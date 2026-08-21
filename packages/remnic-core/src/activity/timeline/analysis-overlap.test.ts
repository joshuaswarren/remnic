import assert from "node:assert/strict";
import test from "node:test";

import { parseOverlap } from "./analysis-overlap.js";

test("overlap 0 is allowed", () => {
  assert.equal(parseOverlap(0, 8), 0);
  assert.equal(parseOverlap(0, 0), 0);
});

test("overlap 3 with maxBatch 8 is returned", () => {
  assert.equal(parseOverlap(3, 8), 3);
});

test("overlap >= maxBatch throws when maxBatch > 0", () => {
  assert.throws(() => parseOverlap(8, 8), /less than maxBatch/);
  assert.throws(() => parseOverlap(5, 4), /less than maxBatch/);
});

test("negative overlap throws", () => {
  assert.throws(() => parseOverlap(-1, 8), /non-negative integer/);
});

test("float overlap throws", () => {
  assert.throws(() => parseOverlap(1.5, 8), /non-negative integer/);
});
