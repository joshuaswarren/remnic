import assert from "node:assert/strict";
import test from "node:test";

import { isEmptyObservationSet } from "./analysis-empty.js";

test("null, undefined, and empty array are empty", () => {
  assert.equal(isEmptyObservationSet(null), true);
  assert.equal(isEmptyObservationSet(undefined), true);
  assert.equal(isEmptyObservationSet([]), true);
});

test("a non-empty array is not empty", () => {
  assert.equal(isEmptyObservationSet([{ id: 1 }]), false);
  assert.equal(isEmptyObservationSet([0]), false);
});

test("a non-array throws", () => {
  assert.throws(() => isEmptyObservationSet({}), TypeError);
  assert.throws(() => isEmptyObservationSet("obs"), TypeError);
  assert.throws(() => isEmptyObservationSet(1), TypeError);
});
