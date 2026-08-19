import assert from "node:assert/strict";
import test from "node:test";

import { countMergeCandidates } from "./merge-count.js";

test("empty list is 0", () => {
  assert.equal(countMergeCandidates([]), 0);
});

test("counts unique ids", () => {
  assert.equal(countMergeCandidates(["alpha", "beta", "alpha"]), 2);
  assert.equal(countMergeCandidates(["alpha", "beta", "gamma"]), 3);
});

test("drops empty strings and does not mutate", () => {
  const ids = ["alpha", "", "beta", "", "alpha"];
  assert.equal(countMergeCandidates(ids), 2);
  assert.deepEqual(ids, ["alpha", "", "beta", "", "alpha"]);
});
