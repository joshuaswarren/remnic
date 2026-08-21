import assert from "node:assert/strict";
import { test } from "node:test";
import { validateSpanOffsets } from "./extraction-span-validate.js";

test("validateSpanOffsets: empty span", () => {
  assert.deepEqual(validateSpanOffsets({ start: 0, end: 0, textLength: 5 }), {
    ok: false,
    error: "empty",
  });
  assert.deepEqual(validateSpanOffsets({ start: 3, end: 3, textLength: 8 }), {
    ok: false,
    error: "empty",
  });
});

test("validateSpanOffsets: out of range", () => {
  assert.deepEqual(validateSpanOffsets({ start: -1, end: 2, textLength: 8 }), {
    ok: false,
    error: "out_of_range",
  });
  assert.deepEqual(validateSpanOffsets({ start: 5, end: 3, textLength: 8 }), {
    ok: false,
    error: "out_of_range",
  });
  assert.deepEqual(validateSpanOffsets({ start: 0, end: 9, textLength: 8 }), {
    ok: false,
    error: "out_of_range",
  });
});

test("validateSpanOffsets: ok half-open span", () => {
  assert.deepEqual(validateSpanOffsets({ start: 0, end: 5, textLength: 8 }), { ok: true });
  assert.deepEqual(validateSpanOffsets({ start: 0, end: 8, textLength: 8 }), { ok: true });
  assert.deepEqual(validateSpanOffsets({ start: 7, end: 8, textLength: 8 }), { ok: true });
});

test("validateSpanOffsets: non-integers throw", () => {
  assert.throws(() => validateSpanOffsets({ start: 1.5, end: 3, textLength: 8 }), /integers/);
  assert.throws(() => validateSpanOffsets({ start: 0, end: 3.2, textLength: 8 }), /integers/);
  assert.throws(() => validateSpanOffsets({ start: 0, end: 3, textLength: 8.1 }), /integers/);
  assert.throws(() => validateSpanOffsets({ start: Number.NaN, end: 3, textLength: 8 }), /integers/);
});
