import assert from "node:assert/strict";
import test from "node:test";

import { parseMinMergeScore } from "./merge-min-score.js";

test("minScore 0 is accepted", () => {
  assert.equal(parseMinMergeScore(0), 0);
});

test("minScore 1 is accepted", () => {
  assert.equal(parseMinMergeScore(1), 1);
});

test("minScore 0.5 is accepted", () => {
  assert.equal(parseMinMergeScore(0.5), 0.5);
});

test("out of range minScore throws", () => {
  assert.throws(() => parseMinMergeScore(-0.1), /\[0, 1\]/);
  assert.throws(() => parseMinMergeScore(1.1), /\[0, 1\]/);
});

test("non-finite minScore throws", () => {
  assert.throws(() => parseMinMergeScore(Number.NaN), RangeError);
  assert.throws(() => parseMinMergeScore(Number.POSITIVE_INFINITY), RangeError);
  assert.throws(() => parseMinMergeScore("0.5"), RangeError);
});
