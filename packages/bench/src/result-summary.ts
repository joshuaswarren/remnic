/**
 * Rich result summaries for tooling surfaces (bench-ui, /api/results feeds).
 *
 * `listBenchmarkResults` in results-store.ts answers "which runs exist";
 * this module answers "what is in a run" for display: aggregate metrics
 * joined with confidence intervals and effect sizes, per-task score
 * tables, assistant per-seed details, and the integrity badge block.
 *
 * Every summary is backed by a `BenchmarkResult` that passed
 * `loadBenchmarkResult` validation. Fields the validator does not check
 * (aggregate/statistic values, `meta.canaryFloor`, assistant
 * `task.details`) are still defensively coerced, so a hand-edited
 * artifact degrades to nulls instead of crashing a consumer.
 */

import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";

import { CANARY_SCORE_FLOOR, isSha256Hex } from "./integrity/index.js";
import { loadBenchmarkResult } from "./results-store.js";
import type { BenchmarkResult, ProviderConfig, TaskResult } from "./types.js";

export interface BenchMetricHighlight {
  name: string;
  mean: number;
}

export interface BenchAggregateMetric {
  name: string;
  mean: number | null;
  median: number | null;
  stdDev: number | null;
  min: number | null;
  max: number | null;
  ciLower: number | null;
  ciUpper: number | null;
  ciLevel: number | null;
  effectSize: number | null;
  effectInterpretation: string | null;
}

export interface BenchTaskScoreEntry {
  name: string;
  value: number;
}

export interface BenchPerSeedScore {
  seed: number;
  identityAccuracy: number | null;
  stanceCoherence: number | null;
  novelty: number | null;
  calibration: number | null;
  parseOk: boolean;
  notes: string;
  latencyMs: number | null;
}

export interface BenchAssistantTaskDetails {
  focus: string | null;
  rubricId: string | null;
  rubricSha256: string | null;
  perSeedScores: BenchPerSeedScore[];
  judgeParseFailures: number | null;
}

export interface BenchTaskSummary {
  taskId: string;
  question: string;
  expected: string;
  actual: string;
  latencyMs: number | null;
  totalTokens: number;
  primaryScore: number | null;
  scoreEntries: BenchTaskScoreEntry[];
  assistantDetails?: BenchAssistantTaskDetails | null;
}

export type BenchIntegritySplit = "public" | "holdout" | "unknown";

export interface BenchIntegritySummary {
  /** Which split produced this result. `unknown` on legacy results. */
  split: BenchIntegritySplit;
  /** True when qrels/judge/dataset hashes are all present and well-formed. */
  sealsPresent: boolean;
  /** True when the canary score is non-null and sits at or below the floor. */
  canaryUnderFloor: boolean | null;
  /** The canary score recorded with the result, when present. */
  canaryScore: number | null;
  /** The canary floor applied — defaults to `CANARY_SCORE_FLOOR`. */
  canaryFloor: number;
  /** Truncated hashes for display (first 12 chars). */
  qrelsSealedHashShort: string | null;
  judgePromptHashShort: string | null;
  datasetHashShort: string | null;
}

export interface BenchResultSummary {
  id: string;
  benchmark: string;
  benchmarkTier: string;
  timestamp: string;
  mode: string;
  totalLatencyMs: number | null;
  meanQueryLatencyMs: number | null;
  taskCount: number;
  metricHighlights: BenchMetricHighlight[];
  primaryMetric: string | null;
  primaryScore: number | null;
  runCount: number;
  estimatedCostUsd: number | null;
  totalTokens: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  systemProvider: string;
  judgeProvider: string;
  providerKey: string;
  adapterMode: string;
  aggregateMetrics: BenchAggregateMetric[];
  taskSummaries: BenchTaskSummary[];
  integrity: BenchIntegritySummary;
  assistantRubricId?: string | null;
  assistantRubricSha256?: string | null;
  assistantRunId?: string | null;
  filePath: string;
}

export interface BenchResultFileWarning {
  filePath: string;
  reason: string;
}

export interface BenchResultSummaryPayload {
  resultsDir: string;
  summaries: BenchResultSummary[];
  skippedFiles?: BenchResultFileWarning[];
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

const metricPriority = [
  "score",
  "accuracy",
  "f1",
  "exact_match",
  "llm_judge",
  "semantic_similarity",
  "precision",
  "recall",
];

function compareStrings(left: string, right: string): number {
  return left.localeCompare(right);
}

function compareMetricNames(left: string, right: string): number {
  const leftIndex = metricPriority.indexOf(left);
  const rightIndex = metricPriority.indexOf(right);

  if (leftIndex !== rightIndex) {
    if (leftIndex === -1) return 1;
    if (rightIndex === -1) return -1;
    return leftIndex - rightIndex;
  }

  return compareStrings(left, right);
}

function compareTimestampedRuns<T extends { timestamp: string; id: string }>(
  left: T,
  right: T,
): number {
  if (left.timestamp === right.timestamp) {
    return compareStrings(left.id, right.id);
  }

  return right.timestamp.localeCompare(left.timestamp);
}

function shortHash(value: unknown): string | null {
  return isSha256Hex(value) ? value.slice(0, 12) : null;
}

function resolveSplit(value: unknown): BenchIntegritySplit {
  return value === "public" || value === "holdout" ? value : "unknown";
}

function resolveCanaryFloor(value: unknown): number {
  // Results produced under a custom `REMNIC_BENCH_CANARY_FLOOR` may persist
  // the floor into `meta.canaryFloor`. If present and finite, honor it so
  // the badge matches the gate that produced the result.
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return value;
  }
  return CANARY_SCORE_FLOOR;
}

function computeIntegritySummary(meta: BenchmarkResult["meta"]): BenchIntegritySummary {
  const canaryScore = toFiniteNumber(meta.canaryScore);
  const canaryFloor = resolveCanaryFloor(meta.canaryFloor);

  const sealsPresent =
    isSha256Hex(meta.qrelsSealedHash) &&
    isSha256Hex(meta.judgePromptHash) &&
    isSha256Hex(meta.datasetHash);

  return {
    split: resolveSplit(meta.splitType),
    sealsPresent,
    canaryScore,
    canaryFloor,
    canaryUnderFloor: canaryScore === null ? null : canaryScore <= canaryFloor,
    qrelsSealedHashShort: shortHash(meta.qrelsSealedHash),
    judgePromptHashShort: shortHash(meta.judgePromptHash),
    datasetHashShort: shortHash(meta.datasetHash),
  };
}

function providerLabel(provider: ProviderConfig | null): string {
  if (!provider) {
    return "unconfigured";
  }
  return `${provider.provider}/${provider.model}`;
}

function aggregateMetrics(result: BenchmarkResult): BenchAggregateMetric[] {
  const statistics = result.results.statistics;
  const confidenceIntervals = statistics?.confidenceIntervals ?? {};
  const effectSizes = statistics?.effectSizes ?? {};

  return Object.entries(result.results.aggregates)
    .map(([name, aggregate]) => {
      const interval = confidenceIntervals[name];
      const effect = effectSizes[name];

      return {
        name,
        mean: toFiniteNumber(aggregate?.mean),
        median: toFiniteNumber(aggregate?.median),
        stdDev: toFiniteNumber(aggregate?.stdDev),
        min: toFiniteNumber(aggregate?.min),
        max: toFiniteNumber(aggregate?.max),
        ciLower: toFiniteNumber(interval?.lower),
        ciUpper: toFiniteNumber(interval?.upper),
        ciLevel: toFiniteNumber(interval?.level),
        effectSize: toFiniteNumber(effect?.cohensD),
        effectInterpretation:
          typeof effect?.interpretation === "string" ? effect.interpretation : null,
      };
    })
    .sort((left, right) => compareMetricNames(left.name, right.name));
}

function metricHighlights(metrics: BenchAggregateMetric[]): BenchMetricHighlight[] {
  return metrics
    .filter((metric): metric is BenchAggregateMetric & { mean: number } => metric.mean !== null)
    .slice(0, 3)
    .map((metric) => ({ name: metric.name, mean: metric.mean }));
}

function assistantPerSeedScore(value: unknown): BenchPerSeedScore | null {
  if (!isRecord(value)) return null;
  const scores = isRecord(value.scores) ? value.scores : {};
  const seed = toFiniteNumber(value.seed);
  if (seed === null) return null;
  return {
    seed,
    identityAccuracy: toFiniteNumber(scores.identity_accuracy),
    stanceCoherence: toFiniteNumber(scores.stance_coherence),
    novelty: toFiniteNumber(scores.novelty),
    calibration: toFiniteNumber(scores.calibration),
    parseOk: value.parseOk === true,
    notes: typeof value.notes === "string" ? value.notes : "",
    latencyMs: toFiniteNumber(value.latencyMs),
  };
}

function assistantDetails(value: Record<string, unknown> | undefined): BenchAssistantTaskDetails | null {
  if (!value || !Array.isArray(value.perSeedScores)) return null;
  const perSeedScores = value.perSeedScores
    .map(assistantPerSeedScore)
    .filter((entry): entry is BenchPerSeedScore => entry !== null);
  return {
    focus: typeof value.focus === "string" ? value.focus : null,
    rubricId: typeof value.rubricId === "string" ? value.rubricId : null,
    rubricSha256: typeof value.rubricSha256 === "string" ? value.rubricSha256 : null,
    perSeedScores,
    judgeParseFailures: toFiniteNumber(value.judgeParseFailures),
  };
}

function scoreEntries(scores: TaskResult["scores"]): BenchTaskScoreEntry[] {
  return Object.entries(scores)
    .map(([name, value]) => ({ name, value }))
    .sort((left, right) => compareMetricNames(left.name, right.name));
}

function taskSummaries(result: BenchmarkResult): BenchTaskSummary[] {
  return result.results.tasks
    .map((task) => {
      const entries = scoreEntries(task.scores);
      return {
        taskId: task.taskId,
        question: task.question,
        expected: task.expected,
        actual: task.actual,
        latencyMs: task.latencyMs,
        totalTokens: task.tokens.input + task.tokens.output,
        primaryScore: entries[0]?.value ?? null,
        scoreEntries: entries,
        assistantDetails: assistantDetails(task.details),
      };
    })
    .sort((left, right) => compareStrings(left.taskId, right.taskId));
}

export function summarizeBenchmarkResult(
  result: BenchmarkResult,
  filePath: string,
): BenchResultSummary {
  const metrics = aggregateMetrics(result);
  const tasks = taskSummaries(result);
  const systemProvider = providerLabel(result.config.systemProvider);
  const judgeProvider = providerLabel(result.config.judgeProvider);
  const remnicConfig = result.config.remnicConfig;
  const configString = (key: string): string | null =>
    typeof remnicConfig[key] === "string" ? (remnicConfig[key] as string) : null;

  return {
    id: result.meta.id,
    benchmark: result.meta.benchmark,
    benchmarkTier: result.meta.benchmarkTier,
    timestamp: result.meta.timestamp,
    mode: result.meta.mode,
    totalLatencyMs: result.cost.totalLatencyMs,
    meanQueryLatencyMs: result.cost.meanQueryLatencyMs,
    taskCount: tasks.length,
    metricHighlights: metricHighlights(metrics),
    primaryMetric: metrics[0]?.name ?? null,
    primaryScore: metrics[0]?.mean ?? null,
    runCount: result.meta.runCount,
    estimatedCostUsd: result.cost.estimatedCostUsd,
    totalTokens: result.cost.totalTokens,
    inputTokens: result.cost.inputTokens,
    outputTokens: result.cost.outputTokens,
    systemProvider,
    judgeProvider,
    providerKey: `${systemProvider}__${judgeProvider}`,
    adapterMode: result.config.adapterMode,
    aggregateMetrics: metrics,
    taskSummaries: tasks,
    integrity: computeIntegritySummary(result.meta),
    assistantRubricId: configString("assistantRubricId"),
    assistantRubricSha256: configString("assistantRubricSha256"),
    assistantRunId: configString("assistantRunId"),
    filePath,
  };
}

export async function loadBenchmarkResultSummaries(
  resultsDir: string,
): Promise<BenchResultSummaryPayload> {
  if (!existsSync(resultsDir)) {
    return {
      resultsDir,
      summaries: [],
      skippedFiles: [],
    };
  }

  const entries = await readdir(resultsDir, { withFileTypes: true });
  const summaries: BenchResultSummary[] = [];
  const skippedFiles: BenchResultFileWarning[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }

    const filePath = path.join(resultsDir, entry.name);

    try {
      const result = await loadBenchmarkResult(filePath);
      summaries.push(summarizeBenchmarkResult(result, filePath));
    } catch (error) {
      skippedFiles.push({
        filePath,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  summaries.sort(compareTimestampedRuns);

  return {
    resultsDir,
    summaries,
    skippedFiles,
  };
}
