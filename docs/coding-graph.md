# Coding graph (Track B)

Issue [#1548](https://github.com/joshuaswarren/remnic/issues/1548) Track B is
`@remnic/coding-graph`, an optional à-la-carte package that ships a native
codebase-graph engine: web-tree-sitter (WASM) parsing, a SQLite knowledge
graph, structural queries, blast-radius analysis, dead-code detection, an
openCypher read subset, optional LSP-upgraded type resolution, and an optional
semantic layer. This document is the single source of truth for the engine.

> One-source rule (#1527): the four durable coding-knowledge *features*
> (decision records, architecture card, session delta, structural provider)
> are documented in [Coding knowledge (Track A)](coding-knowledge.md) and are
> not repeated here. Namespace scoping is in
> [Coding agent mode](coding-agent.md). Track B's `manage_adr` and
> `get_architecture` tools *compose* Track A's records and card with live
> graph stats — one implementation each (rule 22).

## Install

`@remnic/coding-graph` is an optional peer dependency. `@remnic/core` never
imports it directly; it uses a computed-specifier dynamic import so the base
install compiles and runs without it:

```bash
npm install @remnic/coding-graph
```

When the package is absent, the loader returns a user-facing install hint
(never `MODULE_NOT_FOUND`); when present but shape-mismatched, it throws a
tagged `module_load_failed` error telling the operator the install is broken.
The loader lives in
[`coding/optional-coding-graph.ts`](../packages/remnic-core/src/coding/optional-coding-graph.ts).

## Why an optional package

The engine is heavy (web-tree-sitter runtime + grammar `.wasm` assets + LSP
client) and most Remnic users never index code. Core hosts only: types-only
engine interface declarations, the computed-specifier loader, and the surface
wiring. Optional peer dep with `peerDependenciesMeta.*.optional = true`;
never in base `dependencies` or any tsup `noExternal`. This is the à-la-carte
rule (CLAUDE.md rule 57).

The parser is **web-tree-sitter (WASM), not native bindings**. Native
`node-tree-sitter` + per-grammar native modules would repeat the
better-sqlite3 binding pain this repo already paid for (#1538) and the
Windows/cross-platform hook failures (#1518). WASM grammars are prebuilt,
platform-independent files loaded at runtime — no `node-gyp` anywhere. Cost:
~2–3× slower parsing than native; accepted, and measured by the benchmark
harness rather than argued about (see [Performance](#performance)).

## Config and gating

There is no `codingGraph` plugin config block. Track B is gated entirely
through the existing `codingKnowledge` config (see
[Coding knowledge (Track A)](coding-knowledge.md#config-surface) for the full
table). The two relevant keys:

| Key | Default | Behavior |
|-----|---------|----------|
| `codingKnowledge.codegraphTools` | `false` | Gate for the 14 parity tools. Off = `tools/list`, HTTP route registration, and CLI help are byte-identical to pre-feature. **Also requires `@remnic/coding-graph` to be installed.** |
| `codingKnowledge.codegraphDbDir` | `""` | Root for per-project graph SQLite DBs. Empty = derive from `memoryDir`. |

The visibility gate is one predicate —
[`codegraphSurfaceVisible(config)`](../packages/remnic-core/src/coding/codegraph-runtime.ts)
— which returns `true` iff `codingKnowledge.enabled && codegraphTools`. Call
sites that are about to *open* a graph store tighten it with the loader probe
via `codegraphRuntimeAvailable(config)` (config alone is insufficient; the
package may be missing). The probe outcome is memoized.

Database location (rule 11 — no path assembly at call sites):

```text
<codegraphDbDir>/<principalSafe>/<projectIdSafe>.sqlite        (explicit root)
<memoryDir>/codegraph/<principalSafe>/<projectIdSafe>.sqlite   (default)
```

Both `principalSafe` and `projectIdSafe` are sanitized to filesystem-safe
tokens so a hostile project id cannot escape the codegraph root.

## The 14 parity tools

Mirrors the external codebase-memory-mcp tool surface. All 14 are registered
as MCP tools with `engram.*` canonical names and `remnic.*` aliases; they
dispatch through the `codegraph_*` boundary operations to one shared handler
([`coding/codegraph-surfaces.ts`](../packages/remnic-core/src/coding/codegraph-surfaces.ts)).
The runtime bridge is
[`coding/codegraph-runtime.ts`](../packages/remnic-core/src/coding/codegraph-runtime.ts).

| Tool | Operation | Notes |
|------|-----------|-------|
| `engram.codegraph_index` | `codegraph_index` | Index a repository (full or incremental). Mutating. |
| `engram.codegraph_list_projects` | `codegraph_list_projects` | List indexed projects. |
| `engram.codegraph_delete_project` | `codegraph_delete_project` | Delete a project's graph. Mutating. |
| `engram.codegraph_index_status` | `codegraph_index_status` | Index freshness + degradation state. |
| `engram.codegraph_search_graph` | `codegraph_search_graph` | Structured label/name search. |
| `engram.codegraph_trace_path` | `codegraph_trace_path` | Traverse from a symbol over typed edges. |
| `engram.codegraph_detect_changes` | `codegraph_detect_changes` | Diff → affected symbols + [blast radius](#detect_changes--blast-radius). |
| `engram.codegraph_query_graph` | `codegraph_query_graph` | Structured label/name search (raw Cypher text rejected — see [openCypher read subset](#opencypher-read-subset)). |
| `engram.codegraph_get_schema` | `codegraph_get_schema` | Node/edge label histogram. |
| `engram.codegraph_get_snippet` | `codegraph_get_snippet` | Source snippet for a symbol (read from disk). |
| `engram.codegraph_get_architecture` | `codegraph_get_architecture` | Composes Track A's architecture card with live graph stats. |
| `engram.codegraph_search_code` | `codegraph_search_code` | FTS5 full-text search over symbol text. |
| `engram.codegraph_manage_adr` | `codegraph_manage_adr` | Delegates to Track A's decision records (rule 22). |
| `engram.codegraph_ingest_traces` | `codegraph_ingest_traces` | Ingest external trace data as edges. Mutating. |

Reuse, not fork: `manage_adr` reuses
[`coding/decision-records.ts`](../packages/remnic-core/src/coding/decision-records.ts);
`get_architecture` composes the Track A architecture card with live graph
stats. Zero duplicated ADR or architecture-card logic.

Example MCP tool call (`query_graph` with a structured query — raw Cypher
strings are rejected by the boundary, see below):

```json
{
  "tool": "engram.codegraph_query_graph",
  "sessionKey": "string",
  "structuredQuery": { "label": "function", "limit": 20 }
}
```

Example (`detect_changes` against the current diff):

```json
{
  "tool": "engram.codegraph_detect_changes",
  "sessionKey": "string",
  "head": "HEAD"
}
```

## Graph schema

One SQLite DB per coding namespace via the existing `better-sqlite3`
dependency. Schema is versioned (`CODING_GRAPH_SCHEMA_VERSION = 1`, meta-table
version, WAL, `busy_timeout`) following the `lcm/schema.ts` precedent. File
*contents* are never stored in the DB — spans + content hashes only;
`get_snippet` reads source from disk.

**Node labels** (13 — the documented schema universe). The ingest pipeline
emits the lowercase symbol `kind` for these; `Project`, `Package`, `Folder`,
`File`, `Route`, `Resource` are accepted by queries but not yet emitted by
ingest, so they return zero rows:

```text
Project  Package  Folder  File  Module  Class  Function  Method
Interface  Enum  Type  Route  Resource
```

**Edge provenance** — a CHECK-constrained whitelist so a buggy resolver
cannot write an unknown value:

```text
heuristic   lsp   trace   semantic
```

Every edge carries a `confidence ∈ [0.0, 1.0]` and a provenance tag.
Additional tables: `node_attributes` (per-symbol `is_exported` /
`is_route_handler` flags consumed by dead-code detection), `co_changes`
(file-level co-change edges mined from git history), and `symbol_vectors`
(symbol embedding vectors for the semantic layer).

## detect_changes + blast radius

**Wiring status (honest).** The `engram.codegraph_detect_changes` MCP tool is
registered and dispatches to a runtime delegate, but that delegate does **not**
yet gather the diff or fresh-parse changed files — it calls `computeBlastRadius`
with an empty affected set, so the tool returns an empty `affected` list today.
The diff-gathering + fresh-parse pipeline (the library functions below) lands in a
follow-up; until then the result is an honest empty set, never a stub claiming
affected symbols. The library functions (`computeBlastRadius`,
`findDirectlyAffectedSymbols`, `classifyRisk`) are implemented and work when called
directly from `@remnic/coding-graph`.

[`detect-changes.ts`](../packages/coding-graph/src/detect-changes.ts) maps the
current diff (staged + unstaged + committed-since-last-index) hunks to symbols
whose spans overlap the changed line ranges — against a **fresh parse** of the
changed files, never stale stored spans. Half-open interval semantics (rule
35): a hunk range `[startLine, endLine)` overlaps a symbol span
`[symStartLine, symEndLine)` iff `startLine < symEndLine && symStartLine < endLine`.

Blast radius is reverse BFS from affected symbols over inbound `CALLS` /
`IMPORTS` / `USES_TYPE` edges (`BLAST_RADIUS_EDGE_TYPES`) with a depth cap.
Risk classification is a **deterministic rubric** (no LLM):

| Risk | Criterion |
|------|-----------|
| `direct` | The symbol itself is in a changed hunk (depth 0). |
| `near` | 1 hop away from a directly-changed symbol. |
| `transitive` | 2+ hops away. |

Fan-in escalation: when an affected symbol has ≥ `FAN_IN_ESCALATION_THRESHOLD`
inbound edges, its risk is escalated one level (`near → direct`,
`transitive → near`) because high-fan-in symbols concentrate blast radius. A
backend/store failure during traversal is surfaced as
`{ ok: false, code: "store_error" }` rather than masked as an empty result.

## Dead-code detection

**Library primitive, not an MCP tool.** `deadCode()` is a `GraphStore` method — it is not one of the 14 `codegraph_*` parity tools, but the store primitive they and library consumers build on.

[`GraphStore.deadCode()`](../packages/coding-graph/src/graph-store.ts) finds
symbols with zero inbound `CALLS` / `USES_TYPE` edges, excluding the
`DEAD_CODE_EXCLUSION` set. Two flags keep genuinely-reachable symbols off the
list:

- `is_exported` — the symbol's name matches a file's `exports` list. Exported
  symbols form the package's public surface and may be called by external
  consumers the graph cannot see.
- `is_route_handler` — the symbol's qualified name matches a route's
  `handlerQualifiedName`. Route handlers are reachable from HTTP requests
  regardless of internal call edges.

## openCypher read subset

**Two surfaces, one engine.** The MCP `engram.codegraph_query_graph` tool accepts a **structured** query object (`structuredQuery`) and **rejects raw Cypher text** — Cypher strings are not passed through the tool boundary. The openCypher parser + executor below (`executeCypher`) is a `@remnic/coding-graph` library capability for direct consumers; the MCP tool compiles the structured query to the same `searchGraph` / `traverse` primitives.


[`cypher/query-parser.ts`](../packages/coding-graph/src/cypher/query-parser.ts)
is a hand-written recursive-descent parser + executor compiling a strict
read-only subset of openCypher to the structured store API (`searchGraph` /
`traverse` / `traversePaths`). There is **no SQL string assembly from user
input** anywhere; the structured API already parameterises every bind
(rule 51).

Supported grammar:

```text
query        := MATCH pattern [WHERE where_clause] RETURN return_list [LIMIT int]
pattern      := node_pattern (rel_pattern node_pattern)*
node_pattern := '(' [var] [':' label] ['{' prop_map '}'] ')'
rel_pattern  := dashes+brackets+dashes with optional arrows (direction)
bracket      := '[' [':' type ('|' ':' type)*] ['*' range] ']'
range        := int ('..' int)? | '..' int
where_clause := comparison ((AND | OR) comparison)*
```

- **Direction** resolved from the dashes/arrows: `-[...]->` outgoing,
  `<-[...]-` incoming, `-[...]-` both.
- **Variable-length hops**: `-[:CALLS*1..3]->` (1–3 hops), `-[:CALLS*2]->`
  (exactly 2). Unbounded `*` is **rejected** (must specify a range). Exact
  `*N` honours concrete length-N paths via the path-enumerating primitive
  `traversePaths` (#1650); results are deduped by node id and carry
  `truncated: true` if the store's maxPaths cap is hit.
- **Read-only by construction**: every mutation clause token (`CREATE`,
  `MERGE`, `SET`, `DELETE`, `DETACH`, `REMOVE`, `DROP`, …) is rejected with a
  clear error naming the supported grammar. The module has no code path that
  writes to the store.
- Unknown labels and unsupported clauses each have a dedicated rejection test.

## Incremental reindex and co-change

[`reindex.ts`](../packages/coding-graph/src/reindex.ts) computes an incremental
plan from `last-indexed-head` + per-file content hashes: only changed files
are re-parsed, deleted files' nodes are pruned, and the new head + hashes are
persisted as meta. [`co-change.ts`](../packages/coding-graph/src/co-change.ts)
mines `FILE_CHANGES_WITH`-style file-to-file co-change edges from bounded
`git log` history with support/confidence thresholds (`DEFAULT_CO_CHANGE_CONFIG`).

## Type resolution (phased)

- **Phase A — heuristic** (shipped with the store): resolution from the syntax
  graph — import/export matching, scope, qualified names, arity. Edges carry
  `provenance: "heuristic"`.
- **Phase B — LSP client layer** ([`lsp/`](../packages/coding-graph/src/lsp/)):
  a minimal JSON-RPC-over-stdio client driving **already-installed** language
  servers (typescript-language-server, pyright, gopls, rust-analyzer, …) as
  subprocesses to upgrade unresolved/low-confidence edges. This is the
  pragmatic non-C answer to a "Hybrid LSP": Remnic does not reimplement type
  checkers, it orchestrates the real ones, with budgets and tagged
  degradation.

LSP config is an engine-internal object with least-privileged defaults
([`lsp/config.ts`](../packages/coding-graph/src/lsp/config.ts)):

| Field | Default | Behavior |
|-------|---------|----------|
| `enabled` | `false` | Master switch. Off = index identical to Phase A. |
| `servers` | `{}` | Per-language `{ command, args }` overrides (argv arrays — rule 10). Unknown language keys are rejected listing supported languages. |
| `timeoutMs` | `3000` | Handshake + per-request timeout. |
| `maxRequestsPerRun` | `500` | Max definition requests per index run. |

Enabling LSP with zero servers installed produces a working Phase-A index plus
**visible degradations** — a degraded index never masquerades as an empty one
(rule 34). Env override: `REMNIC_CODING_GRAPH_LSP_ENABLED` with `ENGRAM_`
fallback.

## Semantic layer

[`semantic/`](../packages/coding-graph/src/semantic/) adds symbol embeddings,
`SIMILAR_TO` near-clone edges, and `semantic_query` (natural-language
retrieval over the symbol graph). It builds on `@remnic/core`'s host embedding
provider + fallback — no new embedding stack.

**Privacy posture — default sends nothing anywhere.** The semantic layer is
off by default. When off, zero embedding provider calls are made and zero rows
are written to the `symbol_vectors` table (the gate-off test asserts this end
to end). When on:

- **No embedding provider configured**: degrades gracefully. `SIMILAR_TO`
  edges are still produced via local, deterministic MinHash/LSH (pure
  TypeScript, no network). `semantic_query` returns a tagged
  `{ ok: false, code: "provider_unavailable" }` — never an empty result
  masquerading as "no matches".
- **Remote embedding provider configured**: symbol text (canonical form:
  kind + qualified name + signature + body excerpt) leaves the machine to be
  embedded — the same path `@remnic/core`'s `EmbeddingFallback` uses for
  conversation embeddings, no new network stack.

The canonical text that is embedded is the canonical text that is hashed for
the cache (rule 23); cached vectors are reused on re-index when the content
hash is unchanged (rule 37). See the
[`@remnic/coding-graph` README](../packages/coding-graph/README.md#semantic-layer-1556)
for the API surface (`resolveSemanticConfig`, `indexSymbolVectors`,
`computeSimilarTo`, `semanticQuery`).

## Team-shareable artifacts

`@remnic/coding-graph` exports the store, schema, reindex, detect-changes,
co-change, Cypher, LSP, and semantic layers from its package root so consumers
can `import { GraphStore, executeCypher, … } from "@remnic/coding-graph"`. The
subpath exports `./graph-schema`, `./graph-store`, and `./cypher` remain for
callers that want only one layer. Schema and IR types live in
[`coding/coding-graph-types.ts`](../packages/remnic-core/src/coding/coding-graph-types.ts)
(owned by core so the base install compiles without the optional package).

## Performance

Every number below is traced to the committed baseline artifact
[`packages/bench/baselines/coding-graph-baseline.json`](../packages/bench/baselines/coding-graph-baseline.json).
The harness
([`packages/bench/src/coding-graph/`](../packages/bench/src/coding-graph/))
runs a deterministic synthetic repo generator + the real `GraphStore` over
≥20 iterations; there are **no invented numbers** and no README claim without a
measurement behind it (rule 55).

**Baseline fixture** (`DEFAULT_SMOKE_FIXTURE`, seed 42): 20 TypeScript files,
10 symbols per file, call density 0.3. **Machine**: Apple M2 Max, darwin
arm64, Node v22.20.0. Measured (regenerated 2026-07-07):

| Metric | Value |
|--------|-------|
| Full index | 15.5 ms (≈131 000 LOC/s) |
| Incremental single-file update (p50 / p95) | 0.17 ms / 0.24 ms |
| Incremental *modified* update (p50 / p95) | 0.60 ms / 0.96 ms |
| `trace_path` (p95) | 0.13 ms |
| `search_graph` (p95) | 0.18 ms |
| `dead_code` | 0.53 ms |
| DB size | ≈270 KB / KLOC |

These are micro-benchmarks on a small synthetic fixture, not scale claims. A
larger fixture (`DEFAULT_10K_FIXTURE`: ~1000 files × 10 symbols, ~10 000 nodes)
is available for scale runs. Regression is gated by
`checkCodingGraphRegression` against this baseline with a generous 30 %
tolerance; the report includes a machine fingerprint so baselines are only
comparable on the same machine. Working scale *targets* (not measurements) —
tier-1 1M LOC indexing, incremental file < 250 ms p95, `trace_path` < 50 ms p95
at 200k nodes — are owned and adjusted by this harness as real hardware runs
land; they are not cited as achieved results.

## Related reading

- [Coding knowledge (Track A)](coding-knowledge.md) — the four durable
  features; `manage_adr` and `get_architecture` compose them with graph stats.
- [Coding agent mode](coding-agent.md) — namespace scoping Track B inherits.
- [`packages/coding-graph/`](../packages/coding-graph/) — engine, store,
  Cypher, LSP, and semantic source.
- [`packages/bench/baselines/coding-graph-baseline.json`](../packages/bench/baselines/coding-graph-baseline.json)
  — the performance baseline cited above.
