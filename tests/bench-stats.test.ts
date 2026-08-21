import test from "node:test";
import assert from "node:assert/strict";
import {
  bootstrapMeanConfidenceInterval,
  pairedDeltaConfidenceInterval,
} from "../packages/bench/src/stats/bootstrap.ts";
import {
  cohensD,
  interpretEffectSize,
} from "../packages/bench/src/stats/effect-size.ts";
import { compareResults } from "../packages/bench/src/stats/comparison.ts";
import {
  buildBenchmarkRunSeeds,
  orchestrateBenchmarkRuns,
  resolveBenchmarkRunCount,
} from "../packages/bench/src/benchmark.ts";
import type { BenchmarkResult } from "../packages/bench/src/types.ts";

function makeDeterministicRandom(seed = 7): () => number {
  let state = seed;
  return () => {
    state = (state * 48271) % 0x7fffffff;
    return state / 0x7fffffff;
  };
}

function buildBenchmarkResult(
  benchmark: string,
  scoreValues: number[],
): BenchmarkResult {
  return {
    meta: {
      id: `${benchmark}-run`,
      benchmark,
      benchmarkTier: "published",
      version: "1.0.0",
      remnicVersion: "9.3.32",
      gitSha: "abc123",
      timestamp: "2026-04-18T00:00:00.000Z",
      mode: "full",
      runCount: 5,
      seeds: [0, 1, 2, 3, 4],
    },
    config: {
      systemProvider: null,
      judgeProvider: null,
      adapterMode: "lightweight",
      remnicConfig: {},
    },
    cost: {
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      estimatedCostUsd: 0,
      totalLatencyMs: 0,
      meanQueryLatencyMs: 0,
    },
    results: {
      tasks: scoreValues.map((value, index) => ({
        taskId: `task-${index}`,
        question: `Question ${index}`,
        expected: `Expected ${index}`,
        actual: `Actual ${index}`,
        scores: {
          f1: value,
        },
        latencyMs: 10,
        tokens: {
          input: 0,
          output: 0,
        },
      })),
      aggregates: {
        f1: {
          mean: scoreValues.reduce((sum, value) => sum + value, 0) / scoreValues.length,
          median: scoreValues[Math.floor(scoreValues.length / 2)] ?? 0,
          stdDev: 0,
          min: Math.min(...scoreValues),
          max: Math.max(...scoreValues),
        },
      },
    },
    environment: {
      os: "darwin",
      nodeVersion: process.version,
    },
  };
}

test("resolveBenchmarkRunCount keeps quick mode single-run and defaults full mode to five runs", () => {
  assert.equal(resolveBenchmarkRunCount("quick", 99), 1);
  assert.equal(resolveBenchmarkRunCount("full"), 5);
  assert.equal(resolveBenchmarkRunCount("full", 3), 3);
  assert.throws(() => resolveBenchmarkRunCount("full", 0), /positive integer/);
});

test("buildBenchmarkRunSeeds produces deterministic sequential seeds", () => {
  assert.deepEqual(buildBenchmarkRunSeeds(4), [0, 1, 2, 3]);
  assert.deepEqual(buildBenchmarkRunSeeds(3, 11), [11, 12, 13]);
  assert.throws(() => buildBenchmarkRunSeeds(0), /positive integer/);
});

test("orchestrateBenchmarkRuns executes once per planned seed", async () => {
  const seen: Array<{ seed: number; runIndex: number }> = [];
  const batch = await orchestrateBenchmarkRuns(
    "full",
    async (seed, runIndex) => {
      seen.push({ seed, runIndex });
      return `${seed}:${runIndex}`;
    },
    3,
    5,
  );

  assert.equal(batch.runCount, 3);
  assert.deepEqual(batch.seeds, [5, 6, 7]);
  assert.deepEqual(batch.runs, ["5:0", "6:1", "7:2"]);
  assert.deepEqual(seen, [
    { seed: 5, runIndex: 0 },
    { seed: 6, runIndex: 1 },
    { seed: 7, runIndex: 2 },
  ]);
});

test("bootstrapMeanConfidenceInterval returns an ordered interval around the sample mean", () => {
  const interval = bootstrapMeanConfidenceInterval(
    [0.2, 0.4, 0.6, 0.8],
    {
      iterations: 200,
      random: makeDeterministicRandom(17),
    },
  );

  assert.equal(interval.level, 0.95);
  assert.ok(interval.lower <= interval.upper);
  assert.ok(interval.lower <= 0.5);
  assert.ok(interval.upper >= 0.5);
});

test("pairedDeltaConfidenceInterval rejects mismatched sample sizes", () => {
  assert.throws(
    () => pairedDeltaConfidenceInterval([1, 2], [1]),
    /equal-length arrays/,
  );
});

test("cohensD and interpretEffectSize classify large separations", () => {
  const d = cohensD([0.9, 0.95, 1.0], [0.1, 0.15, 0.2]);
  assert.ok(d > 0.8);
  assert.equal(interpretEffectSize(d), "large");
});

test("cohensD handles singleton samples without producing NaN", () => {
  const equalSingletons = cohensD([0.5], [0.5]);
  const shiftedSingletons = cohensD([0.9], [0.1]);

  assert.equal(equalSingletons, 0);
  assert.equal(shiftedSingletons, Infinity);
  assert.equal(interpretEffectSize(shiftedSingletons), "large");
});

test("compareResults reports improvements with effect sizes and paired delta intervals", () => {
  const baseline = buildBenchmarkResult("longmemeval", [0.2, 0.3, 0.4]);
  const candidate = buildBenchmarkResult("longmemeval", [0.6, 0.7, 0.8]);

  const comparison = compareResults(baseline, candidate, 0.05);

  assert.equal(comparison.benchmark, "longmemeval");
  assert.equal(comparison.verdict, "improvement");
  assert.ok(comparison.metricDeltas.f1);
  assert.ok(comparison.metricDeltas.f1!.delta > 0);
  assert.equal(comparison.metricDeltas.f1!.effectSize.interpretation, "large");
  assert.ok(comparison.metricDeltas.f1!.ciOnDelta);
});
