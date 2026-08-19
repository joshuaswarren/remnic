import assert from "node:assert/strict";
import { test } from "node:test";
import { shiftSpan } from "./extraction-span-shift.js";

test("shiftSpan: +delta", () => {
  assert.deepEqual(shiftSpan({ start: 1, end: 4, delta: 3 }), { start: 4, end: 7 });
  assert.deepEqual(shiftSpan({ start: 0, end: 0, delta: 5 }), { start: 5, end: 5 });
});

test("shiftSpan: -delta", () => {
  assert.deepEqual(shiftSpan({ start: 5, end: 8, delta: -2 }), { start: 3, end: 6 });
  assert.deepEqual(shiftSpan({ start: 2, end: 2, delta: -2 }), { start: 0, end: 0 });
});

test("shiftSpan: inverted span throws", () => {
  assert.throws(() => shiftSpan({ start: 3, end: 2, delta: 1 }), /inverted/i);
  assert.throws(() => shiftSpan({ start: 1, end: 0, delta: 0 }), /inverted/i);
});

test("shiftSpan: non-integers throw", () => {
  assert.throws(() => shiftSpan({ start: 1.5, end: 3, delta: 1 }), /integers/);
  assert.throws(() => shiftSpan({ start: 0, end: 3.2, delta: 1 }), /integers/);
  assert.throws(() => shiftSpan({ start: 0, end: 3, delta: 1.5 }), /integers/);
  assert.throws(() => shiftSpan({ start: Number.NaN, end: 3, delta: 0 }), /integers/);
});
