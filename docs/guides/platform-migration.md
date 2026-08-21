# Platform migration

Remnic began as a single OpenClaw plugin package and is now a monorepo with a
framework-agnostic core, a standalone CLI, and a standalone HTTP/MCP server.
This guide is for operators moving beyond the plugin-only setup: running Remnic
without OpenClaw, scripting memory operations, or connecting to a remote
instance. Existing OpenClaw users do not need any of this — the plugin update
path is transparent.

If you are moving from the legacy `@joshuaswarren/openclaw-engram` package to the
canonical `@remnic/plugin-openclaw` package, start with
[OpenClaw Engram to Remnic](openclaw-engram-to-remnic.md). That guide covers the
`plugins.entries.openclaw-engram` to `plugins.entries.openclaw-remnic` rename,
the `remnic openclaw migrate-engram` tooling, and local patch preservation.

## What the platform looks like now

The monorepo publishes 25+ packages. The ones you interact with directly:

| Package | Role |
|---|---|
| `@remnic/core` | Framework-agnostic engine — orchestrator, config, storage, search, extraction, graph. Zero OpenClaw imports. |
| `@remnic/cli` | Standalone `remnic` CLI (36 top-level commands). |
| `@remnic/server` | Standalone HTTP + stdio-MCP server. |
| `@remnic/plugin-openclaw` | The OpenClaw plugin (deepest native integration). |
| `@remnic/hermes-provider` | HTTP client for connecting to a remote Remnic instance. |

The remaining packages are host adapters (Claude Code, Codex, Cursor, Pi),
connectors (Limitless, Bee, Omi, WeClone), and importers (mem0, Supermemory,
ChatGPT, Claude, Gemini, lossless-claw). See
[monorepo structure](../architecture/monorepo-structure.md) for the full map.

Because `@remnic/core` has zero OpenClaw imports, any host — CLI, HTTP server,
MCP server, or a custom integration — can consume it.

## What stays the same for OpenClaw users

If you only use Remnic through OpenClaw, your setup keeps working without
modification:

| Integration point | Status |
|---|---|
| npm entry point (`dist/index.js`) | Identical exports |
| Config location (`openclaw.json` → `plugins.entries.openclaw-remnic.config`) | Same schema (legacy `openclaw-engram` entry still honored) |
| Plugin manifest (`openclaw.plugin.json`) | Still loaded by the OpenClaw gateway |
| Memory storage (`~/.openclaw/workspace/memory/local/`) | Same file layout and frontmatter schema |
| Config schema | Same keys and defaults |
| Extraction and recall pipelines | Identical behavior |
| MCP tools | Same tool names and signatures |
| HTTP API | Same routes and request/response shapes |

## Verify an upgrade

OpenClaw plugin users:

```bash
openclaw engram doctor --json      # runtime diagnostics
openclaw engram config-review --json
openclaw engram inventory --json   # confirm the memory store is intact
```

Standalone users:

```bash
remnic doctor
remnic status
remnic query "test query" --json
```

## Adopt the standalone tools

All standalone features are optional. They are useful for running Remnic without
OpenClaw, CI benchmark regression gates, scripted memory operations, and
connecting to a remote instance via Hermes.

### Install the CLI from source

Building from source is required for daemon mode:

```bash
git clone https://github.com/joshuaswarren/remnic.git
cd remnic && pnpm install && pnpm run build
cd packages/remnic-cli && npm link    # puts `remnic` on your PATH
cd ../..
```

### Initialize configuration

```bash
remnic init
# Writes remnic.config.json in the current directory
```

Set the environment it needs:

```bash
export OPENAI_API_KEY=sk-...
export REMNIC_AUTH_TOKEN=$(openssl rand -hex 32)
# Optional: override the memory directory (legacy ENGRAM_MEMORY_DIR also accepted)
# export REMNIC_MEMORY_DIR=/path/to/custom/memory
```

`REMNIC_AUTH_TOKEN` gates every server request; the daemon merges the env token
over `server.authToken` in the config file. The legacy `ENGRAM_AUTH_TOKEN` is
still accepted during the v1.x compatibility window.

### Start the server

```bash
remnic daemon start
remnic status          # confirm it is running
remnic daemon stop     # when done
```

The server binds `127.0.0.1:4318` by default.

### Query with a tier breakdown

```bash
remnic query "what did I decide about the API?" --explain
```

The output shows which retrieval tiers ran and their latencies.

### Run benchmarks

```bash
remnic benchmark run                 # first run establishes a baseline
remnic benchmark check               # later runs check for regressions
remnic benchmark check --explain     # detailed tier breakdown
remnic benchmark report --report=benchmarks/report.json
```

### Manage spaces

```bash
remnic space list
remnic space create my-project project   # <name> [personal|project|team]
remnic space switch <space-id>
remnic space push <source-id> <target-id>
remnic space audit
```

### Onboard a project

```bash
remnic onboard ~/src/my-project --json
remnic curate ~/src/my-project/docs/ --json
remnic review list
remnic review approve <id>
```

### Diff-aware sync

```bash
remnic sync run --source ~/src/my-project    # one-time
remnic sync watch --source ~/src/my-project  # continuous
```

### Find duplicates and manage connectors

```bash
remnic dedup --json
remnic connectors list
remnic connectors install <connector-id>
remnic connectors doctor <connector-id>
```

## Rollback

OpenClaw plugin users — pin the previous version:

```bash
openclaw plugins install npm:@remnic/plugin-openclaw@<previous-version>
```

Standalone CLI users — the legacy shim package
(`@joshuaswarren/openclaw-engram`) only exposes `engram-access`, not the full
CLI. Full CLI rollback means building from source at the desired tag:

```bash
cd remnic
git fetch --all && git checkout <previous-version-tag>
pnpm install && pnpm run build
cd packages/remnic-cli && npm link
```

Memory storage is never modified by an upgrade, so rollback is safe and does not
lose data.
