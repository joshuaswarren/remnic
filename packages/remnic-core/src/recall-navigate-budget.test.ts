import assert from "node:assert/strict";
import test from "node:test";

import { takeNavigateBudget } from "./recall-navigate-budget.js";

test("budget 0 is exhausted", () => {
  assert.deepEqual(takeNavigateBudget(0, 0), { ok: false, error: "budget_exhausted" });
  assert.deepEqual(takeNavigateBudget(0, 1), { ok: false, error: "budget_exhausted" });
});

test("cost above budget is exhausted", () => {
  assert.deepEqual(takeNavigateBudget(3, 4), { ok: false, error: "budget_exhausted" });
});

test("remaining is budget minus cost", () => {
  assert.deepEqual(takeNavigateBudget(5, 2), { ok: true, remaining: 3 });
  assert.deepEqual(takeNavigateBudget(4, 4), { ok: true, remaining: 0 });
});

test("negative budget or cost throws", () => {
  assert.throws(() => takeNavigateBudget(-1, 0));
  assert.throws(() => takeNavigateBudget(3, -1));
});
