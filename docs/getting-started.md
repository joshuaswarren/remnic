# Getting Started

## Prerequisites

- [OpenClaw](https://github.com/openclaw/openclaw) gateway running
- OpenAI API key (for extraction; retrieval-only mode works without one)
- [QMD](https://github.com/tobi/qmd) installed (recommended)

## Installation

### Option A: npm (recommended)

```bash
openclaw plugins install clawhub:@remnic/plugin-openclaw
```

### Option B: Developer install (from Git)

```bash
git clone https://github.com/joshuaswarren/remnic.git \
  ~/.openclaw/extensions/remnic
cd ~/.openclaw/extensions/remnic
npm ci && npm run build
```

### Option C: Standalone (no OpenClaw)

Use Remnic as a standalone memory system without OpenClaw. Requires [Node.js](https://nodejs.org/) 22.12+ and [tsx](https://github.com/privatenumber/tsx) (`npm install -g tsx`).

Build from source and use the standalone CLI:

```bash
npm install -g tsx               # Required — CLI entry point is TypeScript
git clone https://github.com/joshuaswarren/remnic.git
cd remnic && npm ci && npm run build
cd packages/remnic-cli && npm link # Makes `remnic` available on PATH
cd ../..
remnic init                      # Create config in current directory
export OPENAI_API_KEY=sk-...
export REMNIC_AUTH_TOKEN=$(openssl rand -hex 32)
remnic daemon start              # Start background server (requires source build)
remnic status                    # Verify it's running
remnic query "hello" --explain   # Test with tier breakdown
```

> **Note:** The canonical CLI is `remnic`. The legacy `engram` binary remains as a forwarder during the rename window. Running `npm link` from `packages/remnic-cli/` (not the repo root) makes the CLI globally available — the root package only exposes `engram-access`. Alternatively, invoke directly: `npx tsx packages/remnic-cli/src/index.ts <command>`.

Standalone mode provides 15+ CLI commands for querying, onboarding projects, curating files, managing spaces, running benchmarks, and more. See the [Platform Migration Guide](guides/platform-migration.md) for standalone adoption details.

OpenClaw remains the recommended installation path for most users.

## Minimal Config

Add to `openclaw.json` under `plugins.entries.openclaw-engram.config`:

```jsonc
{
  "openaiApiKey": "${OPENAI_API_KEY}",
  "recallBudgetChars": 64000
}
```

**Important:** The `recallBudgetChars` setting controls how much memory context is injected into agent prompts. The default (8,000 chars) is too small for most deployments — profile and shared context alone can exhaust it, leaving no room for actual memories. Set it to 64,000 for large-context models (Claude, GPT-5) or 32,000 for smaller models. See [Recall Budget Tuning](config-reference.md#recall-budget-tuning).

All other settings have sensible defaults. Config changes require a full gateway restart (hot reload via `SIGUSR1` does not fire `gateway_start`):

```bash
launchctl kickstart -k gui/$(id -u)/ai.openclaw.gateway
```

Verify startup:

```bash
grep '\[engram\]' ~/.openclaw/logs/gateway.log | tail -5
# Should see the memory service start line (the log prefix remains [engram] during v1.x)
```

## Set Up QMD (Recommended)

[QMD](https://github.com/tobi/qmd) provides hybrid BM25 + vector + reranking search. Without it, Remnic falls back to semantic embedding search (using your OpenAI key when available) and then recency-ordered file reads.

**QMD 2.0+ is recommended.** QMD 1.x still works but 2.0 resolves several known issues natively (session ID crash, model override env vars, join performance). Install via bun or npm:

```bash
bun install -g @tobilu/qmd
# or: npm install -g @tobilu/qmd

# Verify
qmd --version  # should show 2.0.0+
```

Add to `~/.config/qmd/index.yml`:

```yaml
openclaw-engram:
  path: ~/.openclaw/workspace/memory/local
  extensions: [.md]
```

Index the collection:

```bash
qmd update && qmd embed
```

Enable in your plugin config:

```jsonc
{
  "qmdEnabled": true,
  "qmdCollection": "openclaw-engram"
}
```

### Upgrading from QMD 1.x to 2.0

QMD 2.0 is a drop-in upgrade — existing collections, indexes, and config files work without changes. The MCP tool interface (`query`, `get`, `multi_get`, `status`) is backward compatible.

**What changed:**
- Unified `search()` replaces the old query/search/structuredSearch split internally
- MCP server rewritten as a clean SDK consumer (same external contract)
- Source reorganized into `src/cli/` and `src/mcp/` subdirectories
- New programmatic SDK: `import { createStore } from '@tobilu/qmd'`
- `better-sqlite3` bumped to ^12.4.5 (Node 25 support)

**Patches no longer needed:** The following QMD 1.x patches are resolved natively in 2.0:
- PR #166 (MCP session ID crash) — built-in `sessionIdGenerator`
- PR #112 (model override env vars) — `QMD_EMBED_MODEL`, `QMD_GENERATE_MODEL`, `QMD_RERANK_MODEL` supported
- PR #117 (CROSS JOIN fix) — vector search uses two-step query pattern

**Upgrade steps:**

```bash
# 1. Install QMD 2.0
bun install -g @tobilu/qmd

# 2. If native bindings need repair, rebuild better-sqlite3 manually
cd ~/.bun/install/global/node_modules/better-sqlite3
npm rebuild better-sqlite3

# 3. Verify
qmd --version       # 2.0.0+
qmd status           # should show existing collections

# 4. Restart the gateway
launchctl kickstart -k gui/$(id -u)/ai.openclaw.gateway

# 5. Verify Remnic picked up QMD 2.0
grep "cliVersion" ~/.openclaw/logs/gateway.log | tail -1
# Should show: cliVersion=qmd 2.0.x
```

**Note:** If you used the OpenClaw patcher for QMD patches, those patches target QMD 1.x source paths that no longer exist in 2.0. The patcher will harmlessly skip them. You can remove old QMD patch entries from the patcher config.

## Five-Minute Config

Enable the most impactful features incrementally:

```jsonc
{
  "openaiApiKey": "${OPENAI_API_KEY}",
  "recallBudgetChars": 64000,
  "qmdEnabled": true,
  "qmdCollection": "openclaw-engram",

  // v8.0: Recall Planner (enabled by default)
  "recallPlannerEnabled": true,

  // v8.0: Episode/Note dual store (opt-in)
  "episodeNoteModeEnabled": true,

  // v8.0: Memory Boxes (opt-in)
  "memoryBoxesEnabled": true,
  "traceWeaverEnabled": true
}
```

## Verify It Works

Start a conversation with OpenClaw. After a few turns, check:

```bash
openclaw engram setup --json
openclaw engram config-review --json
openclaw engram doctor --json
openclaw engram inventory --json

# See extracted memories
ls ~/.openclaw/workspace/memory/local/facts/

# Search memories from CLI
openclaw engram search "your query"
```

## Config Override (Service Environments)

Override the config file path via environment variable:

```bash
OPENCLAW_ENGRAM_CONFIG_PATH=/absolute/path/to/openclaw.json
```

Fallback: `OPENCLAW_CONFIG_PATH`.

## Alternative Search Backends (v9.0)

QMD provides the highest quality retrieval, but Engram v9 supports five other backends. To use an alternative, set `searchBackend` in your config:

```jsonc
{
  "searchBackend": "orama"   // or "lancedb", "meilisearch", "remote", "noop"
}
```

Orama requires zero setup — no external server, no native dependencies. Just set the config and restart.

See [Search Backends](search-backends.md) for a full comparison and configuration guide.

## Next Steps

- [Search Backends](search-backends.md) — choose and configure your search engine
- [Procedural memory](procedural-memory.md) — how-to / runbook memories (issue #519); **default-on** since issue #567 PR 4/5 — set `procedural.enabled` to `false` under the Remnic plugin config to opt out of extraction, mining, and recall-time procedure injection
- [Enable All Features](enable-all-v8.md) — explicit full-profile config for all feature families
- [Config Reference](config-reference.md) — full settings list with defaults and recommended values
- [Operations](operations.md) — backups, exports, hourly summaries
- [Architecture Overview](architecture/overview.md) — how it all fits together
- [Writing a Search Backend](writing-a-search-backend.md) — implement your own adapter
