import assert from "node:assert/strict";
import test from "node:test";

import { histogramBarHeight } from "./BenchmarkDetail";

test("histogramBarHeight caps large buckets and preserves non-empty visibility", () => {
  assert.equal(histogramBarHeight(0, 100), 0);
  assert.equal(histogramBarHeight(1, 100), 12);
  assert.equal(histogramBarHeight(50, 100), 60);
  assert.equal(histogramBarHeight(100, 100), 120);
});
