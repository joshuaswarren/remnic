import assert from "node:assert/strict";
import test from "node:test";

import { uniqueMergeIds } from "./merge-unique.js";

test("empty list returns []", () => {
  assert.deepEqual(uniqueMergeIds([]), []);
});

test("drops empty strings and dedupes", () => {
  assert.deepEqual(uniqueMergeIds(["beta", "", "alpha", "beta", ""]), ["alpha", "beta"]);
});

test("does not mutate input", () => {
  const ids = ["zeta", "", "alpha", "zeta"];
  assert.deepEqual(uniqueMergeIds(ids), ["alpha", "zeta"]);
  assert.deepEqual(ids, ["zeta", "", "alpha", "zeta"]);
});
