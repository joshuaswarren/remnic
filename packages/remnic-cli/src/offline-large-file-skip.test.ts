import assert from "node:assert/strict";
import test from "node:test";

import {
  advanceOfflineLargeFileFailureCounts,
  OFFLINE_LARGE_FILE_SKIP_AFTER_FAILURES,
} from "./index.js";

test("advanceOfflineLargeFileFailureCounts records a fresh failure at count 1", () => {
  const result = advanceOfflineLargeFileFailureCounts({
    counts: new Map(),
    failures: [{ path: "state/big.bin" }],
  });
  assert.deepEqual([...result.counts.entries()], [["state/big.bin", 1]]);
  assert.deepEqual(result.newlySkipped, []);
});

test("advanceOfflineLargeFileFailureCounts flips a path into newlySkipped on the third consecutive failure", () => {
  const result = advanceOfflineLargeFileFailureCounts({
    counts: new Map([["state/big.bin", 2]]),
    failures: [{ path: "state/big.bin" }],
  });
  assert.deepEqual([...result.counts.entries()], [["state/big.bin", 3]]);
  assert.deepEqual(result.newlySkipped, ["state/big.bin"]);
});

test("advanceOfflineLargeFileFailureCounts resets the counter for paths that did not fail this run", () => {
  const result = advanceOfflineLargeFileFailureCounts({
    counts: new Map([["state/big.bin", 2]]),
    failures: [{ path: "state/other.bin" }],
  });
  // The previously-tracked path is gone from the next map; only the
  // failing path is tracked, at count 1.
  assert.deepEqual([...result.counts.entries()], [["state/other.bin", 1]]);
  assert.deepEqual(result.newlySkipped, []);
});

test("advanceOfflineLargeFileFailureCounts honors a threshold override (threshold 1 skips on first failure)", () => {
  const result = advanceOfflineLargeFileFailureCounts({
    counts: new Map(),
    failures: [{ path: "state/big.bin" }],
    threshold: 1,
  });
  assert.deepEqual([...result.counts.entries()], [["state/big.bin", 1]]);
  assert.deepEqual(result.newlySkipped, ["state/big.bin"]);
});

test("OFFLINE_LARGE_FILE_SKIP_AFTER_FAILURES is 3", () => {
  assert.equal(OFFLINE_LARGE_FILE_SKIP_AFTER_FAILURES, 3);
});