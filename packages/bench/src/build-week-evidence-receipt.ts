import { createHash } from "node:crypto";
import { lstat, open, realpath, readFile, stat, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import {
  computeBenchmarkReproDatasetInventoryHash,
  computeBenchmarkReproManifestArtifactHash,
  type BenchmarkReproManifest,
} from "./repro-manifest.js";
import { parseBenchmarkArtifact } from "./published-artifact.js";
import { aggregateTaskScores } from "./scorer.js";
import type { BenchmarkResult, ProviderConfig } from "./types.js";

export const BUILD_WEEK_EVIDENCE_RECEIPT_SCHEMA_VERSION = 1 as const;

/**
 * Pinned identity of the deterministic, generated MemCorrect v1 full corpus.
 * Keep the payload hash literal: a generator drift must require a deliberate
 * review here rather than silently redefining already-published evidence.
 */
export const BUILD_WEEK_MEMCORRECT_DATASET_VERSION = "memcorrect-v1-c077e7" as const;
export const BUILD_WEEK_MEMCORRECT_PAYLOAD_SHA256 =
  "ebbb5889561188354171d3f1323b1284e6c6dc36e40d5fd5cf718ec722401acb" as const;
export const BUILD_WEEK_MEMCORRECT_FULL_TASK_COUNT = 40 as const;
export const BUILD_WEEK_LONGMEMEVAL_DATASET_VERSION = "longmemeval-oracle" as const;
export const BUILD_WEEK_LONGMEMEVAL_PAYLOAD_SHA256 =
  "821a2034d219ab45846873dd14c14f12cfe7776e73527a483f9dac095d38620c" as const;
export const BUILD_WEEK_LONGMEMEVAL_FULL_TASK_COUNT = 500 as const;
export const BUILD_WEEK_LONGMEMEVAL_TASK_ID_SET_SHA256 =
  "f448abc019682167d03901d423bb0365e6ff6b6ec8342420c80ce5e0f1fb9591" as const;

export const BUILD_WEEK_LIMITATIONS = {
  boundedSubset: "This result covers a bounded subset, not the benchmark's complete dataset.",
  singleRun: "This receipt reports one run and does not establish run-to-run variance.",
  estimatedAccounting:
    "Token, call, USD, and local budget-unit totals are estimates from local benchmark instrumentation, not account billing records.",
  modelJudged: "Model-judged metrics can vary with evaluator model and rubric changes.",
} as const;

export type BuildWeekLimitationCode = keyof typeof BUILD_WEEK_LIMITATIONS;

export interface BuildWeekEvidenceReceiptProvider {
  role: "system" | "internal" | "judge";
  provider: string;
  model: string;
  reasoningEffort: string | null;
  serviceTier: string | null;
}

export interface BuildWeekEvidenceReceipt {
  schemaVersion: typeof BUILD_WEEK_EVIDENCE_RECEIPT_SCHEMA_VERSION;
  benchmark: {
    id: string;
    version: string;
    mode: "full" | "quick";
    status: "complete";
    taskCount: number;
    failureCount: number;
    aggregates: Record<string, { mean: number; median: number; stdDev: number; min: number; max: number }>;
  };
  provenance: {
    resultId: string;
    remnicVersion: string;
    gitSha: string;
    runtimeProfile: string | null;
    adapterMode: string;
    providers: BuildWeekEvidenceReceiptProvider[];
  };
  dataset: {
    source: "file-manifest" | "generated-corpus";
    version: string;
    payloadSha256: string;
    manifestSha256: string;
    fileCount: number;
    totalBytes: number;
  };
  integrity: {
    resultSha256: string;
    manifestSha256: string;
    manifestArtifactHash: string;
    publicArtifactSha256: string | null;
  };
  estimatedUsage: {
    label: "local estimates; not account billing";
    calls: number;
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    reasoningOutputTokens: number;
    totalTokens: number;
    localBudgetUnits: number;
    estimatedCostUsd: number;
  };
  assertions: {
    noSolModels: true;
    freshIsolatedStore: true;
    freshIsolatedStoreStatement: "The benchmark used a fresh isolated Remnic store, separate from production data.";
    containsNoPerTaskContent: true;
    containsNoPrivateLedgerOrAccountBalance: true;
  };
  limitations: string[];
}

export interface BuildBuildWeekEvidenceReceiptOptions {
  resultJson: string | Buffer;
  manifestJson: string | Buffer;
  publicArtifactJson?: string | Buffer;
  datasetVersion: string;
  limitationCodes: readonly BuildWeekLimitationCode[];
  freshIsolatedStoreConfirmed: true;
  publicationScope:
    | { kind: "full"; expectedTaskCount: number }
    | { kind: "bounded-subset"; expectedTaskCount: number };
}

const SHA256 = /^[0-9a-f]{64}$/;
const GIT_SHA = /^[0-9a-f]{7,64}$/i;
const SAFE_DATASET_VERSION = /^[A-Za-z0-9][A-Za-z0-9._+@/-]{0,127}$/;
const SAFE_PUBLIC_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._+@:-]{0,255}$/;
const SOL_MODEL = /^gpt-5\.6-sol$/i;
const SUPPORTED_REASONING_EFFORTS = new Set(["low", "medium", "high", "xhigh"]);
const MEMCORRECT_BENCHMARK_ID = "memcorrect-v1";
const MEMCORRECT_BENCHMARK_VERSION = "1.0.0";
const LONGMEMEVAL_BENCHMARK_ID = "longmemeval";
const LONGMEMEVAL_BENCHMARK_VERSION = "2.0.0";
const LONGMEMEVAL_FULL_METRICS = Object.freeze([
  "contains_answer",
  "f1",
  "judge_accuracy",
  "llm_judge",
  "search_hits",
]);
const MEMCORRECT_REQUIRED_TASK_METRICS = Object.freeze([
  "false_apply",
  "judge_correction_acceptance",
  "judge_stale_harm_avoidance",
  "non_resurrection",
  "uptake_at_next",
  "uptake_latency",
  "uptake_latency_censored",
]);
const MEMCORRECT_FULL_METRICS = Object.freeze([
  ...MEMCORRECT_REQUIRED_TASK_METRICS,
  "reassertion",
  "scope_precision",
].sort());
const MEMCORRECT_FULL_SEED = 0xc077e7;
const MEMCORRECT_SCOPED_TASK_IDS = new Set(
  Array.from({ length: BUILD_WEEK_MEMCORRECT_FULL_TASK_COUNT / 4 }, (_, index) =>
    `memcorrect-${MEMCORRECT_FULL_SEED}-${(index * 4 + 2).toString(16)}`),
);
const MEMCORRECT_REASSERTION_TASK_IDS = new Set(
  Array.from({ length: BUILD_WEEK_MEMCORRECT_FULL_TASK_COUNT / 4 }, (_, index) =>
    `memcorrect-${MEMCORRECT_FULL_SEED}-${(index * 4 + 3).toString(16)}`),
);
const MEMCORRECT_GENERATOR_OPTIONS = Object.freeze({
  personaCount: 5,
  factsPerPersona: 8,
  seed: MEMCORRECT_FULL_SEED,
  nowIso: "2026-07-05T00:00:00.000Z",
  maintenanceCycles: 5,
  uptakeLatencyCap: 8,
});
const SINGLE_FILE_PAYLOAD_FALLBACKS: Readonly<Record<string, string>> = Object.freeze({
  longmemeval: "longmemeval_oracle.json",
});

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function parseJsonObject<T>(source: string | Buffer, label: string): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source.toString());
  } catch (error) {
    throw new Error(`${label} must be valid JSON`, { cause: error });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} must contain a JSON object`);
  }
  return parsed as T;
}

function requireSafeString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) {
    throw new Error(`${label} must be a non-empty string no longer than 256 characters`);
  }
  if (/[/\\](?:home|Users|tmp|private|var)[/\\]/i.test(value) || /^[A-Za-z]:[\\/]/.test(value)) {
    throw new Error(`${label} must not contain an absolute private path`);
  }
  if (/(?:sk-[A-Za-z0-9_-]{8,}|bearer\s+[A-Za-z0-9._-]{8,}|api[_-]?key|account\s*balance|ledger\s*path)/i.test(value)) {
    throw new Error(`${label} contains secret or private-account material`);
  }
  return value;
}

function requireSafeIdentifier(value: unknown, label: string): string {
  const safe = requireSafeString(value, label);
  if (!SAFE_PUBLIC_IDENTIFIER.test(safe)) {
    throw new Error(`${label} must be a compact public identifier without whitespace or prose`);
  }
  return safe;
}

function requireFinite(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number`);
  }
  return value;
}

function requireFiniteNonNegative(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a finite non-negative number`);
  }
  return value;
}

function requireNonNegativeInteger(value: unknown, label: string): number {
  const finite = requireFiniteNonNegative(value, label);
  if (!Number.isInteger(finite)) {
    throw new Error(`${label} must be an integer`);
  }
  return finite;
}

function requireCompatibleGitIdentity(left: unknown, right: unknown, label: string): void {
  if (typeof left !== "string" || typeof right !== "string" || !GIT_SHA.test(left) || !GIT_SHA.test(right)) {
    throw new Error(`${label} must contain valid Git commit identifiers`);
  }
  if (left !== right && !left.startsWith(right) && !right.startsWith(left)) {
    throw new Error(`${label} does not identify the same Git commit`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requireExactMemCorrectProvenance(
  result: BenchmarkResult,
  manifest: BenchmarkReproManifest,
  datasetVersion: string,
  publicationScope: BuildBuildWeekEvidenceReceiptOptions["publicationScope"],
): {
  source: "generated-corpus";
  payloadSha256: string;
  manifestSha256: string;
  fileCount: 0;
  totalBytes: 0;
} {
  if (publicationScope.kind !== "full" || publicationScope.expectedTaskCount !== BUILD_WEEK_MEMCORRECT_FULL_TASK_COUNT) {
    throw new Error(`MemCorrect v1 receipts require full coverage of exactly ${BUILD_WEEK_MEMCORRECT_FULL_TASK_COUNT} tasks`);
  }
  if (datasetVersion !== BUILD_WEEK_MEMCORRECT_DATASET_VERSION) {
    throw new Error(`MemCorrect v1 datasetVersion must be ${BUILD_WEEK_MEMCORRECT_DATASET_VERSION}`);
  }
  if (result.meta.version !== MEMCORRECT_BENCHMARK_VERSION) {
    throw new Error(`MemCorrect benchmark version must be ${MEMCORRECT_BENCHMARK_VERSION}`);
  }
  if (result.meta.datasetHash !== BUILD_WEEK_MEMCORRECT_PAYLOAD_SHA256) {
    throw new Error("MemCorrect result datasetHash does not match the pinned full-corpus payload hash");
  }
  const taskIdsMatchPinnedCorpus = result.results.tasks.every(
    (task, index) => task.taskId === `memcorrect-${MEMCORRECT_FULL_SEED}-${index.toString(16)}`,
  );
  if (!taskIdsMatchPinnedCorpus) {
    throw new Error("MemCorrect result task identities do not match the pinned full corpus");
  }
  if (
    result.meta.seeds.length !== 1 ||
    result.meta.seeds[0] !== MEMCORRECT_FULL_SEED ||
    (manifest.run.seed !== undefined && manifest.run.seed !== MEMCORRECT_FULL_SEED)
  ) {
    throw new Error(`MemCorrect provenance must use the pinned seed ${MEMCORRECT_FULL_SEED}`);
  }

  const benchmarkOptions = result.config.benchmarkOptions;
  if (!isRecord(benchmarkOptions)) {
    throw new Error("MemCorrect result must persist full-corpus generator options");
  }
  for (const key of ["personaCount", "factsPerPersona", "nowIso", "maintenanceCycles", "uptakeLatencyCap"] as const) {
    if (benchmarkOptions[key] !== MEMCORRECT_GENERATOR_OPTIONS[key]) {
      throw new Error(`MemCorrect generator option ${key} does not match the pinned full corpus`);
    }
  }
  if (result.config.adapterMode !== "remnic-native") {
    throw new Error("MemCorrect Build Week receipts require adapterMode remnic-native");
  }
  if (result.cost.judgeModelCalls !== BUILD_WEEK_MEMCORRECT_FULL_TASK_COUNT * 2) {
    throw new Error("MemCorrect full evidence requires exactly two specialized judge calls per task");
  }
  const judgeTelemetry = benchmarkOptions["judgeTelemetry"];
  if (!isRecord(judgeTelemetry) || judgeTelemetry["calls"] !== BUILD_WEEK_MEMCORRECT_FULL_TASK_COUNT * 2) {
    throw new Error("MemCorrect result must persist exact specialized-judge telemetry");
  }
  if (!manifest.run.selectedBenchmarks.includes(MEMCORRECT_BENCHMARK_ID)) {
    throw new Error("manifest run does not select memcorrect-v1");
  }
  const resultEntry = manifest.results.find((entry) => entry.resultId === result.meta.id);
  if (
    !resultEntry ||
    resultEntry.seeds.length !== 1 ||
    resultEntry.seeds[0] !== MEMCORRECT_FULL_SEED
  ) {
    throw new Error("manifest result entry does not bind the pinned MemCorrect seed");
  }

  const datasets = manifest.datasets.filter((entry) => entry.benchmark === MEMCORRECT_BENCHMARK_ID);
  if (datasets.length !== 1) {
    throw new Error("manifest must contain exactly one MemCorrect generated-corpus dataset entry");
  }
  const dataset = datasets[0]!;
  if (
    dataset.status !== "not-provided" ||
    dataset.path !== undefined ||
    dataset.realpath !== undefined ||
    dataset.sha256 !== undefined ||
    dataset.fileCount !== 0 ||
    dataset.totalBytes !== 0 ||
    dataset.files.length !== 0
  ) {
    throw new Error("MemCorrect manifest dataset entry must identify the generated corpus without file-backed provenance");
  }

  const generatedProvenance = {
    kind: "generated-corpus",
    benchmark: MEMCORRECT_BENCHMARK_ID,
    benchmarkVersion: MEMCORRECT_BENCHMARK_VERSION,
    datasetVersion: BUILD_WEEK_MEMCORRECT_DATASET_VERSION,
    payloadSha256: BUILD_WEEK_MEMCORRECT_PAYLOAD_SHA256,
    taskCount: BUILD_WEEK_MEMCORRECT_FULL_TASK_COUNT,
    generator: MEMCORRECT_GENERATOR_OPTIONS,
  };
  return {
    source: "generated-corpus",
    payloadSha256: BUILD_WEEK_MEMCORRECT_PAYLOAD_SHA256,
    manifestSha256: sha256(JSON.stringify(generatedProvenance)),
    fileCount: 0,
    totalBytes: 0,
  };
}

function requireFileBackedDatasetProvenance(
  result: BenchmarkResult,
  manifest: BenchmarkReproManifest,
): {
  source: "file-manifest";
  payloadSha256: string;
  manifestSha256: string;
  fileCount: number;
  totalBytes: number;
} {
  const matchingDatasets = manifest.datasets.filter((entry) => entry.benchmark === result.meta.benchmark);
  if (matchingDatasets.length !== 1) {
    throw new Error("manifest must contain exactly one dataset entry for the benchmark");
  }
  const dataset = matchingDatasets[0]!;
  if (dataset.status !== "hashed" || !dataset.sha256 || !SHA256.test(dataset.sha256)) {
    throw new Error("manifest must contain a hashed dataset entry for the benchmark");
  }
  const fileCount = requireFiniteNonNegative(dataset.fileCount, "dataset fileCount");
  const totalBytes = requireFiniteNonNegative(dataset.totalBytes, "dataset totalBytes");
  if (!Number.isInteger(fileCount) || fileCount !== dataset.files.length) {
    throw new Error("dataset fileCount must equal the manifest file inventory length");
  }
  const inventoryBytes = dataset.files.reduce((sum, file) => {
    requireSafeString(file.path, "dataset file path");
    requireFiniteNonNegative(file.sizeBytes, "dataset file sizeBytes");
    if (!SHA256.test(file.sha256)) throw new Error("dataset file sha256 must be a SHA-256 digest");
    return sum + file.sizeBytes;
  }, 0);
  if (inventoryBytes !== totalBytes) {
    throw new Error("dataset totalBytes must equal the manifest file inventory total");
  }
  if (computeBenchmarkReproDatasetInventoryHash(dataset.files) !== dataset.sha256) {
    throw new Error("dataset inventory hash does not match the manifest files");
  }

  let payloadSha256 = result.meta.datasetHash;
  if (payloadSha256 !== undefined) {
    if (!SHA256.test(payloadSha256)) {
      throw new Error("benchmark result datasetHash must be a SHA-256 digest when present");
    }
  } else {
    const canonicalFile = SINGLE_FILE_PAYLOAD_FALLBACKS[result.meta.benchmark];
    const file = dataset.files[0];
    if (
      canonicalFile === undefined ||
      dataset.fileCount !== 1 ||
      file === undefined ||
      file.kind !== "file" ||
      file.path !== canonicalFile ||
      file.target !== undefined ||
      file.sizeBytes !== totalBytes
    ) {
      throw new Error(
        "benchmark result without datasetHash requires one canonical regular dataset payload file",
      );
    }
    payloadSha256 = file.sha256;
  }

  const canonicalFile = SINGLE_FILE_PAYLOAD_FALLBACKS[result.meta.benchmark];
  if (
    canonicalFile !== undefined &&
    dataset.files.length === 1 &&
    dataset.files[0]?.kind === "file" &&
    dataset.files[0]?.path === canonicalFile &&
    payloadSha256 !== dataset.files[0].sha256
  ) {
    throw new Error("benchmark result datasetHash does not match the canonical dataset payload file");
  }

  return {
    source: "file-manifest",
    payloadSha256,
    manifestSha256: dataset.sha256,
    fileCount,
    totalBytes,
  };
}

function requirePinnedFullFileBackedCorpus(
  result: BenchmarkResult,
  manifest: BenchmarkReproManifest,
  datasetVersion: string,
  publicationScope: BuildBuildWeekEvidenceReceiptOptions["publicationScope"],
  datasetReceipt: ReturnType<typeof requireFileBackedDatasetProvenance>,
): void {
  if (publicationScope.kind !== "full") return;
  if (result.meta.benchmark !== LONGMEMEVAL_BENCHMARK_ID) {
    throw new Error(`full publication is not pinned for file-backed benchmark ${result.meta.benchmark}`);
  }
  if (result.meta.version !== LONGMEMEVAL_BENCHMARK_VERSION) {
    throw new Error(`LongMemEval benchmark version must be ${LONGMEMEVAL_BENCHMARK_VERSION}`);
  }
  if (datasetVersion !== BUILD_WEEK_LONGMEMEVAL_DATASET_VERSION) {
    throw new Error(`LongMemEval datasetVersion must be ${BUILD_WEEK_LONGMEMEVAL_DATASET_VERSION}`);
  }
  if (publicationScope.expectedTaskCount !== BUILD_WEEK_LONGMEMEVAL_FULL_TASK_COUNT) {
    throw new Error(`LongMemEval full receipts require exactly ${BUILD_WEEK_LONGMEMEVAL_FULL_TASK_COUNT} tasks`);
  }
  if (datasetReceipt.payloadSha256 !== BUILD_WEEK_LONGMEMEVAL_PAYLOAD_SHA256) {
    throw new Error("LongMemEval payload hash does not match the pinned full corpus");
  }
  const taskIds = result.results.tasks.map((task, index) =>
    requireSafeIdentifier(task.taskId, `LongMemEval task ${index} id`),
  );
  if (new Set(taskIds).size !== BUILD_WEEK_LONGMEMEVAL_FULL_TASK_COUNT) {
    throw new Error("LongMemEval full receipts require 500 unique task identities");
  }
  const taskIdSetHash = sha256(JSON.stringify([...taskIds].sort()));
  if (taskIdSetHash !== BUILD_WEEK_LONGMEMEVAL_TASK_ID_SET_SHA256) {
    throw new Error("LongMemEval task identities do not match the pinned full corpus");
  }
  const dataset = manifest.datasets.find((entry) => entry.benchmark === LONGMEMEVAL_BENCHMARK_ID);
  const file = dataset?.files[0];
  if (
    dataset?.fileCount !== 1 ||
    dataset.files.length !== 1 ||
    file?.kind !== "file" ||
    file.path !== SINGLE_FILE_PAYLOAD_FALLBACKS[LONGMEMEVAL_BENCHMARK_ID] ||
    file.target !== undefined ||
    file.sha256 !== BUILD_WEEK_LONGMEMEVAL_PAYLOAD_SHA256 ||
    file.sizeBytes !== dataset.totalBytes
  ) {
    throw new Error("LongMemEval full receipts require the pinned canonical dataset file inventory");
  }
}

function providerReceipt(
  role: BuildWeekEvidenceReceiptProvider["role"],
  provider: ProviderConfig | null | undefined,
): BuildWeekEvidenceReceiptProvider | undefined {
  if (!provider) return undefined;
  const providerName = requireSafeIdentifier(provider.provider, `${role} provider`);
  const model = requireSafeIdentifier(provider.model, `${role} model`);
  const reasoningEffort = provider.reasoningEffort;
  if (reasoningEffort !== undefined && !SUPPORTED_REASONING_EFFORTS.has(reasoningEffort)) {
    throw new Error(`${role} reasoningEffort must be one of low, medium, high, or xhigh`);
  }
  return {
    role,
    provider: providerName,
    model,
    reasoningEffort: reasoningEffort ?? null,
    // BenchmarkResult does not persist transport service-tier diagnostics.
    // Keep the public receipt honest instead of inferring a tier from provider type.
    serviceTier: null,
  };
}

function sortedAggregates(
  result: BenchmarkResult,
  allowSparseTaskMetrics: boolean,
): BuildWeekEvidenceReceipt["benchmark"]["aggregates"] {
  for (const [taskIndex, task] of result.results.tasks.entries()) {
    for (const [metric, score] of Object.entries(task.scores)) {
      requireSafeIdentifier(metric, `task ${taskIndex} score metric name`);
      requireFinite(score, `task ${taskIndex} score ${metric}`);
    }
  }
  const recomputed = aggregateTaskScores(result.results.tasks.map((task) => task.scores));
  const recordedNames = Object.keys(result.results.aggregates).sort();
  const recomputedNames = Object.keys(recomputed).sort();
  if (
    recordedNames.length !== recomputedNames.length ||
    recordedNames.some((name, index) => name !== recomputedNames[index])
  ) {
    throw new Error("benchmark aggregate metric names do not match the task score metrics");
  }
  if (!allowSparseTaskMetrics) {
    for (const [taskIndex, task] of result.results.tasks.entries()) {
      const taskMetricNames = Object.keys(task.scores).sort();
      if (
        taskMetricNames.length !== recordedNames.length ||
        taskMetricNames.some((name, index) => name !== recordedNames[index])
      ) {
        throw new Error(`benchmark task ${taskIndex} metric names do not match the complete aggregate metric set`);
      }
    }
  }
  const output: BuildWeekEvidenceReceipt["benchmark"]["aggregates"] = {};
  for (const metric of recomputedNames) {
    const recorded = result.results.aggregates[metric]!;
    const expected = recomputed[metric]!;
    const safeMetric = requireSafeIdentifier(metric, "aggregate metric name");
    for (const field of ["mean", "median", "stdDev", "min", "max"] as const) {
      const observed = field === "stdDev"
        ? requireFiniteNonNegative(recorded[field], `${metric}.${field}`)
        : requireFinite(recorded[field], `${metric}.${field}`);
      const tolerance = Number.EPSILON * Math.max(1, Math.abs(expected[field])) * 16;
      if (Math.abs(observed - expected[field]) > tolerance) {
        throw new Error(`benchmark aggregate ${metric}.${field} does not match task scores`);
      }
    }
    output[safeMetric] = expected;
  }
  return output;
}

function requirePinnedFullMetricSchema(
  result: BenchmarkResult,
  publicationScope: BuildBuildWeekEvidenceReceiptOptions["publicationScope"],
  aggregates: BuildWeekEvidenceReceipt["benchmark"]["aggregates"],
): void {
  if (publicationScope.kind !== "full") return;
  const expected = result.meta.benchmark === LONGMEMEVAL_BENCHMARK_ID
    ? LONGMEMEVAL_FULL_METRICS
    : result.meta.benchmark === MEMCORRECT_BENCHMARK_ID
      ? MEMCORRECT_FULL_METRICS
      : undefined;
  if (!expected) throw new Error(`full metric schema is not pinned for benchmark ${result.meta.benchmark}`);
  const aggregateNames = Object.keys(aggregates).sort();
  if (
    aggregateNames.length !== expected.length ||
    aggregateNames.some((name, index) => name !== expected[index])
  ) {
    throw new Error(`full ${result.meta.benchmark} metric schema does not match the pinned benchmark metrics`);
  }
  if (result.meta.benchmark === MEMCORRECT_BENCHMARK_ID) {
    const allowed = new Set(MEMCORRECT_FULL_METRICS);
    for (const [taskIndex, task] of result.results.tasks.entries()) {
      const names = Object.keys(task.scores);
      const hasScopePrecision = names.includes("scope_precision");
      const hasReassertion = names.includes("reassertion");
      if (
        MEMCORRECT_REQUIRED_TASK_METRICS.some((name) => !names.includes(name)) ||
        names.some((name) => !allowed.has(name)) ||
        hasScopePrecision !== MEMCORRECT_SCOPED_TASK_IDS.has(task.taskId) ||
        hasReassertion !== MEMCORRECT_REASSERTION_TASK_IDS.has(task.taskId)
      ) {
        throw new Error(`MemCorrect task ${taskIndex} metric schema does not match the pinned benchmark metrics`);
      }
    }
  }
}

function verifyPublicArtifact(
  result: BenchmarkResult,
  datasetVersion: string,
  publicationScope: BuildBuildWeekEvidenceReceiptOptions["publicationScope"],
  publicArtifactJson: string | Buffer | undefined,
  aggregates: BuildWeekEvidenceReceipt["benchmark"]["aggregates"],
): string | null {
  const required =
    publicationScope.kind === "full" && result.meta.benchmark === LONGMEMEVAL_BENCHMARK_ID;
  if (publicArtifactJson === undefined) {
    if (required) throw new Error("full LongMemEval receipts require the published public artifact");
    return null;
  }
  const raw = publicArtifactJson.toString();
  const artifact = parseBenchmarkArtifact(raw);
  if (
    artifact.benchmarkId !== result.meta.benchmark ||
    artifact.datasetVersion !== datasetVersion ||
    artifact.system.version !== result.meta.remnicVersion ||
    artifact.system.gitSha !== result.meta.gitSha
  ) {
    throw new Error("public artifact identity does not match the benchmark result");
  }
  if (
    artifact.model !== result.config.systemProvider?.model ||
    result.meta.seeds.length !== 1 ||
    artifact.seed !== result.meta.seeds[0]
  ) {
    throw new Error("public artifact model or seed does not match the benchmark result");
  }
  const metricNames = Object.keys(aggregates).sort();
  const artifactMetricNames = Object.keys(artifact.metrics).sort();
  if (
    metricNames.length !== artifactMetricNames.length ||
    metricNames.some((name, index) => name !== artifactMetricNames[index])
  ) {
    throw new Error("public artifact metric names do not match the benchmark result");
  }
  for (const metric of metricNames) {
    if (artifact.metrics[metric] !== aggregates[metric]!.mean) {
      throw new Error(`public artifact metric ${metric} does not match the benchmark result`);
    }
  }
  if (artifact.perTaskScores.length !== result.results.tasks.length) {
    throw new Error("public artifact task count does not match the benchmark result");
  }
  for (let index = 0; index < result.results.tasks.length; index += 1) {
    const source = result.results.tasks[index]!;
    const published = artifact.perTaskScores[index]!;
    if (published.taskId !== source.taskId) {
      throw new Error(`public artifact task ${index} identity does not match the benchmark result`);
    }
    const sourceScoreNames = Object.keys(source.scores).sort();
    const publishedScoreNames = Object.keys(published.scores).sort();
    if (
      sourceScoreNames.length !== publishedScoreNames.length ||
      sourceScoreNames.some((name, scoreIndex) => name !== publishedScoreNames[scoreIndex])
    ) {
      throw new Error(`public artifact task ${index} score names do not match the benchmark result`);
    }
    for (const score of sourceScoreNames) {
      if (published.scores[score] !== source.scores[score]) {
        throw new Error(`public artifact task ${index} score ${score} does not match the benchmark result`);
      }
    }
  }
  return sha256(publicArtifactJson);
}

/**
 * Convert private benchmark sources into a deterministic, aggregate-only receipt.
 * The returned object never copies per-task content, command arguments, paths,
 * environment values, ledger hashes, or account-balance reconciliation data.
 */
export function buildBuildWeekEvidenceReceipt(
  options: BuildBuildWeekEvidenceReceiptOptions,
): BuildWeekEvidenceReceipt {
  const result = parseJsonObject<BenchmarkResult>(options.resultJson, "benchmark result");
  const manifest = parseJsonObject<BenchmarkReproManifest>(options.manifestJson, "benchmark manifest");
  const resultSha256 = sha256(options.resultJson);
  const manifestSha256 = sha256(options.manifestJson);

  if (options.freshIsolatedStoreConfirmed !== true) {
    throw new Error("fresh isolated benchmark store confirmation is required");
  }

  if (!SAFE_DATASET_VERSION.test(options.datasetVersion)) {
    throw new Error("datasetVersion must be a safe public identifier without whitespace or private paths");
  }
  if (result.meta?.status !== undefined && result.meta.status !== "complete") {
    throw new Error("benchmark result must use the canonical complete status (omitted or complete)");
  }
  if (result.meta.mode !== "full") {
    throw new Error("Build Week evidence receipts require a full-mode benchmark run");
  }
  if (!Number.isInteger(options.publicationScope.expectedTaskCount) || options.publicationScope.expectedTaskCount <= 0) {
    throw new Error("expectedTaskCount must be a positive integer");
  }
  if (result.results.tasks.length !== options.publicationScope.expectedTaskCount) {
    throw new Error(
      `benchmark task count ${result.results.tasks.length} does not match expected ${options.publicationScope.expectedTaskCount}`,
    );
  }
  if (options.publicationScope.kind === "full" && manifest.run.limit !== undefined) {
    throw new Error("a limited manifest cannot be published as a full benchmark result");
  }
  if (options.publicationScope.kind === "bounded-subset" && manifest.run.limit !== options.publicationScope.expectedTaskCount) {
    throw new Error("bounded-subset receipt requires a matching explicit manifest limit");
  }
  if (manifest.run.mode !== "full") {
    throw new Error("manifest mode must be full");
  }

  const failureCount = result.results.tasks.filter((task) => {
    const details = task.details;
    if (!details) return false;
    const structured = details.benchmarkFailure;
    return Boolean(
      details.error !== undefined ||
      details.failure !== undefined ||
      (isRecord(structured) && structured.kind === "trial_execution_failure"),
    );
  }).length;
  if (failureCount > 0) {
    throw new Error(`complete evidence receipt refused because ${failureCount} task(s) contain failure markers`);
  }
  const allowSparseTaskMetrics =
    options.publicationScope.kind === "full" && result.meta.benchmark === MEMCORRECT_BENCHMARK_ID;
  const validatedAggregates = sortedAggregates(result, allowSparseTaskMetrics);

  const resultEntry = manifest.results.find((entry) => entry.resultId === result.meta.id);
  if (!resultEntry) throw new Error("manifest does not bind the benchmark result id");
  if (resultEntry.sha256 !== resultSha256) throw new Error("manifest result hash does not match the result bytes");
  if (resultEntry.taskCount !== result.results.tasks.length) throw new Error("manifest result task count does not match");
  if (resultEntry.benchmark !== result.meta.benchmark || resultEntry.mode !== result.meta.mode) {
    throw new Error("manifest result identity does not match the benchmark result");
  }
  requireCompatibleGitIdentity(resultEntry.gitSha, result.meta.gitSha, "manifest result and benchmark result Git identity");
  requireCompatibleGitIdentity(manifest.git.commit, result.meta.gitSha, "manifest commit and benchmark result Git identity");
  requireCompatibleGitIdentity(manifest.git.shortCommit, result.meta.gitSha, "manifest short commit and benchmark result Git identity");

  const datasetReceipt = result.meta.benchmark === MEMCORRECT_BENCHMARK_ID
    ? requireExactMemCorrectProvenance(result, manifest, options.datasetVersion, options.publicationScope)
    : (() => {
        const fileBackedReceipt = requireFileBackedDatasetProvenance(result, manifest);
        requirePinnedFullFileBackedCorpus(
          result,
          manifest,
          options.datasetVersion,
          options.publicationScope,
          fileBackedReceipt,
        );
        return fileBackedReceipt;
      })();
  requirePinnedFullMetricSchema(result, options.publicationScope, validatedAggregates);
  if (!SHA256.test(manifest.artifactHash)) throw new Error("manifest artifactHash must be a SHA-256 digest");
  const { artifactHash: _artifactHash, ...manifestWithoutArtifactHash } = manifest;
  if (computeBenchmarkReproManifestArtifactHash(manifestWithoutArtifactHash) !== manifest.artifactHash) {
    throw new Error("manifest artifactHash does not match its canonical integrity payload");
  }

  const providers = [
    providerReceipt("system", result.config.systemProvider),
    providerReceipt("internal", result.config.internalProvider),
    providerReceipt("judge", result.config.judgeProvider),
  ].filter((entry): entry is BuildWeekEvidenceReceiptProvider => entry !== undefined);
  if (providers.length === 0) throw new Error("benchmark result must record at least one provider");
  if (providers.some((provider) => SOL_MODEL.test(provider.model))) {
    throw new Error("gpt-5.6-sol evidence is forbidden by the Build Week budget policy");
  }

  const runUsage = manifest.codexCredit?.run;
  if (!runUsage || runUsage.id !== manifest.run.id) {
    throw new Error("manifest must contain run-scoped Codex CLI usage for this run");
  }
  if (runUsage.models.some((entry) => SOL_MODEL.test(entry.model))) {
    throw new Error("Codex usage receipt contains a forbidden gpt-5.6-sol model");
  }
  const usageModelNames = new Set<string>();
  for (const [index, entry] of runUsage.models.entries()) {
    const model = requireSafeIdentifier(entry.model, `run usage model ${index}`);
    if (usageModelNames.has(model)) {
      throw new Error(`run usage model ${model} must appear exactly once`);
    }
    usageModelNames.add(model);
    for (const field of ["calls", "inputTokens", "cachedInputTokens", "outputTokens", "reasoningOutputTokens"] as const) {
      requireNonNegativeInteger(entry[field], `run usage model ${model} ${field}`);
    }
    requireFiniteNonNegative(entry.budgetUnits, `run usage model ${model} budgetUnits`);
  }
  for (const field of ["calls", "inputTokens", "cachedInputTokens", "outputTokens", "reasoningOutputTokens"] as const) {
    requireNonNegativeInteger(runUsage[field], `run usage ${field}`);
  }
  const modelTotals = runUsage.models.reduce(
    (totals, entry) => ({
      calls: totals.calls + entry.calls,
      inputTokens: totals.inputTokens + entry.inputTokens,
      cachedInputTokens: totals.cachedInputTokens + entry.cachedInputTokens,
      outputTokens: totals.outputTokens + entry.outputTokens,
      reasoningOutputTokens: totals.reasoningOutputTokens + entry.reasoningOutputTokens,
      budgetUnits: totals.budgetUnits + entry.budgetUnits,
    }),
    { calls: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, budgetUnits: 0 },
  );
  for (const key of ["calls", "inputTokens", "cachedInputTokens", "outputTokens", "reasoningOutputTokens"] as const) {
    if (modelTotals[key] !== runUsage[key]) {
      throw new Error(`run-scoped Codex usage ${key} does not equal its per-model total`);
    }
  }
  if (Math.abs(modelTotals.budgetUnits - runUsage.budgetUnits) > 1e-9) {
    throw new Error("run-scoped Codex usage budgetUnits does not equal its per-model total");
  }
  const usageModels = new Map(runUsage.models.map((entry) => [entry.model, entry]));
  for (const provider of providers) {
    if (provider.provider !== "codex-cli") {
      throw new Error(`Build Week evidence receipts require Codex CLI providers; got ${provider.provider}`);
    }
    const usage = usageModels.get(provider.model);
    if (!usage || !Number.isInteger(usage.calls) || usage.calls <= 0) {
      throw new Error(`run-scoped Codex usage does not bind configured model ${provider.model}`);
    }
  }
  const localBudgetUnits = requireFiniteNonNegative(runUsage.budgetUnits, "run local budget units");
  for (const code of options.limitationCodes) {
    if (!(code in BUILD_WEEK_LIMITATIONS)) throw new Error(`unknown Build Week limitation code ${String(code)}`);
  }
  const limitationCodes = new Set(options.limitationCodes);
  if (options.publicationScope.kind === "bounded-subset" && !options.limitationCodes.includes("boundedSubset")) {
    throw new Error("bounded-subset receipts must include the boundedSubset limitation");
  }
  if (!limitationCodes.has("estimatedAccounting")) {
    throw new Error("Build Week evidence receipts must include the estimatedAccounting limitation");
  }
  if (providers.some((provider) => provider.role === "judge") && !limitationCodes.has("modelJudged")) {
    throw new Error("receipts with a judge provider must include the modelJudged limitation");
  }
  if (!Number.isInteger(result.meta.runCount) || result.meta.runCount <= 0) {
    throw new Error("benchmark runCount must be a positive integer");
  }
  if (result.meta.runCount === 1 && !limitationCodes.has("singleRun")) {
    throw new Error("single-run receipts must include the singleRun limitation");
  }
  if (result.meta.runCount !== 1 && limitationCodes.has("singleRun")) {
    throw new Error("the singleRun limitation is only valid when runCount is 1");
  }
  const limitations = [...limitationCodes].sort().map((code) => BUILD_WEEK_LIMITATIONS[code]);
  const publicArtifactSha256 = verifyPublicArtifact(
    result,
    options.datasetVersion,
    options.publicationScope,
    options.publicArtifactJson,
    validatedAggregates,
  );

  return {
    schemaVersion: BUILD_WEEK_EVIDENCE_RECEIPT_SCHEMA_VERSION,
    benchmark: {
      id: requireSafeIdentifier(result.meta.benchmark, "benchmark id"),
      version: requireSafeIdentifier(result.meta.version, "benchmark version"),
      mode: result.meta.mode,
      status: "complete",
      taskCount: result.results.tasks.length,
      failureCount,
      aggregates: validatedAggregates,
    },
    provenance: {
      resultId: requireSafeIdentifier(result.meta.id, "result id"),
      remnicVersion: requireSafeIdentifier(result.meta.remnicVersion, "Remnic version"),
      gitSha: requireSafeIdentifier(result.meta.gitSha, "git SHA"),
      runtimeProfile: result.config.runtimeProfile
        ? requireSafeIdentifier(result.config.runtimeProfile, "runtime profile")
        : null,
      adapterMode: requireSafeIdentifier(result.config.adapterMode, "adapter mode"),
      providers,
    },
    dataset: {
      source: datasetReceipt.source,
      version: options.datasetVersion,
      payloadSha256: datasetReceipt.payloadSha256,
      // File-backed benchmarks hash the sorted file inventory. Generated
      // MemCorrect hashes its pinned generator identity instead.
      manifestSha256: datasetReceipt.manifestSha256,
      fileCount: datasetReceipt.fileCount,
      totalBytes: datasetReceipt.totalBytes,
    },
    integrity: {
      resultSha256,
      manifestSha256,
      manifestArtifactHash: manifest.artifactHash,
      publicArtifactSha256,
    },
    estimatedUsage: {
      label: "local estimates; not account billing",
      calls: requireFiniteNonNegative(runUsage.calls, "run calls"),
      inputTokens: requireFiniteNonNegative(runUsage.inputTokens, "run inputTokens"),
      cachedInputTokens: requireFiniteNonNegative(runUsage.cachedInputTokens, "run cachedInputTokens"),
      outputTokens: requireFiniteNonNegative(runUsage.outputTokens, "run outputTokens"),
      reasoningOutputTokens: requireFiniteNonNegative(
        runUsage.reasoningOutputTokens,
        "run reasoningOutputTokens",
      ),
      totalTokens: requireFiniteNonNegative(
        runUsage.inputTokens + runUsage.outputTokens,
        "run totalTokens",
      ),
      localBudgetUnits,
      estimatedCostUsd: requireFiniteNonNegative(result.cost.estimatedCostUsd, "estimatedCostUsd"),
    },
    assertions: {
      noSolModels: true,
      freshIsolatedStore: true,
      freshIsolatedStoreStatement:
        "The benchmark used a fresh isolated Remnic store, separate from production data.",
      containsNoPerTaskContent: true,
      containsNoPrivateLedgerOrAccountBalance: true,
    },
    limitations,
  };
}

export function serializeBuildWeekEvidenceReceipt(receipt: BuildWeekEvidenceReceipt): string {
  return `${JSON.stringify(receipt, null, 2)}\n`;
}

async function canonicalOutputPath(outputPath: string): Promise<string> {
  try {
    return await realpath(outputPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return join(await realpath(dirname(outputPath)), basename(outputPath));
  }
}

export async function writeBuildWeekEvidenceReceipt(args: {
  resultPath: string;
  manifestPath: string;
  publicArtifactPath?: string;
  outputPath: string;
  datasetVersion: string;
  limitationCodes: readonly BuildWeekLimitationCode[];
  freshIsolatedStoreConfirmed: true;
  publicationScope: BuildBuildWeekEvidenceReceiptOptions["publicationScope"];
}): Promise<BuildWeekEvidenceReceipt> {
  const [resultRealpath, manifestRealpath, outputRealpath, resultStat, manifestStat] = await Promise.all([
    realpath(args.resultPath),
    realpath(args.manifestPath),
    canonicalOutputPath(args.outputPath),
    stat(args.resultPath),
    stat(args.manifestPath),
  ]);
  if (outputRealpath === resultRealpath || outputRealpath === manifestRealpath) {
    throw new Error("receipt output path must not alias the private result or manifest source");
  }
  let outputStat;
  try {
    outputStat = await stat(args.outputPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (
    outputStat &&
    ((outputStat.dev === resultStat.dev && outputStat.ino === resultStat.ino) ||
      (outputStat.dev === manifestStat.dev && outputStat.ino === manifestStat.ino))
  ) {
    throw new Error("receipt output file must not share identity with the private result or manifest source");
  }
  const [resultJson, manifestJson, publicArtifactJson] = await Promise.all([
    readFile(args.resultPath),
    readFile(args.manifestPath),
    args.publicArtifactPath ? readFile(args.publicArtifactPath) : undefined,
  ]);
  const receipt = buildBuildWeekEvidenceReceipt({
    resultJson,
    manifestJson,
    publicArtifactJson,
    datasetVersion: args.datasetVersion,
    limitationCodes: args.limitationCodes,
    freshIsolatedStoreConfirmed: args.freshIsolatedStoreConfirmed,
    publicationScope: args.publicationScope,
  });
  // Publish create-only. O_EXCL prevents both a leaf substitution and a
  // parent-directory swap from replacing any existing private source entry.
  // Callers that intentionally regenerate a public receipt must choose a new
  // path or remove the prior public artifact outside this safety boundary.
  const output = await open(args.outputPath, "wx", 0o644);
  let createdStat: Awaited<ReturnType<typeof output.stat>> | undefined;
  let identityError: unknown;
  let publicationError: unknown;
  let closeError: unknown;
  try {
    try {
      createdStat = await output.stat();
    } catch (error) {
      // File identity is needed only to remove a failed publication safely.
      // An fstat failure must not itself strand an otherwise writable,
      // create-only output before the guarded publication flow begins.
      identityError = error;
    }
    await output.writeFile(serializeBuildWeekEvidenceReceipt(receipt), { encoding: "utf8" });
    await output.sync();
    if (!createdStat) {
      try {
        createdStat = await output.stat();
        identityError = undefined;
      } catch (statError) {
        identityError = statError;
      }
    }
    if (!createdStat) {
      throw identityError ?? new Error("created receipt file identity is unavailable");
    }
    const publishedStat = await lstat(args.outputPath);
    if (
      !publishedStat.isFile() ||
      publishedStat.dev !== createdStat.dev ||
      publishedStat.ino !== createdStat.ino
    ) {
      throw new Error("receipt output path file identity changed during publication");
    }
  } catch (error) {
    publicationError = error;
    if (!createdStat) {
      try {
        createdStat = await output.stat();
        identityError = undefined;
      } catch (statError) {
        identityError = statError;
      }
    }
  } finally {
    try {
      await output.close();
    } catch (error) {
      closeError = error;
    }
  }
  const outputFailure = publicationError ?? closeError;
  if (outputFailure !== undefined) {
    if (!createdStat) {
      throw new AggregateError(
        [outputFailure, identityError ?? new Error("created receipt file identity is unavailable")],
        "receipt publication failed and its partial output could not be identified for safe removal",
      );
    }
    try {
      const currentStat = await lstat(args.outputPath);
      if (currentStat.dev !== createdStat.dev || currentStat.ino !== createdStat.ino) {
        throw new Error("refusing to remove a failed receipt output whose file identity changed");
      }
      await unlink(args.outputPath);
    } catch (cleanupError) {
      if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new AggregateError(
          [outputFailure, cleanupError],
          "receipt publication failed and its partial output could not be removed safely",
        );
      }
    }
    if (publicationError !== undefined && closeError !== undefined) {
      throw new AggregateError(
        [publicationError, closeError],
        "receipt publication failed and closing its partial output also failed",
      );
    }
    throw outputFailure;
  }
  return receipt;
}
