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

test("runContradictionDetectionBenchmark produces tasks only for real fixture cases", async () => {
  const result = await runContradictionDetectionBenchmark(
    buildOptions({ mode: "full" }),
  );
  assert.equal(result.results.tasks.length, CONTRADICTION_DETECTION_FIXTURE.length);
  assert.ok(
    !result.results.tasks.some((task) => task.taskId === "_aggregate_verdict_metrics"),
  );
  for (const task of result.results.tasks) {
    assert.ok(typeof task.scores === "object");
  }
});

test("runContradictionDetectionBenchmark includes per-verdict metrics", async () => {
  const result = await runContradictionDetectionBenchmark(
    buildOptions({ mode: "full" }),
  );
  assert.ok(typeof result.results.aggregates.precision_contradicts?.mean === "number");
  assert.ok(typeof result.results.aggregates.recall_contradicts?.mean === "number");
  assert.ok(typeof result.results.aggregates.f1_contradicts?.mean === "number");
  assert.ok(typeof result.results.aggregates.precision_duplicates?.mean === "number");
  assert.ok(typeof result.results.aggregates.recall_independent?.mean === "number");
  assert.ok(typeof result.results.aggregates.overall_accuracy?.mean === "number");
});

test("runContradictionDetectionBenchmark quick mode exposes only smoke tasks plus verdict aggregates", async () => {
  const result = await runContradictionDetectionBenchmark(
    buildOptions({ mode: "quick" }),
  );
  assert.equal(result.results.tasks.length, CONTRADICTION_DETECTION_SMOKE_FIXTURE.length);
  assert.deepEqual(
    result.results.tasks.map((task) => task.taskId),
    CONTRADICTION_DETECTION_SMOKE_FIXTURE.map((sample) => sample.id),
  );
  assert.ok(
    !result.results.tasks.some((task) => task.taskId === "_aggregate_verdict_metrics"),
  );
  assert.ok(typeof result.results.aggregates.precision_contradicts?.mean === "number");
  assert.ok(typeof result.results.aggregates.recall_contradicts?.mean === "number");
  assert.ok(typeof result.results.aggregates.f1_contradicts?.mean === "number");
});

test("runContradictionDetectionBenchmark emits per-task completion callbacks", async () => {
  const progress: Array<{ taskId: string; completedCount: number; totalCount: number }> = [];
  await runContradictionDetectionBenchmark(
    buildOptions({
      mode: "full",
      onTaskComplete(task, completedCount, totalCount) {
        const taskId = task.taskId;
        if (typeof taskId !== "string") {
          throw new Error("expected completed task to include a taskId");
        }
        if (typeof completedCount !== "number" || typeof totalCount !== "number") {
          throw new Error("expected progress counts");
        }
        progress.push({ taskId, completedCount, totalCount });
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
  assert.equal(quick.results.tasks.length, CONTRADICTION_DETECTION_SMOKE_FIXTURE.length);
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
