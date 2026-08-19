import assert from "node:assert/strict";
import { test } from "node:test";
import { clipSpan } from "./extraction-span-clip.js";

test("clipSpan: in-range span is unchanged", () => {
  assert.deepEqual(clipSpan({ start: 1, end: 4, textLength: 8 }), {
    ok: true,
    start: 1,
    end: 4,
  });
  assert.deepEqual(clipSpan({ start: 0, end: 8, textLength: 8 }), {
    ok: true,
    start: 0,
    end: 8,
  });
});

test("clipSpan: clips to [0, textLength]", () => {
  assert.deepEqual(clipSpan({ start: -3, end: 4, textLength: 10 }), {
    ok: true,
    start: 0,
    end: 4,
  });
  assert.deepEqual(clipSpan({ start: 6, end: 20, textLength: 10 }), {
    ok: true,
    start: 6,
    end: 10,
  });
  assert.deepEqual(clipSpan({ start: -2, end: 99, textLength: 5 }), {
    ok: true,
    start: 0,
    end: 5,
  });
});

test("clipSpan: empty after clip", () => {
  assert.deepEqual(clipSpan({ start: 3, end: 3, textLength: 8 }), {
    ok: false,
    error: "empty",
  });
  assert.deepEqual(clipSpan({ start: 5, end: 2, textLength: 8 }), {
    ok: false,
    error: "empty",
  });
  assert.deepEqual(clipSpan({ start: -4, end: -1, textLength: 8 }), {
    ok: false,
    error: "empty",
  });
});

test("clipSpan: oob collapses to empty", () => {
  assert.deepEqual(clipSpan({ start: 10, end: 20, textLength: 8 }), {
    ok: false,
    error: "empty",
  });
  assert.deepEqual(clipSpan({ start: 8, end: 12, textLength: 8 }), {
    ok: false,
    error: "empty",
  });
  assert.deepEqual(clipSpan({ start: -5, end: 0, textLength: 8 }), {
    ok: false,
    error: "empty",
  });
});

test("clipSpan: non-integers throw", () => {
  assert.throws(() => clipSpan({ start: 1.5, end: 3, textLength: 8 }), /integers/);
  assert.throws(() => clipSpan({ start: 0, end: 3.2, textLength: 8 }), /integers/);
  assert.throws(() => clipSpan({ start: 0, end: 3, textLength: 8.1 }), /integers/);
  assert.throws(() => clipSpan({ start: Number.NaN, end: 3, textLength: 8 }), /integers/);
});
