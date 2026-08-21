import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { runBenchmarkCiGateCliCommand, runBenchmarkStoredBaselineCiGateCliCommand } from "../src/cli.js";
import { createEvalBaselineSnapshot, runEvalBenchmarkCiGate } from "../src/evals.js";

async function writeBenchmarkStore(options: {
  rootDir: string;
  benchmarkId: string;
  passRate: { passed: number; failed: number; total: number };
  actionOutcomeScore?: number;
  trustViolationRate?: number;
  includeInvalidShadow?: boolean;
}): Promise<void> {
  const benchmarkDir = path.join(options.rootDir, "benchmarks", options.benchmarkId);
  const runDir = path.join(options.rootDir, "runs", "2026-03-07");
  await mkdir(benchmarkDir, { recursive: true });
  await mkdir(runDir, { recursive: true });

  await writeFile(
    path.join(benchmarkDir, "manifest.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        benchmarkId: options.benchmarkId,
        title: `Benchmark ${options.benchmarkId}`,
        cases: [
          { id: "case-1", prompt: "Prompt 1" },
          { id: "case-2", prompt: "Prompt 2" },
        ],
      },
      null,
      2,
    ),
    "utf8",
  );

  await writeFile(
    path.join(runDir, `${options.benchmarkId}-latest.json`),
    JSON.stringify(
      {
        schemaVersion: 1,
        runId: `${options.benchmarkId}-latest`,
        benchmarkId: options.benchmarkId,
        status: "completed",
        startedAt: "2026-03-07T08:00:00.000Z",
        completedAt: "2026-03-07T08:05:00.000Z",
        totalCases: options.passRate.total,
        passedCases: options.passRate.passed,
        failedCases: options.passRate.failed,
        metrics: {
          actionOutcomeScore: options.actionOutcomeScore,
          trustViolationRate: options.trustViolationRate,
        },
      },
      null,
      2,
    ),
    "utf8",
  );

  if (options.includeInvalidShadow) {
    const shadowDir = path.join(options.rootDir, "shadow", "2026-03-07");
    await mkdir(shadowDir, { recursive: true });
    await writeFile(path.join(shadowDir, "broken.json"), "{\"schemaVersion\":1}", "utf8");
  }
}

async function writeRequiredBaselineSnapshot(options: {
  rootDir: string;
  snapshotId: string;
  gitRef?: string;
}): Promise<void> {
  await createEvalBaselineSnapshot({
    memoryDir: options.rootDir,
    evalStoreDir: options.rootDir,
    baselineSnapshotsEnabled: true,
    snapshotId: options.snapshotId,
    createdAt: "2026-03-08T13:20:00.000Z",
    gitRef: options.gitRef ?? "main",
    notes: "Required CI baseline snapshot",
  });
}

test("benchmark CI gate passes when candidate improves pass rate and metrics", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "engram-eval-ci-pass-"));
  const baseDir = path.join(tempRoot, "base");
  const candidateDir = path.join(tempRoot, "candidate");

  await writeBenchmarkStore({
    rootDir: baseDir,
    benchmarkId: "ama-memory",
    passRate: { passed: 7, failed: 3, total: 10 },
    actionOutcomeScore: 0.72,
    trustViolationRate: 0.08,
  });
  await writeBenchmarkStore({
    rootDir: candidateDir,
    benchmarkId: "ama-memory",
    passRate: { passed: 9, failed: 1, total: 10 },
    actionOutcomeScore: 0.88,
    trustViolationRate: 0.03,
  });

  const report = await runBenchmarkCiGateCliCommand({
    baseEvalStoreDir: baseDir,
    candidateEvalStoreDir: candidateDir,
  });

  assert.equal(report.passed, true);
  assert.equal(report.comparedBenchmarks, 1);
  assert.equal(report.regressions.length, 0);
  assert.match(report.improvements.join("\n"), /pass rate improved/);
  assert.match(report.improvements.join("\n"), /actionOutcomeScore/);
  assert.match(report.improvements.join("\n"), /trustViolationRate/);
});

test("benchmark CI gate fails when candidate regresses or drops a benchmark", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "engram-eval-ci-fail-"));
  const baseDir = path.join(tempRoot, "base");
  const candidateDir = path.join(tempRoot, "candidate");

  await writeBenchmarkStore({
    rootDir: baseDir,
    benchmarkId: "ama-memory",
    passRate: { passed: 9, failed: 1, total: 10 },
    actionOutcomeScore: 0.9,
    trustViolationRate: 0.02,
  });
  await writeBenchmarkStore({
    rootDir: baseDir,
    benchmarkId: "objective-state",
    passRate: { passed: 8, failed: 2, total: 10 },
    actionOutcomeScore: 0.75,
    trustViolationRate: 0.05,
  });
  await writeBenchmarkStore({
    rootDir: candidateDir,
    benchmarkId: "ama-memory",
    passRate: { passed: 7, failed: 3, total: 10 },
    actionOutcomeScore: 0.7,
    trustViolationRate: 0.06,
  });

  const report = await runBenchmarkCiGateCliCommand({
    baseEvalStoreDir: baseDir,
    candidateEvalStoreDir: candidateDir,
  });

  assert.equal(report.passed, false);
  assert.deepEqual(report.missingCandidateBenchmarks, ["objective-state"]);
  assert.match(report.regressions.join("\n"), /candidate is missing latest completed benchmark run/);
  assert.match(report.regressions.join("\n"), /ama-memory pass rate regressed/);
  assert.match(report.regressions.join("\n"), /actionOutcomeScore/);
  assert.match(report.regressions.join("\n"), /trustViolationRate/);
});

test("benchmark CI gate fails on invalid candidate eval artifacts", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "engram-eval-ci-invalid-"));
  const baseDir = path.join(tempRoot, "base");
  const candidateDir = path.join(tempRoot, "candidate");

  await writeBenchmarkStore({
    rootDir: baseDir,
    benchmarkId: "ama-memory",
    passRate: { passed: 8, failed: 2, total: 10 },
  });
  await writeBenchmarkStore({
    rootDir: candidateDir,
    benchmarkId: "ama-memory",
    passRate: { passed: 8, failed: 2, total: 10 },
    includeInvalidShadow: true,
  });

  const report = await runBenchmarkCiGateCliCommand({
    baseEvalStoreDir: baseDir,
    candidateEvalStoreDir: candidateDir,
  });

  assert.equal(report.passed, false);
  assert.equal(report.invalidArtifacts.candidate.shadows, 1);
  assert.match(report.regressions.join("\n"), /candidate store has 1 invalid shadow record/);
});

test("benchmark CI gate accepts explicit eval store dirs without memory dirs", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "engram-eval-ci-store-only-"));
  const baseDir = path.join(tempRoot, "base-store");
  const candidateDir = path.join(tempRoot, "candidate-store");

  await writeBenchmarkStore({
    rootDir: baseDir,
    benchmarkId: "ama-memory",
    passRate: { passed: 8, failed: 2, total: 10 },
    actionOutcomeScore: 0.8,
  });
  await writeBenchmarkStore({
    rootDir: candidateDir,
    benchmarkId: "ama-memory",
    passRate: { passed: 9, failed: 1, total: 10 },
    actionOutcomeScore: 0.9,
  });

  const report = await runEvalBenchmarkCiGate({
    baseEvalStoreDir: baseDir,
    candidateEvalStoreDir: candidateDir,
  });

  assert.equal(report.passed, true);
  assert.equal(report.baseRootDir, baseDir);
  assert.equal(report.candidateRootDir, candidateDir);
});

test("stored baseline CI gate passes when candidate improves over the required main snapshot", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "engram-eval-baseline-ci-pass-"));
  const baseDir = path.join(tempRoot, "base");
  const candidateDir = path.join(tempRoot, "candidate");

  await writeBenchmarkStore({
    rootDir: baseDir,
    benchmarkId: "ama-memory",
    passRate: { passed: 8, failed: 2, total: 10 },
    actionOutcomeScore: 0.81,
    trustViolationRate: 0.03,
  });
  await writeRequiredBaselineSnapshot({
    rootDir: baseDir,
    snapshotId: "required-main",
  });
  await writeBenchmarkStore({
    rootDir: candidateDir,
    benchmarkId: "ama-memory",
    passRate: { passed: 9, failed: 1, total: 10 },
    actionOutcomeScore: 0.9,
    trustViolationRate: 0.02,
  });

  const report = await runBenchmarkStoredBaselineCiGateCliCommand({
    baseEvalStoreDir: baseDir,
    candidateEvalStoreDir: candidateDir,
    snapshotId: "required-main",
  });

  assert.equal(report.passed, true);
  assert.equal(report.baseRootDir, baseDir);
  assert.equal(report.baselineSnapshotId, "required-main");
  assert.equal(report.baselineResolvedFrom, "base");
  assert.match(report.improvements.join("\n"), /pass rate improved/i);
});

test("stored baseline CI gate fails when candidate regresses against the required main snapshot", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "engram-eval-baseline-ci-fail-"));
  const baseDir = path.join(tempRoot, "base");
  const candidateDir = path.join(tempRoot, "candidate");

  await writeBenchmarkStore({
    rootDir: baseDir,
    benchmarkId: "ama-memory",
    passRate: { passed: 8, failed: 2, total: 10 },
    actionOutcomeScore: 0.81,
    trustViolationRate: 0.03,
  });
  await writeRequiredBaselineSnapshot({
    rootDir: baseDir,
    snapshotId: "required-main",
  });
  await writeBenchmarkStore({
    rootDir: candidateDir,
    benchmarkId: "ama-memory",
    passRate: { passed: 7, failed: 3, total: 10 },
    actionOutcomeScore: 0.7,
    trustViolationRate: 0.06,
  });

  const report = await runBenchmarkStoredBaselineCiGateCliCommand({
    baseEvalStoreDir: baseDir,
    candidateEvalStoreDir: candidateDir,
    snapshotId: "required-main",
  });

  assert.equal(report.passed, false);
  assert.equal(report.baseRootDir, baseDir);
  assert.equal(report.baselineResolvedFrom, "base");
  assert.match(report.regressions.join("\n"), /pass rate regressed/i);
  assert.match(report.regressions.join("\n"), /actionOutcomeScore/i);
});

test("stored baseline CI gate bootstraps from candidate snapshot when base has not adopted it yet", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "engram-eval-baseline-ci-bootstrap-"));
  const baseDir = path.join(tempRoot, "base");
  const candidateDir = path.join(tempRoot, "candidate");

  await writeBenchmarkStore({
    rootDir: candidateDir,
    benchmarkId: "ama-memory",
    passRate: { passed: 8, failed: 2, total: 10 },
    actionOutcomeScore: 0.81,
    trustViolationRate: 0.03,
  });
  await writeRequiredBaselineSnapshot({
    rootDir: candidateDir,
    snapshotId: "required-main",
  });

  const report = await runBenchmarkStoredBaselineCiGateCliCommand({
    baseEvalStoreDir: baseDir,
    candidateEvalStoreDir: candidateDir,
    snapshotId: "required-main",
  });

  assert.equal(report.passed, true);
  assert.equal(report.baselineResolvedFrom, "candidate");
  assert.equal(report.baselineSnapshotId, "required-main");
});
