import assert from "node:assert/strict";
import test from "node:test";

import { parseStepCount } from "./recall-deep-step-count.js";

test("step count 0 is allowed", () => {
  assert.equal(parseStepCount(0), 0);
});

test("step count 5 is returned", () => {
  assert.equal(parseStepCount(5), 5);
});

test("negative step count throws", () => {
  assert.throws(() => parseStepCount(-1), /non-negative integer/);
});

test("float step count throws", () => {
  assert.throws(() => parseStepCount(1.5), /non-negative integer/);
});
