/**
 * Shared benchmark result config finalization.
 */

import type { BenchmarkResult, RunBenchmarkOptions } from "./types.js";

export function finalizeBenchmarkResultConfig(
  result: BenchmarkResult,
  options: Pick<
    RunBenchmarkOptions,
    "runtimeProfile" | "internalProvider" | "benchmarkOptions"
  >,
): BenchmarkResult {
  result.config.runtimeProfile ??= options.runtimeProfile ?? null;
  result.config.internalProvider ??= options.internalProvider ?? null;
  if (options.benchmarkOptions !== undefined) {
    result.config.benchmarkOptions = {
      ...options.benchmarkOptions,
      ...(result.config.benchmarkOptions ?? {}),
    };
  }
  return result;
}
