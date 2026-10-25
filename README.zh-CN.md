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

## 构建并安装 CLI

需要 Node 22.19+。

```bash
npm install
npm run build          # 生成 dist/，并给 dist/cli.js 加可执行权限
npm link               # 全局安装 `pi-managed-agents` 命令
# 或者：npm install -g .
pi-managed-agents      # 直接进入交互模式
```

想发给别人一个压缩包：

```bash
npm pack
npm install -g ./pi-managed-agents-0.1.0.tgz
pi-managed-agents --help
```

想要不依赖 Node 的单文件二进制（在目标系统和架构上构建）：

```bash
npm install -g bun     # 只有这个方案需要
npm run build:bin      # 生成 release/pi-managed-agents，约 100 MB
./release/pi-managed-agents
```

Bun 可以用 `--target=bun-linux-x64`、`bun-darwin-arm64` 等参数交叉编译。

## 交互模式

不带参数运行 `pi-managed-agents` 就进入交互模式：流式输出 assistant 文本、实时显示 tool 调用，并在多轮之间保持同一个 session 和 sandbox。

```bash
# 不需要 key，faux 模型会回显输入
npm run chat

# 真实 Anthropic 兼容端点
pi-managed-agents chat --provider anthropic --model deepseek-flash[1m] \
  --base-url https://api.deepseek.com/anthropic
```

交互命令：`/help`、`/new`、`/session`、`/sessions`、`/events [n]`、`/model`、`/quit`。
加 `--session <id>` 可以接着已有会话聊；如果上一轮停在 tool call 中间，启动时会自动 `wake`。

## Routines（定时任务）

`scripts/pi-agent-run-job` 是这台机器现有 `cloud-agent-run-job` 的同构版本：
同样的 job env 格式、`flock`、超时、日志保留，同样的 `PUSH_ON` / `[SILENT]` /
idempotency key 推送策略。区别是 agent：它跑的是 `pi-managed-agents`，
并且每次追加到同一个持久 session，而不是 `claude -p` 一次性执行。

`scripts/pi-agent-schedule` 使用独立的 `pi-agent-job-*` systemd timer 前缀，
不会动现有的 `cloud-agent-*` 任务。

```bash
npm run build
ln -sf "$PWD/scripts/pi-agent-run-job" ~/.local/bin/pi-agent-run-job
ln -sf "$PWD/scripts/pi-agent-schedule" ~/.local/bin/pi-agent-schedule

pi-agent-schedule add demo-files \
  --calendar "*-*-* 09:30:00" \
  --prompt-file ./examples/routines/demo-files.prompt.txt \
  --workspace ~/agent-workspace \
  --target user:ou_xxxxxxxxxxxxxxxx \
  --tools "Read Grep Glob" --push always

PUSH_DRY_RUN=1 pi-agent-schedule run demo-files
pi-agent-schedule logs demo-files
```

字段说明、工具到 hand 的映射、timer 管理见
[examples/routines/README.md](examples/routines/README.md)。

## Bridge adapter（飞书聊天 → harness）

`lark-channel-bridge` 只支持 Claude 和 Codex。`src/bridge/claude-shim.ts` 是一个
Claude 兼容 shim，让现有 bridge 不用改代码就能驱动 pi-managed-agents：

```bash
npm run build
./scripts/install-pi-bridge install --dry-run   # 预览
./scripts/install-pi-bridge install             # 写入 shim + systemd drop-in
./scripts/install-pi-bridge install --apply     # 重启 bridge
```

bridge 继续负责消息路由、会话连续性、排队、流式卡片、附件和访问控制；shim 负责
把 bridge 的 `claude -p --output-format stream-json` 协议翻译成 pi harness 调用，
并把 `Bash`/`Read`/`Write`/`Glob` 映射回 sandbox hands。

协议映射、权限模式、备份/回滚和已知限制见
[docs/bridge-adapter.md](docs/bridge-adapter.md)。

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
