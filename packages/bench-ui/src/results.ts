import fs from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type {
  BenchAggregateMetric,
  BenchAssistantTaskDetails,
  BenchIntegritySplit,
  BenchIntegritySummary,
  BenchMetricHighlight,
  BenchPerSeedScore,
  BenchResultSummary,
  BenchResultSummaryPayload,
  BenchTaskScoreEntry,
  BenchTaskSummary,
} from "./bench-data.js";
import { compareMetricNames, compareStrings, compareTimestampedRuns } from "./sort-utils.js";

const DEFAULT_CANARY_FLOOR = 0.1;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/u;

function isSha256Hex(value: unknown): value is string {
  return typeof value === "string" && SHA256_HEX_PATTERN.test(value);
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
  return DEFAULT_CANARY_FLOOR;
}

function computeIntegritySummary(meta: JsonRecord): BenchIntegritySummary {
  const canaryScoreRaw = meta.canaryScore;
  const canaryScore =
    typeof canaryScoreRaw === "number" && Number.isFinite(canaryScoreRaw)
      ? canaryScoreRaw
      : null;

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

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function providerLabel(value: unknown): string {
  if (!isRecord(value)) {
    return "unconfigured";
  }

  const provider = typeof value.provider === "string" ? value.provider : null;
  const model = typeof value.model === "string" ? value.model : null;

  if (provider && model) {
    return `${provider}/${model}`;
  }
  if (provider) {
    return provider;
  }
  if (model) {
    return model;
  }

  return "unconfigured";
}

function scoreEntries(scores: unknown): BenchTaskScoreEntry[] {
  if (!isRecord(scores)) {
    return [];
  }

  return Object.entries(scores)
    .map(([name, value]) => ({ name, value: toFiniteNumber(value) }))
    .filter((entry): entry is { name: string; value: number } => entry.value !== null)
    .sort((left, right) => compareMetricNames(left.name, right.name))
    .map(({ name, value }) => ({ name, value }));
}

function primaryMetricNameFromEntries(entries: Array<{ name: string }>): string | null {
  return entries[0]?.name ?? null;
}

function aggregateMetrics(result: JsonRecord): BenchAggregateMetric[] {
  const results = isRecord(result.results) ? result.results : {};
  const aggregates = isRecord(results.aggregates) ? results.aggregates : {};
  const statistics = isRecord(results.statistics) ? results.statistics : {};
  const confidenceIntervals = isRecord(statistics.confidenceIntervals)
    ? statistics.confidenceIntervals
    : {};
  const effectSizes = isRecord(statistics.effectSizes) ? statistics.effectSizes : {};

  return Object.entries(aggregates)
    .map(([name, aggregate]): BenchAggregateMetric | null => {
      if (!isRecord(aggregate)) {
        return null;
      }

      const interval = isRecord(confidenceIntervals[name]) ? confidenceIntervals[name] : {};
      const effect = isRecord(effectSizes[name]) ? effectSizes[name] : {};

      return {
        name,
        mean: toFiniteNumber(aggregate.mean),
        median: toFiniteNumber(aggregate.median),
        stdDev: toFiniteNumber(aggregate.stdDev),
        min: toFiniteNumber(aggregate.min),
        max: toFiniteNumber(aggregate.max),
        ciLower: toFiniteNumber(interval.lower),
        ciUpper: toFiniteNumber(interval.upper),
        ciLevel: toFiniteNumber(interval.level),
        effectSize: toFiniteNumber(effect.cohensD),
        effectInterpretation:
          typeof effect.interpretation === "string" ? effect.interpretation : null,
      };
    })
    .filter((metric): metric is BenchAggregateMetric => metric !== null)
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

function assistantDetails(value: unknown): BenchAssistantTaskDetails | null {
  if (!isRecord(value)) return null;
  const perSeedRaw = Array.isArray(value.perSeedScores) ? value.perSeedScores : null;
  if (!perSeedRaw) return null;
  const perSeedScores = perSeedRaw
    .map(assistantPerSeedScore)
    .filter((entry): entry is BenchPerSeedScore => entry !== null);
  return {
    focus: typeof value.focus === "string" ? value.focus : null,
    rubricId: typeof value.rubricId === "string" ? value.rubricId : null,
    rubricSha256:
      typeof value.rubricSha256 === "string" ? value.rubricSha256 : null,
    perSeedScores,
    judgeParseFailures: toFiniteNumber(value.judgeParseFailures),
  };
}

function taskSummaries(result: JsonRecord): BenchTaskSummary[] {
  const results = isRecord(result.results) ? result.results : {};
  const tasks = Array.isArray(results.tasks) ? results.tasks : [];

  return tasks
    .map((task): BenchTaskSummary | null => {
      if (!isRecord(task) || typeof task.taskId !== "string") {
        return null;
      }

      const entries = scoreEntries(task.scores);
      const tokens = isRecord(task.tokens) ? task.tokens : {};
      const primaryMetric = primaryMetricNameFromEntries(entries);
      const primaryEntry = primaryMetric
        ? entries.find((entry) => entry.name === primaryMetric) ?? null
        : null;

      return {
        taskId: task.taskId,
        question: typeof task.question === "string" ? task.question : "",
        expected: typeof task.expected === "string" ? task.expected : "",
        actual: typeof task.actual === "string" ? task.actual : "",
        latencyMs: toFiniteNumber(task.latencyMs),
        totalTokens:
          (toFiniteNumber(tokens.input) ?? 0) + (toFiniteNumber(tokens.output) ?? 0),
        primaryScore: primaryEntry?.value ?? null,
        scoreEntries: entries,
        assistantDetails: assistantDetails(task.details),
      };
    })
    .filter((task): task is BenchTaskSummary => task !== null)
    .sort((left, right) => compareStrings(left.taskId, right.taskId));
}

export function summarizeBenchmarkResult(
  result: unknown,
  filePath: string,
): BenchResultSummary | null {
  if (!isRecord(result)) {
    return null;
  }

  const meta = isRecord(result.meta) ? result.meta : {};
  const config = isRecord(result.config) ? result.config : {};
  const cost = isRecord(result.cost) ? result.cost : {};
  const metrics = aggregateMetrics(result);
  const tasks = taskSummaries(result);
  const primaryMetric = metrics[0]?.name ?? null;
  const primaryScore = metrics[0]?.mean ?? null;

  if (
    typeof meta.id !== "string" ||
    typeof meta.benchmark !== "string" ||
    typeof meta.timestamp !== "string"
  ) {
    return null;
  }

  const systemProvider = providerLabel(config.systemProvider);
  const judgeProvider = providerLabel(config.judgeProvider);
  const remnicConfig = isRecord(config.remnicConfig) ? config.remnicConfig : {};
  const assistantRubricId =
    typeof remnicConfig.assistantRubricId === "string"
      ? remnicConfig.assistantRubricId
      : null;
  const assistantRubricSha256 =
    typeof remnicConfig.assistantRubricSha256 === "string"
      ? remnicConfig.assistantRubricSha256
      : null;
  const assistantRunId =
    typeof remnicConfig.assistantRunId === "string"
      ? remnicConfig.assistantRunId
      : null;

  return {
    id: meta.id,
    benchmark: meta.benchmark,
    benchmarkTier:
      typeof meta.benchmarkTier === "string" ? meta.benchmarkTier : "custom",
    timestamp: meta.timestamp,
    mode: meta.mode === "full" ? "full" : "quick",
    totalLatencyMs: toFiniteNumber(cost.totalLatencyMs),
    meanQueryLatencyMs: toFiniteNumber(cost.meanQueryLatencyMs),
    taskCount: tasks.length,
    metricHighlights: metricHighlights(metrics),
    primaryMetric,
    primaryScore,
    runCount: toFiniteNumber(meta.runCount) ?? tasks.length,
    estimatedCostUsd: toFiniteNumber(cost.estimatedCostUsd),
    totalTokens: toFiniteNumber(cost.totalTokens),
    inputTokens: toFiniteNumber(cost.inputTokens),
    outputTokens: toFiniteNumber(cost.outputTokens),
    systemProvider,
    judgeProvider,
    providerKey: `${systemProvider}__${judgeProvider}`,
    adapterMode:
      typeof config.adapterMode === "string" ? config.adapterMode : "unknown",
    aggregateMetrics: metrics,
    taskSummaries: tasks,
    integrity: computeIntegritySummary(meta),
    assistantRubricId,
    assistantRubricSha256,
    assistantRunId,
    filePath,
  };
}

export async function loadBenchResultSummaries(
  resultsDir: string,
): Promise<BenchResultSummaryPayload> {
  if (!fs.existsSync(resultsDir)) {
    return {
      resultsDir,
      summaries: [],
      skippedFiles: [],
    };
  }

  const entries = await readdir(resultsDir, { withFileTypes: true });
  const summaries: BenchResultSummary[] = [];
  const skippedFiles: BenchResultSummaryPayload["skippedFiles"] = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }

    const filePath = path.join(resultsDir, entry.name);

    try {
      const raw = await readFile(filePath, "utf8");
      const summary = summarizeBenchmarkResult(JSON.parse(raw) as unknown, filePath);
      if (summary) {
        summaries.push(summary);
      } else {
        skippedFiles.push({ filePath, reason: "missing required benchmark result fields" });
      }
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
