/**
 * Semantic layer barrel (issue #1556).
 *
 * One import surface for the optional semantic layer:
 *   - config (SemanticConfig + resolveSemanticConfig)
 *   - canonical-text (buildCanonicalText + hash)
 *   - minhash (MinHasher + cosineSimilarity)
 *   - vectors (indexSymbolVectors)
 *   - similarity (computeSimilarTo + similarEdgesToEdgeIR)
 *   - semantic-query (semanticQuery)
 *   - types (tagged results)
 */
export {
  DEFAULT_SIMILAR_TO_THRESHOLD,
  DEFAULT_MAX_SYMBOLS_PER_RUN,
  MINHASH_ONLY_CONFIDENCE,
  SIMILAR_TO_EDGE_TYPE,
  SEMANTIC_PROVENANCE,
  DEFAULT_CANONICAL_BODY_LINES,
  resolveSemanticConfig,
  type SemanticConfig,
} from "./config.js";

export {
  buildCanonicalText,
  buildCanonicalTextAndHash,
  canonicalTextHash,
  collapseWhitespace,
  extractSignatureLine,
  extractBodyText,
  type CanonicalTextInput,
} from "./canonical-text.js";

export {
  MinHasher,
  createMinHasher,
  minHashSignature,
  lshBandKeys,
  shingleSet,
  tokenizeForShingling,
  cosineSimilarity,
  MINHASH_SEEDS,
  type LshIndexEntry,
} from "./minhash.js";

export {
  indexSymbolVectors,
  modelIdFor,
  type IndexVectorsInput,
} from "./vectors.js";

export {
  computeSimilarTo,
  similarEdgesToEdgeIR,
  estimateJaccard,
  CONFIRM_OPERATOR,
  type SimilarToInput,
} from "./similarity.js";

export {
  semanticQuery,
  DEFAULT_SEMANTIC_QUERY_LIMIT,
  type SemanticQueryInput,
} from "./semantic-query.js";

export type {
  SymbolVector,
  SymbolVectorRow,
  SemanticFailure,
  SemanticFailureCode,
  IndexVectorsResult,
  SimilarCandidate,
  SimilarEdge,
  SimilarToResult,
  SemanticQueryHit,
  SemanticQuerySuccess,
  SemanticQueryOutcome,
} from "./types.js";
