# Monorepo structure

How the Remnic packages are organized, what depends on what, and how a release is published. The monorepo is a pnpm + Turborepo workspace built around a host-agnostic core: `@remnic/core` owns memory semantics, `@remnic/server` and `@remnic/cli` are the standalone runtime, and every host integration (OpenClaw, Hermes, Claude Code, Codex, Pi, Replit, and the importers/connectors) is an adapter over that shared engine. Adapters never own core memory semantics.

## Package map

`packages/` holds 27 directories: 26 have an npm manifest, 25 are published to npm, one is private (`bench-ui`), and one ships to PyPI instead of npm (`plugin-hermes` → `remnic-hermes`). Several directory names differ from their published package names — those are called out below.

### Core runtime

| Directory | Published as | Role |
|-----------|--------------|------|
| `remnic-core` | `@remnic/core` | Memory engine: orchestrator, storage, extraction, all search backends, trust zones, namespaces, LCM, entity/causal graph, compounding, work layer. Zero host imports. |
| `remnic-server` | `@remnic/server` | Standalone HTTP + MCP server that wraps core. |
| `remnic-cli` | `@remnic/cli` | The `remnic` command (plus a legacy `engram` forwarder): init, daemon, connectors, tokens, query, doctor, and more. |

### Host plugins

| Directory | Published as | Role |
|-----------|--------------|------|
| `plugin-openclaw` | `@remnic/plugin-openclaw` | OpenClaw adapter with a bundled core runtime. |
| `plugin-claude-code` | `@remnic/plugin-claude-code` | Claude Code plugin (hooks, skills, agents, `.mcp.json`). Files-only. |
| `plugin-codex` | `@remnic/plugin-codex` | Codex CLI plugin (hooks, skills, MCP). |
| `plugin-pi` | `@remnic/plugin-pi` | Memory extension for the Pi / omp coding agent. |
| `plugin-hermes` | `remnic-hermes` (PyPI) | Hermes Agent `MemoryProvider` plugin, written in Python. |

### Connectors (ingest live sources)

| Directory | Published as | Role |
|-----------|--------------|------|
| `connector-bee` | `@remnic/connector-bee` | Bee wearable (bracelet) transcripts. |
| `connector-limitless` | `@remnic/connector-limitless` | Limitless Pendant transcripts. |
| `connector-omi` | `@remnic/connector-omi` | Omi necklace transcripts. |
| `connector-replit` | `@remnic/replit` | Replit Agent MCP connector. |
| `connector-weclone` | `@remnic/connector-weclone` | OpenAI-compatible proxy that adds memory to WeClone avatars; ships the `remnic-weclone-proxy` bin. |

### Importers (one-time backfill from other tools)

| Directory | Published as | Role |
|-----------|--------------|------|
| `import-chatgpt` | `@remnic/import-chatgpt` | ChatGPT data export. |
| `import-claude` | `@remnic/import-claude` | Claude.ai data export. |
| `import-gemini` | `@remnic/import-gemini` | Google Takeout Gemini Apps export. |
| `import-lossless-claw` | `@remnic/import-lossless-claw` | lossless-claw (LCM) SQLite databases. |
| `import-mem0` | `@remnic/import-mem0` | mem0.ai REST API. |
| `import-supermemory` | `@remnic/import-supermemory` | Supermemory JSON export. |
| `import-weclone` | `@remnic/import-weclone` | WeClone-preprocessed chat exports. |
| `export-weclone` | `@remnic/export-weclone` | Exports memories as WeClone/Alpaca fine-tuning datasets. |

### Libraries and tooling

| Directory | Published as | Role |
|-----------|--------------|------|
| `belief-ledger` | `@remnic/belief-ledger` | Belief and prediction ledger built on the memory primitives. |
| `coding-graph` | `@remnic/coding-graph` | web-tree-sitter symbol extraction + a SQLite code knowledge graph. Optional companion of core. |
| `hermes-provider` | `@remnic/hermes-provider` | Typed TypeScript HTTP client for the memory API. |
| `bench` | `@remnic/bench` | Retrieval-latency benchmark ladder and CI regression gates. |
| `bench-ui` | `@remnic/bench-ui` (private) | Vite UI for browsing benchmark results. Not published. |
| `shim-openclaw-engram` | `@joshuaswarren/openclaw-engram` | Deprecated compatibility shim that re-exports `@remnic/plugin-openclaw`. |

## Dependency graph

Dependencies are workspace ranges resolved from the manifests, not doc claims. Most adapters take core as a **required peer dependency**; core takes `@remnic/coding-graph` as an **optional peer**.

```
@remnic/core            no internal deps; optional peer → @remnic/coding-graph
├── @remnic/server      depends on core (+ express, express-rate-limit, MCP SDK)
├── @remnic/cli         depends on core, @remnic/plugin-pi, @remnic/server
│                        + 12 OPTIONAL peers (importers/connectors/bench, all
│                          peerDependenciesMeta.optional)
├── @remnic/coding-graph        required peer → core
├── @remnic/belief-ledger       required peer → core
├── @remnic/bench               depends on core AND @remnic/coding-graph
├── @remnic/plugin-openclaw     depends on core (+ @sinclair/typebox, openai)
├── @remnic/plugin-codex        depends on core
├── @remnic/plugin-pi           depends on core
├── @remnic/export-weclone      required peer → core
├── @remnic/import-*            required peer → core (chatgpt, claude, gemini,
│                                 lossless-claw, mem0, supermemory, weclone)
├── @remnic/connector-bee       required peer → core
├── @remnic/connector-limitless required peer → core
├── @remnic/connector-omi       required peer → core
└── @joshuaswarren/openclaw-engram  depends on core AND @remnic/plugin-openclaw

Zero internal dependencies:
  @remnic/plugin-claude-code   (files-only installer package)
  @remnic/replit               (connector-replit; standalone MCP connector)
  @remnic/connector-weclone    (standalone proxy)
  @remnic/hermes-provider      (standalone HTTP client)
  @remnic/bench-ui             (private Vite app)
  remnic-hermes                (Python; talks to the daemon over HTTP)
```

Note: `plugin-claude-code` and `@remnic/replit` have **zero** dependencies — they are installers/connectors that talk to a running daemon, not core consumers. Earlier docs incorrectly listed them as depending on core.

## Publish order

Publish order is **not hardcoded**. It is generated per release by `scripts/publish-order.mjs` and written to `${RUNNER_TEMP}/remnic-publish-order.txt`, which the release workflow (`.github/workflows/release-and-publish.yml`) then consumes. That script is the single source of truth for release ordering.

The algorithm:

- Considers **public** workspace packages only (private `bench-ui` and the PyPI-only `remnic-hermes` are excluded).
- Builds a dependency DAG from `dependencies`, `optionalDependencies`, and **non-optional** `peerDependencies`. Optional peers (`peerDependenciesMeta.optional`) are deliberately excluded so they never constrain ordering (issue #1551) — that carve-out is why the mutual optional peer between core and `coding-graph` does not read as a cycle.
- Runs a Kahn topological sort with a lexicographically sorted ready queue for deterministic output.
- Errors if it finds a cycle or a public package that depends on a private one.

The resulting order places dependency roots first (core and the zero-dep packages) and terminal consumers last (`remnic-cli`, then the `openclaw-engram` shim). During a release, packages whose trusted publishing is not yet provisioned return `E404` on first publish; those are collected and skipped rather than failing the run.

## À-la-carte packaging contract

Remnic is designed so a user installs only what they use. Two mechanisms enforce this (see AGENTS.md §44 for the canonical statement):

1. **Optional peer dependencies.** `remnic-cli` declares its importers, connectors, and `@remnic/bench` as optional peers (`peerDependenciesMeta.optional`). Installing `@remnic/cli` does not drag in every connector; a missing optional peer is a supported state, not an error.
2. **Computed-specifier dynamic imports.** Code that reaches for an optional package imports it via a computed module specifier resolved at runtime, so bundlers and installers never treat it as a hard requirement. A feature whose optional package is absent degrades gracefully instead of failing to load.

The invariant: adding or removing an optional connector/importer must never break a base install, and the publish-order generator must keep excluding optional peers so the release stays deterministic.

## Build order

Turborepo derives build order from the dependency graph via `turbo.json` — you do not maintain it by hand. Core builds first (everything depends on it); adapters and consumers follow; `@remnic/cli` builds after core, server, and `plugin-pi`. The Python `plugin-hermes` has its own separate build/publish pipeline.

## Package details

### @remnic/core

The memory engine. Contains the orchestrator, storage manager, extraction engine, every search backend, trust zones, namespace isolation, LCM, the entity/causal graph, compounding, shared context, and the work layer. **Zero OpenClaw or Hermes imports** — usable by any host. Declares `@remnic/coding-graph` as an optional peer so code-graph features light up only when that package is present.

### @remnic/server

Standalone HTTP + MCP server. Wraps `@remnic/core` with the shared access service and adapter registry for per-client identity resolution. Runs without OpenClaw.

### @remnic/cli

The `remnic` command (installs a legacy `engram` forwarder alongside it). Command groups include `init`, `daemon`, `connectors`, `token`, `query`, `doctor`, `config`, `space`, `tree`, `sync`, `dedup`, `curate`, `review`, `bench`, and more. See the [CLI reference](../cli.md) for the full surface. Depends on core, `@remnic/server`, and `@remnic/plugin-pi`, plus 12 optional peers.

### @remnic/plugin-openclaw

OpenClaw adapter that bundles a core runtime. Maps Remnic behavior onto OpenClaw's plugin SDK and runtime surfaces. Install with `openclaw plugins install clawhub:@remnic/plugin-openclaw`. Host-specific logic lives here or in the root `src/` compatibility wiring while the OpenClaw loader still requires it.

### @remnic/plugin-claude-code

Files-only Claude Code plugin (zero dependencies). Contains:

- `.claude-plugin/plugin.json` — plugin manifest
- `hooks/` — SessionStart, PostToolUse, UserPromptSubmit hooks
- `skills/` — the `remnic-recall`, `remnic-remember`, `remnic-search`, `remnic-status`, `remnic-entities`, and `remnic-memory-workflow` skill directories
- `agents/` — memory review agent
- `.mcp.json` — MCP server pointing at the Remnic daemon

### @remnic/plugin-codex

Native Codex CLI plugin: `.codex-plugin/plugin.json`, hooks (SessionStart, PostToolUse, UserPromptSubmit, Stop), skills, and an `.mcp.json` pointing at the daemon. Depends on core.

### @remnic/plugin-pi

Memory extension for the Pi / omp coding agent. Ships its own small `remnic.config.json` (daemon URL, namespace, connector token). Depends on core.

### remnic-hermes (PyPI, Python)

Hermes Agent `MemoryProvider` plugin distributed on PyPI (Python ≥ 3.10). Implements the Hermes `MemoryProvider` protocol — `pre_llm_call` injects recalled memories, `sync_turn` observes each turn, `extract_memories` runs structured extraction on session end — and registers explicit recall/store/search tools. It has no npm manifest, so the npm publish-order generator skips it. Talks to the daemon over HTTP; no internal package deps.

### Connectors and importers

Connectors ingest live external sources (wearables, Replit, WeClone); importers do one-time backfills from other memory tools. Each is an independent optional peer of `@remnic/cli`, so you install only the ones you need.

### @remnic/coding-graph and @remnic/belief-ledger

`coding-graph` builds a SQLite code knowledge graph from tree-sitter symbol extraction and is an optional companion of core. `belief-ledger` layers a belief/prediction ledger on the memory primitives. Both take core as a required peer.

### @remnic/hermes-provider and @remnic/bench

`hermes-provider` is a standalone typed HTTP client for the memory API (zero internal deps). `bench` runs the retrieval-latency ladder and CI regression gates; it depends on both core and `@remnic/coding-graph`.

### @joshuaswarren/openclaw-engram (deprecated shim)

A compatibility shim that re-exports `@remnic/plugin-openclaw` and forwards the legacy `engram-access` bin into core, so installs pinned to the old `openclaw-engram` package keep working. Depends on core and `@remnic/plugin-openclaw`.

## Workspace configuration

**pnpm-workspace.yaml:**

```yaml
packages:
  - "packages/*"
```

**turbo.json:**

```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": { "dependsOn": ["^build"], "outputs": ["dist/**"] },
    "check-types": { "dependsOn": ["^build"] },
    "test": { "dependsOn": ["^build"] },
    "dev": { "cache": false, "persistent": true }
  }
}
```

## Root compatibility surface

The copy-only root shims are gone (issue #2913, phase 2 of #2801). What
remains at the root serves OpenClaw runtime entrypoints that have not fully
moved into `packages/plugin-openclaw`: `src/index.ts`, `src/tools.ts`,
`src/explicit-capture.ts`, and the `src/openclaw-*` wiring files.

Root `package.json` keeps every public export name, but each export whose
implementation was only a re-export now aliases the `@remnic/core` export
contract directly (`types`, `remnic-source`, and `import` conditions under
`./packages/remnic-core/`). Root `tsup` builds only the real root
entrypoints, and root `tests/` import `@remnic/core` subpaths directly.
`tests/root-shim-collapse-contract.test.ts` pins this state: zero copy-only
tsup entries, preserved export names, and identical resolution through the
root and core specifiers.

Do not put new cross-platform semantics in root `src/`. Add them to
`@remnic/core` and let adapters consume them.
