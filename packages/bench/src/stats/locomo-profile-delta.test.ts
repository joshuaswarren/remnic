import assert from "node:assert/strict";
import test from "node:test";

import type { BenchmarkArtifact } from "../published-artifact.js";
import {
  diagnoseLoComoProfileDelta,
  renderLoComoProfileDeltaMarkdown,
} from "./locomo-profile-delta.js";

function artifact(
  tasks: Array<{ taskId: string; f1: number; category?: string }>,
  overrides: Partial<BenchmarkArtifact> = {},
): BenchmarkArtifact {
  return {
    schemaVersion: 1,
    benchmarkId: "locomo",
    datasetVersion: "locomo-10",
    system: { name: "remnic", version: "1.0.0", gitSha: "abc123" },
    model: "responder",
    seed: 1,
    startedAt: "2026-07-14T00:00:00.000Z",
    finishedAt: "2026-07-14T00:01:00.000Z",
    durationMs: 60_000,
    env: { node: "v22.0.0", os: "linux" },
    tier: "frontier",
    metrics: {
      f1: tasks.reduce((sum, task) => sum + task.f1, 0) / tasks.length,
      llm_judge: tasks.reduce((sum, task) => sum + task.f1, 0) / tasks.length,
    },
    perTaskScores: tasks.map((task) => ({
      taskId: task.taskId,
      scores: { f1: task.f1, llm_judge: task.f1 },
      ...(task.category ? { category: task.category } : {}),
    })),
    ...overrides,
  };
}

function evidence(value: BenchmarkArtifact, reference: string) {
  return { artifact: value, reference, sha256: reference.repeat(64).slice(0, 64) };
}

test("joins identical tasks, derives LoCoMo categories, and decomposes the delta", () => {
  const baseline = artifact([
    { taskId: "conv-1-q0-single_hop", f1: 0.5 },
    { taskId: "conv-1-q1-multi_hop", f1: 1 },
    { taskId: "conv-1-q2-multi_hop", f1: 0.5 },
  ]);
  const real = artifact([
    { taskId: "conv-1-q2-multi_hop", f1: 0 },
    { taskId: "conv-1-q0-single_hop", f1: 1 },
    { taskId: "conv-1-q1-multi_hop", f1: 0 },
  ]);

  const report = diagnoseLoComoProfileDelta({
    baseline: evidence(baseline, "b"),
    real: evidence(real, "r"),
  });

  assert.equal(report.taskCount, 3);
  assert.equal(report.primaryMetric, "llm_judge");
  assert.deepEqual(report.categories.map((entry) => entry.category), [
    "single_hop",
    "multi_hop",
  ]);
  assert.ok(Math.abs(report.overall.f1!.delta - (-1 / 3)) < 1e-12);
  assert.ok(Math.abs(
    report.categories.reduce(
      (sum, category) => sum + category.metrics.f1!.aggregateContribution,
      0,
    ) - report.overall.f1!.delta,
  ) < 1e-12);
  assert.deepEqual(report.topRegressions.map((task) => task.taskId), [
    "conv-1-q1-multi_hop",
    "conv-1-q2-multi_hop",
  ]);
  assert.equal(report.evidenceBoundary.recallRootCause, "requires-paired-recall-receipts");
});

test("uses an explicit artifact category before the task-id suffix", () => {
  const baseline = artifact([{ taskId: "opaque-task", f1: 1, category: "custom" }]);
  const real = artifact([{ taskId: "opaque-task", f1: 0, category: "custom" }]);
  const report = diagnoseLoComoProfileDelta({
    baseline: evidence(baseline, "b"),
    real: evidence(real, "r"),
  });
  assert.equal(report.categories[0]?.category, "custom");
});

test("allows the judge-independent f1 metric to override the llm_judge default", () => {
  const baseline = artifact([{ taskId: "conv-1-q0-single_hop", f1: 1 }]);
  const real = artifact([{ taskId: "conv-1-q0-single_hop", f1: 0 }]);
  const report = diagnoseLoComoProfileDelta({
    baseline: evidence(baseline, "b"),
    real: evidence(real, "r"),
    primaryMetric: "f1",
  });
  assert.equal(report.primaryMetric, "f1");
});

test("rejects mismatched task sets, duplicate ids, and incomparable run metadata", () => {
  const baseline = artifact([{ taskId: "conv-1-q0-single_hop", f1: 1 }]);
  assert.throws(
    () => diagnoseLoComoProfileDelta({
      baseline: evidence(baseline, "b"),
      real: evidence(artifact([{ taskId: "conv-1-q1-single_hop", f1: 1 }]), "r"),
    }),
    /identical task-id sets/,
  );
  assert.throws(
    () => diagnoseLoComoProfileDelta({
      baseline: evidence(baseline, "b"),
      real: evidence(artifact([
        { taskId: "conv-1-q0-single_hop", f1: 1 },
        { taskId: "conv-1-q0-single_hop", f1: 1 },
      ]), "r"),
    }),
    /duplicate task id/,
  );
  assert.throws(
    () => diagnoseLoComoProfileDelta({
      baseline: evidence(baseline, "b"),
      real: evidence(artifact(
        [{ taskId: "conv-1-q0-single_hop", f1: 1 }],
        { seed: 2 },
      ), "r"),
    }),
    /seed differs/,
  );
});

test("rejects inconsistent published aggregates instead of diagnosing corrupted evidence", () => {
  const baseline = artifact(
    [{ taskId: "conv-1-q0-single_hop", f1: 1 }],
    { metrics: { f1: 0 } },
  );
  const real = artifact([{ taskId: "conv-1-q0-single_hop", f1: 1 }]);
  assert.throws(
    () => diagnoseLoComoProfileDelta({
      baseline: evidence(baseline, "b"),
      real: evidence(real, "r"),
    }),
    /does not match its per-task mean/,
  );
});

test("markdown rendering is deterministic and labels the recall evidence boundary", () => {
  const baseline = artifact([{ taskId: "conv-1-q0-single_hop", f1: 1 }]);
  const real = artifact([{ taskId: "conv-1-q0-single_hop", f1: 0 }]);
  const report = diagnoseLoComoProfileDelta({
    baseline: evidence(baseline, "b"),
    real: evidence(real, "r"),
    primaryMetric: "f1",
  });
  const first = renderLoComoProfileDeltaMarkdown(report);
  const second = renderLoComoProfileDeltaMarkdown(report);
  assert.equal(first, second);
  assert.match(first, /single_hop \| 1 \| 1\.0000 \| 0\.0000 \| -1\.0000/);
  assert.match(first, /score artifacts alone do not identify what recall tier served/);
});
