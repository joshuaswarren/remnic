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
   * hint (`<hint>`, `<hint>.<ext>`, `<hint>/index.<ext>`, or
   * `<hint>/__init__.<ext>`) — never via
   * the global bare-name fallback — so `import { foo } from "./missing"`
   * can never bind an unrelated same-named symbol elsewhere in the repo.
   */
  readonly dstPathHint?: string;
  /**
   * Language of the importing file (issue #1894 round 13): constrains the
   * hinted dst's file extension to that language's module-resolution set
   * so a polyglot repo cannot cross-bind a JS import to a same-named .py
   * file.
   */
  readonly dstImporterLanguage?: string;
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
    this.tail = next.catch(() => undefined);
    return next as Promise<T>;
  }

  /** Test seam: wait until the queue has drained. */
  async drain(): Promise<void> {
    await this.tail;
  }
}

// ──────────────────────────────────────────────────────────────────────────
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
  private closePromise: Promise<void> | undefined;

  private constructor(db: BetterSqlite3Database, repoRoot: string | undefined) {
    this.db = db;
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
    if (repoRoot !== undefined && !path.isAbsolute(repoRoot)) {
      throw new Error(
        `graph-store: repoRoot must be absolute when provided; received ${JSON.stringify(repoRoot)}`,
      );
    }
    await mkdir(path.dirname(dbPath), { recursive: true });
    const db = openBetterSqlite3(dbPath);
    db.pragma("journal_mode = WAL");
    db.pragma("busy_timeout = 5000");
    db.pragma("synchronous = NORMAL");
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

  /**
   * Retire stale LSP-provenance edges for a file (issue #1895).
   *
   * The LSP resolution pass re-derives edges from the CURRENT source on each
   * run. After writing the new `lsp` edges for a file, this method deletes
   * prior `lsp`-provenance edges owned by that file's nodes whose
   * `(src, dst, type)` key is NOT in the asserted set. This is the LSP
   * layer's side of the provenance-lifecycle contract: each layer owns its
   * own stale-edge retirement (#1894 established that reindex's heuristic
   * scope never touches `lsp` rows).
   *
   * Heuristic, trace, and semantic edges are never touched.
   *
   * @returns the number of retired edges.
   */
  reconcileLspEdges(
    filePath: string,
    assertedEdges: ReadonlyArray<{
      srcQualifiedName: string;
      dstQualifiedName: string;
      type: string;
    }>,
  ): number {
    if (this.closed) return 0;
    try {
      const fileRow = expectRow<{ id: number }>(
        this.db.prepare("SELECT id FROM files WHERE path = ?").get(filePath),
        ["id"],
      );
      if (!fileRow) return 0;
      const nodes = expectRows<{ id: string; qualified_name: string }>(
        this.db
          .prepare("SELECT id, qualified_name FROM nodes WHERE file_id = ?")
          .all(fileRow.id),
        ["id", "qualified_name"],
      );
      if (nodes.length === 0) return 0;

      const nameCount = new Map<string, number>();
      for (const n of nodes) nameCount.set(n.qualified_name, (nameCount.get(n.qualified_name) ?? 0) + 1);
      const srcMap = new Map<string, string>();
      for (const n of nodes) {
        if (nameCount.get(n.qualified_name) === 1) srcMap.set(n.qualified_name, n.id);
      }
      const nodeIds = nodes.map((n) => n.id);

      const assertedKeys = new Set<string>();
      for (const e of assertedEdges) {
        const srcId = srcMap.get(e.srcQualifiedName);
        if (!srcId) continue;
        const dstId = resolveNodeId(e.dstQualifiedName, new Map(), this.db);
        if (!dstId) continue;
        assertedKeys.add(`${srcId}\u0000${dstId}\u0000${e.type}`);
      }

      const placeholders = nodeIds.map(() => "?").join(", ");
      const priorEdges = expectRows<{ src: string; dst: string; type: string }>(
        this.db
          .prepare(
            `SELECT src, dst, type FROM edges
              WHERE src IN (${placeholders}) AND provenance = 'lsp'`,
          )
          .all(...nodeIds),
        ["src", "dst", "type"],
      );

      let deleted = 0;
      const toDelete: Array<[string, string, string]> = [];
      for (const e of priorEdges) {
        const key = `${e.src}\u0000${e.dst}\u0000${e.type}`;
        if (!assertedKeys.has(key)) toDelete.push([e.src, e.dst, e.type]);
      }
      if (toDelete.length > 0) {
        const SQLITE_VARIABLE_LIMIT = 32_766;
        const PARAMS_PER_TUPLE = 3;
        const MAX_TUPLES = Math.floor(SQLITE_VARIABLE_LIMIT / PARAMS_PER_TUPLE);
        for (let i = 0; i < toDelete.length; i += MAX_TUPLES) {
          const chunk = toDelete.slice(i, i + MAX_TUPLES);
          const ph = chunk.map(() => "(?, ?, ?)").join(", ");
          const r = this.db
            .prepare(`DELETE FROM edges WHERE (src, dst, type) IN (${ph})`)
            .run(...chunk.flat());
          deleted += r.changes;
        }
      }
      return deleted;
    } catch (error) {
      logWriteFailure(error);
      return 0;
    }
  }

  /** Wait for pending writes to drain — test seam. */
  async drain(): Promise<void> {
    await this.queue.drain();
  }
  // ──────────────────────────────────────────────────────────────────────
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
    if (this.closing) return this.closePromise;
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


  private async runUpsert(
    files: StoreFileIR[],
    deletePaths: readonly string[] = [],
  ): Promise<UpsertBatchResult> {
    const seenPaths = new Set<string>();
    for (const ir of files) {
      assertCanonicalFilePath(ir.path);
      if (seenPaths.has(ir.path)) {
        throw new Error(
          `graph-store: duplicate path '${ir.path}' in batch — each FileIR must have a unique path`,
        );
      }
      seenPaths.add(ir.path);
      const symbolsField = ir.symbols as unknown;
      if (!Array.isArray(symbolsField)) {
        throw new Error(
          `graph-store: file '${ir.path}' symbols must be an array (FileIR contract requires it); received ${
            symbolsField === null ? "null" : typeof symbolsField
          } — refusing to ingest to avoid wiping existing nodes`,
        );
      }
      for (const sym of symbolsField) {
        assertValidSymbolSpan(sym, ir.path);
      }
      if (ir.exports != null) {
        if (!Array.isArray(ir.exports)) {
          throw new Error(
            `graph-store: file '${ir.path}' exports must be an array when present; received ${
              ir.exports === null ? "null" : typeof ir.exports
            } — refusing to ingest to avoid wiping existing flags`,
          );
        }
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

      const tx = this.db.transaction((irs: StoreFileIR[]) => {
        if (deletePaths.length > 0) {
          for (let i = 0; i < deletePaths.length; i += SQLITE_VARIABLE_LIMIT) {
            const chunk = deletePaths.slice(i, i + SQLITE_VARIABLE_LIMIT);
            const placeholders = chunk.map(() => "?").join(", ");
            this.db
              .prepare("DELETE FROM files WHERE path IN (%PH%)".replace("%PH%", placeholders))
              .run(...chunk);
          }
        }
        const pending: { result: UpsertResult; prunedNodeIds: string[] }[] = [];
        for (const ir of irs) {
          const { result, prunedNodeIds } = this.upsertFileNodes(ir);
          pending.push({ result, prunedNodeIds });
          results.push(result);
        }
        const batchPrunedIds: string[] = [];
        for (const { prunedNodeIds } of pending) {
          for (const id of prunedNodeIds) batchPrunedIds.push(id);
        }
        for (const { result, prunedNodeIds } of pending) {
          this.pruneFileNodes(result, prunedNodeIds, batchPrunedIds);
        }
        for (let i = 0; i < irs.length; i += 1) {
          const ir = irs[i]!;
          const result = results[i]!;
          this.upsertFileEdges(ir, result);
        }
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
        continue;
      }
      const ftsRowid = ftsRowidForNodeId(id);
      deleteFtsByRowid.run(ftsRowid);
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
    this.db.exec("DELETE FROM nodes WHERE id IN (SELECT id FROM _pruned_ids)");
    clearPruned.run();
    clearBatch.run();
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
    if (ir.edges == null) {
      return;
    }
    const qualifiedNameToId = new Map<string, string>();
    const ownSymbols = expectRows<{ id: string; qualified_name: string }>(
      this.db
        .prepare("SELECT id, qualified_name FROM nodes WHERE file_id = ?")
        .all(result.fileId),
      ["id", "qualified_name"],
    );
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
    const seenKeys: string[] = [];
    const keyToEdge = new Map<string, EdgeIR>();
    for (const edge of ir.edges ?? []) {
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
      const srcId = qualifiedNameToId.get(edge.srcQualifiedName);
      if (!srcId) continue;
      const dstId = edge.dstPathHint
        ? resolveNodeIdWithPathHint(
            edge.dstQualifiedName,
            edge.dstPathHint,
            this.db,
            edge.dstImporterLanguage,
          )
        : resolveNodeId(edge.dstQualifiedName, qualifiedNameToId, this.db);
      if (!dstId) continue;
      const key = `${srcId}\u0000${dstId}\u0000${edge.type}`;
      assertedKeys.add(key);
      seenKeys.push(key);
      if (!keyToEdge.has(key)) {
        keyToEdge.set(key, edge);
      }
    }

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
    const scoped =
      ir.assertedEdgeProvenances && ir.assertedEdgeProvenances.length > 0
        ? ir.assertedEdgeProvenances
        : undefined;
    for (const p of priorEdges) {
      const key = `${p.src}\u0000${p.dst}\u0000${p.type}`;
      priorByKey.set(key, { confidence: p.confidence, provenance: p.provenance });
      if (assertedKeys.has(key)) continue;
      if (scoped && !(scoped as readonly string[]).includes(p.provenance)) continue;
      staleSrcDstTypes.push({ src: p.src, dst: p.dst, type: p.type });
    }

    //
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
        continue;
      }
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
      this.runChunkedUpdate(
        `UPDATE node_attributes SET is_exported = 0 WHERE node_id IN (%PH%)`,
        ownNodeIds,
      );
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
    if (query == null || typeof query !== "object") {
      return { ok: false, code: "invalid_query" };
    }
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
    if (
      typeof query.start !== "string" ||
      query.start.length === 0
    ) {
      return { ok: false, code: "invalid_query" };
    }
    try {
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
      return { ok: false, code: "ambiguous_start" };
    }
    startId = rows[0]!.id;

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
    const minHops = query.minHops === undefined ? 1 : query.minHops;
    if (
      typeof minHops !== "number" ||
      !Number.isInteger(minHops) ||
      minHops < 1
    ) {
      return { ok: false, code: "invalid_query" };
    }
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

      if (query.maxHops === 0) {
        return { ok: true, hits: [], truncated: false };
      }

      const edgeTypes = query.edgeTypes ?? [];
      const typeClause =
        edgeTypes.length > 0
          ? `AND type IN (${edgeTypes.map(() => "?").join(", ")})`
          : "";
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
    if (query == null || typeof query !== "object") {
      return { ok: false, code: "invalid_query" };
    }
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
    const MAX_SEARCH_LIMIT = 1000;
    const limit = Math.min(rawLimit, MAX_SEARCH_LIMIT);

    if (
      (query.label !== undefined && typeof query.label !== "string") ||
      (query.namePattern !== undefined &&
        typeof query.namePattern !== "string") ||
      (query.filePattern !== undefined &&
        typeof query.filePattern !== "string")
    ) {
      return { ok: false, code: "invalid_query" };
    }

    try {
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
      const usageTypes = DEAD_CODE_EXCLUSION.INBOUND_USAGE_EDGE_TYPES;
      const typePlaceholders = usageTypes.map(() => "?").join(", ");
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
   * Find the innermost node whose span contains a byte offset in a file
   * (issue #1917). Used by the LSP resolution pass's NodeLocator to map
   * definition locations back to indexed nodes. Returns the node's
   * qualified name, or null when no node contains the offset.
   */
  findNodeBySpan(filePath: string, byteOffset: number): string | null {
    if (this.closed) return null;
    try {
      const rows = expectRows<{ qualified_name: string; size: number }>(
        this.db
          .prepare(
            `SELECT n.qualified_name, (n.span_end - n.span_start) AS size FROM nodes n
              JOIN files f ON n.file_id = f.id
              WHERE f.path = ? AND n.span_start <= ? AND n.span_end > ?
              ORDER BY size ASC
              LIMIT 2`,
          )
          .all(filePath, byteOffset, byteOffset),
        ["qualified_name", "size"],
      );
      if (rows.length === 0) return null;
      if (rows.length > 1 && rows[1] !== undefined && rows[0]!.size === rows[1].size) return null;
      const qualifiedName = rows[0]!.qualified_name;
      const dupRow = expectRow<{ n: number }>(
        this.db
          .prepare(`SELECT COUNT(*) AS n FROM nodes WHERE qualified_name = ?`)
          .get(qualifiedName),
        ["n"],
      );
      if (dupRow && dupRow.n > 1) return null;
      return qualifiedName;
    } catch {
      return null;
    }
  }

  /**
   * Callee NAMES already linked from a caller symbol via CALLS edges of a
   * given provenance (issue #1917 wiring). The LSP pass uses this to skip
   * call sites Phase A (provenance "heuristic") already resolved WITHOUT
   * also skipping sites whose only edge is a prior "lsp" edge — those must
   * be re-asserted each run or reconciliation would retire them.
   */
  resolvedCalleeNames(srcQualifiedName: string, provenance: string, filePath?: string): string[] {
    if (this.closed) return [];
    try {
      const fileClause = filePath !== undefined ? " AND f.path = ?" : "";
      const bind = filePath !== undefined ? [srcQualifiedName, provenance, filePath] : [srcQualifiedName, provenance];
      const rows = expectRows<{ name: string }>(
        this.db
          .prepare(
            `SELECT DISTINCT dn.name AS name FROM edges e
              JOIN nodes sn ON e.src = sn.id
              JOIN files f ON sn.file_id = f.id
              JOIN nodes dn ON e.dst = dn.id
              WHERE sn.qualified_name = ? AND e.type = 'CALLS' AND e.provenance = ?${fileClause}`,
          )
          .all(...bind),
        ["name"],
      );
      return rows.map((r) => r.name);
    } catch {
      return [];
    }
  }

  /**
   * Current CALLS edges of a given provenance owned by a caller symbol in
   * a file (#1923 review threads). The LSP pass uses this two ways:
   * provenance "lsp" lists a filtered caller's existing lsp edges, and
   * provenance "heuristic" lists its current Phase-A resolutions — an lsp
   * edge is preserved at reconcile time only when it duplicates a current
   * heuristic resolution (same dst), so removed member calls' edges retire
   * while a filtered bare call's covering edge survives.
   */
  callEdgesForCaller(
    srcQualifiedName: string,
    filePath: string,
    provenance: string,
  ): Array<{ srcQualifiedName: string; dstQualifiedName: string; dstName: string; type: string }> {
    if (this.closed) return [];
    try {
      const rows = expectRows<{ src_q: string; dst_q: string; dst_n: string; type: string }>(
        this.db
          .prepare(
            `SELECT sn.qualified_name AS src_q, dn.qualified_name AS dst_q, dn.name AS dst_n, e.type AS type FROM edges e
              JOIN nodes sn ON e.src = sn.id
              JOIN files f ON sn.file_id = f.id
              JOIN nodes dn ON e.dst = dn.id
              WHERE sn.qualified_name = ? AND f.path = ? AND e.provenance = ? AND e.type = 'CALLS'`,
          )
          .all(srcQualifiedName, filePath, provenance),
        ["src_q", "dst_q", "dst_n", "type"],
      );
      return rows.map((r) => ({
        srcQualifiedName: r.src_q,
        dstQualifiedName: r.dst_q,
        dstName: r.dst_n,
        type: r.type,
      }));
    } catch {
      return [];
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
    const hasNodeId = typeof query.nodeId === "string" && query.nodeId.length > 0;
    if (
      !hasNodeId &&
      (typeof query.qualifiedName !== "string" ||
        query.qualifiedName.length === 0)
    ) {
      return { ok: false, code: "invalid_query" };
    }
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
    let bytes: Buffer;
    try {
      bytes = await readFile(absolutePath);
    } catch (error) {
      logWriteFailure(error);
      return { ok: false, code: "read_failed" };
    }
    const start = Math.max(0, node.span_start);
    const end = Math.min(bytes.length, node.span_end);
    if (start > end) {
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
    const ctx = query.contextLines ?? 0;
    if (ctx > 0) {
      const MAX_CTX = 200;
      const contextLines = Math.min(Math.max(0, Math.floor(ctx)), MAX_CTX);
      if (contextLines > 0) {
        //
        let lineStart = start;
        while (lineStart > 0 && bytes[lineStart - 1] !== 0x0a) {
          lineStart -= 1;
        }
        for (let i = 0; i < contextLines && lineStart > 0; i += 1) {
          lineStart -= 1;
          while (lineStart > 0 && bytes[lineStart - 1] !== 0x0a) {
            lineStart -= 1;
          }
        }
        let lineEnd = end;
        while (lineEnd < bytes.length && bytes[lineEnd] !== 0x0a) {
          lineEnd += 1;
        }
        if (lineEnd < bytes.length && bytes[lineEnd] === 0x0a) {
          lineEnd += 1;
        }
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
    const nodeRow = expectRow<{ id: string }>(
      this.db
        .prepare("SELECT id FROM nodes WHERE qualified_name = ?")
        .get(qualifiedName),
      ["id"],
    );
    if (!nodeRow) return { callers: [], callees: [] };
    const id = nodeRow.id;
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
    return undefined;
  }
  return rows[0]?.id;
}

/**
 * Resolve a dst node constrained to a path hint (issue #1894 review): the
 * node's file path must be the hint verbatim, `<hint>.<ext>`,
 * `<hint>/index.<ext>`, or `<hint>/__init__.<ext>` (Python packages) —
 * where `<ext>` is a SINGLE dot-free extension segment, so `main.test.ts`
 * and `main.d.ts` never satisfy a `main` hint (they are not what a module
 * resolver would load for `./main`). Candidate rows are fetched by
 * qualified name and the path shape is checked in JS: no LIKE/GLOB, so
 * hint characters are never pattern metacharacters. Zero or multiple
 * matches return `undefined` — the edge is dropped rather than guessed
 * (same conservative policy as {@link resolveNodeId}).
 */
/**
 * Language families and the file extensions a module resolver in that
 * family accepts (issue #1894 round 13). A polyglot repo cannot let a
 * JS import bind a same-named .py file: constrain by importer language.
 */
const LANG_FAMILY_EXTENSIONS: Record<string, ReadonlySet<string>> = {
  js: new Set(["ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts"]),
  python: new Set(["py", "pyi"]),
  ruby: new Set(["rb"]),
  go: new Set(["go"]),
  rust: new Set(["rs"]),
  php: new Set(["php"]),
  java: new Set(["java"]),
  csharp: new Set(["cs"]),
  cpp: new Set(["cc", "cpp", "cxx", "c", "hh", "hpp", "hxx", "h"]),
  kotlin: new Set(["kt"]),
  swift: new Set(["swift"]),
  bash: new Set(["sh", "bash"]),
};

const IMPORTER_LANG_FAMILY: Record<string, keyof typeof LANG_FAMILY_EXTENSIONS> = {
  typescript: "js",
  tsx: "js",
  javascript: "js",
  python: "python",
  ruby: "ruby",
  go: "go",
  rust: "rust",
  php: "php",
  java: "java",
  csharp: "csharp",
  c: "cpp",
  cpp: "cpp",
  kotlin: "kotlin",
  swift: "swift",
  bash: "bash",
};

function resolveNodeIdWithPathHint(
  qualifiedName: string,
  pathHint: string,
  db: BetterSqlite3Database,
  importerLanguage?: string,
): string | undefined {
  const family = importerLanguage ? IMPORTER_LANG_FAMILY[importerLanguage] : undefined;
  const allowedExts = family ? LANG_FAMILY_EXTENSIONS[family] : undefined;
  const rows = expectRows<{ id: string; path: string }>(
    db
      .prepare(
        `SELECT n.id, f.path FROM nodes n JOIN files f ON n.file_id = f.id
          WHERE n.qualified_name = ?
          ORDER BY f.path, n.id`,
      )
      .all(qualifiedName),
    ["id", "path"],
  );
  const matches = rows.filter((row) => {
    if (row.path === pathHint) {
      if (allowedExts) {
        return false; // bare hint with no extension cannot match a family
      }
      return true;
    }
    if (!row.path.startsWith(pathHint)) return false;
    const rest = row.path.slice(pathHint.length);
    const m = /^(?:\.([^./]+)|\/(?:index|__init__)\.([^./]+))$/.exec(rest);
    if (!m) return false;
    const ext = m[1] ?? m[2];
    return !allowedExts || allowedExts.has(ext);
  });
  if (matches.length !== 1) return undefined;
  return matches[0]?.id;
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
  if (filePath.includes("\\")) {
    throw new Error(
      `graph-store: file path '${filePath}' must use forward slashes (backslash rejected — FileIR contract requires repo-relative POSIX paths)`,
    );
  }
  if (filePath.startsWith("/") || /^[A-Za-z]:[\\/]/.test(filePath)) {
    throw new Error(
      `graph-store: file path '${filePath}' must be repo-relative (absolute path rejected — FileIR contract requires repo-relative forward-slash paths)`,
    );
  }
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
