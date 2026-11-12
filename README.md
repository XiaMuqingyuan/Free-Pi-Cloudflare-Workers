# Free-Pi-Cloudflare-Workers

把 [freepi-workers.js](./freepi-workers.js) 部署到 Cloudflare Workers，即可把一个或多个 free-pi 账号包装成 **OpenAI 兼容接口**，供任意 OpenAI 客户端使用。

- 单文件、零依赖，一个 Worker 就是全部
- 多账号池：额度最多的优先用，一个号不可用自动换下一个
- 自动跟随上游版本号，不会因 CLI 版本低被拒（426）
- 仅在账号被广告闸门拦下时才补曝光，正常账号 0 次广告请求
- **会话-账号绑定**：一段对话锁定一个账号，换号续写自动切回原账号（上游会拒绝跨账号续写）
- 会话冲突（409）、额度用尽、限流等自动冷却与恢复
- 可选 KV 持久化：绑定关系跨实例/重启不丢

请求路径：`客户端 → Cloudflare Worker → api.freepi.ai`

---

## 一、变量

在 Worker 的 **Settings → Variables and Secrets** 中添加。前两项建议选 **Secret** 类型。

### 必填

| 变量             | 说明                                     |
| ---------------- | ---------------------------------------- |
| `WORKER_API_KEY` | 客户端访问 Worker 用的 调用模型的Api Key |
| `FREEPI_TOKENS`  | free-pi 账号池，写法见下                 |

`FREEPI_TOKENS` 支持四种写法，任选一种：

```bash
# ① 换行分隔
<token1>
<token2>

# ② 逗号分隔
<token1>,<token2>

# ③ JSON 字符串数组
["<token1>","<token2>"]

# ④ JSON 对象数组（推荐，可命名，/v1/usage 里好认）
[{"name":"主号","token":"<token1>"},{"name":"备用1","token":"<token2>"}]
```

每个 `<tokenN>` 替换成完整的 free-pi JWT（三段式 `头.载荷.签名`），从官方 CLI 的 `~/.free-pi/agent/accounts.json` 里取 `jwt` 字段。不像 JWT 的值会被丢弃。

### 可选

| 变量                | 默认            | 说明                                                  |
| ------------------- | --------------- | ----------------------------------------------------- |
| `CLIENT_VERSION`    | `0.6.19`        | 仅在读不到上游版本时的兜底值，一般不用设              |
| `ADS_CLIENT_OS`     | `win32`         | 桌面指纹：操作系统                                    |
| `ADS_CLIENT_ARCH`   | `x64`           | 桌面指纹：CPU 架构                                    |
| `ADS_CLIENT_TZ`     | `Asia/Shanghai` | 桌面指纹：时区                                        |
| `ADS_CLIENT_LOCALE` | `zh-CN`         | 桌面指纹：locale                                      |
| `CONV_NONCE`        | 关              | 设 `1` 启用"加盐实验"，见下文，默认关闭               |

最小配置只需前两项必填变量，其余全部留默认。

### KV 绑定（可选）

默认的会话-账号绑定存在 Worker 实例内存里，实例重启后会丢失（客户端无感，内部多 1~2 次试错自动纠正）。要彻底避免，可绑定 KV 持久化：

1. Workers & Pages → **KV → Create namespace**（名字随意，如 `freepi-conv`）
2. 你的 Worker → **Settings → Variables and Secrets → KV Namespace Bindings**，变量名必须填 **`CONV_KV`**，选中刚建的 namespace
3. Deploy 生效

确认方式：访问 `/healthz`，看到 `"conversation_kv": true`。KV 里只存 token 的哈希指纹，不存明文。

---

## 二、部署

全程在 Cloudflare 网页控制台完成，不需要安装任何工具。

1. 打开 [dash.cloudflare.com](https://dash.cloudflare.com) → **Workers & Pages** → **Create** → **Worker**，起名（如 `freepi-proxy`）→ **Deploy**。
2. 点 **Edit code**，删除编辑器里的示例代码，把 [freepi-workers.js](./freepi-workers.js) 全文粘贴进去 → **Deploy**。
3. 进入该 Worker 的 **Settings → Variables and Secrets**，添加 `WORKER_API_KEY` 与 `FREEPI_TOKENS`（类型选 **Secret**）→ **Deploy** 生效。
4. （可选）**Settings → Domains & Routes → Add → Custom domain** 绑定自定义域名，`*.workers.dev` 在部分网络下不稳定。

部署后访问 `https://<你的worker地址>/healthz`，看到 `"status": "ok"` 且 `accounts` 等于你的账号数即正常。

---

## 三、使用

在任意 OpenAI 兼容客户端中填写：

```
Base URL: https://<你的worker地址>/v1
API Key:  你设的 WORKER_API_KEY
Model:    deepseek-v4-flash
```

多数客户端会把 `/chat/completions` 拼在 Base URL 后面，所以地址要带 `/v1`；若客户端自己补 `/v1`，则只填域名部分。

命令行验证：

```bash
curl https://<你的worker地址>/v1/chat/completions \
  -H "Authorization: Bearer <WORKER_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-v4-flash","messages":[{"role":"user","content":"hi"}]}'
```

其他接口：

| 路径                        | 说明                 |
| --------------------------- | -------------------- |
| `GET /healthz`              | 健康检查（无需鉴权） |
| `GET /v1/models`            | 模型列表             |
| `GET /v1/usage`             | 各账号额度与状态     |
| `POST /v1/chat/completions` | 聊天，支持 `stream`  |

---

## 四、多账号与会话绑定

**上游规则：一段对话只能由一个账号续写。** 同一对话换号会被拒绝（"This conversation belongs to another free-pi account"）。

Worker 的处理方式：

- **一段对话 → 锁定一个账号**。按对话第一条用户消息算指纹，同一段对话永远走同一个账号，多轮对话不会中途换号。
- **不同对话 → 按额度分散**。新对话优先落在剩余额度最多的账号，几个号会被均匀用满。
- **归属自动纠正**。如果指纹猜错（比如实例重启后），会按上游反馈自动切到真正的归属号并记住，客户端无感。
- **池外对话**：这段对话是在不在池子里的账号上开的，会返回明确的中文提示——开个新对话即可，或把那个账号加进 `FREEPI_TOKENS`。

**注意事项**：
- 绑定的账号额度用完时，该对话会提示「绑定账号当前不可用」，换号也救不了（这是上游规则）。同账号额度每天 UTC 零点重置。
- 如果你改了 `FREEPI_TOKENS` 换了账号池，旧对话可能报归属错误，**开新对话**即可。
- 两个不同对话如果开场白完全相同，会绑定到同一个账号（粗指纹的固有代价，不会产生错乱，只是可能扎堆）。

---

## 五、冷却行为速查

账号出问题后按类型冷却，到点自动恢复尝试：

| 错误类型                  | 冷却时长     |
| ------------------------- | ------------ |
| 5xx / 网络错误            | 30 秒        |
| 429 限流 / hourly_ceiling | 1 小时       |
| 401 / 403 / 409 / 罐头    | 5 分钟       |
| daily_cap / 额度耗尽      | 到 UTC 零点  |
| 会话归属错误              | 不换号，自动纠正 |

查看各账号当前状态：`GET /v1/usage`（含额度、冷却中、最后错误）。

---

## 六、CONV_NONCE 实验开关（默认关闭）

设 `CONV_NONCE=1` 启用"加盐实验"：不再绑定会话，每轮按额度优先选号，并给每个账号的请求注入不同的系统消息标记，让上游把同一段对话看成多个不同对话，从而实现单对话跨账号续写。

**默认关闭。** 开启前须知：

- 副作用：每次换号续写要重发完整历史，**token 消耗是 N 倍**
- 风险：这正是上游明文禁止的行为（"Sharing or rotating accounts isn't allowed"），被发现账号可能被标记受限甚至封禁
- 效果取决于上游的会话指纹算法，先用小号验证再决定

建议：只想多账号分摊额度的话，**默认的粘性绑定模式就够了**，不用开这个。

---

## 七、注意

- `WORKER_API_KEY` 和 `FREEPI_TOKENS` 只放 Secret，不要写进代码或提交到仓库；Key 泄漏后立即在控制台改成新值。
- `/healthz` 无需鉴权，会暴露账号数量与配置状态，不希望公开可自行限制。
- free-pi token 约 90 天过期，失效后重新登录官方 CLI 取新 token 更新 `FREEPI_TOKENS`。
- 高频请求可能触发上游反滥用标记，请在客户端侧控制并发。
- 本项目与 free-pi 官方无关，仅供个人学习自用；使用前请自行确认符合其服务条款。
