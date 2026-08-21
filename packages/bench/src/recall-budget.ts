export const DEFAULT_BENCH_RECALL_BUDGET_CHARS = 24_000;
export const MAX_COMBINED_RECALL_BUDGET_CHARS = 36_000;

export function benchmarkRecallBudgetForSessionCount(
  sessionCount: number,
): number {
  if (!Number.isInteger(sessionCount) || sessionCount <= 0) {
    return DEFAULT_BENCH_RECALL_BUDGET_CHARS;
  }

  if (sessionCount === 1) {
    return DEFAULT_BENCH_RECALL_BUDGET_CHARS;
  }

  return Math.floor(MAX_COMBINED_RECALL_BUDGET_CHARS / sessionCount);
}
