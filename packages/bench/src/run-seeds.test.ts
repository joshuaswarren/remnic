import assert from "node:assert/strict";
import test from "node:test";

import { buildBenchmarkRunSeeds } from "./run-seeds.js";

test("buildBenchmarkRunSeeds builds deterministic consecutive seeds", () => {
  assert.deepEqual(buildBenchmarkRunSeeds(3), [0, 1, 2]);
  assert.deepEqual(buildBenchmarkRunSeeds(3, 7), [7, 8, 9]);
});

test("buildBenchmarkRunSeeds allows the maximum safe integer only as the final seed", () => {
  assert.deepEqual(buildBenchmarkRunSeeds(1, Number.MAX_SAFE_INTEGER), [
    Number.MAX_SAFE_INTEGER,
  ]);
  assert.deepEqual(buildBenchmarkRunSeeds(2, Number.MAX_SAFE_INTEGER - 1), [
    Number.MAX_SAFE_INTEGER - 1,
    Number.MAX_SAFE_INTEGER,
  ]);
});

test("buildBenchmarkRunSeeds rejects unsafe starting seeds", () => {
  assert.throws(
    () => buildBenchmarkRunSeeds(1, Number.MAX_SAFE_INTEGER + 1),
    /non-negative integer/,
  );
});

test("buildBenchmarkRunSeeds rejects sequences that cross the safe integer limit", () => {
  assert.throws(
    () => buildBenchmarkRunSeeds(3, Number.MAX_SAFE_INTEGER),
    /safe integer range/,
  );
  assert.throws(
    () => buildBenchmarkRunSeeds(2, Number.MAX_SAFE_INTEGER),
    /safe integer range/,
  );
});
