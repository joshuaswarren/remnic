import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import {
  createEvalBaselineSnapshot,
  getEvalHarnessStatus,
  validateEvalBaselineSnapshot,
} from "../src/evals.js";

async function seedEvalStore(memoryDir: string): Promise<string> {
  const evalRoot = path.join(memoryDir, "state", "evals");
  const benchmarkDir = path.join(evalRoot, "benchmarks", "ama-memory");
  const runsDir = path.join(evalRoot, "runs", "2026-03-08");
  await mkdir(benchmarkDir, { recursive: true });
  await mkdir(runsDir, { recursive: true });

  await writeFile(
    path.join(benchmarkDir, "manifest.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        benchmarkId: "ama-memory",
        title: "AMA benchmark",
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
    path.join(runsDir, "ama-memory-latest.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        runId: "ama-memory-latest",
        benchmarkId: "ama-memory",
        status: "completed",
        startedAt: "2026-03-08T04:00:00.000Z",
        completedAt: "2026-03-08T04:05:00.000Z",
        totalCases: 2,
        passedCases: 2,
        failedCases: 0,
        metrics: {
          actionOutcomeScore: 0.91,
          objectiveStateCoverage: 0.83,
        },
        gitRef: "main",
      },
      null,
      2,
    ),
    "utf8",
  );

  return evalRoot;
}

test("createEvalBaselineSnapshot writes a typed snapshot of latest completed benchmark runs", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-eval-baseline-create-"));
  await seedEvalStore(memoryDir);

  const result = await createEvalBaselineSnapshot({
    memoryDir,
    baselineSnapshotsEnabled: true,
    snapshotId: "main-baseline",
    createdAt: "2026-03-08T04:10:00.000Z",
    gitRef: "main",
    notes: "Baseline after PR31.",
  });

  assert.equal(result.snapshot.snapshotId, "main-baseline");
  assert.equal(result.snapshot.benchmarkCount, 1);
  assert.equal(result.snapshot.gitRef, "main");
  assert.equal(result.snapshot.notes, "Baseline after PR31.");
  assert.equal(result.snapshot.benchmarks[0]?.benchmarkId, "ama-memory");
  assert.equal(result.snapshot.benchmarks[0]?.passRate, 1);
  assert.equal(result.snapshot.benchmarks[0]?.metrics?.actionOutcomeScore, 0.91);
  assert.equal(
    result.targetPath,
    path.join(memoryDir, "state", "evals", "baselines", "main-baseline.json"),
  );

  const validated = validateEvalBaselineSnapshot(result.snapshot);
  assert.equal(validated.benchmarks[0]?.runId, "ama-memory-latest");
});

test("createEvalBaselineSnapshot fails closed when baseline snapshots are disabled", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-eval-baseline-disabled-"));
  await seedEvalStore(memoryDir);

  await assert.rejects(
    () =>
      createEvalBaselineSnapshot({
        memoryDir,
        baselineSnapshotsEnabled: false,
        snapshotId: "disabled",
      }),
    /benchmark baseline snapshots are disabled/i,
  );
});

test("createEvalBaselineSnapshot reports snapshotId when the snapshot id is unsafe", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-eval-baseline-id-"));
  await seedEvalStore(memoryDir);

  await assert.rejects(
    () =>
      createEvalBaselineSnapshot({
        memoryDir,
        baselineSnapshotsEnabled: true,
        snapshotId: "bad/id",
      }),
    /snapshotId must be a safe path segment/i,
  );
});

test("benchmark-status reports baseline snapshot counts and latest baseline metadata", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-eval-baseline-status-"));
  await seedEvalStore(memoryDir);

  await createEvalBaselineSnapshot({
    memoryDir,
    baselineSnapshotsEnabled: true,
    snapshotId: "main-baseline",
    createdAt: "2026-03-08T04:10:00.000Z",
  });

  const status = await getEvalHarnessStatus({
    memoryDir,
    enabled: true,
    shadowModeEnabled: false,
    memoryRedTeamBenchEnabled: false,
    baselineSnapshotsEnabled: true,
  });

  assert.equal(status.baselines.enabled, true);
  assert.equal(status.baselines.total, 1);
  assert.equal(status.baselines.invalid, 0);
  assert.equal(status.baselines.latestSnapshotId, "main-baseline");
  assert.equal(status.baselines.latestCreatedAt, "2026-03-08T04:10:00.000Z");
  assert.equal(status.baselines.latestBenchmarkCount, 1);
  assert.equal(status.latestBaseline?.snapshotId, "main-baseline");
  assert.equal(status.invalidBaselines.length, 0);
});
