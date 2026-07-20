import assert from "node:assert/strict";
import test from "node:test";

import type { AggregateMetrics, TaskResult } from "../../types.js";
import { computeCategoryAggregates } from "./category-aggregates.js";

function makeTask(categoryName: string | undefined, scores: Record<string, number>): TaskResult {
  return {
    taskId: `t-${categoryName ?? "none"}`,
    question: "q",
    expected: "e",
    actual: "a",
    scores,
    latencyMs: 0,
    tokens: { input: 0, output: 0 },
    details: categoryName === undefined ? {} : { categoryName },
  };
}

function makeRawTask(details: Record<string, unknown>): TaskResult {
  return {
    taskId: "t-raw",
    question: "q",
    expected: "e",
    actual: "a",
    scores: { llm_judge: 1 },
    latencyMs: 0,
    tokens: { input: 0, output: 0 },
    details,
  };
}

function meanOf(result: Record<string, AggregateMetrics>, category: string, metric: string): number {
  const categoryAgg = result[category];
  assert.ok(categoryAgg, `expected category "${category}"`);
  const metricAgg = categoryAgg[metric];
  assert.ok(metricAgg, `expected metric "${metric}" in "${category}"`);
  return metricAgg.mean;
}

test("computeCategoryAggregates groups scores by category name", () => {
  const tasks: TaskResult[] = [
    makeTask("single_hop", { llm_judge: 1, contains_answer: 1 }),
    makeTask("single_hop", { llm_judge: 1, contains_answer: 0 }),
    makeTask("adversarial", { llm_judge: 0, contains_answer: 0 }),
    makeTask("adversarial", { llm_judge: 0.5, contains_answer: 0 }),
  ];

  const result = computeCategoryAggregates(tasks);

  assert.deepEqual(Object.keys(result), ["adversarial", "single_hop"]);
  assert.equal(meanOf(result, "adversarial", "llm_judge"), 0.25);
  assert.equal(meanOf(result, "single_hop", "llm_judge"), 1);
  assert.equal(meanOf(result, "single_hop", "contains_answer"), 0.5);
});

test("computeCategoryAggregates skips tasks without a valid categoryName", () => {
  const tasks: TaskResult[] = [
    makeTask("adversarial", { llm_judge: 0 }),
    makeTask(undefined, { llm_judge: 1 }),
    makeTask("", { llm_judge: 1 }),
  ];

  const result = computeCategoryAggregates(tasks);

  assert.deepEqual(Object.keys(result), ["adversarial"]);
  assert.equal(meanOf(result, "adversarial", "llm_judge"), 0);
});

test("computeCategoryAggregates output keys are sorted regardless of task order", () => {
  const tasks: TaskResult[] = [
    makeTask("temporal", { llm_judge: 1 }),
    makeTask("adversarial", { llm_judge: 0 }),
    makeTask("multi_hop", { llm_judge: 1 }),
  ];

  const result = computeCategoryAggregates(tasks);

  assert.deepEqual(Object.keys(result), ["adversarial", "multi_hop", "temporal"]);
});

test("computeCategoryAggregates returns an empty map for no categorized tasks", () => {
  assert.deepEqual(computeCategoryAggregates([]), {});
  assert.deepEqual(computeCategoryAggregates([makeTask(undefined, { llm_judge: 1 })]), {});
});

test("computeCategoryAggregates skips non-string and whitespace-only categoryName", () => {
  const tasks: TaskResult[] = [
    makeRawTask({ categoryName: null }),
    makeRawTask({ categoryName: 3 }),
    makeRawTask({ categoryName: { name: "adversarial" } }),
    makeRawTask({ categoryName: "   " }),
    makeRawTask({}),
    makeTask("adversarial", { llm_judge: 0 }),
  ];

  const result = computeCategoryAggregates(tasks);

  assert.deepEqual(Object.keys(result), ["adversarial"]);
  assert.equal(meanOf(result, "adversarial", "llm_judge"), 0);
});

test("computeCategoryAggregates keeps a __proto__ category as an own key", () => {
  const result = computeCategoryAggregates([makeRawTask({ categoryName: "__proto__" })]);

  assert.deepEqual(Object.keys(result), ["__proto__"]);
  assert.ok(Object.hasOwn(result, "__proto__"));
});
