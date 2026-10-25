# Routines

A routine is a prompt on a systemd timer, run by `pi-managed-agents` against a
persistent session, with the result pushed to Feishu through `lark-cli`.

This is intentionally the same shape as this machine's existing
`cloud-agent-schedule` + `cloud-agent-run-job` setup. The difference is the
agent: routines run the pi-managed-agents harness, not `claude -p`.

## Install the scripts

```bash
# from the repo root
npm run build
ln -sf "$PWD/scripts/pi-agent-run-job" ~/.local/bin/pi-agent-run-job
ln -sf "$PWD/scripts/pi-agent-schedule" ~/.local/bin/pi-agent-schedule
```

The runner finds the agent in this order:

1. `PI_AGENT_CMD` (e.g. `PI_AGENT_CMD="node /path/to/dist/cli.js"`)
2. `pi-managed-agents` on `PATH`
3. `node <repo>/dist/cli.js`

## Add a routine

```bash
pi-agent-schedule add demo-files \
  --calendar "*-*-* 09:30:00" \
  --prompt-file ./examples/routines/demo-files.prompt.txt \
  --workspace ~/agent-workspace \
  --target user:ou_xxxxxxxxxxxxxxxx \
  --tools "Read Grep Glob" \
  --push always
```

`--target` accepts `user:ou_xxx` or `chat:oc_xxx`. Set
`PI_AGENT_DEFAULT_TARGET` if you do not want to pass it every time.

The command writes:

- `~/.config/pi-agent/jobs/<name>.env`
- `~/.config/pi-agent/jobs/<name>.prompt.txt`
- `~/.config/systemd/user/pi-agent-job@.service`
- `~/.config/systemd/user/pi-agent-job-<name>.timer`

and enables the timer immediately.

## Run and inspect

```bash
pi-agent-schedule list
pi-agent-schedule run demo-files
pi-agent-schedule logs demo-files 100
systemctl --user list-timers 'pi-agent-job-*.timer'
```

To test without sending a Feishu message:

```bash
PUSH_DRY_RUN=1 pi-agent-schedule run demo-files
```

To stop notifications without removing the routine, set `PUSH_ON=never` in the
job env, or keep `[SILENT]` as the normal reply.

## What each job field means

| Field | Meaning |
|---|---|
| `PROMPT_FILE` / `PROMPT` | What to ask the agent |
| `WORKSPACE` | Working directory and sandbox root |
| `TARGET_TYPE` / `TARGET_ID` | Feishu DM (`user`) or group (`chat`) |
| `ALLOWED_TOOLS` | Claude-style tool list, mapped to sandbox hands |
| `TIMEOUT` | Per-run timeout, e.g. `10m` |
| `PUSH_ON` | `always`, `failure`, `nonempty`, `never` |
| `SILENT_MARKER` | Skip push when the answer contains this string |
| `SESSION_ID` | Persistent session; defaults to `routine_<name>` |
| `PROVIDER` / `MODEL` / `BASE_URL` | Model selection; defaults come from the environment |
| `SANDBOX` | `local` or `docker` |
| `CONTEXT_WINDOW` | Messages kept in each provider request |

## Tool mapping

| Claude-style | Sandbox hands |
|---|---|
| `Read`, `Grep`, `Glob` | `read_file`, `list_files` |
| `Write`, `Edit` | `write_file` |
| `Bash` | `bash` |
| `bypass` | all four |

`Bash` is broad: a shell command can read and write anywhere inside the
sandbox root. Use `Read Grep Glob` for strictly read-only routines.

## Why a persistent session?

Each routine keeps one session (`routine_<name>`). The harness's context policy
windows it, so the routine can see what it did last time without replaying the
whole history. That is the simplest useful form of routine memory. A real
long-term memory service can be layered on later.
