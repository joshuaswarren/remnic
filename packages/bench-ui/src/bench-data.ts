import { compareMetricNames, compareStrings, compareTimestampedRuns } from "./sort-utils";

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
  /** The canary floor applied — defaults to 0.1. */
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
  mode: "quick" | "full";
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

export interface BenchResultSummaryPayload {
  resultsDir: string;
  summaries: BenchResultSummary[];
  skippedFiles?: BenchResultFileWarning[];
}

export interface BenchResultFileWarning {
  filePath: string;
  reason: string;
}

export type TrendRange = "7d" | "30d" | "90d" | "all";

export interface BenchmarkCard {
  benchmark: string;
  latest: BenchResultSummary;
  previous: BenchResultSummary | null;
  delta: number | null;
}

export type RecentRun = BenchResultSummary & { delta: number | null };

export interface TrendPoint {
  runId: string;
  benchmark: string;
  label: string;
  timestamp: string;
  score: number;
}

export interface RunFilters {
  benchmark: string;
  systemProvider: string;
  judgeProvider: string;
  mode: string;
  range: TrendRange;
}

export interface CompareMetricRow {
  name: string;
  baseline: number | null;
  candidate: number | null;
  delta: number | null;
  percentChange: number | null;
  ciLower: number | null;
  ciUpper: number | null;
  effectSize: number | null;
  effectInterpretation: string | null;
}

export interface TaskDeltaRow {
  taskId: string;
  baseline: number | null;
  candidate: number | null;
  delta: number | null;
  question: string;
  latencyMs: number | null;
}

export interface CompareModel {
  baseline: BenchResultSummary;
  candidate: BenchResultSummary;
  metricRows: CompareMetricRow[];
  taskRows: TaskDeltaRow[];
}

export interface HistogramBucket {
  label: string;
  count: number;
}

export interface ProviderRow {
  providerKey: string;
  systemProvider: string;
  judgeProvider: string;
  runCount: number;
  benchmarks: string[];
  averageScore: number | null;
  averageCostUsd: number | null;
  benchmarkScores: Record<string, number | null>;
}

function withinRange(timestamp: string, range: TrendRange, anchor: number): boolean {
  const value = Date.parse(timestamp);
  if (Number.isNaN(value) || value > anchor) {
    return false;
  }

  if (range === "all") {
    return true;
  }

  const days = range === "7d" ? 7 : range === "30d" ? 30 : 90;
  return value >= anchor - days * 24 * 60 * 60 * 1000;
}

export function humanizeIdentifier(value: string): string {
  return value
    .split(/[-_/]+/u)
    .filter((segment) => segment.length > 0)
    .map((segment) => segment[0]!.toUpperCase() + segment.slice(1))
    .join(" ");
}

const rawCountMetrics = new Set([
  "search_hits",
  // ingestion-setup-friction raw count metrics — lower is better
  "setup_friction",
  "commands_count",
  "prompts_count",
  "errors_count",
]);

const lowerIsBetterRawCountMetrics = new Set([
  "setup_friction",
  "commands_count",
  "prompts_count",
  "errors_count",
]);

export function isRawCountMetric(metricName?: string): boolean {
  return typeof metricName === "string" && rawCountMetrics.has(metricName);
}

export function isLowerIsBetterMetric(metricName?: string): boolean {
  return typeof metricName === "string" && lowerIsBetterRawCountMetrics.has(metricName);
}

export function formatMetricValue(value: number | null, metricName?: string): string {
  if (value === null) {
    return "n/a";
  }

  if (isRawCountMetric(metricName)) {
    return Number.isInteger(value) ? value.toString() : value.toFixed(2);
  }

  if (Math.abs(value) <= 1.25) {
    return `${(value * 100).toFixed(1)}%`;
  }

  return value.toFixed(2);
}

export function formatDelta(value: number | null, metricName?: string): string {
  if (value === null) {
    return "No baseline";
  }

  const prefix = value > 0 ? "+" : "";
  return `${prefix}${formatMetricValue(value, metricName)}`;
}

export function deltaPolarityClass(value: number | null, metricName?: string): string {
  if (value === null || value === 0) return "";
  const improved = isLowerIsBetterMetric(metricName) ? value < 0 : value > 0;
  return improved ? "delta-pill--positive" : "delta-pill--negative";
}

export function formatDuration(value: number | null): string {
  if (value === null) {
    return "n/a";
  }

  if (value < 1000) {
    return `${Math.round(value)} ms`;
  }

  return `${(value / 1000).toFixed(2)} s`;
}

export function formatCurrency(value: number | null): string {
  if (value === null) {
    return "n/a";
  }

  return `$${value.toFixed(3)}`;
}

export function formatTimestamp(value: string): string {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return value;
  }

  return new Date(timestamp).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function listBenchmarks(payload: BenchResultSummaryPayload): string[] {
  return Array.from(new Set(payload.summaries.map((summary) => summary.benchmark))).sort(compareStrings);
}

export function listProviders(
  payload: BenchResultSummaryPayload,
  field: "systemProvider" | "judgeProvider",
): string[] {
  return Array.from(new Set(payload.summaries.map((summary) => summary[field]))).sort(compareStrings);
}

export function getBenchmarkCards(payload: BenchResultSummaryPayload): BenchmarkCard[] {
  const cards: BenchmarkCard[] = [];

  for (const benchmark of listBenchmarks(payload)) {
    const runs = payload.summaries
      .filter((summary) => summary.benchmark === benchmark)
      .slice()
      .sort(compareTimestampedRuns);
    const latest = runs[0];
    if (!latest) {
      continue;
    }

    const previous = runs[1] ?? null;
    cards.push({
      benchmark,
      latest,
      previous,
      delta:
        latest.primaryScore !== null &&
        previous !== null &&
        previous.primaryScore !== null
          ? latest.primaryScore - previous.primaryScore
          : null,
    });
  }

  return cards.sort((left, right) => compareStrings(left.benchmark, right.benchmark));
}

export function getRecentRuns(payload: BenchResultSummaryPayload, limit = 6): RecentRun[] {
  const deltaByRunId = new Map<string, number | null>();

  for (const benchmark of listBenchmarks(payload)) {
    const runs = payload.summaries
      .filter((summary) => summary.benchmark === benchmark)
      .slice()
      .sort(compareTimestampedRuns);

    for (let index = 0; index < runs.length; index += 1) {
      const run = runs[index]!;
      const previous = runs[index + 1] ?? null;
      deltaByRunId.set(
        run.id,
        run.primaryScore !== null && previous !== null && previous.primaryScore !== null
          ? run.primaryScore - previous.primaryScore
          : null,
      );
    }
  }

  return payload.summaries
    .slice()
    .sort(compareTimestampedRuns)
    .slice(0, Math.max(0, limit))
    .map((summary) => ({
      ...summary,
      delta: deltaByRunId.get(summary.id) ?? null,
    }));
}

export function getTrendPoints(
  payload: BenchResultSummaryPayload,
  benchmark: string,
  range: TrendRange,
): TrendPoint[] {
  const anchor = Date.now();
  const runs = payload.summaries
    .filter((summary) => summary.primaryScore !== null)
    .filter((summary) => benchmark === "all" || summary.benchmark === benchmark)
    .filter((summary) => withinRange(summary.timestamp, range, anchor))
    .slice()
    .sort((left, right) => left.timestamp.localeCompare(right.timestamp));

  return runs.map((summary) => ({
    runId: summary.id,
    benchmark: summary.benchmark,
    label: formatTimestamp(summary.timestamp),
    timestamp: summary.timestamp,
    score: summary.primaryScore ?? 0,
  }));
}

export function filterRuns(
  payload: BenchResultSummaryPayload,
  filters: RunFilters,
): BenchResultSummary[] {
  const anchor = Date.now();

  return payload.summaries.filter((summary) => {
    if (filters.benchmark !== "all" && summary.benchmark !== filters.benchmark) {
      return false;
    }
    if (
      filters.systemProvider !== "all" &&
      summary.systemProvider !== filters.systemProvider
    ) {
      return false;
    }
    if (filters.judgeProvider !== "all" && summary.judgeProvider !== filters.judgeProvider) {
      return false;
    }
    if (filters.mode !== "all" && summary.mode !== filters.mode) {
      return false;
    }
    if (!withinRange(summary.timestamp, filters.range, anchor)) {
      return false;
    }

    return true;
  });
}

function metricValue(summary: BenchResultSummary, name: string): BenchAggregateMetric | undefined {
  return summary.aggregateMetrics.find((metric) => metric.name === name);
}

export function buildCompareModel(
  payload: BenchResultSummaryPayload,
  baselineId: string,
  candidateId: string,
): CompareModel | null {
  const baseline = payload.summaries.find((summary) => summary.id === baselineId);
  const candidate = payload.summaries.find((summary) => summary.id === candidateId);

  if (!baseline || !candidate) {
    return null;
  }

  const metricNames = Array.from(
    new Set([
      ...baseline.aggregateMetrics.map((metric) => metric.name),
      ...candidate.aggregateMetrics.map((metric) => metric.name),
    ]),
  ).sort(compareMetricNames);

  const metricRows = metricNames.map((name) => {
    const left = metricValue(baseline, name);
    const right = metricValue(candidate, name);
    const baselineValue = left?.mean ?? null;
    const candidateValue = right?.mean ?? null;
    const delta =
      baselineValue !== null && candidateValue !== null ? candidateValue - baselineValue : null;

    return {
      name,
      baseline: baselineValue,
      candidate: candidateValue,
      delta,
      percentChange:
        delta !== null && baselineValue !== null && baselineValue !== 0
          ? (delta / baselineValue) * 100
          : null,
      ciLower: right?.ciLower ?? null,
      ciUpper: right?.ciUpper ?? null,
      effectSize: right?.effectSize ?? null,
      effectInterpretation: right?.effectInterpretation ?? null,
    };
  });

  const baselineTasks = new Map(baseline.taskSummaries.map((task) => [task.taskId, task]));
  const candidateTasks = new Map(candidate.taskSummaries.map((task) => [task.taskId, task]));
  const taskIds = Array.from(new Set([...baselineTasks.keys(), ...candidateTasks.keys()])).sort(
    compareStrings,
  );

  const taskRows = taskIds
    .map((taskId) => {
      const left = baselineTasks.get(taskId) ?? null;
      const right = candidateTasks.get(taskId) ?? null;
      const baselineValue = left?.primaryScore ?? null;
      const candidateValue = right?.primaryScore ?? null;

      return {
        taskId,
        baseline: baselineValue,
        candidate: candidateValue,
        delta:
          baselineValue !== null && candidateValue !== null
            ? candidateValue - baselineValue
            : null,
        question: right?.question || left?.question || "Task prompt unavailable",
        latencyMs: right?.latencyMs ?? left?.latencyMs ?? null,
      };
    })
    .sort((left, right) => {
      const leftMagnitude = left.delta === null ? -1 : Math.abs(left.delta);
      const rightMagnitude = right.delta === null ? -1 : Math.abs(right.delta);
      if (leftMagnitude === rightMagnitude) {
        return compareStrings(left.taskId, right.taskId);
      }
      return rightMagnitude - leftMagnitude;
    });

  return {
    baseline,
    candidate,
    metricRows,
    taskRows,
  };
}

export function buildHistogram(summary: BenchResultSummary): HistogramBucket[] {
  const buckets = [
    { label: "0-19", count: 0 },
    { label: "20-39", count: 0 },
    { label: "40-59", count: 0 },
    { label: "60-79", count: 0 },
    { label: "80-100", count: 0 },
  ];

  for (const task of summary.taskSummaries) {
    if (task.primaryScore === null) {
      continue;
    }

    const clampedScore = Math.max(0, Math.min(1, task.primaryScore));
    const index =
      clampedScore === 1 ? buckets.length - 1 : Math.floor(clampedScore * buckets.length);
    const bucket = buckets[index];
    if (bucket) {
      bucket.count += 1;
    }
  }

  return buckets;
}

export function buildProviderRows(payload: BenchResultSummaryPayload): ProviderRow[] {
  const grouped = new Map<string, ProviderRow>();
  const benchmarkScoreBuckets = new Map<string, Map<string, number[]>>();

  for (const summary of payload.summaries) {
    let providerBenchmarkScores = benchmarkScoreBuckets.get(summary.providerKey);
    if (!providerBenchmarkScores) {
      providerBenchmarkScores = new Map();
      benchmarkScoreBuckets.set(summary.providerKey, providerBenchmarkScores);
    }
    let benchmarkScores = providerBenchmarkScores.get(summary.benchmark);
    if (!benchmarkScores) {
      benchmarkScores = [];
      providerBenchmarkScores.set(summary.benchmark, benchmarkScores);
    }
    if (summary.primaryScore !== null) {
      benchmarkScores.push(summary.primaryScore);
    }

    const existing = grouped.get(summary.providerKey);
    if (existing) {
      existing.runCount += 1;
      if (!existing.benchmarks.includes(summary.benchmark)) {
        existing.benchmarks.push(summary.benchmark);
        existing.benchmarks.sort(compareStrings);
      }
      continue;
    }

    grouped.set(summary.providerKey, {
      providerKey: summary.providerKey,
      systemProvider: summary.systemProvider,
      judgeProvider: summary.judgeProvider,
      runCount: 1,
      benchmarks: [summary.benchmark],
      averageScore: summary.primaryScore,
      averageCostUsd: summary.estimatedCostUsd,
      benchmarkScores: {},
    });
  }

  return Array.from(grouped.values())
    .map((row) => {
      const scoreValues = payload.summaries
        .filter((summary) => summary.providerKey === row.providerKey)
        .map((summary) => summary.primaryScore)
        .filter((value): value is number => value !== null);
      const costValues = payload.summaries
        .filter((summary) => summary.providerKey === row.providerKey)
        .map((summary) => summary.estimatedCostUsd)
        .filter((value): value is number => value !== null);
      const perBenchmarkScores: Record<string, number | null> = {};
      const providerBenchmarkScores =
        benchmarkScoreBuckets.get(row.providerKey) ?? new Map<string, number[]>();
      for (const benchmark of row.benchmarks) {
        const values = providerBenchmarkScores.get(benchmark) ?? [];
        perBenchmarkScores[benchmark] =
          values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
      }

      return {
        ...row,
        averageScore:
          scoreValues.length > 0
            ? scoreValues.reduce((sum, value) => sum + value, 0) / scoreValues.length
            : null,
        averageCostUsd:
          costValues.length > 0
            ? costValues.reduce((sum, value) => sum + value, 0) / costValues.length
            : null,
        benchmarkScores: perBenchmarkScores,
      };
    })
    .sort((left, right) => compareStrings(left.providerKey, right.providerKey));
}

export function pickDefaultCompareIds(payload: BenchResultSummaryPayload): {
  baselineId: string | null;
  candidateId: string | null;
} {
  const sorted = payload.summaries.slice().sort(compareTimestampedRuns);
  const byBenchmark = new Map<string, BenchResultSummary[]>();
  for (const summary of sorted) {
    const runs = byBenchmark.get(summary.benchmark) ?? [];
    runs.push(summary);
    byBenchmark.set(summary.benchmark, runs);
  }

  for (const summary of sorted) {
    const runs = byBenchmark.get(summary.benchmark) ?? [];
    if (runs.length >= 2) {
      return {
        candidateId: runs[0]!.id,
        baselineId: runs[1]!.id,
      };
    }
  }

  return {
    candidateId: sorted[0]?.id ?? null,
    baselineId: null,
  };
}

export function benchmarkRuns(
  payload: BenchResultSummaryPayload,
  benchmark: string,
): BenchResultSummary[] {
  return payload.summaries
    .filter((summary) => summary.benchmark === benchmark)
    .slice()
    .sort(compareTimestampedRuns);
}

export const ASSISTANT_BENCHMARK_IDS = [
  "assistant-morning-brief",
  "assistant-meeting-prep",
  "assistant-next-best-action",
  "assistant-synthesis",
] as const;

export type AssistantBenchmarkId = (typeof ASSISTANT_BENCHMARK_IDS)[number];

export const ASSISTANT_RUBRIC_DIMENSION_KEYS = [
  "identity_accuracy",
  "stance_coherence",
  "novelty",
  "calibration",
  "overall",
] as const;

export type AssistantRubricDimensionKey =
  (typeof ASSISTANT_RUBRIC_DIMENSION_KEYS)[number];

export interface AssistantDimensionBar {
  dimension: AssistantRubricDimensionKey;
  label: string;
  mean: number | null;
  ciLower: number | null;
  ciUpper: number | null;
}

export function isAssistantBenchmark(benchmark: string): boolean {
  return (ASSISTANT_BENCHMARK_IDS as readonly string[]).includes(benchmark);
}

export function getAssistantRuns(
  payload: BenchResultSummaryPayload,
): BenchResultSummary[] {
  return payload.summaries
    .filter((summary) => isAssistantBenchmark(summary.benchmark))
    .slice()
    .sort(compareTimestampedRuns);
}

export function getLatestAssistantRunByBenchmark(
  payload: BenchResultSummaryPayload,
): Record<string, BenchResultSummary | null> {
  const latest: Record<string, BenchResultSummary | null> = {};
  for (const id of ASSISTANT_BENCHMARK_IDS) {
    latest[id] = null;
  }
  for (const run of getAssistantRuns(payload)) {
    if (!latest[run.benchmark]) {
      latest[run.benchmark] = run;
    }
  }
  return latest;
}

export function dimensionLabel(
  dimension: AssistantRubricDimensionKey,
): string {
  switch (dimension) {
    case "identity_accuracy":
      return "Identity accuracy";
    case "stance_coherence":
      return "Stance coherence";
    case "novelty":
      return "Novelty";
    case "calibration":
      return "Calibration";
    case "overall":
      return "Overall";
  }
}

export function getAssistantDimensionBars(
  summary: BenchResultSummary | null,
): AssistantDimensionBar[] {
  if (!summary) {
    return ASSISTANT_RUBRIC_DIMENSION_KEYS.map((dimension) => ({
      dimension,
      label: dimensionLabel(dimension),
      mean: null,
      ciLower: null,
      ciUpper: null,
    }));
  }
  const lookup = new Map(
    summary.aggregateMetrics.map((metric) => [metric.name, metric]),
  );
  return ASSISTANT_RUBRIC_DIMENSION_KEYS.map((dimension) => {
    const metric = lookup.get(dimension);
    return {
      dimension,
      label: dimensionLabel(dimension),
      mean: metric?.mean ?? null,
      ciLower: metric?.ciLower ?? null,
      ciUpper: metric?.ciUpper ?? null,
    };
  });
}

export function flattenAssistantSpotChecks(
  summary: BenchResultSummary | null,
): Array<{
  taskId: string;
  seed: number;
  identityAccuracy: number | null;
  stanceCoherence: number | null;
  novelty: number | null;
  calibration: number | null;
  parseOk: boolean;
  notes: string;
  focus: string | null;
}> {
  if (!summary) return [];
  const rows: Array<{
    taskId: string;
    seed: number;
    identityAccuracy: number | null;
    stanceCoherence: number | null;
    novelty: number | null;
    calibration: number | null;
    parseOk: boolean;
    notes: string;
    focus: string | null;
  }> = [];
  for (const task of summary.taskSummaries) {
    const details = task.assistantDetails;
    if (!details) continue;
    for (const seed of details.perSeedScores) {
      rows.push({
        taskId: task.taskId,
        seed: seed.seed,
        identityAccuracy: seed.identityAccuracy,
        stanceCoherence: seed.stanceCoherence,
        novelty: seed.novelty,
        calibration: seed.calibration,
        parseOk: seed.parseOk,
        notes: seed.notes,
        focus: details.focus,
      });
    }
  }
  return rows;
}
