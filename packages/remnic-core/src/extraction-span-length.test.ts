import assert from "node:assert/strict";
import { test } from "node:test";
import { spanLength } from "./extraction-span-length.js";

test("spanLength: empty span is zero", () => {
  assert.equal(spanLength({ start: 0, end: 0 }), 0);
  assert.equal(spanLength({ start: 4, end: 4 }), 0);
});

test("spanLength: mid span is half-open end-start", () => {
  assert.equal(spanLength({ start: 1, end: 4 }), 3);
  assert.equal(spanLength({ start: 0, end: 5 }), 5);
  assert.equal(spanLength({ start: 4, end: 5 }), 1);
});

test("spanLength: inverted span throws", () => {
  assert.throws(() => spanLength({ start: 3, end: 2 }), /inverted/i);
  assert.throws(() => spanLength({ start: 1, end: 0 }), /inverted/i);
});

test("spanLength: non-integers throw", () => {
  assert.throws(() => spanLength({ start: 1.5, end: 3 }), /integers/);
  assert.throws(() => spanLength({ start: 0, end: 3.2 }), /integers/);
  assert.throws(() => spanLength({ start: Number.NaN, end: 3 }), /integers/);
});
