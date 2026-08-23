/**
 * Summary seam for the UI shell. Parsing, validation, and summary
 * construction live in `@remnic/bench` (`result-summary.ts`); this module
 * keeps a stable local entry point for the vite dev middleware and tests.
 */
export {
  loadBenchmarkResultSummaries,
  summarizeBenchmarkResult,
} from "@remnic/bench";

export type {
  BenchResultFileWarning,
  BenchResultSummary,
  BenchResultSummaryPayload,
} from "@remnic/bench";
