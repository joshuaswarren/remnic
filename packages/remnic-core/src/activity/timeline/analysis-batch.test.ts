import assert from "node:assert/strict";
import test from "node:test";

import { batchObservations } from "./analysis-batch.js";
import type { TimelineBatchObservation } from "./analysis-batch.js";

function obs(id: number, capturedAtUtc: string): TimelineBatchObservation {
  return { id, capturedAtUtc };
}

test("empty observations return no batches", () => {
  assert.deepEqual(batchObservations([], { maxBatch: 3, overlap: 1 }), []);
});

test("maxBatch 0 returns no batches", () => {
  assert.deepEqual(
    batchObservations([obs(1, "2026-08-17T10:00:00.000Z")], { maxBatch: 0, overlap: 0 }),
    [],
  );
});

test("overlap shares the trailing window with the next batch", () => {
  const items = [1, 2, 3, 4, 5].map((id) => obs(id, `2026-08-17T10:0${id}:00.000Z`));
  const batches = batchObservations(items, { maxBatch: 3, overlap: 1 });
  assert.deepEqual(
    batches.map((batch) => batch.map((item) => item.id)),
    [
      [1, 2, 3],
      [3, 4, 5],
    ],
  );
});

test("order is capturedAtUtc then id, not input order", () => {
  const items = [
    obs(3, "2026-08-17T12:00:00.000Z"),
    obs(2, "2026-08-17T10:00:00.000Z"),
    obs(1, "2026-08-17T10:00:00.000Z"),
  ];
  const batches = batchObservations(items, { maxBatch: 3, overlap: 0 });
  assert.deepEqual(
    batches.map((batch) => batch.map((item) => item.id)),
    [[1, 2, 3]],
  );
});

test("maxBatch below 1 is rejected except 0", () => {
  assert.throws(() => batchObservations([], { maxBatch: -1, overlap: 0 }), RangeError);
  assert.throws(() => batchObservations([], { maxBatch: 0.5, overlap: 0 }), RangeError);
});

test("negative overlap and overlap covering the batch are rejected", () => {
  assert.throws(() => batchObservations([], { maxBatch: 3, overlap: -1 }), RangeError);
  assert.throws(() => batchObservations([], { maxBatch: 3, overlap: 3 }), RangeError);
  assert.throws(() => batchObservations([], { maxBatch: 3, overlap: 4 }), RangeError);
});
