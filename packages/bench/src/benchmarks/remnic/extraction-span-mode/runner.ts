/**
 * Deterministic Phase A gate benchmark for span-mode extraction (issue #2333).
 *
 * Runs ONE fake provider under two extraction variants (current = generated
 * restatement; span = offsets + frame) over the LoCoMo-style and
 * LongMemEval-style synthetic slices — same model, same seed — materializes
 * span facts with per-fact fail-open, and measures:
 *
 *   judge score (0-100, coverage proxy), extraction wall-clock per
 *   conversation (modeled decode-bound), output tokens per conversation,
 *   span-validation fallback rate, and memory entry count.
 *
 * The Phase B gate (≥ 20% wall-clock reduction, judge drop < 2 points,
 * fallback rate < 15%) is then evaluated with @remnic/core's
 * `evaluateSpanPhaseGate` and REPORTED — this runner never asserts the gate;
 * a measured no-go is a valid Phase A outcome.
 *
 * No network, no real model, no secrets: the provider is the deterministic
 * fake in ./fake-provider.ts. Scope is @remnic/bench only; nothing here leaks
 * into base-install surfaces.
 */

import { randomUUID } from "node:crypto";
import { evaluateSpanPhaseGate, type SpanGateVerdict } from "@remnic/core/extraction-span-gate";
import { tallySpanFallbacks, type SpanOutcome } from "@remnic/core/extraction-span-fallback";
import type { BenchmarkDefinition, BenchmarkResult, ResolvedRunBenchmarkOptions, TaskResult } from "../../../types.js";
import { aggregateTaskScores } from "../../../scorer.js";
import { getGitSha, getRemnicVersion } from "../../../reporter.js";
import { SPAN_BENCH_FIXTURE, SPAN_BENCH_SMOKE_FIXTURE, type SpanBenchConversation } from "./fixture.js";
import { renderSegment, type RenderedSegment } from "./segment.js";
import { materializeSpanFact } from "./materialize.js";
import { SpanModeFactSchema, CurrentModeFactSchema } from "./schema.js";
import { runFakeExtraction, type ExtractionMode, MS_PER_OUTPUT_TOKEN, INVALID_SPAN_RATE, DRIFT_SPAN_RATE } from "./fake-provider.js";
import { judgeMemoryScore } from "./judge.js";

export const extractionSpanModeDefinition: BenchmarkDefinition = {
  id: "extraction-span-mode",
  title: "Extraction Span-Mode Phase A Gate",
  tier: "remnic",
  status: "ready",
  runnerAvailable: true,
  meta: {
    name: "extraction-span-mode",
    version: "1.0.0",
    description:
      "Deterministic fake-provider A/B of span-mode vs generated extraction with the issue #2333 Phase B gate (wall-clock, judge score, fallback rate).",
    category: "retrieval",
    citation: "arXiv 2602.03315 §5.2.4 Table 6; Remnic issue #2333",
  },
};

interface ModeAccumulator {
  conversationIds: string[];
  judgeScores: number[];
  wallClockMs: number[];
  outputTokens: number[];
  memoryEntries: number[];
}

function newAccumulator(): ModeAccumulator {
  return { conversationIds: [], judgeScores: [], wallClockMs: [], outputTokens: [], memoryEntries: [] };
}

function mean(values: number[]): number {
  if (values.length === 0) {
    throw new Error("cannot average an empty sample");
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export async function runExtractionSpanModeBenchmark(
  options: ResolvedRunBenchmarkOptions,
): Promise<BenchmarkResult> {
  const seed = options.seed ?? 0;
  const conversations = loadConversations(options.mode, options.limit);
  const segmentByConversation = new Map<string, RenderedSegment>(
    conversations.map((conversation) => [conversation.id, renderSegment(conversation)]),
  );

  const tasks: TaskResult[] = [];
  const outcomes: SpanOutcome[] = [];
  const acc: Record<ExtractionMode, ModeAccumulator> = { current: newAccumulator(), span: newAccumulator() };
  const modes: ExtractionMode[] = ["current", "span"];

  for (const conversation of conversations) {
    const segment = segmentByConversation.get(conversation.id);
    if (!segment) {
      throw new Error(`missing rendered segment for conversation ${conversation.id}`);
    }
    for (const mode of modes) {
      const run = runFakeExtraction(conversation, mode, seed);
      const factScores: number[] = [];
      const modeDetails: Record<string, unknown> = {
        dataset: conversation.dataset,
        mode,
        seed,
      };

      if (mode === "current") {
        for (const [index, raw] of run.rawFacts.entries()) {
          const fact = CurrentModeFactSchema.parse(raw);
          const gold = conversation.facts[index];
          factScores.push(judgeMemoryScore(fact.content, gold.content));
        }
      } else {
        const perFact: Record<string, unknown>[] = [];
        for (const [index, raw] of run.rawFacts.entries()) {
          const fact = SpanModeFactSchema.parse(raw);
          const gold = conversation.facts[index];
          const materialized = materializeSpanFact(fact, segment.messages);
          outcomes.push(materialized.outcome);
          factScores.push(judgeMemoryScore(materialized.content, gold.content));
          perFact.push({
            factId: gold.id,
            outcome: materialized.outcome,
            reason: materialized.reason ?? null,
          });
        }
        modeDetails.facts = perFact;
      }

      const judgeScore = mean(factScores);
      acc[mode].conversationIds.push(conversation.id);
      acc[mode].judgeScores.push(judgeScore);
      acc[mode].wallClockMs.push(run.wallClockMs);
      acc[mode].outputTokens.push(run.outputTokens);
      acc[mode].memoryEntries.push(run.memoryEntryCount);

      tasks.push({
        taskId: `${conversation.id}:${mode}`,
        question: `Extract memories from ${conversation.id} (${conversation.dataset}, ${mode} mode)`,
        expected: "gold-fact coverage",
        actual: `${mode} extraction via deterministic fake provider`,
        scores: {
          [`judge_score_${mode}`]: judgeScore,
          [`output_tokens_${mode}`]: run.outputTokens,
          [`wall_clock_ms_${mode}`]: run.wallClockMs,
          [`memory_entries_${mode}`]: run.memoryEntryCount,
        },
        latencyMs: run.wallClockMs,
        tokens: { input: 0, output: run.outputTokens },
        details: modeDetails,
      });
    }
  }

  const fallbackTally = tallySpanFallbacks(outcomes);
  if (fallbackTally.fallbackRatePct === null) {
    throw new Error("span mode produced no span attempts; the gate cannot be evaluated on an unmeasured run");
  }
  const wallClockReductionPct =
    ((mean(acc.current.wallClockMs) - mean(acc.span.wallClockMs)) / mean(acc.current.wallClockMs)) * 100;
  const judgeScoreDropPoints = mean(acc.current.judgeScores) - mean(acc.span.judgeScores);
  const verdict: SpanGateVerdict = evaluateSpanPhaseGate({
    wallClockReductionPct,
    judgeScoreDropPoints,
    fallbackRatePct: fallbackTally.fallbackRatePct,
  });

  const comparison = {
    model: "deterministic-fake-provider (synthetic; no real model runs)",
    seed,
    conversations: conversations.length,
    perConversation: {
      judgeScoreCurrent: mean(acc.current.judgeScores),
      judgeScoreSpan: mean(acc.span.judgeScores),
      wallClockMsCurrent: mean(acc.current.wallClockMs),
      wallClockMsSpan: mean(acc.span.wallClockMs),
      outputTokensCurrent: mean(acc.current.outputTokens),
      outputTokensSpan: mean(acc.span.outputTokens),
      memoryEntriesCurrent: mean(acc.current.memoryEntries),
      memoryEntriesSpan: mean(acc.span.memoryEntries),
    },
    wallClockReductionPct,
    outputTokenReductionPct:
      ((mean(acc.current.outputTokens) - mean(acc.span.outputTokens)) / mean(acc.current.outputTokens)) * 100,
    judgeScoreDropPoints,
    spanAttempts: fallbackTally.attempts,
    spanFallbacks: fallbackTally.fallbacks,
    fallbackRatePct: fallbackTally.fallbackRatePct,
    costModel: {
      msPerOutputToken: MS_PER_OUTPUT_TOKEN,
      decodeBound: true,
      invalidSpanRate: INVALID_SPAN_RATE,
      driftSpanRate: DRIFT_SPAN_RATE,
    },
    gate: {
      thresholds: {
        minWallClockReductionPct: 20,
        maxJudgeDropPoints: 2,
        maxFallbackRatePct: 15,
      },
      verdict,
    },
  };

  tasks.push({
    taskId: "span-phase-gate",
    question: "Does span-mode extraction clear the Phase B gate?",
    expected: "wall-clock -20%+, judge drop <2, fallback <15%",
    actual: verdict.pass ? "gate cleared" : `gate failed: ${verdict.failed.join(", ")}`,
    scores: {
      gate_pass: verdict.pass ? 1 : 0,
      wall_clock_reduction_pct: wallClockReductionPct,
      judge_score_drop_points: judgeScoreDropPoints,
      fallback_rate_pct: fallbackTally.fallbackRatePct,
    },
    latencyMs: 0,
    tokens: { input: 0, output: 0 },
    goldMemories: [],
    details: { comparison },
  });

  const totalOutputTokens =
    acc.current.outputTokens.reduce((a, b) => a + b, 0) + acc.span.outputTokens.reduce((a, b) => a + b, 0);
  const totalWallClockMs =
    acc.current.wallClockMs.reduce((a, b) => a + b, 0) + acc.span.wallClockMs.reduce((a, b) => a + b, 0);

  return {
    meta: {
      id: randomUUID(),
      benchmark: options.benchmark.id,
      benchmarkTier: options.benchmark.tier,
      version: options.benchmark.meta.version,
      remnicVersion: await getRemnicVersion(),
      gitSha: getGitSha(),
      timestamp: new Date().toISOString(),
      mode: options.mode,
      runCount: 1,
      seeds: [seed],
    },
    config: {
      systemProvider: options.systemProvider ?? null,
      judgeProvider: options.judgeProvider ?? null,
      adapterMode: options.adapterMode ?? "direct",
      remnicConfig: {
        spanBench: {
          provider: "deterministic-fake",
          datasets: ["locomo-synthetic", "longmemeval-synthetic"],
          seed,
        },
      },
    },
    cost: {
      totalTokens: totalOutputTokens,
      inputTokens: 0,
      outputTokens: totalOutputTokens,
      estimatedCostUsd: 0,
      totalLatencyMs: totalWallClockMs,
      meanQueryLatencyMs: tasks.length > 0 ? totalWallClockMs / tasks.length : 0,
    },
    results: {
      tasks,
      aggregates: aggregateTaskScores(tasks.map((task) => task.scores)),
    },
    environment: {
      os: process.platform,
      nodeVersion: process.version,
      hardware: process.arch,
    },
  };
}

function loadConversations(mode: "quick" | "full", limit: number | undefined): SpanBenchConversation[] {
  const base = mode === "quick" ? SPAN_BENCH_SMOKE_FIXTURE : SPAN_BENCH_FIXTURE;
  if (limit === undefined) {
    return base;
  }
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error("extraction-span-mode limit must be a positive integer");
  }
  const limited = base.slice(0, limit);
  if (limited.length === 0) {
    throw new Error("extraction-span-mode fixture is empty after applying the requested limit.");
  }
  return limited;
}
