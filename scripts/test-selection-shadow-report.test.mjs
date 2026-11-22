/** Tests for the issue-#3471 shadow-selection comparison report. */
import { test } from "node:test";
import assert from "node:assert/strict";

import { buildShadowReport } from "./test-selection-shadow-report.mjs";

const shard = (over) => ({
  file: `shadow-${over.shard}.json`,
  payload: {
    shard: over.shard,
    mode: "selected",
    shardFileCount: 100,
    wouldRunCount: 100,
    wouldRun: [],
    changed: [],
    unmapped: [],
    outcome: "success",
    ...over,
  },
});

test("failed shard with proposed skips is flagged suspect", () => {
  const report = buildShadowReport([
    shard({ shard: "1/2", wouldRunCount: 40, outcome: "failure" }),
    shard({ shard: "2/2", outcome: "success" }),
  ]);
  assert.equal(report.summary.verdict, "attention");
  assert.deepEqual(report.summary.suspectShards, ["1/2"]);
  assert.equal(report.summary.testsWouldHaveSkipped, 60);
});

test("all-green run reports no evidence of a miss", () => {
  const report = buildShadowReport([
    shard({ shard: "1/2", wouldRunCount: 10 }),
    shard({ shard: "2/2", mode: "all" }),
  ]);
  assert.equal(report.summary.verdict, "no-evidence-of-miss");
  assert.equal(report.summary.testsWouldHaveSkipped, 90);
  assert.equal(report.summary.shardsFullySelected, 1);
});

test("a failed shard with no proposed skips is not a miss", () => {
  const report = buildShadowReport([shard({ shard: "1/2", outcome: "failure" })]);
  assert.equal(report.summary.verdict, "failed-shard-had-no-proposed-skips");
  assert.deepEqual(report.summary.suspectShards, []);
});

test("empty artifact set still emits a well-formed report", () => {
  const report = buildShadowReport([]);
  assert.equal(report.summary.totalShards, 0);
  assert.deepEqual(report.shards, []);
});
