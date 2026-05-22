/**
 * Direct-answer latency benchmark (issue #518).
 *
 * Exercises the eligibility gate on a hand-crafted synthetic fixture
 * and reports precision (positive cases fire Tier 2), deferral recall
 * (negative cases defer to the hybrid path), and per-case latency.
 * Does not require an orchestrator or a search backend — candidates
 * are synthesized in-memory, so the bench stays deterministic and
 * fast.
 */

import { randomUUID } from "node:crypto";
import { isDirectAnswerEligible, type DirectAnswerCandidate } from "@remnic/core";
import type {
  BenchmarkDefinition,
  BenchmarkResult,
  ResolvedRunBenchmarkOptions,
  TaskResult,
} from "../../../types.js";
import { aggregateTaskScores } from "../../../scorer.js";
import { getGitSha, getRemnicVersion } from "../../../reporter.js";
import {
  DIRECT_ANSWER_BENCH_FIXTURE,
  memoryFileFromCase,
  type DirectAnswerBenchCase,
} from "./fixture.js";

export const retrievalDirectAnswerDefinition: BenchmarkDefinition = {
  id: "retrieval-direct-answer",
  title: "Retrieval: Direct-Answer Gate",
  tier: "remnic",
  status: "ready",
  runnerAvailable: true,
  meta: {
    name: "retrieval-direct-answer",
    version: "1.0.0",
    description:
      "Measures the direct-answer tier eligibility gate: precision on positive cases, deferral recall on negative cases, and per-case decision latency (issue #518).",
    category: "retrieval",
    citation: "Remnic internal synthetic benchmark for issue #518",
  },
};

const DEFAULT_CONFIG = {
  enabled: true,
  tokenOverlapFloor: 0.5,
  importanceFloor: 0.7,
  ambiguityMargin: 0.15,
  eligibleTaxonomyBuckets: [
    "decisions",
    "principles",
    "conventions",
    "runbooks",
    "entities",
  ],
};

function buildCandidates(benchCase: DirectAnswerBenchCase): DirectAnswerCandidate[] {
  return benchCase.candidates.map((c) => ({
    memory: memoryFileFromCase(c),
    trustZone: c.trustZone,
    taxonomyBucket: c.taxonomyBucket ?? null,
    importanceScore: c.importanceScore,
  }));
}

function scoreCase(benchCase: DirectAnswerBenchCase): { scores: Record<string, number>; actualVerdict: string; winnerId: string | null; latencyMs: number } {
  const candidates = buildCandidates(benchCase);
  const start = performance.now();
  const result = isDirectAnswerEligible({
    query: benchCase.query,
    candidates,
    config: DEFAULT_CONFIG,
    queryEntityRefs: benchCase.queryEntityRefs,
  });
  const latencyMs = performance.now() - start;
  const actualVerdict = result.eligible ? "eligible" : "defer";
  const winnerId = result.winner?.memory.frontmatter.id ?? null;

  const verdictCorrect = actualVerdict === benchCase.expected ? 1 : 0;
  const scores: Record<string, number> = {
    verdict_correct: verdictCorrect,
    latency_under_5ms: latencyMs < 5 ? 1 : 0,
  };
  if (benchCase.expected === "eligible") {
    // Positive split metrics: expected-eligible cases should fire Tier 2.
    scores.eligible_case_correct = actualVerdict === "eligible" ? 1 : 0;
    scores.direct_answer_precision = scores.eligible_case_correct;
    // Only record winner_correct on cases that expect an eligible verdict.
    // Hard-coding 1 for defer cases would inflate the aggregate mean and mask
    // real winner-selection regressions on eligible cases. Omitting the metric
    // causes aggregateTaskScores to average only over eligible cases (see
    // collectMetricValues, which filters non-numeric entries).
    scores.winner_correct =
      winnerId === (benchCase.expectedWinnerId ?? null) ? 1 : 0;
  } else {
    // Negative split metrics: expected-defer cases should stay on the hybrid path.
    scores.defer_case_correct = actualVerdict === "defer" ? 1 : 0;
    scores.deferral_recall = scores.defer_case_correct;
  }

  return {
    scores,
    actualVerdict,
    winnerId,
    latencyMs,
  };
}

function selectCases(
  mode: "quick" | "full",
  limit?: number,
): DirectAnswerBenchCase[] {
  // Quick mode defaults to the first case; explicit --limit always wins.
  const effectiveLimit =
    limit !== undefined ? limit : mode === "quick" ? 1 : undefined;
  if (effectiveLimit === undefined) {
    return DIRECT_ANSWER_BENCH_FIXTURE;
  }
  if (!Number.isInteger(effectiveLimit) || effectiveLimit <= 0) {
    throw new Error(
      "retrieval-direct-answer limit must be a positive integer",
    );
  }
  const limited = DIRECT_ANSWER_BENCH_FIXTURE.slice(0, effectiveLimit);
  if (limited.length === 0) {
    throw new Error(
      "retrieval-direct-answer fixture is empty after applying the requested limit.",
    );
  }
  return limited;
}

export async function runRetrievalDirectAnswerBenchmark(
  options: ResolvedRunBenchmarkOptions,
): Promise<BenchmarkResult> {
  const tasks: TaskResult[] = [];
  const latencies: number[] = [];
  const cases = selectCases(options.mode, options.limit);

  for (const benchCase of cases) {
    const { scores, actualVerdict, winnerId, latencyMs } = scoreCase(benchCase);
    latencies.push(latencyMs);
    tasks.push({
      taskId: benchCase.id,
      question: benchCase.query,
      expected:
        benchCase.expected === "eligible"
          ? `eligible:${benchCase.expectedWinnerId ?? ""}`
          : "defer",
      actual: actualVerdict === "eligible" ? `eligible:${winnerId ?? ""}` : "defer",
      scores,
      latencyMs: Math.round(latencyMs * 100) / 100,
      tokens: { input: 0, output: 0 },
      details: {
        caseId: benchCase.id,
        candidateCount: benchCase.candidates.length,
      },
    });
  }

  latencies.sort((a, b) => a - b);
  const p50Raw = latencies[Math.floor(latencies.length * 0.5)] ?? 0;
  const p95Raw =
    latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))] ?? 0;
  const p50 = Math.round(p50Raw * 100) / 100;
  const p95 = Math.round(p95Raw * 100) / 100;

  const aggregated = aggregateTaskScores(tasks.map((task) => task.scores));
  const remnicVersion = await getRemnicVersion();
  const totalLatencyMs = tasks.reduce((sum, task) => sum + task.latencyMs, 0);

  return {
    meta: {
      id: randomUUID(),
      benchmark: options.benchmark.id,
      benchmarkTier: options.benchmark.tier,
      version: options.benchmark.meta.version,
      remnicVersion,
      gitSha: getGitSha(),
      timestamp: new Date().toISOString(),
      mode: options.mode,
      runCount: 1,
      seeds: [options.seed ?? 0],
    },
    config: {
      systemProvider: options.systemProvider ?? null,
      judgeProvider: options.judgeProvider ?? null,
      adapterMode: options.adapterMode ?? "direct",
      remnicConfig: options.remnicConfig ?? {},
    },
    cost: {
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      estimatedCostUsd: 0,
      totalLatencyMs,
      meanQueryLatencyMs: tasks.length > 0 ? totalLatencyMs / tasks.length : 0,
    },
    results: {
      tasks,
      aggregates: {
        ...aggregated,
        latency_p50_ms: { mean: p50, median: p50, stdDev: 0, min: p50, max: p50 },
        latency_p95_ms: { mean: p95, median: p95, stdDev: 0, min: p95, max: p95 },
      },
    },
    environment: {
      os: process.platform,
      nodeVersion: process.version,
      hardware: process.arch,
    },
  };
}
