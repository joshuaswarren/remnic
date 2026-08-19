import assert from "node:assert/strict";
import test from "node:test";

import { recapSortKey } from "./recap-sort-key.js";

test("ok card id is the sort key", () => {
  assert.equal(recapSortKey({ id: "card-1" }), "card-1");
});

test("missing id throws", () => {
  assert.throws(() => recapSortKey({}), /missing recap card id/);
  assert.throws(() => recapSortKey({ id: undefined }), /missing recap card id/);
  assert.throws(() => recapSortKey({ id: null }), /missing recap card id/);
});

test("empty id throws", () => {
  assert.throws(() => recapSortKey({ id: "" }), /empty recap card id/);
});
