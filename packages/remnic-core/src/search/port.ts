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

export interface SearchExecutionOptions {
  signal?: AbortSignal;
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
  isAvailable(): boolean;
  debugStatus(): string;

  // ── Search ──
  search(
    query: string,
    collection?: string,
    maxResults?: number,
    options?: SearchQueryOptions,
    execution?: SearchExecutionOptions,
  ): Promise<SearchResult[]>;
  searchGlobal(query: string, maxResults?: number, execution?: SearchExecutionOptions): Promise<SearchResult[]>;
  bm25Search(
    query: string,
    collection?: string,
    maxResults?: number,
    execution?: SearchExecutionOptions,
  ): Promise<SearchResult[]>;
  vectorSearch(
    query: string,
    collection?: string,
    maxResults?: number,
    execution?: SearchExecutionOptions,
  ): Promise<SearchResult[]>;
  hybridSearch(
    query: string,
    collection?: string,
    maxResults?: number,
    execution?: SearchExecutionOptions,
  ): Promise<SearchResult[]>;

  // ── Maintenance ──
  update(execution?: SearchExecutionOptions): Promise<void>;
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
  embedCollection(collection: string): Promise<void>;

  // ── Collection management ──
  ensureCollection(
    memoryDir: string,
    execution?: SearchExecutionOptions,
  ): Promise<"present" | "missing" | "unknown" | "skipped">;
}
