/**
 * Configuration shape for judge-mediated merge-on-write (issue #2330).
 *
 * Kept in its own module rather than in `types.ts`, which sits at its
 * grandfathered size ceiling (issue #1995). This file deliberately imports
 * nothing: `types.ts` re-exports the type and `dedup/` consumes it, so a
 * shared leaf module is what keeps that from becoming an import cycle.
 */

export interface SemanticMergeConfig {
  enabled: boolean;
  minSimilarity: number;
  maxCandidates: number;
  categories: readonly string[];
  shadowMode: boolean;
}
