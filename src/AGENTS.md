# Source Directory — Agent Guide

This directory contains the TypeScript source for the openclaw-engram plugin.

## Active Development References

Active sequencing and contributor priority live in the GitHub Project:

- [Engram Feature Roadmap](https://github.com/users/joshuaswarren/projects/1)

Use the project for current order/blockers, then read the relevant historical design doc before changing these surfaces:

- `orchestrator.ts` — see `docs/plans/README.md` and the relevant v8 design docs under `docs/plans/`
- `graph.ts` — see `docs/plans/2026-02-22-v8.2-pr18-graph.md`
- `tmt.ts` — see `docs/plans/2026-02-22-v8.2-tree-graph-design.md`

## Critical Invariants (enforce in all changes)

See `AGENTS.md` (root) for the full list. Key reminders:

1. **Recall pipeline order is a contract** — retrieve → filter → rerank → cap → format. Never cap before filter.
2. **Artifact isolation** — `artifacts/` paths must never appear in generic QMD recall.
3. **`no_recall` gates everything** — when planner returns `no_recall`, skip all retrieval paths.
4. **Config `0` means `0`** — never coerce zero limits to non-zero values.
5. **OpenAI Responses API only** — never use Chat Completions anywhere in this directory.
6. **Procedural memory (issue #519)** — Shipped **off** until `procedural.enabled` is `true` in plugin config. See `docs/procedural-memory.md` before changing procedure extraction, recall injection, or mining.

## File Ownership

| File | Purpose | Stability |
|------|---------|-----------|
| `index.ts` | Plugin entry point; hook registration | Stable |
| `config.ts` | Config parsing with defaults | Stable |
| `types.ts` | Shared TypeScript interfaces | Stable (add, don't remove) |
| `logger.ts` | Logging wrapper | Stable |
| `storage.ts` | File I/O for memories (markdown + YAML) | Stable |
| `buffer.ts` | Smart turn accumulation | Stable |
| `extraction.ts` | GPT extraction engine | Stable |
| `retrieval.ts` | Recall pipeline implementation | Stable |
| `qmd.ts` | QMD search client | Stable |
| `intent.ts` | Intent heuristics (morphology-aware) | Stable |
| `signal.ts` | Signal-based flush triggers | Stable |
| `importance.ts` | Zero-LLM importance scoring | Stable |
| `himem.ts` | Episode/Note classification (v8.0) | Active development |
| `boxes.ts` | Memory Box builder + Trace Weaver (v8.0) | Active development |
| `orchestrator.ts` | Core coordination | Active development (v8.2) |
| `tools.ts` | Agent-callable tool implementations | Stable |
| `cli.ts` | CLI command implementations | Stable |
| `extraction-judge.ts` | LLM-as-judge fact-worthiness gate (#376) | Stable |
| `semantic-chunking.ts` | Topic-boundary chunking (#368) | Stable |
| `page-versioning.ts` | Snapshot-based version history (#371) | Stable |
| `source-attribution.ts` | Citation/attribution helpers (#379) | Stable |
| `enrichment/` | External enrichment pipeline (#365) | Stable |
| `binary-lifecycle/` | Binary file management (#367) | Stable |
| `taxonomy/` | MECE taxonomy resolver (#366) | Stable |
| `memory-extension/` | Extension publisher contract (#381, #382) | Stable |
| `memory-extension-host/` | Extension host discovery (#381) | Stable |
| `recall-mmr.ts` | Maximal marginal relevance reranking | Stable |
| `recall-qos.ts` | Recall quality-of-service | Stable |
| `recall-audit.ts` | Recall audit trail | Stable |
| `session-integrity.ts` | Session integrity checks | Stable |
| `session-toggles.ts` | Per-session feature toggles | Stable |
| `compat/` | Provider compatibility checks | Stable |
| `dedup/` | Deduplication engine | Stable |
| `curation/` | Memory curation pipeline | Stable |

## Testing

After any change to this directory:

```bash
npm run check-types           # TypeScript strict check
npm run check-config-contract # Config schema alignment
npm run preflight:quick       # Fast test gate
npm run test:entity-hardening # Required for orchestrator/storage/intent/cache/retrieval/config edits
npm test                      # Full suite
```

New logic in any file above requires corresponding tests in `tests/`.
