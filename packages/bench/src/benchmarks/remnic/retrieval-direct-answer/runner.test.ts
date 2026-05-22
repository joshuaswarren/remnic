import assert from "node:assert/strict";
import test from "node:test";

import {
  retrievalDirectAnswerDefinition,
  runRetrievalDirectAnswerBenchmark,
} from "./runner.ts";

test("runner: full-mode aggregates include advertised precision and deferral metrics", async () => {
  const result = await runRetrievalDirectAnswerBenchmark({
    benchmark: retrievalDirectAnswerDefinition,
    mode: "full",
    runCount: 1,
    adapterMode: "direct",
  } as Parameters<typeof runRetrievalDirectAnswerBenchmark>[0]);

  const aggregates = result.results.aggregates;

  assert.equal(aggregates.verdict_correct?.mean, 1);
  assert.equal(aggregates.eligible_case_correct?.mean, 1);
  assert.equal(aggregates.direct_answer_precision?.mean, 1);
  assert.equal(aggregates.defer_case_correct?.mean, 1);
  assert.equal(aggregates.deferral_recall?.mean, 1);
  assert.equal(aggregates.winner_correct?.mean, 1);
  assert.ok(aggregates.latency_p50_ms, "latency_p50_ms aggregate missing");
  assert.ok(aggregates.latency_p95_ms, "latency_p95_ms aggregate missing");
});

test("runner: split metrics are emitted only for the matching case class", async () => {
  const result = await runRetrievalDirectAnswerBenchmark({
    benchmark: retrievalDirectAnswerDefinition,
    mode: "full",
    runCount: 1,
    adapterMode: "direct",
  } as Parameters<typeof runRetrievalDirectAnswerBenchmark>[0]);

  for (const task of result.results.tasks) {
    if (task.expected.startsWith("eligible:")) {
      assert.equal(task.scores.eligible_case_correct, 1, `${task.taskId}: missing eligible split metric`);
      assert.equal(task.scores.direct_answer_precision, 1, `${task.taskId}: missing precision metric`);
      assert.equal(task.scores.defer_case_correct, undefined, `${task.taskId}: defer metric should be omitted`);
      assert.equal(task.scores.deferral_recall, undefined, `${task.taskId}: deferral recall should be omitted`);
    } else {
      assert.equal(task.scores.defer_case_correct, 1, `${task.taskId}: missing defer split metric`);
      assert.equal(task.scores.deferral_recall, 1, `${task.taskId}: missing deferral recall metric`);
      assert.equal(task.scores.eligible_case_correct, undefined, `${task.taskId}: eligible metric should be omitted`);
      assert.equal(task.scores.direct_answer_precision, undefined, `${task.taskId}: precision metric should be omitted`);
    }
  }
});
