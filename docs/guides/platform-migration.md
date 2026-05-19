# Platform Migration Guide (v9.1.36+)

This guide covers the migration from the old single-package Engram plugin to the Remnic platform architecture introduced in v9.1.36. If you are an existing OpenClaw user upgrading through the normal plugin update path, most changes are transparent.

If you are moving from the legacy `@joshuaswarren/openclaw-engram` package to
the canonical `@remnic/plugin-openclaw` package, start with
[OpenClaw Engram to Remnic migration](openclaw-engram-to-remnic.md). That guide
covers `plugins.entries.openclaw-engram` vs `plugins.entries.openclaw-remnic`,
the `remnic openclaw migrate-engram` tooling, and local patch preservation.

---

## What Changed (M0-M7)

The repository has been reorganized into a monorepo with five packages. The public API surface has expanded significantly, but all existing integration points remain backward compatible.

### Monorepo Structure

```
packages/
  core/              — Framework-agnostic engine (no OpenClaw imports)
  cli/               — Standalone CLI binary (15+ commands)
  server/            — Standalone HTTP/MCP server
  bench/             — Benchmarks + CI regression gates
  hermes-provider/   — HTTP client for remote Remnic instances
```

### New Capabilities

| Milestone | Capability | Description |
|-----------|------------|-------------|
| M0 | Monorepo packages | `@remnic/core`, `@remnic/cli`, `@remnic/server`, `@remnic/bench`, `@remnic/hermes-provider` |
| M0 | Schema validation | `access-schema.ts` with Zod validates all request bodies before processing |
| M0 | Structured error responses | Consistent JSON error envelopes with `error`, `code`, `details` fields and `X-Request-Id` correlation IDs |
| M1 | Hermes provider | `@remnic/hermes-provider` — lightweight HTTP client for connecting to remote Remnic instances |
| M1 | Standalone CLI | 15+ commands: `init`, `status`, `query`, `doctor`, `config`, `daemon`, `tree`, `onboard`, `curate`, `review`, `sync`, `dedup`, `connectors`, `space`, `benchmark` |
| M2 | Workspace tree projection | Context tree generation + validation + live watch mode (`remnic tree generate\|watch\|validate`) |
| M3 | Onboarding + Curation | Project ingestion with language detection, doc discovery, and ingestion planning; file curation with duplicate/contradiction detection |
| M3 | Diff-aware sync | Filesystem sync that detects added/modified/deleted files and ingests changes incrementally |
| M4 | Connector manager | Host adapter lifecycle management (list, install, remove, doctor) |
| M5 | Spaces | Personal, project, and team memory spaces with push/pull/share/promote/audit workflows |
| M6 | Benchmarks | Latency ladder with tier breakdowns, saved baselines, CI regression gates, and `--explain` mode |
| M7 | Retrieval tier system | Tier 0 (exact) through Tier 4 (full scan) with documented latency expectations per tier |

### Package Architecture

```
@remnic/core            — Framework-agnostic engine (re-exports orchestrator, config, storage, search, extraction, graph, trust zones)
@remnic/cli             — Standalone CLI binary (15+ commands)
@remnic/server          — Standalone HTTP/MCP server
@remnic/bench           — Benchmarks + CI regression gates
@remnic/hermes-provider — HTTP client for remote Remnic instances
```

The `@remnic/core` package has zero OpenClaw imports and can be consumed by any host adapter (CLI, HTTP server, MCP server, custom integrations).

---

## What Stayed the Same

The following integration points are unchanged. If you only used Engram through OpenClaw, your setup continues to work without modification.

| Integration Point | Status |
|---|---|
| npm entry point (`dist/index.js`) | Identical — same module exports |
| Config format (`openclaw.json` -> `plugins.entries.openclaw-engram.config`) | Same schema |
| Plugin manifest (`openclaw.plugin.json`) | Still loaded by OpenClaw gateway |
| Memory storage (`~/.openclaw/workspace/memory/local/`) | Same file layout, frontmatter schema, and directory structure |
| Install hooks | Only `prepack` — no `postinstall` or `prepare` hooks |
| Config options | All 60+ options unchanged |
| Extraction pipeline | Identical behavior |
| Recall pipeline | Identical behavior |
| MCP tools | Same 10+ tools with same signatures |
| HTTP API | Same routes, same request/response shapes |
| SDK capability detection | Runtime feature detection (no version checks) |

---

## How to Verify the Upgrade

### OpenClaw Users

```bash
# 1. Diagnostics
openclaw engram doctor --json

# 2. Verify test suite
npm test   # 672 tests should pass

# 3. Check config
openclaw engram config-review --json

# 4. Verify memory store is intact
openclaw engram inventory --json
```

### Standalone Users

```bash
# 1. Diagnostics
remnic doctor

# 2. Server status
remnic status

# 3. Verify query works
remnic query "test query" --json
```

---

## Adopting Standalone Features

All standalone features are optional. OpenClaw users can continue using the plugin path indefinitely. The standalone tools are useful for:

- Running Engram without OpenClaw
- CI/CD benchmark regression gates
- Scripted memory operations
- Connecting to remote Remnic instances via Hermes

### Install Standalone CLI

```bash
# Build from source (required for daemon mode)
git clone https://github.com/joshuaswarren/remnic.git
cd remnic && pnpm install && pnpm run build
cd packages/remnic-cli && npm link    # Makes `remnic` available on PATH
cd ../..
```

### Initialize Configuration

```bash
remnic init
# Creates remnic.config.json in the current directory
```

Set required environment variables:

```bash
export OPENAI_API_KEY=sk-...
export REMNIC_AUTH_TOKEN=$(openssl rand -hex 32)
# Optional: override memory location (default: ~/.remnic/memory for standalone, ~/.openclaw/workspace/memory/local for OpenClaw users)
# export REMNIC_MEMORY_DIR=/path/to/custom/memory
```

### Start Standalone Server

```bash
remnic daemon start
remnic status          # verify it is running
remnic daemon stop     # when done
```

### Query with Tier Breakdown

```bash
remnic query "what did I decide about the API?" --explain
```

Output shows which retrieval tiers were used and their latencies:

```
Query: what did I decide about the API?
Tiers used: tier0 -> tier1 -> tier2
Total duration: 142ms
  tier0: 3ms (0 results)
  tier1: 45ms (2 results)
  tier2: 94ms (5 results)
```

### Run Benchmarks

```bash
# First run — establishes baseline
remnic benchmark run

# Subsequent runs — checks for regressions
remnic benchmark check

# Detailed tier breakdown
remnic benchmark run --explain

# Generate report
remnic benchmark report --report=benchmarks/report.json
```

### Manage Spaces

```bash
# List spaces
remnic space list

# Create a project space
remnic space create my-project project

# Switch active space
remnic space switch <space-id>

# Push memories between spaces
remnic space push <source-id> <target-id>

# Audit trail
remnic space audit
```

### Onboard a Project

```bash
# Analyze a project directory
remnic onboard ~/src/my-project --json

# Curate specific files into memory
remnic curate ~/src/my-project/docs/ --json

# Review ingested content
remnic review list
remnic review approve <id>
```

### Diff-Aware Sync

```bash
# One-time sync
remnic sync run --source ~/src/my-project

# Continuous watch
remnic sync watch --source ~/src/my-project
```

### Find Duplicates

```bash
remnic dedup --json
```

### Manage Connectors

```bash
# List available and installed connectors
remnic connectors list

# Install a connector
remnic connectors install <connector-id>

# Diagnose connector health
remnic connectors doctor <connector-id>
```

---

## Rollback

If the upgrade causes issues:

**OpenClaw plugin users** — pin to the previous version:

```bash
openclaw plugins install npm:@remnic/plugin-openclaw@<previous-version>
```

**Standalone CLI users** — the legacy shim package (`@joshuaswarren/openclaw-engram`) only exposes `engram-access`, not the full CLI. Full CLI rollback requires building from source at the desired version tag:

```bash
cd remnic
git fetch --all && git checkout <previous-version-tag>
pnpm install && pnpm run build
cd packages/remnic-cli && npm link    # re-links the CLI binary to this version
```

Memory storage is never modified by an upgrade, so rollback is safe and does not lose data.
