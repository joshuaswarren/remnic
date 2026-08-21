import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_BENCH_RECALL_BUDGET_CHARS,
  benchmarkRecallBudgetForSessionCount,
} from "./recall-budget.ts";

test("benchmarkRecallBudgetForSessionCount caps combined multi-session context", () => {
  assert.equal(
    benchmarkRecallBudgetForSessionCount(1),
    DEFAULT_BENCH_RECALL_BUDGET_CHARS,
  );
  assert.equal(benchmarkRecallBudgetForSessionCount(3), 12_000);
  assert.equal(benchmarkRecallBudgetForSessionCount(6), 6_000);
  assert.equal(benchmarkRecallBudgetForSessionCount(20), 1_800);
  assert.equal(benchmarkRecallBudgetForSessionCount(100), 360);
  assert.equal(benchmarkRecallBudgetForSessionCount(40_000), 0);
});

test("benchmarkRecallBudgetForSessionCount falls back for invalid counts", () => {
  assert.equal(
    benchmarkRecallBudgetForSessionCount(0),
    DEFAULT_BENCH_RECALL_BUDGET_CHARS,
  );
  assert.equal(
    benchmarkRecallBudgetForSessionCount(1.5),
    DEFAULT_BENCH_RECALL_BUDGET_CHARS,
  );
});
