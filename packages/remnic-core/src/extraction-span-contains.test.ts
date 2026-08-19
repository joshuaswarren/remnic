import assert from "node:assert/strict";
import { test } from "node:test";
import { spanContainsOffset } from "./extraction-span-contains.js";

test("spanContainsOffset: inside is true", () => {
  assert.equal(spanContainsOffset({ start: 1, end: 4, offset: 2 }), true);
  assert.equal(spanContainsOffset({ start: 1, end: 4, offset: 3 }), true);
});

test("spanContainsOffset: start is inclusive", () => {
  assert.equal(spanContainsOffset({ start: 1, end: 4, offset: 1 }), true);
  assert.equal(spanContainsOffset({ start: 0, end: 5, offset: 0 }), true);
});

test("spanContainsOffset: end is exclusive", () => {
  assert.equal(spanContainsOffset({ start: 1, end: 4, offset: 4 }), false);
  assert.equal(spanContainsOffset({ start: 0, end: 5, offset: 5 }), false);
});

test("spanContainsOffset: inverted span throws", () => {
  assert.throws(() => spanContainsOffset({ start: 3, end: 2, offset: 2 }), /inverted/i);
  assert.throws(() => spanContainsOffset({ start: 1, end: 0, offset: 0 }), /inverted/i);
});

test("spanContainsOffset: non-integers throw", () => {
  assert.throws(() => spanContainsOffset({ start: 1.5, end: 3, offset: 2 }), /integers/);
  assert.throws(() => spanContainsOffset({ start: 0, end: 3.2, offset: 1 }), /integers/);
  assert.throws(() => spanContainsOffset({ start: 0, end: 3, offset: 1.1 }), /integers/);
  assert.throws(() => spanContainsOffset({ start: Number.NaN, end: 3, offset: 1 }), /integers/);
});
