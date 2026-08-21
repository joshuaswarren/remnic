import assert from "node:assert/strict";
import test from "node:test";

import type { ResolvedRunBenchmarkOptions } from "../../../types.js";
import {
  TAXONOMY_ACCURACY_SMOKE_FIXTURE,
} from "./fixture.js";
import {
  runTaxonomyAccuracyBenchmark,
  taxonomyAccuracyDefinition,
} from "./runner.js";

function options(
  overrides: Partial<ResolvedRunBenchmarkOptions> = {},
): ResolvedRunBenchmarkOptions {
  return {
    mode: "quick",
    benchmark: taxonomyAccuracyDefinition,
    system: { describe: () => "noop", store: async () => undefined, query: async () => "" },
    ...overrides,
  } as ResolvedRunBenchmarkOptions;
}

test("taxonomy-accuracy smoke fixture covers non-fact and fallback branches", () => {
  const categories = new Set(TAXONOMY_ACCURACY_SMOKE_FIXTURE.map((sample) => sample.memoryCategory));
  const ids = new Set(TAXONOMY_ACCURACY_SMOKE_FIXTURE.map((sample) => sample.id));

  assert.equal(categories.has("fact"), true);
  assert.equal(categories.has("decision"), true);
  assert.equal(categories.has("preference"), true);
  assert.equal(categories.has("correction"), true);
  assert.equal(ids.has("general-fact"), true);
});

test("taxonomy-accuracy quick mode exercises every smoke fixture case", async () => {
  const result = await runTaxonomyAccuracyBenchmark(options());

  assert.deepEqual(
    result.results.tasks.map((task) => task.taskId),
    TAXONOMY_ACCURACY_SMOKE_FIXTURE.map((sample) => sample.id),
  );
  assert.equal(
    result.results.tasks.every((task) => task.scores.exact_match === 1),
    true,
  );
});

test("taxonomy-accuracy reports completed task progress", async () => {
  const completedCounts: number[] = [];
  const totalCounts: Array<number | undefined> = [];
  const taskIds: string[] = [];

  const result = await runTaxonomyAccuracyBenchmark(options({
    onTaskComplete(task, completedCount, totalCount) {
      taskIds.push(task.taskId);
      completedCounts.push(completedCount);
      totalCounts.push(totalCount);
    },
  }));

  const expectedCounts = TAXONOMY_ACCURACY_SMOKE_FIXTURE.map((_, index) => index + 1);
  const expectedTotalCounts = TAXONOMY_ACCURACY_SMOKE_FIXTURE.map(() => TAXONOMY_ACCURACY_SMOKE_FIXTURE.length);

  assert.deepEqual(taskIds, result.results.tasks.map((task) => task.taskId));
  assert.deepEqual(completedCounts, expectedCounts);
  assert.deepEqual(totalCounts, expectedTotalCounts);
});
