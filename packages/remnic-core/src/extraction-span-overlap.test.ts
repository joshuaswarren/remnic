import assert from "node:assert/strict";
import { test } from "node:test";
import { spansOverlap } from "./extraction-span-overlap.js";

test("spansOverlap: interior overlap is true", () => {
  assert.equal(spansOverlap({ start: 0, end: 4 }, { start: 2, end: 6 }), true);
  assert.equal(spansOverlap({ start: 2, end: 6 }, { start: 0, end: 4 }), true);
  assert.equal(spansOverlap({ start: 1, end: 5 }, { start: 2, end: 3 }), true);
});

test("spansOverlap: touching at an endpoint is false", () => {
  assert.equal(spansOverlap({ start: 0, end: 3 }, { start: 3, end: 5 }), false);
  assert.equal(spansOverlap({ start: 3, end: 5 }, { start: 0, end: 3 }), false);
  assert.equal(spansOverlap({ start: 1, end: 1 }, { start: 1, end: 4 }), false);
});

test("spansOverlap: disjoint spans are false", () => {
  assert.equal(spansOverlap({ start: 0, end: 2 }, { start: 4, end: 6 }), false);
  assert.equal(spansOverlap({ start: 4, end: 6 }, { start: 0, end: 2 }), false);
});

test("spansOverlap: inverted span throws", () => {
  assert.throws(() => spansOverlap({ start: 3, end: 2 }, { start: 0, end: 1 }), /inverted/i);
  assert.throws(() => spansOverlap({ start: 0, end: 1 }, { start: 5, end: 4 }), /inverted/i);
});

test("spansOverlap: non-integers throw", () => {
  assert.throws(() => spansOverlap({ start: 1.5, end: 3 }, { start: 0, end: 1 }), /integers/);
  assert.throws(() => spansOverlap({ start: 0, end: 3 }, { start: 1, end: 2.2 }), /integers/);
  assert.throws(
    () => spansOverlap({ start: Number.NaN, end: 3 }, { start: 0, end: 1 }),
    /integers/,
  );
});
