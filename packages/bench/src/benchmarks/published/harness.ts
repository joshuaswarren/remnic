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

import { createHash, randomUUID } from "node:crypto";

import type {
  BenchAttributionRetrieval,
  BenchRecallSupportAssessment,
  BenchRecallSupportStatus,
  BenchResponder,
  Message,
} from "../../adapters/types.js";
import {
  answerBenchmarkQuestion,
  buildStrictBenchmarkQuestion,
  type BenchmarkAnswerResult,
  type BenchmarkAnswerFormat,
} from "../../answering.js";
import { findBenchmarkRunBlockedError, isBenchmarkRunBlockedError } from "../../benchmark-run-blocked-error.js";
import { benchmarkRecallBudgetForSessionCount } from "../../recall-budget.js";
import {
  captureBenchmarkExecutionProvenance,
  type BenchmarkExecutionProvenance,
  getRemnicVersion,
} from "../../reporter.js";
import {
  aggregateTaskScores,
  containsAnswer,
  f1Score,
  llmBinaryJudgeScoreDetailed,
  llmJudgeScoreDetailed,
  rougeL,
  timed,
} from "../../scorer.js";
import { computeCategoryAggregates } from "./category-aggregates.js";
import type {
  BenchmarkMode,
  BenchmarkResult,
  PairedAnswerReplayEntry,
  ResolvedRunBenchmarkOptions,
  TaskResult,
  TaskAttributionWitness,
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
  /** Optional plain-statement gold knowledge points for op-level failure attribution (issue #1954). */
  goldMemories?: string[];
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
   * Optional benchmark-owned yes/no judge prompt. When present, the harness
   * calls `BenchJudge.scoreBinaryPrompt()` instead of the generic scalar
   * judge rubric so published benchmark metrics can keep their official
   * evaluator wording.
   */
  binaryJudgePrompt?: (args: {
    question: string;
    expected: string;
    answeredText: string;
  }) => string;
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
export type HarnessMetricId = "f1" | "contains_answer" | "rouge_l" | "llm_judge" | "judge_accuracy";

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

interface PendingPairedAnswerReplay {
  key: string;
  entry: PairedAnswerReplayEntry;
}

/** Convenience: guard an arbitrary iterable shape into an async iterator. */
async function* toAsyncIterable<T>(iter: Iterable<T> | AsyncIterable<T>): AsyncIterable<T> {
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
 *   - Within a plan, trials are sequential by default. Runners may opt
 *     into bounded trial concurrency after ingestion/drain; task output
 *     and progress callbacks still follow dataset order.
 *     Across plans, execution remains sequential.
 *   - Every trial recalls from ALL `recallSessionIds` before calling
 *     the responder.
 */
export async function runPublishedHarness(ctx: HarnessContext): Promise<BenchmarkResult> {
  validateContext(ctx);
  const executionProvenance = captureBenchmarkExecutionProvenance();
  const answerSupportGate = resolveAnswerSupportGate(ctx.options);
  const trialConcurrency = resolveTrialConcurrency(ctx.options.benchmarkOptions?.trialConcurrency);
  const tasks: TaskResult[] = [];
  if ((ctx.options.resumeTasks || ctx.options.onTaskStart) && trialConcurrency !== 1) {
    throw new Error("PublishedBenchmarkHarness: resume hooks require trialConcurrency=1");
  }
  const pendingPairedAnswerReplays = new Map<TaskResult, PendingPairedAnswerReplay>();

  try {
    for await (const plan of toAsyncIterable(ctx.plans)) {
      const resumedPlanTasks = plan.trials.map((trial) => ctx.options.resumeTasks?.get(trial.taskId));
      if (resumedPlanTasks.length > 0 && resumedPlanTasks.every(Boolean)) {
        for (const task of resumedPlanTasks) {
          if (!task) continue;
          tasks.push(task);
          ctx.options.onTaskComplete?.(task, tasks.length, ctx.totalCount);
        }
        continue;
      }
      await ctx.options.system.reset();
      for (const session of plan.ingestSessions) {
        if (session.messages.length > 0) {
          await ctx.options.system.store(session.sessionId, session.messages);
        }
      }
      try {
        await ctx.options.system.drain?.();
      } catch (drainErr) {
        throw new Error(
          `PublishedBenchmarkHarness: drain failed before scoring; public benchmark evidence would be incomplete: ${
            drainErr instanceof Error ? drainErr.message : String(drainErr)
          }`,
          { cause: drainErr }
        );
      }
      const planIndex = tasks.length;
      await executePlanTrials(ctx, plan.trials, {
        planIndex,
        tasks,
        trialConcurrency,
        answerSupportGate,
        pendingPairedAnswerReplays,
      });
    }
  } catch (error) {
    if (ctx.options.runtimeProfile === "baseline") {
      ctx.options.pairedAnswerReplayCache?.clear();
    }
    throw error;
  }

  const result = await buildBenchmarkResult(ctx, tasks, executionProvenance);
  if (ctx.options.runtimeProfile === "baseline" && result.meta.status === "partial") {
    ctx.options.pairedAnswerReplayCache?.clear();
  }
  return result;
}

async function executePlanTrials(
  ctx: HarnessContext,
  trials: HarnessTrial[],
  options: {
    planIndex: number;
    tasks: TaskResult[];
    trialConcurrency: number;
    answerSupportGate: boolean;
    pendingPairedAnswerReplays: Map<TaskResult, PendingPairedAnswerReplay>;
  }
): Promise<void> {
  if (options.trialConcurrency === 1 || trials.length <= 1) {
    for (const trial of trials) {
      const resumed = ctx.options.resumeTasks?.get(trial.taskId);
      if (resumed) {
        options.tasks.push(resumed);
        ctx.options.onTaskComplete?.(resumed, options.tasks.length, ctx.totalCount);
        continue;
      }
      ctx.options.onTaskStart?.(trial.taskId);
      appendCompletedTask(
        ctx,
        options.tasks,
        options.pendingPairedAnswerReplays,
        await executeTrialWithFailure(
          ctx,
          trial,
          options.planIndex,
          options.answerSupportGate,
          options.pendingPairedAnswerReplays
        )
      );
    }
    return;
  }

  for (let batchStart = 0; batchStart < trials.length; batchStart += options.trialConcurrency) {
    const batch = trials.slice(batchStart, batchStart + options.trialConcurrency);
    const settled = await Promise.allSettled(
      batch.map((trial) =>
        executeTrialWithFailure(
          ctx,
          trial,
          options.planIndex,
          options.answerSupportGate,
          options.pendingPairedAnswerReplays
        )
      )
    );

    const unexpectedRejection = settled.find(
      (result): result is PromiseRejectedResult =>
        result.status === "rejected" && findBenchmarkRunBlockedError(result.reason) === undefined
    );
    if (unexpectedRejection) {
      throw unexpectedRejection.reason;
    }

    const terminalOffset = settled.findIndex(
      (result) => result.status === "rejected" && findBenchmarkRunBlockedError(result.reason) !== undefined
    );
    const emitLimit = terminalOffset < 0 ? settled.length : terminalOffset;
    for (let offset = 0; offset < emitLimit; offset += 1) {
      const result = settled[offset];
      if (result?.status !== "fulfilled") {
        throw new Error(
          `PublishedBenchmarkHarness: concurrent trial ${batchStart + offset} did not settle before canonical emission.`
        );
      }
      appendCompletedTask(ctx, options.tasks, options.pendingPairedAnswerReplays, result.value);
    }

    if (terminalOffset >= 0) {
      const terminalResult = settled[terminalOffset];
      const terminalError =
        terminalResult?.status === "rejected" ? findBenchmarkRunBlockedError(terminalResult.reason) : undefined;
      if (!terminalError) {
        throw new Error(
          `PublishedBenchmarkHarness: concurrent trial ${batchStart + terminalOffset} lost its terminal error before canonical emission.`
        );
      }
      throw terminalError;
    }
  }
}

function appendCompletedTask(
  ctx: HarnessContext,
  tasks: TaskResult[],
  pendingPairedAnswerReplays: Map<TaskResult, PendingPairedAnswerReplay>,
  task: TaskResult
): void {
  const pendingReplay = pendingPairedAnswerReplays.get(task);
  if (pendingReplay) {
    ctx.options.pairedAnswerReplayCache?.set(pendingReplay.key, pendingReplay.entry);
  }
  tasks.push(task);
  // Pass the GLOBAL total (ctx.totalCount), not a per-plan total —
  // `tasks.length` is cumulative across every plan in ctx.plans, so a
  // per-plan divisor would overflow to "N/3" nonsense in plan 2+.
  ctx.options.onTaskComplete?.(task, tasks.length, ctx.totalCount);
}

interface TrialAttributionCapture {
  witness?: TaskAttributionWitness;
}

async function executeTrialWithFailure(
  ctx: HarnessContext,
  trial: HarnessTrial,
  planIndex: number,
  answerSupportGate: boolean,
  pendingPairedAnswerReplays: Map<TaskResult, PendingPairedAnswerReplay>
): Promise<TaskResult> {
  const trialId = trial.taskId ?? trial.question.slice(0, 60);
  const attributionCapture: TrialAttributionCapture = {};
  try {
    return await executeTrial(
      ctx,
      trial,
      answerSupportGate,
      pendingPairedAnswerReplays,
      attributionCapture,
    );
  } catch (err) {
    const blocked = findBenchmarkRunBlockedError(err);
    if (blocked) {
      throw blocked;
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error(`  [WARN] harness trial plan-${planIndex}/${trialId} failed: ${message}`);
    return {
      taskId: trial.taskId,
      question: trial.question,
      expected: trial.expected,
      actual: `(error: ${message})`,
      scores: buildFailureScores(ctx.metricsSpec.metrics),
      latencyMs: 0,
      tokens: { input: 0, output: 0 },
      ...(trial.goldMemories ? { goldMemories: trial.goldMemories } : {}),
      ...(attributionCapture.witness
        ? { attributionWitness: attributionCapture.witness }
        : {}),
      details: {
        // Preserve the trial's category so a failed trial is still attributed
        // to its per-category bucket (computeCategoryAggregates), keeping the
        // per-category breakdown consistent with the overall aggregates that
        // already count this failure row (issue #1878).
        ...(typeof trial.extraDetails?.categoryName === "string"
          ? { categoryName: trial.extraDetails.categoryName }
          : {}),
        // `error` is retained for compatibility with existing diagnostics.
        // The structured marker is the authoritative run-status signal; an
        // arbitrary benchmark-owned `extraDetails.error` must not make a
        // successful trial look failed.
        error: message,
        benchmarkFailure: {
          kind: "trial_execution_failure",
          message,
        },
      },
    };
  }
}

function validateContext(ctx: HarnessContext): void {
  if (!ctx.options || !ctx.options.system) {
    throw new Error(
      "PublishedBenchmarkHarness requires a resolved options.system. " +
        "Valid shapes are created by the `benchmark-runner` CLI and the " +
        "bench test doubles in packages/bench/src/adapters/."
    );
  }
  if (!ctx.metricsSpec || !Array.isArray(ctx.metricsSpec.metrics)) {
    throw new Error(
      "PublishedBenchmarkHarness requires metricsSpec.metrics: one of " +
        "f1, contains_answer, rouge_l, llm_judge, judge_accuracy."
    );
  }
  const allowed: readonly HarnessMetricId[] = ["f1", "contains_answer", "rouge_l", "llm_judge", "judge_accuracy"];
  for (const metric of ctx.metricsSpec.metrics) {
    if (!allowed.includes(metric)) {
      throw new Error(
        `PublishedBenchmarkHarness: unknown metric "${String(metric)}". ` + `Valid metrics: ${allowed.join(", ")}.`
      );
    }
  }
  if (ctx.options.seed !== undefined) {
    if (!Number.isInteger(ctx.options.seed) || ctx.options.seed < 0) {
      throw new Error(
        `PublishedBenchmarkHarness: seed must be a non-negative integer; got ${String(ctx.options.seed)}.`
      );
    }
  }
}

function buildFailureScores(metrics: readonly HarnessMetricId[]): Record<string, number> {
  const scores: Record<string, number> = {};
  for (const metric of metrics) {
    scores[metric] = -1;
  }
  return scores;
}

function resolveTrialConcurrency(raw: unknown): number {
  if (raw === undefined) {
    return 1;
  }
  const parsed = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 64) {
    throw new Error("PublishedBenchmarkHarness: benchmarkOptions.trialConcurrency must be an integer from 1 to 64.");
  }
  return parsed;
}

function resolveAnswerSupportGate(options: ResolvedRunBenchmarkOptions): boolean {
  const raw = options.benchmarkOptions?.answerSupportGate ?? options.remnicConfig?.answerSupportGate;
  if (raw === undefined) {
    return false;
  }
  if (typeof raw === "boolean") {
    return raw;
  }
  if (typeof raw === "string") {
    const normalized = raw.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(normalized)) {
      return true;
    }
    if (["false", "0", "no", "off"].includes(normalized)) {
      return false;
    }
  }
  throw new Error(
    "PublishedBenchmarkHarness: answerSupportGate must be a boolean or one of true/false, 1/0, yes/no, on/off."
  );
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`)
    .join(",")}}`;
}

function pairedAnswerReplayKey(
  trial: HarnessTrial,
  recalledText: string,
  recallSupport: BenchRecallSupportAssessment | undefined,
  systemProvider: ResolvedRunBenchmarkOptions["systemProvider"],
  responderIdentity: string | null
): string {
  return createHash("sha256")
    .update(
      stableStringify({
        responder: {
          baseUrl: systemProvider?.baseUrl ?? null,
          disableThinking: systemProvider?.disableThinking ?? null,
          model: systemProvider?.model ?? null,
          provider: systemProvider?.provider ?? null,
          providerRequestTimeoutMs: systemProvider?.providerRequestTimeoutMs ?? null,
          reasoningEffort: systemProvider?.reasoningEffort ?? null,
          responderContextBudgetChars: systemProvider?.responderContextBudgetChars ?? null,
          responderPromptBudgetChars: systemProvider?.responderPromptBudgetChars ?? null,
          retryOptions: systemProvider?.retryOptions ?? null,
          seed: systemProvider?.seed ?? null,
          temperature: systemProvider?.temperature ?? null,
        },
        responderIdentity,
        responderPrompt: buildStrictBenchmarkQuestion(
          trial.question,
          trial.answerFormat ?? "auto"
        ),
        answerMode: "strict",
        question: trial.question,
        recalledText,
        recallSupport: recallSupport
          ? {
              evidenceCount: recallSupport.evidenceCount ?? null,
              maxScore: recallSupport.maxScore ?? null,
              reason: recallSupport.reason ?? null,
              status: recallSupport.status,
              supportThreshold: recallSupport.supportThreshold ?? null,
            }
          : null,
        taskId: trial.taskId,
      })
    )
    .digest("hex");
}

function pairedAnswerReplayEntry(
  sourceRuntimeProfile: PairedAnswerReplayEntry["sourceRuntimeProfile"],
  answer: HarnessAnswerResult
): PairedAnswerReplayEntry {
  return {
    sourceRuntimeProfile,
    finalAnswer: answer.finalAnswer,
    answeredText: answer.answeredText,
    ...(answer.model === undefined ? {} : { model: answer.model }),
  };
}

/**
 * Resolve a non-secret responder fingerprint. Returns `null` when the
 * responder does not declare an identity, signalling that the replay cache
 * must be disabled for this trial (paired runs will invoke the responder
 * directly every time instead of risking a cross-profile replay).
 */
function resolveResponderIdentity(responder: BenchResponder | undefined): string | null {
  if (!responder || typeof responder.identity !== "function") {
    return null;
  }
  let raw: string;
  try {
    raw = responder.identity();
  } catch {
    return null;
  }
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  return trimmed.length > 0 ? trimmed : null;
}

async function executeTrial(
  ctx: HarnessContext,
  trial: HarnessTrial,
  answerSupportGate: boolean,
  pendingPairedAnswerReplays: Map<TaskResult, PendingPairedAnswerReplay>,
  attributionCapture: TrialAttributionCapture,
): Promise<TaskResult> {
  const { result: recallResult, durationMs } = await timed(async () => {
    const recallBudget = benchmarkRecallBudgetForSessionCount(trial.recallSessionIds.length);
    const witnessEnabled =
      (trial.goldMemories?.length ?? 0) > 0 &&
      typeof ctx.options.system.recallWithTrace === "function" &&
      typeof ctx.options.system.captureAttributionWitness === "function";
    const recalledSessions = await Promise.all(
      trial.recallSessionIds.map(async (sessionId) => {
        if (!witnessEnabled) {
          return {
            text: await ctx.options.system.recall(sessionId, trial.question, recallBudget),
          };
        }
        const traced = await ctx.options.system.recallWithTrace!(
          sessionId,
          trial.question,
          recallBudget,
        );
        const attribution: BenchAttributionRetrieval = traced.attribution ?? {
          sessionId,
          appliedCap: null,
          atCapMemoryIds: null,
          headroomMemoryIds: null,
        };
        return { text: traced.text, attribution };
      }),
    );
    if (witnessEnabled) {
      attributionCapture.witness = await ctx.options.system.captureAttributionWitness!({
        goldMemories: trial.goldMemories!,
        retrievals: recalledSessions.map((session) => session.attribution!),
      }).catch(() => undefined);
    }
    const rawRecalledText = recalledSessions
      .map((session) => session.text)
      .filter(Boolean)
      .join("\n\n");
    const recalledText = trial.recallTextTransform
      ? trial.recallTextTransform({
          question: trial.question,
          recalledText: rawRecalledText,
        })
      : rawRecalledText;
    const recallSupport = answerSupportGate ? await assessRecallSupport(ctx, trial, recalledText) : undefined;
    return { recalledText, recallSupport };
  });
  const { recalledText, recallSupport } = recallResult;
  const responderIdentity = resolveResponderIdentity(ctx.options.system.responder);
  const answerReplayKey =
    ctx.options.pairedAnswerReplayCache && responderIdentity !== null
      ? pairedAnswerReplayKey(
          trial,
          recalledText,
          recallSupport,
          ctx.options.systemProvider,
          responderIdentity,
        )
      : undefined;
  const cachedAnswer = answerReplayKey ? ctx.options.pairedAnswerReplayCache?.get(answerReplayKey) : undefined;
  const currentProfile = ctx.options.runtimeProfile ?? null;
  const pairedAnswerReusedFrom =
    cachedAnswer?.sourceRuntimeProfile === "baseline" && currentProfile === "real" ? "baseline" : undefined;
  let answered: HarnessAnswerResult;
  if (pairedAnswerReusedFrom) {
    const reusedAnswer = cachedAnswer!;
    answered = {
      finalAnswer: reusedAnswer.finalAnswer,
      recalledText,
      answeredText: reusedAnswer.answeredText,
      latencyMs: 0,
      tokens: { input: 0, output: 0 },
      model: reusedAnswer.model,
    };
  } else {
    answered = await answerBenchmarkQuestion({
      question: trial.question,
      recalledText,
      responder: ctx.options.system.responder,
      answerMode: "strict",
      answerFormat: trial.answerFormat,
      recallSupport,
    }).catch((error: unknown) => answerWithTrialFallback(trial, recalledText, error));
    answered = refineTrialAnswer(trial, recalledText, answered);
  }

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

  // Only invoke the LLM judge when judge-backed metrics are in the spec.
  // Cursor review feedback on PR 596: unconditionally calling the judge
  // billed non-judge runs for an API call per trial and inflated the
  // `TaskResult` latency/token totals. The zero-valued placeholder
  // below keeps the downstream arithmetic unchanged for runs that
  // don't opt into the judge.
  const judgeRequested =
    ctx.metricsSpec.metrics.includes("llm_judge") || ctx.metricsSpec.metrics.includes("judge_accuracy");
  const judgeResult = judgeRequested
    ? await scoreTrialJudge(ctx, trial, answered.finalAnswer)
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
        scores.contains_answer = containsAnswer(answered.finalAnswer, trial.expected);
        break;
      case "rouge_l":
        scores.rouge_l = rougeL(answered.finalAnswer, trial.expected);
        break;
      case "llm_judge":
        if (judgeResult.score >= 0) {
          scores.llm_judge = judgeResult.score;
        }
        break;
      case "judge_accuracy":
        if (judgeResult.score >= 0) {
          scores.judge_accuracy = judgeResult.score >= 0.5 ? 1 : 0;
        } else {
          scores.judge_accuracy = -1;
        }
        break;
      default: {
        // Unreachable — validated in validateContext. Keep as a sanity
        // guard; CLAUDE.md rule 53 (enumerate all non-active states).
        const exhaustive: never = metric;
        throw new Error(`PublishedBenchmarkHarness: metric ${String(exhaustive)} not handled.`);
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
    ...(answerSupportGate ? { answerSupportGate: true, recallSupport } : {}),
    ...(pairedAnswerReusedFrom ? { pairedAnswerReusedFrom } : {}),
    responderModel: answered.model,
    judgeModel: judgeResult.model,
    ...(answered.fallbackReason ? { answerFallbackReason: answered.fallbackReason } : {}),
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

  const task: TaskResult = {
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
    ...(trial.goldMemories ? { goldMemories: trial.goldMemories } : {}),
    ...(attributionCapture.witness
      ? { attributionWitness: attributionCapture.witness }
      : {}),
    details,
  };
  if (answerReplayKey && currentProfile === "baseline" && answered.fallbackReason === undefined) {
    pendingPairedAnswerReplays.set(task, {
      key: answerReplayKey,
      entry: pairedAnswerReplayEntry(currentProfile, answered),
    });
  }
  return task;
}

async function assessRecallSupport(
  ctx: HarnessContext,
  trial: HarnessTrial,
  recalledText: string
): Promise<BenchRecallSupportAssessment> {
  if (recalledText.trim().length === 0) {
    return {
      status: "empty",
      reason: "successful recall returned empty responder context",
      evidenceCount: 0,
    };
  }

  const assessor = ctx.options.system.assessRecallSupport;
  if (!assessor) {
    return {
      status: "unavailable",
      reason: "adapter did not provide an exact-context support assessment",
    };
  }

  try {
    const assessment = await assessor.call(ctx.options.system, {
      query: trial.question,
      recalledText,
      sessionIds: trial.recallSessionIds,
    });
    validateRecallSupportAssessment(assessment);
    return assessment;
  } catch (error) {
    const blocked = findBenchmarkRunBlockedError(error);
    if (blocked) {
      throw blocked;
    }
    return {
      status: "backend_failure",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

function validateRecallSupportAssessment(assessment: BenchRecallSupportAssessment): void {
  const allowed: readonly BenchRecallSupportStatus[] = ["supported", "weak", "empty", "unavailable", "backend_failure"];
  if (!assessment || !allowed.includes(assessment.status)) {
    throw new Error("adapter returned an invalid recall support status");
  }
  if (assessment.status !== "weak") {
    return;
  }
  if (
    !Number.isInteger(assessment.evidenceCount) ||
    (assessment.evidenceCount ?? 0) <= 0 ||
    !Number.isFinite(assessment.maxScore) ||
    !Number.isFinite(assessment.supportThreshold) ||
    (assessment.maxScore ?? Number.POSITIVE_INFINITY) >= (assessment.supportThreshold ?? Number.NEGATIVE_INFINITY)
  ) {
    throw new Error(
      "adapter weak recall support requires a positive evidenceCount and a finite maxScore below supportThreshold"
    );
  }
}

async function scoreTrialJudge(ctx: HarnessContext, trial: HarnessTrial, answeredText: string) {
  if (!trial.binaryJudgePrompt) {
    return llmJudgeScoreDetailed(ctx.options.system.judge, trial.question, answeredText, trial.expected);
  }

  const judge = ctx.options.system.judge;
  if (!judge?.scoreBinaryPrompt) {
    return llmJudgeScoreDetailed(judge, trial.question, answeredText, trial.expected);
  }

  const prompt = trial.binaryJudgePrompt({
    question: trial.question,
    expected: trial.expected,
    answeredText,
  });
  if (typeof prompt !== "string" || prompt.trim().length === 0) {
    throw new Error("PublishedBenchmarkHarness: binaryJudgePrompt returned an empty prompt.");
  }

  const binaryJudge = {
    scoreBinaryPrompt: judge.scoreBinaryPrompt.bind(judge),
  };
  return llmBinaryJudgeScoreDetailed(binaryJudge, prompt, {
    predicted: answeredText,
    expected: trial.expected,
  });
}

type HarnessAnswerResult = BenchmarkAnswerResult & {
  fallbackReason?: string;
  refinementReason?: string;
  originalAnswer?: string;
};

function answerWithTrialFallback(trial: HarnessTrial, recalledText: string, error: unknown): HarnessAnswerResult {
  if (isBenchmarkRunBlockedError(error)) {
    throw error;
  }
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
  answered: HarnessAnswerResult
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
  executionProvenance: BenchmarkExecutionProvenance
): Promise<BenchmarkResult> {
  const remnicVersion = await getRemnicVersion();
  const totalLatencyMs = tasks.reduce((sum, task) => sum + task.latencyMs, 0);
  const totalInputTokens = tasks.reduce((sum, task) => sum + task.tokens.input, 0);
  const totalOutputTokens = tasks.reduce((sum, task) => sum + task.tokens.output, 0);
  const mode: BenchmarkMode = ctx.options.mode;
  const failedTasks = tasks.flatMap((task) => {
    const marker = task.details?.benchmarkFailure;
    if (
      typeof marker !== "object" ||
      marker === null ||
      (marker as { kind?: unknown }).kind !== "trial_execution_failure"
    ) {
      return [];
    }
    const message = (marker as { message?: unknown }).message;
    return [
      {
        taskId: task.taskId,
        message: typeof message === "string" ? message : "unknown trial failure",
      },
    ];
  });
  const failureReason =
    failedTasks.length > 0
      ? `trial_execution_failure: ${failedTasks.length}/${tasks.length} scored trial(s) failed (${failedTasks
          .slice(0, 3)
          .map((failure) => `${failure.taskId}: ${failure.message.slice(0, 240)}`)
          .join("; ")}${failedTasks.length > 3 ? `; and ${failedTasks.length - 3} more` : ""})`
      : undefined;
  const categoryAggregates = computeCategoryAggregates(tasks);

  return {
    meta: {
      id: randomUUID(),
      benchmark: ctx.options.benchmark.id,
      benchmarkTier: ctx.options.benchmark.tier,
      version: ctx.options.benchmark.meta.version,
      remnicVersion,
      ...executionProvenance,
      timestamp: new Date().toISOString(),
      mode,
      runCount: 1,
      seeds: [ctx.options.seed ?? 0],
      ...(failureReason ? { status: "partial" as const, failureReason } : {}),
    },
    config: {
      systemProvider: ctx.options.systemProvider ?? null,
      judgeProvider: ctx.options.judgeProvider ?? null,
      adapterMode: ctx.options.adapterMode ?? "direct",
      remnicConfig: ctx.options.remnicConfig ?? {},
      ...(ctx.options.benchmarkOptions ? { benchmarkOptions: ctx.options.benchmarkOptions } : {}),
    },
    cost: {
      totalTokens: totalInputTokens + totalOutputTokens,
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      estimatedCostUsd: 0,
      totalLatencyMs,
      meanQueryLatencyMs: tasks.length > 0 ? totalLatencyMs / tasks.length : 0,
    },
    results: {
      tasks,
      aggregates: aggregateTaskScores(tasks.map((task) => task.scores)),
      // Per-category breakdown for benchmarks that stamp a `categoryName`
      // detail (LoCoMo). Omitted when empty so other benchmarks' output shape
      // is unchanged (issue #1878).
      ...(Object.keys(categoryAggregates).length > 0 ? { categoryAggregates } : {}),
    },
    environment: {
      os: process.platform,
      nodeVersion: process.version,
      hardware: process.arch,
    },
  };
}
