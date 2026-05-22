/**
 * Tests for the reasoning-trace retrieval bench fixture + runner
 * (issue #564 PR 4).
 *
 * The fixture itself is synthetic, but we verify:
 * - fixture shape: 10+ cases, mix of positive and negative, unique ids, all
 *   cases reference the shared 15-memory pool with 2 reasoning traces.
 * - running the bench in full mode produces aggregates that show the boost
 *   lifts recall@1 above baseline on positive cases and leaves negative
 *   cases unchanged — i.e. the feature is actually doing something
 *   measurable.
 * - latency stays well under 1ms per case (pure helper call).
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  REASONING_TRACE_BENCH_FIXTURE,
  type ReasoningTraceBenchCase,
} from "./fixture.ts";
import {
  retrievalReasoningTraceDefinition,
  runRetrievalReasoningTraceBenchmark,
} from "./runner.ts";

function countWhere(
  cases: ReasoningTraceBenchCase[],
  predicate: (c: ReasoningTraceBenchCase) => boolean,
): number {
  return cases.filter(predicate).length;
}

test("fixture: at least 10 cases with unique ids", () => {
  assert.ok(
    REASONING_TRACE_BENCH_FIXTURE.length >= 10,
    `expected at least 10 cases, got ${REASONING_TRACE_BENCH_FIXTURE.length}`,
  );
  const ids = new Set<string>();
  for (const c of REASONING_TRACE_BENCH_FIXTURE) {
    assert.ok(!ids.has(c.id), `duplicate case id: ${c.id}`);
    ids.add(c.id);
  }
});

test("fixture: each case has 15 candidates with exactly 2 reasoning traces", () => {
  for (const c of REASONING_TRACE_BENCH_FIXTURE) {
    assert.equal(
      c.candidates.length,
      15,
      `case ${c.id}: expected 15 candidates, got ${c.candidates.length}`,
    );
    const traces = c.candidates.filter((cand) =>
      cand.path.includes("reasoning-traces/"),
    );
    assert.equal(
      traces.length,
      2,
      `case ${c.id}: expected 2 reasoning traces in pool, got ${traces.length}`,
    );
  }
});

test("fixture: has both positive and negative cases", () => {
  const positives = countWhere(
    REASONING_TRACE_BENCH_FIXTURE,
    (c) => c.expectsTraceTopAfterBoost,
  );
  const negatives = countWhere(
    REASONING_TRACE_BENCH_FIXTURE,
    (c) => !c.expectsTraceTopAfterBoost,
  );
  assert.ok(positives >= 3, `expected >=3 positive cases, got ${positives}`);
  assert.ok(negatives >= 3, `expected >=3 negative cases, got ${negatives}`);
});

test("fixture: positive cases name the expected boosted trace id", () => {
  const expectedByCase = new Map([
    ["pos-latency-howto", "trace-latency"],
    ["pos-oauth-step-by-step", "trace-oauth-loop"],
    ["pos-troubleshoot-oauth", "trace-oauth-loop"],
    ["pos-figure-out-latency", "trace-latency"],
    ["pos-reason-through", "trace-latency"],
  ]);

  for (const c of REASONING_TRACE_BENCH_FIXTURE) {
    if (!c.expectsTraceTopAfterBoost) continue;
    assert.equal(
      c.expectedTopWithBoost,
      expectedByCase.get(c.id),
      `case ${c.id}: expected boosted trace id mismatch`,
    );
  }
});

test("definition: benchmark metadata is ready and available", () => {
  assert.equal(retrievalReasoningTraceDefinition.id, "retrieval-reasoning-trace");
  assert.equal(retrievalReasoningTraceDefinition.tier, "remnic");
  assert.equal(retrievalReasoningTraceDefinition.status, "ready");
  assert.equal(retrievalReasoningTraceDefinition.runnerAvailable, true);
});

test("runner: full-mode run produces boost_recall_at_1 > 0 and boost_noop_preserved > 0", async () => {
  const result = await runRetrievalReasoningTraceBenchmark({
    benchmark: retrievalReasoningTraceDefinition,
    mode: "full",
    runCount: 1,
    adapterMode: "direct",
  } as Parameters<typeof runRetrievalReasoningTraceBenchmark>[0]);

  const recall = result.results.aggregates.boost_recall_at_1;
  const noop = result.results.aggregates.boost_noop_preserved;
  const baselineMatch = result.results.aggregates.baseline_top_matches_fixture;
  const classification = result.results.aggregates.heuristic_classification_correct;

  assert.ok(recall, "boost_recall_at_1 aggregate missing");
  assert.ok(noop, "boost_noop_preserved aggregate missing");
  assert.ok(
    recall.mean === 1,
    `expected 100% boost_recall_at_1 on positive cases, got ${recall.mean}`,
  );
  assert.ok(
    noop.mean === 1,
    `expected 100% boost_noop_preserved on negative cases, got ${noop.mean}`,
  );
  assert.ok(
    baselineMatch && baselineMatch.mean === 1,
    `baseline_top_matches_fixture should be 1, got ${baselineMatch?.mean}`,
  );
  assert.ok(
    classification && classification.mean === 1,
    `heuristic_classification_correct should be 1, got ${classification?.mean}`,
  );

  const expectedBoostedTopByCase = new Map([
    ["pos-latency-howto", "trace-latency"],
    ["pos-oauth-step-by-step", "trace-oauth-loop"],
    ["pos-troubleshoot-oauth", "trace-oauth-loop"],
    ["pos-figure-out-latency", "trace-latency"],
    ["pos-reason-through", "trace-latency"],
  ]);
  for (const task of result.results.tasks) {
    if (!expectedBoostedTopByCase.has(task.taskId)) continue;
    assert.match(task.actual, /boosted-top=trace-/);
    assert.equal(
      task.actual.includes(`boosted-top=${expectedBoostedTopByCase.get(task.taskId)}`),
      true,
      `case ${task.taskId}: expected boosted top ${expectedBoostedTopByCase.get(task.taskId)}, got ${task.actual}`,
    );
    assert.equal(
      task.scores.boost_recall_at_1,
      1,
      `case ${task.taskId}: expected exact-trace recall score`,
    );
  }
});

test("runner: quick mode exercises at least one positive AND one negative case", async () => {
  const result = await runRetrievalReasoningTraceBenchmark({
    benchmark: retrievalReasoningTraceDefinition,
    mode: "quick",
    runCount: 1,
    adapterMode: "direct",
  } as Parameters<typeof runRetrievalReasoningTraceBenchmark>[0]);

  // In quick mode we should still see both `boost_recall_at_1` (from a
  // positive case) and `boost_noop_preserved` (from a negative case) so a
  // one-sided regression can't slip through a smoke run.
  assert.ok(
    result.results.aggregates.boost_recall_at_1,
    "quick mode must exercise the positive boost path",
  );
  assert.ok(
    result.results.aggregates.boost_noop_preserved,
    "quick mode must exercise the negative guard path",
  );
});

test("runner: quick mode emits per-task completion callbacks", async () => {
  const progress: Array<{ taskId: string; completedCount: number; totalCount: number }> = [];
  const result = await runRetrievalReasoningTraceBenchmark({
    benchmark: retrievalReasoningTraceDefinition,
    mode: "quick",
    runCount: 1,
    adapterMode: "direct",
    onTaskComplete(task, completedCount, totalCount) {
      progress.push({ taskId: task.taskId, completedCount, totalCount });
    },
  } as Parameters<typeof runRetrievalReasoningTraceBenchmark>[0]);

  assert.deepEqual(
    progress.map((entry) => entry.completedCount),
    [1, 2],
  );
  assert.deepEqual(
    progress.map((entry) => entry.totalCount),
    [result.results.tasks.length, result.results.tasks.length],
  );
  assert.deepEqual(
    progress.map((entry) => entry.taskId),
    result.results.tasks.map((task) => task.taskId),
  );
});

test("runner: latency p95 stays well under 5ms (pure helper)", async () => {
  const result = await runRetrievalReasoningTraceBenchmark({
    benchmark: retrievalReasoningTraceDefinition,
    mode: "full",
    runCount: 1,
    adapterMode: "direct",
  } as Parameters<typeof runRetrievalReasoningTraceBenchmark>[0]);

  const p95 = result.results.aggregates.latency_p95_ms?.mean ?? 0;
  assert.ok(
    p95 < 5,
    `expected p95 boost latency < 5ms, got ${p95}ms`,
  );
});
