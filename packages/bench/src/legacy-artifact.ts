/**
 * Legacy benchmark artifact compatibility (issue #2850).
 *
 * Artifacts written before the canonical `isBenchmarkResult` validator
 * existed carry fewer required fields. The pre-#2800 bench-ui parser
 * accepted them with per-field display defaults; the canonical loader
 * rejects them, so historical runs vanished from result listings once
 * tooling moved to `loadBenchmarkResult`.
 *
 * This module recognizes that legacy envelope and upgrades it to a
 * canonical `BenchmarkResult`. The recognition rule is deliberate and
 * narrow:
 *
 * - ABSENT optional fields get the documented default below (the same
 *   default the pre-#2800 bench-ui parser displayed).
 * - PRESENT fields must already be canonical-valid for every field the
 *   canonical validator checks. A present-but-invalid value is never
 *   coerced, dropped, or guessed — the artifact is rejected with a
 *   reason naming the field, or by the canonical re-validation the
 *   loader runs on the upgraded result.
 * - Integrity and provenance are never fabricated: seals, split type,
 *   and canary score stay absent when the artifact lacks them, so
 *   downstream integrity gates (publish, leaderboard) still classify
 *   these results as `missing-integrity`. Unknown version, Remnic
 *   version, and git SHA upgrade to the explicit marker `"unknown"`.
 * - Modern provenance or integrity markers are not shape 1. ANY single
 *   provenance key (version/remnicVersion/gitSha), a published/remnic
 *   tier, or a split/hash seal claims modern provenance, so partially
 *   corrupted modern artifacts reject too instead of laundering through
 *   this path with fabricated "unknown" markers; never fabricate empty
 *   results for them.
 * - Task entries without a usable `taskId` are skipped, exactly as the
 *   pre-#2800 UI skipped unidentifiable task rows.
 * - Mean-only aggregates upgrade only when exactly one recognized task
 *   proves single-sample semantics. Zero recognized tasks, skipped-ID
 *   rows, and multi-task runs reject incomplete aggregates.
 */
import type { AggregateMetrics, BenchRuntimeProfile, BenchmarkMode, BenchmarkResult, BenchmarkTier, MetricAggregate, ProviderConfig, TaskResult } from "./types.js";
import { INTEGRITY_META_FIELDS } from "./integrity/types.js";

/**
 * Recognized legacy shape version. Shape 1 is the pre-#2800 bench-ui
 * envelope: `meta.id`, `meta.benchmark`, and `meta.timestamp` present;
 * every other canonical field optional.
 */
export const LEGACY_ARTIFACT_SHAPE_VERSION = 1 as const;

export type LegacyArtifactRecognition =
  | { ok: true; shapeVersion: typeof LEGACY_ARTIFACT_SHAPE_VERSION; result: BenchmarkResult }
  | { ok: false; reason: string };

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

class ArtifactRejected extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

function reject(reason: string): never {
  throw new ArtifactRejected(reason);
}

/** Read an optional string field; rejects non-strings, keeps empty strings (empty is a legal display value). */
function optionalString(where: string, container: JsonRecord, key: string): string | undefined {
  if (!(key in container)) {
    return undefined;
  }
  if (typeof container[key] !== "string") {
    reject(`${where} must be a string when present`);
  }
  return container[key];
}

/** Read an optional finite-number field; rejects non-numbers and non-finite values. */
function optionalFiniteNumber(where: string, container: JsonRecord, key: string): number | undefined {
  if (!(key in container)) {
    return undefined;
  }
  if (!isFiniteNumber(container[key])) {
    reject(`${where} must be a finite number when present`);
  }
  return container[key];
}

function optionalMode(where: string, container: JsonRecord): BenchmarkMode | undefined {
  if (!("mode" in container)) {
    return undefined;
  }
  if (container.mode !== "quick" && container.mode !== "full") {
    reject(`${where} must be "quick" or "full" when present`);
  }
  return container.mode;
}

function optionalTier(where: string, container: JsonRecord): BenchmarkTier | undefined {
  if (!("benchmarkTier" in container)) {
    return undefined;
  }
  const value = container.benchmarkTier;
  if (value !== "published" && value !== "remnic" && value !== "custom") {
    reject(`${where} must be "published", "remnic", or "custom" when present`);
  }
  return value;
}

function optionalProviderConfig(where: string, value: unknown): ProviderConfig | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (!isRecord(value) || typeof value.provider !== "string" || typeof value.model !== "string") {
    reject(`${where} must be a provider config ({ provider, model }) or null when present`);
  }
  return value as unknown as ProviderConfig;
}

function optionalSeeds(where: string, value: unknown): number[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || !value.every(isFiniteNumber)) {
    reject(`${where} must be an array of finite numbers when present`);
  }
  return value;
}

function isBenchRuntimeProfile(value: unknown): value is BenchRuntimeProfile {
  return (
    value === "baseline" || value === "real" || value === "openclaw-chain" || value === "local-lab"
  );
}

function normalizeMetricAggregate(
  where: string,
  raw: unknown,
  taskCount: number,
): MetricAggregate {
  if (
    isRecord(raw) &&
    isFiniteNumber(raw.mean) &&
    isFiniteNumber(raw.median) &&
    isFiniteNumber(raw.stdDev) &&
    isFiniteNumber(raw.min) &&
    isFiniteNumber(raw.max)
  ) {
    return raw as unknown as MetricAggregate;
  }

  let mean: number | undefined;
  let rawMedian: number | undefined;
  let rawStdDev: number | undefined;
  let rawMin: number | undefined;
  let rawMax: number | undefined;

  if (isFiniteNumber(raw)) {
    mean = raw;
  } else if (isRecord(raw)) {
    for (const field of ["mean", "median", "stdDev", "min", "max"] as const) {
      if (field in raw && !isFiniteNumber(raw[field])) {
        reject(`${where}.${field} must be a finite number when present`);
      }
    }
    if (isFiniteNumber(raw.mean)) {
      mean = raw.mean;
    }
    if (isFiniteNumber(raw.median)) {
      rawMedian = raw.median;
    }
    if (isFiniteNumber(raw.stdDev)) {
      rawStdDev = raw.stdDev;
    }
    if (isFiniteNumber(raw.min)) {
      rawMin = raw.min;
    }
    if (isFiniteNumber(raw.max)) {
      rawMax = raw.max;
    }
  }

  if (mean === undefined) {
    reject(`${where} must be a finite number or an object with a finite mean number`);
  }

  // Inline the guard: an aliased boolean does not narrow `let` locals,
  // and this branch returns the raw values as required numbers.
  if (rawMedian !== undefined && rawStdDev !== undefined && rawMin !== undefined && rawMax !== undefined) {
    return {
      mean,
      median: rawMedian,
      stdDev: rawStdDev,
      min: rawMin,
      max: rawMax,
    };
  }

  if (taskCount === 1) {
    return {
      mean,
      median: rawMedian ?? mean,
      stdDev: rawStdDev ?? 0,
      min: rawMin ?? mean,
      max: rawMax ?? mean,
    };
  }

  if (taskCount === 0) {
    reject(
      `${where} missing required fields (median, stdDev, min, max); mean-only upgrade requires exactly one recognized task`,
    );
  }

  reject(
    `${where} missing required multi-sample fields (median, stdDev, min, max) for multi-task run (taskCount=${taskCount})`,
  );
}


function upgradeMeta(legacy: JsonRecord, recognizedTaskCount: number): BenchmarkResult["meta"] {
  if (!isRecord(legacy.meta)) {
    reject("meta with non-empty id, benchmark, and timestamp strings is required");
  }
  const meta = legacy.meta;
  for (const key of ["id", "benchmark", "timestamp"] as const) {
    const value = meta[key];
    if (typeof value !== "string" || value.trim().length === 0) {
      reject(`meta.${key} must be a non-empty string`);
    }
  }

  const taskCount = recognizedTaskCount;
  const upgraded: BenchmarkResult["meta"] = {
    id: meta.id as string,
    benchmark: meta.benchmark as string,
    timestamp: meta.timestamp as string,
    // Old UI display default for an absent tier.
    benchmarkTier: optionalTier("meta.benchmarkTier", meta) ?? "custom",
    // Provenance is not knowable from a legacy artifact: recognition
    // rejects any payload with a present provenance key, so the only
    // honest value here is the explicit "unknown" marker.
    version: "unknown",
    remnicVersion: "unknown",
    gitSha: "unknown",
    // Old UI display default for an absent mode.
    mode: optionalMode("meta.mode", meta) ?? "quick",
    // Old UI fell back to the task count when runCount was absent.
    runCount: optionalFiniteNumber("meta.runCount", meta, "runCount") ?? taskCount,
    seeds: optionalSeeds("meta.seeds", meta.seeds) ?? [],
  };

  // Optional pass-through fields: present-but-wrong-type rejects here
  // so report-card/HTML export never sees a non-string failureReason.
  const metaExtras = upgraded as unknown as JsonRecord;
  for (const key of [
    "runId",
    "gitDirty",
    "gitDirtyEntryCount",
    "splitType",
    "qrelsSealedHash",
    "judgePromptHash",
    "datasetHash",
    "canaryScore",
    "canaryFloor",
    "status",
    "failureReason",
  ] as const) {
    if (!(key in meta)) {
      continue;
    }
    if (key === "canaryFloor") {
      const floorVal = optionalFiniteNumber("meta.canaryFloor", meta, "canaryFloor");
      if (floorVal !== undefined) {
        if (floorVal < 0) {
          reject("meta.canaryFloor must be a non-negative number when present");
        }
        metaExtras[key] = floorVal;
      }
      continue;
    }
    if (key === "canaryScore" || key === "gitDirtyEntryCount") {
      const numeric = optionalFiniteNumber(`meta.${key}`, meta, key);
      if (numeric !== undefined) {
        metaExtras[key] = numeric;
      }
      continue;
    }
    if (
      key === "runId" ||
      key === "qrelsSealedHash" ||
      key === "judgePromptHash" ||
      key === "datasetHash" ||
      key === "failureReason"
    ) {
      const text = optionalString(`meta.${key}`, meta, key);
      if (text !== undefined) {
        metaExtras[key] = text;
      }
      continue;
    }
    if (key === "gitDirty") {
      if (typeof meta.gitDirty !== "boolean") {
        reject("meta.gitDirty must be a boolean when present");
      }
      metaExtras.gitDirty = meta.gitDirty;
      continue;
    }
    if (key === "status") {
      if (meta.status !== "complete" && meta.status !== "partial") {
        reject('meta.status must be "complete" or "partial" when present');
      }
      metaExtras.status = meta.status;
      continue;
    }
    if (meta.splitType !== "public" && meta.splitType !== "holdout") {
      reject('meta.splitType must be "public" or "holdout" when present');
    }
    metaExtras.splitType = meta.splitType;
  }

  return upgraded;
}

function upgradeConfig(legacy: JsonRecord): BenchmarkResult["config"] {
  if (!("config" in legacy)) {
    // Old UI display defaults: no providers configured, adapter unknown.
    return {
      systemProvider: null,
      judgeProvider: null,
      adapterMode: "unknown",
      remnicConfig: {},
    };
  }
  if (!isRecord(legacy.config)) {
    reject("config must be an object when present");
  }
  const config = legacy.config;

  const upgraded: BenchmarkResult["config"] = {
    systemProvider: optionalProviderConfig("config.systemProvider", config.systemProvider),
    judgeProvider: optionalProviderConfig("config.judgeProvider", config.judgeProvider),
    // Old UI display default for an absent adapter mode.
    adapterMode: optionalString("config.adapterMode", config, "adapterMode") ?? "unknown",
    remnicConfig: {},
  };

  if ("remnicConfig" in config) {
    if (!isRecord(config.remnicConfig)) {
      reject("config.remnicConfig must be an object when present");
    }
    upgraded.remnicConfig = config.remnicConfig;
  }
  if ("internalProvider" in config && config.internalProvider !== undefined) {
    upgraded.internalProvider = optionalProviderConfig("config.internalProvider", config.internalProvider);
  }
  // Config extras carry the strict-schema contract (issue #2885): the
  // canonical re-validation never checks these fields, so an invalid
  // value copied here would flow into repro manifests and exports as if
  // it were typed. Validate before copying.
  if ("runtimeProfile" in config && config.runtimeProfile !== undefined) {
    const profile = config.runtimeProfile;
    if (profile !== null && !isBenchRuntimeProfile(profile)) {
      reject(
        'config.runtimeProfile must be "baseline", "real", "openclaw-chain", "local-lab", or null when present',
      );
    }
    upgraded.runtimeProfile = profile;
  }
  if ("benchmarkOptions" in config && config.benchmarkOptions !== undefined) {
    if (!isRecord(config.benchmarkOptions)) {
      reject("config.benchmarkOptions must be an object when present");
    }
    upgraded.benchmarkOptions = config.benchmarkOptions;
  }

  return upgraded;
}

function upgradeCost(legacy: JsonRecord): BenchmarkResult["cost"] {
  if (!("cost" in legacy)) {
    // Canonical cost accounting is additive; a legacy artifact that
    // recorded no usage upgrades to zero, never to a guess.
    return {
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      estimatedCostUsd: 0,
      totalLatencyMs: 0,
      meanQueryLatencyMs: 0,
    };
  }
  if (!isRecord(legacy.cost)) {
    reject("cost must be an object when present");
  }
  const cost = legacy.cost;

  const upgraded: BenchmarkResult["cost"] = {
    totalTokens: optionalFiniteNumber("cost.totalTokens", cost, "totalTokens") ?? 0,
    inputTokens: optionalFiniteNumber("cost.inputTokens", cost, "inputTokens") ?? 0,
    outputTokens: optionalFiniteNumber("cost.outputTokens", cost, "outputTokens") ?? 0,
    estimatedCostUsd: optionalFiniteNumber("cost.estimatedCostUsd", cost, "estimatedCostUsd") ?? 0,
    totalLatencyMs: optionalFiniteNumber("cost.totalLatencyMs", cost, "totalLatencyMs") ?? 0,
    meanQueryLatencyMs: optionalFiniteNumber("cost.meanQueryLatencyMs", cost, "meanQueryLatencyMs") ?? 0,
  };
  if ("judgeModelCalls" in cost) {
    upgraded.judgeModelCalls = optionalFiniteNumber("cost.judgeModelCalls", cost, "judgeModelCalls");
  }
  return upgraded;
}

function upgradeTask(where: string, task: unknown): TaskResult | null {
  if (!isRecord(task) || typeof task.taskId !== "string" || task.taskId.trim().length === 0) {
    // Pre-#2800 UI parity: a task row without a usable taskId has no
    // identity to display and is skipped, not fatal.
    return null;
  }

  if ("scores" in task && (!isRecord(task.scores) || !Object.values(task.scores).every(isFiniteNumber))) {
    reject(`${where}.scores must map metric names to finite numbers when present`);
  }
  if ("tokens" in task && !isRecord(task.tokens)) {
    reject(`${where}.tokens must be an object when present`);
  }
  const tokensSource = isRecord(task.tokens) ? task.tokens : {};

  const upgraded: TaskResult = {
    taskId: task.taskId,
    // Old UI display defaults for absent task text fields.
    question: optionalString(`${where}.question`, task, "question") ?? "",
    expected: optionalString(`${where}.expected`, task, "expected") ?? "",
    actual: optionalString(`${where}.actual`, task, "actual") ?? "",
    scores: (isRecord(task.scores) ? task.scores : {}) as TaskResult["scores"],
    latencyMs: optionalFiniteNumber(`${where}.latencyMs`, task, "latencyMs") ?? 0,
    tokens: {
      input: optionalFiniteNumber(`${where}.tokens.input`, tokensSource, "input") ?? 0,
      output: optionalFiniteNumber(`${where}.tokens.output`, tokensSource, "output") ?? 0,
    },
  };

  const taskExtras = upgraded as unknown as JsonRecord;
  for (const key of ["goldMemories", "attributionWitness", "details"] as const) {
    if (key in task) {
      taskExtras[key] = task[key];
    }
  }

  return upgraded;
}

function upgradeResults(legacy: JsonRecord): BenchmarkResult["results"] {
  const upgraded: BenchmarkResult["results"] = { tasks: [], aggregates: {} };
  if (!("results" in legacy)) {
    return upgraded;
  }
  if (!isRecord(legacy.results)) {
    reject("results must be an object when present");
  }
  const results = legacy.results;

  if ("tasks" in results) {
    if (!Array.isArray(results.tasks)) {
      reject("results.tasks must be an array when present");
    }
    upgraded.tasks = results.tasks
      .map((task, index) => upgradeTask(`results.tasks[${index}]`, task))
      .filter((task): task is TaskResult => task !== null);
  }

  if ("aggregates" in results) {
    if (!isRecord(results.aggregates)) {
      reject("results.aggregates must be an object when present");
    }
    const normalizedAggregates: AggregateMetrics = {};
    for (const [metricName, rawValue] of Object.entries(results.aggregates)) {
      normalizedAggregates[metricName] = normalizeMetricAggregate(
        `results.aggregates.${metricName}`,
        rawValue,
        upgraded.tasks.length,
      );
    }
    upgraded.aggregates = normalizedAggregates;
  }

  const resultsExtras = upgraded as unknown as JsonRecord;
  if ("categoryAggregates" in results && results.categoryAggregates !== undefined) {
    if (!isRecord(results.categoryAggregates)) {
      reject("results.categoryAggregates must be an object when present");
    }
    const normalizedCategoryAggregates: Record<string, AggregateMetrics> = {};
    for (const [catName, catAggs] of Object.entries(results.categoryAggregates)) {
      if (!isRecord(catAggs)) {
        reject(`results.categoryAggregates.${catName} must be an object`);
      }
      const catNormalized: AggregateMetrics = {};
      for (const [metricName, rawVal] of Object.entries(catAggs)) {
        catNormalized[metricName] = normalizeMetricAggregate(
          `results.categoryAggregates.${catName}.${metricName}`,
          rawVal,
          upgraded.tasks.length,
        );
      }
      normalizedCategoryAggregates[catName] = catNormalized;
    }
    resultsExtras.categoryAggregates = normalizedCategoryAggregates;
  }

  if ("statistics" in results) {
    resultsExtras.statistics = results.statistics;
  }

  const hasCategoryAggregate =
    isRecord(resultsExtras.categoryAggregates) &&
    Object.values(resultsExtras.categoryAggregates).some(
      (category) => isRecord(category) && Object.keys(category).length > 0,
    );
  if (upgraded.tasks.length === 0 && Object.keys(upgraded.aggregates).length === 0 && !hasCategoryAggregate) {
    reject("results must contain at least one recognized task or aggregate");
  }

  return upgraded;
}

function upgradeEnvironment(legacy: JsonRecord): BenchmarkResult["environment"] {
  if (!("environment" in legacy)) {
    return { os: "unknown", nodeVersion: "unknown" };
  }
  if (!isRecord(legacy.environment)) {
    reject("environment must be an object when present");
  }
  const environment = legacy.environment;

  const upgraded: BenchmarkResult["environment"] = {
    os: optionalString("environment.os", environment, "os") ?? "unknown",
    nodeVersion: optionalString("environment.nodeVersion", environment, "nodeVersion") ?? "unknown",
  };
  if ("hardware" in environment) {
    // Pass through verbatim; the canonical re-validation in the loader
    // rejects a present-but-invalid value instead of dropping it.
    upgraded.hardware = environment.hardware as string;
  }
  return upgraded;
}

/**
 * Recognize and upgrade a legacy benchmark artifact (shape version 1).
 * Callers invoke this only after the canonical validator rejected the
 * payload; `ok: false` carries the reason for every rejection, so
 * malformed and ambiguous artifacts stay skipped with an explanation.
 */
export function recognizeLegacyBenchmarkArtifact(value: unknown): LegacyArtifactRecognition {
  if (!isRecord(value)) {
    return { ok: false, reason: "artifact is not a JSON object" };
  }
  if (isRecord(value.meta)) {
    const meta = value.meta;
    // Any single provenance key claims modern provenance. Requiring all
    // three keys let a partially corrupted modern artifact (e.g. version
    // and remnicVersion retained, gitSha lost) fall into this legacy
    // path and get its missing marker fabricated as "unknown".
    const modernProvenance = "version" in meta || "remnicVersion" in meta || "gitSha" in meta;
    const modernTier = meta.benchmarkTier === "published" || meta.benchmarkTier === "remnic";
    const modernIntegrity = INTEGRITY_META_FIELDS.some((key) => key in meta);
    if (modernProvenance || modernTier || modernIntegrity) {
      return {
        ok: false,
        reason: !("results" in value)
          ? "modern provenance/integrity markers present; missing results is not a legacy artifact"
          : "modern provenance/integrity markers present; not a legacy artifact",
      };
    }
  }

  try {
    return {
      ok: true,
      shapeVersion: LEGACY_ARTIFACT_SHAPE_VERSION,
      result: (() => {
        const results = upgradeResults(value);
        return {
          meta: upgradeMeta(value, results.tasks.length),
          config: upgradeConfig(value),
          cost: upgradeCost(value),
          results,
          environment: upgradeEnvironment(value),
        };
      })(),
    };
  } catch (error) {
    if (error instanceof ArtifactRejected) {
      return { ok: false, reason: error.reason };
    }
    return {
      ok: false,
      reason: error instanceof Error ? error.message : "legacy artifact upgrade failed",
    };
  }
}
