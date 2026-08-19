import assert from "node:assert/strict";
import test from "node:test";

import { compareMergeScore } from "./merge-score.js";

test("higher score wins", () => {
  assert.equal(compareMergeScore(0.9, 0.8), 1);
  assert.equal(compareMergeScore(0.8, 0.9), -1);
});

test("equal scores return 0", () => {
  assert.equal(compareMergeScore(0.85, 0.85), 0);
});

test("NaN or non-finite scores throw", () => {
  assert.throws(() => compareMergeScore(Number.NaN, 0.5), /invalid merge score/);
  assert.throws(() => compareMergeScore(0.5, Number.NaN), /invalid merge score/);
  assert.throws(() => compareMergeScore(Number.POSITIVE_INFINITY, 0.5), /invalid merge score/);
  assert.throws(() => compareMergeScore(0.5, Number.NEGATIVE_INFINITY), /invalid merge score/);
});
