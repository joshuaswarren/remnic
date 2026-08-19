import assert from "node:assert/strict";
import test from "node:test";

import { breakMergeTie } from "./merge-tie.js";

test("a wins when aId is lower", () => {
  assert.equal(breakMergeTie("alpha", "zeta"), "alpha");
});

test("b wins when bId is lower", () => {
  assert.equal(breakMergeTie("zeta", "alpha"), "alpha");
});

test("same id returns aId", () => {
  assert.equal(breakMergeTie("alpha", "alpha"), "alpha");
});

test("empty id throws", () => {
  assert.throws(() => breakMergeTie("", "alpha"), /empty merge id/);
  assert.throws(() => breakMergeTie("alpha", ""), /empty merge id/);
  assert.throws(() => breakMergeTie("", ""), /empty merge id/);
});
