# Architecture

A one-page orientation to how Remnic is built. Remnic is a local-first memory and context layer for AI agents: one memory store on your machine, shared by every agent you connect. This page is the map; each section links into `docs/architecture/` for depth.

## The shape

A host-agnostic engine (`@remnic/core`) owns all memory semantics. A standalone daemon (`@remnic/server`) exposes it over HTTP + MCP, and thin adapters connect each agent tool to that one store.

```
        Claude Code   Codex CLI   Cursor   ChatGPT   Hermes   Replit   Pi/omp
             │           │          │         │         │        │       │
             └───────────┴──────────┴────┬────┴─────────┴────────┴───────┘
                                         │ HTTP + MCP (127.0.0.1:4318)
                                ┌────────▼─────────┐
                                │  @remnic/server   │  standalone daemon
                                ├───────────────────┤
                                │   @remnic/core     │  memory engine
                                │  orchestrator ·    │
                                │  extraction ·      │
                                │  search backends · │
                                │  graph · lifecycle │
                                └────────┬──────────┘
                                         │
                                ┌────────▼──────────┐
                                │  markdown + YAML   │  plain files on disk
                                │  ~/.remnic/memory  │  (no external database)
                                └───────────────────┘
```

OpenClaw is one adapter (the deepest native integration), not the center. Standalone Remnic must remain correct without any single host.

## The three-phase flow

Every integration drives the same core loop:

```
Before an agent turn:   Recall   → inject relevant memories into the prompt
After each turn:        Buffer   → accumulate turns until a trigger fires
Periodically:           Extract  → one LLM call turns turns into stored memories
```

Recall runs a planner → candidate generation (artifacts, QMD hybrid search, embedding fallback) → policy filtering → optional rerank → cap → format. See [Retrieval pipeline](architecture/retrieval-pipeline.md). Extraction, consolidation, and expiry are covered in [Memory lifecycle](architecture/memory-lifecycle.md).

## Key design decisions

- **Local-first storage** — every memory is a plain markdown file with YAML frontmatter; no external database.
- **Host-agnostic core** — `@remnic/core` has zero host imports; adapters translate, they don't own semantics.
- **OpenAI Responses API** — extraction uses structured outputs via the Responses API, never Chat Completions.
- **Pluggable search** — QMD hybrid (BM25 + vector + rerank) is the default backend, with Orama, LanceDB, Meilisearch, remote, and no-op behind one interface; recall fails open when a backend is unavailable.
- **À-la-carte packages** — install only the connectors/importers you use; optional peers keep the base install small.

## Where the code lives

Remnic is a pnpm + Turborepo monorepo. Core is in `packages/remnic-core/src/`, the standalone runtime in `packages/remnic-server/` and `packages/remnic-cli/`, and each host/connector/importer is its own package. See [Monorepo structure](architecture/monorepo-structure.md) for the full 27-package map, dependency graph, and publish order.

| Concern | Where |
|---------|-------|
| Orchestration (all phases) | `packages/remnic-core/src/orchestrator.ts` |
| Storage (markdown + YAML) | `packages/remnic-core/src/storage.ts` |
| Turn buffering | `packages/remnic-core/src/buffer.ts` |
| Extraction (Responses API) | `packages/remnic-core/src/extraction.ts` |
| Search interface + backends | `packages/remnic-core/src/search/` |
| Standalone HTTP + MCP server | `packages/remnic-server/src/` |
| OpenClaw adapter | `packages/plugin-openclaw/` + root `src/` wiring |

## Further reading

- [Architecture overview](architecture/overview.md) — full system design, storage layout, and data model
- [Retrieval pipeline](architecture/retrieval-pipeline.md) — how recall works end to end
- [Memory lifecycle](architecture/memory-lifecycle.md) — write, consolidation, expiry, and tiering
- [Graph reasoning](architecture/graph-reasoning.md) — the opt-in graph layer
- [Monorepo structure](architecture/monorepo-structure.md) — packages, dependencies, and releases
- [Shared memory](architecture/shared-memory.md) — how one store serves many agents
- [Config reference](config-reference.md) — every configuration flag
