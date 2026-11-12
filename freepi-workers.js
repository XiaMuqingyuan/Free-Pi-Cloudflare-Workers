
// ────────────────────────────────────────────────────────────────────
const CLIENT_VERSION = '0.6.19';
const ENV_KEY = 'CLIENT_VERSION';
// ────────────────────────────────────────────────────────────────────

const UPSTREAM = 'https://api.freepi.ai';
const CHAT_URL = `${UPSTREAM}/v1/chat/completions`;

// 超时与轮数（毫秒 / 轮）
const CHAT_CONNECT_TIMEOUT_MS = 30000; // 流式：等响应头（建连）
const CHAT_TOTAL_TIMEOUT_MS = 120000;  // 非流式：整个生成
const STREAM_IDLE_TIMEOUT_MS = 30000;  // 流式：相邻 chunk 最大间隔
const AUX_TIMEOUT_MS = 15000;          // ads / session / me
const VERSION_TIMEOUT_MS = 5000;       // /client-version
const MAX_GATE_ROUNDS = 3;

// 上游最低版本缓存
const VERSION_TTL_MS = 6 * 3600 * 1000;

// 账号冷却：统一 5 分钟，不区分错误类型。
// 冷却只是"暂时降低优先级"，不是永久封禁，5 分钟后自动恢复尝试。
const COOLDOWN_MS = 5 * 60 * 1000;
const COOLDOWN_NETWORK_MS = 30 * 1000; // 网络/5xx 是临时故障，30 秒就够
const QUOTA_TTL_MS = 5 * 60 * 1000;          // /me 额度缓存
// 广告闸门（实测结论，详见 README.md）：
// 正常账号服务端根本不查广告 —— standard 车道下裸请求即 200。
// 只有当账号被反滥用判成 restricted 后，才要求"滑动窗口内有确认曝光"，
// 此时才回 403 ads_required（慢车道下则伪装成 HTTP 200 的补全罐头）。
// 所以策略是"懒曝光"：默认 0 次广告请求，被拦过才预热 + 补打点。

// 路由模式：drain = 用光一个账号再换下一个（默认）；rotate = 每个请求换一个
const DEFAULT_ROUTING = 'drain';

// per-isolate 状态
let UPSTREAM_MIN_VERSION = null; // 从 /client-version 读到的 min（最低要求）
let UPSTREAM_LATEST_VERSION = null; // 从 /client-version 读到的 latest（最新发版，优先跟随）
let UPSTREAM_MIN_AT = 0;
let UPSTREAM_MIN_PENDING = null;
let LEARNED_MIN_VERSION = null;  // 从 403 学到的值（优先级最高）
let UPSTREAM_MIN_ERROR = null;   // 最近一次探测失败的原因（只在 healthz 里露出）
let POOL_CURSOR = 0;
const INFLIGHT = new Map();       // token -> 在飞 chat 数
const COOLDOWN_UNTIL = new Map(); // token -> 冷却截止时间（临时故障）
const EXHAUSTED_UNTIL = new Map();// token -> 额度用完的截止时间（到下个 UTC 零点）
const QUOTA = new Map();          // token -> { at, remaining, allowance, refillAt }
const LAST_ERROR = new Map();     // token -> 最近一次失败摘要

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    };
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const VERSION = '1.3.0';
    const mode = String((env && env.ROUTING) || DEFAULT_ROUTING).toLowerCase() === 'rotate' ? 'rotate' : 'drain';

    // 账号池配置错误（JSON 写坏、全是碎片）→ 明确报 config_error，
    // 不要带着垃圾 token 去上游换回一串 401。
    // healthz 仍要能打开，否则配置写坏了连诊断入口都没有。
    let accounts = [];
    let poolError = null;
    try {
      accounts = poolOf(env);
    } catch (e) {
      poolError = String(e && e.message || e);
    }

    if (url.pathname === '/healthz') {
      // healthz 以前只读缓存：新 isolate 从没跑过 chat，就永远是 null。
      // 这里补一次主动探测（只在没有缓存或 ?probe=1 时），5 秒超时，
      // 读到就一起把后续请求要用的版本预热好。
      const force = url.searchParams.get('probe') === '1';
      if (force || !UPSTREAM_MIN_VERSION) {
        await upstreamMinVersion({ force });
      }
      return Response.json({
        status: poolError ? 'config_error' : 'ok',
        version: VERSION,
        client_version: clientVersion(env),
        client_version_source: versionSource(),
        upstream_min_version: UPSTREAM_MIN_VERSION,
        upstream_latest_version: UPSTREAM_LATEST_VERSION,
        version_probe: (UPSTREAM_MIN_VERSION || UPSTREAM_LATEST_VERSION) ? 'ok' : 'failed',
        ...(UPSTREAM_MIN_ERROR ? { version_error: UPSTREAM_MIN_ERROR } : {}),
        routing: mode,
        accounts: accounts.length,
        ads_required_accounts: [...ADS_REQUIRED.keys()].filter((t) => needsAds(t)).length,
        ...(poolError ? { config_error: poolError } : {}),
      }, { headers: cors });
    }

    const protectedPaths = ['/v1/chat/completions', '/v1/models', '/v1/usage'];
    if (protectedPaths.includes(url.pathname)) {
      const key = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
      if (!env.WORKER_API_KEY || !accounts.length) {
        return Response.json({
          error: {
            message: poolError || (!env.WORKER_API_KEY ? 'WORKER_API_KEY 未配置' : 'FREEPI_TOKENS 里没有可用 token'),
            code: 'config_error',
          },
        }, { status: 500, headers: cors });
      }
      const a = new TextEncoder().encode(key), b = new TextEncoder().encode(env.WORKER_API_KEY);
      let diff = a.length ^ b.length;
      for (let i = 0; i < Math.min(a.length, b.length); i++) diff |= a[i] ^ b[i];
      if (diff !== 0) {
        return Response.json({ error: { message: 'Invalid API key', code: 'invalid_api_key' } }, { status: 401, headers: cors });
      }
    }

    if (url.pathname === '/v1/models') {
      let list = null;
      try {
        const cv = await fetch(`${UPSTREAM}/client-version`, { signal: AbortSignal.timeout(VERSION_TIMEOUT_MS) });
        if (cv.ok) {
          const d = await cv.json();
          if (Array.isArray(d.models)) {
            list = d.models
              .filter((m) => !m.unavailable)
              .map((m) => ({ id: m.id, object: 'model', owned_by: m.section === 'defense' ? 'freepi-defense' : 'freepi' }));
          }
        }
      } catch {}
      if (!list) list = [{ id: 'deepseek-v4-flash', object: 'model', owned_by: 'freepi' }];
      return Response.json({ object: 'list', data: list }, { headers: cors });
    }

    if (url.pathname === '/v1/usage') {
      const rows = await Promise.all(accounts.map(async (acct) => {
        const base = {
          account: acct.name,
          cooling: cooling(acct.token),
          exhausted: exhausted(acct.token),
          remaining_cached: QUOTA.get(acct.token) ? QUOTA.get(acct.token).remaining : undefined,
          last_error: LAST_ERROR.get(acct.token) || null,
        };
        try {
          const me = await fetch(`${UPSTREAM}/me`, {
            headers: freepiHeaders(acct.token, env),
            signal: AbortSignal.timeout(AUX_TIMEOUT_MS),
          });
          const data = await me.json().catch(() => ({}));
          return {
            ...base,
            handle: data.handle,
            allowance_credits: data.allowance_credits,
            remaining_credits_today: data.remaining_credits_today,
            remaining_usd_today: data.remaining_usd_today,
            cap_usd_today: data.cap_usd_today,
            premium_credits: data.premium_credits,
            credit_usd: data.credit_usd,
            refill_at: data.refill_at,
            tier: data.tier,
            raw_status: me.status,
          };
        } catch {
          return { ...base, error: 'upstream unreachable' };
        }
      }));
      return Response.json({
        routing: mode,
        accounts: rows,
        pool_size: rows.length,
        cooling: rows.filter((r) => r.cooling).length,
        exhausted: rows.filter((r) => r.exhausted).length,
      }, { headers: cors });
    }

    if (url.pathname === '/v1/chat/completions' && request.method === 'POST') {
      let body;
      try {
        body = await request.json();
      } catch {
        return Response.json({ error: { message: 'invalid JSON body', code: 'bad_request' } }, { status: 400, headers: cors });
      }
      const requestedModel = body.model || 'deepseek-v4-flash';

      if (poolError) {
        return Response.json({ error: { message: poolError, code: 'config_error' } }, { status: 500, headers: cors });
      }

      let upstream;
      try {
        upstream = await chatAcrossPool(accounts, body, env, cors, mode);
      } catch {
        return Response.json({ error: { message: 'upstream unreachable', code: 'upstream_error' } }, { status: 502, headers: cors });
      }

      // 流式只在成功时透传；错误体一律 JSON，否则 SSE 客户端会把 JSON 当事件流解析
      if (body.stream && upstream.status < 400) {
        return new Response(upstream.body, {
          status: upstream.status,
          headers: { ...cors, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
        });
      }

      let text;
      try {
        text = await upstream.text();
      } catch {
        return Response.json({ error: { message: 'upstream connection aborted', code: 'upstream_error' } }, { status: 502, headers: cors });
      }
      let data;
      try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 2000) }; }
      if (data && data.model && data.model !== 'deepseek-v4-flash') {
        // 上游回显了真实服务的模型 id，保留
      } else if (data && data.model) {
        data.model = requestedModel;
      }
      return new Response(JSON.stringify(data), {
        status: upstream.status,
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    return Response.json({ error: { message: 'not found', code: 'not_found' } }, { status: 404, headers: cors });
  },
};

// ── 版本解析：上游优先，变量兜底 ─────────────────────────────────────

// 读 /client-version 的 min + latest；6 小时内复用，过期后台刷新。
// latest 是上游最新发版号，跟随它可以让 worker 永远像"刚更新过的 CLI"，
// 不必等 min 抬高才被动跟进。
// 返回值可能是 null（上游不可达且从未读到过）。
async function upstreamMinVersion({ force = false } = {}) {
  if (!force && UPSTREAM_MIN_VERSION && Date.now() - UPSTREAM_MIN_AT < VERSION_TTL_MS) {
    return UPSTREAM_MIN_VERSION;
  }
  if (UPSTREAM_MIN_PENDING) return UPSTREAM_MIN_PENDING;
  UPSTREAM_MIN_PENDING = fetch(`${UPSTREAM}/client-version`, { signal: AbortSignal.timeout(VERSION_TIMEOUT_MS) })
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => {
      const min = d && typeof d.min === 'string' ? d.min.trim() : '';
      const latest = d && typeof d.latest === 'string' ? d.latest.trim() : '';
      const okMin = /^\d+\.\d+(\.\d+)?$/.test(min);
      const okLatest = /^\d+\.\d+(\.\d+)?$/.test(latest);
      if (okMin) UPSTREAM_MIN_VERSION = min;
      if (okLatest) UPSTREAM_LATEST_VERSION = latest;
      if (okMin || okLatest) {
        UPSTREAM_MIN_AT = Date.now();
        UPSTREAM_MIN_ERROR = null;
      } else {
        UPSTREAM_MIN_ERROR = `响应里没有 min/latest 字段（收到 ${JSON.stringify(d).slice(0, 80)}）`;
      }
      return UPSTREAM_MIN_VERSION;
    })
    .catch((e) => {
      UPSTREAM_MIN_ERROR = String(e && e.message || e).slice(0, 120);
      return UPSTREAM_MIN_VERSION;
    })
    .finally(() => { UPSTREAM_MIN_PENDING = null; });
  return UPSTREAM_MIN_PENDING;
}

// 版本比较：0.6.9 < 0.6.18（按段做数字比较，不能按字符串比）
function cmpVersion(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x - y;
  }
  return 0;
}

function higherVersion(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return cmpVersion(a, b) >= 0 ? a : b;
}

// 生效版本：单请求 override → max(403 学到的值, 上游 latest, 上游 min) → env → 常量。
// 取 latest 而不是 min：永远像"刚更新过的 CLI"，上游抬 min 时已经领先，不会先吃 426。
// 仍取 max：万一 min 反超 latest（灰度回滚），用小的会一直 426。
function clientVersion(env, override) {
  if (override) return String(override).trim();
  const upstreamBest = higherVersion(UPSTREAM_LATEST_VERSION, UPSTREAM_MIN_VERSION);
  const best = higherVersion(LEARNED_MIN_VERSION, upstreamBest);
  if (best) return best;
  const fromEnv = env && env[ENV_KEY] ? String(env[ENV_KEY]).trim() : '';
  return fromEnv || CLIENT_VERSION;
}

function versionSource() {
  const upstreamBest = higherVersion(UPSTREAM_LATEST_VERSION, UPSTREAM_MIN_VERSION);
  const best = higherVersion(LEARNED_MIN_VERSION, upstreamBest);
  if (!best) return 'fallback';
  if (best === LEARNED_MIN_VERSION && best !== upstreamBest) return 'learned-403';
  if (best === UPSTREAM_LATEST_VERSION && UPSTREAM_LATEST_VERSION) return 'upstream-latest';
  return 'upstream-min';
}

// ── 账号池 ────────────────────────────────────────────────────────

// 支持：
//   FREEPI_TOKENS = 'tok1\ntok2' / 'tok1,tok2' / '["tok1","tok2"]'
//   FREEPI_TOKENS = '[{"name":"a","token":"tok1"},{"name":"b","key":"tok2"}]'
// 以及单账号的 FREEPI_TOKEN / FREEPI_TOKEN_ALT
//
// 注意：以 [ 开头的值必须是合法 JSON。以前解析失败会退化成按逗号切分，
// 结果把 JSON 片段当成 token 发出去，上游一律回 401 —— 现在直接报配置错误。
function poolOf(env) {
  const out = [];
  const seen = new Set();
  const bad = [];
  const push = (name, token) => {
    const t = String(token || '').trim().replace(/^["']|["']$/g, '');
    if (!t) return;
    // JWT 形如 a.b.c；明显不是的（JSON 碎片、说明文字）直接丢弃并计数
    if (!/^[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}$/.test(t)) {
      bad.push(String(name || t).slice(0, 24));
      return;
    }
    if (seen.has(t)) return;
    seen.add(t);
    out.push({ name: String(name || '').trim() || `acct${out.length + 1}`, token: t });
  };
  const add = (value, source) => {
    if (!value) return;
    const text = String(value).trim();
    if (!text) return;
    if (text.startsWith('[')) {
      let parts;
      try {
        parts = JSON.parse(text);
      } catch (e) {
        throw new Error(`${source} 不是合法 JSON（${e.message}）。检查每个对象都有 { }、对象之间用逗号分隔。`);
      }
      if (!Array.isArray(parts)) throw new Error(`${source} 必须是 JSON 数组，例如 [{"name":"A","token":"eyJ…"}]`);
      for (const part of parts) {
        if (part && typeof part === 'object') push(part.name || part.label, part.token || part.key || part.jwt);
        else push('', part);
      }
      return;
    }
    for (const part of text.split(/[\s,]+/)) push('', part);
  };
  add(env.FREEPI_TOKENS, 'FREEPI_TOKENS');
  add(env.FREEPI_TOKEN, 'FREEPI_TOKEN');
  add(env.FREEPI_TOKEN_ALT, 'FREEPI_TOKEN_ALT');
  if (bad.length) {
    // 有被丢弃的条目：数量对不上时能一眼看出来，但不把原始值写进日志
    console.warn(`pool: 丢弃 ${bad.length} 个不像 JWT 的值（${bad.slice(0, 3).join(', ')}）`);
  }
  return out;
}

function freepiHeaders(token, env, overrideVersion, sid) {
  if (!token) throw new Error('no free-pi token in the pool');
  return {
    'Authorization': 'Bearer ' + token,
    'x-session-id': sid || crypto.randomUUID(),
    'x-client-version': clientVersion(env, overrideVersion),
  };
}

// ── 冷却与在飞计数 ─────────────────────────────────────────────────

function cooling(token) {
  const until = COOLDOWN_UNTIL.get(token) || 0;
  return until > Date.now();
}

function cool(token, ms, reason) {
  COOLDOWN_UNTIL.set(token, Date.now() + ms);
  LAST_ERROR.set(token, reason);
}

// 额度用完：按上游的每日重置（00:00 UTC）算，不必每小时重试
function msUntilUtcMidnight() {
  const now = new Date();
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(60 * 1000, next - Date.now());
}

function exhausted(token) {
  return (EXHAUSTED_UNTIL.get(token) || 0) > Date.now();
}

function markExhausted(token, reason) {
  EXHAUSTED_UNTIL.set(token, Date.now() + msUntilUtcMidnight());
  LAST_ERROR.set(token, reason || 'quota exhausted');
}

// drain 模式需要知道"这个号还剩多少"：读 /me 并缓存 5 分钟。
// 读不到不影响可用性（当作未知，照常尝试）。
// force=true 绕过缓存；若此时发现又有额度了，就解除 exhausted（刚重置/刚充值）。
async function ensureQuota(token, env, force = false) {
  const cached = QUOTA.get(token);
  if (!force && cached && Date.now() - cached.at < QUOTA_TTL_MS) return cached;
  try {
    const me = await fetch(`${UPSTREAM}/me`, {
      headers: freepiHeaders(token, env),
      signal: AbortSignal.timeout(AUX_TIMEOUT_MS),
    });
    if (me.status === 401) {
      cool(token, COOLDOWN_MS, '401 /me');
      return null;
    }
    if (!me.ok) return cached || null;
    const d = await me.json();
    const q = {
      at: Date.now(),
      remaining: typeof d.remaining_credits_today === 'number' ? d.remaining_credits_today : null,
      allowance: typeof d.allowance_credits === 'number' ? d.allowance_credits : null,
      refillAt: d.refill_at || null,
    };
    QUOTA.set(token, q);
    if (q.remaining === 0) {
      // 0 额度 ≠ 不可用：上游会把这类账号放进慢道（spare capacity）继续服务，
      // 实测广告流程走通后能拿到真实回复。只记录状态，不再按"用完"排除。
      LAST_ERROR.set(token, '0 credits left (slow lane)');
    }
    if (force) EXHAUSTED_UNTIL.delete(token);
    return q;
  } catch {
    return cached || null;
  }
}

function inflight(token, delta) {
  const n = (INFLIGHT.get(token) || 0) + delta;
  if (n <= 0) INFLIGHT.delete(token);
  else INFLIGHT.set(token, n);
}

// 账号排序。
//  drain（默认）：固定顺序，先用 0 号账号，额度用光/冷却了才往后走；
//  rotate       ：每个请求换一个起点。
// 两种模式都遵守：已用完(exhausted)与冷却中的排到最后；同档内"空闲账号"优先。
function orderedPool(accounts, mode = DEFAULT_ROUTING) {
  const load = (a) => INFLIGHT.get(a.token) || 0;
  const usable = (a) => !exhausted(a.token) && !cooling(a.token);

  let ordered;
  if (mode === 'rotate') {
    const start = accounts.length ? POOL_CURSOR % accounts.length : 0;
    if (accounts.length) POOL_CURSOR = (POOL_CURSOR + 1) % accounts.length;
    ordered = accounts.map((_, i) => accounts[(start + i) % accounts.length]);
  } else {
    ordered = [...accounts];
  }

  const byIdle = (a, b) => (load(a) > 0 ? 1 : 0) - (load(b) > 0 ? 1 : 0);
  const ready = ordered.filter(usable).sort(byIdle);
  const rest = ordered.filter((a) => !usable(a)).sort(byIdle);
  return [...ready, ...rest];
}

// ── 响应与请求 ────────────────────────────────────────────────────

function errorLike(res, probe) {
  const headers = new Headers(res.headers);
  headers.delete('content-encoding');
  headers.delete('content-length');
  headers.delete('transfer-encoding');
  headers.delete('connection');
  return new Response(probe, { status: res.status, statusText: res.statusText, headers });
}

function chatFetch(token, body, env, overrideVersion, sid, onStreamEnd, turn) {
  const isStream = !!body.stream;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), isStream ? CHAT_CONNECT_TIMEOUT_MS : CHAT_TOTAL_TIMEOUT_MS);
  const headers = { ...freepiHeaders(token, env, overrideVersion, sid), 'Content-Type': 'application/json' };
  if (turn) headers['x-turn-id'] = turn; // CLI 的聊天请求也带当前轮 id
  Object.assign(headers, adsFingerprint(env)); // 聊天也呈 Windows 桌面指纹（与 /ads/next 一致）
  return fetch(CHAT_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: ac.signal,
  }).then((res) => {
    clearTimeout(timer);
    if (isStream && res.ok) return withIdleWatchdog(res, ac, onStreamEnd);
    return res;
  }, (err) => {
    clearTimeout(timer);
    throw err;
  });
}

// 空闲看门狗：chunk 间隔超过阈值才 abort，正常长流不掐
function withIdleWatchdog(res, ac, onStreamEnd) {
  if (!res.body) return res; // 理论上有 body，防一手 204/空响应
  let idle = setTimeout(() => ac.abort(), STREAM_IDLE_TIMEOUT_MS);
  const bump = () => { clearTimeout(idle); idle = setTimeout(() => ac.abort(), STREAM_IDLE_TIMEOUT_MS); };
  const watch = new TransformStream({
    transform(chunk, ctrl) { bump(); ctrl.enqueue(chunk); },
    flush() { clearTimeout(idle); },
    cancel() { clearTimeout(idle); },
  });
  const settled = res.body.pipeTo(watch.writable).catch(() => {});
  if (onStreamEnd) settled.then(onStreamEnd);
  return new Response(watch.readable, { status: res.status, headers: res.headers });
}

// ── 广告流程（复刻官方 CLI 的完整握手）────────────────────────────
// 上游只认这个形状的请求链；缺任何一环都可能不记账。

const SESSION_IDS = new Map();   // token -> 稳定 session id（isolate 生命周期内）
const ADS_LOADED_AT = new Map(); // token -> { at, sid } 上次成功走完广告流程的时间
// 已知会被上游广告闸门拦的账号。实测：正常账号服务端根本不查广告
// （standard 车道裸请求即 200），只有被反滥用标记 restricted 后才要求
// "窗口内有确认曝光"。所以默认零曝光，只有进过这张表的号才预热。
// 带 TTL：账号恢复正常后自然过期，回到零曝光；再被拦就重新计时。
const ADS_REQUIRED = new Map();  // token -> 标记过期时间戳
const ADS_REQUIRED_TTL_MS = 20 * 60 * 1000;

function markAdsRequired(token) {
  ADS_REQUIRED.set(token, Date.now() + ADS_REQUIRED_TTL_MS);
}

function needsAds(token) {
  const until = ADS_REQUIRED.get(token) || 0;
  if (until > Date.now()) return true;
  if (until) ADS_REQUIRED.delete(token); // 过期即回到零曝光
  return false;
}

// 快速恢复：标记期内连续 N 次请求都没再被闸门拦，说明账号已恢复正常，
// 立即清标记回到零曝光，不必干等 TTL。
const ADS_OK_STREAK = new Map(); // token -> 连续干净成功次数
const ADS_OK_STREAK_TO_CLEAR = 2;

function noteAdsCleanSuccess(token) {
  if (!needsAds(token)) return;
  const n = (ADS_OK_STREAK.get(token) || 0) + 1;
  if (n >= ADS_OK_STREAK_TO_CLEAR) {
    ADS_REQUIRED.delete(token);
    ADS_OK_STREAK.delete(token);
  } else {
    ADS_OK_STREAK.set(token, n);
  }
}

// CLI 用 ~/.free-pi/agent/accounts.json 里每个账号自己的 sessionId；
// worker 在 isolate 内保持稳定，重启后重新生成（上游只要求会话内一致）。
function stableSessionId(token) {
  let sid = SESSION_IDS.get(token);
  if (!sid) {
    sid = crypto.randomUUID();
    SESSION_IDS.set(token, sid);
  }
  return sid;
}

// CLI 的桌面指纹：process.platform / os.arch() / Intl 时区与 locale。
// 可用 env 覆盖（ADS_CLIENT_OS / ADS_CLIENT_ARCH / ADS_CLIENT_TZ / ADS_CLIENT_LOCALE）。
function adsFingerprint(env) {
  return {
    'x-client-os': (env && env.ADS_CLIENT_OS) || 'win32',
    'x-client-arch': (env && env.ADS_CLIENT_ARCH) || 'x64',
    'x-client-timezone': (env && env.ADS_CLIENT_TZ) || 'Asia/Shanghai',
    'x-client-locale': (env && env.ADS_CLIENT_LOCALE) || 'zh-CN',
  };
}

// GET /ads/next?slot=banner：x-ad-trigger（launch / user_message）+ 轮 id + 桌面指纹
async function fetchAd(token, env, sid, turn, trigger) {
  const headers = {
    ...freepiHeaders(token, env, null, sid),
    'x-turn-id': turn,
    ...adsFingerprint(env),
    ...(trigger ? { 'x-ad-trigger': trigger } : {}),
  };
  const next = await fetch(`${UPSTREAM}/ads/next?slot=banner`, {
    headers,
    signal: AbortSignal.timeout(AUX_TIMEOUT_MS),
  });
  if (!next.ok) return null;
  const ad = await next.json().catch(() => null);
  return ad && ad.ad_id ? ad : null;
}

// POST /ads/impression：只有 x-session-id，不带 turn/指纹（与 CLI 一致）
async function fireImpression(token, env, sid, ad) {
  const imp = await fetch(`${UPSTREAM}/ads/impression`, {
    method: 'POST',
    headers: { ...freepiHeaders(token, env, null, sid), 'Content-Type': 'application/json' },
    body: JSON.stringify({ ad_id: ad.ad_id, click_token: ad.click_token, imp_fired: true }),
    signal: AbortSignal.timeout(AUX_TIMEOUT_MS),
  });
  return imp.ok;
}

// gravity 广告的第三方曝光 beacon（CLI 渲染广告时同样 GET 一次，3 秒超时）
async function fireGravityBeacon(ad) {
  if (!ad || ad.source !== 'gravity' || !ad.imp_url) return;
  try {
    const u = new URL(ad.imp_url);
    if (u.protocol !== 'https:' || !/(^|\.)trygravity\.(ai|com)$/.test(u.hostname)) return;
    await fetch(ad.imp_url, { signal: AbortSignal.timeout(3000) });
  } catch {}
}

// 走一遍完整 CLI 广告流程；成功则记账（按 token + sid）。
async function loadAds(token, env, sid, turn, trigger) {
  try {
    const ad = await fetchAd(token, env, sid, turn, trigger);
    if (!ad) return false;
    if (!await fireImpression(token, env, sid, ad)) return false;
    await fireGravityBeacon(ad);
    ADS_LOADED_AT.set(token, { at: Date.now(), sid });
    return true;
  } catch {
    return false;
  }
}

function resetSession(token, env, sid) {
  return fetch(`${UPSTREAM}/session/reset`, {
    method: 'POST',
    headers: freepiHeaders(token, env, null, sid),
    signal: AbortSignal.timeout(AUX_TIMEOUT_MS),
  }).catch(() => {});
}

// ── 闸门 ──────────────────────────────────────────────────────────

const VERSION_GATE_RE = /below the required minimum/i;
const MIN_VERSION_RE = /minimum[^\d]*([\d]+\.[\d]+\.[\d]+)/i;

// 账号级闸门：只有换账号才能解。
// 注意：不能拿 "credit" 这种裸词判断——付费模型会回
// "This model is for credit users."，那属于"模型被拒"，换账号也没用，
// 以前把它当账号闸门会让整池白跑一遍。
const ACCOUNT_GATE_RES = [
  /ads_required/i,
  /hourly_ceiling/i,
  /daily_ceiling/i,
  /quota_exhausted/i,
  /credits_exhausted/i,
  /concurrent_session/i,
  /insufficient[_ ]credits?/i,
  /out of credits/i,
];
function isAccountGate(text) {
  return ACCOUNT_GATE_RES.some((re) => re.test(text));
}

// 单账号：默认零曝光；被广告闸门拦下才补曝光。版本就地学、session 就地 reset。
async function sendWithGates(token, body, env, onStreamEnd) {
  await upstreamMinVersion(); // 首次请求先把上游版本取回来，避免每个请求先吃一次 403
  const sid = stableSessionId(token); // 每账号稳定会话（上游按 会话 记并发槽位）
  const turn = crypto.randomUUID();   // 每请求一轮，与广告流程同轮
  // 懒曝光：只有"最近被闸门拦过"的号才预热，正常账号这里是 0 次广告子请求。
  if (needsAds(token)) {
    await loadAds(token, env, sid, turn, ADS_LOADED_AT.has(token) ? 'user_message' : 'launch');
  }
  let res = await chatFetch(token, body, env, null, sid, onStreamEnd, turn);
  let sessionResetDone = false;
  let adsGateHit = false; // 本轮是否真的被广告闸门拦过（决定能否算"干净成功"）
  let cannedRetried = false; // 罐头只就地补一次曝光，避免无限循环

  for (let round = 0; round < MAX_GATE_ROUNDS; round++) {
    // 罐头 200：伪装成补全的广告闸门文案。就地补曝光重试，不换号。
    // 只在非流式下检测（流式无法预读 body）。
    if (!body.stream && res.status === 200 && !cannedRetried) {
      const probe = await res.clone().text().catch(() => '');
      if (CANNED_PAUSE_RE.test(probe)) {
        adsGateHit = true;
        cannedRetried = true;
        markAdsRequired(token);
        const nextTurn = crypto.randomUUID();
        await loadAds(token, env, sid, nextTurn, 'user_message');
        res = await chatFetch(token, body, env, null, sid, onStreamEnd, nextTurn);
        continue;
      }
    }

    if (res.status === 403 || res.status === 426) {
      const probe = await res.text();
      if (probe.includes('ads_required')) {
        // 被拦 = 账号已被判 restricted：记住它，并就地补一次真实曝光
        adsGateHit = true;
        markAdsRequired(token);
        const nextTurn = crypto.randomUUID();
        await loadAds(token, env, sid, nextTurn, 'user_message');
        res = await chatFetch(token, body, env, null, sid, onStreamEnd, nextTurn);
        continue;
      }
      if (VERSION_GATE_RE.test(probe)) {
        const m = probe.match(MIN_VERSION_RE);
        const retry = m && m[1];
        // 用 cmpVersion 做数字比较：只有 retry 比当前生效版本更高才重试。
        // 之前用 retry !== clientVersion(env) 做字符串不等比较，当 latest > retry
        // 时条件恒真，会在 MAX_GATE_ROUNDS 内空转。
        const sentVersion = clientVersion(env);
        if (retry && cmpVersion(retry, sentVersion) > 0) {
          LEARNED_MIN_VERSION = retry;
          res = await chatFetch(token, body, env, retry, sid, onStreamEnd, turn);
          continue;
        }
        // 上游报错但没给出版本：强制刷新一次 min 再试
        const fresh = await upstreamMinVersion({ force: true });
        if (fresh && fresh !== clientVersion(env)) {
          LEARNED_MIN_VERSION = fresh;
          res = await chatFetch(token, body, env, fresh, sid, onStreamEnd, turn);
          continue;
        }
      }
      // 426 = Upgrade Required：上游只给状态码、正文为空，必须主动去读 min
      if (res.status === 426) {
        const fresh = await upstreamMinVersion({ force: true });
        // 只有 fresh 比当前发送的版本更高才值得重试，否则原样透传。
        if (fresh && cmpVersion(fresh, clientVersion(env)) > 0) {
          LEARNED_MIN_VERSION = fresh;
          res = await chatFetch(token, body, env, fresh, sid, onStreamEnd, turn);
          continue;
        }
        return errorLike(res, probe); // 上游没给出更高的版本：原样交池层
      }
      return errorLike(res, probe); // 其他 403：真错误（如付费模型），交池层透传
    }

    if (res.status === 409 || res.status === 429) {
      const probe = await res.text();
      if (probe.includes('concurrent_session') && !sessionResetDone && (INFLIGHT.get(token) || 0) <= 1) {
        sessionResetDone = true;
        await resetSession(token, env, sid);
        res = await chatFetch(token, body, env, null, sid, onStreamEnd, turn);
        continue;
      }
      return errorLike(res, probe);
    }

    // 干净成功（没被广告闸门拦过）→ 累计成功次数，够数就清标记回到零曝光
    if (!adsGateHit) noteAdsCleanSuccess(token);
    return res;
  }
  return res;
}

// ── 走池 ──────────────────────────────────────────────────────────

// 池内可换号的状态
const SWITCH_STATUS = new Set([401, 403, 409, 429, 402]);

function cooldownFor(status) {
  if (status >= 500) return COOLDOWN_NETWORK_MS; // 上游临时故障，30 秒
  return COOLDOWN_MS; // 其他（401/429/403/409/402）5 分钟
}

// 账号级闸门里区分"额度用完"和"临时故障"
const QUOTA_HOURLY_RE = /hourly_ceiling/i;
const QUOTA_DAILY_RE = /quota_exhausted|credits_exhausted|daily_ceiling|insufficient[_ ]credits?|out of credits/i;

// 上游还会把"广告闸门"文案伪装成 HTTP 200 的"补全"塞进 content（usage 全 0），
// 状态码完全正常，任何 403/429 闸门都拦不到它。实测触发条件是会话没按 CLI
// 形状加载广告（与剩余额度无关），完整广告流程走通后即消失。
// 保留内容识别兜底：一旦罐头再现，按账号闸门冷却换号，别让它流到客户端。
const CANNED_PAUSE_RE = /free-pi is free because it shows ads/i;

async function chatAcrossPool(accounts, body, env, cors, mode = DEFAULT_ROUTING) {
  if (!accounts.length) {
    return Response.json({ error: { message: 'no token configured', code: 'upstream_error' } }, { status: 502, headers: cors });
  }
  // 会话 id 由 sendWithGates 按账号各自持有（稳定），不再每请求随机
  let last = null;
  let lastStatus = 0;
  const rejected = [];
  let lastBody = '';
  let cannedCount = 0;

  // drain 模式：先读一轮额度（5 分钟缓存），把已经见底的账号排除在外。
  // 如果全池都没额度，强制刷新一次（可能刚过 UTC 零点或刚充值）；
  // 仍然没有就直接快速失败，不要拿 N 个注定 429 的请求去骚扰上游。
  if (mode !== 'rotate') {
    await Promise.all(accounts.map((a) => ensureQuota(a.token, env)));
    const usableNow = accounts.filter((a) => !exhausted(a.token) && !cooling(a.token));
    if (!usableNow.length) {
      await Promise.all(accounts.map((a) => ensureQuota(a.token, env, true)));
      const after = accounts.filter((a) => !exhausted(a.token) && !cooling(a.token));
      if (!after.length) {
        const timestamps = accounts.map((a) => EXHAUSTED_UNTIL.get(a.token) || Date.now());
        return Response.json({
          error: {
            message: '所有 freepi 账号的今日额度都已用完，等下一个 UTC 零点重置，或换一个账号池。',
            code: 'all_exhausted',
            resets_at: new Date(Math.min(...timestamps)).toISOString(),
            accounts: accounts.map((a) => a.name),
          },
        }, { status: 429, headers: cors });
      }
    }
  }

  for (const acct of orderedPool(accounts, mode)) {
    const token = acct.token;
    inflight(token, +1);
    let released = false;
    const release = () => { if (!released) { released = true; inflight(token, -1); } };
    let res = null;

    try {
      res = await sendWithGates(token, body, env, body.stream ? release : null);
    } catch (err) {
      LAST_ERROR.set(token, String(err && err.message || err).slice(0, 200));
      cool(token, COOLDOWN_NETWORK_MS, 'network');
      continue;
    } finally {
      if (!res || !res.ok || !body.stream) release();
    }

    const status = res.status;
    if (!SWITCH_STATUS.has(status) && status < 500) {
      // 流式不读响应体，罐头检测做不了，原样透传
      if (body.stream) {
        COOLDOWN_UNTIL.delete(token);
        LAST_ERROR.delete(token);
        return res;
      }
      const okText = await res.text().catch(() => '');
      if (CANNED_PAUSE_RE.test(okText)) {
        // 罐头：sendWithGates 已经就地补过一次曝光还是罐头，说明曝光也救不回来。
        // 短冷却换号，别让它流到客户端。
        cannedCount++;
        LAST_ERROR.set(token, `${status} canned pause reply`);
        cool(token, COOLDOWN_MS, 'canned pause (after retry)'); // 5 分钟
        lastStatus = 429;
        last = Response.json({
          error: {
            message: `账号 ${acct.name} 补曝光后仍被罐头拦截，已换号重试。`,
            code: 'canned_pause',
          },
        }, { status: 429, headers: cors });
        continue;
      }
      COOLDOWN_UNTIL.delete(token);
      LAST_ERROR.delete(token);
      return errorLike(res, okText); // 体已读，重建响应返回（成功或客户端错误）
    }

    const text = await res.text().catch(() => '');
    if (status === 403 && !isAccountGate(text)) {
      return errorLike(res, text); // 真 403（例如付费模型），原样透传
    }

    LAST_ERROR.set(token, `${status} ${text.slice(0, 160)}`);
    if (QUOTA_DAILY_RE.test(text)) {
      markExhausted(token, `${status} ${text.slice(0, 80)}`); // 用光：等到下一个 UTC 零点
    } else if (QUOTA_HOURLY_RE.test(text)) {
      cool(token, COOLDOWN_MS, `${status} hourly_ceiling`);
    } else {
      cool(token, cooldownFor(status), `${status}`);
    }
    lastStatus = status;
    if (status === 401) {
      rejected.push(acct.name);
      if (!lastBody) lastBody = text.slice(0, 200);
    }
    last = errorLike(res, text);
  }

  // 全部账号都被上游 401：说明 token 本身不被接受（过期 / 抄错 / 不是 JWT），
  // 给出可读的诊断，而不是把上游那段裸 401 直接甩回去
  if (lastStatus === 401) {
    return Response.json({
      error: {
        message: `上游拒绝了所有账号的 token（${rejected.join(', ')}）：JWT 过期、复制不完整，或填的不是 freepi 的 token。`,
        code: 'upstream_unauthorized',
        accounts: rejected,
        upstream: lastBody,
      },
    }, { status: 401, headers: { ...cors, 'x-freepi2api-stage': 'upstream-401' } });
  }

  // 整池都被罐头回复拦下（补曝光也救不回来）：给可读的诊断
  if (cannedCount && cannedCount === accounts.length) {
    return Response.json({
      error: {
        message: '所有账号补曝光后仍被上游广告闸门拦下。这通常是账号被反滥用标记（高频请求），等几分钟后重试，或往 FREEPI_TOKENS 里加新账号。',
        code: 'canned_pause_all',
        accounts: accounts.map((a) => a.name),
      },
    }, { status: 429, headers: cors });
  }

  return last ?? Response.json({ error: { message: 'all accounts failed', code: 'upstream_error' } }, { status: 502, headers: cors });
}