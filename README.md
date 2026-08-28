# agy-proxy · Antigravity 本地反代网关

本地运行的 Antigravity（Google OAuth）反向代理：登录后自动发现账号可用模型，并对外同时提供
**OpenAI 兼容**（`/v1/chat/completions`）与 **Anthropic 兼容**（`/v1/messages`）两种接口，
供 Claude Code CLI、Cherry Studio、OpenAI SDK 等任意客户端直接接入。

**全程网页操作**：打开浏览器管理台即可完成 OAuth 登录、创建/管理 API Key、查看 token 用量与请求日志——
不需要敲一行命令。

> ⚠️ **免责声明**
> 本工具通过复用 Antigravity 桌面版的公开 OAuth 客户端访问 Google Cloud Code 接口，
> 该用法可能违反 Antigravity 的服务条款，存在限流、封禁等风险。
> 本项目仅供个人在本地环境学习研究网络协议之用，请自行承担使用风险，
> 并遵守当地法律法规与上游服务条款。作者不对账号损失承担责任。

## Web 管理台（主推）

网关启动后打开 `http://127.0.0.1:8045/`（地址随 host/port 配置），所有日常操作都在网页完成：

- **网页端 OAuth 登录**：在「账号池」页点击登录，浏览器拉起 Google OAuth 授权（PKCE），
  回调自动接收、状态实时轮询，成功后账号直接入池；无浏览器环境时切换粘贴模式，复制回调 URL 即可。
  支持多账号连续登录，凭据 AES-256-GCM 加密落盘。
- **网页端创建密钥**：在「接入密钥」页一键创建命名 API Key（可建多把、按需删除），或轮换主密钥；
  新建密钥仅在回环访问下完整展示一次，之后界面只显示脱敏尾号。
- **token 用量**：在「请求统计」页查看实时累计（请求数 / 成功失败 / 三类 token）与**按天持久化的用量历史**——
  按协议、模型、账号、小时分布聚合，可展开任意单日的完整明细；数据重启不丢，保留天数可配置。
- **请求日志**：同页提供最近请求的实时流水（时间、协议、模型、服务账号、状态码、耗时、是否流式、
  prompt/output/thoughts token 数与错误信息），每条请求来了什么、走了哪个号、花了多少 token 一目了然。
- **账号池管理**：账号卡片展示配额条与状态，网页上即可启停、验证、绑定/测试每账号专属出站代理、
  批量导入导出。
- **模型目录**：真实发现账号可用模型与剩余配额，支持控制台内直接试聊（test chat）。
- **服务概览 / 网关设置 / 接入指南**：运行状态与用量速览；debugLog、并发、别名、kill-switch 等配置
  页面上改即热生效；内置客户端接入指南。

## 功能

- **双协议兼容**：
  - OpenAI `/v1/chat/completions`：流式 SSE + 非流式，支持 tool_calls、图片输入、`reasoning_content`
  - Anthropic `/v1/messages`：严格事件流生命周期，thinking 块、tool_use/tool_result、thought_signature 回放
  - Anthropic `/v1/messages/count_tokens`：上游计数透传
- **模型发现**：`GET /v1/models` 返回账号真实可用模型与剩余配额；发现失败时回退内置目录。
- **账号池与轮换**：429 四分类引擎（soft/rate_limited/quota_exhausted/unknown）、按服务端真实重置时间冷却
  （+1.5s grace）、用量感知选号、10 分钟会话亲和（同对话钉同一账号保缓存）、403 `VALIDATION_REQUIRED`
  温和处理（自愈冷却 + validation_url 展示）。
- **自动健康巡检**：后台按间隔强制刷新凭据并复核 project（默认 30 分钟，`AGY_HEALTH_INTERVAL_MS` 可调），
  自动复活可恢复的停用/待验证账号、提前解除验证型冷却（凭据恢复即解冻）；连续失败 5 次后熔断该号的
  自动探测，防止巡检本身变成风控信号；手动 `agy-proxy verify` / 控制台「验证」按钮始终可用。
- **每账号独立出站代理**：账号可绑定专属 http/https 代理（Clash/v2rayN 混合端口即可）实现多账号 IP 隔离；
  生成/流式/count_tokens/配额发现/token 刷新全部走该出口；代理连接层故障不计冷却、立即换号（fail-closed）；
  UI 账号卡片与 `agy-proxy proxy` 子命令均可绑定、清除、真实探测，任何界面只显示脱敏 `protocol//host:port`。
- **风控姿态控制**：per-account 稳定设备指纹（版本池可从官方 release feed 自动保鲜，也可经
  `fingerprint.json` 手动覆盖）、全局上游并发信号量（默认 2）、全局最小调用间隔（默认 300ms，
  `AGY_MIN_INTERVAL_MS` 可调）、紧急 kill-switch（`agy-proxy pause/resume` 或 config `killSwitch`）。
- **用量历史（按天持久化）**：每次请求的 token 用量与成功/失败按本地时区聚合写入
  `<dataDir>/usage/YYYY-MM-DD.json`（内存累计 + 去抖原子落盘，重启不丢）；流式请求在流收尾时补记
  usage 帧 token 数；`usageRetentionDays` 可设置保留天数（默认永久）。

## 快速开始

要求 Node.js ≥ 22。

```bash
cd agy-proxy
npm install
npm run build          # tsc + admin-ui + 静态资源拷贝
node dist/index.js serve   # 启动网关（或直接双击 start.cmd）
```

然后全部在浏览器完成：

1. 打开 **`http://127.0.0.1:8045/`**
2. 「账号池」→ **登录账号**：浏览器完成 Google OAuth 授权，账号自动入池（可连续添加多个）
3. 「接入密钥」→ **创建 API Key**，复制备用
4. 任意客户端接入（下方示例），「请求统计」页实时查看 token 用量与请求日志

CLI 登录仍可用作替代：`node dist/index.js login`（浏览器模式）或 `login --headless`（粘贴回调）。

### 客户端接入

```bash
KEY=你创建的API密钥

curl http://127.0.0.1:8045/healthz
curl -H "Authorization: Bearer $KEY" http://127.0.0.1:8045/v1/models

# OpenAI 兼容
curl -N http://127.0.0.1:8045/v1/chat/completions \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"model":"gemini-3.7-flash-tiered","stream":true,"messages":[{"role":"user","content":"你好"}]}'

# Anthropic 兼容（Claude Code CLI 直接可用）
export ANTHROPIC_BASE_URL=http://127.0.0.1:8045
export ANTHROPIC_API_KEY=$KEY
claude
```

### OAuth client_secret

无需手动配置。该客户端为"安装型"OAuth 客户端，id/secret 都是产品内置的公开标识符
（两个参考项目均原样内嵌）。本仓库不携带任何凭据字面量：登录时若未设置 `AGY_CLIENT_SECRET`，
会自动从公开参考源获取并仅在内存中使用；首次登录成功后自动迁入加密账号库，之后不再依赖。
环境变量 `AGY_CLIENT_SECRET` 仅作为覆盖项保留。

## 配置

数据目录 `~/.agy-proxy/`（`AGY_PROXY_HOME` 可覆盖）：`config.json`（host/port/apiKey/debugLog/
modelAliases/proxy/maxConcurrentUpstream/onlyRealModels/killSwitch/usageRetentionDays）、加密的 `accounts.enc.json`、
按天用量历史 `usage/YYYY-MM-DD.json`、可选 `fingerprint.json`（versions/sdkClients/osVersions/chromeVersions/electronVersions/versionFeeds 覆盖池；
版本池另由官方 release feed 每 6 小时自动保鲜）。

环境变量：`AGY_API_KEY`、`AGY_HOST`、`AGY_PORT`、`AGY_PROXY_PROXY`/`HTTPS_PROXY`（全局出站代理，
未设置时自动探测本机 Clash/v2rayN 常见端口）、`AGY_MIN_INTERVAL_MS`（全局最小调用间隔，0 关闭）、
`AGY_HEALTH_INTERVAL_MS`（后台健康巡检间隔毫秒数，默认 1800000，设 0 关闭定时器）、
`AGY_USAGE_RETENTION_DAYS`（用量历史保留天数，0=永久，默认 0）、
`AGY_ADMIN_TOKEN`（管理面写操作令牌；非回环监听时必设）。

## 安全设计

- 默认仅绑定 `127.0.0.1`；`/v1/*` 强制 API Key；管理面读开放（回环）/ 写受 Origin-CSRF 校验保护。
- 凭据导出为 POST 且纳入写保护；日志脱敏；默认不落盘对话内容——仅当开启 `debugLog` 时，
  完整请求/响应报文（含对话载荷）才会写入 `<dataDir>/debug/` 供本地排障，请勿提交或分享该目录。
- 所有出站请求统一经过 SSRF 防护（scheme/host/DNS 解析复检，防 DNS rebinding），兼容 TUN 代理 fake-ip。

## CLI

```
agy-proxy login [--headless] [--port]   # 登录（网页端登录的命令行替代）
agy-proxy status                        # 账号状态
agy-proxy models [email]                # 可用模型与配额
agy-proxy verify [email]                # 强制校验凭据/project（等同一次手动健康探测）
agy-proxy health [--email] [--interval <ms>]  # 全量健康巡检一轮 / --interval 常驻循环
agy-proxy proxy set <email> <url>       # 为账号绑定出站代理（http/https）
agy-proxy proxy clear <email>           # 清除绑定
agy-proxy proxy test <email>            # 经该代理真实探测
agy-proxy proxy list                    # 脱敏列出所有绑定
agy-proxy logout <email>                # 删除本地账号（不撤销 Google 侧授权）
agy-proxy usage [--days <n>]           # 列出最近 N 天的每日用量（默认 14）
agy-proxy usage --date <YYYY-MM-DD>    # 查看某一天的模型/账号分布明细
agy-proxy pause | resume                # 热开关 kill-switch
agy-proxy serve [--host] [--port]       # 启动网关
```

## 开发

```bash
npm run typecheck   # tsc --noEmit
npm test            # 构建 + adapter/pool/usage-history 三组离线冒烟断言
npm run build       # 完整构建（后端 + 管理台）
```
