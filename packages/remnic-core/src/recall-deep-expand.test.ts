import assert from "node:assert/strict";
import test from "node:test";

import { mayExpandOnce } from "./recall-deep-expand.js";

test("already expanded is false", () => {
  assert.equal(mayExpandOnce({ alreadyExpanded: true, budgetLeft: 3 }), false);
});

test("budget 0 is false", () => {
  assert.equal(mayExpandOnce({ alreadyExpanded: false, budgetLeft: 0 }), false);
});

test("ok is true", () => {
  assert.equal(mayExpandOnce({ alreadyExpanded: false, budgetLeft: 3 }), true);
});

test("negative budget throws", () => {
  assert.throws(
    () => mayExpandOnce({ alreadyExpanded: false, budgetLeft: -1 }),
    /negative/,
  );
});
