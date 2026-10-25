# pi-managed-agents（中文）

[English](README.md) | 简体中文

用 [`@earendil-works/pi-agent-core`](https://github.com/earendil-works/pi) 复现 Anthropic
[《Scaling Managed Agents: Decoupling the brain from the hands》](https://www.anthropic.com/research/managed-agents)
里的架构。

这不是 Anthropic 的官方实现，也不是生产级服务，而是一个能跑起来的 reference
implementation：把文章里的 session / harness / sandbox 三个接口，落成可阅读、
可测试、可替换实现的 TypeScript 代码。

## 它做了什么

把 agent 拆成三层：

- **Session**：append-only 事件日志，持久化在上下文窗口和 sandbox 之外。
  harness 可以按位置读取、回看、重读；完整历史永远不丢。
- **Harness（大脑）**：无状态的 agent 循环，基于 pi-agent-core 的 `Agent`。
  崩溃后用 `wake(sessionId)` 从日志重建，不依赖进程内状态。
- **Sandbox（手）**：统一成 `execute(name, input) -> string`。
  本地进程和 Docker 容器实现同一个接口；按需创建，丢了就把错误交给模型，
  下次调用自动换一个新的。

## 能跑出来的效果

```bash
npm install
npm run demo          # 完整跑一轮：写文件、列目录、返回答案
npm run demo:crash    # 模拟 harness 崩溃，新 harness 重放 orphan tool call 并继续
npm run demo:security # 真实 token 在 vault，sandbox 只拿 session token，走 MCP proxy
npm run demo:many     # 4 个无状态 harness 并发
npm run bench         # 模拟 TTFT：p50 降约 62%，p95 降约 88%
npm test              # 23 个测试
```

## 文章概念与代码对照

| 文章里的概念 | 代码位置 |
|---|---|
| Session 是 context window 之外的 append-only 日志 | `src/session/store.ts`、`src/session/events.ts` |
| 上下文是 session 的一个切片，不是整个日志 | `src/session/context.ts` |
| Harness 无状态、可恢复 | `src/harness/harness.ts`（`run`、`wake`） |
| 容器失败变成 tool-call error | `src/sandbox/runtime.ts` |
| 容器是 cattle，按需创建 | `src/sandbox/runtime.ts`、`src/bench/ttft.ts` |
| 手可以互换 | `src/sandbox/local.ts`、`src/sandbox/docker.ts` |
| 凭证不进入 sandbox | `src/credentials/vault.ts`、`src/credentials/mcp-proxy.ts` |
| git token 只在初始化时用一次 | `src/credentials/git.ts` |
| many brains / many hands | `examples/many-brains.ts` |

## 常用命令

```bash
# 不需要 API key，用 faux 模型跑确定性 demo
npx tsx src/cli.ts run "show me the sandbox"

# 查看会话和事件
npx tsx src/cli.ts sessions
npx tsx src/cli.ts events <sessionId>

# 从日志恢复一个会话
npx tsx src/cli.ts resume <sessionId>

# 真实模型：pi-ai 会从环境变量读取 key
ANTHROPIC_API_KEY=... npx tsx src/cli.ts run "list the files" --provider anthropic --model <model-id>
OPENAI_API_KEY=...    npx tsx src/cli.ts run "list the files" --provider openai    --model <model-id>

# Anthropic Messages 兼容端点（DeepSeek、内部网关等），模型不在 catalog 里也能用
# 认证仍然走 ANTHROPIC_AUTH_TOKEN 或 ANTHROPIC_API_KEY
ANTHROPIC_AUTH_TOKEN=... npx tsx src/cli.ts run "list the files" \
  --provider anthropic --model deepseek-flash[1m] \
  --base-url https://api.deepseek.com/anthropic

# Docker sandbox
npx tsx src/cli.ts run "..." --sandbox docker
```

## 一些设计取舍

- 模型只拿到一个 `execute(name, input)` 工具，而不是 `bash`、`read_file`、`mcp__*`
  一堆工具。这样换 sandbox 不需要改 harness。
- `ContextPolicy` 负责两件事：`select(events)` 在唤醒时重建 transcript，
  `prune(messages)` 在每次请求前裁剪。策略是 harness 的代码，不是 session 的存储格式。
- `SandboxUnavailableError` 表示容器没了，转成 tool error 并换新；
  `SandboxExecutionError` 表示命令失败，容器还在，错误原样回给模型。

## 限制

- `LocalSandbox` 的 `bash` 跑在宿主机上，只是开发 shim，**不是安全边界**。
  需要隔离请用 `DockerSandbox` 或真正的远程 sandbox。
- `FileSessionStore` 是单进程追加锁；跨进程需要 Postgres / Kafka / 对象存储。
- `McpProxy` 是 loopback-only 的内存授权，生产需要 TLS、持久化、权限范围和审计。
- `npm run bench` 是模拟数据，不是 Anthropic 服务的实测。

## License

MIT
