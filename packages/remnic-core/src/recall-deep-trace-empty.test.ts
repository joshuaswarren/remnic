import assert from "node:assert/strict";
import test from "node:test";

import { isEmptyDeepRecallTrace } from "./recall-deep-trace-empty.js";

test("null, undefined, and empty array are empty", () => {
  assert.equal(isEmptyDeepRecallTrace(null), true);
  assert.equal(isEmptyDeepRecallTrace(undefined), true);
  assert.equal(isEmptyDeepRecallTrace([]), true);
});

test("a non-empty trace is not empty", () => {
  assert.equal(
    isEmptyDeepRecallTrace([
      {
        action: "expand",
        budget: 1,
        workingSet: [],
        frontier: [],
      },
    ]),
    false,
  );
});

test("non-array throws", () => {
  assert.throws(() => isEmptyDeepRecallTrace("trace"), /array/);
});
