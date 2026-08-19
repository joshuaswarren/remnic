import assert from "node:assert/strict";
import test from "node:test";

import { rejectSelfMerge } from "./merge-self.js";

test("same id is self_merge", () => {
  assert.deepEqual(rejectSelfMerge("alpha", "alpha"), { ok: false, error: "self_merge" });
});

test("different ids are ok", () => {
  assert.deepEqual(rejectSelfMerge("alpha", "beta"), { ok: true });
  assert.deepEqual(rejectSelfMerge("beta", "alpha"), { ok: true });
});

test("empty id throws", () => {
  assert.throws(() => rejectSelfMerge("", "alpha"), /empty merge id/);
  assert.throws(() => rejectSelfMerge("alpha", ""), /empty merge id/);
  assert.throws(() => rejectSelfMerge("", ""), /empty merge id/);
});
