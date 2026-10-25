# pi-managed-agents

English | [简体中文](README.zh-CN.md)

A minimal, runnable reproduction of the architecture described in Anthropic's
[**Scaling Managed Agents: Decoupling the brain from the hands**](https://www.anthropic.com/research/managed-agents)
(April 2026), built on [`@earendil-works/pi-agent-core`](https://github.com/earendil-works/pi).

This is not a port of Anthropic's service and it is not affiliated with
Anthropic. It is a small reference implementation of the three interfaces the
article argues for: **session**, **harness**, and **sandbox**.

```
                    ┌────────────────────────────────────┐
                    │ Session                            │
                    │ append-only event log, durable,    │
                    │ outside the context window         │
                    └───────────────┬────────────────────┘
                         getEvents  │  emitEvent
                    ┌───────────────▼────────────────────┐
                    │ Harness ("brain")                  │
                    │ stateless agent loop               │
                    │ pi-agent-core Agent + ContextPolicy│
                    └───────────────┬────────────────────┘
                         execute(name, input) -> string
                    ┌───────────────▼────────────────────┐
                    │ Sandbox ("hands")                  │
                    │ local | docker | anything else     │
                    └────────────────────────────────────┘
```

The harness never imports a sandbox implementation. It only knows the
`execute(name, input) -> string` shape. Swap the hand, keep the brain.

## What is implemented

| Article concept | Code |
|---|---|
| Session is an append-only log outside the context window | `src/session/store.ts`, `src/session/events.ts` |
| Context is a slice of the session, not the whole log | `src/session/context.ts` (`Full`, `Window`, `Pinned`) |
| Harness is stateless and recoverable | `src/harness/harness.ts` (`run`, `wake`) |
| Container failures become tool-call errors | `src/sandbox/runtime.ts` (`SandboxRuntime`) |
| Containers are cattle, provisioned lazily | `src/sandbox/runtime.ts`, `src/bench/ttft.ts` |
| Hands are interchangeable | `src/sandbox/local.ts`, `src/sandbox/docker.ts`, one `execute` tool in `src/harness/tools.ts` |
| Credentials never enter the sandbox | `src/credentials/vault.ts`, `src/credentials/mcp-proxy.ts` |
| Git token wired in at provision time, then gone | `src/credentials/git.ts` |
| Many brains / many hands | `examples/many-brains.ts` |
| Orphaned tool calls after a crash | `Harness.wake` + `recoverOrphanToolCalls` |

## Quickstart

```bash
npm install
npm run demo          # session + harness + local sandbox, end to end
npm run demo:crash    # kill the harness, wake a new one from the log
npm run demo:security # vault + session-scoped MCP proxy + sandbox inspection
npm run demo:many     # four stateless harnesses running concurrently
npm run bench         # simulated eager vs lazy provisioning TTFT
npm test              # 23 tests
```

Node 22.19+ is required (the pi packages' engine constraint).

### CLI

```bash
# deterministic faux model, no API key
npx tsx src/cli.ts run "show me the sandbox"

# inspect
npx tsx src/cli.ts sessions
npx tsx src/cli.ts events <sessionId>

# resume any session; if the last turn is complete this is a no-op
npx tsx src/cli.ts resume <sessionId>

# real provider: keys are resolved by pi-ai from the environment
ANTHROPIC_API_KEY=... npx tsx src/cli.ts run "list the files" --provider anthropic --model <model-id>
OPENAI_API_KEY=...    npx tsx src/cli.ts run "list the files" --provider openai    --model <model-id>

# Anthropic Messages-compatible endpoint not in the catalog
# (DeepSeek, an internal gateway, ...). Auth still comes from
# ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY.
ANTHROPIC_AUTH_TOKEN=... npx tsx src/cli.ts run "list the files" \
  --provider anthropic --model deepseek-flash[1m] \
  --base-url https://api.deepseek.com/anthropic

# eager provisioning instead of lazy
npx tsx src/cli.ts run "..." --eager

# Docker hands
npx tsx src/cli.ts run "..." --sandbox docker
```

`--provider faux` ignores the task text and runs a scripted tool call followed
by a fixed answer. It exists so the architecture is runnable with no keys and
deterministic in tests.

## The important flows

### 1. A normal run

`Harness.run(sessionId, input)`:

1. appends `run_started` to the session
2. rebuilds the transcript from the session using the context policy
3. creates a fresh pi-agent-core `Agent`
4. lazily provisions the sandbox only when the first `execute` call happens
5. mirrors every durable message and tool event into the session
6. appends `run_finished` after the loop settles

The session is the source of truth. The in-memory `Agent` transcript is a
cache that can be discarded at any time.

### 2. Crash recovery

`examples/crash-recovery.ts` simulates a harness dying after the assistant
recorded a tool call but before the tool result was durable. `Harness.wake`:

1. reads the session log
2. finds the assistant message with no matching `toolResult`
3. replays the orphaned `execute` call
4. appends the tool result
5. starts a new stateless harness and calls `agent.continue()`

Run it:

```bash
npm run demo:crash
```

You will see the session before and after recovery, including the duplicate
`tool_started` / `tool_finished` audit events from the replay. The transcript
still has exactly one user message and one tool result.

### 3. Lazy provisioning and TTFT

`Harness` does not provision a sandbox before the first model request unless
`eagerProvision: true`. A session that never touches a hand never pays for one.

`npm run bench` simulates provisioning latency (with a heavy tail) and model
latency:

```
             p50       p95       mean
eager      232ms     802ms     277ms
lazy        89ms     100ms      88ms

p50 reduction: 61.9%
p95 reduction: 87.6%
```

These numbers are a simulation, not a measurement of Anthropic's service. They
reproduce the shape of the article's claim: eager container setup puts a
heavy-tailed cost on every session's critical path; lazy setup removes it.

### 4. The credential boundary

`examples/security-demo.ts` demonstrates the pattern:

- the real token lives in `Vault`, in the host process
- the sandbox is provisioned with `MCP_PROXY_URL` and a random
  session-scoped token
- `McpProxy` maps that token to a session, fetches the real credential from the
  vault, and injects it upstream
- the sandbox's `env` and files contain no real token
- the session log contains no real token
- a request without the session token gets `401`

The same idea applies to git: `provisionGitRepo` passes the token through
git's one-shot `GIT_CONFIG_*` environment, rewrites the remote to the clean
URL, and never writes the token into `.git/config`.

### 5. Context policy

`ContextPolicy` has two jobs:

- `select(events)` rebuilds a transcript after a wake
- `prune(messages)` trims the live transcript before every provider request

`WindowContextPolicy(40)` keeps the last 40 messages and never splits a tool
call from its result. `PinnedContextPolicy` keeps the original user goal plus a
tail. Both are deliberately simple; the article's point is that this policy is
harness code, not session storage, so it can change as models improve.

## Project layout

```
src/
  session/      append-only event log, queries, context policies, formatting
  sandbox/      Sandbox interface, LocalSandbox, DockerSandbox, SandboxRuntime
  credentials/  Vault, McpProxy, git provisioning
  harness/      the execute tool, Harness.run, Harness.wake, recovery
  model/        faux provider for tests, real provider factory
  bench/        simulated TTFT benchmark
examples/       runnable demos
test/           node:test suite
```

## Design notes

**Why pi-agent-core?** It provides the agent loop, tool-call execution, event
stream and transcript handling. This project deliberately does not reimplement
the loop; it wraps the loop in the session/harness/sandbox boundaries. That is
the same division of responsibility the article describes: the harness is the
loop plus routing, not the model.

**System prompt and tool declarations.** pi-agent-core keeps these in the
transcript as system messages. `ContextPolicy.prune` preserves all system
messages and only trims the conversational tail, so tool declarations are not
lost when the window shrinks.

**One `execute` tool.** The model does not get `bash`, `read_file`, `git`, or
`mcp__*` as separate tools. It gets one tool with the shape
`execute(name, input)`. That is what lets a hand be a container, a phone, or a
Pokémon emulator without changing the brain.

**Failure semantics.** `SandboxUnavailableError` means the hand is gone. The
runtime converts it into a tool error and provisions a replacement on the next
call. `SandboxExecutionError` means the command failed; the sandbox survives and
the error is returned to the model unchanged.

## Production gaps

This is a reference implementation, not a service. Missing or simplified:

- **Durability**: `FileSessionStore` is one JSONL file per session and
  serializes appends inside one process. A real deployment needs a log with
  cross-process conditional writes (Postgres, Kafka, object storage) and a
  proper session id / tenancy model.
- **Concurrency**: `Harness` uses an in-process `Set` to prevent two runs on
  the same session. It does not coordinate across processes.
- **Isolation**: `LocalSandbox` runs `bash` on the host. It is a development
  shim, not a security boundary. Use `DockerSandbox` with `--network none`, or a
  real remote sandbox, for untrusted code.
- **Sandbox persistence**: a new local sandbox points at the same directory for
  crash demos, but a Docker replacement starts empty. Real systems reinitialize
  from `provision({resources})` and keep durable state outside the sandbox.
- **Credentials**: `McpProxy` is HTTP-only, loopback-only, and keeps grants in
  memory. Production needs TLS, an auth service, per-tool scopes, rotation,
  revocation and audit.
- **Observability**: events are recorded but not exported as metrics/traces.
- **Evals**: no evaluation harness or regression suite for agent behavior.

## Tests

```bash
npm test
npm run typecheck
npm run build
```

The suite covers the append-only log, context policies, local sandbox behavior,
lazy provisioning, sandbox loss/replacement, crash recovery, MCP proxy
credential isolation, git token sanitization, and the simulated TTFT result.

Docker is optional. `DockerSandbox` is exercised manually (or in CI with
`TEST_DOCKER=1` if you add such a test); the default suite does not require
Docker.

## References

- Anthropic, [Scaling Managed Agents: Decoupling the brain from the hands](https://www.anthropic.com/research/managed-agents)
- Anthropic, [Effective harnesses for long-running agents](https://www.anthropic.com/research/effective-harnesses-for-long-running-agents)
- OpenAI, [Unrolling the Codex agent loop](https://openai.com/index/unrolling-the-codex-agent-loop/)
- LangChain, [The Anatomy of an Agent Harness](https://blog.langchain.com/the-anatomy-of-an-agent-harness/)
- Martin Fowler / Birgitta Böckeler, [Harness engineering for coding agent users](https://martinfowler.com/articles/harness-engineering.html)

## License

MIT
