import assert from "node:assert/strict";
import test from "node:test";

import { parseMaxBatch } from "./analysis-max.js";

test("maxBatch 0 is allowed", () => {
  assert.equal(parseMaxBatch(0), 0);
});

test("maxBatch 8 is returned", () => {
  assert.equal(parseMaxBatch(8), 8);
});

test("negative maxBatch throws", () => {
  assert.throws(() => parseMaxBatch(-1), /non-negative integer/);
});

test("float maxBatch throws", () => {
  assert.throws(() => parseMaxBatch(1.5), /non-negative integer/);
});
