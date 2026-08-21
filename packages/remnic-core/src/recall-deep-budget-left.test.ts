import assert from "node:assert/strict";
import test from "node:test";

import { parseBudgetLeft } from "./recall-deep-budget-left.js";

test("budget left 0 is allowed", () => {
  assert.equal(parseBudgetLeft(0), 0);
});

test("budget left 4 is returned", () => {
  assert.equal(parseBudgetLeft(4), 4);
});

test("negative budget left throws", () => {
  assert.throws(() => parseBudgetLeft(-1), /non-negative integer/);
});

test("float budget left throws", () => {
  assert.throws(() => parseBudgetLeft(1.5), /non-negative integer/);
});
