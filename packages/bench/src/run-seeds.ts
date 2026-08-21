/**
 * Seed-sequence generation for benchmark runs.
 *
 * Factored out of `benchmark.ts` so individual runners can reuse it without
 * triggering a circular import through `benchmark.ts -> registry.ts ->
 * runner.ts -> benchmark.ts`.
 */

export function buildBenchmarkRunSeeds(
  runCount: number,
  baseSeed?: number,
): number[] {
  if (!Number.isSafeInteger(runCount) || runCount <= 0) {
    throw new Error("benchmark run count must be a positive integer within JavaScript safe integer range");
  }

  const firstSeed = baseSeed ?? 0;
  if (!Number.isSafeInteger(firstSeed) || firstSeed < 0) {
    throw new Error("benchmark seed must be a non-negative integer within JavaScript safe integer range");
  }

  const maxOffset = Number.MAX_SAFE_INTEGER - firstSeed;
  if (runCount - 1 > maxOffset) {
    throw new Error("benchmark seed sequence must stay within JavaScript safe integer range");
  }

  return Array.from({ length: runCount }, (_, index) => firstSeed + index);
}
