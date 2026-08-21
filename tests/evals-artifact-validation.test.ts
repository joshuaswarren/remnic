import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";

import {
  runEvalBenchmarkCiGate,
  validateEvalBaselineSnapshot,
  validateEvalRunSummary,
} from "../src/evals.js";

function validRun(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    runId: "run-001",
    benchmarkId: "ama-memory",
    status: "completed",
    startedAt: "2026-03-07T08:00:00.000Z",
    completedAt: "2026-03-07T08:05:00.000Z",
    totalCases: 2,
    passedCases: 1,
    failedCases: 1,
    ...overrides,
  };
}

test("eval run summary rejects impossible counts and malformed timestamps", () => {
  for (const [overrides, message] of [
    [{ totalCases: 1.5 }, /totalCases must be a non-negative integer/],
    [{ passedCases: 1.5 }, /passedCases must be a non-negative integer/],
    [{ failedCases: Number.POSITIVE_INFINITY }, /failedCases must be a non-negative integer/],
    [{ totalCases: 1, passedCases: 2, failedCases: 0 }, /passedCases \+ failedCases/],
    [{ startedAt: "not-a-date" }, /startedAt must be a valid ISO timestamp/],
    [{ completedAt: "also-not-a-date" }, /completedAt must be a valid ISO timestamp/],
  ] as const) {
    assert.throws(
      () => validateEvalRunSummary(validRun(overrides)),
      message,
      `overrides ${JSON.stringify(overrides)} should be rejected`,
    );
  }
});

test("eval baseline snapshot rejects malformed createdAt and completedAt timestamps", () => {
  const snapshot = {
    schemaVersion: 1,
    snapshotId: "baseline-001",
    createdAt: "2026-03-08T13:20:00.000Z",
    sourceRootDir: "/tmp/evals",
    benchmarkCount: 1,
    benchmarks: [
      {
        benchmarkId: "ama-memory",
        runId: "run-001",
        completedAt: "2026-03-07T08:05:00.000Z",
        passRate: 1,
      },
    ],
  };

  assert.throws(
    () => validateEvalBaselineSnapshot({ ...snapshot, createdAt: "not-a-date" }),
    /createdAt must be a valid ISO timestamp/,
  );
  assert.throws(
    () =>
      validateEvalBaselineSnapshot({
        ...snapshot,
        benchmarks: [{ ...snapshot.benchmarks[0], completedAt: "also-not-a-date" }],
      }),
    /benchmarks\[0\]\.completedAt must be a valid ISO timestamp/,
  );
});

test("eval CI gate excludes invalid run summaries from comparisons", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "remnic-eval-invalid-runs-"));
  const baseDir = path.join(tempRoot, "base");
  const candidateDir = path.join(tempRoot, "candidate");
  await mkdir(path.join(baseDir, "runs"), { recursive: true });
  await mkdir(path.join(candidateDir, "runs"), { recursive: true });

  await writeFile(
    path.join(baseDir, "runs", "ama-memory.json"),
    JSON.stringify(validRun({ totalCases: 1, passedCases: 1, failedCases: 0 }), null, 2),
    "utf8",
  );
  await writeFile(
    path.join(candidateDir, "runs", "ama-memory.json"),
    JSON.stringify(
      validRun({
        totalCases: 1,
        passedCases: 2,
        failedCases: 0,
        startedAt: "not-a-date",
        completedAt: "also-not-a-date",
      }),
      null,
      2,
    ),
    "utf8",
  );

  const report = await runEvalBenchmarkCiGate({
    baseEvalStoreDir: baseDir,
    candidateEvalStoreDir: candidateDir,
  });

  assert.equal(report.comparedBenchmarks, 0);
  assert.deepEqual(report.missingCandidateBenchmarks, ["ama-memory"]);
  assert.equal(report.invalidArtifacts.candidate.runs, 1);
  assert.match(report.regressions.join("\n"), /invalid run summary file/);
});
