import assert from "node:assert/strict";
import test from "node:test";

import { isEmptyNavigatePath } from "./recall-navigate-path.js";

test("null, undefined, and empty array are empty", () => {
  assert.equal(isEmptyNavigatePath(null), true);
  assert.equal(isEmptyNavigatePath(undefined), true);
  assert.equal(isEmptyNavigatePath([]), true);
});

test("a non-empty array is not empty", () => {
  assert.equal(isEmptyNavigatePath([{ id: 1 }]), false);
  assert.equal(isEmptyNavigatePath([0]), false);
});

test("a non-array throws", () => {
  assert.throws(() => isEmptyNavigatePath({}), TypeError);
  assert.throws(() => isEmptyNavigatePath("nodes"), TypeError);
  assert.throws(() => isEmptyNavigatePath(1), TypeError);
});
