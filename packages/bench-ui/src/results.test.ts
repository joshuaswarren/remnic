import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  loadBenchmarkResultSummaries,
  loadBenchResultSummaries,
} from "./results";
import { validResultFixture } from "./testing/result-fixture";
import { withTempDir } from "./testing/tmp-dir";

test("loadBenchmarkResultSummaries produces the full UI summary for a conformant artifact", async () => {
  await withTempDir("results", async (resultsDir) => {
    const filePath = path.join(resultsDir, "equiv.json");
    await writeFile(filePath, JSON.stringify(validResultFixture("run-equiv")), "utf8");

    const payload = await loadBenchmarkResultSummaries(resultsDir);

    assert.deepEqual(payload.skippedFiles, []);
    assert.equal(payload.summaries.length, 1);
    assert.deepEqual(payload.summaries[0], {
      id: "run-equiv",
      benchmark: "assistant-synthesis",
      benchmarkTier: "remnic",
      timestamp: "2026-05-21T00:00:00.000Z",
      mode: "full",
      totalLatencyMs: 9500,
      meanQueryLatencyMs: 1583.33,
      taskCount: 2,
      metricHighlights: [
        { name: "score", mean: 0.82 },
        { name: "accuracy", mean: 0.75 },
        { name: "zzz_custom", mean: 1.25 },
      ],
      primaryMetric: "score",
      primaryScore: 0.82,
      runCount: 3,
      estimatedCostUsd: 0.012,
      totalTokens: 1200,
      inputTokens: 800,
      outputTokens: 400,
      systemProvider: "ollama/llama3",
      judgeProvider: "openai/gpt-5.2",
      providerKey: "ollama/llama3__openai/gpt-5.2",
      adapterMode: "direct",
      aggregateMetrics: [
        {
          name: "score",
          mean: 0.82,
          median: 0.8,
          stdDev: 0.05,
          min: 0.7,
          max: 0.9,
          ciLower: 0.78,
          ciUpper: 0.86,
          ciLevel: 0.95,
          effectSize: 0.4,
          effectInterpretation: "medium",
        },
        {
          name: "accuracy",
          mean: 0.75,
          median: 0.74,
          stdDev: 0.03,
          min: 0.6,
          max: 0.8,
          ciLower: null,
          ciUpper: null,
          ciLevel: null,
          effectSize: null,
          effectInterpretation: null,
        },
        {
          name: "zzz_custom",
          mean: 1.25,
          median: 1.2,
          stdDev: 0.1,
          min: 1,
          max: 1.4,
          ciLower: null,
          ciUpper: null,
          ciLevel: null,
          effectSize: null,
          effectInterpretation: null,
        },
      ],
      taskSummaries: [
        {
          taskId: "a-task",
          question: "q1",
          expected: "e1",
          actual: "a1",
          latencyMs: 900,
          totalTokens: 1186,
          primaryScore: 0.61,
          scoreEntries: [{ name: "accuracy", value: 0.61 }],
          assistantDetails: {
            focus: "calendar",
            rubricId: "assistant-v1",
            rubricSha256: "rubric-sha",
            perSeedScores: [
              {
                seed: 1,
                identityAccuracy: 5,
                stanceCoherence: 4,
                novelty: 3,
                calibration: 5,
                parseOk: true,
                notes: "solid",
                latencyMs: 900,
              },
              {
                seed: 2,
                identityAccuracy: 4,
                stanceCoherence: null,
                novelty: null,
                calibration: null,
                parseOk: false,
                notes: "",
                latencyMs: null,
              },
            ],
            judgeParseFailures: 1,
          },
        },
        {
          taskId: "b-task",
          question: "q2",
          expected: "e2",
          actual: "a2",
          latencyMs: 1200,
          totalTokens: 14,
          primaryScore: 0.9,
          scoreEntries: [
            { name: "score", value: 0.9 },
            { name: "f1", value: 0.5 },
          ],
          assistantDetails: null,
        },
      ],
      integrity: {
        split: "holdout",
        sealsPresent: true,
        canaryScore: 0.05,
        canaryFloor: 0.1,
        canaryUnderFloor: true,
        qrelsSealedHashShort: "1aaaaaaaaaaa",
        judgePromptHashShort: "2bbbbbbbbbbb",
        datasetHashShort: "3ccccccccccc",
      },
      assistantRubricId: "assistant-v1",
      assistantRubricSha256: "rubric-sha",
      assistantRunId: "amb-run-1",
      filePath,
    });
  });
});

test("loadBenchResultSummaries compatibility export emits deprecation warning once and matches parser output", async () => {
  await withTempDir("results", async (resultsDir) => {
    await writeFile(
      path.join(resultsDir, "compat.json"),
      JSON.stringify(validResultFixture("run-compat")),
      "utf8",
    );
    await writeFile(path.join(resultsDir, "malformed.json"), "{not-json", "utf8");

    const warnings: Error[] = [];
    const onWarning = (warning: Error) => {
      warnings.push(warning);
    };
    process.on("warning", onWarning);

    try {
      const directResult = await loadBenchmarkResultSummaries(resultsDir);
      assert.equal(warnings.length, 0);

      const firstWrapperCall = await loadBenchResultSummaries(resultsDir);
      assert.equal(warnings.length, 1);
      assert.equal(warnings[0]?.name, "DeprecationWarning");
      assert.match(
        warnings[0]?.message ?? "",
        /loadBenchResultSummaries is deprecated; use loadBenchmarkResultSummaries from @remnic\/bench/,
      );

      const secondWrapperCall = await loadBenchResultSummaries(resultsDir);
      assert.equal(warnings.length, 1);

      assert.deepEqual(firstWrapperCall, directResult);
      assert.deepEqual(secondWrapperCall, directResult);
      assert.equal(firstWrapperCall.summaries.length, 1);
      assert.equal(firstWrapperCall.summaries[0]?.id, "run-compat");
      assert.equal(firstWrapperCall.skippedFiles?.length, 1);
    } finally {
      process.removeListener("warning", onWarning);
    }
  });
});

test("loadBenchmarkResultSummaries honors a canary floor persisted in the artifact", async () => {
  await withTempDir("results", async (resultsDir) => {
    const artifact = validResultFixture("run-floored");
    artifact.meta.canaryScore = 0.15;
    artifact.meta.canaryFloor = 0.2;
    await writeFile(
      path.join(resultsDir, "floored.json"),
      JSON.stringify(artifact),
      "utf8",
    );

    const payload = await loadBenchmarkResultSummaries(resultsDir);

    assert.equal(payload.summaries[0]?.integrity.canaryFloor, 0.2);
    assert.equal(payload.summaries[0]?.integrity.canaryUnderFloor, true);
  });
});

test("loadBenchmarkResultSummaries skips malformed and non-conformant result files", async () => {
  await withTempDir("results", async (resultsDir) => {
    const partialPath = path.join(resultsDir, "partial.json");
    const malformedPath = path.join(resultsDir, "malformed.json");
    await writeFile(
      partialPath,
      JSON.stringify({
        meta: { id: "run-1", benchmark: "locomo", timestamp: "2026-05-21T00:00:00.000Z" },
        results: { aggregates: {} },
      }),
      "utf8",
    );
    await writeFile(malformedPath, "{not-json", "utf8");

    const payload = await loadBenchmarkResultSummaries(resultsDir);

    assert.deepEqual(payload.summaries, []);
    assert.equal(payload.skippedFiles?.length, 2);
    const partial = payload.skippedFiles?.find((skip) => skip.filePath === partialPath);
    const malformed = payload.skippedFiles?.find((skip) => skip.filePath === malformedPath);
    assert.match(partial?.reason ?? "", /Invalid benchmark result file/);
    assert.match(malformed?.reason ?? "", /JSON|Expected|property/i);
  });
});
