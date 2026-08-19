import assert from "node:assert/strict";
import test from "node:test";

import { mayRefine } from "./recall-deep-refine.js";

test("refined is false", () => {
  assert.equal(mayRefine({ refined: true, budgetLeft: 3 }), false);
});

test("budget 0 is false", () => {
  assert.equal(mayRefine({ refined: false, budgetLeft: 0 }), false);
});

test("ok is true", () => {
  assert.equal(mayRefine({ refined: false, budgetLeft: 3 }), true);
});

test("negative budget throws", () => {
  assert.throws(
    () => mayRefine({ refined: false, budgetLeft: -1 }),
    /negative/,
  );
});
