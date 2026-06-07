# Using Remnic with Codex CLI

[Codex CLI](https://github.com/openai/codex) is OpenAI's terminal-based coding agent. It reads, writes, and executes code locally while keeping your source on your machine. This guide shows how to give Codex persistent, cross-session memory through Remnic — so it remembers your projects, preferences, and past decisions every time you start a session.

## Why give Codex memory?

Codex is stateless by default. Every session starts from zero — it doesn't know your project conventions, past debugging sessions, or architecture decisions unless you re-explain them. Remnic fixes this.

### What changes with Remnic

| Without Remnic | With Remnic |
|---|---|
| Re-explain project conventions every session | Codex recalls coding standards, naming patterns, and folder structure automatically |
| Repeat architecture context for every task | Entity knowledge surfaces DB schemas, API contracts, and module boundaries on demand |
| Lose debugging context between sessions | Past root-cause analyses and dead-end paths are recalled, avoiding repeated work |
| Manually state preferences (test runner, linter, git workflow) | Preferences persist across sessions and projects |
| Third-party integration details forgotten | Remnic entities store API details, service endpoints, and integration patterns |
| Context-switching tax when resuming work | Session-start recall brings you back to speed instantly |

### Concrete examples

- **"Use snake_case for database columns"** — Remnic recalls this convention before Codex generates a migration.
- **"The payments module talks to Stripe via `PaymentGateway` service"** — Remnic surfaces this when Codex works on checkout code.
- **"Last time we debugged the N+1 query, the fix was eager-loading `user.orders`"** — Remnic prevents re-investigating the same issue.
- **"Joshua prefers pytest with strict typing and async-first design"** — Remnic adapts Codex's suggestions to your style.

## Prerequisites

- Codex CLI v0.114.0+ (`codex --version`)
- Remnic HTTP server running and reachable (see [API docs](../api.md#mcp-over-http))
- A bearer token for authentication
- **Node.js** in your PATH (`node --version`) — the bundled plugin hooks are a single cross-platform Node.js runner, so this is the only hard requirement on every platform.
- **Platform extras for the *manual* hook below:**
  - **macOS / Linux:** a POSIX shell plus `curl` (and `python3` only if you use the Python manual example).
  - **Windows 10/11:** **Windows PowerShell 5.1** ships with the OS — nothing to install. PowerShell 7 (`pwsh`) is optional. `Invoke-RestMethod` is built in, so `curl`/`python3` are *not* required. Use the PowerShell hook variant and `%USERPROFILE%` paths shown below.

> **Cross-platform note (issue #1440):** As of the cross-platform-hooks release, the bundled `@remnic/plugin-codex` hooks ship a unified Node.js runner with both `command` (POSIX `.sh`) and `commandWindows` (PowerShell `.ps1`) entries, so the **marketplace install and `remnic connectors install codex-cli` now work on Windows, macOS, and Linux** with no manual hook scripting. The bundled `hooks.json` resolves the runner via `${PLUGIN_ROOT}` (which Codex injects and substitutes for plugin hooks), so it works regardless of the session's working directory. Prefer those paths; the manual setup further down is only for advanced/custom cases.

## Quickest setup: `remnic connectors install codex-cli`

If you just want Remnic wired into Codex with sensible defaults, run:

```bash
remnic connectors install codex-cli
```

This writes a connector config, drops the Remnic **memory extension**
(`memories_extensions/remnic/instructions.md`) as a sibling of
`<codex_home>/memories/`, and runs a health check. Codex's phase-2
consolidation sub-agent auto-discovers the extension the next time it
runs — no further wiring needed.

To opt out of the memory extension (for users self-managing the Codex
memories_extensions folder):

```bash
remnic connectors install codex-cli --config installExtension=false
```

To target a non-default Codex home (for example an integration-test home
or a shared multi-user install):

```bash
CODEX_HOME=/srv/codex remnic connectors install codex-cli
# or
remnic connectors install codex-cli --config codexHome=/srv/codex
```

The rest of this guide covers manual setup for more advanced cases.

## Setup

### 1. Generate and set the token

Generate a secure token and add it to your shell profile (`~/.zshenv`, `~/.bashrc`, etc.) on every machine where Codex or Remnic runs:

```bash
# Generate a token (or use any secure random string)
openssl rand -base64 32

# Add to your shell profile
export REMNIC_AUTH_TOKEN="<paste-generated-token-here>"
```

Source the profile or open a new terminal so the variable is available.

### 2. Start the Remnic HTTP server

On the machine where Remnic runs:

```bash
npx remnic-server \
  --host 0.0.0.0 \
  --port 4318 \
  --auth-token "$REMNIC_AUTH_TOKEN"
```

Use `remnic daemon start` only when Codex and Remnic run on the same machine, or
when your `remnic.config.json` already sets a non-loopback bind address under
`server.host`. The daemon helper defaults to `127.0.0.1`, which is not reachable
from a second machine unless you change the config first.

If you have `namespacesEnabled: true` in your Remnic config, set the principal in
the config file rather than on the `remnic-server` command line. The standalone
server currently reads `server.principal` from config but does not expose a
`--principal` CLI flag.

```bash
cat > remnic.config.json <<EOF
{
  "remnic": {
    "namespacesEnabled": true
  },
  "server": {
    "host": "0.0.0.0",
    "port": 4318,
    "authToken": "${REMNIC_AUTH_TOKEN}",
    "principal": "generalist"
  }
}
EOF
```

For persistent operation, set up a launchd plist (macOS), systemd unit (Linux), or similar service manager so the server survives reboots.

### 3. Add Remnic as an MCP server

Edit `~/.codex/config.toml`:

```toml
[mcp_servers.remnic]
url = "http://<remnic-host>:4318/mcp"
bearer_token_env_var = "REMNIC_AUTH_TOKEN"
```

Replace `<remnic-host>` with:
- `127.0.0.1` if Codex and Remnic run on the same machine
- The machine's LAN IP or Tailscale IP for cross-machine access

Verify with:

```bash
codex mcp list
```

You should see `remnic` in the URL-based servers section with `Bearer token` auth.

### 4. Set up the SessionStart hook (recommended)

The hook automatically recalls relevant Remnic memories at the start of every Codex session, injecting them as context before your first message.

> Most users should skip this section and use the bundled plugin (marketplace or `remnic connectors install codex-cli`), which ships a maintained cross-platform hook. The manual script below is for custom setups. Pick the variant for your OS.

#### macOS / Linux (bash)

Create the hook script at `~/.codex/scripts/remnic-session-recall.sh`:

```bash
#!/usr/bin/env bash
# Codex SessionStart hook: recall Remnic context at session start.
set -euo pipefail

REMNIC_HOST="${REMNIC_HOST:-127.0.0.1}"
REMNIC_PORT="${REMNIC_PORT:-4318}"
REMNIC_TOKEN="${REMNIC_AUTH_TOKEN:-${OPENCLAW_REMNIC_ACCESS_TOKEN:-${OPENCLAW_ENGRAM_ACCESS_TOKEN:-}}}"
REMNIC_URL="http://${REMNIC_HOST}:${REMNIC_PORT}/engram/v1/recall"

# Read hook input from stdin
INPUT="$(cat)"

# Extract cwd from hook payload to build a meaningful recall query
CWD="$(echo "$INPUT" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('cwd',''))" 2>/dev/null || echo "")"
PROJECT_NAME="$(basename "$CWD" 2>/dev/null || echo "unknown")"

QUERY="Starting a new coding session in project: ${PROJECT_NAME}. Recall relevant memories, preferences, decisions, and context about this project and the user."

# If no token, skip gracefully
if [ -z "$REMNIC_TOKEN" ]; then
  echo '{"continue":true,"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"[Remnic: no token set — skipping memory recall]"}}'
  exit 0
fi

# Call Remnic recall API
RESPONSE="$(curl -s --max-time 8 \
  -X POST "$REMNIC_URL" \
  -H "Authorization: Bearer ${REMNIC_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"query\": $(echo "$QUERY" | python3 -c "import json,sys; print(json.dumps(sys.stdin.read().strip()))"), \"topK\": 12}" \
  2>/dev/null || echo "")"

# Extract the context field
if [ -n "$RESPONSE" ]; then
  CONTEXT="$(echo "$RESPONSE" | python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
    ctx = d.get('context', '')
    count = d.get('count', 0)
    if ctx:
        print(f'[Remnic Memory Recall — {count} memories]\n\n{ctx}')
    else:
        print('[Remnic: no relevant memories found for this session]')
except Exception:
    print('[Remnic: recall response parse error]')
" 2>/dev/null || echo "[Remnic: recall failed]")"
else
  CONTEXT="[Remnic: server unreachable — continuing without memory recall]"
fi

# Return hook output with additionalContext
python3 -c "
import json, sys
context = sys.stdin.read()
output = {
    'continue': True,
    'hookSpecificOutput': {
        'hookEventName': 'SessionStart',
        'additionalContext': context
    }
}
print(json.dumps(output))
" <<< "$CONTEXT"
```

Make it executable:

```bash
chmod +x ~/.codex/scripts/remnic-session-recall.sh
```

#### Windows (PowerShell)

Windows has no `bash`, `curl`, `python3`, or `chmod` by default — and there is no `chmod` step (PowerShell scripts are run by the interpreter, not by an executable bit). Create the hook at `%USERPROFILE%\.codex\scripts\remnic-session-recall.ps1` instead. It uses the built-in `Invoke-RestMethod`, so no extra tools are needed:

```powershell
#requires -Version 5.1
# Codex SessionStart hook: recall Remnic context at session start.
$ErrorActionPreference = 'Stop'

$remnicHost = if ($env:REMNIC_HOST) { $env:REMNIC_HOST } else { '127.0.0.1' }
$remnicPort = if ($env:REMNIC_PORT) { $env:REMNIC_PORT } else { '4318' }
$token = $env:REMNIC_AUTH_TOKEN
if (-not $token) { $token = $env:OPENCLAW_REMNIC_ACCESS_TOKEN }
if (-not $token) { $token = $env:OPENCLAW_ENGRAM_ACCESS_TOKEN }
$url = "http://${remnicHost}:${remnicPort}/engram/v1/recall"

# Read the hook payload from stdin.
$raw = [Console]::In.ReadToEnd()
$cwd = ''
try { $cwd = (ConvertFrom-Json $raw).cwd } catch {}
$project = if ($cwd) { Split-Path -Leaf $cwd } else { 'unknown' }

function Emit($context) {
  @{ continue = $true; hookSpecificOutput = @{ hookEventName = 'SessionStart'; additionalContext = $context } } |
    ConvertTo-Json -Compress -Depth 5
}

if (-not $token) { Emit '[Remnic: no token set — skipping memory recall]'; exit 0 }

$query = "Starting a new coding session in project: $project. Recall relevant memories, preferences, decisions, and context about this project and the user."
$body = @{ query = $query; topK = 12 } | ConvertTo-Json -Compress
try {
  $resp = Invoke-RestMethod -Method Post -Uri $url -TimeoutSec 15 `
    -Headers @{ Authorization = "Bearer $token" } -ContentType 'application/json' -Body $body
  if ($resp.context) {
    Emit ("[Remnic Memory Recall — $($resp.count) memories]`n`n" + $resp.context)
  } else {
    Emit '[Remnic: no relevant memories found for this session]'
  }
} catch {
  Emit '[Remnic: server unreachable — continuing without memory recall]'
}
```

#### Configure the hook

Add the hook to `~/.codex/hooks.json` (macOS/Linux) or `%USERPROFILE%\.codex\hooks.json` (Windows). Provide **both** `command` (POSIX) and `commandWindows` (PowerShell) so the same config works everywhere — Codex picks the right one per platform:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "<full-path-to>/remnic-session-recall.sh",
            "commandWindows": "powershell -NoProfile -ExecutionPolicy Bypass -File <full-path-to>\\remnic-session-recall.ps1",
            "timeout": 15
          }
        ]
      }
    ]
  }
}
```

Replace `<full-path-to>` with the absolute path on each platform — e.g. `/Users/you/.codex/scripts/remnic-session-recall.sh` (macOS/Linux) and `C:\Users\you\.codex\scripts\remnic-session-recall.ps1` (Windows). `powershell` is Windows PowerShell 5.1, which ships with Windows 10/11; if you've installed PowerShell 7 you can substitute `pwsh`.

### 5. Tell Codex how to use Remnic (optional)

You can add instructions to your `AGENTS.md` (global or project-level) to guide Codex on when to use Remnic tools:

```markdown
## Memory

Remnic is available as an MCP server for long-term memory.

- Use `remnic.recall` for targeted lookups on specific topics.
- Use `remnic.memory_store` to persist durable facts, preferences, decisions, and corrections.
- Use `remnic.entity_get` to look up known entities (people, projects, tools, companies).
- If the Remnic MCP server is unavailable, proceed without memory.
```

## Available tools

Once connected, Codex has access to these Remnic MCP tools:

| Tool | Purpose |
|------|---------|
| `remnic.recall` | Retrieve relevant memories for a query |
| `remnic.recall_explain` | Debug the last recall (what was retrieved and why) |
| `remnic.memory_get` | Fetch a specific memory by ID |
| `remnic.memory_timeline` | View a memory's lifecycle history |
| `remnic.memory_store` | Store a new explicit memory |
| `remnic.suggestion_submit` | Queue a memory suggestion for review |
| `remnic.entity_get` | Look up a known entity by name |
| `remnic.review_queue_list` | View the governance review queue |

## Cross-machine setup

If Remnic runs on a different machine than Codex (e.g., a home server), use a VPN or overlay network like [Tailscale](https://tailscale.com) to make the HTTP server reachable:

1. Install Tailscale on both machines
2. Use the Remnic host's Tailscale IP in `config.toml` and the hook script
3. Set `REMNIC_HOST` in the hook script to the Tailscale IP

The hook script gracefully degrades — if the Remnic server is unreachable or the token is missing, it skips recall and lets the session proceed normally.

## Verification

After setup, start a new Codex session and check:

1. **MCP tools available:** Ask Codex to list its available tools — you should see `remnic.*` tools.
2. **Recall working:** The session should start with `[Remnic Memory Recall — N memories]` context if the hook is configured.
3. **Writes working:** Ask Codex to store a test memory: `Use remnic.memory_store to save "test memory from Codex" with category "fact" and dryRun true`. It should return `"status": "validated"`.

## Troubleshooting

**Remnic tools not showing up in Codex:**
- Codex loads MCP servers at session start. If the server was down when the session started, restart Codex.
- Verify with `codex mcp list` — remnic should show `enabled` with `Bearer token` auth.
- Check the server is reachable: `curl -s http://<host>:4318/mcp -X POST -H "Authorization: Bearer $REMNIC_AUTH_TOKEN" -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'`

**"namespace is not writable" error:**
- You have `namespacesEnabled: true` in your Remnic config. Set `server.principal` in `remnic.config.json` so it matches a `writePrincipals` entry for your target namespace.

**Hook not firing:**
- Verify `~/.codex/hooks.json` (`%USERPROFILE%\.codex\hooks.json` on Windows) exists and uses the correct absolute path.
- **macOS / Linux:** ensure the script is executable (`chmod +x`) and that `node` is on PATH (the bundled hooks are Node.js).
- **Windows:** there is no `chmod` step. Make sure the `commandWindows` entry is present and that `powershell` (Windows PowerShell 5.1, ships with Windows; `pwsh` for PowerShell 7) and `node` are on PATH. If scripts are blocked by policy, the `-ExecutionPolicy Bypass` flag in the example handles it; you do not need to change machine policy.
- Check that `REMNIC_AUTH_TOKEN` is set in your environment. The older `OPENCLAW_REMNIC_ACCESS_TOKEN` and `OPENCLAW_ENGRAM_ACCESS_TOKEN` names are still accepted during the compatibility window.

**Slow session start:**
- The hook has a 15-second timeout. If the Remnic server is slow to respond, increase the `timeout` value in `hooks.json` or reduce `topK` in the recall query.

## Native memory materialization

Codex's phase-2 consolidation reads canonical files under `<codex_home>/memories/`
(`memory_summary.md`, `MEMORY.md`, `raw_memories.md`, `rollout_summaries/*.md`).
Remnic can mirror hot memories into this exact layout so the always-loaded
`memory_summary.md` is populated with Remnic content — giving Codex a quick
cross-session pass without any MCP roundtrips.

Materialization is **opt-in via a sentinel file** (`<codex_home>/memories/.remnic-managed`):
if the sentinel is missing, Remnic will skip the directory and log a warning,
so hand-edited layouts are never clobbered. Writes are atomic (temp dir +
rename), and idempotent no-ops happen whenever the content hash is unchanged.

Triggers (all configurable):

- After semantic or causal consolidation completes (`codexMaterializeOnConsolidation`)
- At Codex session end via the bundled Stop hook (`codexMaterializeOnSessionEnd`)
- Manually: `tsx scripts/codex-materialize.ts --reason manual`

See [plugins/codex.md — Native memory materialization](../plugins/codex.md#native-memory-materialization)
for the full list of config knobs and the opt-out procedure.
