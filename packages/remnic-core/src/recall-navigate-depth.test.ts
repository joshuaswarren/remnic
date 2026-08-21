import assert from "node:assert/strict";
import test from "node:test";

import { parseNavigateDepth } from "./recall-navigate-depth.js";

test("depth 0 is allowed", () => {
  assert.equal(parseNavigateDepth(0), 0);
});

test("depth 3 is returned", () => {
  assert.equal(parseNavigateDepth(3), 3);
});

test("negative depth throws", () => {
  assert.throws(() => parseNavigateDepth(-1), /non-negative integer/);
});

test("float depth throws", () => {
  assert.throws(() => parseNavigateDepth(1.5), /non-negative integer/);
});
