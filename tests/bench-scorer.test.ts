import test from "node:test";
import assert from "node:assert/strict";
import {
  aggregateScores,
  aggregateTaskScores,
  precisionAtK,
  recallAtK,
} from "../packages/bench/src/scorer.ts";

test("aggregateScores projects legacy mean/min/max values from aggregateTaskScores", () => {
  const metrics = [
    { f1: 0.5, exact: 0.0 },
    { f1: 1.0, exact: 1.0 },
  ];

  const detailed = aggregateTaskScores(metrics);
  const legacy = aggregateScores(metrics);

  assert.equal(legacy.f1_mean, detailed.f1?.mean);
  assert.equal(legacy.f1_min, detailed.f1?.min);
  assert.equal(legacy.f1_max, detailed.f1?.max);
  assert.equal(legacy.exact_mean, detailed.exact?.mean);
  assert.equal(legacy.exact_min, detailed.exact?.min);
  assert.equal(legacy.exact_max, detailed.exact?.max);
});

test("aggregateScores and aggregateTaskScores both handle empty input", () => {
  assert.deepEqual(aggregateTaskScores([]), {});
  assert.deepEqual(aggregateScores([]), {});
});

test("recallAtK deduplicates repeated hits so recall does not exceed 1.0", () => {
  assert.equal(recallAtK(["a", "a"], ["a"], 2), 1.0);
});

test("precisionAtK divides hits by K instead of relevant set size", () => {
  assert.equal(precisionAtK(["a", "b", "c"], ["a"], 3), 1 / 3);
});

test("precisionAtK deduplicates repeated hits so precision does not double-count duplicates", () => {
  assert.equal(precisionAtK(["a", "a"], ["a"], 2), 0.5);
});
