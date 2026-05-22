import assert from "node:assert/strict";
import test from "node:test";

import type { ResolvedRunBenchmarkOptions } from "../../../types.js";
import {
  contradictionDetectionDefinition,
  runContradictionDetectionBenchmark,
} from "./runner.js";
import {
  CONTRADICTION_DETECTION_FIXTURE,
  CONTRADICTION_DETECTION_SMOKE_FIXTURE,
} from "./fixture.js";

function buildOptions(
  overrides: Partial<ResolvedRunBenchmarkOptions> = {},
): ResolvedRunBenchmarkOptions {
  return {
    benchmark: {
      ...contradictionDetectionDefinition,
      run: runContradictionDetectionBenchmark,
    },
    mode: "full",
    ...overrides,
  } as ResolvedRunBenchmarkOptions;
}

test("contradictionDetectionDefinition has the expected shape", () => {
  assert.equal(contradictionDetectionDefinition.id, "contradiction-detection");
  assert.equal(contradictionDetectionDefinition.tier, "remnic");
  assert.equal(contradictionDetectionDefinition.runnerAvailable, true);
  assert.equal(contradictionDetectionDefinition.meta.category, "retrieval");
});

test("runContradictionDetectionBenchmark produces tasks per fixture case plus aggregate", async () => {
  const result = await runContradictionDetectionBenchmark(
    buildOptions({ mode: "full" }),
  );
  // 19 cases + 1 aggregate task
  assert.equal(
    result.results.tasks.length,
    CONTRADICTION_DETECTION_FIXTURE.length + 1,
  );
  for (const task of result.results.tasks) {
    assert.ok(typeof task.scores === "object");
  }
});

test("runContradictionDetectionBenchmark includes per-verdict metrics", async () => {
  const result = await runContradictionDetectionBenchmark(
    buildOptions({ mode: "full" }),
  );
  const agg = result.results.tasks.find(
    (t) => t.taskId === "_aggregate_verdict_metrics",
  );
  assert.ok(agg, "aggregate task must exist");
  assert.ok(typeof agg.scores.precision_contradicts === "number");
  assert.ok(typeof agg.scores.recall_contradicts === "number");
  assert.ok(typeof agg.scores.f1_contradicts === "number");
  assert.ok(typeof agg.scores.precision_duplicates === "number");
  assert.ok(typeof agg.scores.recall_independent === "number");
  assert.ok(typeof agg.scores.overall_accuracy === "number");
});

test("runContradictionDetectionBenchmark emits per-task completion callbacks", async () => {
  const progress: Array<{ taskId: string; completedCount: number; totalCount: number }> = [];
  await runContradictionDetectionBenchmark(
    buildOptions({
      mode: "full",
      onTaskComplete(task, completedCount, totalCount) {
        progress.push({ taskId: task.taskId, completedCount, totalCount });
      },
    }),
  );

  assert.equal(progress.length, CONTRADICTION_DETECTION_FIXTURE.length);
  assert.ok(!progress.some((entry) => entry.taskId === "_aggregate_verdict_metrics"));
  for (let i = 0; i < progress.length; i++) {
    assert.equal(progress[i]!.completedCount, i + 1);
    assert.equal(progress[i]!.totalCount, CONTRADICTION_DETECTION_FIXTURE.length);
  }
});

test("runContradictionDetectionBenchmark quick mode runs the smoke subset", async () => {
  const full = await runContradictionDetectionBenchmark(
    buildOptions({ mode: "full" }),
  );
  const quick = await runContradictionDetectionBenchmark(
    buildOptions({ mode: "quick" }),
  );
  assert.ok(quick.results.tasks.length < full.results.tasks.length);
  assert.ok(quick.results.tasks.length > 0);
});

test("runContradictionDetectionBenchmark rejects invalid limit", async () => {
  await assert.rejects(() =>
    runContradictionDetectionBenchmark(buildOptions({ limit: -1 })),
  );
  await assert.rejects(() =>
    runContradictionDetectionBenchmark(buildOptions({ limit: 0 })),
  );
});

test("runContradictionDetectionBenchmark deterministic — no tokens consumed", async () => {
  const result = await runContradictionDetectionBenchmark(
    buildOptions({ mode: "full" }),
  );
  assert.equal(result.cost.totalTokens, 0);
  assert.equal(result.cost.inputTokens, 0);
  assert.equal(result.cost.outputTokens, 0);
});
