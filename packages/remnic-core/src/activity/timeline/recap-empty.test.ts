import assert from "node:assert/strict";
import test from "node:test";

import { isEmptyRecapCards } from "./recap-empty.js";

test("null, undefined, and empty array are empty", () => {
  assert.equal(isEmptyRecapCards(null), true);
  assert.equal(isEmptyRecapCards(undefined), true);
  assert.equal(isEmptyRecapCards([]), true);
});

test("a non-empty array is not empty", () => {
  assert.equal(isEmptyRecapCards([{ id: 1 }]), false);
  assert.equal(isEmptyRecapCards([0]), false);
});

test("a non-array throws", () => {
  assert.throws(() => isEmptyRecapCards({}), TypeError);
  assert.throws(() => isEmptyRecapCards("cards"), TypeError);
  assert.throws(() => isEmptyRecapCards(1), TypeError);
});
