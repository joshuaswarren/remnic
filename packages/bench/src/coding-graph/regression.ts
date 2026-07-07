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
  // cpuModel is nullable — null means "unknown / undetected", not "different".
  // Only count a cpuModel difference when BOTH sides report a concrete model,
  // so a null cpuModel does not spuriously skip the gate and hide a real
  // regression on the same machine class (cursor Bugbot: 'Fingerprint skip
  // omits cpuModel validation').
  if (
    report.cpuModel !== null &&
    baseline.cpuModel !== null &&
    report.cpuModel !== baseline.cpuModel
  ) {
    differing.push("cpuModel");
  }
  if (report.cpuCores !== baseline.cpuCores) differing.push("cpuCores");
  return { differingFields: differing };
}

/**
 * Validate the load-bearing fields of a machine fingerprint. JSON-loaded
 * fingerprints bypass TS's nominal types, so a corrupt artifact may carry
 * `machine: {}` or `nodeVersion` as a non-string; compareMachineFingerprints
 * → nodeMajor then calls .replace on an invalid value and throws instead of
 * returning the intended corrupt-artifact failure. Returns the names of
 * fields that are missing or have the wrong runtime type.
 * (chatgpt-codex-connector #1688 P2: 'Validate fingerprint field types'.)
 */
function invalidFingerprintFields(fp: MachineFingerprint): string[] {
  const bad: string[] = [];
  if (typeof fp.arch !== "string") bad.push("arch");
  if (typeof fp.platform !== "string") bad.push("platform");
  // nodeVersion feeds nodeMajor's .replace — a non-string throws.
  if (typeof fp.nodeVersion !== "string") bad.push("nodeVersion");
  if (typeof fp.cpuCores !== "number" || !Number.isFinite(fp.cpuCores)) bad.push("cpuCores");
  // cpuModel is nullable (the harness sets null when no CPUs are detected),
  // but it must still be a string-or-null — a number/object/undefined (a
  // missing key) is corruption (cursor Bugbot: 'Fingerprint skip omits
  // cpuModel validation').
  if (fp.cpuModel !== null && typeof fp.cpuModel !== "string") bad.push("cpuModel");
  return bad;
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

  // Field-presence + finite-number guard: a corrupt/partial v2 report
  // may carry schemaVersion 2 yet lack a required metric field, have a
  // nested sub-field missing, or carry a non-numeric value from a malformed
  // JSON (e.g. fullIndexLocsPerSecond: "oops"). extractMetrics feeds these
  // values into ratio math; a NaN result silently passes the gate. Validate
  // every metric as a finite number before comparing or skipping
  // (chatgpt-codex-connector #1688 P2: 'Validate metric values as finite').
  const metricChecks: ReadonlyArray<readonly [string, unknown]> = [
    ["incrementalUpdate.p50", report.incrementalUpdate?.p50],
    ["incrementalUpdate.p95", report.incrementalUpdate?.p95],
    ["incrementalModifiedUpdate.p50", report.incrementalModifiedUpdate?.p50],
    ["incrementalModifiedUpdate.p95", report.incrementalModifiedUpdate?.p95],
    ["tracePath.p95", report.tracePath?.p95],
    ["searchGraph.p95", report.searchGraph?.p95],
    ["fullIndexMs.ms", report.fullIndexMs?.ms],
    ["fullIndexLocsPerSecond", report.fullIndexLocsPerSecond],
    ["deadCodeMs.ms", report.deadCodeMs?.ms],
    ["dbBytesPerKloc", report.dbBytesPerKloc],
  ];
  const missingFields = metricChecks
    .filter(([, v]) => typeof v !== "number" || !Number.isFinite(v as number))
    .map(([k]) => k);
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

  // Baseline-side metric value guard: the report guard above only
  // validates report values. A corrupt baseline JSON could carry a
  // non-numeric metric (e.g. fullIndexLocsPerSecond: "oops") that reaches
  // the comparison loop where measVal / baseVal yields NaN, and NaN >
  // tolerance is false so the gate silently passes. The baseline is loaded
  // from JSON and carries the regression thresholds, so require every
  // PRESENT baseline metric to be a finite number. A metric that is simply
  // absent stays additive (skipped below), preserving the "keys present in
  // BOTH" contract — only a present non-number is corruption
  // (chatgpt-codex-connector #1688 P2: 'Validate baseline metrics').
  const badBaselineMetrics = (Object.keys(METRIC_DIRECTION) as RegressionMetricKey[])
    .filter((key) => {
      const v = baseline.metrics[key];
      return v != null && (typeof v !== "number" || !Number.isFinite(v as number));
    });
  if (badBaselineMetrics.length > 0) {
    return {
      passed: false,
      regressions: [],
      summary:
        "Baseline has a non-numeric required metric field(s): " +
        badBaselineMetrics.join(", ") +
        " — the baseline is corrupt. Regenerate it (#1688).",
    };
  }

  // Machine-fingerprint presence + field-type guard: a corrupt JSON report
  // or baseline may carry a null fingerprint OR a fingerprint with wrong-
  // typed fields (e.g. machine: {} or nodeVersion as a number).
  // compareMachineFingerprints → nodeMajor calls .replace on nodeVersion; a
  // non-string throws instead of returning the intended corrupt-artifact
  // failure. Reject both missing and wrong-typed fingerprints before
  // comparing (chatgpt-codex-connector #1688 P2: 'Validate fingerprint
  // field types').
  const reportFpBad = report.machine == null ? ["<missing>"] : invalidFingerprintFields(report.machine);
  const baselineFpBad = baseline.machine == null ? ["<missing>"] : invalidFingerprintFields(baseline.machine);
  if (reportFpBad.length > 0 || baselineFpBad.length > 0) {
    const which: string[] = [];
    if (reportFpBad.length > 0) which.push("report (" + reportFpBad.join(", ") + ")");
    if (baselineFpBad.length > 0) which.push("baseline (" + baselineFpBad.join(", ") + ")");
    return {
      passed: false,
      regressions: [],
      summary:
        "Report or baseline machine fingerprint is missing or has an invalid " +
        "field type(s): " + which.join("; ") +
        " — the artifact is incomplete or corrupt. Regenerate it (#1688).",
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
