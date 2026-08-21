import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { runBenchmarkBaselineReportCliCommand } from "../src/cli.js";
import { createEvalBaselineSnapshot } from "../src/evals.js";

async function writeBenchmarkStore(options: {
  rootDir: string;
  benchmarkId: string;
  passRate: { passed: number; failed: number; total: number };
  actionOutcomeScore?: number;
  trustViolationRate?: number;
  completedAt?: string;
}): Promise<void> {
  const benchmarkDir = path.join(options.rootDir, "benchmarks", options.benchmarkId);
  const runDir = path.join(options.rootDir, "runs", "2026-03-08");
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
    path.join(runDir, `${options.benchmarkId}-${options.passRate.passed}.json`),
    JSON.stringify(
      {
        schemaVersion: 1,
        runId: `${options.benchmarkId}-${options.passRate.passed}`,
        benchmarkId: options.benchmarkId,
        status: "completed",
        startedAt: "2026-03-08T08:00:00.000Z",
        completedAt: options.completedAt ?? "2026-03-08T08:05:00.000Z",
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
}

test("benchmark baseline report passes and emits markdown when candidate improves over stored baseline", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-eval-baseline-report-pass-"));
  const evalRoot = path.join(memoryDir, "state", "evals");

  await writeBenchmarkStore({
    rootDir: evalRoot,
    benchmarkId: "ama-memory",
    passRate: { passed: 7, failed: 3, total: 10 },
    actionOutcomeScore: 0.72,
    trustViolationRate: 0.08,
    completedAt: "2026-03-08T08:05:00.000Z",
  });

  await createEvalBaselineSnapshot({
    memoryDir,
    evalStoreDir: evalRoot,
    baselineSnapshotsEnabled: true,
    snapshotId: "release-2026-03-08",
    createdAt: "2026-03-08T08:06:00.000Z",
  });

  await writeBenchmarkStore({
    rootDir: evalRoot,
    benchmarkId: "ama-memory",
    passRate: { passed: 9, failed: 1, total: 10 },
    actionOutcomeScore: 0.89,
    trustViolationRate: 0.03,
    completedAt: "2026-03-08T09:05:00.000Z",
  });

  const report = await runBenchmarkBaselineReportCliCommand({
    memoryDir,
    evalStoreDir: evalRoot,
    benchmarkDeltaReporterEnabled: true,
    snapshotId: "release-2026-03-08",
  });

  assert.equal(report.passed, true);
  assert.equal(report.comparedBenchmarks, 1);
  assert.equal(report.baselineSnapshotId, "release-2026-03-08");
  assert.match(report.improvements.join("\n"), /pass rate improved/);
  assert.match(report.improvements.join("\n"), /actionOutcomeScore/);
  assert.match(report.improvements.join("\n"), /trustViolationRate/);
  assert.match(report.markdownReport, /# Eval Baseline Delta Report/);
  assert.match(report.markdownReport, /release-2026-03-08/);
  assert.match(report.markdownReport, /ama-memory: passRate 0.7 -> 0.9/);
});

test("benchmark baseline report fails on regressions, missing candidate benchmarks, and invalid baseline files", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-eval-baseline-report-fail-"));
  const evalRoot = path.join(memoryDir, "state", "evals");

  await writeBenchmarkStore({
    rootDir: evalRoot,
    benchmarkId: "ama-memory",
    passRate: { passed: 9, failed: 1, total: 10 },
    actionOutcomeScore: 0.91,
    trustViolationRate: 0.02,
    completedAt: "2026-03-08T08:05:00.000Z",
  });
  await writeBenchmarkStore({
    rootDir: evalRoot,
    benchmarkId: "objective-state",
    passRate: { passed: 8, failed: 2, total: 10 },
    actionOutcomeScore: 0.8,
    trustViolationRate: 0.04,
    completedAt: "2026-03-08T08:07:00.000Z",
  });

  await createEvalBaselineSnapshot({
    memoryDir,
    evalStoreDir: evalRoot,
    baselineSnapshotsEnabled: true,
    snapshotId: "release-2026-03-08",
  });

  await rm(path.join(evalRoot, "runs", "2026-03-08", "objective-state-8.json"));

  await writeBenchmarkStore({
    rootDir: evalRoot,
    benchmarkId: "ama-memory",
    passRate: { passed: 7, failed: 3, total: 10 },
    actionOutcomeScore: 0.7,
    trustViolationRate: 0.06,
    completedAt: "2026-03-08T09:05:00.000Z",
  });

  const brokenBaselineDir = path.join(evalRoot, "baselines");
  await mkdir(brokenBaselineDir, { recursive: true });
  await writeFile(path.join(brokenBaselineDir, "broken.json"), "{\"schemaVersion\":1}", "utf8");

  const report = await runBenchmarkBaselineReportCliCommand({
    memoryDir,
    evalStoreDir: evalRoot,
    benchmarkDeltaReporterEnabled: true,
    snapshotId: "release-2026-03-08",
  });

  assert.equal(report.passed, false);
  assert.deepEqual(report.missingCandidateBenchmarks, ["objective-state"]);
  assert.equal(report.invalidArtifacts.candidate.baselines, 1);
  assert.equal("baselineSnapshot" in report.invalidArtifacts, false);
  assert.match(report.regressions.join("\n"), /candidate is missing latest completed benchmark run for objective-state/);
  assert.match(report.regressions.join("\n"), /ama-memory pass rate regressed/);
  assert.match(report.regressions.join("\n"), /candidate store has 1 invalid baseline snapshot file/);
});

test("benchmark baseline report rejects disabled reporter flag", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-eval-baseline-report-disabled-"));

  await assert.rejects(
    () =>
      runBenchmarkBaselineReportCliCommand({
        memoryDir,
        benchmarkDeltaReporterEnabled: false,
        snapshotId: "release-2026-03-08",
      }),
    /benchmark delta reporter is disabled/,
  );
});

test("benchmark baseline report rejects unknown snapshot ids", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-eval-baseline-report-missing-"));
  const evalRoot = path.join(memoryDir, "state", "evals");
  await writeBenchmarkStore({
    rootDir: evalRoot,
    benchmarkId: "ama-memory",
    passRate: { passed: 8, failed: 2, total: 10 },
  });

  await assert.rejects(
    () =>
      runBenchmarkBaselineReportCliCommand({
        memoryDir,
        evalStoreDir: evalRoot,
        benchmarkDeltaReporterEnabled: true,
        snapshotId: "missing-snapshot",
      }),
    /benchmark baseline snapshot not found: missing-snapshot/,
  );
});
