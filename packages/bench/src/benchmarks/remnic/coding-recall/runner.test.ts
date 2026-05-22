/**
 * Smoke tests for the coding-recall benchmark runner (issue #569 PR 8).
 *
 * Verifies that the deterministic scorer produces the expected ordering and
 * isolation metric for each fixture case.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { runCodingRecallBenchmark, codingRecallDefinition } from "./runner.js";

test("coding-recall: cross-project case yields perfect isolation + precision", async () => {
  const result = await runCodingRecallBenchmark({
    benchmark: codingRecallDefinition,
    mode: "full",
    limit: 1,
    seed: 0,
  } as unknown as Parameters<typeof runCodingRecallBenchmark>[0]);

  const task = result.results.tasks[0];
  assert.ok(task);
  assert.equal(task!.taskId, "cross-project-basic");
  assert.equal(task!.scores.isolation, 1, "no cross-project leakage");
  // Expected memories are top of the ranking.
  const actual = JSON.parse(task!.actual);
  assert.ok(Array.isArray(actual));
  // The session can only see project A's namespace; project B candidates are filtered out.
  assert.ok(!actual.includes("b1"));
  assert.ok(!actual.includes("b2"));
  assert.deepEqual(actual, ["a1", "a2"]);
});

test("coding-recall: branch-isolation case — branch B filtered out, project fallback visible", async () => {
  const result = await runCodingRecallBenchmark({
    benchmark: codingRecallDefinition,
    mode: "full",
    limit: 2,
    seed: 0,
  } as unknown as Parameters<typeof runCodingRecallBenchmark>[0]);

  const task = result.results.tasks[1];
  assert.ok(task);
  assert.equal(task!.taskId, "branch-isolation-with-project-fallback");
  assert.equal(task!.scores.isolation, 1);
  const actual = JSON.parse(task!.actual);
  assert.ok(actual.includes("brA-local"), "branch-A memory must be retrievable");
  assert.ok(actual.includes("proj-level"), "project-level memory must be retrievable via fallback");
  assert.ok(!actual.includes("brB-local"), "branch-B must not leak");
  assert.ok(!actual.includes("other-proj"), "other project must not leak");
});

test("coding-recall: review-context case boosts touched-file memories via tie-break", async () => {
  const result = await runCodingRecallBenchmark({
    benchmark: codingRecallDefinition,
    mode: "full",
    seed: 0,
  } as unknown as Parameters<typeof runCodingRecallBenchmark>[0]);

  const task = result.results.tasks.find((t) => t.taskId === "review-context-boosts-touched-files");
  assert.ok(task);
  const actual = JSON.parse(task!.actual);
  // "strong" (0.8 + 0) ties with "touched" (0.3 + 0.5); stable id sort
  // places "strong" first. Then "touched" (0.8), then "untouched" (0.3).
  assert.deepEqual(actual, ["strong", "touched", "untouched"]);
});

test("coding-recall: developer workflow planning covers project conventions and action boundaries", async () => {
  const result = await runCodingRecallBenchmark({
    benchmark: codingRecallDefinition,
    mode: "full",
    seed: 0,
  } as unknown as Parameters<typeof runCodingRecallBenchmark>[0]);

  const task = result.results.tasks.find((t) => t.taskId === "developer-workflow-change-plan");
  assert.ok(task);
  assert.equal(task!.scores.isolation, 1);
  assert.equal(task!.scores.workflow_coverage, 1);
  const actual = JSON.parse(task!.actual);
  assert.deepEqual(actual, [
    "dev-architecture-core-host-agnostic",
    "dev-test-gate-preflight",
    "dev-release-process-changeset",
    "dev-ask-before-public-api",
    "dev-review-batch-subsystem",
  ]);
  assert.ok(!actual.includes("dev-other-repo-fast-path"));
  assert.deepEqual(task!.details?.missingWorkflowFacets, []);
});

test("coding-recall: developer workflow review boosts touched-file past bugs", async () => {
  const result = await runCodingRecallBenchmark({
    benchmark: codingRecallDefinition,
    mode: "full",
    seed: 0,
  } as unknown as Parameters<typeof runCodingRecallBenchmark>[0]);

  const task = result.results.tasks.find((t) => t.taskId === "developer-workflow-review-risk");
  assert.ok(task);
  assert.equal(task!.scores.isolation, 1);
  assert.equal(task!.scores.workflow_coverage, 1);
  const actual = JSON.parse(task!.actual);
  assert.deepEqual(actual, [
    "dev-past-bug-hash-dedup",
    "dev-storage-cache-invalidation",
    "dev-untouched-style-preference",
    "dev-review-hardening-gate",
  ]);
  assert.ok(!actual.includes("dev-client-app-storage-bug"));
});

test("coding-recall: quick task caps still exercise workflow coverage", async () => {
  const result = await runCodingRecallBenchmark({
    benchmark: codingRecallDefinition,
    mode: "quick",
    limit: 1,
    seed: 0,
  } as unknown as Parameters<typeof runCodingRecallBenchmark>[0]);

  const task = result.results.tasks[0];
  assert.ok(task);
  assert.equal(task!.taskId, "developer-workflow-change-plan");
  assert.equal(task!.scores.workflow_coverage, 1);
});

test("coding-recall emits task completion callbacks in full mode", async () => {
  const completed: Array<{ taskId: string; completedCount: number; totalCount?: number }> = [];

  const result = await runCodingRecallBenchmark({
    benchmark: codingRecallDefinition,
    mode: "full",
    seed: 0,
    onTaskComplete(task, completedCount, totalCount) {
      completed.push({ taskId: task.taskId, completedCount, totalCount });
    },
  } as unknown as Parameters<typeof runCodingRecallBenchmark>[0]);

  assert.equal(result.results.tasks.length, 5);
  assert.deepEqual(
    completed.map((entry) => entry.taskId),
    result.results.tasks.map((task) => task.taskId),
  );
  assert.deepEqual(
    completed.map((entry) => entry.completedCount),
    [1, 2, 3, 4, 5],
  );
  assert.deepEqual(
    completed.map((entry) => entry.totalCount),
    [5, 5, 5, 5, 5],
  );
});

test("coding-recall: aggregates include all metrics", async () => {
  const result = await runCodingRecallBenchmark({
    benchmark: codingRecallDefinition,
    mode: "full",
    seed: 0,
  } as unknown as Parameters<typeof runCodingRecallBenchmark>[0]);

  const agg = result.results.aggregates;
  assert.ok(typeof agg.isolation === "object" && agg.isolation !== null);
  assert.ok(typeof agg.p_at_1 === "object" && agg.p_at_1 !== null);
  assert.ok(typeof agg.workflow_coverage === "object" && agg.workflow_coverage !== null);
  assert.equal(result.results.tasks.length, 5);
  // Overall isolation and workflow coverage means should be 1.0.
  assert.equal(agg.isolation!.mean, 1, "overall isolation mean across fixture must be 1.0");
  assert.equal(agg.workflow_coverage!.mean, 1, "workflow facet coverage across fixture must be 1.0");
});
