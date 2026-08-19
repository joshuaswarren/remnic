import assert from "node:assert/strict";
import test from "node:test";

import { hasDuplicateMergeIds } from "./merge-dup.js";

test("none is false", () => {
  assert.equal(hasDuplicateMergeIds([]), false);
  assert.equal(hasDuplicateMergeIds(["alpha"]), false);
  assert.equal(hasDuplicateMergeIds(["alpha", "beta"]), false);
});

test("duplicate non-empty id is true", () => {
  assert.equal(hasDuplicateMergeIds(["alpha", "beta", "alpha"]), true);
});

test("empty strings are ignored and input is not mutated", () => {
  const ids = ["alpha", "", "", "beta"];
  assert.equal(hasDuplicateMergeIds(ids), false);
  assert.equal(hasDuplicateMergeIds(["", "", "alpha", "", "alpha"]), true);
  assert.deepEqual(ids, ["alpha", "", "", "beta"]);
});
