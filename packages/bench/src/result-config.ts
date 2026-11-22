
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
