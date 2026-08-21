/**
 * Shared benchmark result config finalization.
 */

import type { BenchmarkResult, RunBenchmarkOptions } from "./types.js";

export function finalizeBenchmarkResultConfig(
  result: BenchmarkResult,
  options: Pick<
    RunBenchmarkOptions,
    "runtimeProfile" | "internalProvider" | "benchmarkOptions" | "limit"
  >,
): BenchmarkResult {
  result.config.runtimeProfile ??= options.runtimeProfile ?? null;
  result.config.internalProvider ??= options.internalProvider ?? null;
  if (options.benchmarkOptions !== undefined || options.limit !== undefined) {
    // Strip any live adapter instance — benchmark runners (e.g. MemCorrect)
    // accept a MemCorrectSystemAdapter under benchmarkOptions.adapter, but
    // it must never enter the persisted result config. The runner strips it
    // from its own return value, but this merge re-spreads the original
    // options, so filter it here at the single finalization point.
    const { adapter: _omitAdapter, ...persistableOptions } =
      (options.benchmarkOptions as Record<string, unknown> | undefined) ?? {};
    result.config.benchmarkOptions = {
      ...persistableOptions,
      ...(options.limit !== undefined ? { limit: options.limit } : {}),
      ...(result.config.benchmarkOptions ?? {}),
    };
  }
  return result;
}
