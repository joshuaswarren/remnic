# Oh My Pi (omp) Integration

[Oh My Pi](https://omp.sh) (`omp`, [`can1357/oh-my-pi`](https://github.com/can1357/oh-my-pi))
is a terminal coding agent forked from [Pi](https://pi.dev). Because omp
preserves Pi's extension API — the same `context`, `turn_end`,
`session_shutdown`, and `session_before_compact` hooks — the existing
`@remnic/plugin-pi` runtime extension runs on omp unchanged. Only the
*installer* differs (omp keeps its agent files under `~/.omp/agent` instead of
`~/.pi/agent`), so Remnic ships a dedicated **`omp` connector** that writes into
the right place.

There are two ways to give omp the **same** governed memory that OpenClaw,
Claude Code, Codex, ChatGPT, and Pi already share. Both point omp at the *same*
Remnic daemon + memory directory, so memory written by any agent is recalled by
every agent.

> **One brain, many front-ends.** Shared memory only requires that every agent
> talks to one Remnic instance (one daemon URL + one `memoryDir`). omp joins as
> another front-end; it does not get a private store.

---

## Path 1 — Register Remnic as an MCP server (fast, no extension)

omp is a first-class MCP client. This is the quickest way to validate shared
read/write and needs no Remnic extension files.

First start the Remnic server (it serves the MCP endpoint on port 4318) and mint
a token — the same HTTP/MCP surface every other MCP client uses (see
[connector-setup.md](./connector-setup.md)):

```bash
remnic daemon start                       # serves http://localhost:4318/mcp
remnic connectors install generic-mcp     # mints the connector token ($REMNIC_AUTH_TOKEN)
```

Then point omp at it via `~/.omp/agent/mcp.json` (user scope) or `.omp/mcp.json`
(project scope) using the HTTP transport:

```json
{
  "$schema": "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json",
  "mcpServers": {
    "remnic": {
      "type": "http",
      "url": "http://localhost:4318/mcp",
      "headers": {
        "Authorization": "Bearer ${REMNIC_AUTH_TOKEN}",
        "X-Engram-Namespace": "my-project"
      }
    }
  }
}
```

This exposes Remnic's MCP tools (`remnic_recall`, `remnic_memory_store`,
`remnic_briefing`, `remnic_observe`, …) to omp against the same store the other
agents use. The optional `X-Engram-Namespace` header scopes memory to a
project/team.

> **Transport note.** The `remnic` binary does not serve MCP over stdio — the
> daemon's HTTP `/mcp` endpoint is the supported transport for every MCP client
> (OpenClaw plugin mode uses `openclaw engram access http-serve --port 4318`).

**Trade-off:** MCP recall is *tool-gated* — the model must decide to call
`remnic_recall`/`remnic_briefing`. There is no automatic system-prompt
injection. Use an omp rule/skill to nudge a `remnic_briefing` call at session
start, or use Path 2 for automatic recall.

---

## Path 2 — Install the native omp extension (recommended)

Start the Remnic daemon, then install the `omp` connector:

```bash
remnic daemon start
remnic connectors install omp
```

The installer writes (mirroring the Pi connector, under omp's agent home):

- `~/.omp/agent/extensions/remnic/index.ts` — omp auto-discovery wrapper
- `~/.omp/agent/extensions/remnic/remnic.config.json` — private daemon URL, namespace, and auth token (`0600`)
- `~/.omp/agent/extensions/remnic/README.md` — local operator notes

To skip writing the extension and only create the connector/token:

```bash
remnic connectors install omp --config installExtension=false
```

To target a non-default daemon or namespace:

```bash
remnic connectors install omp \
  --config remnicDaemonUrl=http://127.0.0.1:4318 \
  --config namespace=work
```

### Known issue: omp cannot resolve the extension's npm dependencies

> **Status:** open omp loader bug, confirmed against omp v16.3.5
> (macOS arm64 and Debian x64). Tracked for an installer-side fix in the
> Remnic repo — see the `OmpMemoryExtensionPublisher` auto-bundle issue.

omp's embedded runtime fails to resolve bare npm specifiers from the
extension's `node_modules`, even though the packages are installed and a
system `bun` resolves them fine from the same directory. Every session start
logs (and the extension silently never loads):

```text
Failed to load extension: ResolveMessage: Cannot find module
'@sinclair/typebox' from
'~/.omp/agent/extensions/remnic/node_modules/@remnic/plugin-pi/dist/index.js'
```

omp's extension loader has a compat shim that rewrites bare
`@sinclair/typebox` imports onto its host-bundled copy, but the rewrite does
not reach files under the extension's `node_modules`, and plain resolution
from those files fails inside omp's compiled binary.

**Workaround — pre-bundle the extension so nothing resolves at runtime.**

Step 1: the connector-generated `index.ts` imports `@remnic/plugin-pi` via a
`file://` URL pointing at the global install (`renderWrapper()` in
`packages/plugin-pi/src/publisher.ts`). Bun's bundler cannot resolve
`file://` specifiers (`Could not resolve: "file://…"`), so first convert the
extension directory to a self-contained npm layout with a bare-specifier
import:

```bash
# Resolve the extension root the same way the installer does (see
# "Install location" above): active profile wins, then PI_CODING_AGENT_DIR,
# then the default agent dir.
# Profile selection mirrors resolveOmpProfile(): OMP_PROFILE wins whenever it
# is SET (even set-but-empty — it does not fall through to PI_PROFILE), values
# are trimmed, and blank or the reserved "default" mean "no profile".
if [ "${OMP_PROFILE+x}" = "x" ]; then raw_profile="$OMP_PROFILE"; else raw_profile="${PI_PROFILE-}"; fi
profile="$(printf '%s' "$raw_profile" | xargs)"
[ "$profile" = "default" ] && profile=""
config_root="$HOME/${PI_CONFIG_DIR:-.omp}"
if [ -n "$profile" ]; then
  agent_dir="$config_root/profiles/$profile/agent"
elif [ -n "${PI_CODING_AGENT_DIR:-}" ]; then
  # Expand a leading tilde the way expandTildePath() does.
  case "$PI_CODING_AGENT_DIR" in
    "~") agent_dir="$HOME" ;;
    "~/"*) agent_dir="$HOME/${PI_CODING_AGENT_DIR#\~/}" ;;
    *) agent_dir="$PI_CODING_AGENT_DIR" ;;
  esac
else
  agent_dir="$config_root/agent"
fi
ext_dir="$agent_dir/extensions/remnic"
[ -f "$ext_dir/remnic.config.json" ] || {
  echo "Extension not installed at $ext_dir — run: remnic connectors install omp" >&2
  exit 1
}
cd "$ext_dir"
cat > index.ts <<'EOF'
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRemnicPiExtension } from "@remnic/plugin-pi";

// Resolve remnic.config.json relative to this file so the extension keeps
// working under profiles / custom agent dirs (OMP_PROFILE, PI_CONFIG_DIR,
// PI_CODING_AGENT_DIR). When bundled, this file runs from dist-bundle/, so
// also check one level up.
const here = dirname(fileURLToPath(import.meta.url));
const configPath = [
  join(here, "remnic.config.json"),
  join(here, "..", "remnic.config.json"),
].find(existsSync);

export default createRemnicPiExtension({ configPath });
EOF
npm init -y >/dev/null && npm install @remnic/plugin-pi
```

(Keep your existing `remnic.config.json` — only `index.ts` is replaced. The
relative lookup preserves the installer-written location instead of
hard-coding `~/.omp/agent`, so profile-scoped installs keep their token and
namespace.)

Step 2: bundle:

```bash
bun build index.ts --target=bun --outdir=dist-bundle
```

This inlines every dependency (only `node:` builtins stay external; native
addons such as lancedb are emitted as sibling `.node` assets — which is why
the bundle is **per-host** and must never be copied between machines). Then
point omp at the bundle instead of `index.ts` by adding an `omp.extensions`
manifest to the extension's `package.json` (omp prefers the manifest over
`index.ts`):

```json
{
  "omp": { "extensions": ["./dist-bundle/index.js"] },
  "scripts": {
    "postinstall": "bun build index.ts --target=bun --outdir=dist-bundle"
  }
}
```

The `postinstall` script keeps the bundle fresh across `npm install` /
`npm update` of `@remnic/plugin-pi`. For extra safety you can make the
manifest entry a small wrapper that compares the bundle's mtime against
`node_modules/@remnic/plugin-pi/dist/index.js` and re-runs `bun build`
before importing the bundle, so a stale bundle can never load silently.

Verify with a throwaway session — there must be no `Failed to load
extension` line for the remnic path:

```bash
omp -p --no-session "Reply with just: ok"
grep "Failed to load extension" ~/.omp/logs/omp.$(date +%F).log
```

Until the bundle workaround is in place, Path 1 (the raw MCP entry with an
`Authorization: Bearer` header) still works — only tool-gated access, no
automatic recall/observe.

### Install location

The connector writes into the same agent directory omp auto-discovers
extensions from, resolved the way omp's own `DirResolver` does:

- The config dir name is `PI_CONFIG_DIR` (default `.omp`).
- An active profile (`OMP_PROFILE`, falling back to `PI_PROFILE`) wins and
  targets `<configRoot>/profiles/<name>/agent`; omp discards `PI_CODING_AGENT_DIR`
  while a profile is active.
- Otherwise `PI_CODING_AGENT_DIR` overrides the whole agent dir.
- Otherwise the base is `~/.omp/agent`.

Install under the same profile/env you launch omp with (e.g.
`OMP_PROFILE=work remnic connectors install omp`) so the extension lands where
that profile scans. `remnic connectors remove omp` sweeps the base agent dir and
every `profiles/<name>/agent` under the config root, so removal cleans up a
profile-scoped install even if the profile env is not set at remove time. omp's
XDG redirection (`XDG_DATA_HOME`, …) relocates *data* dirs (sessions/state/cache),
**not** the extension dir, so it does not affect where the connector installs.

### Turn off omp's built-in memory

omp ships its own memory backends (`memory.backend: local` and
`memory.backend: mnemopi`). Those are **separate, per-project stores** that are
*not* shared with other agents. To make Remnic the single source of truth, leave
omp's backend off in `~/.omp/agent/config.yml`:

```yaml
memory:
  backend: off
```

Running both means two disjoint memories; pick Remnic (shared) or Mnemopi
(local-only), not both.

## What The Extension Does

- Uses the `before_agent_start` hook to inject recalled Remnic context into the system prompt.
- Uses `message_end`, `turn_end`, and `session_shutdown` hooks to observe user, assistant, and tool activity with `sourceFormat: "pi"`.
- Uses `session_before_compact` to flush Remnic LCM for the active session before omp compacts context, then records the compaction token delta.
- Registers Remnic MCP tools as omp tools when the Remnic daemon token is configured.
- Persists lightweight dedupe state with omp `custom` entries so repeated turns are not re-observed.

All of these hooks exist in omp's extension event surface (it is a superset of
Pi's), so the shared runtime extension binds without modification.

## omp Commands

The extension registers these slash commands:

- `/remnic-status` — check daemon health
- `/remnic-recall <query>` — recall Remnic context for a query
- `/remnic-remember <memory>` — explicitly store a memory
- `/remnic-lcm-search <query>` — search archived context
- `/remnic-why` — inspect the last recall explanation
- `/remnic-compact` — request compaction

## Configuration

The extension loads configuration from:

1. `REMNIC_OMP_CONFIG` (or `REMNIC_PI_CONFIG`, which takes precedence if both are set)
2. The explicit `configPath` written into the auto-discovery wrapper (`~/.omp/agent/extensions/remnic/remnic.config.json`)

Supported config keys:

| Key | Default | Description |
|-----|---------|-------------|
| `remnicDaemonUrl` | `http://127.0.0.1:4318` | Remnic HTTP/MCP daemon URL |
| `authToken` | unset | Connector token generated by `remnic connectors install omp` |
| `namespace` | unset | Remnic namespace for recall/observe/store requests |
| `recallMode` | `auto` | Recall mode: `auto`, `minimal`, `full`, `graph_mode`, or `no_recall` |
| `recallTopK` | `8` | Max recalled results |
| `recallBudgetChars` | `12000` | Max recalled context injected into omp |
| `recallEnabled` | `true` | Enable semantic recall before each user turn |
| `observeEnabled` | `true` | Enable turn observation |
| `observeSkipExtraction` | `false` | Archive observed messages without extraction |
| `compactionEnabled` | `true` | Enable LCM flush/checkpoint coordination |
| `mcpToolsEnabled` | `true` | Register Remnic MCP tools as omp tools |
| `statusEnabled` | `true` | Set omp UI status from daemon health |
| `requestTimeoutMs` | `60000` | HTTP/MCP request timeout for recall/observe/compaction/commands |
| `startupRequestTimeoutMs` | `1000` | Shorter timeout for startup-sensitive probes so a slow or offline daemon can't stall omp boot |

Boolean-like strings such as `"false"`, `"0"`, `"no"`, and `"off"` are treated as false.

> **Remote daemons: raise `startupRequestTimeoutMs`.** MCP tool registration happens once at session start (`tools/list` against the daemon) under this timeout, and a timeout is swallowed silently — the session simply runs without any `remnic_*` tools, while the separate (lighter) health probe can still report the daemon as ready. The `1000` default is tuned for a localhost daemon; when `remnicDaemonUrl` points at another machine (Tailscale/MagicDNS, VPN, LAN), one cold DNS resolution or relayed round trip can exceed it. Set `"startupRequestTimeoutMs": 10000` for remote daemons, and prefer a stable Tailscale IP over a MagicDNS name on hosts where MagicDNS is not enabled.

### Direct load (without the connector installer)

You can load the package directly, pointing it at a config via `REMNIC_OMP_CONFIG`:

```bash
REMNIC_OMP_CONFIG=~/.omp/agent/extensions/remnic/remnic.config.json \
  omp -e npm:@remnic/plugin-pi
```

## API Surface

omp uses the shared Remnic access layer, identical to Pi:

- `POST /engram/v1/recall`
- `POST /engram/v1/observe`
- `POST /engram/v1/lcm/search`
- `POST /engram/v1/lcm/compaction/flush`
- `POST /engram/v1/lcm/compaction/record`
- `POST /mcp` for MCP tool discovery and calls

Both canonical `remnic.*` MCP tools and legacy `engram.*` aliases remain available through the daemon.

## See Also

- [Pi Coding Agent Integration](./pi.md) — the upstream Pi connector this shares its runtime with.
- [Connector Setup Guide](./connector-setup.md) — MCP/HTTP config snippets for other agents.
