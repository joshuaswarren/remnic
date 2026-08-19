import assert from "node:assert/strict";
import test from "node:test";

import { parseMaxChildren } from "./recall-navigate-max-children.js";

test("max children 0 is allowed", () => {
  assert.equal(parseMaxChildren(0), 0);
});

test("max children 10 is returned", () => {
  assert.equal(parseMaxChildren(10), 10);
});

test("negative max children throws", () => {
  assert.throws(() => parseMaxChildren(-1), /non-negative integer/);
});

test("float max children throws", () => {
  assert.throws(() => parseMaxChildren(1.5), /non-negative integer/);
});
