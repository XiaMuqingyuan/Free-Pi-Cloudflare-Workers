# Free-Pi-Cloudflare-Workers

把 [freepi-workers.js](./freepi-workers.js) 部署到 Cloudflare Workers，即可把一个或多个 free-pi 账号包装成 **OpenAI 兼容接口**，供任意 OpenAI 客户端使用。

- 单文件、零依赖，一个 Worker 就是全部
- 多账号池：一个号不可用自动换下一个
- 自动跟随上游版本号，不会因 CLI 版本低被拒（426）
- 仅在账号被广告闸门拦下时才补曝光，正常账号 0 次广告请求
- 会话冲突（409）、额度用尽、限流等自动冷却与恢复

请求路径：`客户端 → Cloudflare Worker → api.freepi.ai`

---

## 一、变量

在 Worker 的 **Settings → Variables and Secrets** 中添加。两项都建议选 **Secret** 类型。

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
| `ROUTING`           | `drain`         | `drain` = 用光一个号再换下一个；`rotate` = 每请求轮换 |
| `CLIENT_VERSION`    | `0.6.19`        | 仅在读不到上游版本时的兜底值，一般不用设              |
| `ADS_CLIENT_OS`     | `win32`         | 桌面指纹：操作系统                                    |
| `ADS_CLIENT_ARCH`   | `x64`           | 桌面指纹：CPU 架构                                    |
| `ADS_CLIENT_TZ`     | `Asia/Shanghai` | 桌面指纹：时区                                        |
| `ADS_CLIENT_LOCALE` | `zh-CN`         | 桌面指纹：locale                                      |

最小配置只需前两项必填变量，其余全部留默认。

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

## 四、注意

- `WORKER_API_KEY` 和 `FREEPI_TOKENS` 只放 Secret，不要写进代码或提交到仓库；Key 泄漏后立即在控制台改成新值。
- `/healthz` 无需鉴权，会暴露账号数量，不希望公开可自行限制。
- free-pi token 约 90 天过期，失效后重新登录官方 CLI 取新 token 更新 `FREEPI_TOKENS`。
- 高频请求可能触发上游反滥用标记，请在客户端侧控制并发。
- 本项目与 free-pi 官方无关，仅供个人学习自用；使用前请自行确认符合其服务条款。
