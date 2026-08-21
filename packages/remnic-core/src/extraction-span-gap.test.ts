import assert from "node:assert/strict";
import { test } from "node:test";
import { spanGap } from "./extraction-span-gap.js";

test("spanGap: disjoint half-open gap is b.start - a.end", () => {
  assert.equal(spanGap({ start: 0, end: 2 }, { start: 4, end: 6 }), 2);
  assert.equal(spanGap({ start: 0, end: 3 }, { start: 3, end: 5 }), 0);
  assert.equal(spanGap({ start: 4, end: 6 }, { start: 0, end: 2 }), 2);
});

test("spanGap: overlap is 0", () => {
  assert.equal(spanGap({ start: 0, end: 4 }, { start: 2, end: 6 }), 0);
  assert.equal(spanGap({ start: 1, end: 5 }, { start: 2, end: 3 }), 0);
});

test("spanGap: inverted span throws", () => {
  assert.throws(() => spanGap({ start: 3, end: 2 }, { start: 0, end: 1 }), /inverted/i);
  assert.throws(() => spanGap({ start: 0, end: 1 }, { start: 5, end: 4 }), /inverted/i);
});

test("spanGap: non-integers throw", () => {
  assert.throws(() => spanGap({ start: 1.5, end: 3 }, { start: 3, end: 5 }), /integers/);
  assert.throws(() => spanGap({ start: 0, end: 3 }, { start: 3, end: 5.2 }), /integers/);
  assert.throws(
    () => spanGap({ start: Number.NaN, end: 3 }, { start: 3, end: 5 }),
    /integers/,
  );
});

