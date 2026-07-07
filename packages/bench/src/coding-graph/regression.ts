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
  MachineFingerprint,
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
  incrementalModifiedUpdateP95Ms: "lower-is-better" as const,
  incrementalModifiedUpdateP50Ms: "lower-is-better" as const,
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
    incrementalModifiedUpdateP50Ms: report.incrementalModifiedUpdate.p50,
    incrementalModifiedUpdateP95Ms: report.incrementalModifiedUpdate.p95,
    tracePathP95Ms: report.tracePath.p95,
    searchGraphP95Ms: report.searchGraph.p95,
    deadCodeMs: report.deadCodeMs.ms,
    dbBytesPerKloc: report.dbBytesPerKloc,
  };
}


// ---------------------------------------------------------------------------
// Machine-fingerprint comparison (#1688 item 2).
//
// Compares the load-bearing fields that drive timing variance. nodeVersion
// is compared on its MAJOR version only (v22.20.0 vs v22.5.0 race identically
// for our purposes; v22 vs v23 do not). cpuCores counts; totalMemoryMb does
// not (a memory difference alone rarely moves sub-ms SQLite ops and would
// over-trigger the skip).
// ---------------------------------------------------------------------------

const NODE_MAJOR_CACHE = new WeakMap<MachineFingerprint, string>();

function nodeMajor(fp: MachineFingerprint): string {
  const cached = NODE_MAJOR_CACHE.get(fp);
  if (cached !== undefined) return cached;
  // process.version shape: "v22.20.0" → major "22".
  const major = fp.nodeVersion.replace(/^v/, "").split(".")[0] ?? fp.nodeVersion;
  NODE_MAJOR_CACHE.set(fp, major);
  return major;
}

/**
 * Compare two machine fingerprints on the fields that matter for timing.
 * Returns the list of fields that differ. An empty list means the
 * fingerprints are comparable.
 */
export function compareMachineFingerprints(
  report: MachineFingerprint,
  baseline: MachineFingerprint,
): { readonly differingFields: readonly string[] } {
  const differing: string[] = [];
  if (report.arch !== baseline.arch) differing.push("arch");
  if (report.platform !== baseline.platform) differing.push("platform");
  if (nodeMajor(report) !== nodeMajor(baseline)) differing.push("nodeVersion(major)");
  if (report.cpuModel !== baseline.cpuModel) differing.push("cpuModel");
  if (report.cpuCores !== baseline.cpuCores) differing.push("cpuCores");
  return { differingFields: differing };
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

  // Guard: schema-version compatibility. extractMetrics below
  // unconditionally dereferences v2-only fields (e.g.
  // incrementalModifiedUpdate); a pre-v2 report lacks them and would
  // throw a TypeError before any skip could run — defeating the
  // cross-environment robustness the machine guard targets
  // (kilo-code-bot review of #1688). A schema mismatch is a structural
  // incompatibility: fail with an actionable message instead of
  // crashing or silently skipping.
  if (report.schemaVersion !== baseline.schemaVersion) {
    return {
      passed: false,
      regressions: [],
      summary:
        `Schema-version mismatch: report=${report.schemaVersion} ` +
        `baseline=${baseline.schemaVersion}. Metrics are not comparable ` +
        `across schema versions — regenerate the baseline (#1688).`,
    };
  }

  // Field-presence guard: a corrupt/partial v2 report may carry
  // schemaVersion 2 yet lack a required metric field OR a nested sub-field
  // (a hand-edited or truncated JSON). extractMetrics dereferences both the
  // top-level field and its nested p50/p95; without this guard a missing
  // nested field produces undefined in the metric map, and the comparison
  // loop silently skips it (passed: true) — letting corrupt artifacts pass
  // (chatgpt-codex-connector #1688 P2: 'Validate nested metric fields').
  const missingFields: string[] = [];
  if (report.incrementalUpdate == null) missingFields.push("incrementalUpdate");
  if (report.incrementalModifiedUpdate == null) missingFields.push("incrementalModifiedUpdate");
  if (report.incrementalUpdate?.p50 == null) missingFields.push("incrementalUpdate.p50");
  if (report.incrementalUpdate?.p95 == null) missingFields.push("incrementalUpdate.p95");
  if (report.incrementalModifiedUpdate?.p50 == null) missingFields.push("incrementalModifiedUpdate.p50");
  if (report.incrementalModifiedUpdate?.p95 == null) missingFields.push("incrementalModifiedUpdate.p95");
  if (report.tracePath?.p95 == null) missingFields.push("tracePath.p95");
  if (report.searchGraph?.p95 == null) missingFields.push("searchGraph.p95");
  if (report.fullIndexMs?.ms == null) missingFields.push("fullIndexMs.ms");
  if (report.fullIndexLocsPerSecond == null) missingFields.push("fullIndexLocsPerSecond");
  if (report.deadCodeMs?.ms == null) missingFields.push("deadCodeMs.ms");
  if (report.dbBytesPerKloc == null) missingFields.push("dbBytesPerKloc");
  if (missingFields.length > 0) {
    return {
      passed: false,
      regressions: [],
      summary:
        "Report claims schemaVersion " + report.schemaVersion +
        " but is missing required metric field(s): " + missingFields.join(", ") +
        " — the report is incomplete or corrupt. Regenerate it (#1688).",
    };
  }

  // Guard (#1688 item 2): a timing comparison is only meaningful on the
  // same machine class. A baseline carries a fingerprint (arch/platform/
  // nodeVersion/cpuModel/cores); a report from a different machine class
  // can fail the gate on legitimate hardware variance rather than a real
  // regression. When the fingerprints differ on a load-bearing field, SKIP
  // the comparison (passed: true + skipped: true) and surface the mismatch
  // so a human decides whether cross-machine numbers are comparable.
  const mismatch = compareMachineFingerprints(report.machine, baseline.machine);
  if (mismatch.differingFields.length > 0) {
    return {
      passed: true,
      skipped: true,
      regressions: [],
      summary:
        "Machine-fingerprint mismatch — comparison skipped to avoid a " +
        "false-positive hardware-variance failure. Differing fields: " +
        mismatch.differingFields.join(", ") +
        ". Regenerate the baseline on this machine for a real comparison " +
        "(#1688).",
      machineMismatch: {
        report: report.machine,
        baseline: baseline.machine,
        differingFields: mismatch.differingFields,
      },
    };
  }

  const measured = extractMetrics(report);
  const baselineMetrics = baseline.metrics;
  const regressions: RegressionMetricDetail[] = [];

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
