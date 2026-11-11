import assert from "node:assert/strict";
import test from "node:test";

import { fullCorpusHeapPressure } from "./full-corpus-heap-guard.js";

test("fullCorpusHeapPressure postpones only when usage is strictly above the limit", () => {
  assert.deepEqual(fullCorpusHeapPressure({ used_heap_size: 61, heap_size_limit: 100 }, 0.6), {
    postpone: true,
    ratio: 0.61,
  });
  assert.deepEqual(fullCorpusHeapPressure({ used_heap_size: 60, heap_size_limit: 100 }, 0.6), {
    postpone: false,
    ratio: 0.6,
  });
  assert.deepEqual(fullCorpusHeapPressure({ used_heap_size: 59, heap_size_limit: 100 }, 0.6), {
    postpone: false,
    ratio: 0.59,
  });
});

test("fullCorpusHeapPressure never fires at limit ratio 1", () => {
  const pressure = fullCorpusHeapPressure({ used_heap_size: 100, heap_size_limit: 100 }, 1);
  assert.equal(pressure.postpone, false);
  assert.equal(pressure.ratio, 1);
});

test("fullCorpusHeapPressure ignores unusable statistics or limits", () => {
  assert.deepEqual(fullCorpusHeapPressure({ used_heap_size: 90, heap_size_limit: 0 }, 0.6), {
    postpone: false,
    ratio: 0,
  });
  assert.deepEqual(fullCorpusHeapPressure({ used_heap_size: 90, heap_size_limit: -1 }, 0.6), {
    postpone: false,
    ratio: 0,
  });
  assert.deepEqual(fullCorpusHeapPressure({ used_heap_size: Number.NaN, heap_size_limit: 100 }, 0.6), {
    postpone: false,
    ratio: 0,
  });
  assert.deepEqual(fullCorpusHeapPressure({ used_heap_size: -1, heap_size_limit: 100 }, 0.6), {
    postpone: false,
    ratio: 0,
  });
  assert.deepEqual(fullCorpusHeapPressure({ used_heap_size: 90, heap_size_limit: 100 }, Number.NaN), {
    postpone: false,
    ratio: 0,
  });
  assert.deepEqual(
    fullCorpusHeapPressure({ used_heap_size: Number.POSITIVE_INFINITY, heap_size_limit: 100 }, 0.6),
    { postpone: false, ratio: 0 },
  );
});
