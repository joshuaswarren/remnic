import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { runBenchmarkStatusCliCommand } from "../src/cli.js";

test("benchmark-status reports empty eval store safely", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-evals-empty-"));

  const status = await runBenchmarkStatusCliCommand({
    memoryDir,
    evalHarnessEnabled: false,
    evalShadowModeEnabled: false,
    benchmarkBaselineSnapshotsEnabled: false,
    memoryRedTeamBenchEnabled: false,
  });

  assert.equal(status.enabled, false);
  assert.equal(status.shadowModeEnabled, false);
  assert.equal(status.benchmarks.total, 0);
  assert.equal(status.runs.total, 0);
  assert.equal(status.shadows.total, 0);
  assert.equal(status.baselines.total, 0);
  assert.deepEqual(status.invalidBenchmarks, []);
});

test("benchmark-status summarizes valid manifests, invalid manifests, and latest run", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-evals-status-"));
  const evalRoot = path.join(memoryDir, "state", "evals");
  const benchmarkDir = path.join(evalRoot, "benchmarks", "ama-memory");
  const invalidDir = path.join(evalRoot, "benchmarks", "broken-pack");
  const runsDir = path.join(evalRoot, "runs");
  await mkdir(benchmarkDir, { recursive: true });
  await mkdir(invalidDir, { recursive: true });
  await mkdir(runsDir, { recursive: true });
  const shadowDir = path.join(evalRoot, "shadow", "2026-03-06");
  await mkdir(shadowDir, { recursive: true });

  await writeFile(
    path.join(benchmarkDir, "manifest.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        benchmarkId: "ama-memory",
        title: "AMA-style agent memory harness",
        tags: ["trajectory", "objective-state"],
        sourceLinks: ["https://arxiv.org/abs/2602.22769"],
        cases: [
          {
            id: "case-1",
            prompt: "Resume the broken deployment and explain what changed.",
            expectedSignals: ["objective-state", "causal-trajectory"],
          },
          {
            id: "case-2",
            prompt: "Recover the last created artifact and the next follow-up action.",
            expectedSignals: ["creation-memory", "recoverability"],
          },
        ],
      },
      null,
      2,
    ),
    "utf8",
  );

  await writeFile(path.join(invalidDir, "manifest.json"), "{\"schemaVersion\":1}", "utf8");

  await writeFile(
    path.join(runsDir, "run-001.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        runId: "run-001",
        benchmarkId: "ama-memory",
        status: "completed",
        startedAt: "2026-03-06T10:00:00.000Z",
        completedAt: "2026-03-06T10:02:00.000Z",
        totalCases: 2,
        passedCases: 1,
        failedCases: 1,
        metrics: {
          actionOutcomeScore: 0.75,
          objectiveStateCoverage: 0.5,
        },
      },
      null,
      2,
    ),
    "utf8",
  );
  await writeFile(path.join(runsDir, "run-bad.json"), "{\"schemaVersion\":1}", "utf8");
  await writeFile(
    path.join(shadowDir, "trace-001.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        traceId: "trace-001",
        recordedAt: "2026-03-06T10:03:00.000Z",
        sessionKey: "agent:main",
        promptHash: "abc123",
        promptLength: 42,
        retrievalQueryHash: "def456",
        retrievalQueryLength: 42,
        recallMode: "full",
        recallResultLimit: 4,
        source: "hot_qmd",
        recalledMemoryCount: 2,
        injected: true,
        contextChars: 240,
        memoryIds: ["mem-1", "mem-2"],
        durationMs: 22,
      },
      null,
      2,
    ),
    "utf8",
  );
  await writeFile(path.join(shadowDir, "trace-bad.json"), "{\"schemaVersion\":1}", "utf8");

  const status = await runBenchmarkStatusCliCommand({
    memoryDir,
    evalHarnessEnabled: true,
    evalShadowModeEnabled: true,
    benchmarkBaselineSnapshotsEnabled: false,
    memoryRedTeamBenchEnabled: false,
  });

  assert.equal(status.enabled, true);
  assert.equal(status.shadowModeEnabled, true);
  assert.equal(status.benchmarks.total, 2);
  assert.equal(status.benchmarks.valid, 1);
  assert.equal(status.benchmarks.invalid, 1);
  assert.equal(status.benchmarks.redTeam, 0);
  assert.equal(status.benchmarks.totalCases, 2);
  assert.deepEqual(status.benchmarks.attackClasses, []);
  assert.deepEqual(status.benchmarks.targetSurfaces, []);
  assert.deepEqual(status.benchmarks.tags, ["objective-state", "trajectory"]);
  assert.equal(status.runs.total, 2);
  assert.equal(status.runs.invalid, 1);
  assert.equal(status.runs.completed, 1);
  assert.equal(status.runs.failed, 0);
  assert.equal(status.shadows.total, 2);
  assert.equal(status.shadows.invalid, 1);
  assert.equal(status.baselines.total, 0);
  assert.equal(status.baselines.invalid, 0);
  assert.equal(status.shadows.latestTraceId, "trace-001");
  assert.equal(status.shadows.latestRecordedAt, "2026-03-06T10:03:00.000Z");
  assert.equal(status.shadows.latestSessionKey, "agent:main");
  assert.equal(status.runs.latestRunId, "run-001");
  assert.equal(status.runs.latestBenchmarkId, "ama-memory");
  assert.equal(status.runs.latestCompletedAt, "2026-03-06T10:02:00.000Z");
  assert.ok(status.latestRun);
  assert.ok(status.latestShadow);
  assert.deepEqual(status.latestShadow?.memoryIds, ["mem-1", "mem-2"]);
  assert.equal(status.latestRun?.metrics?.actionOutcomeScore, 0.75);
  assert.equal(status.invalidBenchmarks.length, 1);
  assert.match(status.invalidBenchmarks[0]?.error ?? "", /cases must be an array/i);
  assert.equal(status.invalidRuns.length, 1);
  assert.equal(path.basename(status.invalidRuns[0]?.path ?? ""), "run-bad.json");
  assert.match(status.invalidRuns[0]?.error ?? "", /must be a non-empty string/i);
  assert.equal(status.invalidShadows.length, 1);
  assert.equal(path.basename(status.invalidShadows[0]?.path ?? ""), "trace-bad.json");
});
