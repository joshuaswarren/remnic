import assert from "node:assert/strict";
import test from "node:test";

import { orderMergePair } from "./merge-pair.js";

test("orders ids by localeCompare", () => {
  assert.deepEqual(orderMergePair("zeta", "alpha"), ["alpha", "zeta"]);
  assert.deepEqual(orderMergePair("alpha", "zeta"), ["alpha", "zeta"]);
});

test("same id returns both sides", () => {
  assert.deepEqual(orderMergePair("alpha", "alpha"), ["alpha", "alpha"]);
});

test("empty id throws", () => {
  assert.throws(() => orderMergePair("", "alpha"), /empty merge id/);
  assert.throws(() => orderMergePair("alpha", ""), /empty merge id/);
  assert.throws(() => orderMergePair("", ""), /empty merge id/);
});
