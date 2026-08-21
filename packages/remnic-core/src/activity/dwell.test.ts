import assert from "node:assert/strict";
import test from "node:test";

import { sumDwellSeconds } from "./dwell.js";

test("empty spans sum to 0", () => {
  assert.equal(sumDwellSeconds([]), 0);
});

test("skips negative duration", () => {
  assert.equal(
    sumDwellSeconds([
      { startMs: 0, endMs: 1000 },
      { startMs: 2000, endMs: 1000 },
    ]),
    1,
  );
});

test("two spans add without merging overlaps", () => {
  assert.equal(
    sumDwellSeconds([
      { startMs: 0, endMs: 2000 },
      { startMs: 1000, endMs: 3000 },
    ]),
    4,
  );
});
