import assert from "node:assert/strict";
import test from "node:test";

import { rejectEmptyMergeIds } from "./merge-empty.js";

test("empty set is empty_set", () => {
  assert.deepEqual(rejectEmptyMergeIds([]), { ok: false, error: "empty_set" });
});

test("empty id is empty_id", () => {
  assert.deepEqual(rejectEmptyMergeIds([""]), { ok: false, error: "empty_id" });
  assert.deepEqual(rejectEmptyMergeIds(["alpha", ""]), { ok: false, error: "empty_id" });
  assert.deepEqual(rejectEmptyMergeIds(["", "alpha"]), { ok: false, error: "empty_id" });
});

test("ok returns the same ids in order and does not mutate", () => {
  const ids = ["zeta", "alpha", "beta"];
  const result = rejectEmptyMergeIds(ids);
  assert.deepEqual(result, { ok: true, ids: ["zeta", "alpha", "beta"] });
  assert.equal(result.ok && result.ids, ids);
  assert.deepEqual(ids, ["zeta", "alpha", "beta"]);
});
