import type { BenchmarkResult } from "@remnic/bench";

/**
 * A conformant `BenchmarkResult` artifact fixture — the shape
 * `writeBenchmarkResult` produces — for tests that exercise the
 * `/api/results` pipeline end to end.
 */
export function validResultFixture(id = "run-1"): BenchmarkResult {
  return {
    meta: {
      id,
      benchmark: "assistant-synthesis",
      benchmarkTier: "remnic",
      version: "1.0.0",
      remnicVersion: "9.0.0",
      gitSha: "0123456789abcdef",
      timestamp: "2026-05-21T00:00:00.000Z",
      mode: "full",
      runCount: 3,
      seeds: [1, 2, 3],
      splitType: "holdout",
      qrelsSealedHash: `1a${"a".repeat(62)}`,
      judgePromptHash: `2b${"b".repeat(62)}`,
      datasetHash: `3c${"c".repeat(62)}`,
      canaryScore: 0.05,
    },
    config: {
      systemProvider: { provider: "ollama", model: "llama3" },
      judgeProvider: { provider: "openai", model: "gpt-5.2" },
      adapterMode: "direct",
      remnicConfig: {
        assistantRubricId: "assistant-v1",
        assistantRubricSha256: "rubric-sha",
        assistantRunId: "amb-run-1",
      },
    },
    cost: {
      totalTokens: 1200,
      inputTokens: 800,
      outputTokens: 400,
      estimatedCostUsd: 0.012,
      totalLatencyMs: 9500,
      meanQueryLatencyMs: 1583.33,
    },
    results: {
      tasks: [
        {
          taskId: "b-task",
          question: "q2",
          expected: "e2",
          actual: "a2",
          scores: { f1: 0.5, score: 0.9 },
          latencyMs: 1200,
          tokens: { input: 10, output: 4 },
        },
        {
          taskId: "a-task",
          question: "q1",
          expected: "e1",
          actual: "a1",
          scores: { accuracy: 0.61 },
          latencyMs: 900,
          tokens: { input: 790, output: 396 },
          details: {
            focus: "calendar",
            rubricId: "assistant-v1",
            rubricSha256: "rubric-sha",
            judgeParseFailures: 1,
            perSeedScores: [
              {
                seed: 1,
                scores: {
                  identity_accuracy: 5,
                  stance_coherence: 4,
                  novelty: 3,
                  calibration: 5,
                },
                parseOk: true,
                notes: "solid",
                latencyMs: 900,
              },
              {
                seed: 2,
                scores: { identity_accuracy: 4 },
                parseOk: false,
              },
            ],
          },
        },
      ],
      aggregates: {
        zzz_custom: { mean: 1.25, median: 1.2, stdDev: 0.1, min: 1.0, max: 1.4 },
        score: { mean: 0.82, median: 0.8, stdDev: 0.05, min: 0.7, max: 0.9 },
        accuracy: { mean: 0.75, median: 0.74, stdDev: 0.03, min: 0.6, max: 0.8 },
      },
      statistics: {
        bootstrapSamples: 1000,
        confidenceIntervals: {
          score: { lower: 0.78, upper: 0.86, level: 0.95 },
        },
        effectSizes: {
          score: { cohensD: 0.4, interpretation: "medium" },
        },
      },
    },
    environment: {
      os: "linux",
      nodeVersion: "v22.13.0",
      hardware: "x64",
    },
  };
}
