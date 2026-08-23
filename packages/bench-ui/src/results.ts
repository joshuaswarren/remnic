/**
 * Summary seam for the UI shell. Parsing, validation, and summary
 * construction live in `@remnic/bench` (`result-summary.ts`); this module
 * keeps a stable local entry point for the vite dev middleware and tests.
 */
import { loadBenchmarkResultSummaries, summarizeBenchmarkResult } from "@remnic/bench";

export { loadBenchmarkResultSummaries, summarizeBenchmarkResult };

export type {
  BenchResultFileWarning,
  BenchResultSummary,
  BenchResultSummaryPayload,
} from "@remnic/bench";

/**
 * @deprecated Use `loadBenchmarkResultSummaries` instead. Same signature
 * and payload; kept so imports of this module path keep resolving. A
 * regression test locks output equality on the equivalence fixture.
 */
export const loadBenchResultSummaries = loadBenchmarkResultSummaries;
