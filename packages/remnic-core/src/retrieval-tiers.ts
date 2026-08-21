/**
 * Retrieval tier ladder (issue #518).
 *
 * Explicit tier ordering so callers can reason about precedence without
 * inspecting retrieval.ts internals.  The tier names are the same strings
 * used in `RecallTierExplain.tier` and in profiling spans.
 *
 * The ladder is codified here as a read-only array; consumers that need
 * "is this a valid tier?" use `RETRIEVAL_TIERS.includes(value)`.
 */

import type { RetrievalTier } from "./types.js";

export const RETRIEVAL_TIERS: readonly RetrievalTier[] = [
  "exact-cache",
  "fuzzy-cache",
  "direct-answer",
  "hybrid",
  "rerank-graph",
  "agentic",
] as const;

export function isRetrievalTier(value: unknown): value is RetrievalTier {
  return typeof value === "string" && (RETRIEVAL_TIERS as readonly string[]).includes(value);
}
