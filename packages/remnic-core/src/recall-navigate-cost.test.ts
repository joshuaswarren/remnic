import assert from "node:assert/strict";
import test from "node:test";

import { parseNavigateCost } from "./recall-navigate-cost.js";

test("cost 0 is allowed", () => {
  assert.equal(parseNavigateCost(0), 0);
});

test("cost 2 is returned", () => {
  assert.equal(parseNavigateCost(2), 2);
});

test("negative cost throws", () => {
  assert.throws(() => parseNavigateCost(-1), /non-negative integer/);
});

test("float cost throws", () => {
  assert.throws(() => parseNavigateCost(1.5), /non-negative integer/);
});
