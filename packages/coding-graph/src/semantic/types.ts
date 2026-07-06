/**
 * Shared types for the semantic layer (issue #1556).
 *
 * Tagged failures follow rule 34 — every entry point returns a
 * discriminated union so a caller that switches on `result.code` never
 * observes a thrown error from the semantic layer.
 */

/**
 * A persisted symbol vector. `vector` is the float32 embedding; `dims`
 * is its dimensionality; `modelId` identifies the provider+model that
 * produced it (so a provider swap invalidates the cache); `contentHash`
 * is the canonical-text hash (so a canonical-text change invalidates the
 * cache — rule 37).
 */
export interface SymbolVector {
  readonly nodeId: string;
  readonly qualifiedName: string;
  readonly vector: Float32Array;
  readonly dims: number;
  readonly modelId: string;
  readonly contentHash: string;
}

/**
 * A row read back from the vectors table for brute-force cosine.
 */
export interface SymbolVectorRow {
  readonly nodeId: string;
  readonly qualifiedName: string;
  readonly vector: Float32Array;
  readonly dims: number;
  readonly modelId: string;
  readonly contentHash: string;
  readonly filePath: string;
}

/**
 * Tagged-failure codes shared across the semantic layer.
 *
 * - `semantic_disabled`: the master gate is off (rule 30/48). No provider
 *   call, no vectors-table write, no edge emitted.
 * - `provider_unavailable`: no host embedding provider registered for the
 *   given scope.
 * - `provider_timeout`: the provider exceeded the lookup budget.
 * - `malformed_vector`: `normalizeHostEmbeddingVector` returned null.
 * - `repo_root_unset`: the store was opened without a repoRoot, so source
 *   text cannot be read.
 * - `store_closed`: the store is closed.
 * - `db_error`: an underlying SQLite error.
 * - `no_vectors`: semantic_query ran but the vectors table is empty.
 * - `invalid_query`: malformed query input.
 */
export type SemanticFailureCode =
  | "semantic_disabled"
  | "provider_unavailable"
  | "provider_timeout"
  | "malformed_vector"
  | "repo_root_unset"
  | "store_closed"
  | "db_error"
  | "no_vectors"
  | "invalid_query";

export interface SemanticFailure {
  readonly ok: false;
  readonly code: SemanticFailureCode;
  readonly message?: string;
}

/**
 * Result of indexing vectors for a batch of symbols.
 */
export interface IndexVectorsResult {
  readonly ok: true;
  readonly embedded: number;
  readonly cached: number;
  readonly skipped: number;
}

/**
 * A SIMILAR_TO candidate pair from the MinHash/LSH pass.
 */
export interface SimilarCandidate {
  readonly aNodeId: string;
  readonly bNodeId: string;
  readonly aQualifiedName: string;
  readonly bQualifiedName: string;
  readonly jaccard: number;
}

/**
 * A confirmed SIMILAR_TO edge (after cosine confirmation when available).
 */
export interface SimilarEdge {
  readonly srcQualifiedName: string;
  readonly dstQualifiedName: string;
  readonly confidence: number;
  readonly confirmed: boolean;
}

/**
 * Result of the SIMILAR_TO pipeline.
 */
export interface SimilarToResult {
  readonly ok: true;
  readonly edges: readonly SimilarEdge[];
  readonly candidates: number;
  readonly confirmed: number;
  readonly minhashOnly: number;
}

/**
 * A hydrated semantic_query hit — graph context attached so the agent
 * gets structure, not just a snippet.
 */
export interface SemanticQueryHit {
  readonly qualifiedName: string;
  readonly filePath: string;
  readonly kind: string;
  readonly score: number;
  readonly snippet: string;
  readonly callers: readonly string[];
  readonly callees: readonly string[];
}

/**
 * Result of semantic_query. When degraded, `ok: true` still carries the
 * (possibly empty) hits plus a `degraded` tag so the caller never
 * mistakes "no matches" for "backend broken" (rule 34).
 */
export interface SemanticQuerySuccess {
  readonly ok: true;
  readonly hits: readonly SemanticQueryHit[];
  readonly degraded?: "provider_unavailable" | "provider_timeout" | "malformed_vector";
}

export type SemanticQueryOutcome = SemanticQuerySuccess | SemanticFailure;
