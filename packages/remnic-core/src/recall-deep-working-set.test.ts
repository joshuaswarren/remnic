import assert from "node:assert/strict";
import test from "node:test";

import { isEmptyWorkingSet } from "./recall-deep-working-set.js";

test("null, undefined, and empty array are empty", () => {
  assert.equal(isEmptyWorkingSet(null), true);
  assert.equal(isEmptyWorkingSet(undefined), true);
  assert.equal(isEmptyWorkingSet([]), true);
});

test("a non-empty array is not empty", () => {
  assert.equal(isEmptyWorkingSet([{ id: 1 }]), false);
  assert.equal(isEmptyWorkingSet([0]), false);
});

test("a non-array throws", () => {
  assert.throws(() => isEmptyWorkingSet({}), TypeError);
  assert.throws(() => isEmptyWorkingSet("items"), TypeError);
  assert.throws(() => isEmptyWorkingSet(1), TypeError);
});
