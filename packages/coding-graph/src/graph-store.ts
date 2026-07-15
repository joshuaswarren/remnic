/**
 * Coding-graph write pipeline — two-pass single-batch single-transaction
 * delete + reinsert per file. PR1 scope (issue #1552):
 *
 *   - Node ids are sha256 over SORTED key material (qualified name, file
 *     path, label) — rule 23/38; the same hash MUST be computed identically
 *     at ingest and lookup time.
 *   - File contents are NEVER stored — only spans + content hashes
 *     (privacy + DB size; rule 11). `get_code_snippet` is a read-side
 *     concern that lands in PR2.
 *   - DB handles live on the GraphStore instance, keyed per instance —
 *     never module scope (rule 11).
 *   - Writes are serialized per DB with a rejection-recovering queue
 *     (rule 40). A second concurrent `upsertFileBatch` call waits on a
 *     FIFO tail then runs; if it rejects (timeout / abort), the queue
 *     drains so the next call can proceed.
 *   - One DB per namespace path passed in by the caller — this PR does
 *     NOT add namespace resolution; rule 42 keeps it that way until PR2
 *     wires the namespace layer.
 *
 * Two-pass ingestion (per `upsertFileBatch`):
 *   1. Every file in the batch is upserted (file row + node row per
 *      symbol). FTS5 is kept in lockstep via explicit DELETE/INSERT on
 *      the contentless `nodes_fts` table (the write pipeline is the
 *      single source of FTS truth — no auto-triggers).
 *   2. Edges are resolved against the FULL batch's node map (already in
 *      the DB after pass 1) so cross-file edges are order-independent.
 *      Stale edges for files in this batch are deleted first so changed
 *      confidence/provenance values overwrite prior rows.
 *
 * Tagged failure shapes (rule 34): the open + write paths return a
 * discriminated union. Success: `{ok:true, results: UpsertResult[]}`. Failure:
 * `{ok:false, code:"db_locked"|"db_corrupt"}` — no message is exposed
 * to callers because `error.message` from better-sqlite3 frequently
 * contains absolute filesystem paths and stack snippets that should
 * never reach agents or HTTP surfaces (rule 11). The store logs the
 * underlying error internally and returns the code only.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import {
  openBetterSqlite3,
  type BetterSqlite3Database,
} from "@remnic/core/runtime/better-sqlite";

import {
  applyCodingGraphSchema,
  ftsRowidForNodeId,
  isEdgeProvenance,
  readSchemaVersion,
  type EdgeProvenance,
} from "./graph-schema.js";

import { expectRow, expectRows } from "./row-types.js";

// Re-export the core IR contract types so existing imports from
// `./graph-store.js` still resolve. The store no longer redefines these;
// it derives from @remnic/core's contract so PR2 callers can pass
// `ParseResult.ir` directly without field-name translation or casts
// (chatgpt-codex-connector P2: 'Derive store FileIR from the core parser
// contract'). Core owns the canonical types in
// packages/remnic-core/src/coding/coding-graph-types.ts; this package
// implements against them.
export type {
  FileIR,
  SymbolIR,
  ImportIR,
  ExportIR,
  CallSiteIR,
  RouteIR,
  CodingGraphLanguage,
} from "@remnic/core/coding/coding-graph-types";

import type {
  FileIR,
  SymbolIR,
  ExportIR,
  RouteIR,
  CodingGraphLanguage,
} from "@remnic/core/coding/coding-graph-types";

/**
 * Half-open byte span `[startByte, endByte)` — matches @remnic/core's
 * inline span type. Kept as a named alias for API consumers that import
 * `ByteSpan` from the store subpath (issue #1551 / rule 35).
 */
export type ByteSpan = { readonly startByte: number; readonly endByte: number };

/**
 * Symbol kind union — matches @remnic/core's `SymbolIR["kind"]` exactly
 * (core does not export this as a named type).
 */
export type SymbolKind =
  | "function"
  | "class"
  | "method"
  | "interface"
  | "enum"
  | "type"
  | "module";

/**
 * Store-specific edge — references nodes by `qualifiedName` so the store
 * can resolve them against the same batch's symbol set plus the on-disk
 * node table. PR1 only carries CALLS-style edges; PR2 adds the rest of
 * #1552's edge types.
 *
 * Optional `srcNodeId` / `dstNodeId` (issue #1677) carry the content-
 * derived node id (the same canonical hash form the store uses as
 * `nodes.id`, see `nodeIdFor`). When present, the standalone
 * `upsertEdges` path resolves the endpoint by `nodes.id` (unique) instead
 * of by qualified name, so a SIMILAR_TO edge between two symbols that
 * share a qualified name across files is persisted rather than dropped as
 * ambiguous. The qname-keyed file-batch path and the existing
 * `ambiguous … drops edges` behavior are unchanged. Only populated by
 * callers that originate edges from node-id-keyed pairs (the semantic
 * SIMILAR_TO pipeline); structural/trace edges keep the qname path.
 */
export interface EdgeIR {
  /** Qualified name of the source node (caller / definition site). */
  srcQualifiedName: string;
  /** Qualified name of the destination node (callee / type used). */
  dstQualifiedName: string;
  type: string;
  confidence: number;
  provenance: EdgeProvenance;
  /**
   * Optional content-derived source node id (`nodes.id`). When present on
   * a standalone-edge upsert, the store resolves the endpoint by id
   * (unambiguous) instead of falling back to qualified-name resolution.
   */
  readonly srcNodeId?: string;
  /** Optional content-derived destination node id — see {@link EdgeIR.srcNodeId}. */
  readonly dstNodeId?: string;
  /**
   * Repo-relative, extension-stripped path the dst must live in (issue
   * #1894 review): derived from a relative import's module specifier. A
   * hinted edge resolves ONLY among nodes whose file path matches the
   * hint (`<hint>`, `<hint>.<ext>`, or `<hint>/index.<ext>`) — never via
   * the global bare-name fallback — so `import { foo } from "./missing"`
   * can never bind an unrelated same-named symbol elsewhere in the repo.
   */
  readonly dstPathHint?: string;
}

/**
 * Store input — the subset of @remnic/core's `FileIR` the store reads,
 * plus the store-specific `edges` extension. A core `FileIR` (from
 * `ParseResult.ir`) is structurally assignable here: all required fields
 * (path, language, contentHash, symbols, imports, exports, callSites,
 * routes) match by name and readonly-ness. PR2 callers pass
 * `{ ...parseResult.ir, edges }` (or the bare IR when edges are absent)
 * with zero casts or field-name translation.
 *
 * PR2 adds optional `exports` and `routes` consumption: when present,
 * the write pipeline marks matching nodes in `node_attributes` so the
 * `deadCode()` query can exclude them via the
 * {@link DEAD_CODE_EXCLUSION} constant. Both fields are optional because
 * a PR1-era caller (or a JSON-IR caller that strips them) still ingests
 * cleanly — the dead-code query simply sees no exclusion flags.
 */
export interface StoreFileIR {
  readonly path: string;
  readonly language: CodingGraphLanguage;
  readonly contentHash: string;
  readonly symbols: readonly SymbolIR[];
  /** Store-specific edges derived from the IR by the caller. */
  readonly edges?: readonly EdgeIR[];
  /**
   * When present, the stale-edge delete in `upsertFileEdges` is scoped to
   * edges whose provenance is in this list: prior src-owned edges of OTHER
   * provenances survive un-asserted (issue #1891). The reindex pipeline
   * asserts `["heuristic"]` because a fresh parse says nothing about
   * `trace`/`lsp` edges; deleting them on every re-ingest would destroy
   * state the parse never contradicted (rule 25). Absent = legacy
   * behavior: every stale src-owned edge is deleted.
   */
  readonly assertedEdgeProvenances?: readonly EdgeProvenance[];
  /**
   * Per-file export list (mirrors core FileIR.exports). When present,
   * the write pipeline marks every node in this file whose `name`
   * matches an ExportIR.name as `is_exported=1` in `node_attributes`.
   * Name-matching is the conventional pattern: a parser that emits a
   * `export const foo` declaration also emits a SymbolIR named `foo`
   * (or omits it if foo is a non-symbol like a plain variable); the
   * dead-code query then excludes surviving exported symbols.
   */
  readonly exports?: readonly ExportIR[];
  /**
   * Per-file HTTP route declarations (mirrors core FileIR.routes). When
   * present, the write pipeline marks the node whose `qualifiedName`
   * equals `route.handlerQualifiedName` as `is_route_handler=1` in
   * `node_attributes`. Route handlers are reachable from HTTP traffic
   * regardless of whether any other indexed node CALLS them.
   */
  readonly routes?: readonly RouteIR[];
}

// ──────────────────────────────────────────────────────────────────────────
// Result shapes — tagged failures (rule 34).
// ──────────────────────────────────────────────────────────────────────────

export type GraphStoreFailureCode = "db_locked" | "db_corrupt" | "db_error" | "store_closed";

export interface GraphStoreFailure {
  ok: false;
  code: GraphStoreFailureCode;
}

export interface UpsertResult {
  path: string;
  fileId: number;
  nodeCount: number;
  edgeCount: number;
  /**
   * Dangling edges observed while deleting the file's prior subgraph
   * (cross-file edges whose `dst` belonged to a node owned by this file).
   * Per the PR1 dangling-edge policy in {@link graph-schema}, they are
   * DROPPED, not kept with a marker. Surfaced here so callers can log
   * the loss (rule 11, 40).
   */
  droppedDanglingEdges: number;
}

export interface UpsertSuccess {
  ok: true;
  results: UpsertResult[];
}

export type UpsertBatchResult = UpsertSuccess | GraphStoreFailure;

/**
 * Result of {@link GraphStore.upsertEdges} — a standalone-edge write used by
 * the codegraph ingest_traces surface (issue #1554). `persisted` counts
 * edges actually inserted/updated; `skipped` counts edges whose src or dst
 * did not resolve to exactly one node (dangling-edge policy).
 */
export interface UpsertEdgesSuccess {
  ok: true;
  persisted: number;
  skipped: number;
}
export type UpsertEdgesResult = UpsertEdgesSuccess | GraphStoreFailure;

// ──────────────────────────────────────────────────────────────────────────
// PR2 read primitives — query / result types (issue #1552 steps 4–5).
// Tagged failures share the {@link GraphStoreFailureCode} set so callers
// can use one switch over every store surface.
// ──────────────────────────────────────────────────────────────────────────

/** Direction of traversal relative to the edge's src→dst orientation. */
export type TraverseDirection = "outgoing" | "incoming" | "both";

/**
 * Iterative frontier BFS over the edges table. Cycle-safe via a JS
 * visited set keyed by node id; predictable memory regardless of graph
 * shape (recursive CTEs are the documented fallback if benchmarks ever
 * justify them — issue #1552 design section).
 */
export interface TraverseQuery {
  /**
   * Start node. Accepts either a node id or a qualified name — the
   * store resolves a qualified name to its deterministic id via the
   * same `(qualifiedName, filePath, label)` identity used at ingest
   * time. When the qualified name is ambiguous (declared in more than
   * one file), the query is rejected with `code: "ambiguous_start"`
   * so the caller can pass an explicit node id instead.
   */
  start: string;
  /** Default `"outgoing"`. */
  direction?: TraverseDirection;
  /**
   * Edge types to follow (e.g. `["CALLS", "USES_TYPE"]`). When omitted
   * or empty, every edge type in the table is followed. Unknown edge
   * types simply contribute no rows — the query is not rejected
   * because the schema places no CHECK constraint on `edges.type`.
   */
  edgeTypes?: readonly string[];
  /**
   * Maximum BFS depth. Half-open: a node at depth == maxDepth IS
   * included; a node at depth maxDepth+1 is NOT (rule 35). The start
   * node itself sits at depth 0 and is always included in the result
   * set when it exists. A maxDepth of 0 returns just the start node.
   * MUST be a non-negative integer — invalid values are rejected with
   * `code: "invalid_query"` rather than silently clamped (rule 51).
   */
  maxDepth: number;
}

export interface TraverseHit {
  nodeId: string;
  qualifiedName: string;
  name: string;
  label: string;
  /** Repo-relative file path of the node (joined from files.path). */
  filePath: string;
  /** BFS depth from the start node (start = 0). */
  depth: number;
}

export type TraverseResult =
  | { ok: true; hits: TraverseHit[] }
  | ({ ok: false } & GraphStoreFailure)
  | { ok: false; code: "unknown_start" | "ambiguous_start" | "invalid_query" };

/**
 * Default cap on the number of concrete paths {@link GraphStore.traversePaths}
 * enumerates before stopping and flagging `truncated`. Bounds the worst-case
 * exponential blowup of relationship-simple path enumeration on dense
 * subgraphs (issue #1650). Callers may override per-query via
 * {@link TraversePathsQuery.maxPaths}.
 */
export const DEFAULT_TRAVERSE_PATHS_MAX = 10_000;

/**
 * Hard upper bound on {@link TraversePathsQuery.maxHops}. The DFS recurses
 * once per hop; an unbounded depth (e.g. a Cypher `*15000`) would overflow
 * the call stack before `maxPaths` could stop it. 1000 is ~100x any
 * realistic code-graph depth and recurses safely (chatgpt-codex-connector
 * P2: 'Avoid recursive DFS for deep bounded paths').
 */
export const MAX_TRAVERSE_PATHS_HOPS = 1000;

/**
 * Path-enumerating traversal query (issue #1650). Mirrors {@link TraverseQuery}
 * but yields CONCRETE paths rather than BFS-shortest-depth reachability, so an
 * exact `*N` (N > 1) hop count is honored for nodes reachable at both a shorter
 * and a length-N path.
 */
export interface TraversePathsQuery {
  /** Start node id or qualified name (same resolution rules as {@link TraverseQuery.start}). */
  start: string;
  /** Default `"outgoing"`. */
  direction?: TraverseDirection;
  /** Edge types to follow; omitted/empty means every type. */
  edgeTypes?: readonly string[];
  /**
   * Inclusive upper bound on enumerated path LENGTH (hop count). MUST be a
   * non-negative integer. A `maxHops` of 0 yields no paths (every enumerated
   * path has length >= 1); callers that need the length-0 trivial path add it
   * themselves.
   */
  maxHops: number;
  /**
   * Inclusive LOWER bound on EMITTED path length (hop count). Defaults
   * to 1. The DFS still EXPLORES shorter prefixes to reach longer paths,
   * but only EMITS (and counts toward {@link maxPaths}) paths whose length
   * is in `[minHops, maxHops]` -- so an exact `*N` cap is not consumed by
   * the shorter prefixes (cursor Bugbot: 'Path cap ignores hop minimum').
   * MUST be a positive integer (>= 1) when present.
   */
  minHops?: number;
  /**
   * Safety cap on total enumerated paths. Defaults to
   * {@link DEFAULT_TRAVERSE_PATHS_MAX}. When the cap is reached, enumeration
   * STOPS and the result carries `truncated: true` so callers can detect that
   * the result is incomplete (e.g. to narrow the query or raise the cap).
   */
  maxPaths?: number;
}

/**
 * One enumerated path. The endpoint node is fully resolved; the full node-id
 * sequence lets callers reconstruct the path (issue #1650 acceptance).
 */
export interface TraversePathHit {
  nodeId: string;
  qualifiedName: string;
  name: string;
  label: string;
  filePath: string;
  /** Length of this path in hops (>= 1). */
  length: number;
  /** Full path as node ids, start-first (`length + 1` entries). */
  nodeIds: string[];
  /**
   * Edge type per hop, parallel to {@link nodeIds} (`length` entries). Two
   * distinct relationships can connect the same node pair with different
   * types (the edges table is UNIQUE on `(src, dst, type)`); exposing the
   * type per hop lets callers distinguish those otherwise-identical-node
   * paths (chatgpt-codex-connector P2: 'Include edge identity in path
   * hits').
   */
  edgeTypes: string[];
  /**
   * Per-hop edge endpoints, parallel to {@link nodeIds} (`length` entries).
   * Under `direction: "both"` antiparallel same-type edges (A->B and B->A)
   * yield distinct relationship-simple paths that share nodeIds + edgeTypes;
   * the src/dst per hop disambiguates which edge was traversed and in which
   * direction (chatgpt-codex-connector P2: 'Include edge endpoints in path
   * hits').
   */
  edgeEndpoints: Array<{ src: string; dst: string }>;
}

export type TraversePathsResult =
  | { ok: true; hits: TraversePathHit[]; truncated: boolean }
  | ({ ok: false } & GraphStoreFailure)
  | { ok: false; code: "unknown_start" | "ambiguous_start" | "invalid_query" };

/**
 * Structured node search. All filters are AND-combined; every filter
 * is optional so the bare query `{}` returns the whole graph (capped
 * by `limit`). Patterns use SQLite `LIKE` semantics — `%` matches any
 * run, `_` matches one character — applied case-insensitively via
 * `LIKE ... COLLATE NOCASE`. Patterns are parameter-bound, never
 * string-interpolated, so a `%`/`_` in user input cannot inject SQL.
 */
export interface SearchQuery {
  /** Filter by node label (the symbol kind, e.g. `"function"`). */
  label?: string;
  /** LIKE pattern on `nodes.name` (case-insensitive). */
  namePattern?: string;
  /** LIKE pattern on `files.path` (case-insensitive). */
  filePattern?: string;
  /**
   * Inclusive lower bound on total degree (in + out edge count).
   * Combined with {@link degreeMax} for a half-open? — no, inclusive
   * on both ends by convention since degree is an integer count, not
   * a span (rule 35 covers byte/time spans, not integer ranges).
   */
  degreeMin?: number;
  /** Inclusive upper bound on total degree. */
  degreeMax?: number;
  /**
   * Cap on returned rows. Default 100; clamped to [0, 1000]. A
   * `limit: 0` returns an empty `hits` array (rule 27 — guard the
   * slice/LIMIT against the zero case).
   */
  limit?: number;
}

export interface SearchHit {
  nodeId: string;
  qualifiedName: string;
  name: string;
  label: string;
  filePath: string;
  /** Total in + out edge count for this node. */
  degree: number;
}

export type SearchResult =
  | { ok: true; hits: SearchHit[] }
  | ({ ok: false } & GraphStoreFailure)
  | { ok: false; code: "invalid_query" };

/** Aggregate counts over the whole graph — single round-trip. */
export interface SchemaStats {
  files: number;
  nodes: number;
  edges: number;
  /** Node count grouped by `label` (symbol kind). */
  nodesByLabel: Record<string, number>;
  /** Edge count grouped by `type`. */
  edgesByType: Record<string, number>;
}

export type SchemaStatsResult =
  | { ok: true; stats: SchemaStats }
  | ({ ok: false } & GraphStoreFailure);

export interface DeadCodeHit {
  nodeId: string;
  qualifiedName: string;
  name: string;
  label: string;
  filePath: string;
}

export type DeadCodeResult =
  | { ok: true; hits: DeadCodeHit[] }
  | ({ ok: false } & GraphStoreFailure);

/**
 * Read a symbol's source span from disk. The store NEVER persists file
 * contents (privacy + DB size — issue #1552 design); `snippetFor`
 * resolves the node's `files.path` against {@link GraphStoreOptions.repoRoot}
 * and slices `[span_start, span_end)` from the on-disk bytes.
 */
export interface SnippetQuery {
  /**
   * Qualified name to resolve. Optional when `nodeId` is supplied — the
   * guard requires at least one of the two.
   */
  qualifiedName?: string;
  /**
   * Optional repo root override. When set, the snippet is read from this
   * root instead of the root captured at GraphStore.open() time, so a
   * caller that supplies its own repoRoot (e.g. semanticQuery) hydrates
   * snippets even when the store was opened without one (chatgpt-codex-
   * connector + cursor: 'Snippet hydration ignores query repoRoot').
   */
  repoRoot?: string;
  /**
   * Optional deterministic node id. When set, the lookup resolves by
   * `nodes.id` (unique) instead of `qualified_name`, so a hit whose
   * qualified name is duplicated across files still hydrates the exact
   * node's snippet instead of failing with `ambiguous_name`
   * (chatgpt-codex-connector P2: 'Hydrate snippets by node id as well').
   */
  nodeId?: string;
  /**
   * Optional lines of context to include before and after the span
   * (default 0 — exact span only). Context is line-aligned: the slice
   * expands to the nearest line boundary at each end.
   */
  contextLines?: number;
}

export interface SnippetSuccess {
  ok: true;
  qualifiedName: string;
  filePath: string;
  /** Absolute path the bytes were read from (`repoRoot/files.path`). */
  absolutePath: string;
  startByte: number;
  endByte: number;
  /** The decoded source slice (UTF-8). */
  text: string;
  lang: string;
}

export type SnippetFailureCode =
  | "not_found"
  | "ambiguous_name"
  | "repo_root_unset"
  | "read_failed"
  | "invalid_query"
  | "store_closed"
  // DB-level failures surface from the node-lookup catch path so the
  // typed contract matches every code classifyReadError can return
  // (cursor Bugbot: 'snippetFor omits store failure codes').
  | "db_locked"
  | "db_corrupt"
  | "db_error";

export type SnippetResult = SnippetSuccess | { ok: false; code: SnippetFailureCode };

// ──────────────────────────────────────────────────────────────────────────
// KV / list read primitives — tagged failures (rule 22). readMeta,
// readFileHashes, and readCoChanges previously caught every error and
// returned the empty value (null / new Map() / []), making a SQLITE_BUSY
// indistinguishable from "key absent" / "empty index" / "no co-change
// edges". The reindex executor's prune + head-advance decisions depend on
// readFileHashes, so conflating error with empty could skip pruning while
// advancing head, or prune against a falsely-empty set. These result types
// force callers to handle the two cases distinctly (cursor Bugbot HIGH:
// 'readFileHashes conflates error with empty'; 'readCoChanges swallows
// store errors'; 'readMeta conflates absent key with db failure').
// ──────────────────────────────────────────────────────────────────────────

/** Result of readMeta — `{ ok: true; value: null }` is a genuinely absent key;
 * a tagged failure is a backend error (rule 22). */
export type ReadMetaResult =
  | { ok: true; value: string | null }
  | ({ ok: false } & GraphStoreFailure);

/** Result of readFileHashes — `{ ok: true; hashes: <empty> }` is an empty
 * index; a tagged failure is a backend error (rule 22). */
export type ReadFileHashesResult =
  | { ok: true; hashes: Map<string, string> }
  | ({ ok: false } & GraphStoreFailure);

/** A co-change edge row returned by readCoChanges. */
export interface ReadCoChangeEdge {
  readonly fileA: string;
  readonly fileB: string;
  readonly support: number;
  readonly confidence: number;
}

/** Result of readCoChanges — `{ ok: true; edges: [] }` means no edges
 * recorded; a tagged failure is a backend error (rule 22). */
export type ReadCoChangesResult =
  | { ok: true; edges: readonly ReadCoChangeEdge[] }
  | ({ ok: false } & GraphStoreFailure);

// ──────────────────────────────────────────────────────────────────────────
// PR2 dead-code exclusion — explicit named constant (rule 53 analog).
// ──────────────────────────────────────────────────────────────────────────

/**
 * The single source of truth for what `deadCode()` EXCLUDES from the
 * candidate set. Anything matched by these patterns or flags is treated
 * as a non-dead surface even when it has zero inbound call/usage edges.
 *
 * This constant exists so the exclusion criteria are NAMED, DOCUMENTED,
 * and auditable in one place — not scattered across ad-hoc `WHERE`
 * clauses (rule 53 analog). Adding a new exclusion category means
 * extending this constant plus the matching `node_attributes` column;
 * the query then picks both up automatically.
 *
 * Categories:
 *   - {@link INBOUND_USAGE_EDGE_TYPES} — an inbound edge of any of these
 *     types disqualifies a node from being dead.
 *   - {@link TEST_PATH_PATTERNS} — a node whose `files.path` matches is
 *     in a test file; tests can call into private code without the
 *     production graph seeing the edge.
 *   - {@link ENTRY_POINT_PATH_PATTERNS} — process entry points (index,
 *     main, cli, bin/); these are reachable from outside the graph.
 *   - {@link EXCLUDED_ATTRIBUTE_FLAGS} — per-node flags stored in
 *     `node_attributes` (set at write time from FileIR.exports /
 *     FileIR.routes); `is_exported` and `is_route_handler`.
 */
export const DEAD_CODE_EXCLUSION = {
  /**
   * Edge types that — when pointing INTO a node — count as "this node
   * is used". Mirrors the issue's `CALLS/USAGE` wording plus the four
   * call-flavored edge types in the wider coding-graph vocabulary.
   */
  INBOUND_USAGE_EDGE_TYPES: [
    "CALLS",
    "USES_TYPE",
    "ASYNC_CALLS",
    "HTTP_CALLS",
    "DATA_FLOWS",
  ] as const,
  /**
   * File-path regexes identifying test files. Matched against
   * `files.path` (repo-relative, forward slashes).
   */
  TEST_PATH_PATTERNS: [
    /\.test\.[cm]?[tj]sx?$/,
    /\.spec\.[cm]?[tj]sx?$/,
    /(^|\/)__tests__\//,
    /(^|\/)__mocks__\//,
    /(^|\/)tests?\//,
    /(^|\/)test\//,
  ] as const,
  /**
   * File-path regexes identifying entry points (reachable from
   * outside the indexed code). Matched against `files.path`. Kept
   * deliberately narrow — `server.ts` / `app.ts` are intentionally
   * NOT treated as entry points because they are common module
   * names that may also contain dead helpers. The conservative
   * direction is to report a symbol as dead rather than hide it.
   */
  ENTRY_POINT_PATH_PATTERNS: [
    /(^|\/)index\.[cm]?[tj]sx?$/,
    /(^|\/)main\.[cm]?[tj]sx?$/,
    /(^|\/)cli\.[cm]?[tj]sx?$/,
    /(^|\/)bin\//,
    /(^|\/)src\/bin\//,
  ] as const,
  /**
   * Columns on `node_attributes` whose value being `1` excludes the
   * node. Names mirror the schema so a future column add is a one-line
   * constant extension + a query clause (no scattered edits).
   */
  EXCLUDED_ATTRIBUTE_FLAGS: ["is_exported", "is_route_handler"] as const,
} as const;

/**
 * @returns true iff `filePath` matches any pattern in
 * {@link DEAD_CODE_EXCLUSION.TEST_PATH_PATTERNS} or
 * {@link DEAD_CODE_EXCLUSION.ENTRY_POINT_PATH_PATTERNS}.
 */
function isExcludedByPath(filePath: string): boolean {
  for (const re of DEAD_CODE_EXCLUSION.TEST_PATH_PATTERNS) {
    if (re.test(filePath)) return true;
  }
  for (const re of DEAD_CODE_EXCLUSION.ENTRY_POINT_PATH_PATTERNS) {
    if (re.test(filePath)) return true;
  }
  return false;
}

// ──────────────────────────────────────────────────────────────────────────
// Internal: SQL variable-limit chunking (PR1 pattern — keep under 32766).
// ──────────────────────────────────────────────────────────────────────────

/** SQLite variable bind limit for the bundled better-sqlite3 native build. */
const SQLITE_VARIABLE_LIMIT = 32_766;

/**
 * Run a parameterized `IN (?, ?, …)` query in chunks small enough to
 * stay under SQLite's variable bind limit. The caller provides the
 * statement prefix/suffix with a single `%PH%` placeholder where the
 * `?,?,…` list goes; this helper substitutes the chunked placeholders
 * and runs `.run(...)` per chunk, aggregating the returned rows.
 *
 * Mirrors the chunking pattern PR1 already uses inside
 * `pruneFileNodes` (the FTS rowid deletes) and `upsertFileEdges` (the
 * stale-edge tuple deletes). The reviews already hardened this class
 * against `too many SQL variables` failures.
 */
function chunkedInQuery(
  db: BetterSqlite3Database,
  sqlTemplate: string,
  params: readonly (string | number)[],
): unknown[] {
  const out: unknown[] = [];
  if (params.length === 0) return out;
  for (let i = 0; i < params.length; i += SQLITE_VARIABLE_LIMIT) {
    const chunk = params.slice(i, i + SQLITE_VARIABLE_LIMIT);
    const placeholders = chunk.map(() => "?").join(", ");
    const sql = sqlTemplate.replace("%PH%", placeholders);
    const rows = db.prepare(sql).all(...chunk);
    if (Array.isArray(rows)) {
      for (const r of rows) out.push(r);
    }
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────────
// Internal: write-queue (rule 40).
// ──────────────────────────────────────────────────────────────────────────

/**
 * Per-instance FIFO. A second call to `upsertFileBatch` enqueues and the
 * previous call's promise is awaited before the new one runs. `schedule()`
 * returns immediately with a promise — callers can `await` it or fire-and-
 * forget. A throwing handler propagates the rejection AND drains the queue
 * so the next enqueued call doesn't deadlock (rejection-recovering).
 */
class WriteQueue {
  private tail: Promise<unknown> = Promise.resolve();

  schedule<T>(run: () => Promise<T>): Promise<T> {
    const next = this.tail.then(run, run);
    // Swallow the tail's settlement for callers waiting on `next` only.
    // The actual rejection still surfaces from `next` itself.
    this.tail = next.catch(() => undefined);
    return next as Promise<T>;
  }

  /** Test seam: wait until the queue has drained. */
  async drain(): Promise<void> {
    await this.tail;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Store.
// ──────────────────────────────────────────────────────────────────────────

export interface GraphStoreOptions {
  /** Absolute path to the SQLite file. The caller resolves the namespace. */
  dbPath: string;
  /**
   * Optional absolute path to the repo root. When set, `snippetFor()`
   * resolves a node's repo-relative `files.path` against this root to
   * read its source span from disk. When unset, `snippetFor()` returns
   * `code: "repo_root_unset"` for every call. The store NEVER persists
   * file contents (privacy + DB size — issue #1552 design); this is
   * the only path the read-side uses.
   */
  repoRoot?: string;
}

/**
 * One DB per instance. The store does NOT mutate its path or close the
 * handle until {@link close} is called explicitly (rule 11).
 */
export class GraphStore {
  private readonly db: BetterSqlite3Database;
  private readonly queue = new WriteQueue();
  private readonly repoRoot: string | undefined;
  private closed = false;
  private closing = false;
  /**
   * True once close() has begun (closing) or completed (closed). Public so
   * callers that hold a GraphStore reference can return the documented
   * 'store_closed' degradation code instead of treating a closed store as
   * an empty graph (cursor Bugbot: 'Closed store reports success'). The
   * read primitives already short-circuit on this internally; this getter
   * lets the semantic entry points do the same BEFORE calling a read that
   * would return [].
   */
  get isClosed(): boolean {
    return this.closed || this.closing;
  }
  // Shared drain-and-close promise so a second close() called while the
  // first is still draining awaits the same completion instead of
  // resolving early (chatgpt-codex-connector P2: 'Wait for an
  // in-progress close').
  private closePromise: Promise<void> | undefined;

  private constructor(db: BetterSqlite3Database, repoRoot: string | undefined) {
    this.db = db;
    // Validate at open() so the failure mode is a thrown, name-specific
    // error at construction — never a silent `code: "repo_root_unset"`
    // cascade on the first snippetFor() call after a long ingest. The
    // caller may still pass `undefined` (the PR1 default); they just
    // cannot pass a relative path that would silently slice the wrong
    // file (rule 11 — no path assembly at call sites).
    this.repoRoot = repoRoot;
  }

  /**
   * Open a store at the given dbPath. Creates parent directories and
   * applies the schema (idempotent — also handles upgrade). The dbPath
   * does no namespace resolution.
   */
  static async open(options: GraphStoreOptions): Promise<GraphStore> {
    const { dbPath, repoRoot } = options;
    if (!path.isAbsolute(dbPath)) {
      throw new Error(
        `graph-store: dbPath must be absolute; received ${JSON.stringify(dbPath)}`,
      );
    }
    // Validate repoRoot up-front (rule 11). When provided it MUST be
    // absolute — a relative repoRoot would silently resolve against
    // the process CWD and `snippetFor()` would slice the wrong file
    // (or a non-existent one) without a clear failure shape. The
    // PR1 baseline keeps `repoRoot` optional so existing callers that
    // do not need snippets continue to open() with just `{ dbPath }`.
    if (repoRoot !== undefined && !path.isAbsolute(repoRoot)) {
      throw new Error(
        `graph-store: repoRoot must be absolute when provided; received ${JSON.stringify(repoRoot)}`,
      );
    }
    await mkdir(path.dirname(dbPath), { recursive: true });
    const db = openBetterSqlite3(dbPath);
    // Pragmas verbatim from packages/remnic-core/src/lcm/schema.ts — the
    // shared in-repo pattern. Do not tune per-store (rule 23).
    db.pragma("journal_mode = WAL");
    db.pragma("busy_timeout = 5000");
    db.pragma("synchronous = NORMAL");
    // SQLite defaults to foreign_keys=OFF per-connection. The graph's
    // `edges` table relies on `ON DELETE CASCADE` from `nodes(id)` to
    // drop owned edges when a file's prior nodes are pruned; without
    // this pragma the cascade silently no-ops and edges accumulate as
    // orphans (cursor + codex review). PR2's `node_attributes` table
    // also relies on this cascade so attribute rows die with their node.
    db.pragma("foreign_keys = ON");
    applyCodingGraphSchema(db);
    return new GraphStore(db, repoRoot);
  }

  /**
   * The current schema_version row. Test seam — never expires, never
   * cached so migrations land without a restart.
   */
  schemaVersion(): number {
    return readSchemaVersion(this.db);
  }

  /**
   * Ingest a batch of IR files atomically. One transaction wraps every
   * file's delete + insert; if any file throws, the whole batch rolls
   * back (rule 34 — never partial-write a coding graph).
   *
   * Re-ingesting the same IR is a no-op once the rows are written
   * (idempotency — node ids are deterministic so the second pass collides
   * on PRIMARY KEY).
   *
   * Two-pass ordering: pass 1 upserts every file's nodes (so FTS stays
   * in sync and cross-file edge targets exist by the time pass 2 runs),
   * pass 2 resolves edges against the full batch's node map and deletes
   * prior edges owned by these files so changed confidence/provenance
   * values overwrite (chatgpt-codex-connector P1 + cursor medium + PR1
   * design anchor in graph-schema).
   *
   * Tagging:
   *   - `{ok:true, results}` — every file's counts.
   *   - `{ok:false, code:"db_locked"}` — busy_timeout elapsed; caller may
   *     retry. NOT a thrown error so the agent can degrade gracefully.
   *   - `{ok:false, code:"db_corrupt"}` — SQLite reported
   *     `database disk image is malformed`; the caller must surface and
   *     stop trusting this DB.
   */
  async upsertFileBatch(
    files: StoreFileIR[],
    /**
     * Optional paths to delete in the SAME transaction as the upsert
     * (issue #1553 — the reindex executor prunes deleted files atomically
     * with the changed-files upsert so a mid-batch failure cannot leave
     * the graph with committed deletions but no re-ingested replacements).
     * Cascades to nodes + edges + node_attributes via the schema's
     * `ON DELETE CASCADE`. Empty/omitted = no deletions.
     */
    deletePaths: readonly string[] = [],
  ): Promise<UpsertBatchResult> {
    if (this.closed || this.closing) {
      return {
        ok: false,
        code: "store_closed",
      };
    }
    return this.queue.schedule(() => this.runUpsert(files, deletePaths));
  }

  /**
   * Upsert standalone edges whose endpoints are resolved from the FULL
   * database (not just a per-file batch). Used by the codegraph
   * ingest_traces surface (issue #1554) to persist runtime HTTP_CALLS
   * observations as edges with `provenance: "trace"` — upgrading
   * confidence on existing edges and inserting new ones.
   *
   * Endpoint resolution: when an edge carries `srcNodeId` / `dstNodeId`
   * (issue #1677 — the SIMILAR_TO pipeline populates them from
   * content-derived node ids), the endpoint is resolved by `nodes.id`
   * (unique primary key), so an edge between two symbols that share a
   * qualified name across files is persisted rather than dropped as
   * ambiguous. Edges WITHOUT node ids fall back to qualified_name
   * resolution via the global `resolveNodeId` (unambiguous single-match
   * policy). Edges whose endpoints do not resolve (missing node id row OR
   * an ambiguous/dangling qualified name) are skipped (and counted in
   * `skipped`) rather than attached to the wrong node — the dangling-edge
   * policy from `upsertFileBatch` applies.
   *
   * Serialized on the store's write queue like `upsertFileBatch` so a
   * concurrent file-batch upsert and a trace upsert cannot interleave
   * (rule 40).
   */
  async upsertEdges(
    edges: readonly EdgeIR[],
  ): Promise<UpsertEdgesResult> {
    if (this.closed || this.closing) {
      return { ok: false, code: "store_closed" };
    }
    return this.queue.schedule(() => this.runUpsertEdges(edges));
  }

  /** Wait for pending writes to drain — test seam. */
  async drain(): Promise<void> {
    await this.queue.drain();
  }
  // ──────────────────────────────────────────────────────────────────────
  // PR3 (issue #1553): meta-table + file-management methods for the
  // incremental reindex pipeline.
  // ──────────────────────────────────────────────────────────────────────

  /**
   * Read a value from the `meta` table. Returns `null` when the key is
   * absent. Synchronous (like the other read primitives) so the reindex
   * planner can read `last_indexed_head` without an await.
   */
  readMeta(key: string): ReadMetaResult {
    if (this.closed) return { ok: false, code: "store_closed" };
    try {
      const row = expectRow<{ value: string }>(
        this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key),
        ["value"],
      );
      return { ok: true, value: row ? row.value : null };
    } catch (error) {
      logWriteFailure(error);
      return classifyReadError(error);
    }
  }

  /**
   * Write a key/value pair to the `meta` table. Synchronous — runs in its
   * own implicit transaction. The reindex executor calls this AFTER
   * `upsertFileBatch` resolves (rule 25: head/state updates only after
   * the data transaction commits). A crash between the two leaves the old
   * head, and the next run re-ingests idempotently (deterministic node ids).
   */
  writeMeta(key: string, value: string): void {
    if (this.closed) return;
    this.db
      .prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)")
      .run(key, value);
  }

  /**
   * Read every file row's path → content_hash. Used by hash_scan mode
   * to detect content drift without a reachable base commit (issue #1553).
   */
  readFileHashes(): ReadFileHashesResult {
    if (this.closed) return { ok: false, code: "store_closed" };
    try {
      const rows = expectRows<{ path: string; content_hash: string }>(
        this.db.prepare("SELECT path, content_hash FROM files").all(),
        ["path", "content_hash"],
      );
      const out = new Map<string, string>();
      for (const r of rows) out.set(r.path, r.content_hash);
      return { ok: true, hashes: out };
    } catch (error) {
      logWriteFailure(error);
      return classifyReadError(error);
    }
  }

  /**
   * Drop file rows by path, cascading to their nodes + edges +
   * node_attributes (the schema's `ON DELETE CASCADE` from `files(id)`
   * handles the cascade — `foreign_keys = ON` is set in `open()`).
   * Used by the reindex executor to prune deleted files.
   *
   * Paths are chunked under the SQLite variable limit (rule 23 pattern).
   */
  async dropFiles(paths: readonly string[]): Promise<void> {
    if (this.closed || this.closing || paths.length === 0) return;
    await this.queue.schedule(async () => {
      this.runChunkedDelete(
        "DELETE FROM files WHERE path IN (%PH%)",
        paths,
      );
    });
  }

  /**
   * Chunk a parameterized DELETE-with-IN-list under SQLite's variable
   * bind limit. Mirrors the chunking pattern used by `runChunkedUpdate`
   * and the stale-edge deletes.
   */
  private runChunkedDelete(sqlTemplate: string, params: readonly string[]): void {
    if (params.length === 0) return;
    for (let i = 0; i < params.length; i += SQLITE_VARIABLE_LIMIT) {
      const chunk = params.slice(i, i + SQLITE_VARIABLE_LIMIT);
      const placeholders = chunk.map(() => "?").join(", ");
      this.db.prepare(sqlTemplate.replace("%PH%", placeholders)).run(...chunk);
    }
  }
  /**
   * PR3 (issue #1553): upsert co-change edges into the `co_changes`
   * table. Clears existing edges then inserts the new set in one
   * transaction (idempotent — re-running on unchanged history produces
   * the same table). Serialized through the write queue.
   */
  /**
   * PR3 (issue #1553): upsert co-change edges into the `co_changes`
   * table. Clears existing edges then inserts the new set in one
   * transaction (idempotent — re-running on unchanged history produces
   * the same table). Serialized through the write queue.
   *
   * Returns `{ ok: false, code: "store_closed" }` when the store is
   * closed/closing so the caller does NOT believe mining succeeded
   * while nothing was persisted (cursor Bugbot: 'Co-change store
   * reports false success').
   */
  async upsertCoChanges(edges: readonly {
    readonly fileA: string;
    readonly fileB: string;
    readonly support: number;
    readonly confidence: number;
  }[]): Promise<
    | { ok: true }
    | { ok: false; code: "store_closed" }
    | { ok: false; code: "db_error" }
  > {
    if (this.closed || this.closing) {
      return { ok: false, code: "store_closed" };
    }
    try {
      await this.queue.schedule(async () => {
        const tx = this.db.transaction(() => {
          this.db.exec("DELETE FROM co_changes");
          const insert = this.db.prepare(
            `INSERT INTO co_changes (file_a, file_b, support, confidence)
               VALUES (?, ?, ?, ?)
             ON CONFLICT(file_a, file_b) DO UPDATE SET
               support = excluded.support,
               confidence = excluded.confidence`,
          );
          for (const e of edges) {
            insert.run(e.fileA, e.fileB, e.support, e.confidence);
          }
        });
        tx();
      });
      return { ok: true };
    } catch (error) {
      // A locked/corrupt DB would otherwise throw out of the queued
      // callback and crash the caller even though the public type only
      // advertises tagged failures. Surface a tagged db_error instead
      // (chatgpt-codex-connector: 'Return a tagged co-change store
      // failure').
      logWriteFailure(error);
      return { ok: false, code: "db_error" };
    }
  }

  /**
   * PR3 (issue #1553): read co-change edges for a file. Returns edges
   * where the file is either `file_a` or `file_b`. Synchronous read.
   */
  readCoChanges(filePath: string): ReadCoChangesResult {
    if (this.closed) return { ok: false, code: "store_closed" };
    try {
      const rows = expectRows<{
        file_a: string;
        file_b: string;
        support: number;
        confidence: number;
      }>(
        this.db
          .prepare(
            `SELECT file_a, file_b, support, confidence
               FROM co_changes
              WHERE file_a = ? OR file_b = ?
              ORDER BY confidence DESC, file_a ASC, file_b ASC`,
          )
          .all(filePath, filePath),
        ["file_a", "file_b", "support", "confidence"],
      );
      return {
        ok: true,
        edges: rows.map((r) => ({
          fileA: r.file_a,
          fileB: r.file_b,
          support: r.support,
          confidence: r.confidence,
        })),
      };
    } catch (error) {
      logWriteFailure(error);
      return classifyReadError(error);
    }
  }

  /**
   * Close the SQLite handle after draining the write queue. A batch
   * that has already been scheduled on the queue would otherwise run
   * against a closed DB and surface as `db_corrupt` — the caller
   * would stop trusting the store for unrelated reasons. Drain first,
   * then close (cursor Bugbot #09be5784).
   */
  async close(): Promise<void> {
    if (this.closed) return;
    // A concurrent close() is already draining. Return the shared
    // promise so this caller's `await store.close()` actually waits
    // for the drain to finish and the SQLite handle to close — the
    // pre-fix early `return` resolved immediately, so a caller that
    // treats close() as a flush barrier could delete/reopen the DB
    // while writes were still in flight (chatgpt-codex-connector P2:
    // 'Wait for an in-progress close').
    if (this.closing) return this.closePromise;
    // Block NEW writes before draining so a concurrent upsertFileBatch
    // cannot schedule a write that runs after this drain's await captured
    // the old tail. Without this flag, close() drains the queue snapshot,
    // closes the handle, and the late-scheduled write hits a closed DB
    // (chatgpt-codex-connector P2: 'Block new writes before draining').
    this.closing = true;
    this.closePromise = this.finishClose();
    return this.closePromise;
  }

  /** Drain queued writes then close the SQLite handle exactly once. */
  private async finishClose(): Promise<void> {
    await this.queue.drain();
    this.closed = true;
    this.db.close();
  }

  // ────────────── private ──────────────

  private async runUpsert(
    files: StoreFileIR[],
    deletePaths: readonly string[] = [],
  ): Promise<UpsertBatchResult> {
    // Guard: duplicate paths in one batch silently corrupt the edge
    // pass — pass 2 deletes the first entry's edges when the second
    // entry's edge pass runs against the same file row. Fail loud so
    // the caller fixes the input (cursor Bugbot: 'Duplicate paths
    // corrupt edge pass').
    const seenPaths = new Set<string>();
    for (const ir of files) {
      // Canonical-path check BEFORE the duplicate check: a caller that
      // passes the same repo file as `./src/a.ts` in one ingest and
      // `src/a.ts` in another (or uses backslashes / an absolute path)
      // would persist two distinct files rows + node-id hashes and
      // leave duplicate/stale symbols the later canonical ingest
      // cannot match or prune. The FileIR contract requires
      // repo-relative forward-slash paths; reject the violation at the
      // store boundary rather than silently normalizing
      // (chatgpt-codex-connector P2: 'Reject non-canonical file paths
      // before persisting').
      assertCanonicalFilePath(ir.path);
      if (seenPaths.has(ir.path)) {
        throw new Error(
          `graph-store: duplicate path '${ir.path}' in batch — each FileIR must have a unique path`,
        );
      }
      seenPaths.add(ir.path);
      // `symbols` is a REQUIRED FileIR contract field (non-optional
      // `readonly symbols: readonly SymbolIR[]`). Runtime null can
      // still arrive via JSON deserialization or a malformed parser
      // result; without this guard the `?? []` fallback made a
      // missing/null field indistinguishable from an explicit empty
      // array, so the prune step silently wiped every existing
      // node/edge for the path while the batch returned ok. Reject
      // the contract violation instead of clearing the file
      // (chatgpt-codex-connector P2: 'Reject missing symbols instead
      // of pruning the file').
      const symbolsField = ir.symbols as unknown;
      if (!Array.isArray(symbolsField)) {
        throw new Error(
          `graph-store: file '${ir.path}' symbols must be an array (FileIR contract requires it); received ${
            symbolsField === null ? "null" : typeof symbolsField
          } — refusing to ingest to avoid wiping existing nodes`,
        );
      }
      // Span check: a malformed parser or JSON caller can emit
      // startByte > endByte (or non-integer / negative spans); the
      // values are bound directly into span_start/span_end and PR2
      // snippet/search consumers will trust them as half-open byte
      // offsets. Reject before insertion so bad IR cannot corrupt
      // graph metadata (chatgpt-codex-connector P2: 'Reject invalid
      // symbol spans before storing nodes').
      for (const sym of symbolsField) {
        assertValidSymbolSpan(sym, ir.path);
      }
      // Attribute arrays: `exports` and `routes` are optional, but
      // when present MUST be arrays. A malformed non-array (e.g. a
      // JSON caller passing `exports: "publicApi"`) is iterable as
      // characters whose entries have no `.name`, so the per-flag
      // rebuild in upsertFileAttributes would compute an empty set
      // and then WIPE every is_exported / is_route_handler flag for
      // the file — turning a single bad re-ingest into silent
      // dead-code misclassification. Reject at the boundary like the
      // symbols check above (chatgpt-codex-connector P2: 'Validate
      // attribute arrays before clearing flags').
      if (ir.exports != null) {
        if (!Array.isArray(ir.exports)) {
          throw new Error(
            `graph-store: file '${ir.path}' exports must be an array when present; received ${
              ir.exports === null ? "null" : typeof ir.exports
            } — refusing to ingest to avoid wiping existing flags`,
          );
        }
        // Each entry must carry a non-empty string `name`; a malformed
        // entry (e.g. `{ name: 42 }`) is silently skipped by the
        // per-flag rebuild, so it contributes nothing while the wipe
        // still clears every is_exported flag. Reject the whole batch
        // like the symbols check (chatgpt-codex-connector P2: 'Reject
        // malformed attribute entries before clearing flags').
        for (const ex of ir.exports) {
          if (!ex || typeof ex.name !== "string" || ex.name.length === 0) {
            throw new Error(
              `graph-store: file '${ir.path}' has a malformed export entry — expected { name: string (non-empty) }; refusing to ingest to avoid wiping existing flags`,
            );
          }
        }
      }
      if (ir.routes != null) {
        if (!Array.isArray(ir.routes)) {
          throw new Error(
            `graph-store: file '${ir.path}' routes must be an array when present; received ${
              ir.routes === null ? "null" : typeof ir.routes
            } — refusing to ingest to avoid wiping existing flags`,
          );
        }
        for (const r of ir.routes) {
          if (
            !r ||
            typeof r.handlerQualifiedName !== "string" ||
            r.handlerQualifiedName.length === 0
          ) {
            throw new Error(
              `graph-store: file '${ir.path}' has a malformed route entry — expected { handlerQualifiedName: string (non-empty) }; refusing to ingest to avoid wiping existing flags`,
            );
          }
        }
      }
    }
    try {
      const results: UpsertResult[] = [];

      // Single transaction for the whole batch — atomic, faster than
      // per-file BEGIN/COMMIT, and rule 34 mandates "never partial-write
      // a coding graph". Two passes: pass 1 upserts every file's nodes
      // (so FTS stays in sync and cross-file edge targets exist by the
      // time pass 2 runs), pass 2 resolves edges against the full
      // batch's node map and deletes prior edges owned by these files
      // so changed confidence/provenance values overwrite. The two
      // passes together make the write pipeline order-independent for
      // cross-file edges (chatgpt-codex-connector P1/P2).
      const tx = this.db.transaction((irs: StoreFileIR[]) => {
        // Pass 0 (issue #1553): prune deleted-file rows in the SAME
        // transaction as the upsert so a failure rolls both back
        // atomically (cursor Bugbot: 'Deletes commit before ingest
        // fails'). Cascades to nodes + edges + node_attributes.
        if (deletePaths.length > 0) {
          for (let i = 0; i < deletePaths.length; i += SQLITE_VARIABLE_LIMIT) {
            const chunk = deletePaths.slice(i, i + SQLITE_VARIABLE_LIMIT);
            const placeholders = chunk.map(() => "?").join(", ");
            this.db
              .prepare("DELETE FROM files WHERE path IN (%PH%)".replace("%PH%", placeholders))
              .run(...chunk);
          }
        }
        // Pass 1a: upsert every file's nodes and collect the per-file
        // prune sets WITHOUT deleting yet. `upsertFileNodes` returns
        // the result plus the node ids it wants to prune; the actual
        // prune (and the dangling-edge count that gates it) is deferred
        // to pass 1b so all files in the batch share one batch-wide
        // view of what is being pruned.
        const pending: { result: UpsertResult; prunedNodeIds: string[] }[] = [];
        for (const ir of irs) {
          const { result, prunedNodeIds } = this.upsertFileNodes(ir);
          pending.push({ result, prunedNodeIds });
          results.push(result);
        }
        // Pass 1b: count + delete dangling edges per file. The src
        // exclusion uses the BATCH-WIDE pruned set, not just this
        // file's, so an edge whose both ends are pruned in different
        // files is never reported as "dangling" — it is
        // cascade-deleted, and the reported loss no longer depends on
        // which file the loop visits first
        // (chatgpt-codex-connector P2: 'Count dangling edges against
        // the whole batch').
        const batchPrunedIds: string[] = [];
        for (const { prunedNodeIds } of pending) {
          for (const id of prunedNodeIds) batchPrunedIds.push(id);
        }
        for (const { result, prunedNodeIds } of pending) {
          this.pruneFileNodes(result, prunedNodeIds, batchPrunedIds);
        }
        // Pass 2: every file's edges. Resolves against the full DB
        // (which already contains every node from this batch plus
        // every node from prior batches).
        for (let i = 0; i < irs.length; i += 1) {
          const ir = irs[i]!;
          const result = results[i]!;
          this.upsertFileEdges(ir, result);
        }
        // Pass 3 (PR2): every file's node_attributes rows
        // (`is_exported`, `is_route_handler`). Derived from the IR's
        // optional `exports` and `routes` arrays. Runs after the prune
        // so attribute rows for nodes that survived into this batch
        // are written against the final node set. Cascade-delete on
        // `nodes(id)` already cleaned up rows for pruned nodes during
        // pass 1b; this pass only inserts new / updates existing rows
        // for surviving nodes.
        for (let i = 0; i < irs.length; i += 1) {
          const ir = irs[i]!;
          const result = results[i]!;
          this.upsertFileAttributes(ir, result);
        }
      });
      tx(files);
      return { ok: true, results };
    } catch (error) {
      logWriteFailure(error);
      return classifyError(error);
    }
  }

  /**
   * Standalone-edge upsert body (runs under the write queue). Resolves
   * both endpoints from the full DB via the unambiguous single-match
   * `resolveNodeId` fallback, then upserts each edge with the same
   * ON CONFLICT(src,dst,type) policy as the file-batch path. Edges whose
   * src or dst do not resolve to exactly one node are skipped (counted
   * in `skipped`) per the dangling-edge policy.
   */
  private async runUpsertEdges(
    edges: readonly EdgeIR[],
  ): Promise<UpsertEdgesResult> {
    const emptyBatch: Map<string, string> = new Map();
    const insertEdge = this.db.prepare(
      `INSERT INTO edges (src, dst, type, confidence, provenance)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(src, dst, type) DO UPDATE SET
           confidence = excluded.confidence,
           provenance = excluded.provenance`,
    );
    // node-id resolution (issue #1677). `nodes.id` is the PRIMARY KEY, so
    // this is a unique, unambiguous lookup — a SIMILAR_TO edge between two
    // same-qualified-name symbols resolves here instead of being dropped by
    // the ambiguous qualified-name fallback. The row's qualified_name is
    // returned so the caller's (src|dst)QualifiedName can be matched against
    // it: a stale or mismatched id+qname pair is skipped (counted in
    // `skipped`) rather than silently writing an edge from the wrong node
    // (chatgpt-codex-connector P2 — id/qname consistency at the boundary).
    const nodeById = this.db.prepare(
      "SELECT qualified_name FROM nodes WHERE id = ? LIMIT 1",
    );
    try {
      let persisted = 0;
      let skipped = 0;
      this.db.transaction(() => {
        for (const edge of edges) {
          if (!isEdgeProvenance(edge.provenance)) {
            throw new Error(
              `graph-store: edge has invalid provenance ${JSON.stringify(edge.provenance)}`,
            );
          }
          if (
            !Number.isFinite(edge.confidence) ||
            edge.confidence < 0 ||
            edge.confidence > 1
          ) {
            throw new Error(
              `graph-store: edge confidence ${edge.confidence} is out of range [0, 1] for edge ${edge.srcQualifiedName} → ${edge.dstQualifiedName}`,
            );
          }
          // Prefer the content-derived node id when the caller supplied one
          // (issue #1677). Only fall through to qualified-name resolution
          // when no id is present, preserving the existing trace/HTTP_CALLS
          // path verbatim. When an id IS supplied, its row's qualified_name
          // MUST match the edge's (src|dst)QualifiedName — a mismatched pair
          // (stale body map, custom integration) is skipped like a dangling
          // edge instead of corrupting the graph (chatgpt-codex-connector P2).
          const srcId = edge.srcNodeId
            ? resolveByNodeId(nodeById, edge.srcNodeId, edge.srcQualifiedName)
            : resolveNodeId(edge.srcQualifiedName, emptyBatch, this.db);
          const dstId = edge.dstNodeId
            ? resolveByNodeId(nodeById, edge.dstNodeId, edge.dstQualifiedName)
            : resolveNodeId(edge.dstQualifiedName, emptyBatch, this.db);
          if (!srcId || !dstId) {
            skipped += 1;
            continue;
          }
          const r = insertEdge.run(srcId, dstId, edge.type, edge.confidence, edge.provenance);
          persisted += r.changes;
        }
      })();
      return { ok: true, persisted, skipped };
    } catch (error) {
      logWriteFailure(error);
      return classifyError(error);
    }
  }

  /**
   * Pass 1a: upsert the file row and every symbol node, refreshing the
   * contentless `nodes_fts` index in lockstep, and compute the set of
   * stale node ids this file wants to prune (deterministic id, NOT
   * qualified_name, so a kind change gets a new id and the OLD row is
   * deleted). The prune itself — and the dangling-edge count that
   * gates it — is deferred to {@link pruneFileNodes} so the whole batch
   * shares one batch-wide view of what is being pruned before any
   * cascade runs.
   */
  private upsertFileNodes(ir: StoreFileIR): {
    result: UpsertResult;
    prunedNodeIds: string[];
  } {
    // Upsert the file row first; the nodes table references files(id).
    const upsertFile = this.db.prepare(
      `INSERT INTO files (path, lang, content_hash)
         VALUES (?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET
         lang = excluded.lang,
         content_hash = excluded.content_hash
       RETURNING id`,
    );
    const fileRow = expectRow<{ id: number }>(
      upsertFile.get(ir.path, ir.language, ir.contentHash),
      ["id"],
    );
    if (!fileRow) {
      throw new Error(
        `graph-store: INSERT INTO files RETURNING id returned no row for path=${ir.path}`,
      );
    }
    const fileId = fileRow.id;

    // Build the seen id set FIRST (every symbol → its deterministic id)
    // so the prune step is order-stable and never deletes an id we
    // are about to (re)insert. Determinism is non-negotiable — see
    // nodeIdFor for the canonical form.
    const seenNodeIds = new Set<string>();
    const symbolByNodeId = new Map<string, SymbolIR>();
    for (const sym of ir.symbols) {
      const id = nodeIdFor({
        qualifiedName: sym.qualifiedName,
        filePath: ir.path,
        label: sym.kind,
      });
      seenNodeIds.add(id);
      symbolByNodeId.set(id, sym);
    }

    // Snapshot the prior nodes owned by this file so we can (a) skip
    // true no-op UPSERTs to keep `changes` honest, and (b) count
    // dangling edges the prune step will cascade.
    const existingNodes = expectRows<{
      id: string;
      label: string;
      name: string;
      qualified_name: string;
      file_id: number;
      span_start: number;
      span_end: number;
      lang: string;
    }>(
      this.db
        .prepare(
          `SELECT id, label, name, qualified_name, file_id,
                  span_start, span_end, lang
             FROM nodes WHERE file_id = ?`,
        )
        .all(fileId),
      ["id", "label", "name", "qualified_name", "file_id", "span_start", "span_end", "lang"],
    );
    const existingById = new Map(existingNodes.map((n) => [n.id, n]));

    const insertNode = this.db.prepare(
      `INSERT INTO nodes (
          id, label, name, qualified_name,
          file_id, span_start, span_end, lang
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          label = excluded.label,
          name = excluded.name,
          qualified_name = excluded.qualified_name,
          file_id = excluded.file_id,
          span_start = excluded.span_start,
          span_end = excluded.span_end,
          lang = excluded.lang`,
    );
    const insertFts = this.db.prepare(
      `INSERT INTO nodes_fts (rowid, name, qualified_name) VALUES (?, ?, ?)`,
    );
    const deleteFtsByRowid = this.db.prepare(
      `DELETE FROM nodes_fts WHERE rowid = ?`,
    );
    // fts_index: maps FTS rowid → node id so PR2's search can JOIN
    // hits back to `nodes`. Contentless FTS5 does NOT store column
    // values, so the `id UNINDEXED` column reads NULL on every
    // MATCH — this table is the only reverse-mapping the read path
    // has (chatgpt-codex-connector P2: 'Preserve a node key for
    // FTS hits'). UNIQUE(node_id) lets the upsert use INSERT OR
    // REPLACE so a same-node re-upsert (the common no-op path)
    // keeps a single mapping row.
    const upsertFtsIndex = this.db.prepare(
      `INSERT INTO fts_index (fts_rowid, node_id) VALUES (?, ?)
         ON CONFLICT(node_id) DO UPDATE SET
           fts_rowid = excluded.fts_rowid`,
    );
    const deleteFtsIndexByRowid = this.db.prepare(
      `DELETE FROM fts_index WHERE fts_rowid = ?`,
    );
    let nodeCount = 0;
    for (const [id, sym] of symbolByNodeId) {
      const prior = existingById.get(id);
      if (
        prior &&
        prior.label === sym.kind &&
        prior.name === sym.name &&
        prior.qualified_name === sym.qualifiedName &&
        prior.span_start === sym.span.startByte &&
        prior.span_end === sym.span.endByte &&
        prior.lang === ir.language
      ) {
        // Truly a no-op — the row already matches the IR. Skip the
        // INSERT/UPDATE entirely so `changes` stays 0.
        continue;
      }
      // Drop any prior FTS row for this id before the new INSERT.
      // Contentless FTS5 (`content=''`) does NOT store UNINDEXED
      // column values, so the only reliable key is the deterministic
      // rowid we derive from the node id hash (chatgpt-codex-connector
      // P2: `WHERE id = ?` matches zero rows in contentless mode).
      const ftsRowid = ftsRowidForNodeId(id);
      deleteFtsByRowid.run(ftsRowid);
      // Mirror the delete into the FTS → node id reverse map so a
      // re-upsert does not collide on the UNIQUE(fts_rowid) PK when
      // the same rowid previously pointed at a different node id
      // (chatgpt-codex-connector P2: 'Preserve a node key for
      // FTS hits').
      deleteFtsIndexByRowid.run(ftsRowid);
      insertNode.run(
        id,
        sym.kind,
        sym.name,
        sym.qualifiedName,
        fileId,
        sym.span.startByte,
        sym.span.endByte,
        ir.language,
      );
      insertFts.run(ftsRowid, sym.name, sym.qualifiedName);
      upsertFtsIndex.run(ftsRowid, id);
      nodeCount += 1;
    }

    // Prune by id (NOT qualified_name). A symbol whose kind changed
    // keeps the same qualifiedName but has a new node id; the old
    // id's row must be deleted to keep the file's symbol set honest.
    // We do this AFTER the upserts so any same-id re-upsert above is
    // preserved. The actual delete (and the dangling-edge count) is
    // deferred to pruneFileNodes so the batch can share one batch-wide
    // view of every pruned node before any cascade runs.
    const prunedNodeIds = existingNodes
      .map((n) => n.id)
      .filter((id) => !seenNodeIds.has(id));

    return {
      result: {
        path: ir.path,
        fileId,
        nodeCount,
        edgeCount: 0,
        droppedDanglingEdges: 0,
      },
      prunedNodeIds,
    };
  }

  /**
   * Pass 1b: count the dangling edges this file's prune will drop and
   * perform the cascade delete + FTS cleanup. A dangling edge is one
   * whose dst is pruned by THIS file but whose src survives — and
   * "survives" is judged against the BATCH-WIDE pruned set, so an edge
   * whose both ends are pruned (possibly in different files) is
   * cascade-deleted and never reported as dangling. This makes the
   * reported loss independent of the order files are visited in
   * (chatgpt-codex-connector P2: 'Count dangling edges against the
   * whole batch').
   */
  private pruneFileNodes(
    result: UpsertResult,
    prunedNodeIds: readonly string[],
    batchPrunedIds: readonly string[],
  ): void {
    if (prunedNodeIds.length === 0) {
      result.droppedDanglingEdges = 0;
      return;
    }
    // Two temp tables keep the IN / NOT IN queries under SQLite's
    // ~32766 variable bind limit for large prune sets (cursor Bugbot:
    // 'Prune path exceeds SQL variable limit'). Each insert binds 1
    // param; the subquery-based count/delete bind zero.
    this.db.exec(
      "CREATE TEMP TABLE IF NOT EXISTS _pruned_ids (id TEXT NOT NULL PRIMARY KEY)",
    );
    this.db.exec(
      "CREATE TEMP TABLE IF NOT EXISTS _batch_pruned_ids (id TEXT NOT NULL PRIMARY KEY)",
    );
    const clearPruned = this.db.prepare("DELETE FROM _pruned_ids");
    const clearBatch = this.db.prepare("DELETE FROM _batch_pruned_ids");
    const insertPruned = this.db.prepare(
      "INSERT OR IGNORE INTO _pruned_ids (id) VALUES (?)",
    );
    const insertBatch = this.db.prepare(
      "INSERT OR IGNORE INTO _batch_pruned_ids (id) VALUES (?)",
    );
    clearPruned.run();
    clearBatch.run();
    const fillTemp = this.db.transaction(
      (rows: { table: string; ids: readonly string[] }[]) => {
        for (const { table, ids } of rows) {
          const stmt =
            table === "_pruned_ids"
              ? insertPruned
              : insertBatch;
          for (const id of ids) stmt.run(id);
        }
      },
    );
    fillTemp([
      { table: "_pruned_ids", ids: prunedNodeIds },
      { table: "_batch_pruned_ids", ids: batchPrunedIds },
    ]);
    // Count dangling edges BEFORE the cascade: dst is a node pruned by
    // THIS file AND src is NOT pruned anywhere in the batch (edges
    // between two batch-pruned nodes are cascade-deleted, not
    // "dangling", and must not be attributed to either file).
    const dangling = expectRow<{ c: number }>(
      this.db
        .prepare(
          `SELECT COUNT(*) AS c FROM edges
             WHERE dst IN (SELECT id FROM _pruned_ids)
               AND src NOT IN (SELECT id FROM _batch_pruned_ids)`,
        )
        .get(),
      ["c"],
    );
    result.droppedDanglingEdges = dangling?.c ?? 0;
    // DELETE stale nodes — ON DELETE CASCADE on edges drops every
    // edge whose src or dst is pruned (FK pragma set in open()).
    this.db.exec("DELETE FROM nodes WHERE id IN (SELECT id FROM _pruned_ids)");
    clearPruned.run();
    clearBatch.run();
    // FTS + fts_index cleanup: rowids are derived in JS (not SQL),
    // so chunk the IN list to stay under the bind limit.
    const SQLITE_VAR_LIMIT = 32_766;
    const ftsRowids = prunedNodeIds.map(ftsRowidForNodeId);
    for (let i = 0; i < ftsRowids.length; i += SQLITE_VAR_LIMIT) {
      const chunk = ftsRowids.slice(i, i + SQLITE_VAR_LIMIT);
      const ph = chunk.map(() => "?").join(", ");
      this.db.prepare(`DELETE FROM nodes_fts WHERE rowid IN (${ph})`).run(...chunk);
      this.db.prepare(`DELETE FROM fts_index WHERE fts_rowid IN (${ph})`).run(...chunk);
    }
  }

  /**
   * Pass 2: re-insert edges for one file. Runs AFTER every file's
   * nodes are in place (the full batch is committed to nodes) so
   * cross-file edges resolve regardless of input order. Stale edges
   * for nodes owned by this file are deleted first so a changed
   * `confidence` or `provenance` actually overwrites the prior row
   * (chatgpt-codex-connector P1: ON CONFLICT DO NOTHING silently
   * kept stale edges across re-ingests).
   */
  private upsertFileEdges(ir: StoreFileIR, result: UpsertResult): void {
    // If edges are not provided (undefined or null — e.g. from JSON
    // deserialization), preserve prior edges rather than treating a
    // missing field as an empty assertion set. A bare core
    // ParseResult.ir (which has no edges field) re-upsert must NOT
    // wipe previously stored edges. An explicit empty array [] DOES
    // assert "no edges" and deletes all prior src-owned edges
    // (cursor Bugbot: 'Omitted edges field wipes stored edges' /
    // 'Null edges wipe stored edges').
    if (ir.edges == null) {
      return;
    }
    // Build the set of edges the IR is asserting for this file. The
    // SRC of each edge MUST belong to this file (it is resolved from
    // the per-file `qualifiedNameToId` map only — no DB fallback);
    // a FileIR that asserts an edge whose src is absent from this
    // file but present elsewhere is malformed and the edge is dropped
    // so it cannot be silently cross-owned. The DST may be cross-file
    // and uses the full-DB fallback (chatgpt-codex-connector P2:
    // 'Require edge sources to belong to the ingested file'). Edges
    // whose dst cannot resolve are also dropped — the caller is
    // responsible for the batch's canonical file set (rule 40).
    const qualifiedNameToId = new Map<string, string>();
    const ownSymbols = expectRows<{ id: string; qualified_name: string }>(
      this.db
        .prepare("SELECT id, qualified_name FROM nodes WHERE file_id = ?")
        .all(result.fileId),
      ["id", "qualified_name"],
    );
    // Count qualified_name occurrences so ambiguous names are excluded.
    // Node identity is (qualifiedName, filePath, label) — two symbols in
    // the same file CAN share a qualified_name (e.g. a TS type + value
    // both named Foo, with different labels → different node ids). A
    // qualified_name-only map would silently keep just one; instead,
    // ambiguous names are left out so edges to them resolve to undefined
    // and are dropped — matching the DST conservative-drop policy
    // (chatgpt-codex-connector P2: 'Reject ambiguous local qualified names').
    const qnameCounts = new Map<string, number>();
    for (const row of ownSymbols) {
      qnameCounts.set(row.qualified_name, (qnameCounts.get(row.qualified_name) ?? 0) + 1);
    }
    for (const row of ownSymbols) {
      if ((qnameCounts.get(row.qualified_name) ?? 0) === 1) {
        qualifiedNameToId.set(row.qualified_name, row.id);
      }
    }

    const assertedKeys = new Set<string>();
    // Re-resolve each edge in the IR to its deterministic key so the
    // delete below only drops edges that are NOT being re-asserted.
    // Doing this BEFORE the delete is critical: deleting first then
    // checking the no-op skip leaves cross-file edges (whose src is
    // owned here but whose dst lives elsewhere) orphaned when the
    // IR re-asserts them — the prior-edge snapshot matches, the
    // insert is skipped, and the row is gone (cursor Bugbot #6a78cd0a).
    const seenKeys: string[] = [];
    // Map each resolved key to its first edge so the insertion pass
    // can look up metadata in O(1) instead of rescanning ir.edges
    // and re-running resolveNodeId (with DB lookups) per key
    // (chatgpt-codex-connector P2: 'Preserve resolved edge metadata
    // instead of rescanning'). First-edge-wins dedupe policy
    // (cursor Bugbot #28876d4c) is preserved by only setting on
    // first occurrence.
    const keyToEdge = new Map<string, EdgeIR>();
    for (const edge of ir.edges ?? []) {
      // Reject malformed edges up-front (rule 51: surface what is wrong).
      if (!isEdgeProvenance(edge.provenance)) {
        throw new Error(
          `graph-store: edge has invalid provenance ${JSON.stringify(edge.provenance)}`,
        );
      }
      if (
        !Number.isFinite(edge.confidence) ||
        edge.confidence < 0 ||
        edge.confidence > 1
      ) {
        throw new Error(
          `graph-store: edge confidence ${edge.confidence} is out of range [0, 1] for edge ${edge.srcQualifiedName} → ${edge.dstQualifiedName}`,
        );
      }
      // SRC must be a symbol in THIS file — resolve from the per-file
      // map only. A FileIR whose edge src lives in another file is
      // malformed; dropping it prevents cross-owned edges that survive
      // re-ingest (chatgpt-codex-connector P2).
      const srcId = qualifiedNameToId.get(edge.srcQualifiedName);
      if (!srcId) continue;
      // DST may be cross-file. A path-hinted edge (relative import,
      // issue #1894 review) resolves ONLY within its declared target
      // file — never via the global bare-name fallback; unhinted edges
      // keep the batch-map + full-DB fallback.
      const dstId = edge.dstPathHint
        ? resolveNodeIdWithPathHint(edge.dstQualifiedName, edge.dstPathHint, this.db)
        : resolveNodeId(edge.dstQualifiedName, qualifiedNameToId, this.db);
      if (!dstId) continue;
      const key = `${srcId}\u0000${dstId}\u0000${edge.type}`;
      assertedKeys.add(key);
      seenKeys.push(key);
      if (!keyToEdge.has(key)) {
        keyToEdge.set(key, edge);
      }
    }

    // Pre-fetch the prior edges owned by this file (src in this file's
    // nodes) so we can (a) skip the no-op re-upsert when confidence +
    // provenance match exactly, and (b) compute the stale-edge delete
    // set: prior src-owned edges that are NOT in the current IR's
    // asserted keys.
    const priorEdges = expectRows<{
      src: string;
      dst: string;
      type: string;
      confidence: number;
      provenance: string;
    }>(
      this.db
        .prepare(
          "SELECT src, dst, type, confidence, provenance FROM edges WHERE src IN (SELECT id FROM nodes WHERE file_id = ?)",
        )
        .all(result.fileId),
      ["src", "dst", "type", "confidence", "provenance"],
    );
    const priorByKey = new Map<string, { confidence: number; provenance: string }>();
    const staleSrcDstTypes: Array<{ src: string; dst: string; type: string }> = [];
    // Provenance scoping (issue #1891): when the IR declares which
    // provenances it asserts, stale edges of OTHER provenances are not
    // this ingest's to delete — a fresh parse contradicts only its own
    // derivation class (rule 25). Absent = legacy delete-all-stale.
    const scoped = ir.assertedEdgeProvenances;
    for (const p of priorEdges) {
      const key = `${p.src}\u0000${p.dst}\u0000${p.type}`;
      priorByKey.set(key, { confidence: p.confidence, provenance: p.provenance });
      if (assertedKeys.has(key)) continue;
      if (scoped && !(scoped as readonly string[]).includes(p.provenance)) continue;
      staleSrcDstTypes.push({ src: p.src, dst: p.dst, type: p.type });
    }

    // Delete only the stale src-owned edges (prior-but-not-asserted).
    // This preserves any cross-file edge that the current IR
    // re-asserts, even when its dst lives in a file NOT in this
    // batch — the row survives the delete and the no-op skip below
    // keeps `changes` honest.
    //
    // Chunk the deletes: each tuple binds 3 parameters and SQLite
    // enforces a variable limit (32766 in the bundled build). An
    // unbounded IN list would throw `too many SQL variables` for a
    // file with >10,922 stale edges, rolling back the whole batch
    // (chatgpt-codex-connector P2: 'Chunk stale-edge deletes before
    // binding them').
    const SQLITE_VARIABLE_LIMIT = 32_766;
    const PARAMS_PER_TUPLE = 3;
    const MAX_TUPLES_PER_CHUNK = Math.floor(SQLITE_VARIABLE_LIMIT / PARAMS_PER_TUPLE);
    for (let i = 0; i < staleSrcDstTypes.length; i += MAX_TUPLES_PER_CHUNK) {
      const chunk = staleSrcDstTypes.slice(i, i + MAX_TUPLES_PER_CHUNK);
      const placeholders = chunk.map(() => "(?, ?, ?)").join(", ");
      this.db
        .prepare(`DELETE FROM edges WHERE (src, dst, type) IN (${placeholders})`)
        .run(...chunk.flatMap((e) => [e.src, e.dst, e.type]));
    }

    const insertEdge = this.db.prepare(
      `INSERT INTO edges (src, dst, type, confidence, provenance)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(src, dst, type) DO UPDATE SET
           confidence = excluded.confidence,
           provenance = excluded.provenance`,
    );
    let edgeCount = 0;
    // Dedupe keys: a FileIR with two edges sharing `(src, dst, type)`
    // (but differing confidence/provenance) is malformed input. First-edge
    // metadata wins; later duplicates are skipped so they cannot inflate
    // edgeCount via redundant re-upserts (cursor Bugbot #28876d4c).
    const processedKeys = new Set<string>();
    for (const key of seenKeys) {
      if (processedKeys.has(key)) continue;
      processedKeys.add(key);
      const edge = keyToEdge.get(key);
      if (!edge) continue;
      const parts = key.split("\u0000");
      const srcId = parts[0]!;
      const dstId = parts[1]!;
      const prior = priorByKey.get(key);
      if (
        prior &&
        prior.confidence === edge.confidence &&
        prior.provenance === edge.provenance
      ) {
        // Identical to the prior row — no INSERT/UPDATE needed, so
        // `changes` stays 0 and the idempotency contract holds. The
        // row still exists because the delete above only removed
        // stale keys.
        continue;
      }
      // Two update-path protections under provenance scoping (issue
      // #1891 + #1894 review rounds):
      //  1. a prior row whose provenance is OUTSIDE the asserted scope
      //     is not this assertion's to modify (defense in depth — in
      //     practice cross-provenance key collisions are heuristic/lsp
      //     only, handled by 2);
      //  2. an lsp row is a strictly stronger derivation of the SAME
      //     source-derived edge: re-asserting the heuristic key keeps
      //     the row alive (it is not stale) but must never downgrade it.
      //     Retirement of lsp rows happens through the stale-delete when
      //     the call disappears from the parse — lsp IS in the reindex
      //     assertion scope precisely so vanished calls retire their
      //     upgraded rows too.
      if (
        prior &&
        scoped &&
        (!(scoped as readonly string[]).includes(prior.provenance) ||
          (prior.provenance === "lsp" && edge.provenance === "heuristic"))
      ) {
        continue;
      }
      const r = insertEdge.run(srcId, dstId, edge.type, edge.confidence, edge.provenance);
      edgeCount += r.changes;
    }
    result.edgeCount = edgeCount;
  }

  /**
   * Pass 3 (PR2): upsert `node_attributes` rows for this file's
   * surviving nodes, derived from the IR's optional `exports` and
   * `routes` arrays. Per-field preservation semantics (mirrors the
   * edges pass, generalized to two independent flags):
   *   - `exports == null` (omitted) → preserve existing `is_exported`
   *     flags untouched (PR1-era IR has no exports field). The
   *     `is_route_handler` flag is rebuilt independently from
   *     `routes` — the two columns do NOT interact.
   *   - `exports === []` (explicit empty) → wipe the file's
   *     `is_exported` flags (the caller is asserting "this file
   *     exports nothing").
   *   - same rule for `routes` / `is_route_handler`.
   *
   * A symbol is `is_exported=1` when its `name` matches an entry in
   * `ir.exports` (multiple symbols with the same name in one file all
   * get the flag — the dead-code query treats this conservatively,
   * never silently picking one). A symbol is `is_route_handler=1`
   * when its `qualifiedName` equals a route's `handlerQualifiedName`.
   *
   * Implementation: per-flag UPDATE, not a delete-then-insert (the
   * original PR2 implementation wiped both flags whenever either field
   * was present, so a re-ingest with only `exports` silently dropped
   * `is_route_handler` — cursor Bugbot + chatgpt-codex-connector P2).
   * The two flags live in the same row keyed by node_id; INSERT OR
   * IGNORE ensures a row exists, then UPDATE-per-flag changes only
   * the column the IR is asserting.
   */
  private upsertFileAttributes(ir: StoreFileIR, result: UpsertResult): void {
    // Both fields omitted → nothing to assert. Preserve every flag
    // (PR1 baseline). Avoids touching the table at all so truly-no-op
    // re-ingests stay zero-cost.
    if (ir.exports == null && ir.routes == null) {
      return;
    }

    const ownNodes = expectRows<{ id: string; name: string; qualified_name: string }>(
      this.db
        .prepare("SELECT id, name, qualified_name FROM nodes WHERE file_id = ?")
        .all(result.fileId),
      ["id", "name", "qualified_name"],
    );
    const ownNodeIds = ownNodes.map((n) => n.id);
    if (ownNodeIds.length === 0) {
      return;
    }

    // Per-flag rebuild. The pattern is identical for each flag:
    //   1. Ensure every node in this file has an attributes row
    //      (default 0,0). INSERT OR IGNORE keeps any existing row.
    //   2. If the IR field for this flag is present, wipe the column
    //      for this file's nodes (so removed flags clear), then set
    //      the column for nodes in the new set.
    //   3. If the IR field is omitted, leave the column untouched.
    const ensureRow = this.db.prepare(
      `INSERT OR IGNORE INTO node_attributes (node_id, is_exported, is_route_handler)
         VALUES (?, 0, 0)`,
    );
    for (const id of ownNodeIds) ensureRow.run(id);

    if (ir.exports != null) {
      const exportNames = new Set<string>();
      for (const ex of ir.exports) {
        if (ex && typeof ex.name === "string" && ex.name.length > 0) {
          exportNames.add(ex.name);
        }
      }
      const newExportedIds = new Set<string>();
      for (const n of ownNodes) {
        if (exportNames.has(n.name)) newExportedIds.add(n.id);
      }
      // Wipe is_exported for this file's nodes, chunked under the
      // SQLite variable limit. The other column is untouched.
      this.runChunkedUpdate(
        `UPDATE node_attributes SET is_exported = 0 WHERE node_id IN (%PH%)`,
        ownNodeIds,
      );
      // Set the flag for the new exported set.
      const setExported = this.db.prepare(
        `UPDATE node_attributes SET is_exported = 1 WHERE node_id = ?`,
      );
      for (const id of newExportedIds) setExported.run(id);
    }

    if (ir.routes != null) {
      const handlerQNames = new Set<string>();
      for (const r of ir.routes) {
        if (r && typeof r.handlerQualifiedName === "string" && r.handlerQualifiedName.length > 0) {
          handlerQNames.add(r.handlerQualifiedName);
        }
      }
      const newRouteIds = new Set<string>();
      for (const n of ownNodes) {
        if (handlerQNames.has(n.qualified_name)) newRouteIds.add(n.id);
      }
      this.runChunkedUpdate(
        `UPDATE node_attributes SET is_route_handler = 0 WHERE node_id IN (%PH%)`,
        ownNodeIds,
      );
      const setRoute = this.db.prepare(
        `UPDATE node_attributes SET is_route_handler = 1 WHERE node_id = ?`,
      );
      for (const id of newRouteIds) setRoute.run(id);
    }
  }

  /**
   * Chunk a parameterized UPDATE-with-IN-list under SQLite's variable
   * bind limit. The SQL template uses `%PH%` as a placeholder for the
   * `?,?,…` list. Mirrors the chunking pattern PR1 uses for deletes.
   */
  private runChunkedUpdate(sqlTemplate: string, params: readonly string[]): void {
    if (params.length === 0) return;
    for (let i = 0; i < params.length; i += SQLITE_VARIABLE_LIMIT) {
      const chunk = params.slice(i, i + SQLITE_VARIABLE_LIMIT);
      const placeholders = chunk.map(() => "?").join(", ");
      this.db.prepare(sqlTemplate.replace("%PH%", placeholders)).run(...chunk);
    }
  }

  // ──────────────────────────────────────────────────────────────────────
  // PR2 read primitives (issue #1552 steps 4–5).
  // ──────────────────────────────────────────────────────────────────────

  /**
   * Iterative frontier BFS over the edges table. Cycle-safe via a JS
   * visited set keyed by node id; depth-capped by {@link TraverseQuery.maxDepth}
   * (half-open — depth==maxDepth is INCLUDED, maxDepth+1 is NOT — rule 35).
   * The start node is always included at depth 0 when it exists.
   *
   * Reads the edges table via a single prepared statement per
   * direction; the frontier expands level-by-level so memory is
   * bounded by the visited set's size, not the recursion depth.
   */
  traverse(query: TraverseQuery): TraverseResult {
    if (this.closed) return { ok: false, code: "store_closed" };
    // Guard the query object before any dereference: a null/undefined
    // payload (e.g. malformed JSON forwarded at an MCP boundary) would
    // throw on `query.maxDepth` below instead of returning the tagged
    // invalid_query the read contract advertises
    // (chatgpt-codex-connector P2: 'Validate read query objects before
    // dereferencing').
    if (query == null || typeof query !== "object") {
      return { ok: false, code: "invalid_query" };
    }
    // Validate maxDepth up-front (rule 51: surface what's wrong).
    if (
      typeof query.maxDepth !== "number" ||
      !Number.isInteger(query.maxDepth) ||
      query.maxDepth < 0
    ) {
      return {
        ok: false,
        code: "invalid_query",
      };
    }
    // Validate direction against the allowed set (rule 51 +
    // chatgpt-codex-connector P2: 'Reject invalid traversal directions
    // explicitly'). Default ONLY on `undefined` — a `null` from a
    // JSON/tool caller is a malformed value, not an absent one, so the
    // `??` operator (which treats null as nullish) would silently turn
    // it into "outgoing" and mask the bad input. Reject null explicitly
    // (chatgpt-codex-connector P2: 'Reject null traversal directions').
    const direction: TraverseDirection =
      query.direction === undefined ? "outgoing" : query.direction;
    if (
      direction !== "outgoing" &&
      direction !== "incoming" &&
      direction !== "both"
    ) {
      return { ok: false, code: "invalid_query" };
    }
    // Validate edgeTypes, if present, is an array of strings (rule 51 +
    // chatgpt-codex-connector P2: 'Validate edgeTypes before building
    // traversal SQL'). A malformed value like a bare string "CALLS"
    // would otherwise throw at .map() instead of returning the
    // tagged invalid_query failure the contract advertises.
    if (
      query.edgeTypes !== undefined &&
      (!Array.isArray(query.edgeTypes) ||
        !query.edgeTypes.every((e) => typeof e === "string"))
    ) {
      return { ok: false, code: "invalid_query" };
    }
    // Validate `start` is a non-empty string before it reaches the
    // SQLite bind (rule 51 + chatgpt-codex-connector P2: 'Validate
    // traverse start before binding it'). A JS/JSON caller passing an
    // object/array survives the regex `.test()` coercion but then
    // throws a non-SQLite TypeError at bind time; surface that as the
    // precise `invalid_query` rather than letting it fall through to
    // the generic db_error catch-all.
    if (
      typeof query.start !== "string" ||
      query.start.length === 0
    ) {
      return { ok: false, code: "invalid_query" };
    }
    // Wrap DB operations in try/catch so lock/corrupt errors return a
    // tagged failure instead of throwing (cursor Bugbot: 'SQLite errors
    // escape read APIs'). Same shape as schemaStats/deadCode.
    try {
    // Resolve the start node. If `start` is a 64-char lowercase hex
    // string (the nodeIdFor sha256 format), resolve ONLY by id — this
    // is the unambiguous path a caller uses after seeing an ambiguous
    // qualified_name rejection. Otherwise resolve ONLY by qualified_name.
    // Splitting the two paths (cursor Bugbot: 'Traverse start conflates id
    // and name') prevents a mistyped id from silently matching an
    // unrelated qualified_name, and prevents a unique id from being
    // reported as ambiguous just because some other node shares the id
    // string as a qualified_name.
    let startId: string;
    const isNodeId = /^[0-9a-f]{64}$/.test(query.start);
    const rows = expectRows<{ id: string }>(
      this.db
        .prepare(
          isNodeId
            ? "SELECT id FROM nodes WHERE id = ?"
            : "SELECT id FROM nodes WHERE qualified_name = ?",
        )
        .all(query.start),
      ["id"],
    );
    if (rows.length === 0) {
      return { ok: false, code: "unknown_start" };
    }
    if (rows.length > 1) {
      // Multiple rows mean the start resolved to more than one node —
      // either the same id matching twice (impossible — PRIMARY KEY)
      // or a qualified_name declared in multiple files. Reject so the
      // caller passes an explicit node id.
      return { ok: false, code: "ambiguous_start" };
    }
    startId = rows[0]!.id;

    // BFS. Edge-type filter is bound into the prepared statement via
    // IN (?, ?, ...) — empty list means "all types" (no WHERE clause
    // on type). The edge-type list is small (≤ ~25) so chunking is
    // unnecessary here, but we still parameterize so user input
    // cannot inject SQL.
    const edgeTypes = query.edgeTypes ?? [];
    const typeClause =
      edgeTypes.length > 0
        ? `AND type IN (${edgeTypes.map(() => "?").join(", ")})`
        : "";
    const outgoingStmt = this.db.prepare(
      `SELECT dst AS neighbor, src AS via_id FROM edges WHERE src = ? ${typeClause}`,
    );
    const incomingStmt = this.db.prepare(
      `SELECT src AS neighbor, dst AS via_id FROM edges WHERE dst = ? ${typeClause}`,
    );

    const visited = new Set<string>([startId]);
    const hits: TraverseHit[] = [];
    const startRow = expectRow<{
      id: string;
      qualified_name: string;
      name: string;
      label: string;
      file_path: string;
    }>(
      this.db
        .prepare(
          "SELECT n.id, n.qualified_name, n.name, n.label, f.path AS file_path FROM nodes n JOIN files f ON n.file_id = f.id WHERE n.id = ?",
        )
        .get(startId),
      ["id", "qualified_name", "name", "label", "file_path"],
    );
    if (!startRow) {
      // Race: the node vanished between the resolve and the read.
      // Treat as unknown rather than crash.
      return { ok: false, code: "unknown_start" };
    }
    hits.push({
      nodeId: startRow.id,
      qualifiedName: startRow.qualified_name,
      name: startRow.name,
      label: startRow.label,
      filePath: startRow.file_path,
      depth: 0,
    });

    // maxDepth === 0 → just the start node (half-open: depth 0 is
    // included, depth 1 is not).
    if (query.maxDepth === 0) {
      return { ok: true, hits };
    }

    let frontier: string[] = [startId];
    for (let depth = 1; depth <= query.maxDepth; depth += 1) {
      const nextFrontier: string[] = [];
      for (const nodeId of frontier) {
        const params = [nodeId, ...edgeTypes];
        const outRows =
          direction === "outgoing" || direction === "both"
            ? expectRows<{ neighbor: string }>(
                outgoingStmt.all(...params),
                ["neighbor"],
              )
            : [];
        const inRows =
          direction === "incoming" || direction === "both"
            ? expectRows<{ neighbor: string }>(
                incomingStmt.all(...params),
                ["neighbor"],
              )
            : [];
        for (const r of [...outRows, ...inRows]) {
          const neighbor = r.neighbor;
          // Cycle safety: a node already in `visited` is not re-added.
          // This also handles self-edges (src == dst): the start is in
          // visited, so a self-loop on it never re-expands the frontier.
          if (visited.has(neighbor)) continue;
          visited.add(neighbor);
          nextFrontier.push(neighbor);
          const hitRow = expectRow<{
            id: string;
            qualified_name: string;
            name: string;
            label: string;
            file_path: string;
          }>(
            this.db
              .prepare(
                "SELECT n.id, n.qualified_name, n.name, n.label, f.path AS file_path FROM nodes n JOIN files f ON n.file_id = f.id WHERE n.id = ?",
              )
              .get(neighbor),
            ["id", "qualified_name", "name", "label", "file_path"],
          );
          if (hitRow) {
            hits.push({
              nodeId: hitRow.id,
              qualifiedName: hitRow.qualified_name,
              name: hitRow.name,
              label: hitRow.label,
              filePath: hitRow.file_path,
              depth,
            });
          }
        }
      }
      if (nextFrontier.length === 0) break;
      frontier = nextFrontier;
    }
    return { ok: true, hits };
    } catch (error) {
      logWriteFailure(error);
      return classifyReadError(error) as TraverseResult;
    }
  }
  /**
   * Path-enumerating traversal (issue #1650). Unlike {@link traverse}'s BFS —
   * which visits each node ONCE at its shortest-path depth and so cannot honor
   * an exact `*N` (N > 1) hop count for nodes reachable at both a shorter and a
   * length-N path — this primitive enumerates concrete relationship-simple
   * paths from the start, yielding one hit per distinct (path, endpoint) pair
   * up to {@link TraversePathsQuery.maxHops}.
   *
   * Cycle safety uses RELATIONSHIP UNIQUENESS (the real Cypher rule): a single
   * path never traverses the same edge twice, keyed by the edge's canonical
   * `(src, dst, type)` identity. A node MAY recur in a path via distinct edges
   * (e.g. A->B->A over two different edges) — that is correct Cypher behavior.
   * The {@link TraversePathsQuery.maxHops} cap bounds each path's length;
   * {@link TraversePathsQuery.maxPaths} bounds the total enumerated count so a
   * dense subgraph cannot blow enumeration up exponentially without notice
   * (when hit, enumeration stops and the result carries `truncated: true`).
   *
   * Every yielded path has length >= 1 (at least one edge). A length-0 "path"
   * (the trivial start->start) is NOT enumerated; callers that need the start
   * node for a `*0..N` bound add it themselves.
   */
  traversePaths(query: TraversePathsQuery): TraversePathsResult {
    if (this.closed) return { ok: false, code: "store_closed" };
    // Guard the query object before any dereference (mirrors traverse).
    if (query == null || typeof query !== "object") {
      return { ok: false, code: "invalid_query" };
    }
    if (
      typeof query.maxHops !== "number" ||
      !Number.isInteger(query.maxHops) ||
      query.maxHops < 0
    ) {
      return { ok: false, code: "invalid_query" };
    }
    // Reject depths that would overflow the recursive DFS before maxPaths
    // can bind it (chatgpt-codex-connector P2: 'Avoid recursive DFS for deep
    // bounded paths').
    if (query.maxHops > MAX_TRAVERSE_PATHS_HOPS) {
      return { ok: false, code: "invalid_query" };
    }
    const direction: TraverseDirection =
      query.direction === undefined ? "outgoing" : query.direction;
    if (
      direction !== "outgoing" &&
      direction !== "incoming" &&
      direction !== "both"
    ) {
      return { ok: false, code: "invalid_query" };
    }
    if (
      query.edgeTypes !== undefined &&
      (!Array.isArray(query.edgeTypes) ||
        !query.edgeTypes.every((e) => typeof e === "string"))
    ) {
      return { ok: false, code: "invalid_query" };
    }
    if (typeof query.start !== "string" || query.start.length === 0) {
      return { ok: false, code: "invalid_query" };
    }
    // minHops: validate only when explicitly provided; default 1. MUST be a
    // positive integer -- the primitive never emits length-0 paths.
    const minHops = query.minHops === undefined ? 1 : query.minHops;
    if (
      typeof minHops !== "number" ||
      !Number.isInteger(minHops) ||
      minHops < 1
    ) {
      return { ok: false, code: "invalid_query" };
    }
    // maxPaths: reject a malformed EXPLICIT value rather than silently
    // defaulting (rule 51 -- surface what's wrong). Only `undefined` defaults
    // (chatgpt-codex-connector P2: 'Reject malformed maxPaths instead of
    // defaulting').
    let maxPaths: number;
    if (query.maxPaths === undefined) {
      maxPaths = DEFAULT_TRAVERSE_PATHS_MAX;
    } else if (
      typeof query.maxPaths !== "number" ||
      !Number.isInteger(query.maxPaths) ||
      query.maxPaths < 0
    ) {
      return { ok: false, code: "invalid_query" };
    } else {
      maxPaths = query.maxPaths;
    }

    try {
      // Resolve the start node — same split id/qualified_name policy as
      // traverse (cursor Bugbot: 'Traverse start conflates id and name').
      const isNodeId = /^[0-9a-f]{64}$/.test(query.start);
      const rows = expectRows<{ id: string }>(
        this.db
          .prepare(
            isNodeId
              ? "SELECT id FROM nodes WHERE id = ?"
              : "SELECT id FROM nodes WHERE qualified_name = ?",
          )
          .all(query.start),
        ["id"],
      );
      if (rows.length === 0) return { ok: false, code: "unknown_start" };
      if (rows.length > 1) return { ok: false, code: "ambiguous_start" };
      const startId = rows[0]!.id;

      // maxHops === 0 -> no edge paths exist.
      if (query.maxHops === 0) {
        return { ok: true, hits: [], truncated: false };
      }

      const edgeTypes = query.edgeTypes ?? [];
      const typeClause =
        edgeTypes.length > 0
          ? `AND type IN (${edgeTypes.map(() => "?").join(", ")})`
          : "";
      // Return the canonical (src, dst, type) so relationship-uniqueness keys
      // are direction-independent: traversing edge A->B outgoing then B->A
      // incoming reuses the SAME relationship and is blocked.
      const outgoingStmt = this.db.prepare(
        `SELECT dst AS neighbor, src, dst, type FROM edges WHERE src = ? ${typeClause}`,
      );
      const incomingStmt = this.db.prepare(
        `SELECT src AS neighbor, src, dst, type FROM edges WHERE dst = ? ${typeClause}`,
      );
      const nodeStmt = this.db.prepare(
        "SELECT n.id, n.qualified_name, n.name, n.label, f.path AS file_path FROM nodes n JOIN files f ON n.file_id = f.id WHERE n.id = ?",
      );

      type NodeRow = {
        id: string;
        qualified_name: string;
        name: string;
        label: string;
        file_path: string;
      };
      type EdgeRow = {
        neighbor: string;
        src: string;
        dst: string;
        type: string;
      };

      const nodeCache = new Map<string, NodeRow>();
      const getNode = (id: string): NodeRow | undefined => {
        const cached = nodeCache.get(id);
        if (cached) return cached;
        const row = expectRow<NodeRow>(nodeStmt.get(id), [
          "id",
          "qualified_name",
          "name",
          "label",
          "file_path",
        ]);
        if (row) nodeCache.set(id, row);
        return row;
      };

      const neighborsOf = (id: string): EdgeRow[] => {
        const params = [id, ...edgeTypes];
        const out: EdgeRow[] =
          direction === "outgoing" || direction === "both"
            ? expectRows<EdgeRow>(outgoingStmt.all(...params), [
                "neighbor",
                "src",
                "dst",
                "type",
              ])
            : [];
        const inn: EdgeRow[] =
          direction === "incoming" || direction === "both"
            ? expectRows<EdgeRow>(incomingStmt.all(...params), [
                "neighbor",
                "src",
                "dst",
                "type",
              ])
            : [];
        // Dedupe by the canonical (src, dst, type) key. Under
        // direction "both" a SELF-LOOP (src == dst) is matched by BOTH
        // the outgoing and incoming SELECTs, and because usedEdges is
        // cleared after each branch the same relationship-simple path
        // would otherwise be emitted twice -- violating the one-hit-per-
        // distinct-path contract and double-consuming the maxPaths cap
        // (chatgpt-codex-connector P2: 'Deduplicate self-loop edges for
        // both-direction traversal'). The UNIQUE(src,dst,type) table
        // constraint guarantees no dup within a single direction, so this
        // only ever collapses the both-direction self-loop overlap.
        const seenEdge = new Set<string>();
        const deduped: EdgeRow[] = [];
        for (const e of [...out, ...inn]) {
          const k = e.src + "\u0000" + e.dst + "\u0000" + e.type;
          if (seenEdge.has(k)) continue;
          seenEdge.add(k);
          deduped.push(e);
        }
        return deduped;
      };

      const hits: TraversePathHit[] = [];
      let truncated = false;
      const usedEdges = new Set<string>();
      const pathNodes: string[] = [startId];
      const pathEdgeTypes: string[] = [];
      const pathEndpoints: Array<{ src: string; dst: string }> = [];

      // Recursive DFS. `length` is the current path's hop count (edges taken).
      // We EXPLORE while length < maxHops (shorter prefixes must be walked to
      // reach longer paths) but EMIT only when newLength >= minHops, so the
      // maxPaths cap protects the in-range result set instead of being
      // consumed by discarded shorter prefixes (cursor Bugbot: 'Path cap
      // ignores hop minimum').
      const dfs = (currentId: string, length: number): void => {
        if (truncated) return;
        if (length >= query.maxHops) return;
        for (const e of neighborsOf(currentId)) {
          if (truncated) return;
          const key = `${e.src}\u0000${e.dst}\u0000${e.type}`;
          if (usedEdges.has(key)) continue;
          usedEdges.add(key);
          pathNodes.push(e.neighbor);
          pathEdgeTypes.push(e.type);
          pathEndpoints.push({ src: e.src, dst: e.dst });
          const newLength = length + 1;
          if (newLength >= minHops) {
            // Cap check on EMITTED (in-range) hits only.
            if (hits.length >= maxPaths) {
              truncated = true;
            } else {
              const info = getNode(e.neighbor);
              if (info) {
                hits.push({
                  nodeId: info.id,
                  qualifiedName: info.qualified_name,
                  name: info.name,
                  label: info.label,
                  filePath: info.file_path,
                  length: newLength,
                  nodeIds: pathNodes.slice(),
                  edgeTypes: pathEdgeTypes.slice(),
                  edgeEndpoints: pathEndpoints.slice(),
                });
              }
            }
          }
          if (!truncated) dfs(e.neighbor, newLength);
          pathEndpoints.pop();
          pathEdgeTypes.pop();
          pathNodes.pop();
          usedEdges.delete(key);
        }
      };

      dfs(startId, 0);
      return { ok: true, hits, truncated };
    } catch (error) {
      logWriteFailure(error);
      return classifyReadError(error) as TraversePathsResult;
    }
  }
  /**
   * Structured node search. All filters are AND-combined; patterns use
   * SQLite LIKE (case-insensitive via COLLATE NOCASE). Patterns and
   * limits are parameter-bound, never string-interpolated, so user
   * input cannot inject SQL.
   */
  searchGraph(query: SearchQuery): SearchResult {
    if (this.closed) return { ok: false, code: "store_closed" };
    // Guard the query object before any dereference (see traverse).
    if (query == null || typeof query !== "object") {
      return { ok: false, code: "invalid_query" };
    }
    // Validate numeric inputs (rule 51). NaN / negative / non-integer
    // limits are rejected, not silently clamped, so callers learn what
    // they passed.
    if (
      (query.degreeMin !== undefined &&
        (typeof query.degreeMin !== "number" ||
          !Number.isInteger(query.degreeMin) ||
          query.degreeMin < 0)) ||
      (query.degreeMax !== undefined &&
        (typeof query.degreeMax !== "number" ||
          !Number.isInteger(query.degreeMax) ||
          query.degreeMax < 0))
    ) {
      return { ok: false, code: "invalid_query" };
    }
    if (
      query.degreeMin !== undefined &&
      query.degreeMax !== undefined &&
      query.degreeMin > query.degreeMax
    ) {
      return { ok: false, code: "invalid_query" };
    }
    const rawLimit = query.limit ?? 100;
    if (
      typeof rawLimit !== "number" ||
      !Number.isInteger(rawLimit) ||
      rawLimit < 0
    ) {
      return { ok: false, code: "invalid_query" };
    }
    // Clamp to [0, MAX_SEARCH_LIMIT]. A `limit: 0` returns an empty
    // hits array (rule 27 — guard the slice/LIMIT against zero).
    const MAX_SEARCH_LIMIT = 1000;
    const limit = Math.min(rawLimit, MAX_SEARCH_LIMIT);

    // Validate string filters are strings when present (rule 51 +
    // chatgpt-codex-connector P2: 'Reject non-string search patterns
    // instead of dropping filters'). A non-string like namePattern: 42
    // has undefined .length, so the guard below would silently drop
    // the filter and return unrelated nodes. Reject up-front instead.
    if (
      (query.label !== undefined && typeof query.label !== "string") ||
      (query.namePattern !== undefined &&
        typeof query.namePattern !== "string") ||
      (query.filePattern !== undefined &&
        typeof query.filePattern !== "string")
    ) {
      return { ok: false, code: "invalid_query" };
    }

    // Wrap DB operations in try/catch (cursor Bugbot: 'SQLite errors
    // escape read APIs'). Same shape as schemaStats/deadCode/traverse.
    try {
    // Build a single parameterized query. The degree subquery counts
    // inbound + outbound edges per node; the WHERE clause AND-combines
    // every present filter; the LIMIT is bound last. LIKE patterns are
    // bound as-is so SQLite interprets `%` and `_`.
    const params: (string | number)[] = [];
    const where: string[] = [];
    if (query.label !== undefined && query.label.length > 0) {
      where.push("n.label = ?");
      params.push(query.label);
    }
    if (query.namePattern !== undefined && query.namePattern.length > 0) {
      where.push("n.name LIKE ? COLLATE NOCASE");
      params.push(query.namePattern);
    }
    if (query.filePattern !== undefined && query.filePattern.length > 0) {
      where.push("f.path LIKE ? COLLATE NOCASE");
      params.push(query.filePattern);
    }
    // Degree filter on the computed subquery. We re-emit the COUNT
    // subquery in the WHERE clause rather than using HAVING — SQLite
    // requires HAVING to be paired with GROUP BY, and this query has
    // no GROUP BY (each row is one node). The correlated subquery is
    // evaluated per-row; SQLite's planner caches it cheaply for the
    // graph sizes we target (issue #1552 scale targets).
    if (query.degreeMin !== undefined) {
      where.push(
        "(SELECT COUNT(*) FROM edges e WHERE e.src = n.id OR e.dst = n.id) >= ?",
      );
      params.push(query.degreeMin);
    }
    if (query.degreeMax !== undefined) {
      where.push(
        "(SELECT COUNT(*) FROM edges e WHERE e.src = n.id OR e.dst = n.id) <= ?",
      );
      params.push(query.degreeMax);
    }

    params.push(limit);
    const sql = `SELECT n.id AS node_id, n.qualified_name, n.name, n.label,
                        f.path AS file_path,
                        (SELECT COUNT(*) FROM edges e WHERE e.src = n.id OR e.dst = n.id) AS degree
                   FROM nodes n
                   JOIN files f ON n.file_id = f.id
                  ${where.length > 0 ? "WHERE " + where.join(" AND ") : ""}
                  ORDER BY degree DESC, n.qualified_name ASC
                  LIMIT ?`;
    const rows = expectRows<{
      node_id: string;
      qualified_name: string;
      name: string;
      label: string;
      file_path: string;
      degree: number;
    }>(this.db.prepare(sql).all(...params), [
      "node_id",
      "qualified_name",
      "name",
      "label",
      "file_path",
      "degree",
    ]);
    const hits: SearchHit[] = rows.map((r) => ({
      nodeId: r.node_id,
      qualifiedName: r.qualified_name,
      name: r.name,
      label: r.label,
      filePath: r.file_path,
      degree: r.degree,
    }));
    return { ok: true, hits };
    } catch (error) {
      logWriteFailure(error);
      return classifyReadError(error) as SearchResult;
    }
  }

  /**
   * Aggregate counts over the whole graph. Single round-trip: one
   * scalar per metric, two GROUP BY queries for the by-label /
   * by-type histograms.
   */
  schemaStats(): SchemaStatsResult {
    if (this.closed) return { ok: false, code: "store_closed" };
    try {
      const fileCount = expectRow<{ c: number }>(
        this.db.prepare("SELECT COUNT(*) AS c FROM files").get(),
        ["c"],
      );
      const nodeCount = expectRow<{ c: number }>(
        this.db.prepare("SELECT COUNT(*) AS c FROM nodes").get(),
        ["c"],
      );
      const edgeCount = expectRow<{ c: number }>(
        this.db.prepare("SELECT COUNT(*) AS c FROM edges").get(),
        ["c"],
      );
      const labelRows = expectRows<{ label: string; c: number }>(
        this.db
          .prepare(
            "SELECT label, COUNT(*) AS c FROM nodes GROUP BY label ORDER BY label",
          )
          .all(),
        ["label", "c"],
      );
      const typeRows = expectRows<{ type: string; c: number }>(
        this.db
          .prepare(
            "SELECT type, COUNT(*) AS c FROM edges GROUP BY type ORDER BY type",
          )
          .all(),
        ["type", "c"],
      );
      const nodesByLabel: Record<string, number> = {};
      for (const r of labelRows) nodesByLabel[r.label] = r.c;
      const edgesByType: Record<string, number> = {};
      for (const r of typeRows) edgesByType[r.type] = r.c;
      return {
        ok: true,
        stats: {
          files: fileCount?.c ?? 0,
          nodes: nodeCount?.c ?? 0,
          edges: edgeCount?.c ?? 0,
          nodesByLabel,
          edgesByType,
        },
      };
    } catch (error) {
      logWriteFailure(error);
      const failure = classifyReadError(error);
      return failure as unknown as SchemaStatsResult;
    }
  }

  /**
   * Dead-code candidates: nodes with zero inbound
   * {@link DEAD_CODE_EXCLUSION.INBOUND_USAGE_EDGE_TYPES} edges, excluding
   * nodes whose `node_attributes` row marks them exported / route-handler
   * AND nodes whose file path matches the test / entry-point patterns
   * in {@link DEAD_CODE_EXCLUSION}.
   *
   * The exclusion criteria live in the named constant — not in
   * ad-hoc WHERE clauses (rule 53 analog). The stored flags come from
   * the write pipeline's `upsertFileAttributes` pass, which the IR's
   * `exports` and `routes` arrays feed.
   */
  deadCode(): DeadCodeResult {
    if (this.closed) return { ok: false, code: "store_closed" };
    try {
      // The inbound-usage edge-type list comes from the named
      // constant; bind it as a parameterized IN (...) so the criteria
      // are auditable in one place and a future edge-type add is a
      // one-line constant extension.
      const usageTypes = DEAD_CODE_EXCLUSION.INBOUND_USAGE_EDGE_TYPES;
      const typePlaceholders = usageTypes.map(() => "?").join(", ");
      // LEFT JOIN node_attributes so a missing row reads as (0, 0).
      // COALESCE is belt-and-braces — the LEFT JOIN already produces
      // NULL for missing rows, and `NULL OR ...` would surface NULL
      // in the WHERE; explicit COALESCE collapses NULL → 0.
      // Self-edges (e.src <> n.id) are excluded from inbound usage: a
      // private recursive helper whose only edge is `fn → fn` is
      // unreachable from the rest of the program, so the self-call
      // must not count as external usage — otherwise deadCode() omits
      // it and the unreferenced symbol stays invisible
      // (chatgpt-codex-connector P2: 'Ignore self-edges in dead-code
      // reachability').
      const sql = `SELECT n.id AS node_id, n.qualified_name, n.name, n.label,
                          f.path AS file_path
                     FROM nodes n
                     JOIN files f ON n.file_id = f.id
                     LEFT JOIN node_attributes a ON a.node_id = n.id
                    WHERE NOT EXISTS (
                       SELECT 1 FROM edges e
                        WHERE e.dst = n.id
                          AND e.src <> n.id
                          AND e.type IN (${typePlaceholders})
                     )
                      AND COALESCE(a.is_exported, 0) = 0
                      AND COALESCE(a.is_route_handler, 0) = 0
                    ORDER BY n.qualified_name ASC`;
      const rows = expectRows<{
        node_id: string;
        qualified_name: string;
        name: string;
        label: string;
        file_path: string;
      }>(this.db.prepare(sql).all(...usageTypes), [
        "node_id",
        "qualified_name",
        "name",
        "label",
        "file_path",
      ]);
      // Apply path-based exclusions in JS — SQLite's regex support is
      // opt-in and inconsistent across builds; doing it here keeps the
      // exclusion logic entirely in the named constant.
      const hits: DeadCodeHit[] = [];
      for (const r of rows) {
        if (isExcludedByPath(r.file_path)) continue;
        hits.push({
          nodeId: r.node_id,
          qualifiedName: r.qualified_name,
          name: r.name,
          label: r.label,
          filePath: r.file_path,
        });
      }
      return { ok: true, hits };
    } catch (error) {
      logWriteFailure(error);
      const failure = classifyReadError(error);
      return failure as unknown as DeadCodeResult;
    }
  }

  /**
   * Read a symbol's source span from disk. The store NEVER persists
   * file contents (privacy + DB size — issue #1552 design); this
   * method resolves `files.path` against {@link GraphStoreOptions.repoRoot}
   * and slices the half-open `[startByte, endByte)` span from the
   * on-disk bytes.
   */
  async snippetFor(query: SnippetQuery): Promise<SnippetResult> {
    if (this.closed) return { ok: false, code: "store_closed" };
    // Guard the query object before any dereference (see traverse).
    if (query == null || typeof query !== "object") {
      return { ok: false, code: "invalid_query" };
    }
    // Prefer a deterministic node id when supplied — it is unique, so it
    // never hits the qualified-name ambiguity path.
    const hasNodeId = typeof query.nodeId === "string" && query.nodeId.length > 0;
    if (
      !hasNodeId &&
      (typeof query.qualifiedName !== "string" ||
        query.qualifiedName.length === 0)
    ) {
      return { ok: false, code: "invalid_query" };
    }
    // Validate contextLines is a non-negative integer when present,
    // consistent with traverse's maxDepth and the other numeric read
    // fields. The old path coerced (Math.floor), so `1.9` silently
    // became 1 and `"2"` became 2 — reject malformed values up-front
    // instead (chatgpt-codex-connector P2: 'Reject invalid context
    // line counts').
    if (
      query.contextLines !== undefined &&
      (typeof query.contextLines !== "number" ||
        !Number.isInteger(query.contextLines) ||
        query.contextLines < 0)
    ) {
      return { ok: false, code: "invalid_query" };
    }
    const root = typeof query.repoRoot === "string" && query.repoRoot.length > 0
      ? query.repoRoot
      : this.repoRoot;
    if (root === undefined) {
      return { ok: false, code: "repo_root_unset" };
    }
    // Wrap the DB lookup in try/catch (cursor Bugbot: 'SQLite errors
    // escape read APIs'). The file read below has its own catch.
    let rows: {
      id: string;
      qualified_name: string;
      file_path: string;
      span_start: number;
      span_end: number;
      lang: string;
    }[];
    try {
      rows = expectRows<{
        id: string;
        qualified_name: string;
        file_path: string;
        span_start: number;
        span_end: number;
        lang: string;
      }>(
        this.db
          .prepare(
            `SELECT n.id, n.qualified_name, n.span_start, n.span_end, n.lang,
                    f.path AS file_path
               FROM nodes n JOIN files f ON n.file_id = f.id
              WHERE ${hasNodeId ? "n.id = ?" : "n.qualified_name = ?"}`,
          )
          .all(hasNodeId ? query.nodeId : query.qualifiedName),
        ["id", "qualified_name", "file_path", "span_start", "span_end", "lang"],
      );
    } catch (error) {
      logWriteFailure(error);
      return classifyReadError(error) as unknown as SnippetResult;
    }
    if (rows.length === 0) return { ok: false, code: "not_found" };
    if (rows.length > 1) return { ok: false, code: "ambiguous_name" };
    const node = rows[0]!;
    const absolutePath = path.resolve(root, node.file_path);
    // Read the file from disk and slice the span. readFile is the
    // single fs call — no streaming, no mmap, just one allocation per
    // request. The store caches nothing; the caller may.
    let bytes: Buffer;
    try {
      bytes = await readFile(absolutePath);
    } catch (error) {
      logWriteFailure(error);
      return { ok: false, code: "read_failed" };
    }
    // Half-open [startByte, endByte). Guard endByte ≤ buffer.length
    // so a stale span after a file edit does not throw OutOfRange.
    const start = Math.max(0, node.span_start);
    const end = Math.min(bytes.length, node.span_end);
    if (start > end) {
      // The file shrank below the span — return an empty snippet
      // rather than throw; the caller can decide whether to re-ingest.
      return {
        ok: true,
        qualifiedName: node.qualified_name,
        filePath: node.file_path,
        absolutePath,
        startByte: node.span_start,
        endByte: node.span_end,
        text: "",
        lang: node.lang,
      };
    }
    let text = bytes.subarray(start, end).toString("utf8");
    // Optional context lines (line-aligned expansion). contextLines
    // is bounded to a sane cap so a caller cannot ask for megabytes
    // of surrounding code.
    const ctx = query.contextLines ?? 0;
    if (ctx > 0) {
      const MAX_CTX = 200;
      const contextLines = Math.min(Math.max(0, Math.floor(ctx)), MAX_CTX);
      if (contextLines > 0) {
        // Line-aligned expansion. For contextLines=N we include the N
        // full lines preceding the span's line and the N full lines
        // following the span's line. Walk backward from `start`,
        // skipping (contextLines) line-end newlines, then walk to the
        // start of the (contextLines+1)th line back; walk forward
        // from `end` symmetrically.
        //
        // The first newline we hit going backward is the END of the
        // span's own line, NOT a context line — so we need to count
        // `contextLines` newlines after that boundary to find where
        // the context region begins. Concrete example for N=1:
        //   "...line one\nline two\n..."  with span starting at "line two"
        //   walking back from start of "line two", we hit \n (end of
        //   "line one"). The line "line one" IS the context. Its start
        //   is one further newline back (or buffer start).
        let lineStart = start;
        // Move lineStart to the beginning of the line containing `start`.
        while (lineStart > 0 && bytes[lineStart - 1] !== 0x0a) {
          lineStart -= 1;
        }
        // For each of contextLines, jump past the newline at
        // lineStart - 1 and walk to the previous line's start.
        for (let i = 0; i < contextLines && lineStart > 0; i += 1) {
          // Step past the newline ending the prior line.
          lineStart -= 1;
          // Walk to the start of THAT line.
          while (lineStart > 0 && bytes[lineStart - 1] !== 0x0a) {
            lineStart -= 1;
          }
        }
        let lineEnd = end;
        // Move lineEnd to the end of the line containing `end`
        // (inclusive of the trailing newline if present).
        while (lineEnd < bytes.length && bytes[lineEnd] !== 0x0a) {
          lineEnd += 1;
        }
        if (lineEnd < bytes.length && bytes[lineEnd] === 0x0a) {
          lineEnd += 1;
        }
        // For each of contextLines, advance past one more line.
        for (let i = 0; i < contextLines && lineEnd < bytes.length; i += 1) {
          while (lineEnd < bytes.length && bytes[lineEnd] !== 0x0a) {
            lineEnd += 1;
          }
          if (lineEnd < bytes.length && bytes[lineEnd] === 0x0a) {
            lineEnd += 1;
          }
        }
        text = bytes.subarray(lineStart, lineEnd).toString("utf8");
      }
    }
    return {
      ok: true,
      qualifiedName: node.qualified_name,
      filePath: node.file_path,
      absolutePath,
      startByte: node.span_start,
      endByte: node.span_end,
      text,
      lang: node.lang,
    };
  }

  // ──────────────────────────────────────────────────────────────────────
  // Semantic layer (issue #1556): symbol_vectors table read/write.
  // The db is private; these methods are the ONLY surface the semantic
  // indexer/query path uses. Vectors are float32 BLOBs; content_hash is
  // the canonical-text hash (rule 37 — the cache invalidation key).
  // ──────────────────────────────────────────────────────────────────────

  /**
   * Upsert one symbol vector. Idempotent on (node_id, model_id). The
   * caller (the semantic indexer) has ALREADY decided to re-embed (the
   * content_hash differs from the cached row); this method just persists.
   */
  async writeSymbolVector(input: {
    readonly nodeId: string;
    readonly modelId: string;
    readonly contentHash: string;
    readonly dims: number;
    readonly vector: Float32Array;
  }): Promise<boolean> {
    // Honor the closing flag (not just closed) and serialize via the write
    // queue, matching upsertFileBatch / upsertEdges / clearSemanticSimilarToEdges
    // — otherwise concurrent graph ingestion can interleave a vector upsert
    // with a transactional node delete (cursor Bugbot: 'Vector writes ignore
    // closing flag' + 'Vector writes bypass write queue').
    if (this.closed || this.closing) return false;
    const buf = Buffer.from(input.vector.buffer, input.vector.byteOffset, input.vector.byteLength);
    await this.queue.schedule(async () => {
      this.db
        .prepare(
          `INSERT INTO symbol_vectors (node_id, model_id, content_hash, dims, vector)
             VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(node_id, model_id) DO UPDATE SET
             content_hash = excluded.content_hash,
             dims = excluded.dims,
             vector = excluded.vector`,
        )
        .run(input.nodeId, input.modelId, input.contentHash, input.dims, buf);
    });
    return true;
  }

  /**
   * Read one vector row by (node_id, model_id). Returns null when absent.
   * Used by the indexer's cache-check path (skip re-embed when content_hash
   * matches) and by the cache-hit test.
   */
  readSymbolVector(
    nodeId: string,
    modelId: string,
  ): { readonly contentHash: string; readonly dims: number; readonly vector: Float32Array } | null {
    if (this.closed) return null;
    const row = expectRow<{ content_hash: string; dims: number; vector: Uint8Array }>(
      this.db
        .prepare(
          `SELECT content_hash, dims, vector FROM symbol_vectors
            WHERE node_id = ? AND model_id = ?`,
        )
        .get(nodeId, modelId),
      ["content_hash", "dims", "vector"],
    );
    if (!row) return null;
    return {
      contentHash: row.content_hash,
      dims: row.dims,
      vector: new Float32Array(row.vector.buffer, row.vector.byteOffset, row.vector.byteLength / 4),
    };
  }

  /**
   * Read every vector row for a given model. Used by brute-force cosine
   * retrieval (SIMILAR_TO confirmation + semantic_query). Returns node
   * metadata alongside the vector so callers can hydrate hits without a
   * second round-trip.
   */
  readAllSymbolVectors(modelId: string): readonly {
    readonly nodeId: string;
    readonly qualifiedName: string;
    readonly filePath: string;
    readonly kind: string;
    readonly dims: number;
    readonly vector: Float32Array;
    readonly contentHash: string;
  }[] {
    if (this.closed) return [];
    const rows = expectRows<{
      node_id: string;
      qualified_name: string;
      label: string;
      file_path: string;
      dims: number;
      vector: Uint8Array;
      content_hash: string;
    }>(
      this.db
        .prepare(
          `SELECT sv.node_id, sv.dims, sv.vector, sv.content_hash,
                  n.qualified_name, n.label, f.path AS file_path
             FROM symbol_vectors sv
             JOIN nodes n ON sv.node_id = n.id
             JOIN files f ON n.file_id = f.id
            WHERE sv.model_id = ?`,
        )
        .all(modelId),
      ["node_id", "qualified_name", "label", "file_path", "dims", "vector", "content_hash"],
    );
    return rows.map((r) => ({
      nodeId: r.node_id,
      qualifiedName: r.qualified_name,
      filePath: r.file_path,
      kind: r.label,
      dims: r.dims,
      contentHash: r.content_hash,
      vector: new Float32Array(r.vector.buffer, r.vector.byteOffset, r.vector.byteLength / 4),
    }));
  }

  /**
   * Delete vector rows for a set of node ids (all models). Used by the
   * cache-invalidation path when a symbol's canonical text changed AND
   * it could not be re-embedded (provider gone) — the stale vector must
   * not survive to pollute cosine retrieval. Cascades via the schema's
   * ON DELETE CASCADE on nodes(id) when a node is pruned, so this method
   * is only for the targeted-invalidation path.
   */
  async deleteSymbolVectors(nodeIds: readonly string[]): Promise<void> {
    // Same closing-flag + write-queue discipline as writeSymbolVector
    // (cursor Bugbot: 'Vector writes ignore closing flag' + 'Vector writes
    // bypass write queue').
    if (this.closed || this.closing || nodeIds.length === 0) return;
    await this.queue.schedule(async () => {
      this.runChunkedDelete(
        "DELETE FROM symbol_vectors WHERE node_id IN (%PH%)",
        nodeIds,
      );
    });
  }

  /**
   * Remove every SIMILAR_TO edge written by the semantic similarity
   * pipeline (type 'SIMILAR_TO', provenance 'semantic'). The pipeline
   * recomputes the FULL near-clone edge set on each run, so callers MUST
   * clear the prior set before upserting the new one — otherwise an edge
   * between two symbols that stopped being similar survives indefinitely
   * and graph traversal keeps reporting a stale clone relationship
   * (chatgpt-codex-connector P2: 'Replace old SIMILAR_TO edges on
   * recompute'). Scoped to provenance 'semantic' so non-semantic edges
   * are untouched. Serialized via the write queue so it cannot interleave
   * a concurrent file-batch edge upsert.
   */
  async clearSemanticSimilarToEdges(): Promise<void> {
    if (this.closed || this.closing) return;
    await this.queue.schedule(async () => {
      this.db
        .prepare("DELETE FROM edges WHERE type = ? AND provenance = ?")
        .run("SIMILAR_TO", "semantic");
    });
  }

  /**
   * Read every node with its file path + span, for the semantic indexer.
   * The indexer reads source text from disk (via repoRoot) and builds
   * canonical text per node. Returns kind + qualified_name + span so the
   * indexer can reconstruct the SymbolIR-equivalent without a second
   * join. Ordered by qualified_name for deterministic processing order.
   */
  readNodesForSemantic(): readonly {
    readonly nodeId: string;
    readonly qualifiedName: string;
    readonly kind: string;
    readonly filePath: string;
    readonly startByte: number;
    readonly endByte: number;
    readonly lang: string;
  }[] {
    if (this.closed) return [];
    const rows = expectRows<{
      id: string;
      qualified_name: string;
      label: string;
      file_path: string;
      span_start: number;
      span_end: number;
      lang: string;
    }>(
      this.db
        .prepare(
          `SELECT n.id, n.qualified_name, n.label, n.span_start, n.span_end, n.lang,
                  f.path AS file_path
             FROM nodes n JOIN files f ON n.file_id = f.id
            ORDER BY n.qualified_name ASC`,
        )
        .all(),
      ["id", "qualified_name", "label", "file_path", "span_start", "span_end", "lang"],
    );
    return rows.map((r) => ({
      nodeId: r.id,
      qualifiedName: r.qualified_name,
      kind: r.label,
      filePath: r.file_path,
      startByte: r.span_start,
      endByte: r.span_end,
      lang: r.lang,
    }));
  }

  /**
   * Read the callers and callees of a node by qualified name, for
   * semantic_query hydration (the issue: hydrate each hit with graph
   * context — defining file, direct callers/callees).
   */
  readNeighbors(
    qualifiedName: string,
  ): { readonly callers: readonly string[]; readonly callees: readonly string[] } {
    if (this.closed) return { callers: [], callees: [] };
    // Resolve the node id first.
    const nodeRow = expectRow<{ id: string }>(
      this.db
        .prepare("SELECT id FROM nodes WHERE qualified_name = ?")
        .get(qualifiedName),
      ["id"],
    );
    if (!nodeRow) return { callers: [], callees: [] };
    const id = nodeRow.id;
    // Callers: nodes that CALL this node (edges where dst = id, type CALLS).
    const callerRows = expectRows<{ qualified_name: string }>(
      this.db
        .prepare(
          `SELECT n.qualified_name FROM edges e
             JOIN nodes n ON e.src = n.id
            WHERE e.dst = ? AND e.type = 'CALLS'`,
        )
        .all(id),
      ["qualified_name"],
    );
    // Callees: nodes this node CALLS (edges where src = id, type CALLS).
    const calleeRows = expectRows<{ qualified_name: string }>(
      this.db
        .prepare(
          `SELECT n.qualified_name FROM edges e
             JOIN nodes n ON e.dst = n.id
            WHERE e.src = ? AND e.type = 'CALLS'`,
        )
        .all(id),
      ["qualified_name"],
    );
    return {
      callers: callerRows.map((r) => r.qualified_name),
      callees: calleeRows.map((r) => r.qualified_name),
    };
  }

  /**
   * Read callers/callees by node id directly (avoids the qualified-name
   * ambiguity when duplicate names exist across files). Used by
   * semantic_query hydration (chatgpt-codex-connector: 'Use the hit node
   * id when hydrating neighbors').
   */
  readNeighborsByNodeId(
    nodeId: string,
  ): { readonly callers: readonly string[]; readonly callees: readonly string[] } {
    if (this.closed) return { callers: [], callees: [] };
    const callerRows = expectRows<{ qualified_name: string }>(
      this.db
        .prepare(
          `SELECT n.qualified_name FROM edges e
             JOIN nodes n ON e.src = n.id
            WHERE e.dst = ? AND e.type = 'CALLS'`,
        )
        .all(nodeId),
      ["qualified_name"],
    );
    const calleeRows = expectRows<{ qualified_name: string }>(
      this.db
        .prepare(
          `SELECT n.qualified_name FROM edges e
             JOIN nodes n ON e.dst = n.id
            WHERE e.src = ? AND e.type = 'CALLS'`,
        )
        .all(nodeId),
      ["qualified_name"],
    );
    return {
      callers: callerRows.map((r) => r.qualified_name),
      callees: calleeRows.map((r) => r.qualified_name),
    };
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Node id hashing — sorted key material (rule 23/38).
// ──────────────────────────────────────────────────────────────────────────

export interface NodeIdInput {
  qualifiedName: string;
  filePath: string;
  label: string;
}

/**
 * sha256 over the sorted key material. The exact form MUST match between
 * ingest and lookup; tests assert this. Sort is stable (string compare),
 * no separators needed — the three fields are concatenated with a length
 * prefix so collision space is unambiguous.
 */
export function nodeIdFor(input: NodeIdInput): string {
  const fields = [
    ["qualifiedName", input.qualifiedName],
    ["filePath", input.filePath],
    ["label", input.label],
  ]
    .map(([k, v]) => [k as string, String(v)] as [string, string])
    .sort(([a], [b]) => a.localeCompare(b));
  const hash = createHash("sha256");
  for (const [k, v] of fields) {
    hash.update(`${k.length}:${k}:`);
    hash.update(`${v.length}:${v}:`);
  }
  return hash.digest("hex");
}

/**
 * Resolve a qualified_name to its deterministic node id.
 *
 * `inBatch` is the per-file map built from `nodes` rows owned by the
 * edge's source file (the FileIR.path the edge came in on). The
 * DB fallback is for cross-file edges whose src/dst lives in a
 * DIFFERENT file (in the same batch or a prior batch). Node
 * identity is the full `(qualifiedName, filePath, label)` triple
 * (see `nodeIdFor`), so a qualified_name match alone is ambiguous
 * when two files declare the same symbol. The fallback uses
 * `ORDER BY file_id, id` to pick deterministically, but only when
 * exactly one row matches — multiple matches return `undefined`
 * and the edge is dropped at insert time (per the dangling-edge
 * policy; the caller is responsible for the batch's canonical
 * file set). This is the conservative call for a write pipeline
 * whose caller knows the canonical file set on each batch
 * (rule 11, 40 — chatgpt-codex-connector P2 + cursor Bugbot
 * #1380bc89).
 */
function resolveNodeId(
  qualifiedName: string,
  inBatch: Map<string, string>,
  db: BetterSqlite3Database,
): string | undefined {
  const local = inBatch.get(qualifiedName);
  if (local) return local;
  const rows = expectRows<{ id: string; file_id: number }>(
    db
      .prepare(
        "SELECT id, file_id FROM nodes WHERE qualified_name = ? ORDER BY file_id, id",
      )
      .all(qualifiedName),
    ["id", "file_id"],
  );
  if (rows.length === 0) return undefined;
  if (rows.length > 1) {
    // Ambiguous — drop the edge rather than attach it to the wrong
    // node. Callers needing disambiguation should include the target
    // file in the same batch (the per-file map then wins) or extend
    // EdgeIR with file identity material.
    return undefined;
  }
  return rows[0]?.id;
}

/**
 * Resolve a dst node constrained to a path hint (issue #1894 review): the
 * node's file path must be the hint verbatim, `<hint>.<ext>`, or
 * `<hint>/index.<ext>`. `substr` prefix comparisons (not LIKE) so hint
 * characters are never pattern metacharacters. Zero or multiple matches
 * return `undefined` — the edge is dropped rather than guessed (same
 * conservative policy as {@link resolveNodeId}).
 */
function resolveNodeIdWithPathHint(
  qualifiedName: string,
  pathHint: string,
  db: BetterSqlite3Database,
): string | undefined {
  const rows = expectRows<{ id: string }>(
    db
      .prepare(
        `SELECT n.id FROM nodes n JOIN files f ON n.file_id = f.id
          WHERE n.qualified_name = ?
            AND (f.path = ?
              OR substr(f.path, 1, ?) = ?
              OR substr(f.path, 1, ?) = ?)
          ORDER BY f.path, n.id`,
      )
      .all(
        qualifiedName,
        pathHint,
        pathHint.length + 1,
        `${pathHint}.`,
        pathHint.length + 7,
        `${pathHint}/index.`,
      ),
    ["id"],
  );
  if (rows.length !== 1) return undefined;
  return rows[0]?.id;
}

/**
 * Resolve a standalone-edge endpoint by content-derived node id (issue #1677).
 *
 * `nodes.id` is the PRIMARY KEY, so the lookup is unique and unambiguous —
 * this is what lets a SIMILAR_TO edge between two same-qualified-name symbols
 * resolve where the qualified-name fallback would be ambiguous. The supplied
 * `qualifiedName` is validated against the row: a stale or mismatched
 * id+qname pair (stale body map, custom integration) returns `undefined` so
 * the caller skips the edge like a dangling endpoint instead of silently
 * writing an edge from the wrong node (chatgpt-codex-connector P2 — id/qname
 * consistency at the store boundary). `stmt` is the caller's prepared
 * `SELECT qualified_name FROM nodes WHERE id = ?`.
 */
function resolveByNodeId(
  stmt: { get(...args: unknown[]): unknown },
  nodeId: string,
  qualifiedName: string,
): string | undefined {
  const row = expectRow<{ qualified_name: string }>(stmt.get(nodeId), ["qualified_name"]);
  if (!row) return undefined;
  if (row.qualified_name !== qualifiedName) return undefined;
  return nodeId;
}
// ──────────────────────────────────────────────────────────────────────────
// Error classification — tag SQLITE_BUSY / SQLITE_CORRUPT into the failure
// shape (rule 34). better-sqlite3 surfaces them as `SqliteError` with `.code`.
// ──────────────────────────────────────────────────────────────────────────

function classifyError(error: unknown): GraphStoreFailure {
  const code = hasErrorCode(error) ? error.code : "";
  if (code === "SQLITE_BUSY" || code === "SQLITE_LOCKED") {
    return { ok: false, code: "db_locked" };
  }
  const msg = error instanceof Error ? error.message : String(error ?? "");
  if (
    code === "SQLITE_CORRUPT" ||
    code === "SQLITE_NOTADB" ||
    msg.includes("database disk image is malformed")
  ) {
    return { ok: false, code: "db_corrupt" };
  }
  // Non-SQLite errors are NOT disk corruption — they are validation
  // failures (e.g. invalid edge provenance) or programming errors.
  // Conflating them with `db_corrupt` would tell the caller to stop
  // trusting the store for the wrong reason; re-throw so the caller
  // sees the real error (chatgpt-codex-connector P2).
  throw error instanceof Error ? error : new Error(String(error ?? ""));
}

/**
 * Read-path error classifier. Unlike {@link classifyError} (write
 * path), this is TOTAL — it never throws. Every unexpected error
 * maps to a tagged `db_error` failure so the read APIs
 * (`traverse`/`searchGraph`/`schemaStats`/`deadCode`/`snippetFor`)
 * honor their advertised discriminated-union contract: a caller that
 * exhaustively switches on `result.code` never observes a throw
 * (cursor Bugbot: 'Read APIs rethrow SQLite errors';
 * chatgpt-codex-connector P2: 'Return tagged failures from read
 * queries'). The write path keeps {@link classifyError} because its
 * validation throws (duplicate path, bad confidence, non-array
 * symbols) are intentional fail-loud contract violations that
 * callers and tests catch as rejections.
 *
 * `db_error` is deliberately distinct from `db_corrupt` so a generic
 * failure does not signal the caller to stop trusting the DB
 * (chatgpt-codex-connector P2: do not conflate unexpected errors
 * with corruption).
 */
function classifyReadError(error: unknown): GraphStoreFailure {
  try {
    return classifyError(error);
  } catch {
    return { ok: false, code: "db_error" };
  }
}

function hasErrorCode(value: unknown): value is { code: string } {
  if (typeof value !== "object" || value === null) return false;
  if (!("code" in value)) return false;
  const codeValue: unknown = (value as Record<string, unknown>)["code"];
  return typeof codeValue === "string";
}

/**
 * Internal log for write failures. Never exposed to callers — the
 * public failure union only carries the code, so absolute paths
 * from `error.message` cannot leak into agents, HTTP responses, or
 * MCP tool results (rule 11).
 */
function logWriteFailure(error: unknown): void {
  // eslint-disable-next-line no-console
  console.error(
    "[coding-graph] write failure:",
    error instanceof Error ? error.message : String(error ?? ""),
  );
}

/**
 * Reject non-canonical repo-relative paths at the store boundary. The
 * FileIR contract requires forward-slash, repo-relative paths; a caller
 * that emits `./src/a.ts`, backslashes, or an absolute path would hash
 * to a distinct files row + node id and leave duplicate/stale symbols a
 * later canonical ingest cannot match or prune
 * (chatgpt-codex-connector P2: 'Reject non-canonical file paths before
 * persisting').
 */
function assertCanonicalFilePath(filePath: unknown): void {
  if (typeof filePath !== "string" || filePath.length === 0) {
    throw new Error(
      `graph-store: file path must be a non-empty string; received ${
        filePath === null ? "null" : typeof filePath
      }`,
    );
  }
  // Windows separators — the contract mandates forward slashes.
  if (filePath.includes("\\")) {
    throw new Error(
      `graph-store: file path '${filePath}' must use forward slashes (backslash rejected — FileIR contract requires repo-relative POSIX paths)`,
    );
  }
  // Absolute POSIX path or a Windows drive root.
  if (filePath.startsWith("/") || /^[A-Za-z]:[\\/]/.test(filePath)) {
    throw new Error(
      `graph-store: file path '${filePath}' must be repo-relative (absolute path rejected — FileIR contract requires repo-relative forward-slash paths)`,
    );
  }
  // `.` / `..` segments alias a canonical path (`./src/a.ts` vs
  // `src/a.ts`, or `src/../a.ts`) and would hash to a distinct files
  // row + node id, leaving duplicates the canonical ingest cannot
  // match or prune. Segment-based check avoids false positives on
  // names like `a..b.ts`.
  if (filePath.split("/").some((segment) => segment === "." || segment === "..")) {
    throw new Error(
      `graph-store: file path '${filePath}' must be canonical (no '.' or '..' segments — FileIR contract requires repo-relative forward-slash paths)`,
    );
  }
}

/**
 * Reject malformed symbol spans before they are bound into span_start /
 * span_end. The FileIR contract documents half-open byte spans
 * `[startByte, endByte)`; a buggy parser or JSON caller can emit
 * startByte > endByte or non-integer values, and PR2 snippet/search
 * consumers will trust the offsets as-is, producing invalid source
 * slices. Reject at the boundary rather than persisting corrupt metadata
 * (chatgpt-codex-connector P2: 'Reject invalid symbol spans before
 * storing nodes'). Narrowing is done with typeof/in guards (no casts) so
 * the compiler verifies every access.
 */
function assertValidSymbolSpan(sym: unknown, filePath: string): void {
  if (typeof sym !== "object" || sym === null) {
    throw new Error(
      `graph-store: file '${filePath}' has a non-object symbol; received ${
        sym === null ? "null" : typeof sym
      }`,
    );
  }
  if (!("span" in sym)) {
    throw new Error(
      `graph-store: file '${filePath}' has a symbol with no span (FileIR contract requires startByte/endByte)`,
    );
  }
  const span: unknown = sym.span;
  if (
    typeof span !== "object" ||
    span === null ||
    !("startByte" in span) ||
    !("endByte" in span)
  ) {
    throw new Error(
      `graph-store: file '${filePath}' has a symbol with a malformed span — expected { startByte, endByte }; received ${JSON.stringify(span)}`,
    );
  }
  const startByte: unknown = span.startByte;
  const endByte: unknown = span.endByte;
  // typeof narrows unknown → number; Number.isInteger then rejects
  // NaN/Infinity, which typeof === "number" admits.
  if (
    typeof startByte !== "number" ||
    typeof endByte !== "number" ||
    !Number.isInteger(startByte) ||
    !Number.isInteger(endByte)
  ) {
    throw new Error(
      `graph-store: file '${filePath}' has a symbol with a non-integer span [${JSON.stringify(startByte)}, ${JSON.stringify(endByte)}) — startByte and endByte must be finite integers`,
    );
  }
  if (startByte < 0 || endByte < 0) {
    throw new Error(
      `graph-store: file '${filePath}' has a symbol with a negative span [${startByte}, ${endByte}) — byte offsets must be non-negative`,
    );
  }
  if (startByte > endByte) {
    throw new Error(
      `graph-store: file '${filePath}' has a symbol with startByte > endByte [${startByte}, ${endByte}) — half-open spans require startByte <= endByte`,
    );
  }
}
