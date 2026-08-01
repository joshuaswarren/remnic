import type { QmdSearchResult } from "../types.js";

/** Alias so consumers don't need to reference "Qmd" in a backend-agnostic context. */
export type SearchResult = QmdSearchResult;

export interface SearchQueryOptions {
  intent?: string;
  explain?: boolean;
  candidateLimit?: number;
  rerank?: boolean;
  chunkStrategy?: "auto" | "regex";
  structuredSearches?: Array<{ type: "lex" | "vec" | "hyde"; query: string }>;
}

/**
 * A search that returned empty (or partial) results because the backend was
 * unavailable, still loading, or timed out — cases that are otherwise
 * indistinguishable from a genuine "no matches" (issue #1536, CLAUDE.md
 * rule 34).
 */
export interface SearchDegradation {
  backend: "qmd" | "remote" | "meilisearch" | "orama" | "lancedb";
  code:
    | "backend_unavailable"
    | "backend_error"
    | "daemon_timeout"
    | "daemon_loading"
    | "subprocess_error"
    | "deadline_exceeded"
    | "remote_error";
  detail?: string;
}

export interface SearchExecutionOptions {
  signal?: AbortSignal;
  /**
   * Observer invoked when the backend degrades during this call (#1536).
   * Callers that need to distinguish empty-because-degraded from
   * empty-because-no-matches (recall x-ray, fallback decisions) pass a
   * collector here. Observer failures are swallowed by the notifier —
   * observability must never break search.
   */
  onDegradation?: (degradation: SearchDegradation) => void;
}

export function reportSearchDegradation(
  execution: SearchExecutionOptions | undefined,
  degradation: SearchDegradation
): void {
  try {
    execution?.onDegradation?.(degradation);
  } catch {
    // Observability must never break search.
  }
}

export function resolveEnsureCollectionArgs(
  collectionOrExecution?: string | SearchExecutionOptions,
  execution?: SearchExecutionOptions
): { collection?: string; execution?: SearchExecutionOptions } {
  if (typeof collectionOrExecution === "string") {
    return { collection: collectionOrExecution, execution };
  }
  return { collection: undefined, execution: collectionOrExecution ?? execution };
}

/**
 * Optional status report for search backends that track embedding backlog.
 * Backends without embedding pipelines return null from status().
 */
export interface SearchBackendStatus {
  pendingEmbeddings: number | null;
  oldestPendingAgeMs: number | null;
  totalFiles: number | null;
  embeddedFiles: number | null;
}

/**
 * Abstract search backend interface.
 *
 * Implementations:
 * - QmdClient (default, local hybrid BM25+vector+reranking)
 * - OramaBackend (embedded, pure JS, hybrid FTS+vector)
 * - LanceDbBackend (embedded, native Arrow bindings, RRF reranking)
 * - MeilisearchBackend (server-based SDK, hybrid search)
 * - RemoteSearchBackend (HTTP REST adapter)
 * - NoopSearchBackend (graceful degradation)
 *
 * See docs/writing-a-search-backend.md for the implementation guide.
 */
export interface SearchBackend {
  // ── Lifecycle ──
  probe(): Promise<boolean>;
  /**
   * Optional non-mutating availability probe for health/readiness checks.
   * Implementations must avoid auto-upgrades, collection creation, daemon
   * startup, or any other runtime-modifying side effects.
   */
  checkAvailability?(execution?: SearchExecutionOptions): Promise<boolean>;
  isAvailable(): boolean;
  debugStatus(): string;
  /** Optional embedding backlog status for health surfaces. */
  status?(): Promise<SearchBackendStatus>;

  // ── Search ──
  search(
    query: string,
    collection?: string,
    maxResults?: number,
    options?: SearchQueryOptions,
    execution?: SearchExecutionOptions
  ): Promise<SearchResult[]>;
  searchGlobal(query: string, maxResults?: number, execution?: SearchExecutionOptions): Promise<SearchResult[]>;
  bm25Search(
    query: string,
    collection?: string,
    maxResults?: number,
    execution?: SearchExecutionOptions
  ): Promise<SearchResult[]>;
  vectorSearch(
    query: string,
    collection?: string,
    maxResults?: number,
    execution?: SearchExecutionOptions
  ): Promise<SearchResult[]>;
  hybridSearch(
    query: string,
    collection?: string,
    maxResults?: number,
    execution?: SearchExecutionOptions
  ): Promise<SearchResult[]>;

  // ── Maintenance ──
  update(execution?: SearchExecutionOptions): Promise<void>;
  /**
   * Wall-clock ms of the most recent SUCCESSFUL index refresh, or null when the
   * backend has never run one. Ordinary update() is fail-open: it returns
   * silently (without throwing or advancing this timestamp) when the backend is
   * unavailable or the call is suppressed by a min-interval / failure backoff.
   * Callers that must know whether update() actually indexed — so they can
   * invalidate dependent caches only on a real refresh — snapshot this before
   * the call and treat the backend as refreshed iff the value advanced. Optional
   * because not every backend tracks it; absent means "assume refreshed".
   */
  readonly lastUpdateRanAtMs?: number | null;
  /**
   * Optional strict refresh used by callers that must know whether the backend
   * was actually refreshed before writing success markers. Ordinary update
   * calls remain fail-open for migration/maintenance resilience.
   */
  updateStrict?(execution?: SearchExecutionOptions): Promise<void>;
  updateCollection(collection: string, execution?: SearchExecutionOptions): Promise<void>;
  updateCollectionFromDir?(collection: string, memoryDir: string, execution?: SearchExecutionOptions): Promise<void>;
  /**
   * True when update() refreshes every indexed collection, not just this
   * backend's configured collection. Namespace routers use this to avoid
   * repeating the same expensive global update once per namespace.
   */
  updatesAllCollections?(): boolean;
  /**
   * Optional strict refresh used by callers that must know whether a collection
   * was actually refreshed before writing success markers. Ordinary update
   * calls remain fail-open for migration/maintenance resilience.
   */
  updateCollectionStrict?(collection: string, execution?: SearchExecutionOptions): Promise<void>;
  embed(): Promise<void>;
  /**
   * Optional strict embed used by callers that must know vectors were actually
   * refreshed before writing success markers.
   */
  embedStrict?(): Promise<void>;
  embedCollection(collection: string): Promise<void>;
  /**
   * Optional strict collection embed used by callers that must know vectors were
   * actually refreshed before writing success markers.
   */
  embedCollectionStrict?(collection: string): Promise<void>;

  // ── Collection management ──
  /**
   * True only when the backend can bind, isolate, search, and delete collections
   * outside Remnic's primary memory roots.
   */
  supportsAdditionalCollections?(): boolean;
  /**
   * Prevent a collection from participating in unscoped/global searches.
   * Dedicated corpora must call this immediately after collection creation.
   */
  excludeCollectionFromGlobalSearch?(collection: string, execution?: SearchExecutionOptions): Promise<void>;
  /** Remove a non-primary collection and its backend-owned index state. */
  deleteCollection?(collection: string, execution?: SearchExecutionOptions): Promise<boolean>;
  /** Canonical source root currently bound to a named collection. */
  collectionRoot?(collection: string, execution?: SearchExecutionOptions): Promise<string | null>;
  /** Collection-scoped status for observability surfaces. */
  collectionStatus?(collection: string): Promise<Pick<SearchBackendStatus, "totalFiles">>;
  /**
   * Optional non-mutating collection probe. Backends that can distinguish a
   * missing collection from a transient probe failure should implement this so
   * callers can avoid auto-creating collections in unsafe layouts.
   */
  checkCollection?(
    collectionOrExecution?: string | SearchExecutionOptions,
    execution?: SearchExecutionOptions
  ): Promise<"present" | "missing" | "unknown" | "skipped">;
  ensureCollection(
    memoryDir: string,
    execution?: SearchExecutionOptions
  ): Promise<"present" | "missing" | "unknown" | "skipped">;
  ensureCollection(
    memoryDir: string,
    collection?: string,
    execution?: SearchExecutionOptions
  ): Promise<"present" | "missing" | "unknown" | "skipped">;
}
