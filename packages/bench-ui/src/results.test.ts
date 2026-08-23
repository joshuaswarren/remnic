import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { loadBenchResultSummaries } from "./results";
import { withTempDir } from "./testing/tmp-dir";

test("loadBenchResultSummaries reports malformed result files as skipped warnings", async () => {
  await withTempDir("results", async (resultsDir) => {
    const validPath = path.join(resultsDir, "valid.json");
    const malformedPath = path.join(resultsDir, "malformed.json");
    await writeFile(
      validPath,
      JSON.stringify({
        meta: {
          id: "run-1",
          benchmark: "locomo",
          timestamp: "2026-05-21T00:00:00.000Z",
        },
        results: { aggregates: {} },
      }),
      "utf8",
    );
    await writeFile(malformedPath, "{not-json", "utf8");

    const payload = await loadBenchResultSummaries(resultsDir);

    assert.equal(payload.summaries.length, 1);
    assert.equal(payload.summaries[0]?.id, "run-1");
    assert.equal(payload.skippedFiles?.length, 1);
    assert.equal(payload.skippedFiles?.[0]?.filePath, malformedPath);
    assert.match(payload.skippedFiles?.[0]?.reason ?? "", /JSON|Expected|property/i);
  });
});

test("loadBenchResultSummaries skips non-standard result modes", async () => {
  await withTempDir("results", async (resultsDir) => {
    const resultPath = path.join(resultsDir, "eval.json");
    await writeFile(
      resultPath,
      JSON.stringify({
        meta: {
          id: "run-eval",
          benchmark: "locomo",
          timestamp: "2026-05-21T00:00:00.000Z",
          mode: "eval",
        },
        results: { aggregates: {} },
      }),
      "utf8",
    );

    const payload = await loadBenchResultSummaries(resultsDir);

    assert.equal(payload.summaries.length, 0);
    assert.equal(payload.skippedFiles?.length, 1);
    assert.equal(payload.skippedFiles?.[0]?.filePath, resultPath);
    assert.match(payload.skippedFiles?.[0]?.reason ?? "", /meta\.mode must be "quick" or "full"/);
  });
});

test("loadBenchResultSummaries skips malformed aggregate and meta fields", async () => {
  await withTempDir("results", async (resultsDir) => {
    const badAggregatePath = path.join(resultsDir, "a-bad-aggregate.json");
    const badMetaPath = path.join(resultsDir, "b-bad-meta.json");
    await writeFile(
      badAggregatePath,
      JSON.stringify({
        meta: {
          id: "run-bad-agg",
          benchmark: "locomo",
          timestamp: "2026-05-21T00:00:00.000Z",
          mode: "quick",
        },
        results: {
          tasks: [{ taskId: "t1" }],
          aggregates: { accuracy: { mean: 0.5, median: "bad" } },
        },
      }),
      "utf8",
    );
    await writeFile(
      badMetaPath,
      JSON.stringify({
        meta: {
          id: "run-bad-meta",
          benchmark: "locomo",
          timestamp: "2026-05-21T00:00:00.000Z",
          mode: "quick",
          failureReason: 404,
        },
        results: { aggregates: {} },
      }),
      "utf8",
    );

    const payload = await loadBenchResultSummaries(resultsDir);

    assert.equal(payload.summaries.length, 0);
    assert.equal(payload.skippedFiles?.length, 2);
    const aggregateSkip = (payload.skippedFiles ?? []).find((entry) => entry.filePath === badAggregatePath);
    const metaSkip = (payload.skippedFiles ?? []).find((entry) => entry.filePath === badMetaPath);
    assert.match(aggregateSkip?.reason ?? "", /median must be a finite number when present/);
    assert.match(metaSkip?.reason ?? "", /failureReason must be a string when present/);
  });
});
