import assert from "node:assert/strict";
import test from "node:test";

import { shouldSkipMergeJudge } from "./merge-threshold.js";

test("disabled merge skips the judge", () => {
  assert.equal(shouldSkipMergeJudge({ enabled: false, score: 0.85, skipThreshold: 0.92 }), true);
});

test("skipThreshold 0 never skips on score", () => {
  assert.equal(shouldSkipMergeJudge({ enabled: true, score: 1, skipThreshold: 0 }), false);
  assert.equal(shouldSkipMergeJudge({ enabled: true, score: 0, skipThreshold: 0 }), false);
});

test("score at or above skipThreshold skips", () => {
  assert.equal(shouldSkipMergeJudge({ enabled: true, score: 0.92, skipThreshold: 0.92 }), true);
  assert.equal(shouldSkipMergeJudge({ enabled: true, score: 0.99, skipThreshold: 0.92 }), true);
  assert.equal(shouldSkipMergeJudge({ enabled: true, score: 0.91, skipThreshold: 0.92 }), false);
});

test("invalid score or threshold throws", () => {
  assert.throws(
    () => shouldSkipMergeJudge({ enabled: true, score: Number.NaN, skipThreshold: 0.92 }),
    /invalid merge score/,
  );
  assert.throws(
    () => shouldSkipMergeJudge({ enabled: true, score: -0.1, skipThreshold: 0.92 }),
    /invalid merge score/,
  );
  assert.throws(
    () => shouldSkipMergeJudge({ enabled: true, score: 1.1, skipThreshold: 0.92 }),
    /invalid merge score/,
  );
  assert.throws(
    () => shouldSkipMergeJudge({ enabled: true, score: 0.5, skipThreshold: Number.NaN }),
    /invalid merge skipThreshold/,
  );
  assert.throws(
    () => shouldSkipMergeJudge({ enabled: true, score: 0.5, skipThreshold: -0.01 }),
    /invalid merge skipThreshold/,
  );
  assert.throws(
    () => shouldSkipMergeJudge({ enabled: true, score: 0.5, skipThreshold: 1.01 }),
    /invalid merge skipThreshold/,
  );
});
