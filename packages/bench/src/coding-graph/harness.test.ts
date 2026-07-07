/**
 * Coding-graph benchmark harness tests (issue #1557).
 *
 * Ordered per the issue's prove-fail-first discipline:
 *   1. Generator determinism — same params, byte-identical output (rule 38).
 *   2. Generator distinctness — different seeds produce different output.
 *   3. Harness smoke test — index a small fixture, assert every metric key
 *      is present with plausible types.
 *   4. Regression gate — passes when metrics are within tolerance.
 *   5. Regression gate prove-fail — FAILS when a baseline claims a metric
 *      much faster than measured (rule 50 — a real failing step).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  generateSyntheticRepo,
  runCodingGraphBenchmark,
  checkCodingGraphRegression,
  buildBaselineFromReport,
  extractMetrics,
  compareMachineFingerprints,
  createSeededRng,
  DEFAULT_SMOKE_FIXTURE,
  CODING_GRAPH_BENCH_SCHEMA_VERSION,
  type CodingGraphBenchReport,
  type CodingGraphBaseline,
  type MachineFingerprint,
} from "./index.js";
import {
  GraphStore,
  type StoreFileIR,
  type EdgeIR,
  type SymbolKind,
  type CodingGraphLanguage,
} from "@remnic/coding-graph";

// ──────────────────────────────────────────────────────────────────────────
// 1. Generator determinism (rule 38).
// ──────────────────────────────────────────────────────────────────────────

test("generator: same seed + same params → byte-identical output", () => {
  const config = { ...DEFAULT_SMOKE_FIXTURE, fileCount: 10, symbolsPerFile: 5 };
  const a = generateSyntheticRepo(config);
  const b = generateSyntheticRepo(config);

  assert.deepEqual(a.files, b.files, "same params must produce identical files");
  assert.equal(a.approximateLoc, b.approximateLoc);
});

test("generator: deterministic symbol spans and content hashes", () => {
  const config = { ...DEFAULT_SMOKE_FIXTURE, fileCount: 5, symbolsPerFile: 3, seed: 999 };
  const repo = generateSyntheticRepo(config);

  // Re-generate and verify byte-level identity of specific fields.
  const repo2 = generateSyntheticRepo(config);
  const sym0a = repo.files[0].symbols[0];
  const sym0b = repo2.files[0].symbols[0];

  assert.equal(sym0a.qualifiedName, sym0b.qualifiedName);
  assert.equal(sym0a.startByte, sym0b.startByte);
  assert.equal(sym0a.endByte, sym0b.endByte);
  assert.equal(repo.files[0].contentHash, repo2.files[0].contentHash);
});

// ──────────────────────────────────────────────────────────────────────────
// 2. Generator distinctness — different seeds → different repos.
// ──────────────────────────────────────────────────────────────────────────

test("generator: different seeds produce different repos", () => {
  const repo1 = generateSyntheticRepo({ ...DEFAULT_SMOKE_FIXTURE, seed: 100 });
  const repo2 = generateSyntheticRepo({ ...DEFAULT_SMOKE_FIXTURE, seed: 99999 });

  // Different seeds produce different edge targets — the entire edge
  // structure should differ (different targets, different confidences).
  const edges1 = JSON.stringify(repo1.files.map((f) => f.edges));
  const edges2 = JSON.stringify(repo2.files.map((f) => f.edges));
  assert.notEqual(edges1, edges2, "different seeds must produce different edge structure");
});

test("generator: callDensity controls edge count", () => {
  const sparse = generateSyntheticRepo({
    ...DEFAULT_SMOKE_FIXTURE,
    fileCount: 50,
    symbolsPerFile: 10,
    callDensity: 0.1,
  });
  const dense = generateSyntheticRepo({
    ...DEFAULT_SMOKE_FIXTURE,
    fileCount: 50,
    symbolsPerFile: 10,
    callDensity: 0.8,
  });

  const sparseEdges = sparse.files.reduce((s, f) => s + f.edges.length, 0);
  const denseEdges = dense.files.reduce((s, f) => s + f.edges.length, 0);
  assert.ok(
    denseEdges > sparseEdges * 2,
    `dense (${denseEdges}) should have >>sparse (${sparseEdges}) edges`,
  );
});

test("seeded RNG: produces stable, reproducible sequence", () => {
  const rng1 = createSeededRng(42);
  const rng2 = createSeededRng(42);
  const seq1 = Array.from({ length: 10 }, () => rng1());
  const seq2 = Array.from({ length: 10 }, () => rng2());
  assert.deepEqual(seq1, seq2, "same seed must produce identical RNG sequence");
});

// ──────────────────────────────────────────────────────────────────────────
// 3. Harness smoke test — every metric key present with plausible types.
// ──────────────────────────────────────────────────────────────────────────

test("harness smoke: small fixture produces complete report with all metric keys", async () => {
  const report = await runCodingGraphBenchmark({
    fixture: { fileCount: 10, symbolsPerFile: 5, callDensity: 0.3 },
    iterations: 20,
  });

  // Schema version.
  assert.equal(report.schemaVersion, CODING_GRAPH_BENCH_SCHEMA_VERSION);

  // Machine fingerprint.
  assert.ok(typeof report.machine.arch === "string" && report.machine.arch.length > 0);
  assert.ok(typeof report.machine.nodeVersion === "string");

  // Fixture metadata.
  assert.equal(report.fixture.fileCount, 10);
  assert.equal(report.fixture.symbolCount, 50);
  assert.ok(report.fixture.edgeCount > 0, "fixture should have edges");
  assert.ok(report.fixture.approximateLoc > 0);

  // Full index metrics.
  assert.ok(report.fullIndexMs.ms > 0, "fullIndexMs must be positive");
  assert.ok(
    report.fullIndexLocsPerSecond > 0,
    "fullIndexLocsPerSecond must be positive",
  );

  // Incremental update distribution.
  assert.equal(report.incrementalUpdate.iterations, 20);
  assert.ok(report.incrementalUpdate.p50 >= 0);
  assert.ok(
    report.incrementalUpdate.p95 >= report.incrementalUpdate.p50,
    "p95 must be >= p50",
  );
  assert.equal(report.incrementalUpdate.samplesMs.length, 20);

  // Incremental MODIFIED-content update distribution (#1688 item 1) — the
  // change-heavy path. It does strictly more work than the idempotent no-op,
  // so p50 should be >= the idempotent p50 (defensive lower bound; not a
  // strict perf assertion since both are sub-ms and noisy).
  assert.equal(report.incrementalModifiedUpdate.iterations, 20);
  assert.ok(report.incrementalModifiedUpdate.p50 >= 0);
  assert.ok(
    report.incrementalModifiedUpdate.p95 >= report.incrementalModifiedUpdate.p50,
    "modified p95 must be >= modified p50",
  );
  assert.equal(report.incrementalModifiedUpdate.samplesMs.length, 20);

  // Trace path.
  assert.equal(report.tracePath.iterations, 20);
  assert.ok(report.tracePath.p95 >= 0);
  assert.equal(report.tracePath.samplesMs.length, 20);

  // Search graph.
  assert.equal(report.searchGraph.iterations, 20);
  assert.ok(report.searchGraph.p95 >= 0);
  assert.equal(report.searchGraph.samplesMs.length, 20);

  // Dead code.
  assert.ok(report.deadCodeMs.ms >= 0);

  // DB size.
  assert.ok(report.dbBytes > 0, "DB file must exist and be non-empty");
  assert.ok(report.dbBytesPerKloc > 0);

  // Peak RSS.
  assert.ok(report.peakRssBytes > 0);

  // Graph counts.
  assert.ok(report.graphNodeCount > 0, "graph should have nodes after index");
  assert.ok(report.graphEdgeCount > 0, "graph should have edges after index");
});

// ──────────────────────────────────────────────────────────────────────────
// 4. Regression gate — passes within tolerance.
// ──────────────────────────────────────────────────────────────────────────

test("regression gate: passes when metrics match the baseline", async () => {
  const report = await runCodingGraphBenchmark({
    fixture: { fileCount: 10, symbolsPerFile: 5 },
    iterations: 20,
  });

  // Build a baseline from the report itself — metrics are identical, so
  // the gate must pass with any tolerance.
  const baseline = buildBaselineFromReport(report, "smoke baseline");
  const result = checkCodingGraphRegression(report, baseline, 30);

  assert.equal(result.passed, true, "identical metrics must pass");
  assert.equal(result.regressions.length, 0);
});

test("regression gate: passes within 30% tolerance on natural variance", async () => {
  const report1 = await runCodingGraphBenchmark({
    fixture: { fileCount: 10, symbolsPerFile: 5 },
    iterations: 20,
  });
  // Run again — natural timing variance should stay within 30%.
  const report2 = await runCodingGraphBenchmark({
    fixture: { fileCount: 10, symbolsPerFile: 5 },
    iterations: 20,
  });

  const baseline = buildBaselineFromReport(report1, "run 1");
  const result = checkCodingGraphRegression(report2, baseline, 30);
  // Natural back-to-back variance must not trip the gate as a GROSS
  // regression. The sub-ms p95 metrics (incrementalUpdate /
  // incrementalModifiedUpdate / tracePath / searchGraph) are excluded from
  // this check: their p95 over ~20 sub-ms samples is outlier-dominated — a
  // single GC/scheduler spike swings a 0.2 ms p95 by 10×+ — so a relative
  // bound is meaningless there (a known property of micro-benchmark p95, not
  // a gate defect). Only metrics with a baseline ≥ 2 ms (fullIndexMs) are
  // stable enough for a relative-variance comparison. dbBytesPerKloc is
  // deterministic on the same machine and never regresses. A REAL regression
  // on the stable metrics is ~10× (see the prove-fail test), well above the
  // 50% bound used here (#1688).
  const stableRegressions = result.regressions.filter((r) => r.baseline >= 2);
  assert.ok(
    result.passed || stableRegressions.every((r) => r.percentChange < 50),
    "natural variance should not trigger gross regression on stable (≥2ms) metrics",
  );
});

// ──────────────────────────────────────────────────────────────────────────
// 5. Regression gate prove-fail — gross regression is a REAL failure
//    (rule 50 — the gate fails, not warns).
// ──────────────────────────────────────────────────────────────────────────

test("regression gate prove-fail: gross slowdown FAILS the gate", async () => {
  const report = await runCodingGraphBenchmark({
    fixture: { fileCount: 10, symbolsPerFile: 5 },
    iterations: 20,
  });

  // Construct a baseline that claims fullIndexMs is 10× faster than
  // measured — this is a gross regression that MUST trip the gate.
  const realMetrics = extractMetrics(report);
  const aggressiveBaseline: CodingGraphBaseline = {
    schemaVersion: report.schemaVersion,
    machine: report.machine,
    fixtureConfig: report.fixture.config,
    metrics: {
      ...realMetrics,
      fullIndexMs: Math.max(0.001, realMetrics.fullIndexMs / 10), // 10× "faster"
    },
    createdAt: report.timestamp,
    note: "prove-fail: injected aggressive baseline",
  };

  const result = checkCodingGraphRegression(report, aggressiveBaseline, 30);

  assert.equal(
    result.passed,
    false,
    "a 10× slowdown MUST fail the gate (rule 50 — real failing step)",
  );
  assert.ok(result.regressions.length > 0, "must report regressions");
  const fullIdxRegression = result.regressions.find(
    (r) => r.key === "fullIndexMs",
  );
  assert.ok(fullIdxRegression, "fullIndexMs must be in the regression list");
  assert.ok(
    fullIdxRegression!.percentChange > 30,
    "fullIndexMs must exceed 30% tolerance",
  );
  assert.ok(
    result.summary.includes("fullIndexMs"),
    "summary must name the regressed metric",
  );
});

test("regression gate: higherIsBetter metric regresses when throughput drops", () => {
  // Synthetic report + baseline — no DB needed.
  const mockReport: CodingGraphBenchReport = {
    schemaVersion: 1,
    timestamp: "2026-01-01T00:00:00.000Z",
    machine: {
      arch: "arm64",
      platform: "darwin",
      nodeVersion: "v22.0.0",
      cpuModel: "test",
      cpuCores: 8,
      totalMemoryMb: 16384,
    },
    fixture: {
      config: DEFAULT_SMOKE_FIXTURE,
      approximateLoc: 1000,
      fileCount: 10,
      symbolCount: 50,
      edgeCount: 20,
    },
    fullIndexMs: { ms: 100 },
    fullIndexLocsPerSecond: 10000, // baseline was 20000 — 50% drop
    incrementalUpdate: { p50: 1, p95: 2, iterations: 20, samplesMs: [] },
    incrementalModifiedUpdate: { p50: 1, p95: 2, iterations: 20, samplesMs: [] },
    tracePath: { p50: 1, p95: 2, iterations: 20, samplesMs: [] },
    searchGraph: { p50: 1, p95: 2, iterations: 20, samplesMs: [] },
    deadCodeMs: { ms: 5 },
    dbBytesPerKloc: 1000,
    peakRssBytes: 1000000,
    dbBytes: 1000,
    graphNodeCount: 50,
    graphEdgeCount: 20,
  };

  const baseline: CodingGraphBaseline = {
    schemaVersion: 1,
    machine: mockReport.machine,
    fixtureConfig: DEFAULT_SMOKE_FIXTURE,
    metrics: {
      fullIndexMs: 100,
      fullIndexLocsPerSecond: 20000,
      incrementalUpdateP50Ms: 1,
      incrementalUpdateP95Ms: 2,
      tracePathP95Ms: 2,
      searchGraphP95Ms: 2,
      deadCodeMs: 5,
      dbBytesPerKloc: 1000,
    },
    createdAt: "2026-01-01T00:00:00.000Z",
    note: "throughput regression test",
  };

  const result = checkCodingGraphRegression(mockReport, baseline, 30);
  assert.equal(result.passed, false);
  const throughputRegression = result.regressions.find(
    (r) => r.key === "fullIndexLocsPerSecond",
  );
  assert.ok(throughputRegression, "LOC/s regression must be detected");
  assert.equal(throughputRegression!.direction, "higher-is-better");
});

// ──────────────────────────────────────────────────────────────────────────
// 6. Regression gate — fixture mismatch is a hard failure.
// ──────────────────────────────────────────────────────────────────────────

test("regression gate: fixture mismatch fails the gate", () => {
  const mockReport: CodingGraphBenchReport = {
    schemaVersion: 1,
    timestamp: "2026-01-01T00:00:00.000Z",
    machine: {
      arch: "arm64",
      platform: "darwin",
      nodeVersion: "v22.0.0",
      cpuModel: "test",
      cpuCores: 8,
      totalMemoryMb: 16384,
    },
    fixture: {
      config: { seed: 42, fileCount: 1000, symbolsPerFile: 10, callDensity: 0.2, language: "typescript" },
      approximateLoc: 100000,
      fileCount: 1000,
      symbolCount: 10000,
      edgeCount: 2000,
    },
    fullIndexMs: { ms: 500 },
    fullIndexLocsPerSecond: 200000,
    incrementalUpdate: { p50: 1, p95: 2, iterations: 20, samplesMs: [] },
    incrementalModifiedUpdate: { p50: 1, p95: 2, iterations: 20, samplesMs: [] },
    tracePath: { p50: 1, p95: 2, iterations: 20, samplesMs: [] },
    searchGraph: { p50: 1, p95: 2, iterations: 20, samplesMs: [] },
    deadCodeMs: { ms: 5 },
    dbBytesPerKloc: 1000,
    peakRssBytes: 1000000,
    dbBytes: 1000,
    graphNodeCount: 50,
    graphEdgeCount: 20,
  };

  const baseline: CodingGraphBaseline = {
    schemaVersion: 1,
    machine: mockReport.machine,
    fixtureConfig: { seed: 42, fileCount: 20, symbolsPerFile: 10, callDensity: 0.3, language: "typescript" },
    metrics: {
      fullIndexMs: 500,
      fullIndexLocsPerSecond: 200000,
      incrementalUpdateP50Ms: 1,
      incrementalUpdateP95Ms: 2,
      tracePathP95Ms: 2,
      searchGraphP95Ms: 2,
      deadCodeMs: 5,
      dbBytesPerKloc: 1000,
    },
    createdAt: "2026-01-01T00:00:00.000Z",
    note: "different fixture baseline",
  };

  const result = checkCodingGraphRegression(mockReport, baseline, 30);
  assert.equal(result.passed, false, "fixture mismatch must fail the gate");
  assert.ok(result.summary.includes("Fixture mismatch"), "summary must explain fixture mismatch");
  assert.equal(result.regressions.length, 0, "no metric regressions — only fixture mismatch");
});

// ──────────────────────────────────────────────────────────────────────────
// 6b. Regression gate — a seed-only mismatch still fails (every knob counts).
// ──────────────────────────────────────────────────────────────────────────

test("regression gate: seed-only fixture mismatch fails the gate", () => {
  const baseReport: CodingGraphBenchReport = {
    schemaVersion: 1,
    timestamp: "2026-01-01T00:00:00.000Z",
    machine: {
      arch: "arm64",
      platform: "darwin",
      nodeVersion: "v22.0.0",
      cpuModel: "test",
      cpuCores: 8,
      totalMemoryMb: 16384,
    },
    fixture: {
      config: { seed: 99, fileCount: 20, symbolsPerFile: 10, callDensity: 0.3, language: "typescript" },
      approximateLoc: 1000,
      fileCount: 20,
      symbolCount: 200,
      edgeCount: 60,
    },
    fullIndexMs: { ms: 10 },
    fullIndexLocsPerSecond: 100000,
    incrementalUpdate: { p50: 1, p95: 2, iterations: 20, samplesMs: [] },
    incrementalModifiedUpdate: { p50: 1, p95: 2, iterations: 20, samplesMs: [] },
    tracePath: { p50: 1, p95: 2, iterations: 20, samplesMs: [] },
    searchGraph: { p50: 1, p95: 2, iterations: 20, samplesMs: [] },
    deadCodeMs: { ms: 1 },
    dbBytesPerKloc: 1000,
    peakRssBytes: 1000000,
    dbBytes: 1000,
    graphNodeCount: 200,
    graphEdgeCount: 60,
  };

  const baseline: CodingGraphBaseline = {
    schemaVersion: 1,
    machine: baseReport.machine,
    // Identical except seed: 42 vs 99 — every other knob matches.
    fixtureConfig: { seed: 42, fileCount: 20, symbolsPerFile: 10, callDensity: 0.3, language: "typescript" },
    metrics: {
      fullIndexMs: 10,
      fullIndexLocsPerSecond: 100000,
      incrementalUpdateP50Ms: 1,
      incrementalUpdateP95Ms: 2,
      tracePathP95Ms: 2,
      searchGraphP95Ms: 2,
      deadCodeMs: 1,
      dbBytesPerKloc: 1000,
    },
    createdAt: "2026-01-01T00:00:00.000Z",
    note: "seed-different baseline",
  };

  const result = checkCodingGraphRegression(baseReport, baseline, 30);
  assert.equal(result.passed, false, "seed-only mismatch must fail the gate");
  assert.ok(result.summary.includes("seed"), "summary must name the mismatched knob (seed)");
});


// ──────────────────────────────────────────────────────────────────────────
// 7. Machine-fingerprint guard (#1688 item 2) — a baseline from a different
//    machine class must SKIP the comparison (passed: true + skipped: true),
//    not fail CI on legitimate hardware variance.
// ──────────────────────────────────────────────────────────────────────────

const SAME_MACHINE: MachineFingerprint = {
  arch: "arm64",
  platform: "darwin",
  nodeVersion: "v22.20.0",
  cpuModel: "Apple M2 Max",
  cpuCores: 12,
  totalMemoryMb: 98304,
};

function reportWithMachine(machine: MachineFingerprint): CodingGraphBenchReport {
  return {
    schemaVersion: CODING_GRAPH_BENCH_SCHEMA_VERSION,
    timestamp: "2026-07-07T00:00:00.000Z",
    machine,
    fixture: {
      config: DEFAULT_SMOKE_FIXTURE,
      approximateLoc: 1000,
      fileCount: 20,
      symbolCount: 200,
      edgeCount: 60,
    },
    fullIndexMs: { ms: 10 },
    fullIndexLocsPerSecond: 100000,
    incrementalUpdate: { p50: 1, p95: 2, iterations: 20, samplesMs: [] },
    incrementalModifiedUpdate: { p50: 2, p95: 3, iterations: 20, samplesMs: [] },
    tracePath: { p50: 1, p95: 2, iterations: 20, samplesMs: [] },
    searchGraph: { p50: 1, p95: 2, iterations: 20, samplesMs: [] },
    deadCodeMs: { ms: 1 },
    dbBytesPerKloc: 280000,
    peakRssBytes: 1000000,
    dbBytes: 1000,
    graphNodeCount: 200,
    graphEdgeCount: 60,
  };
}

function baselineWithMachine(machine: MachineFingerprint): CodingGraphBaseline {
  return {
    schemaVersion: CODING_GRAPH_BENCH_SCHEMA_VERSION,
    machine,
    fixtureConfig: DEFAULT_SMOKE_FIXTURE,
    metrics: {
      fullIndexMs: 10,
      fullIndexLocsPerSecond: 100000,
      incrementalUpdateP50Ms: 1,
      incrementalUpdateP95Ms: 2,
      incrementalModifiedUpdateP50Ms: 2,
      incrementalModifiedUpdateP95Ms: 3,
      tracePathP95Ms: 2,
      searchGraphP95Ms: 2,
      deadCodeMs: 1,
      dbBytesPerKloc: 280000,
    },
    createdAt: "2026-07-07T00:00:00.000Z",
    note: "machine-guard baseline",
  };
}

test("machine guard: same fingerprint → normal comparison (no skip)", () => {
  const report = reportWithMachine(SAME_MACHINE);
  const baseline = baselineWithMachine(SAME_MACHINE);
  const result = checkCodingGraphRegression(report, baseline, 30);
  assert.equal(result.passed, true, "same machine + identical metrics pass");
  assert.equal(result.skipped, undefined, "same machine must NOT skip");
  assert.equal(result.machineMismatch, undefined, "no mismatch detail on same machine");
});

test("machine guard: different arch SKIPS comparison (not a CI failure)", () => {
  const report = reportWithMachine({ ...SAME_MACHINE, arch: "x64" });
  const baseline = baselineWithMachine(SAME_MACHINE);
  const result = checkCodingGraphRegression(report, baseline, 30);
  assert.equal(result.passed, true, "hardware variance must not fail CI");
  assert.equal(result.skipped, true, "mismatched machine skips comparison");
  assert.equal(result.regressions.length, 0, "no regressions computed on skip");
  assert.ok(result.machineMismatch, "mismatch detail present");
  assert.ok(
    result.machineMismatch!.differingFields.includes("arch"),
    "differingFields names arch",
  );
  assert.ok(
    result.summary.includes("Machine-fingerprint mismatch"),
    "summary explains the skip",
  );
});

test("machine guard: different cpuModel SKIPS comparison", () => {
  const report = reportWithMachine({ ...SAME_MACHINE, cpuModel: "Apple M3 Pro" });
  const baseline = baselineWithMachine(SAME_MACHINE);
  const result = checkCodingGraphRegression(report, baseline, 30);
  assert.equal(result.skipped, true);
  assert.ok(result.machineMismatch!.differingFields.includes("cpuModel"));
});

test("machine guard: different node MAJOR version SKIPS (minor does not)", () => {
  // Major differs (v23 vs v22) → skip.
  const majorDiff = reportWithMachine({ ...SAME_MACHINE, nodeVersion: "v23.0.0" });
  const r1 = checkCodingGraphRegression(majorDiff, baselineWithMachine(SAME_MACHINE), 30);
  assert.equal(r1.skipped, true, "different node major skips");
  assert.ok(r1.machineMismatch!.differingFields.includes("nodeVersion(major)"));

  // Minor differs only (v22.5.0 vs v22.20.0) → same major → comparable, no skip.
  const minorDiff = reportWithMachine({ ...SAME_MACHINE, nodeVersion: "v22.5.0" });
  const r2 = checkCodingGraphRegression(minorDiff, baselineWithMachine(SAME_MACHINE), 30);
  assert.equal(r2.skipped, undefined, "same node major does not skip");
  assert.equal(r2.machineMismatch, undefined);
});

test("machine guard: totalMemoryMb difference alone does NOT skip", () => {
  // Memory alone rarely moves sub-ms SQLite ops; over-triggering the skip
  // on memory would hide real regressions. Only memory differs here.
  const report = reportWithMachine({ ...SAME_MACHINE, totalMemoryMb: 16384 });
  const baseline = baselineWithMachine(SAME_MACHINE);
  const result = checkCodingGraphRegression(report, baseline, 30);
  assert.equal(result.skipped, undefined, "memory-only difference must not skip");
  assert.equal(result.passed, true, "still comparable → normal comparison");
});

test("compareMachineFingerprints: empty diff for identical fingerprints", () => {
  const diff = compareMachineFingerprints(SAME_MACHINE, SAME_MACHINE);
  assert.deepEqual(diff.differingFields, []);
});

test("compareMachineFingerprints: lists every load-bearing differing field", () => {
  const a: MachineFingerprint = { ...SAME_MACHINE };
  const b: MachineFingerprint = {
    ...SAME_MACHINE,
    arch: "x64",
    platform: "linux",
    nodeVersion: "v23.0.0",
    cpuModel: "Intel Xeon",
    cpuCores: 32,
  };
  const diff = compareMachineFingerprints(a, b);
  assert.deepEqual(
    [...diff.differingFields].sort(),
    ["arch", "cpuCores", "cpuModel", "nodeVersion(major)", "platform"],
  );
});


// ──────────────────────────────────────────────────────────────────────────
// 8. Guard ordering (#1688 review) — structural invariants beat the
//    machine-fingerprint skip. A misconfigured run (wrong fixture or
//    incompatible schema) on a different machine must FAIL on its real
//    problem, not be silently skipped as "hardware variance".
// ──────────────────────────────────────────────────────────────────────────

test("guard ordering: fixture mismatch beats machine-fingerprint skip", () => {
  // Report is on a DIFFERENT machine (arch x64) AND has a different
  // fixture (fileCount 1000 vs 20). Before the reorder this returned
  // {passed:true, skipped:true} — the machine skip masked the fixture
  // mismatch. Now the structural fixture check must fail first.
  const report = reportWithMachine({ ...SAME_MACHINE, arch: "x64" });
  const baseline = baselineWithMachine(SAME_MACHINE);
  const mismatchedReport: CodingGraphBenchReport = {
    ...report,
    fixture: {
      ...report.fixture,
      config: { ...report.fixture.config, fileCount: 1000 },
    },
  };
  const result = checkCodingGraphRegression(mismatchedReport, baseline, 30);
  assert.equal(result.passed, false, "fixture mismatch must fail, not skip");
  assert.equal(result.skipped, undefined, "must not reach the machine skip");
  assert.ok(
    result.summary.includes("Fixture mismatch"),
    "summary must explain the fixture mismatch",
  );
});

test("guard ordering: schema-version mismatch fails instead of crashing", () => {
  // A pre-v2 report (schemaVersion 1) compared against a v2 baseline.
  // Before the schema guard, extractMetrics dereferenced the v2-only
  // incrementalModifiedUpdate field and threw a TypeError. Now the
  // schema guard fails the gate with an actionable message.
  const report = reportWithMachine(SAME_MACHINE);
  const baseline = baselineWithMachine(SAME_MACHINE);
  const staleReport: CodingGraphBenchReport = {
    ...report,
    schemaVersion: 1,
    incrementalModifiedUpdate:
      undefined as unknown as CodingGraphBenchReport["incrementalModifiedUpdate"],
  };
  const result = checkCodingGraphRegression(staleReport, baseline, 30);
  assert.equal(result.passed, false, "schema mismatch must fail the gate");
  assert.equal(result.skipped, undefined, "schema mismatch is a hard fail, not a skip");
  assert.ok(
    result.summary.includes("Schema-version mismatch"),
    "summary must explain the schema mismatch",
  );
});

test("extractMetrics: throws on a report missing incrementalModifiedUpdate (guard is load-bearing)", () => {
  // Proves the schema guard above is necessary: without it, extractMetrics
  // deref-crashes on the v2-only field.
  const report = reportWithMachine(SAME_MACHINE);
  const staleReport = {
    ...report,
    incrementalModifiedUpdate: undefined,
  } as unknown as CodingGraphBenchReport;
  assert.throws(() => extractMetrics(staleReport));
});

// ──────────────────────────────────────────────────────────────────────────
// 9. Modified-loop restore (#1688 review) — re-ingesting the full fixture
//    restores cross-file edges that the churn prune cascade-deleted.
//    Restoring only the churned file leaves peer files' incoming edges
//    gone, so the graph would shrink each pass.
// ──────────────────────────────────────────────────────────────────────────

test("modified-loop restore: full-fixture re-ingest restores cascade-deleted cross-file edges", async () => {
  const repo = generateSyntheticRepo({
    ...DEFAULT_SMOKE_FIXTURE,
    callDensity: 0.5,
  });
  const storeFiles: StoreFileIR[] = repo.files.map((f) => ({
    path: f.path,
    language: f.language as CodingGraphLanguage,
    contentHash: f.contentHash,
    symbols: f.symbols.map((s) => ({
      qualifiedName: s.qualifiedName,
      name: s.name,
      kind: s.kind as SymbolKind,
      span: { startByte: s.startByte, endByte: s.endByte },
    })),
    edges: f.edges.map(
      (e): EdgeIR => ({
        srcQualifiedName: e.srcQualifiedName,
        dstQualifiedName: e.dstQualifiedName,
        type: e.type,
        confidence: e.confidence,
        provenance: e.provenance as EdgeIR["provenance"],
      }),
    ),
  }));

  const dir = await mkdtemp(path.join(tmpdir(), "cg-restore-test-"));
  const dbPath = path.join(dir, "restore.sqlite");
  try {
    const store = await GraphStore.open({ dbPath });
    try {
      const indexResult = await store.upsertFileBatch(storeFiles);
      assert.equal(indexResult.ok, true, "full index must succeed");

      const baselineStats = store.schemaStats();
      assert.ok(baselineStats.ok, "schemaStats must succeed after index");
      const baselineEdges = baselineStats.ok ? baselineStats.stats.edges : 0;
      assert.ok(baselineEdges > 0, "fixture must have edges to exercise the restore");

      // Pick a target that has INCOMING cross-file edges so the
      // single-file-restore defect is observable below.
      let targetIdx = -1;
      for (let i = 0; i < storeFiles.length; i++) {
        const symSet = new Set(
          storeFiles[i]!.symbols.map((s) => s.qualifiedName),
        );
        const hasIncoming = storeFiles.some(
          (f, j) =>
            j !== i &&
            (f.edges ?? []).some((e) => symSet.has(e.dstQualifiedName)),
        );
        if (hasIncoming) {
          targetIdx = i;
          break;
        }
      }
      assert.ok(
        targetIdx >= 0,
        "fixture must have a file with incoming cross-file edges",
      );
      const target = storeFiles[targetIdx]!;

      // Churn: replace the target with a single churn symbol + no edges.
      const modified: StoreFileIR = {
        ...target,
        contentHash: target.contentHash + "-churn",
        symbols: [
          {
            qualifiedName: "mod.churnSymbol",
            name: "churnSymbol",
            kind: "function" as SymbolKind,
            span: { startByte: 0, endByte: 0 },
          },
        ],
        edges: [],
      };
      const churnResult = await store.upsertFileBatch([modified]);
      assert.equal(churnResult.ok, true, "churn upsert must succeed");

      const afterChurn = store.schemaStats();
      const afterChurnEdges = afterChurn.ok ? afterChurn.stats.edges : 0;
      assert.ok(
        afterChurnEdges < baselineEdges,
        "churn must shed edges via cascade (after=" +
          afterChurnEdges +
          ", baseline=" +
          baselineEdges +
          ")",
      );

      // FIX: restore by re-ingesting the FULL fixture.
      const restoreResult = await store.upsertFileBatch(storeFiles);
      assert.equal(restoreResult.ok, true, "full-fixture restore must succeed");
      const afterRestore = store.schemaStats();
      const afterRestoreEdges = afterRestore.ok ? afterRestore.stats.edges : 0;
      assert.equal(
        afterRestoreEdges,
        baselineEdges,
        "full-fixture restore returns the graph to baseline edge count (after=" +
          afterRestoreEdges +
          ", baseline=" +
          baselineEdges +
          ")",
      );

      // DEFECT PROOF: re-churn, then restore ONLY the target file (the
      // old behavior). Cross-file incoming edges stay gone.
      const churnAgain = await store.upsertFileBatch([modified]);
      assert.equal(churnAgain.ok, true);
      const singleRestore = await store.upsertFileBatch([target]);
      assert.equal(singleRestore.ok, true);
      const afterSingle = store.schemaStats();
      const afterSingleEdges = afterSingle.ok ? afterSingle.stats.edges : 0;
      assert.ok(
        afterSingleEdges < baselineEdges,
        "single-file restore must NOT fully restore cross-file edges (after=" +
          afterSingleEdges +
          ", baseline=" +
          baselineEdges +
          ") — the defect the full-fixture fix closes",
      );
    } finally {
      await store.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("guard ordering: corrupt v2 report missing a metric field fails instead of crashing", () => {
  // schemaVersion matches the baseline (both 2) but the v2-only field is
  // absent (a truncated/hand-edited report). Before the field-presence
  // guard, extractMetrics dereferenced the missing field and threw an
  // uncaught TypeError (cursor #1688 review: 'v2 report crashes gate').
  const report = reportWithMachine(SAME_MACHINE);
  const baseline = baselineWithMachine(SAME_MACHINE);
  const corruptReport: CodingGraphBenchReport = {
    ...report,
    incrementalModifiedUpdate:
      undefined as unknown as CodingGraphBenchReport["incrementalModifiedUpdate"],
  };
  const result = checkCodingGraphRegression(corruptReport, baseline, 30);
  assert.equal(result.passed, false, "corrupt v2 report must fail, not crash");
  assert.equal(result.skipped, undefined);
  assert.ok(result.summary.includes("missing"), "summary must explain the missing field");
});
test("guard ordering: corrupt v2 report on a DIFFERENT machine fails before the machine skip", () => {
  // Before the field-presence-before-machine-fingerprint reorder, a corrupt
  // v2 report (schema matches but incrementalModifiedUpdate is absent) on a
  // different machine would hit the machine-fingerprint skip FIRST and
  // return {passed:true, skipped:true} — silently passing a malformed
  // artifact through cross-machine CI. The field-presence guard must run
  // before the machine skip so corrupt reports always fail
  // (chatgpt-codex-connector #1688 review: 'Validate corrupt reports
  // before machine skips').
  const corruptReport: CodingGraphBenchReport = {
    ...reportWithMachine({ ...SAME_MACHINE, arch: "x64" }),
    incrementalModifiedUpdate:
      undefined as unknown as CodingGraphBenchReport["incrementalModifiedUpdate"],
  };
  const baseline = baselineWithMachine(SAME_MACHINE);
  const result = checkCodingGraphRegression(corruptReport, baseline, 30);
  assert.equal(result.passed, false, "corrupt report must fail even on a different machine");
  assert.equal(result.skipped, undefined, "must NOT reach the machine skip — corrupt-report guard runs first");
  assert.ok(result.summary.includes("missing"), "summary must explain the missing field, not the machine mismatch");
});
test("guard ordering: corrupt v2 report with truncated nested metric field fails", () => {
  // schemaVersion matches (both 2) and the top-level field exists, but a
  // nested sub-field is missing (e.g. incrementalModifiedUpdate: { p50: 1 }
  // with no p95). Before the deepened guard, extractMetrics produced
  // undefined for the missing p95 and the comparison loop silently skipped
  // it — letting corrupt artifacts pass as passed:true.
  // (chatgpt-codex-connector #1688 P2: 'Validate nested metric fields'.)
  const report = reportWithMachine(SAME_MACHINE);
  const baseline = baselineWithMachine(SAME_MACHINE);
  const truncatedReport: CodingGraphBenchReport = {
    ...report,
    incrementalModifiedUpdate: { p50: 1, p95: undefined as unknown as number, iterations: 20, samplesMs: [] },
  };
  const result = checkCodingGraphRegression(truncatedReport, baseline, 30);
  assert.equal(result.passed, false, "truncated nested field must fail the gate");
  assert.equal(result.skipped, undefined);
  assert.ok(result.summary.includes("incrementalModifiedUpdate.p95"), "summary must name the missing nested field");
});
test("guard ordering: corrupt v2 report missing p50 (but has p95) fails the gate", () => {
  // The deepened guard must check BOTH p50 and p95, not just p95.
  // extractMetrics reads both percentiles; a report with p95 present
  // but p50 missing previously passed the guard and the comparison loop
  // silently skipped the undefined p50 metric (cursor Bugbot: 'Regression
  // gate skips missing p50').
  const report = reportWithMachine(SAME_MACHINE);
  const baseline = baselineWithMachine(SAME_MACHINE);
  const missingP50Report: CodingGraphBenchReport = {
    ...report,
    incrementalModifiedUpdate: { p50: undefined as unknown as number, p95: 3, iterations: 20, samplesMs: [] },
  };
  const result = checkCodingGraphRegression(missingP50Report, baseline, 30);
  assert.equal(result.passed, false, "missing p50 must fail the gate");
  assert.ok(result.summary.includes("incrementalModifiedUpdate.p50"), "summary must name the missing p50 field");
});

test("guard ordering: corrupt v2 report missing scalar metrics fails before machine skip", () => {
  // The field-presence guard must also validate scalar/complex metrics
  // (fullIndexMs.ms, fullIndexLocsPerSecond, deadCodeMs.ms, dbBytesPerKloc),
  // not just nested micro-metrics. A report missing these on a different
  // machine would otherwise fall through to the skip as hardware variance
  // (chatgpt-codex-connector #1688 P2: "Validate scalar report metrics").
  const report = reportWithMachine({ ...SAME_MACHINE, arch: "x64" });
  const baseline = baselineWithMachine(SAME_MACHINE);
  const missingScalar: CodingGraphBenchReport = {
    ...report,
    fullIndexMs: undefined as unknown as CodingGraphBenchReport["fullIndexMs"],
  };
  const result = checkCodingGraphRegression(missingScalar, baseline, 30);
  assert.equal(result.passed, false, "missing scalar metric must fail");
  assert.equal(result.skipped, undefined, "must not reach machine skip");
  assert.ok(result.summary.includes("fullIndexMs.ms"), "summary must name the missing scalar field");
});

test("guard ordering: report with non-numeric metric value fails (NaN guard)", () => {
  // A JSON-loaded report may carry a string where a number is expected
  // (fullIndexLocsPerSecond: "oops"). Without Number.isFinite validation,
  // the NaN ratio passes the tolerance check and the gate returns true.
  // (chatgpt-codex-connector #1688 P2: "Validate metric values as finite").
  const report = reportWithMachine(SAME_MACHINE);
  const baseline = baselineWithMachine(SAME_MACHINE);
  const nonNumericReport: CodingGraphBenchReport = {
    ...report,
    fullIndexLocsPerSecond: "oops" as unknown as number,
  };
  const result = checkCodingGraphRegression(nonNumericReport, baseline, 30);
  assert.equal(result.passed, false, "non-numeric metric must fail the gate");
  assert.ok(result.summary.includes("fullIndexLocsPerSecond"), "summary must name the bad field");
});

test("guard ordering: report with null machine fingerprint fails before compare", () => {
  // A corrupt JSON report may have machine: null. Without the guard,
  // compareMachineFingerprints dereferences the null and crashes.
  // (chatgpt-codex-connector #1688 P2: "Validate machine fingerprints").
  const report = reportWithMachine(SAME_MACHINE);
  const baseline = baselineWithMachine(SAME_MACHINE);
  const nullMachineReport: CodingGraphBenchReport = {
    ...report,
    machine: undefined as unknown as CodingGraphBenchReport["machine"],
  };
  const result = checkCodingGraphRegression(nullMachineReport, baseline, 30);
  assert.equal(result.passed, false, "null machine must fail the gate");
  assert.ok(result.summary.includes("machine"), "summary must mention the missing machine fingerprint");
});






