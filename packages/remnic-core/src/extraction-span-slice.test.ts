import assert from "node:assert/strict";
import { test } from "node:test";
import { sliceSpanText } from "./extraction-span-slice.js";

const TEXT = "hello";

test("sliceSpanText: empty span is empty string", () => {
  assert.equal(sliceSpanText({ text: TEXT, start: 2, end: 2 }), "");
  assert.equal(sliceSpanText({ text: TEXT, start: 0, end: 0 }), "");
  assert.equal(sliceSpanText({ text: TEXT, start: TEXT.length, end: TEXT.length }), "");
  assert.equal(sliceSpanText({ text: "", start: 0, end: 0 }), "");
});

test("sliceSpanText: mid span is half-open [start, end)", () => {
  assert.equal(sliceSpanText({ text: TEXT, start: 1, end: 4 }), "ell");
  assert.equal(sliceSpanText({ text: TEXT, start: 0, end: 5 }), "hello");
  assert.equal(sliceSpanText({ text: TEXT, start: 0, end: 1 }), "h");
  assert.equal(sliceSpanText({ text: TEXT, start: 4, end: 5 }), "o");
});

test("sliceSpanText: out of range throws", () => {
  assert.throws(() => sliceSpanText({ text: TEXT, start: -1, end: 2 }), /out of range/i);
  assert.throws(() => sliceSpanText({ text: TEXT, start: 0, end: 6 }), /out of range/i);
  assert.throws(() => sliceSpanText({ text: TEXT, start: 3, end: 2 }), /out of range/i);
  assert.throws(() => sliceSpanText({ text: TEXT, start: 6, end: 6 }), /out of range/i);
});

test("sliceSpanText: non-integers throw", () => {
  assert.throws(() => sliceSpanText({ text: TEXT, start: 1.5, end: 3 }), /integers/);
  assert.throws(() => sliceSpanText({ text: TEXT, start: 0, end: 3.2 }), /integers/);
  assert.throws(() => sliceSpanText({ text: TEXT, start: Number.NaN, end: 3 }), /integers/);
});
