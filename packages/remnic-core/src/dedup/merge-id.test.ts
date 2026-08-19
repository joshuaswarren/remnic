import assert from "node:assert/strict";
import test from "node:test";

import { pickMergeTargetId } from "./merge-id.js";

test("empty candidates return null", () => {
  assert.equal(pickMergeTargetId([]), null);
});

test("picks lowest id by localeCompare", () => {
  assert.equal(pickMergeTargetId(["zeta", "alpha", "beta"]), "alpha");
});

test("does not mutate candidates", () => {
  const candidates = ["zeta", "alpha", "beta"];
  pickMergeTargetId(candidates);
  assert.deepEqual(candidates, ["zeta", "alpha", "beta"]);
});
