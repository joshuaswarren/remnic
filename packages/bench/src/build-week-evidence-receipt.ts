import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

import type { BenchmarkReproManifest } from "./repro-manifest.js";
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
  datasetVersion: string;
  limitationCodes: readonly BuildWeekLimitationCode[];
  freshIsolatedStoreConfirmed: true;
  publicationScope:
    | { kind: "full"; expectedTaskCount: number }
    | { kind: "bounded-subset"; expectedTaskCount: number };
}

const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_DATASET_VERSION = /^[A-Za-z0-9][A-Za-z0-9._+@/-]{0,127}$/;
const SAFE_PUBLIC_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._+@:/-]{0,255}$/;
const SOL_MODEL = /^gpt-5\.6-sol$/i;
const MEMCORRECT_BENCHMARK_ID = "memcorrect-v1";
const MEMCORRECT_BENCHMARK_VERSION = "1.0.0";
const MEMCORRECT_FULL_SEED = 0xc077e7;
const MEMCORRECT_GENERATOR_OPTIONS = Object.freeze({
  personaCount: 5,
  factsPerPersona: 8,
  seed: MEMCORRECT_FULL_SEED,
  nowIso: "2026-07-05T00:00:00.000Z",
  maintenanceCycles: 5,
  uptakeLatencyCap: 8,
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requireExactMemCorrectProvenance(
  result: BenchmarkResult,
  manifest: BenchmarkReproManifest,
  datasetVersion: string,
  publicationScope: BuildBuildWeekEvidenceReceiptOptions["publicationScope"],
): { source: "generated-corpus"; manifestSha256: string; fileCount: 0; totalBytes: 0 } {
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
  for (const key of ["personaCount", "factsPerPersona", "maintenanceCycles", "uptakeLatencyCap"] as const) {
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
    manifestSha256: sha256(JSON.stringify(generatedProvenance)),
    fileCount: 0,
    totalBytes: 0,
  };
}

function providerReceipt(
  role: BuildWeekEvidenceReceiptProvider["role"],
  provider: ProviderConfig | null | undefined,
): BuildWeekEvidenceReceiptProvider | undefined {
  if (!provider) return undefined;
  const providerName = requireSafeIdentifier(provider.provider, `${role} provider`);
  const model = requireSafeIdentifier(provider.model, `${role} model`);
  return {
    role,
    provider: providerName,
    model,
    reasoningEffort: provider.reasoningEffort ?? null,
    // BenchmarkResult does not persist transport service-tier diagnostics.
    // Keep the public receipt honest instead of inferring a tier from provider type.
    serviceTier: null,
  };
}

function sortedAggregates(result: BenchmarkResult): BuildWeekEvidenceReceipt["benchmark"]["aggregates"] {
  const output: BuildWeekEvidenceReceipt["benchmark"]["aggregates"] = {};
  for (const metric of Object.keys(result.results.aggregates).sort()) {
    const aggregate = result.results.aggregates[metric];
    if (!aggregate) continue;
    output[requireSafeIdentifier(metric, "aggregate metric name")] = {
      mean: requireFinite(aggregate.mean, `${metric}.mean`),
      median: requireFinite(aggregate.median, `${metric}.median`),
      stdDev: requireFiniteNonNegative(aggregate.stdDev, `${metric}.stdDev`),
      min: requireFinite(aggregate.min, `${metric}.min`),
      max: requireFinite(aggregate.max, `${metric}.max`),
    };
  }
  return output;
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
  if (result.meta?.status !== "complete") {
    throw new Error("only explicitly complete benchmark results can produce Build Week evidence receipts");
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

  const resultEntry = manifest.results.find((entry) => entry.resultId === result.meta.id);
  if (!resultEntry) throw new Error("manifest does not bind the benchmark result id");
  if (resultEntry.sha256 !== resultSha256) throw new Error("manifest result hash does not match the result bytes");
  if (resultEntry.taskCount !== result.results.tasks.length) throw new Error("manifest result task count does not match");
  if (resultEntry.benchmark !== result.meta.benchmark || resultEntry.mode !== result.meta.mode) {
    throw new Error("manifest result identity does not match the benchmark result");
  }

  if (!result.meta.datasetHash || !SHA256.test(result.meta.datasetHash)) {
    throw new Error("benchmark result must contain a SHA-256 dataset payload hash");
  }
  const datasetReceipt = result.meta.benchmark === MEMCORRECT_BENCHMARK_ID
    ? requireExactMemCorrectProvenance(result, manifest, options.datasetVersion, options.publicationScope)
    : (() => {
        const dataset = manifest.datasets.find((entry) => entry.benchmark === result.meta.benchmark);
        if (!dataset || dataset.status !== "hashed" || !dataset.sha256 || !SHA256.test(dataset.sha256)) {
          throw new Error("manifest must contain a hashed dataset entry for the benchmark");
        }
        return {
          source: "file-manifest" as const,
          manifestSha256: dataset.sha256,
          fileCount: requireFiniteNonNegative(dataset.fileCount, "dataset fileCount"),
          totalBytes: requireFiniteNonNegative(dataset.totalBytes, "dataset totalBytes"),
        };
      })();
  if (!SHA256.test(manifest.artifactHash)) throw new Error("manifest artifactHash must be a SHA-256 digest");

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
  const usageModels = new Set(runUsage.models.map((entry) => entry.model));
  for (const provider of providers) {
    if (provider.provider === "codex-cli" && !usageModels.has(provider.model)) {
      throw new Error(`run-scoped Codex usage does not bind configured model ${provider.model}`);
    }
  }
  const localBudgetUnits = requireFiniteNonNegative(runUsage.budgetUnits, "run local budget units");
  for (const code of options.limitationCodes) {
    if (!(code in BUILD_WEEK_LIMITATIONS)) throw new Error(`unknown Build Week limitation code ${String(code)}`);
  }
  const limitations = [...new Set(options.limitationCodes)].sort().map((code) => BUILD_WEEK_LIMITATIONS[code]);
  if (options.publicationScope.kind === "bounded-subset" && !options.limitationCodes.includes("boundedSubset")) {
    throw new Error("bounded-subset receipts must include the boundedSubset limitation");
  }

  return {
    schemaVersion: BUILD_WEEK_EVIDENCE_RECEIPT_SCHEMA_VERSION,
    benchmark: {
      id: requireSafeIdentifier(result.meta.benchmark, "benchmark id"),
      version: requireSafeIdentifier(result.meta.version, "benchmark version"),
      mode: result.meta.mode,
      status: "complete",
      taskCount: result.results.tasks.length,
      failureCount,
      aggregates: sortedAggregates(result),
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
      payloadSha256: result.meta.datasetHash,
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

export async function writeBuildWeekEvidenceReceipt(args: {
  resultPath: string;
  manifestPath: string;
  outputPath: string;
  datasetVersion: string;
  limitationCodes: readonly BuildWeekLimitationCode[];
  freshIsolatedStoreConfirmed: true;
  publicationScope: BuildBuildWeekEvidenceReceiptOptions["publicationScope"];
}): Promise<BuildWeekEvidenceReceipt> {
  const [resultJson, manifestJson] = await Promise.all([
    readFile(args.resultPath),
    readFile(args.manifestPath),
  ]);
  const receipt = buildBuildWeekEvidenceReceipt({
    resultJson,
    manifestJson,
    datasetVersion: args.datasetVersion,
    limitationCodes: args.limitationCodes,
    freshIsolatedStoreConfirmed: args.freshIsolatedStoreConfirmed,
    publicationScope: args.publicationScope,
  });
  await writeFile(args.outputPath, serializeBuildWeekEvidenceReceipt(receipt), { encoding: "utf8", mode: 0o644 });
  return receipt;
}
