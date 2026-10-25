# Bridge adapter: let lark-channel-bridge drive pi-managed-agents

`lark-channel-bridge` only knows two agent kinds: `claude` and `codex`. Rather
than fork the bridge, this project ships a **Claude-compatible shim**:

```text
Feishu message
  -> lark-channel-bridge (unchanged)
  -> spawns `claude -p --output-format stream-json ...`
  -> ~/.local/bin/pi-bridge/claude  (our shim)
  -> pi-managed-agents Harness (session / harness / sandbox)
  -> Claude stream-json lines back to the bridge
  -> streaming card in Feishu
```

The bridge keeps doing what it is good at: Feishu auth, message routing,
session continuity, queueing, streaming cards, attachments, access control. The
shim only translates one protocol into the other.

## What the shim does

The bridge runs:

```bash
claude -p \
  --output-format stream-json \
  --verbose \
  --permission-mode <mode> \
  --append-system-prompt-file <file> \
  [--resume <bridgeSessionId>] [--model <model>]
```

and writes the prompt to stdin. The shim:

1. reads the prompt and the appended bridge system prompt
2. maps `--resume <id>` to a persistent pi session (`bridge_<id>`)
3. runs the pi-managed-agents harness in the bridge's `cwd`
4. emits Claude stream-json events:
   - `system/init`
   - `assistant` text deltas
   - `assistant` tool_use blocks (`Bash`, `Read`, `Write`, `Glob`)
   - `user` tool_result blocks
   - `result` with usage
5. delegates to the real `claude` binary for every non-bridge invocation
   (`--version`, interactive use, `-p` without `stream-json`).

## Install

Build first:

```bash
npm run build
```

Preview the change:

```bash
./scripts/install-pi-bridge install --dry-run
```

Install the shim and the systemd drop-in, but do **not** restart the bridge:

```bash
./scripts/install-pi-bridge install
```

Apply it (restarts the bridge, so the next Feishu message goes to pi):

```bash
./scripts/install-pi-bridge install --apply
```

The installer:

- creates `~/.local/bin/pi-bridge/claude` → `dist/bridge/claude-shim.js`
- writes
  `~/.config/systemd/user/lark-channel-bridge.bot.claude.service.d/pi-adapter.conf`
  with `PI_BRIDGE_AGENT=pi`, `PI_REAL_CLAUDE_BIN`, `PI_BRIDGE_SESSIONS_DIR`
  and a `PATH` that puts the shim directory first
- backs up `~/.lark-channel/profiles/claude/sessions.json`
- reloads systemd

The bridge is **not** restarted unless you pass `--apply`.

## Check and revert

```bash
./scripts/install-pi-bridge status
./scripts/install-pi-bridge uninstall          # remove drop-in, keep bridge running
./scripts/install-pi-bridge uninstall --apply  # remove and restart
```

After reverting, restore the session backup if you want the previous Claude
conversations back:

```bash
ls ~/.lark-channel/profiles/claude/sessions.json.bak-pi-*
cp ~/.lark-channel/profiles/claude/sessions.json.bak-pi-<timestamp> \
   ~/.lark-channel/profiles/claude/sessions.json
systemctl --user restart lark-channel-bridge.bot.claude.service
```

## Permissions and hands

| Claude permission mode | Hands |
|---|---|
| `bypassPermissions`, `acceptEdits`, `auto` | all four |
| `manual`, `default` | `read_file`, `list_files` |

The shim has no approval UI, so `manual` is intentionally read-only. The bridge's
own access control (`allowedUsers`, `allowedChats`, admins, mention gating) still
decides who can talk to the bot. Set `PI_BRIDGE_ALLOWED_HANDS` to override the
mapping.

## Tools

The model only sees one pi tool, `execute(name, input)`. The shim maps hands to
Claude-style names for the bridge's UI:

| Hand | Bridge tool name |
|---|---|
| `bash` | `Bash` |
| `read_file` | `Read` |
| `write_file` | `Write` |
| `list_files` | `Glob` |

## Model and credentials

The shim inherits the bridge's environment, including the systemd
`EnvironmentFile` (`~/.config/lark-channel/agent.env`). It resolves the model in
this order:

1. `--model` from the bridge
2. `ANTHROPIC_MODEL`
3. the first Anthropic model in pi-ai's catalog

If `ANTHROPIC_BASE_URL` is set, the shim uses
`createAnthropicCompatibleRuntime`, so DeepSeek's `/anthropic` endpoint and
internal gateways work without a catalog entry.

## Known limits

- Only `LocalSandbox` is wired in. The bridge already runs on the host and
  passes `cwd`; a Docker sandbox needs a workspace volume mapping.
- Existing Claude session ids are not understood by the shim. The installer
  backs up `sessions.json`; use `/new` in a chat to start clean.
- The bridge's Claude-specific `/resume` history does not carry over.
- The shim is opt-in and reversible; it does not patch the bridge package.
- For a long-term solution, add a real `pi` agent kind to the bridge source
  (`AgentAdapter` interface) instead of translating Claude stream-json.
