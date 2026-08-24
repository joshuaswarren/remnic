import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BenchmarkMode, BenchmarkResult, MetricAggregate } from "./types.js";
import {
  assertIntegrityMetaPresent,
  integrityMetaIsComplete,
} from "./integrity/types.js";
import {
  checkDatasetContamination,
  EMPTY_CONTAMINATION_MANIFEST,
  type ContaminationManifest,
} from "./integrity/contamination.js";
import {
  renderMemoryReportCard,
  type ReportCardProvenanceContext,
} from "./report-card.js";
import { recognizeLegacyBenchmarkArtifact } from "./legacy-artifact.js";
import { validateProviderConfigShape } from "./provider-config.js";

export interface StoredBenchmarkResultSummary {
  id: string;
  path: string;
  benchmark: string;
  timestamp: string;
  mode: BenchmarkMode;
}

export interface StoredBenchmarkBaseline {
  name: string;
  savedAt: string;
  result: BenchmarkResult;
  source?: {
    id: string;
    path: string;
  };
}

export interface StoredBenchmarkBaselineSummary {
  name: string;
  path: string;
  benchmark: string;
  timestamp: string;
  resultId: string;
  resultTimestamp: string;
  mode: BenchmarkMode;
}

export type BenchmarkExportFormat = "json" | "csv" | "html";
export type BenchmarkPublishTarget = "remnic-ai";

export interface PublishedBenchmarkFeedEntry {
  benchmark: string;
  benchmarkTier: BenchmarkResult["meta"]["benchmarkTier"];
  resultId: string;
  timestamp: string;
  mode: BenchmarkMode;
  remnicVersion: string;
  gitSha: string;
  taskCount: number;
  aggregateMetrics: BenchmarkResult["results"]["aggregates"];
  cost: BenchmarkResult["cost"];
  environment: BenchmarkResult["environment"];
  /** Self-contained HTML report card. Optional so older persisted feeds remain valid. */
  reportCardHtml?: string;
  integrity: {
    splitType: NonNullable<BenchmarkResult["meta"]["splitType"]>;
    qrelsSealedHash: string;
    judgePromptHash: string;
    datasetHash: string;
    canaryScore?: number;
  };
}

export interface BuildBenchmarkPublishFeedOptions {
  /**
   * Contamination manifest applied to every candidate result. A result whose
   * `datasetHash` matches an entry is dropped from the published feed.
   * Defaults to the empty manifest.
   */
  contaminationManifest?: ContaminationManifest;
}

export interface PublishedBenchmarkFeed {
  target: BenchmarkPublishTarget;
  generatedAt: string;
  benchmarks: PublishedBenchmarkFeedEntry[];
  /**
   * Records for every candidate result that was considered but dropped from
   * this feed because of an integrity concern. Exposed so tooling can surface
   * the dropped runs without grep-ing logs.
   */
  skipped?: PublishSkipRecord[];
}

const BASELINE_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;
const REPRO_MANIFEST_FILENAME = "MANIFEST.json";

export function defaultBenchmarkBaselineDir(): string {
  const homeDir = process.env.HOME ?? process.env.USERPROFILE ?? os.homedir();
  return path.join(homeDir, ".remnic", "bench", "baselines");
}

export function defaultBenchmarkPublishPath(target: BenchmarkPublishTarget): string {
  const homeDir = process.env.HOME ?? process.env.USERPROFILE ?? os.homedir();
  switch (target) {
    case "remnic-ai":
      return path.join(homeDir, ".remnic", "published", "benchmarks.json");
  }
}

function compareResultSummaries(
  left: StoredBenchmarkResultSummary,
  right: StoredBenchmarkResultSummary,
): number {
  if (left.timestamp === right.timestamp) {
    return left.id.localeCompare(right.id);
  }
  return right.timestamp.localeCompare(left.timestamp);
}

function compareBaselineSummaries(
  left: StoredBenchmarkBaselineSummary,
  right: StoredBenchmarkBaselineSummary,
): number {
  if (left.timestamp === right.timestamp) {
    return left.name.localeCompare(right.name);
  }
  return right.timestamp.localeCompare(left.timestamp);
}

function isBenchmarkMode(value: unknown): value is BenchmarkMode {
  return value === "quick" || value === "full";
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Resolve explicit report-card provenance from an actual adjacent manifest.
 * A stale manifest that does not name the selected result is ignored.
 */
export async function loadBenchmarkReportCardProvenance(
  outputDir: string,
  resultId: string,
): Promise<ReportCardProvenanceContext> {
  const manifestPath = path.join(outputDir, REPRO_MANIFEST_FILENAME);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch {
    return {};
  }
  if (!isObjectRecord(parsed) || !Array.isArray(parsed.results)) return {};
  const coversResult = parsed.results.some(
    (entry) => isObjectRecord(entry) && entry.resultId === resultId,
  );
  if (!coversResult) return {};
  const artifactHash = typeof parsed.artifactHash === "string" && parsed.artifactHash.length > 0
    ? parsed.artifactHash
    : undefined;
  return {
    manifestReference: REPRO_MANIFEST_FILENAME,
    ...(artifactHash ? { artifactHash } : {}),
  };
}

function isProviderConfigLike(value: unknown): boolean {
  if (value === null) {
    return true;
  }
  // Complete canonical shape (issue #2895): the loader shares the provider
  // validator with the legacy adapter instead of a two-string clone.
  return validateProviderConfigShape(value) === null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isUniqueMemoryIdList(value: unknown): value is string[] | null {
  if (value === null) return true;
  if (!Array.isArray(value)) return false;
  const ids = new Set<string>();
  for (const id of value) {
    if (!isNonEmptyString(id) || ids.has(id)) return false;
    ids.add(id);
  }
  return true;
}

function isTaskAttributionWitnessLike(
  value: unknown,
  goldMemories: string[] | undefined,
): boolean {
  if (!isObjectRecord(value) || value.schemaVersion !== 1) {
    return false;
  }
  const runtime = value.runtime;
  if (
    !isObjectRecord(runtime) ||
    !isNonEmptyString(runtime.qmdCollection) ||
    !isNonEmptyString(runtime.qmdIndex) ||
    !isNonNegativeInteger(runtime.qmdMaxResults) ||
    typeof runtime.attributionThreshold !== "number" ||
    !Number.isFinite(runtime.attributionThreshold) ||
    runtime.attributionThreshold < 0 ||
    runtime.attributionThreshold > 1
  ) {
    return false;
  }
  if (
    !Array.isArray(value.golds) ||
    (goldMemories !== undefined && value.golds.length !== goldMemories.length)
  ) {
    return false;
  }
  for (let index = 0; index < value.golds.length; index += 1) {
    const gold = value.golds[index];
    if (
      !isObjectRecord(gold) ||
      !isNonEmptyString(gold.goldMemory) ||
      (goldMemories !== undefined && gold.goldMemory !== goldMemories[index]) ||
      !isUniqueMemoryIdList(gold.storeMemoryIds) ||
      !isUniqueMemoryIdList(gold.oracleMemoryIds)
    ) {
      return false;
    }
  }
  if (!Array.isArray(value.retrievals)) {
    return false;
  }
  const sessionIds = new Set<string>();
  for (const retrieval of value.retrievals) {
    if (
      !isObjectRecord(retrieval) ||
      !isNonEmptyString(retrieval.sessionId) ||
      sessionIds.has(retrieval.sessionId) ||
      !(retrieval.appliedCap === null || isNonNegativeInteger(retrieval.appliedCap)) ||
      !isUniqueMemoryIdList(retrieval.atCapMemoryIds) ||
      !isUniqueMemoryIdList(retrieval.headroomMemoryIds)
    ) {
      return false;
    }
    sessionIds.add(retrieval.sessionId);
    const appliedCap = retrieval.appliedCap;
    const atCapIds = retrieval.atCapMemoryIds;
    const headroomIds = retrieval.headroomMemoryIds;
    if (
      (appliedCap === null && (atCapIds !== null || headroomIds !== null)) ||
      (appliedCap !== null && atCapIds !== null && atCapIds.length > appliedCap) ||
      (appliedCap !== null &&
        atCapIds !== null &&
        atCapIds.length < appliedCap &&
        headroomIds === null) ||
      (appliedCap !== null &&
        headroomIds !== null &&
        headroomIds.length > 0 &&
        (atCapIds === null || atCapIds.length !== appliedCap))
    ) {
      return false;
    }
    if (atCapIds !== null && headroomIds !== null) {
      const atCapSet = new Set(atCapIds);
      if (headroomIds.some((id) => atCapSet.has(id))) {
        return false;
      }
    }
  }
  return true;
}
function isMetricAggregate(value: unknown): value is MetricAggregate {
  return (
    isObjectRecord(value) &&
    isFiniteNumber(value.mean) &&
    isFiniteNumber(value.median) &&
    isFiniteNumber(value.stdDev) &&
    isFiniteNumber(value.min) &&
    isFiniteNumber(value.max)
  );
}


function isBenchmarkResult(value: unknown): value is BenchmarkResult {
  if (!isObjectRecord(value)) {
    return false;
  }

  const meta = value.meta;
  if (!isObjectRecord(meta)) {
    return false;
  }

  const hasValidMeta =
    typeof meta.id === "string" &&
    typeof meta.benchmark === "string" &&
    (meta.benchmarkTier === "published" ||
      meta.benchmarkTier === "remnic" ||
      meta.benchmarkTier === "custom") &&
    typeof meta.version === "string" &&
    typeof meta.remnicVersion === "string" &&
    typeof meta.gitSha === "string" &&
    typeof meta.timestamp === "string" &&
    isBenchmarkMode(meta.mode) &&
    isFiniteNumber(meta.runCount) &&
    Array.isArray(meta.seeds) &&
    meta.seeds.every(isFiniteNumber) &&
    (meta.canaryFloor === undefined || (isFiniteNumber(meta.canaryFloor) && meta.canaryFloor >= 0)) &&
    (meta.canaryScore === undefined || isFiniteNumber(meta.canaryScore)) &&
    (meta.failureReason === undefined || typeof meta.failureReason === "string") &&
    (meta.runId === undefined || typeof meta.runId === "string") &&
    (meta.gitDirty === undefined || typeof meta.gitDirty === "boolean") &&
    (meta.gitDirtyEntryCount === undefined || isFiniteNumber(meta.gitDirtyEntryCount)) &&
    (meta.splitType === undefined || meta.splitType === "public" || meta.splitType === "holdout") &&
    (meta.qrelsSealedHash === undefined || typeof meta.qrelsSealedHash === "string") &&
    (meta.judgePromptHash === undefined || typeof meta.judgePromptHash === "string") &&
    (meta.datasetHash === undefined || typeof meta.datasetHash === "string") &&
    (meta.status === undefined || meta.status === "complete" || meta.status === "partial");
  if (!hasValidMeta) {
    return false;
  }

  const config = value.config;
  if (
    !isObjectRecord(config) ||
    !isProviderConfigLike(config.systemProvider) ||
    !isProviderConfigLike(config.judgeProvider) ||
    (config.internalProvider !== undefined &&
      !isProviderConfigLike(config.internalProvider)) ||
    typeof config.adapterMode !== "string" ||
    !isObjectRecord(config.remnicConfig)
  ) {
    return false;
  }

  const cost = value.cost;
  if (
    !isObjectRecord(cost) ||
    !isFiniteNumber(cost.totalTokens) ||
    !isFiniteNumber(cost.inputTokens) ||
    !isFiniteNumber(cost.outputTokens) ||
    !isFiniteNumber(cost.estimatedCostUsd) ||
    !isFiniteNumber(cost.totalLatencyMs) ||
    !isFiniteNumber(cost.meanQueryLatencyMs)
  ) {
    return false;
  }

  const results = value.results;
  if (
    !isObjectRecord(results) ||
    !Array.isArray(results.tasks) ||
    !results.tasks.every(isTaskResultLike) ||
    !isObjectRecord(results.aggregates) ||
    !Object.values(results.aggregates).every(isMetricAggregate)
  ) {
    return false;
  }

  if (results.categoryAggregates !== undefined) {
    if (!isObjectRecord(results.categoryAggregates)) {
      return false;
    }
    for (const catAgg of Object.values(results.categoryAggregates)) {
      if (!isObjectRecord(catAgg) || !Object.values(catAgg).every(isMetricAggregate)) {
        return false;
      }
    }
  }

  const environment = value.environment;
  return (
    isObjectRecord(environment) &&
    typeof environment.os === "string" &&
    typeof environment.nodeVersion === "string" &&
    (environment.hardware === undefined ||
      typeof environment.hardware === "string")
  );
}

function isTaskResultLike(value: unknown): boolean {
  if (!isObjectRecord(value)) {
    return false;
  }
  const tokens = value.tokens;
  const goldMemories = value.goldMemories;
  if (
    goldMemories !== undefined &&
    (!Array.isArray(goldMemories) ||
      !goldMemories.every((item) => typeof item === "string"))
  ) {
    return false;
  }
  if (
    value.attributionWitness !== undefined &&
    !isTaskAttributionWitnessLike(value.attributionWitness, goldMemories as string[] | undefined)
  ) {
    return false;
  }
  return (
    typeof value.taskId === "string" &&
    typeof value.question === "string" &&
    typeof value.expected === "string" &&
    typeof value.actual === "string" &&
    isObjectRecord(value.scores) &&
    Object.values(value.scores).every(isFiniteNumber) &&
    isFiniteNumber(value.latencyMs) &&
    isObjectRecord(tokens) &&
    isFiniteNumber(tokens.input) &&
    isFiniteNumber(tokens.output)
  );
}

function isStoredBenchmarkBaseline(value: unknown): value is StoredBenchmarkBaseline {
  if (!value || typeof value !== "object") {
    return false;
  }

  const baseline = value as StoredBenchmarkBaseline;
  if (
    typeof baseline.name !== "string" ||
    typeof baseline.savedAt !== "string" ||
    !isBenchmarkResult(baseline.result)
  ) {
    return false;
  }

  if (baseline.source === undefined) {
    return true;
  }

  return (
    typeof baseline.source === "object" &&
    baseline.source !== null &&
    typeof baseline.source.id === "string" &&
    typeof baseline.source.path === "string"
  );
}

function assertValidBaselineName(name: string): void {
  if (!BASELINE_NAME_PATTERN.test(name)) {
    throw new Error(
      `Invalid baseline name "${name}". Use only letters, numbers, "_" and "-".`,
    );
  }
}

function assertUsableBaselineDir(baselineDir: string): void {
  if (!fs.existsSync(baselineDir)) {
    return;
  }

  const stats = fs.statSync(baselineDir);
  if (!stats.isDirectory()) {
    throw new Error(
      `Invalid benchmark baseline directory: ${baselineDir} is not a directory.`,
    );
  }
}

function toSummary(
  result: BenchmarkResult,
  filePath: string,
): StoredBenchmarkResultSummary {
  return {
    id: result.meta.id,
    path: filePath,
    benchmark: result.meta.benchmark,
    timestamp: result.meta.timestamp,
    mode: result.meta.mode,
  };
}

function toBaselineSummary(
  baseline: StoredBenchmarkBaseline,
  filePath: string,
): StoredBenchmarkBaselineSummary {
  return {
    name: baseline.name,
    path: filePath,
    benchmark: baseline.result.meta.benchmark,
    timestamp: baseline.savedAt,
    resultId: baseline.result.meta.id,
    resultTimestamp: baseline.result.meta.timestamp,
    mode: baseline.result.meta.mode,
  };
}

export async function loadBenchmarkResult(filePath: string): Promise<BenchmarkResult> {
  const content = await readFile(filePath, "utf8");
  const parsed: unknown = JSON.parse(content);
  if (isBenchmarkResult(parsed)) {
    return parsed;
  }

  // Canonical-first, then legacy upgrade (issue #2850): artifacts from
  // before the canonical schema get one chance to upgrade with
  // documented defaults. Present-but-invalid values never coerce; the
  // re-validation below is the belt that keeps the return type honest.
  const legacy = recognizeLegacyBenchmarkArtifact(parsed);
  if (legacy.ok && isBenchmarkResult(legacy.result)) {
    return legacy.result;
  }
  throw new Error(
    `Invalid benchmark result file: ${filePath}${legacy.ok ? " (legacy artifact failed canonical re-validation)" : ` (${legacy.reason})`}`,
  );
}

export async function listBenchmarkResults(
  outputDir: string,
): Promise<StoredBenchmarkResultSummary[]> {
  if (!fs.existsSync(outputDir)) {
    return [];
  }

  const entries = await readdir(outputDir, { withFileTypes: true });
  const results: StoredBenchmarkResultSummary[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }

    const filePath = path.join(outputDir, entry.name);
    try {
      const result = await loadBenchmarkResult(filePath);
      results.push(toSummary(result, filePath));
    } catch {
      continue;
    }
  }

  return results.sort(compareResultSummaries);
}

export async function saveBenchmarkBaseline(
  baselineDir: string,
  name: string,
  result: BenchmarkResult,
  source?: {
    id: string;
    path: string;
  },
): Promise<string> {
  assertValidBaselineName(name);
  assertUsableBaselineDir(baselineDir);
  await mkdir(baselineDir, { recursive: true });

  const filePath = path.join(baselineDir, `${name}.json`);
  const payload: StoredBenchmarkBaseline = {
    name,
    savedAt: new Date().toISOString(),
    result,
    source,
  };
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`);
  return filePath;
}

export async function loadBenchmarkBaseline(
  filePath: string,
): Promise<StoredBenchmarkBaseline> {
  const content = await readFile(filePath, "utf8");
  const parsed: unknown = JSON.parse(content);
  if (!isStoredBenchmarkBaseline(parsed)) {
    throw new Error(`Invalid benchmark baseline file: ${filePath}`);
  }
  return parsed;
}

export async function listBenchmarkBaselines(
  baselineDir: string,
): Promise<StoredBenchmarkBaselineSummary[]> {
  if (!fs.existsSync(baselineDir)) {
    return [];
  }

  assertUsableBaselineDir(baselineDir);
  const entries = await readdir(baselineDir, { withFileTypes: true });
  const baselines: StoredBenchmarkBaselineSummary[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }

    const filePath = path.join(baselineDir, entry.name);
    try {
      const baseline = await loadBenchmarkBaseline(filePath);
      baselines.push(toBaselineSummary(baseline, filePath));
    } catch {
      continue;
    }
  }

  return baselines.sort(compareBaselineSummaries);
}

export async function resolveBenchmarkResultReference(
  outputDir: string,
  reference: string,
): Promise<StoredBenchmarkResultSummary | undefined> {
  // Store-first resolution keeps `runs show <id>` deterministic: a
  // bare identifier always maps to the stored run rather than an
  // unrelated file in the current working directory that happens to
  // share the same name. Only fall back to the filesystem when the
  // reference is unambiguously path-shaped.
  const summaries = await listBenchmarkResults(outputDir);
  const exactIdMatch = summaries.find((summary) => summary.id === reference);
  if (exactIdMatch) {
    return exactIdMatch;
  }

  const basenameMatch = summaries.find(
    (summary) => path.basename(summary.path) === reference,
  );
  if (basenameMatch) {
    return basenameMatch;
  }

  if (looksLikeFilesystemPath(reference) && fs.existsSync(reference)) {
    try {
      const result = await loadBenchmarkResult(reference);
      return toSummary(result, reference);
    } catch {
      return undefined;
    }
  }

  return undefined;
}

// A reference is treated as a filesystem path only when it looks like
// one — absolute, contains a path separator, or points to a .json file.
// Bare identifiers (e.g. run IDs) stay scoped to the store.
function looksLikeFilesystemPath(reference: string): boolean {
  return (
    path.isAbsolute(reference) ||
    reference.includes("/") ||
    reference.includes(path.sep) ||
    reference.endsWith(".json")
  );
}

export async function deleteBenchmarkResults(
  outputDir: string,
  references: string[],
): Promise<{
  deleted: StoredBenchmarkResultSummary[];
  missing: string[];
}> {
  const summaries = await listBenchmarkResults(outputDir);
  const deleted: StoredBenchmarkResultSummary[] = [];
  const missing: string[] = [];
  const seenPaths = new Set<string>();

  for (const reference of references) {
    // Resolve stored-run references first (by id or basename) so
    // `remnic bench runs delete <id>` never unlinks an unrelated file
    // that happens to share the same name in the current working
    // directory. Only fall back to treating the reference as a direct
    // filesystem path when it is unambiguously path-shaped or no
    // stored run matches.
    let summary: StoredBenchmarkResultSummary | undefined =
      summaries.find((entry) => entry.id === reference) ??
      summaries.find((entry) => path.basename(entry.path) === reference);

    if (!summary && looksLikeFilesystemPath(reference)) {
      // If we've already deleted the file this path points at earlier
      // in the same batch, treat a repeat reference as a duplicate —
      // not a missing run — so multi-ref automation that mixes id and
      // path aliases for the same run still exits cleanly.
      const canonicalRef = path.resolve(reference);
      if (seenPaths.has(canonicalRef)) {
        continue;
      }
      if (fs.existsSync(reference)) {
        try {
          const result = await loadBenchmarkResult(reference);
          summary = toSummary(result, reference);
        } catch {
          summary = undefined;
        }
      }
    }
    if (!summary) {
      missing.push(reference);
      continue;
    }
    // Canonicalize before dedupe so a relative path and an absolute
    // path that point at the same file collapse to a single key.
    const canonicalPath = path.resolve(summary.path);
    if (seenPaths.has(canonicalPath)) {
      continue;
    }
    seenPaths.add(canonicalPath);

    try {
      await unlink(summary.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        // Already removed (e.g. by a concurrent delete) — treat as success.
      } else {
        throw error;
      }
    }
    deleted.push(summary);
  }

  return { deleted, missing };
}

function comparePublishedBenchmarkEntries(
  left: PublishedBenchmarkFeedEntry,
  right: PublishedBenchmarkFeedEntry,
): number {
  if (left.timestamp === right.timestamp) {
    return left.benchmark.localeCompare(right.benchmark);
  }
  return right.timestamp.localeCompare(left.timestamp);
}

function isPublishableResultForTarget(
  result: BenchmarkResult,
  target: BenchmarkPublishTarget,
): boolean {
  switch (target) {
    case "remnic-ai":
      return result.meta.benchmarkTier === "published" && result.meta.mode === "full";
  }
}

/**
 * Throws if the result is missing any required integrity field. Called
 * explicitly by tooling (e.g. `remnic bench publish --strict`) that needs to
 * surface integrity gaps as errors rather than silently skipping the run.
 * The feed builder uses `isResultPublishable` below to filter non-fatal
 * conditions (public split, missing integrity) so a single bad result does
 * not block publishing older, valid holdout runs.
 */
export function assertPublishableIntegrity(
  result: BenchmarkResult,
  target: BenchmarkPublishTarget,
): void {
  assertIntegrityMetaPresent(result.meta);
  if (target === "remnic-ai" && result.meta.splitType !== "holdout") {
    throw new Error(
      `Published leaderboard only accepts holdout-split results; got splitType="${String(result.meta.splitType)}".`,
    );
  }
}

export type PublishSkipReason =
  | "missing-integrity"
  | "non-holdout-split"
  | "contaminated-dataset";

export interface PublishSkipRecord {
  resultId: string;
  path: string;
  reason: PublishSkipReason;
  detail: string;
}

/**
 * Decide whether a single result should contribute to a published feed for
 * the given target. Returns `null` when the result is publishable; otherwise
 * returns a structured skip reason. Called per-result so newer results with
 * missing/public metadata do not block older valid holdout runs for the same
 * benchmark.
 */
function classifyPublishCandidate(
  result: BenchmarkResult,
  target: BenchmarkPublishTarget,
  contaminationManifest: ContaminationManifest,
): PublishSkipRecord | null {
  if (!integrityMetaIsComplete(result.meta)) {
    return {
      resultId: result.meta.id,
      path: "",
      reason: "missing-integrity",
      detail: "Result is missing one or more required integrity fields.",
    };
  }

  if (target === "remnic-ai" && result.meta.splitType !== "holdout") {
    return {
      resultId: result.meta.id,
      path: "",
      reason: "non-holdout-split",
      detail: `Leaderboard only accepts holdout-split results; got "${result.meta.splitType}".`,
    };
  }

  const contamination = checkDatasetContamination(
    result.meta.datasetHash,
    contaminationManifest,
  );
  if (!contamination.clean) {
    return {
      resultId: result.meta.id,
      path: "",
      reason: "contaminated-dataset",
      detail: `datasetHash ${result.meta.datasetHash} appears on the contamination manifest (${contamination.matched?.reason ?? "unspecified reason"}).`,
    };
  }

  return null;
}

function toPublishedBenchmarkFeedEntry(
  result: BenchmarkResult,
  provenance: ReportCardProvenanceContext,
): PublishedBenchmarkFeedEntry {
  if (!integrityMetaIsComplete(result.meta)) {
    throw new Error(
      "toPublishedBenchmarkFeedEntry called with a result missing integrity metadata; call assertPublishableIntegrity first.",
    );
  }

  return {
    benchmark: result.meta.benchmark,
    benchmarkTier: result.meta.benchmarkTier,
    resultId: result.meta.id,
    timestamp: result.meta.timestamp,
    mode: result.meta.mode,
    remnicVersion: result.meta.remnicVersion,
    gitSha: result.meta.gitSha,
    taskCount: result.results.tasks.length,
    aggregateMetrics: result.results.aggregates,
    cost: result.cost,
    environment: result.environment,
    reportCardHtml: renderMemoryReportCard(result, provenance),
    integrity: {
      splitType: result.meta.splitType,
      qrelsSealedHash: result.meta.qrelsSealedHash,
      judgePromptHash: result.meta.judgePromptHash,
      datasetHash: result.meta.datasetHash,
      ...(result.meta.canaryScore !== undefined
        ? { canaryScore: result.meta.canaryScore }
        : {}),
    },
  };
}

export async function buildBenchmarkPublishFeed(
  outputDir: string,
  target: BenchmarkPublishTarget,
  options: BuildBenchmarkPublishFeedOptions = {},
): Promise<PublishedBenchmarkFeed> {
  const summaries = await listBenchmarkResults(outputDir);
  const contaminationManifest =
    options.contaminationManifest ?? EMPTY_CONTAMINATION_MANIFEST;
  const latestByBenchmark = new Map<string, PublishedBenchmarkFeedEntry>();
  const skipped: PublishSkipRecord[] = [];

  for (const summary of summaries) {
    if (latestByBenchmark.has(summary.benchmark)) {
      continue;
    }

    const result = await loadBenchmarkResult(summary.path);
    if (!isPublishableResultForTarget(result, target)) {
      continue;
    }

    // Classify rather than throw so a newer public-split / missing-integrity
    // result does NOT block older, valid holdout runs for the same benchmark
    // from reaching the leaderboard.
    const skip = classifyPublishCandidate(result, target, contaminationManifest);
    if (skip) {
      skipped.push({ ...skip, path: summary.path });
      continue;
    }

    const provenance = await loadBenchmarkReportCardProvenance(
      outputDir,
      result.meta.id,
    );
    latestByBenchmark.set(
      summary.benchmark,
      toPublishedBenchmarkFeedEntry(result, provenance),
    );
  }

  return {
    target,
    generatedAt: new Date().toISOString(),
    benchmarks: [...latestByBenchmark.values()].sort(comparePublishedBenchmarkEntries),
    skipped,
  };
}

export async function writeBenchmarkPublishFeed(
  feed: PublishedBenchmarkFeed,
  outputPath: string,
): Promise<string> {
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(feed, null, 2)}\n`);
  return outputPath;
}

function csvEscape(value: string | number): string {
  const text = String(value);
  if (/[",\n]/.test(text)) {
    return `"${text.replaceAll(`"`, `""`)}"`;
  }
  return text;
}

export function renderBenchmarkResultExport(
  result: BenchmarkResult,
  format: BenchmarkExportFormat,
  options: { reportCardProvenance?: ReportCardProvenanceContext } = {},
): string {
  if (format === "json") {
    return `${JSON.stringify(result, null, 2)}\n`;
  }

  if (format === "html") {
    return renderMemoryReportCard(result, options.reportCardProvenance);
  }

  const rows = [
    [
      "result_id",
      "benchmark",
      "timestamp",
      "mode",
      "metric",
      "mean",
      "median",
      "std_dev",
      "min",
      "max",
    ].join(","),
  ];

  for (const metric of Object.keys(result.results.aggregates).sort()) {
    const aggregate = result.results.aggregates[metric]!;
    rows.push([
      result.meta.id,
      result.meta.benchmark,
      result.meta.timestamp,
      result.meta.mode,
      metric,
      aggregate.mean,
      aggregate.median,
      aggregate.stdDev,
      aggregate.min,
      aggregate.max,
    ].map(csvEscape).join(","));
  }

  return `${rows.join("\n")}\n`;
}
