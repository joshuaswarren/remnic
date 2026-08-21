/**
 * Stable reasons why benchmark execution cannot make progress without an
 * external state change. Providers may throw this error to distinguish a
 * run-wide infrastructure block from an ordinary per-trial failure.
 */
export const BenchmarkRunBlockReason = {
  InfrastructureUnavailable: "infrastructure_unavailable",
  ManualReconciliationRequired: "manual_reconciliation_required",
  SpendHeadroomExhausted: "spend_headroom_exhausted",
  SpendCeilingExceeded: "spend_ceiling_exceeded",
  ResourceLocked: "resource_locked",
} as const;

export type BenchmarkRunBlockReason =
  (typeof BenchmarkRunBlockReason)[keyof typeof BenchmarkRunBlockReason];

export const BENCHMARK_RUN_BLOCKED_ERROR_CODE =
  "REMNIC_BENCHMARK_RUN_BLOCKED" as const;

const BLOCK_REASONS: ReadonlySet<string> = new Set(
  Object.values(BenchmarkRunBlockReason),
);

export class BenchmarkRunBlockedError extends Error {
  readonly code = BENCHMARK_RUN_BLOCKED_ERROR_CODE;
  readonly reason: BenchmarkRunBlockReason;

  constructor(
    reason: BenchmarkRunBlockReason,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "BenchmarkRunBlockedError";
    this.reason = reason;
  }
}

/**
 * Find a run-terminal marker in an error's cause chain. The structural check
 * keeps the contract usable across duplicate package instances; the visited
 * set prevents hostile or accidentally cyclic cause graphs from looping.
 */
export function findBenchmarkRunBlockedError(
  error: unknown,
): BenchmarkRunBlockedError | undefined {
  const visited = new Set<object>();
  let current: unknown = error;

  while (typeof current === "object" && current !== null) {
    if (visited.has(current)) {
      return undefined;
    }
    visited.add(current);

    const candidate = current as {
      code?: unknown;
      reason?: unknown;
      cause?: unknown;
    };
    if (
      candidate.code === BENCHMARK_RUN_BLOCKED_ERROR_CODE &&
      typeof candidate.reason === "string" &&
      BLOCK_REASONS.has(candidate.reason)
    ) {
      return current as BenchmarkRunBlockedError;
    }
    current = candidate.cause;
  }

  return undefined;
}

export function isBenchmarkRunBlockedError(error: unknown): boolean {
  return findBenchmarkRunBlockedError(error) !== undefined;
}
