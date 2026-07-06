/**
 * Coding-graph regression gate (issue #1557 step 3).
 *
 * Compares a benchmark report against a tracked baseline with a generous
 * tolerance. Hard-fails on gross regression — a real failing step, not a
 * warning (rule 50: no `|| true`). Tightening the baseline is a deliberate
 * PR act, mirroring `check-ratchets --update` (rule 50).
 *
 * The baseline is bench-owned (separate file from the structural ratchets
 * in scripts/ratchet-baseline.json). New metrics are additive: only keys
 * present in BOTH the report and the baseline are compared.
 */

import type {
  CodingGraphBenchReport,
  CodingGraphBaseline,
  RegressionGateResult,
  RegressionMetricDetail,
} from "./types.js";
import { DEFAULT_TOLERANCE_PERCENT } from "./types.js";

// ---------------------------------------------------------------------------
// Extract comparable metric values from a report.
//
// lowerIsBetter keys: time-based metrics (ms).
// higherIsBetter keys: throughput (LOC/s).
// ---------------------------------------------------------------------------

const METRIC_DIRECTION = {
  fullIndexMs: "lower-is-better" as const,
  fullIndexLocsPerSecond: "higher-is-better" as const,
  incrementalUpdateP95Ms: "lower-is-better" as const,
  incrementalUpdateP50Ms: "lower-is-better" as const,
  tracePathP95Ms: "lower-is-better" as const,
  searchGraphP95Ms: "lower-is-better" as const,
  deadCodeMs: "lower-is-better" as const,
  dbBytesPerKloc: "lower-is-better" as const,
};

export type RegressionMetricKey = keyof typeof METRIC_DIRECTION;

/**
 * Extract the flat metric map from a report for comparison.
 */
export function extractMetrics(report: CodingGraphBenchReport): Record<string, number> {
  return {
    fullIndexMs: report.fullIndexMs.ms,
    fullIndexLocsPerSecond: report.fullIndexLocsPerSecond,
    incrementalUpdateP50Ms: report.incrementalUpdate.p50,
    incrementalUpdateP95Ms: report.incrementalUpdate.p95,
    tracePathP95Ms: report.tracePath.p95,
    searchGraphP95Ms: report.searchGraph.p95,
    deadCodeMs: report.deadCodeMs.ms,
    dbBytesPerKloc: report.dbBytesPerKloc,
  };
}

/**
 * Compare a report against a baseline. Returns a gate result that exits
 * non-zero when any metric regresses beyond the tolerance.
 *
 * @param report The current run's metrics.
 * @param baseline The tracked baseline to compare against.
 * @param tolerancePercent How much worse a metric can be before it counts
 *   as a regression. Default 30 (generous — perf in CI flake).
 */
export function checkCodingGraphRegression(
  report: CodingGraphBenchReport,
  baseline: CodingGraphBaseline,
  tolerancePercent: number = DEFAULT_TOLERANCE_PERCENT,
): RegressionGateResult {
  const measured = extractMetrics(report);
  const baselineMetrics = baseline.metrics;
  const regressions: RegressionMetricDetail[] = [];

  // Guard: a regression comparison is only meaningful when the report's
  // fixture matches the baseline's fixture on EVERY knob. A different seed
  // or language produces a structurally different synthetic repo, so timing
  // deltas across mismatched fixtures are meaningless. Compare all keys
  // present in the baseline config so new knobs are covered automatically.
  const reportFixture = report.fixture.config;
  const baselineFixture = baseline.fixtureConfig;
  const mismatchedKeys = (Object.keys(baselineFixture) as Array<
    keyof typeof baselineFixture
  >).filter((key) => reportFixture[key] !== baselineFixture[key]);
  if (mismatchedKeys.length > 0) {
    const diffs = mismatchedKeys
      .map(
        (key) =>
          `${key}: report=${reportFixture[key]} baseline=${baselineFixture[key]}`,
      )
      .join(", ");
    return {
      passed: false,
      regressions: [],
      summary: `Fixture mismatch (${diffs}). Metrics are not comparable across different fixtures.`,
    };
  }

  for (const key of Object.keys(METRIC_DIRECTION) as RegressionMetricKey[]) {
    const baseVal = baselineMetrics[key];
    const measVal = measured[key];
    if (baseVal == null || measVal == null) continue;
    if (baseVal === 0) continue; // can't compute percentage of zero

    const direction = METRIC_DIRECTION[key];
    const ratio = measVal / baseVal;
    const percentChange = direction === "lower-is-better"
      ? (ratio - 1) * 100 // positive = slower = worse
      : (1 - ratio) * 100; // positive = slower throughput = worse

    const regressed = percentChange > tolerancePercent;

    if (regressed) {
      regressions.push({
        key,
        baseline: baseVal,
        measured: measVal,
        percentChange: Math.round(percentChange * 10) / 10,
        direction,
        tolerancePercent,
        regressed: true,
      });
    }
  }

  const passed = regressions.length === 0;
  const summary = passed
    ? "All metrics within tolerance."
    : `${regressions.length} metric(s) regressed beyond ${tolerancePercent}% tolerance:\n` +
      regressions
        .map(
          (r) =>
            `  ${r.key}: ${r.baseline} → ${r.measured} (${r.percentChange > 0 ? "+" : ""}${r.percentChange}% vs baseline)`,
        )
        .join("\n");

  return { passed, regressions, summary };
}

// ---------------------------------------------------------------------------
// Baseline construction helpers.
// ---------------------------------------------------------------------------

/**
 * Build a baseline object from a report, suitable for writing to the
 * tracked baseline JSON file. This is the "deliberate PR act" that
 * tightens the baseline (mirrors `check-ratchets --update`).
 */
export function buildBaselineFromReport(
  report: CodingGraphBenchReport,
  note: string,
): CodingGraphBaseline {
  return {
    schemaVersion: report.schemaVersion,
    machine: report.machine,
    fixtureConfig: report.fixture.config,
    metrics: extractMetrics(report),
    createdAt: report.timestamp,
    note,
  };
}
