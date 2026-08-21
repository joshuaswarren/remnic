import assert from "node:assert/strict";
import { test } from "node:test";
import { joinAdjacentSpans } from "./extraction-span-join.js";

test("joinAdjacentSpans: adjacent half-open spans join", () => {
  assert.deepEqual(joinAdjacentSpans({ start: 0, end: 3 }, { start: 3, end: 5 }), {
    start: 0,
    end: 5,
  });
  assert.deepEqual(joinAdjacentSpans({ start: 1, end: 1 }, { start: 1, end: 4 }), {
    start: 1,
    end: 4,
  });
});

test("joinAdjacentSpans: gap is not_adjacent", () => {
  assert.deepEqual(joinAdjacentSpans({ start: 0, end: 2 }, { start: 4, end: 6 }), {
    ok: false,
    error: "not_adjacent",
  });
  assert.deepEqual(joinAdjacentSpans({ start: 4, end: 6 }, { start: 0, end: 2 }), {
    ok: false,
    error: "not_adjacent",
  });
});

test("joinAdjacentSpans: overlap is not_adjacent", () => {
  assert.deepEqual(joinAdjacentSpans({ start: 0, end: 4 }, { start: 2, end: 6 }), {
    ok: false,
    error: "not_adjacent",
  });
  assert.deepEqual(joinAdjacentSpans({ start: 1, end: 5 }, { start: 2, end: 3 }), {
    ok: false,
    error: "not_adjacent",
  });
});

test("joinAdjacentSpans: inverted span throws", () => {
  assert.throws(() => joinAdjacentSpans({ start: 3, end: 2 }, { start: 0, end: 1 }), /inverted/i);
  assert.throws(() => joinAdjacentSpans({ start: 0, end: 1 }, { start: 5, end: 4 }), /inverted/i);
});

test("joinAdjacentSpans: non-integers throw", () => {
  assert.throws(() => joinAdjacentSpans({ start: 1.5, end: 3 }, { start: 3, end: 5 }), /integers/);
  assert.throws(() => joinAdjacentSpans({ start: 0, end: 3 }, { start: 3, end: 5.2 }), /integers/);
  assert.throws(
    () => joinAdjacentSpans({ start: Number.NaN, end: 3 }, { start: 3, end: 5 }),
    /integers/,
  );
});
