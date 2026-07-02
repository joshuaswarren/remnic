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

Add Remnic to `~/.omp/agent/mcp.json` (user scope) or `.omp/mcp.json` (project
scope):

```json
{
  "$schema": "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json",
  "mcpServers": {
    "remnic": {
      "type": "stdio",
      "command": "remnic",
      "args": ["access", "mcp-serve"]
    }
  }
}
```

This exposes Remnic's MCP tools (`remnic_recall`, `remnic_memory_store`,
`remnic_briefing`, `remnic_observe`, …) to omp against the same store the other
agents use. The stdio server authenticates as the trusted principal from your
Remnic config/env, so no bearer token is required for a local subprocess.

**Cross-machine / HTTP transport.** If the daemon runs elsewhere, start the
authenticated HTTP surface (`remnic access http-serve --port 4318`) and point
omp at its `/mcp` endpoint with a token:

```json
{
  "mcpServers": {
    "remnic": {
      "type": "http",
      "url": "http://127.0.0.1:4318/mcp",
      "headers": { "Authorization": "Bearer ${REMNIC_TOKEN}" }
    }
  }
}
```

Generate a token with `remnic connectors install generic-mcp` (or
`remnic token generate omp`).

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

- Uses the `context` hook to recall relevant Remnic context before an agent turn.
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
| `recallEnabled` | `true` | Enable context-hook recall |
| `observeEnabled` | `true` | Enable turn observation |
| `observeSkipExtraction` | `false` | Archive observed messages without extraction |
| `compactionEnabled` | `true` | Enable LCM flush/checkpoint coordination |
| `mcpToolsEnabled` | `true` | Register Remnic MCP tools as omp tools |
| `statusEnabled` | `true` | Set omp UI status from daemon health |
| `requestTimeoutMs` | `60000` | HTTP/MCP request timeout for recall/observe/compaction/commands |
| `startupRequestTimeoutMs` | `1000` | Shorter timeout for startup-sensitive probes so a slow or offline daemon can't stall omp boot |

Boolean-like strings such as `"false"`, `"0"`, `"no"`, and `"off"` are treated as false.

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
