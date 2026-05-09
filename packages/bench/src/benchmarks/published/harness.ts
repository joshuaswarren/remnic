/**
 * PublishedBenchmarkHarness — shared per-item execution harness for the
 * `longmemeval` and `locomo` runners (issue #566 slice 2).
 *
 * The LongMemEval and LoCoMo runners previously duplicated the entire
 * reset → ingest haystack → recall → answer → judge → score lifecycle.
 * This module extracts that lifecycle so both runners consume exactly
 * one implementation. Dataset-specific concerns (how to iterate items,
 * how many QA entries per item, per-task details payload) are expressed
 * as a `HarnessPlan` that the harness uniformly executes.
 *
 * Determinism contract (documented in issue #566 PR 2/7):
 *
 *   Given identical `(seed, datasetDir, system, modelId)` inputs, every
 *   output field except wall-clock timestamps MUST be identical. The
 *   harness records the seed in the `BenchmarkResult.meta.seeds` array
 *   and forwards it verbatim so downstream consumers can reproduce runs
 *   from the published artifact.
 *
 * CLAUDE.md rule 51 (reject invalid user input): `--model` / `--dataset`
 * / `--limit` validation lives upstream in the CLI surface (PR 4).
 * The harness itself validates its `HarnessContext` shape — invalid
 * seeds, missing systems, etc. throw at setup time with listed
 * permissible values rather than silently defaulting.
 */

import { randomUUID } from "node:crypto";

import type { Message } from "../../adapters/types.js";
import {
  answerBenchmarkQuestion,
  type BenchmarkAnswerResult,
  type BenchmarkAnswerFormat,
} from "../../answering.js";
import { benchmarkRecallBudgetForSessionCount } from "../../recall-budget.js";
import { getGitSha, getRemnicVersion } from "../../reporter.js";
import {
  aggregateTaskScores,
  containsAnswer,
  f1Score,
  llmJudgeScoreDetailed,
  rougeL,
  timed,
} from "../../scorer.js";
import type {
  BenchmarkMode,
  BenchmarkResult,
  ResolvedRunBenchmarkOptions,
  TaskResult,
} from "../../types.js";

/**
 * A single haystack session that should be ingested into the system
 * under test before any queries run. The harness calls
 * `system.store(sessionId, messages)` once per non-empty session.
 */
export interface HarnessSession {
  sessionId: string;
  messages: Message[];
}

/**
 * A single scored question that the harness executes against the system
 * under test. `recallSessionIds` drives which `system.recall(sessionId,
 * query)` calls are made per question — the LongMemEval runner recalls
 * from every haystack session; the LoCoMo runner recalls from every
 * extracted `session_*` key.
 */
export interface HarnessTrial {
  /** Stable identifier used as `TaskResult.taskId`. */
  taskId: string;
  /** Question text sent to the responder. */
  question: string;
  /** Canonical expected answer used for scoring. */
  expected: string;
  /** Session IDs that should be consulted via `system.recall`. */
  recallSessionIds: string[];
  /** Optional answer-shaping protocol for benchmarks with official short/structured outputs. */
  answerFormat?: BenchmarkAnswerFormat;
  /**
   * Optional hook invoked AFTER `system.recall` and `answerBenchmarkQuestion`
   * but BEFORE the LLM judge. Returns per-trial additions (extra scores
   * + extra detail fields) that get merged into the final `TaskResult`.
   * Used by LongMemEval to compute `search_hits` via `system.search()`
   * in the same ingest-state the recall saw.
   */
  postAnswerHook?: (args: {
    question: string;
    recalledText: string;
    answeredText: string;
  }) => Promise<{
    extraScores?: Record<string, number>;
    extraDetails?: Record<string, unknown>;
  }>;
  /**
   * Optional benchmark-specific redaction for prompt-visible recall context.
   * This must not use gold answers to add evidence; it is only for removing
   * benchmark-private labels from already-recalled text before answering.
   */
  recallTextTransform?: (args: {
    question: string;
    recalledText: string;
  }) => string;
  /**
   * Optional deterministic fallback used when the configured responder transport
   * fails after recall succeeded. It may only derive an answer from recalledText.
   */
  answerFallback?: (args: {
    question: string;
    recalledText: string;
    error: unknown;
  }) => string | undefined;
  /**
   * Optional deterministic refinement used after the configured responder
   * returns. It may only derive an answer from recalledText and the question.
   */
  answerRefinement?: (args: {
    question: string;
    recalledText: string;
    answeredText: string;
  }) => string | undefined;
  /**
   * Optional extra per-task metrics computed by the caller up-front
   * (not a function of recall state). Merged into the final
   * `TaskResult.scores`.
   */
  extraScores?: Record<string, number>;
  /**
   * Optional extra per-task `details` fields. Merged on top of the
   * harness-provided base details object.
   */
  extraDetails?: Record<string, unknown>;
}

/**
 * A plan describes ONE item from the dataset: the haystack to ingest
 * and the trials to execute. `ingestSessions` is always ingested in the
 * order provided, before any trial runs.
 */
export interface HarnessPlan {
  /** Sessions to ingest into the system under test. */
  ingestSessions: HarnessSession[];
  /** Trials executed after all sessions are ingested. */
  trials: HarnessTrial[];
}

/**
 * Metrics the harness computes for every trial. Dataset-specific extra
 * metrics are merged on top via `HarnessTrial.extraScores`.
 */
export type HarnessMetricId =
  | "f1"
  | "contains_answer"
  | "rouge_l"
  | "llm_judge";

export interface HarnessMetricsSpec {
  /**
   * Metric IDs computed by the harness. Order is preserved in the
   * returned `TaskResult.scores` object. `llm_judge` is emitted only
   * when the judge returns a non-negative score.
   */
  metrics: readonly HarnessMetricId[];
}

export interface HarnessContext {
  /** Resolved runner options forwarded from the CLI. */
  options: ResolvedRunBenchmarkOptions;
  /** Metrics to compute per trial. */
  metricsSpec: HarnessMetricsSpec;
  /**
   * Iterator of dataset-item plans. The harness iterates once, so this
   * should be finite. Runners that apply `--limit` must slice upstream
   * of this iterator (`loadLongMemEvalS` / `loadLoCoMo10` honor limit).
   */
  plans: Iterable<HarnessPlan> | AsyncIterable<HarnessPlan>;
  /** Optional global task count for progress callbacks. */
  totalCount?: number;
}

/** Convenience: guard an arbitrary iterable shape into an async iterator. */
async function* toAsyncIterable<T>(
  iter: Iterable<T> | AsyncIterable<T>,
): AsyncIterable<T> {
  for await (const value of iter as AsyncIterable<T>) {
    yield value;
  }
}

/**
 * Execute every plan and return a fully-populated `BenchmarkResult`.
 * Callers are the LongMemEval and LoCoMo runners; each is responsible
 * for loading their dataset and translating items into `HarnessPlan`s.
 *
 * The harness guarantees:
 *
 *   - `system.reset()` is called exactly once per plan, before ingest.
 *   - `system.store(sessionId, messages)` is called once per non-empty
 *     session, in the order provided by `plan.ingestSessions`.
 *   - Within a plan, trials are executed sequentially. Across plans,
 *     plans are executed sequentially. No implicit concurrency is
 *     introduced; that keeps the harness deterministic.
 *   - Every trial recalls from ALL `recallSessionIds` before calling
 *     the responder.
 */
export async function runPublishedHarness(
  ctx: HarnessContext,
): Promise<BenchmarkResult> {
  validateContext(ctx);
  const tasks: TaskResult[] = [];

  for await (const plan of toAsyncIterable(ctx.plans)) {
    await ctx.options.system.reset();
    for (const session of plan.ingestSessions) {
      if (session.messages.length > 0) {
        await ctx.options.system.store(session.sessionId, session.messages);
      }
    }
    try {
      await ctx.options.system.drain?.();
    } catch (drainErr) {
      console.error(`  [WARN] harness drain failed for plan: ${drainErr instanceof Error ? drainErr.message : String(drainErr)}`);
    }
    const planIndex = tasks.length;
    for (const trial of plan.trials) {
      const trialId = trial.taskId ?? trial.question.slice(0, 60);
      try {
        tasks.push(await executeTrial(ctx, trial));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`  [WARN] harness trial plan-${planIndex}/${trialId} failed: ${message}`);
        tasks.push({
          taskId: trial.taskId,
          question: trial.question,
          expected: trial.expected,
          actual: `(error: ${message})`,
          scores: { f1: -1, contains_answer: -1, llm_judge: -1 },
          latencyMs: 0,
          tokens: { input: 0, output: 0 },
          details: { error: message },
        });
      }
      // Pass the GLOBAL total (ctx.totalCount), not a per-plan total —
      // `tasks.length` is cumulative across every plan in ctx.plans, so a
      // per-plan divisor would overflow to "N/3" nonsense in plan 2+.
      ctx.options.onTaskComplete?.(tasks[tasks.length - 1]!, tasks.length, ctx.totalCount);
    }
  }

  return buildBenchmarkResult(ctx, tasks);
}

function validateContext(ctx: HarnessContext): void {
  if (!ctx.options || !ctx.options.system) {
    throw new Error(
      "PublishedBenchmarkHarness requires a resolved options.system. " +
        "Valid shapes are created by the `benchmark-runner` CLI and the " +
        "bench test doubles in packages/bench/src/adapters/.",
    );
  }
  if (!ctx.metricsSpec || !Array.isArray(ctx.metricsSpec.metrics)) {
    throw new Error(
      "PublishedBenchmarkHarness requires metricsSpec.metrics: one of " +
        'f1, contains_answer, rouge_l, llm_judge.',
    );
  }
  const allowed: readonly HarnessMetricId[] = [
    "f1",
    "contains_answer",
    "rouge_l",
    "llm_judge",
  ];
  for (const metric of ctx.metricsSpec.metrics) {
    if (!allowed.includes(metric)) {
      throw new Error(
        `PublishedBenchmarkHarness: unknown metric "${String(metric)}". ` +
          `Valid metrics: ${allowed.join(", ")}.`,
      );
    }
  }
  if (ctx.options.seed !== undefined) {
    if (!Number.isInteger(ctx.options.seed) || ctx.options.seed < 0) {
      throw new Error(
        `PublishedBenchmarkHarness: seed must be a non-negative integer; got ${String(ctx.options.seed)}.`,
      );
    }
  }
}

async function executeTrial(
  ctx: HarnessContext,
  trial: HarnessTrial,
): Promise<TaskResult> {
  const { result: recalledText, durationMs } = await timed(async () => {
    const recallBudget = benchmarkRecallBudgetForSessionCount(
      trial.recallSessionIds.length,
    );
    const recalledSessions = await Promise.all(
      trial.recallSessionIds.map((sessionId) =>
        ctx.options.system.recall(sessionId, trial.question, recallBudget),
      ),
    );
    const rawRecalledText = recalledSessions.filter(Boolean).join("\n\n");
    return trial.recallTextTransform
      ? trial.recallTextTransform({
          question: trial.question,
          recalledText: rawRecalledText,
        })
      : rawRecalledText;
  });
  let answered: HarnessAnswerResult =
    await answerBenchmarkQuestion({
      question: trial.question,
      recalledText,
      responder: ctx.options.system.responder,
      answerMode: "strict",
      answerFormat: trial.answerFormat,
    }).catch((error: unknown) =>
      answerWithTrialFallback(trial, recalledText, error),
    );
  answered = refineTrialAnswer(trial, recalledText, answered);

  // Post-answer hook runs before the judge so dataset-specific signals
  // (e.g. LongMemEval `search_hits`) are observed from the same
  // post-ingest, post-recall system state as the recall/answer calls.
  const hookResult = trial.postAnswerHook
    ? await trial.postAnswerHook({
        question: trial.question,
        recalledText,
        answeredText: answered.finalAnswer,
      })
    : { extraScores: undefined, extraDetails: undefined };

  // Only invoke the LLM judge when `llm_judge` is in the metrics spec.
  // Cursor review feedback on PR 596: unconditionally calling the judge
  // billed non-judge runs for an API call per trial and inflated the
  // `TaskResult` latency/token totals. The zero-valued placeholder
  // below keeps the downstream arithmetic unchanged for runs that
  // don't opt into the judge.
  const judgeRequested = ctx.metricsSpec.metrics.includes("llm_judge");
  const judgeResult = judgeRequested
    ? await llmJudgeScoreDetailed(
        ctx.options.system.judge,
        trial.question,
        answered.finalAnswer,
        trial.expected,
      )
    : {
        score: -1,
        tokens: { input: 0, output: 0 },
        latencyMs: 0,
        model: undefined as string | undefined,
      };

  const scores: Record<string, number> = {};
  for (const metric of ctx.metricsSpec.metrics) {
    switch (metric) {
      case "f1":
        scores.f1 = f1Score(answered.finalAnswer, trial.expected);
        break;
      case "contains_answer":
        scores.contains_answer = containsAnswer(
          answered.finalAnswer,
          trial.expected,
        );
        break;
      case "rouge_l":
        scores.rouge_l = rougeL(answered.finalAnswer, trial.expected);
        break;
      case "llm_judge":
        if (judgeResult.score >= 0) {
          scores.llm_judge = judgeResult.score;
        }
        break;
      default: {
        // Unreachable — validated in validateContext. Keep as a sanity
        // guard; CLAUDE.md rule 53 (enumerate all non-active states).
        const exhaustive: never = metric;
        throw new Error(
          `PublishedBenchmarkHarness: metric ${String(exhaustive)} not handled.`,
        );
      }
    }
  }
  if (trial.extraScores) {
    for (const [name, value] of Object.entries(trial.extraScores)) {
      scores[name] = value;
    }
  }
  if (hookResult.extraScores) {
    for (const [name, value] of Object.entries(hookResult.extraScores)) {
      scores[name] = value;
    }
  }

  const baseDetails: Record<string, unknown> = {
    recalledLength: recalledText.length,
    answeredLength: answered.finalAnswer.length,
    recalledText,
    answeredText: answered.finalAnswer,
    ...(trial.answerFormat ? { answerFormat: trial.answerFormat } : {}),
    responderModel: answered.model,
    judgeModel: judgeResult.model,
    ...(answered.fallbackReason
      ? { answerFallbackReason: answered.fallbackReason }
      : {}),
    ...(answered.refinementReason
      ? {
          answerRefinementReason: answered.refinementReason,
          originalAnsweredText: answered.originalAnswer,
        }
      : {}),
  };
  const details: Record<string, unknown> = { ...baseDetails };
  if (trial.extraDetails) {
    Object.assign(details, trial.extraDetails);
  }
  if (hookResult.extraDetails) {
    Object.assign(details, hookResult.extraDetails);
  }

  return {
    taskId: trial.taskId,
    question: trial.question,
    expected: trial.expected,
    actual: answered.finalAnswer,
    scores,
    latencyMs: durationMs + answered.latencyMs + judgeResult.latencyMs,
    tokens: {
      input: answered.tokens.input + judgeResult.tokens.input,
      output: answered.tokens.output + judgeResult.tokens.output,
    },
    details,
  };
}

type HarnessAnswerResult = BenchmarkAnswerResult & {
  fallbackReason?: string;
  refinementReason?: string;
  originalAnswer?: string;
};

function answerWithTrialFallback(
  trial: HarnessTrial,
  recalledText: string,
  error: unknown,
): HarnessAnswerResult {
  const fallback = trial.answerFallback?.({
    question: trial.question,
    recalledText,
    error,
  });
  if (fallback === undefined) {
    throw error;
  }
  return {
    finalAnswer: fallback,
    recalledText,
    answeredText: fallback,
    latencyMs: 0,
    tokens: { input: 0, output: 0 },
    model: "deterministic-fallback",
    fallbackReason: error instanceof Error ? error.message : String(error),
  };
}

function refineTrialAnswer(
  trial: HarnessTrial,
  recalledText: string,
  answered: HarnessAnswerResult,
): HarnessAnswerResult {
  const refined = trial.answerRefinement?.({
    question: trial.question,
    recalledText,
    answeredText: answered.finalAnswer,
  });
  const trimmed = refined?.trim();
  if (!trimmed || trimmed === answered.finalAnswer.trim()) {
    return answered;
  }

  return {
    ...answered,
    finalAnswer: trimmed,
    answeredText: trimmed,
    originalAnswer: answered.finalAnswer,
    refinementReason: "benchmark recalled-evidence refinement",
  };
}

async function buildBenchmarkResult(
  ctx: HarnessContext,
  tasks: TaskResult[],
): Promise<BenchmarkResult> {
  const remnicVersion = await getRemnicVersion();
  const totalLatencyMs = tasks.reduce((sum, task) => sum + task.latencyMs, 0);
  const totalInputTokens = tasks.reduce(
    (sum, task) => sum + task.tokens.input,
    0,
  );
  const totalOutputTokens = tasks.reduce(
    (sum, task) => sum + task.tokens.output,
    0,
  );
  const mode: BenchmarkMode = ctx.options.mode;

  return {
    meta: {
      id: randomUUID(),
      benchmark: ctx.options.benchmark.id,
      benchmarkTier: ctx.options.benchmark.tier,
      version: ctx.options.benchmark.meta.version,
      remnicVersion,
      gitSha: getGitSha(),
      timestamp: new Date().toISOString(),
      mode,
      runCount: 1,
      seeds: [ctx.options.seed ?? 0],
    },
    config: {
      systemProvider: ctx.options.systemProvider ?? null,
      judgeProvider: ctx.options.judgeProvider ?? null,
      adapterMode: ctx.options.adapterMode ?? "direct",
      remnicConfig: ctx.options.remnicConfig ?? {},
      ...(ctx.options.benchmarkOptions
        ? { benchmarkOptions: ctx.options.benchmarkOptions }
        : {}),
    },
    cost: {
      totalTokens: totalInputTokens + totalOutputTokens,
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      estimatedCostUsd: 0,
      totalLatencyMs,
      meanQueryLatencyMs:
        tasks.length > 0 ? totalLatencyMs / tasks.length : 0,
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
