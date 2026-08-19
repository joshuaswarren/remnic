import assert from "node:assert/strict";
import test from "node:test";

import { clampDeepRecallBudget } from "./recall-deep-budget.js";

test("budget 0 stays 0", () => {
  assert.equal(clampDeepRecallBudget(0), 0);
});

test("budget 3 stays 3", () => {
  assert.equal(clampDeepRecallBudget(3), 3);
});

test("invalid budget throws", () => {
  assert.throws(() => clampDeepRecallBudget(-1), /non-negative integer/);
  assert.throws(() => clampDeepRecallBudget(1.5), /non-negative integer/);
  assert.throws(() => clampDeepRecallBudget(Number.NaN), /non-negative integer/);
  assert.throws(() => clampDeepRecallBudget(Number.POSITIVE_INFINITY), /non-negative integer/);
});
