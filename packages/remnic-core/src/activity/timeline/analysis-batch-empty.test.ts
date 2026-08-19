import assert from "node:assert/strict";
import test from "node:test";

import { isEmptyAnalysisBatches } from "./analysis-batch-empty.js";

test("null, undefined, and empty list are empty", () => {
  assert.equal(isEmptyAnalysisBatches(null), true);
  assert.equal(isEmptyAnalysisBatches(undefined), true);
  assert.equal(isEmptyAnalysisBatches([]), true);
});

test("only empty inner batches are empty", () => {
  assert.equal(isEmptyAnalysisBatches([[], []]), true);
  assert.equal(isEmptyAnalysisBatches([null]), true);
  assert.equal(isEmptyAnalysisBatches([undefined]), true);
  assert.equal(isEmptyAnalysisBatches([null, []]), true);
});

test("a non-empty inner batch is not empty", () => {
  assert.equal(isEmptyAnalysisBatches([[], [{ id: 1, capturedAtUtc: "2026-08-19T00:00:00.000Z" }]]), false);
});

test("non-array throws", () => {
  assert.throws(() => isEmptyAnalysisBatches("batches"), /array/);
});
