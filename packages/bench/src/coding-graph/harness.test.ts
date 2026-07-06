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

import {
  generateSyntheticRepo,
  runCodingGraphBenchmark,
  checkCodingGraphRegression,
  buildBaselineFromReport,
  extractMetrics,
  createSeededRng,
  DEFAULT_SMOKE_FIXTURE,
  CODING_GRAPH_BENCH_SCHEMA_VERSION,
  type CodingGraphBenchReport,
  type CodingGraphBaseline,
} from "./index.js";

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
  // Time metrics may vary, but the gate should be lenient enough for
  // back-to-back runs on the same machine.
  assert.ok(
    result.passed || result.regressions.every((r) => r.percentChange < 50),
    "natural variance should not trigger gross regression",
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
