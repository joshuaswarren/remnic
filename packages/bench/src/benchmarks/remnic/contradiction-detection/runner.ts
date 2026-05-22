/**
 * Contradiction-detection benchmark (issue #647).
 *
 * Pure-synthetic bench — no LLM calls.  Uses a deterministic heuristic
 * classifier to simulate the contradiction judge on the fixture pairs
 * and measures per-verdict precision, recall, and F1 against the
 * ground-truth labels.
 *
 * The heuristic is deliberately simple (token-overlap + keyword
 * signals) so that the bench measures structural correctness of
 * the pipeline wiring, not LLM quality.  It emits all four verdicts
 * (contradicts, duplicates, independent, needs-user).  A real
 * LLM-based variant can be added later as a separate bench mode.
 */

import { randomUUID } from "node:crypto";
import type {
  BenchmarkDefinition,
  BenchmarkResult,
  ResolvedRunBenchmarkOptions,
  TaskResult,
} from "../../../types.js";
import { aggregateTaskScores } from "../../../scorer.js";
import { getGitSha, getRemnicVersion } from "../../../reporter.js";
import {
  CONTRADICTION_DETECTION_FIXTURE,
  CONTRADICTION_DETECTION_SMOKE_FIXTURE,
  type ContradictionBenchCase,
  type ContradictionFixtureVerdict,
} from "./fixture.js";

// ── Definition ────────────────────────────────────────────────────────────────

export const contradictionDetectionDefinition: BenchmarkDefinition = {
  id: "contradiction-detection",
  title: "Contradiction Detection",
  tier: "remnic",
  status: "ready",
  runnerAvailable: true,
  meta: {
    name: "contradiction-detection",
    version: "1.0.0",
    description:
      "Synthetic benchmark for contradiction-judge precision/recall across " +
      "four verdict classes (contradicts, duplicates, independent, needs-user). " +
      "Uses a deterministic heuristic classifier — no LLM calls.",
    category: "retrieval",
    citation: "Remnic internal synthetic benchmark for issue #647.",
  },
};

// ── Verdict constants ─────────────────────────────────────────────────────────

const ALL_VERDICTS: ContradictionFixtureVerdict[] = [
  "contradicts",
  "duplicates",
  "independent",
  "needs-user",
];

// ── Deterministic heuristic judge ─────────────────────────────────────────────
//
// A simple text-based classifier that uses token overlap and keyword
// signals.  This is NOT a replacement for the real LLM judge — it
// exists so the bench can run without an LLM and measure structural
// correctness of the pipeline.

const CONTRA_SIGNALS = [
  " not ",
  " switched ",
  " deprecated ",
  " instead of ",
  " replaced ",
  " no longer ",
  " disabled by default",
  " enabled by default",
  " lost on restart",
  " persisted to disk",
  " survives restarts",
  " in memory and",
  " now the default",
  " only used as a fallback",
];

function heuristicVerdict(
  textA: string,
  textB: string,
): ContradictionFixtureVerdict {
  const a = textA.toLowerCase();
  const b = textB.toLowerCase();
  const overlap = tokenOverlap(a, b);

  // Check for contradiction signals
  const aHasContra = CONTRA_SIGNALS.some((s) => a.includes(s));
  const bHasContra = CONTRA_SIGNALS.some((s) => b.includes(s));
  if (aHasContra || bHasContra) {
    // If the texts share even modest token overlap, the signal
    // likely indicates a genuine contradiction.
    if (overlap > 0.15) return "contradicts";
  }

  // Check for near-duplicate
  if (overlap > 0.55) return "duplicates";

  // Contradiction signal present but virtually no token overlap —
  // ambiguous, defer to human review.
  if ((aHasContra || bHasContra) && overlap <= 0.15) return "needs-user";

  // Some topic overlap but not duplicate and not contradictory
  if (overlap > 0.2) return "independent";

  // Very little overlap
  return "independent";
}

function tokenOverlap(a: string, b: string): number {
  // Dice coefficient on word unigrams — symmetric, and more generous
  // than Jaccard for near-paraphrases with asymmetric length.
  const setA = new Set(a.split(/\s+/).filter(Boolean));
  const setB = new Set(b.split(/\s+/).filter(Boolean));
  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;
  let shared = 0;
  for (const t of setA) {
    if (setB.has(t)) shared++;
  }
  const dice = (2 * shared) / (setA.size + setB.size);

  // Containment: fraction of the smaller set's tokens found in the larger.
  // Handles paraphrases where one sentence is a subset restatement.
  const smaller = setA.size <= setB.size ? setA : setB;
  const larger = setA.size <= setB.size ? setB : setA;
  let contained = 0;
  for (const t of smaller) {
    if (larger.has(t)) contained++;
  }
  const containment = contained / smaller.size;

  // Weighted blend: containment alone would over-score contradictions
  // that happen to share all short-text tokens, so mix with Dice.
  return 0.5 * dice + 0.5 * containment;
}

// ── Per-verdict metrics ───────────────────────────────────────────────────────

interface VerdictMetrics {
  tp: number;
  fp: number;
  fn: number;
  precision: number;
  recall: number;
  f1: number;
}

function computeVerdictMetrics(
  cases: ContradictionBenchCase[],
  predicted: ContradictionFixtureVerdict[],
  verdict: ContradictionFixtureVerdict,
): VerdictMetrics {
  let tp = 0;
  let fp = 0;
  let fn = 0;

  for (let i = 0; i < cases.length; i++) {
    const expected = cases[i].expectedVerdict;
    const pred = predicted[i];
    if (expected === verdict && pred === verdict) tp++;
    else if (expected !== verdict && pred === verdict) fp++;
    else if (expected === verdict && pred !== verdict) fn++;
  }

  const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;

  return { tp, fp, fn, precision, recall, f1 };
}

// ── Runner ────────────────────────────────────────────────────────────────────

export async function runContradictionDetectionBenchmark(
  options: ResolvedRunBenchmarkOptions,
): Promise<BenchmarkResult> {
  const cases = loadCases(options.mode, options.limit);
  const tasks: TaskResult[] = [];

  // Per-case task results — time each heuristic call individually
  const predicted: ContradictionFixtureVerdict[] = [];

  for (let i = 0; i < cases.length; i++) {
    const sample = cases[i];
    const startedAt = performance.now();
    const pred = heuristicVerdict(sample.textA, sample.textB);
    const latencyMs = Math.round((performance.now() - startedAt) * 1000) / 1000;
    predicted.push(pred);

    const correct = pred === sample.expectedVerdict ? 1 : 0;

    tasks.push({
      taskId: sample.id,
      question: sample.title,
      expected: sample.expectedVerdict,
      actual: pred,
      scores: { accuracy: correct },
      latencyMs,
      tokens: { input: 0, output: 0 },
      details: {
        textA: sample.textA.slice(0, 120),
        textB: sample.textB.slice(0, 120),
        categoryA: sample.categoryA,
        categoryB: sample.categoryB,
      },
    });
    options.onTaskComplete?.(tasks[tasks.length - 1]!, tasks.length, cases.length);
  }

  // Per-verdict metrics
  const verdictScores: Record<string, number> = {};
  for (const v of ALL_VERDICTS) {
    const m = computeVerdictMetrics(cases, predicted, v);
    verdictScores[`precision_${v}`] = m.precision;
    verdictScores[`recall_${v}`] = m.recall;
    verdictScores[`f1_${v}`] = m.f1;
  }

  // Overall accuracy
  const correctCount = tasks.filter((t) => t.scores.accuracy === 1).length;
  verdictScores.overall_accuracy = cases.length > 0 ? correctCount / cases.length : 0;

  // Compute latency metrics BEFORE adding the synthetic aggregate task
  // so meanQueryLatencyMs denominator reflects real cases only.
  const remnicVersion = await getRemnicVersion();
  const totalLatencyMs = tasks.reduce((sum, task) => sum + task.latencyMs, 0);
  const meanQueryLatencyMs = tasks.length > 0 ? totalLatencyMs / tasks.length : 0;

  // Add a synthetic aggregate task so verdict-level scores appear in aggregates.
  // Excluded from latency computation above.
  tasks.push({
    taskId: "_aggregate_verdict_metrics",
    question: "Per-verdict precision/recall/F1",
    expected: "see scores",
    actual: "see scores",
    scores: verdictScores,
    latencyMs: 0,
    tokens: { input: 0, output: 0 },
  });

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
      meanQueryLatencyMs,
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

// ── Case loader ───────────────────────────────────────────────────────────────

function loadCases(
  mode: "quick" | "full",
  limit?: number,
): ContradictionBenchCase[] {
  const baseCases =
    mode === "quick"
      ? CONTRADICTION_DETECTION_SMOKE_FIXTURE
      : CONTRADICTION_DETECTION_FIXTURE;

  if (limit === undefined) return baseCases;
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error("contradiction-detection limit must be a positive integer");
  }
  const limited = baseCases.slice(0, limit);
  if (limited.length === 0) {
    throw new Error(
      "contradiction-detection fixture is empty after applying the requested limit.",
    );
  }
  return limited;
}
