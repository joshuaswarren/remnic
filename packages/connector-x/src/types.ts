/**
 * Shared types for @remnic/connector-x.
 */

export type XRecordKind = "bookmark" | "own_post";

/** Trust gate for extracted memories. "suggest" routes through a review queue; "store" writes directly. */
export type XMemoryMode = "suggest" | "store";

export type XSourceKind = "mcp" | "corpusDir" | "cli";

export interface XAuthor {
  id?: string;
  username?: string;
  name?: string;
}

export interface XProvenance {
  sourceId: string;
  sourceKind: XSourceKind;
  syncRunId: string;
  fetchedAt: string;
}

/** Normalized record, the common currency every source emits. */
export interface XPostRecord {
  postId: string;
  kind: XRecordKind;
  author?: XAuthor;
  /** Post creation time (ISO 8601) when the source carries it. */
  createdAt?: string;
  /** When the bookmark act happened (ISO 8601), when known. */
  bookmarkedAt?: string;
  text: string;
  urls: string[];
  mediaCount: number;
  /** Zero-credit enrichment (e.g. resolved URL titles from a local corpus). */
  enrichment?: Record<string, unknown>;
  provenance?: XProvenance;
}

/** The memory a record maps to, before trust gating. */
export interface XMemorySuggestion {
  record: XPostRecord;
  tags: string[];
  category: string;
  entityRef?: string;
  confidence: number;
  postUrl: string;
  /** Composed memory sentence. */
  content: string;
}

/**
 * Host-provided memory sink. `submitSuggestion` feeds the review queue;
 * `storeMemory` writes directly. The connector picks per `memoryMode`.
 */
export interface XMemorySink {
  submitSuggestion(suggestion: XMemorySuggestion): Promise<void>;
  storeMemory(suggestion: XMemorySuggestion): Promise<void>;
}

export interface XSourceFetchOutcome {
  records: XPostRecord[];
  /** Billable reads consumed (MCP only; 0 for zero-credit sources). */
  reads: number;
  pages: number;
  /** Present when the source degraded instead of erroring. */
  skipped?: { reason: string; detail?: string };
}

export interface XSource {
  id: string;
  kind: XSourceKind;
  fetch(ctx: XSourceFetchContext): Promise<XSourceFetchOutcome>;
}

export interface XSourceFetchContext {
  knownIds: ReadonlySet<string>;
  budget: XBudgetRuntime;
  signal?: AbortSignal;
}

/** Budget enforcement shared by the sync loop and the MCP source. */
export interface XBudgetRuntime {
  canRead(): { ok: true } | { ok: false; reason: string; detail?: string };
  noteRead(): void;
  /** Pages consumed this sync by the current source. */
  pagesUsed: number;
  maxPages: number;
}

export interface XSourceSyncSummary {
  sourceId: string;
  kind: XSourceKind;
  recordsNew: number;
  recordsKnown: number;
  reads: number;
  pages: number;
  skipped?: { reason: string; detail?: string };
  error?: string;
}

export interface XSyncReport {
  runId: string;
  startedAt: string;
  finishedAt: string;
  memoryMode: XMemoryMode;
  sources: XSourceSyncSummary[];
  suggestionsSubmitted: number;
  memoriesStored: number;
  sinkFailures: number;
  monthKey: string;
  monthSpendUsd: number;
}

export interface XSourceStatus {
  sourceId: string;
  kind: XSourceKind;
  priority: number;
  lastSyncAt: string | null;
  lastRecordsNew: number;
  available: boolean;
  availabilityDetail?: string;
}

export interface XStatusReport {
  enabled: boolean;
  memoryMode: XMemoryMode;
  syncSchedule: string;
  sources: XSourceStatus[];
  seenCount: number;
  monthKey: string;
  monthSpendUsd: number;
  monthlyCostCapUsd: number;
  lastSyncAt: string | null;
}
