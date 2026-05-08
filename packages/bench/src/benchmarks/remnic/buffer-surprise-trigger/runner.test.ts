/**
 * Smoke test for `buffer-surprise-trigger` benchmark (issue #563 PR 4).
 *
 * Exercises the end-to-end runner on the smoke fixture to catch wiring
 * regressions (fixture loading, metric shape, candidate vs control
 * parallel run, aggregate computation). The runner is fully
 * deterministic — no mocks required.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  runBufferSurpriseTriggerBenchmark,
  bufferSurpriseTriggerDefinition,
  topicShiftF1,
} from "./runner.js";
import type { ResolvedRunBenchmarkOptions } from "../../../types.js";
import type { BenchMemoryAdapter } from "../../../adapters/types.js";

// This benchmark does not exercise the `system` adapter at all — it
// operates on `SmartBuffer` directly — but `ResolvedRunBenchmarkOptions`
// requires a non-null adapter reference. A bare object satisfies the
// type checker without bringing in any real integration surface.
function noopAdapter(): BenchMemoryAdapter {
  return {
    async store() {},
    async recall() {
      return "";
    },
    async search() {
      return [];
    },
    async reset() {},
    async getStats() {
      return { sessionCount: 0, totalMemories: 0 };
    },
    async destroy() {},
  } as unknown as BenchMemoryAdapter;
}

test("runner returns tasks with candidate + control metrics (quick mode)", async () => {
  const options: ResolvedRunBenchmarkOptions = {
    mode: "quick",
    benchmark: bufferSurpriseTriggerDefinition,
    system: noopAdapter(),
  };
  const result = await runBufferSurpriseTriggerBenchmark(options);

  assert.ok(result.results.tasks.length > 0, "expected at least one task");
  for (const task of result.results.tasks) {
    const scores = task.scores;
    assert.ok(
      typeof scores.candidate_topic_shift_f1 === "number" &&
        scores.candidate_topic_shift_f1 >= 0 &&
        scores.candidate_topic_shift_f1 <= 1,
      `candidate F1 out of range for ${task.taskId}`,
    );
    assert.ok(
      typeof scores.control_topic_shift_f1 === "number" &&
        scores.control_topic_shift_f1 >= 0 &&
        scores.control_topic_shift_f1 <= 1,
      `control F1 out of range for ${task.taskId}`,
    );
    assert.equal(
      scores.topic_shift_f1_delta,
      scores.candidate_topic_shift_f1 - scores.control_topic_shift_f1,
      `f1_delta mismatch for ${task.taskId}`,
    );
    assert.ok(Number.isFinite(scores.candidate_flush_count));
    assert.ok(Number.isFinite(scores.control_flush_count));
  }
});

test("runner produces aggregates for every per-task metric", async () => {
  const options: ResolvedRunBenchmarkOptions = {
    mode: "quick",
    benchmark: bufferSurpriseTriggerDefinition,
    system: noopAdapter(),
  };
  const result = await runBufferSurpriseTriggerBenchmark(options);

  // Every metric the tasks produced should appear in aggregates with
  // the standard {mean, median, stdDev, min, max} shape.
  const expectedKeys = [
    "candidate_topic_shift_f1",
    "control_topic_shift_f1",
    "topic_shift_f1_delta",
    "candidate_flush_count",
    "control_flush_count",
    "candidate_mean_turns_between_flushes",
    "control_mean_turns_between_flushes",
  ];
  for (const key of expectedKeys) {
    const agg = result.results.aggregates[key];
    assert.ok(agg, `missing aggregate for ${key}`);
    assert.ok(typeof agg.mean === "number");
    assert.ok(typeof agg.median === "number");
    assert.ok(typeof agg.stdDev === "number");
    assert.ok(typeof agg.min === "number");
    assert.ok(typeof agg.max === "number");
  }
});

test("candidate produces at least as many flushes as control on the topic-shift fixture", async () => {
  // Surprise-on should never flush *less* than surprise-off on a corpus
  // designed around novelty — that would break the additive-only
  // invariant exercised in PR 2.
  const options: ResolvedRunBenchmarkOptions = {
    mode: "full",
    benchmark: bufferSurpriseTriggerDefinition,
    system: noopAdapter(),
  };
  const result = await runBufferSurpriseTriggerBenchmark(options);

  for (const task of result.results.tasks) {
    assert.ok(
      task.scores.candidate_flush_count >= task.scores.control_flush_count,
      `additive-only invariant violated for ${task.taskId}: candidate=${task.scores.candidate_flush_count}, control=${task.scores.control_flush_count}`,
    );
  }
});

test("candidate flushes exactly at annotated topic shifts on the full fixture", async () => {
  const options: ResolvedRunBenchmarkOptions = {
    mode: "full",
    benchmark: bufferSurpriseTriggerDefinition,
    system: noopAdapter(),
  };
  const result = await runBufferSurpriseTriggerBenchmark(options);

  for (const task of result.results.tasks) {
    const details = task.details as {
      candidateFlushTurnIndices?: number[];
      topicShiftTurnIndices?: number[];
    };
    assert.deepEqual(
      details.candidateFlushTurnIndices,
      details.topicShiftTurnIndices,
      `candidate flushes must align with annotated shifts for ${task.taskId}`,
    );
    assert.equal(
      task.scores.candidate_topic_shift_f1,
      1,
      `candidate F1 must be perfect for ${task.taskId}`,
    );
  }
});

// ---------------------------------------------------------------------------
// topicShiftF1 unit tests
// ---------------------------------------------------------------------------

test("topicShiftF1: perfect match returns 1", () => {
  assert.equal(topicShiftF1([5, 10], [5, 10]), 1);
});

test("topicShiftF1: ±1 tolerance matches as true positive", () => {
  // predicted=[4] against expected=[5] is within tolerance=1.
  assert.equal(topicShiftF1([4], [5]), 1);
  assert.equal(topicShiftF1([6], [5]), 1);
});

test("topicShiftF1: out-of-tolerance predictions are false positives", () => {
  // predicted=[10] vs expected=[5] → TP=0, FP=1, FN=1 → precision=0,
  // recall=0 → F1=0.
  assert.equal(topicShiftF1([10], [5]), 0);
});

test("topicShiftF1: empty expected + empty predicted returns 1", () => {
  assert.equal(topicShiftF1([], []), 1);
});

test("topicShiftF1: empty expected + non-empty predicted returns 0", () => {
  assert.equal(topicShiftF1([5], []), 0);
});

test("topicShiftF1: partial match computes F1 correctly", () => {
  // expected=[5, 10, 15], predicted=[5, 10] → TP=2, FP=0, FN=1
  // precision=1, recall=2/3 → F1=0.8
  const f1 = topicShiftF1([5, 10], [5, 10, 15]);
  assert.ok(Math.abs(f1 - 0.8) < 1e-9, `expected 0.8, got ${f1}`);
});

test("topicShiftF1: each expected index matches at most one predicted", () => {
  // expected=[5], predicted=[4, 6] — both are within tolerance=1 of
  // index 5, but only one can claim it. TP=1, FP=1, FN=0.
  // precision=0.5, recall=1, F1 = 2*0.5*1/(0.5+1) = 2/3.
  const f1 = topicShiftF1([4, 6], [5]);
  assert.ok(
    Math.abs(f1 - 2 / 3) < 1e-9,
    `expected 2/3, got ${f1}`,
  );
});

test("topicShiftF1: max-bipartite matching outperforms greedy on overlaps", () => {
  // expected=[4, 5], predicted=[5, 6], tolerance=1.
  // A greedy nearest-first pass pairs 5↔5 first and then cannot pair
  // 6 (4 is out of tolerance), yielding TP=1.  Max bipartite finds
  // the valid assignment 5↔4, 6↔5 and reports TP=2.
  // TP=2, FP=0, FN=0 → F1 = 1.
  assert.equal(topicShiftF1([5, 6], [4, 5], 1), 1);
});

test("topicShiftF1: returns 0 precision+0 recall → 0, not NaN", () => {
  // Out-of-tolerance prediction against a single expected target must
  // return a defined score, not NaN / undefined — downstream
  // aggregators rely on scalar output.
  const f1 = topicShiftF1([20], [1], 1);
  assert.equal(f1, 0);
});
