#!/usr/bin/env -S npx tsx
/**
 * Verify that a stored benchmark result directory contains reproducible
 * evidence for the full published public benchmark matrix.
 *
 * This is intentionally stricter than schema validation. It checks the
 * run envelope required for current public-matrix claims: full mode,
 * real runtime, current git SHA, Codex CLI gpt-5.5, xhigh reasoning,
 * fast service tier diagnostics, hashed datasets, and complete results.
 *
 * It does not prove SOTA by itself; benchmark-specific comparative
 * evidence still needs to be reviewed separately.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { PUBLISHED_BENCHMARK_ARTIFACT_IDS } from "../../packages/bench/src/published-artifact.ts";
import {
  listBenchmarkResults,
  loadBenchmarkResult,
} from "../../packages/bench/src/results-store.ts";
import type {
  BenchmarkResult,
  BenchReasoningEffort,
  BenchRuntimeProfile,
  ProviderConfig,
} from "../../packages/bench/src/types.ts";

const DEFAULT_MODEL = "gpt-5.5";
const DEFAULT_REASONING_EFFORT: BenchReasoningEffort = "xhigh";
const DEFAULT_SERVICE_TIER = "fast";
const DEFAULT_RUNTIME_PROFILE: BenchRuntimeProfile = "real";
const MANIFEST_FILENAME = "MANIFEST.json";

type ProviderRole = "systemProvider" | "judgeProvider" | "internalProvider";

interface CodexDiagnosticRecord {
  runId?: string;
  provider?: string;
  model?: string;
  reasoningEffort?: string;
  serviceTier?: string;
  error?: string;
  result?: {
    status?: number | null;
    signal?: string | null;
  };
}

interface ReproManifest {
  schemaVersion?: number;
  generatedAt?: string;
  git?: {
    commit?: string;
    shortCommit?: string;
    dirty?: boolean;
  };
  run?: {
    id?: string;
    mode?: string;
    runtimeProfiles?: string[];
    selectedBenchmarks?: string[];
    selectedWorkItems?: Array<{
      benchmark?: string;
      runtimeProfile?: string;
    }>;
    limit?: number;
    seed?: number;
  };
  datasets?: Array<{
    benchmark?: string;
    status?: string;
    fileCount?: number;
    sha256?: string;
  }>;
  results?: Array<{
    benchmark?: string;
    path?: string;
    sha256?: string;
    resultId?: string;
    mode?: string;
    gitSha?: string;
    taskCount?: number;
  }>;
  command?: {
    argv?: string[];
    envKeys?: string[];
  };
  environment?: {
    platform?: string;
    arch?: string;
    nodeVersion?: string;
    packageManager?: string;
  };
  qmd?: unknown;
  configFiles?: unknown;
  artifactHash?: string;
}

type ReproManifestResult = NonNullable<ReproManifest["results"]>[number];

interface ManifestResultResolution {
  entry: ReproManifestResult;
  path: string;
}

export interface PublicMatrixEvidenceIssue {
  code: string;
  message: string;
  benchmark?: string;
  path?: string;
}

export interface PublicMatrixEvidenceRow {
  benchmark: string;
  resultPath?: string;
  resultId?: string;
  taskCount?: number;
  diagnosticsChecked?: number;
}

export interface PublicMatrixEvidenceReport {
  ok: boolean;
  issues: PublicMatrixEvidenceIssue[];
  rows: PublicMatrixEvidenceRow[];
}

export interface VerifyPublicMatrixEvidenceOptions {
  resultsDir: string;
  benchmarks?: readonly string[];
  diagnosticsDir?: string;
  manifestPath?: string;
  requireManifest?: boolean;
  requireDiagnostics?: boolean;
  requireInternalProvider?: boolean;
  expectedModel?: string;
  expectedReasoningEffort?: BenchReasoningEffort;
  expectedServiceTier?: string;
  expectedRuntimeProfile?: BenchRuntimeProfile;
  expectedGitSha?: string;
  skipGitSha?: boolean;
}

export async function verifyPublicMatrixEvidence(
  options: VerifyPublicMatrixEvidenceOptions,
): Promise<PublicMatrixEvidenceReport> {
  const expectedModel = options.expectedModel ?? DEFAULT_MODEL;
  const expectedReasoningEffort =
    options.expectedReasoningEffort ?? DEFAULT_REASONING_EFFORT;
  const expectedServiceTier = options.expectedServiceTier ?? DEFAULT_SERVICE_TIER;
  const expectedRuntimeProfile =
    options.expectedRuntimeProfile ?? DEFAULT_RUNTIME_PROFILE;
  const issues: PublicMatrixEvidenceIssue[] = [];
  const expectedGitSha = resolveExpectedGitSha(options, issues);
  const benchmarks = resolveBenchmarks(options.benchmarks);
  const resultsDir = path.resolve(expandHome(options.resultsDir));
  const diagnosticsDir = path.resolve(
    expandHome(options.diagnosticsDir ?? path.join(resultsDir, "codex-cli-diagnostics")),
  );
  const manifestPath = path.resolve(
    expandHome(options.manifestPath ?? path.join(resultsDir, MANIFEST_FILENAME)),
  );
  const rows: PublicMatrixEvidenceRow[] = benchmarks.map((benchmark) => ({
    benchmark,
  }));
  const requireManifest = options.requireManifest ?? true;
  const manifest = requireManifest
    ? await loadReproManifest(manifestPath, issues)
    : undefined;

  if (requireManifest && manifest) {
    validateManifest(manifest, manifestPath, {
      benchmarks,
      expectedGitSha,
      expectedRuntimeProfile,
      issues,
    });
  }

  const summaries = requireManifest ? [] : await listBenchmarkResults(resultsDir);
  for (const row of rows) {
    const manifestResult = manifest
      ? await resolveManifestResult(
          resultsDir,
          manifest,
          row.benchmark,
          expectedRuntimeProfile,
          issues,
        )
      : undefined;
    const resultPath = manifest
      ? manifestResult?.path
      : resolveLatestResultPath(summaries, row.benchmark);
    if (!resultPath) {
      if (!manifest) {
        issues.push({
          code: "missing-full-result",
          benchmark: row.benchmark,
          message: `No full-mode result found for ${row.benchmark}.`,
        });
      }
      continue;
    }

    row.resultPath = resultPath;
    if (manifestResult) {
      await validateManifestResultFile(manifestResult.entry, resultPath, row.benchmark, issues);
    }
    let result: BenchmarkResult;
    try {
      result = await loadBenchmarkResult(resultPath);
    } catch (error) {
      issues.push({
        code: "manifest-result-unreadable",
        benchmark: row.benchmark,
        path: resultPath,
        message: `Could not load manifest result: ${error instanceof Error ? error.message : String(error)}.`,
      });
      continue;
    }

    row.resultId = result.meta.id;
    row.taskCount = result.results.tasks.length;
    if (manifestResult) {
      validateManifestResultIdentity(manifestResult.entry, result, resultPath, issues);
    }
    if (result.meta.benchmark !== row.benchmark) {
      addIssue(
        issues,
        row.benchmark,
        resultPath,
        "manifest-result-benchmark-mismatch",
        `Manifest entry for ${row.benchmark} points to result for ${result.meta.benchmark}.`,
      );
    }
    validateResultEnvelope(result, resultPath, {
      expectedModel,
      expectedReasoningEffort,
      expectedRuntimeProfile,
      expectedGitSha,
      requireInternalProvider: options.requireInternalProvider ?? true,
      issues,
    });
  }

  if (options.requireDiagnostics ?? true) {
    const diagnosticsChecked = await validateDiagnostics(diagnosticsDir, {
      expectedRunId: isNonEmptyString(manifest?.run?.id)
        ? manifest.run.id.trim()
        : undefined,
      requireRunId: requireManifest,
      expectedModel,
      expectedReasoningEffort,
      expectedServiceTier,
      issues,
    });
    for (const row of rows) {
      row.diagnosticsChecked = diagnosticsChecked;
    }
  }

  return {
    ok: issues.length === 0,
    issues,
    rows,
  };
}

function validateResultEnvelope(
  result: BenchmarkResult,
  resultPath: string,
  options: {
    expectedModel: string;
    expectedReasoningEffort: BenchReasoningEffort;
    expectedRuntimeProfile: BenchRuntimeProfile;
    expectedGitSha: string | undefined;
    requireInternalProvider: boolean;
    issues: PublicMatrixEvidenceIssue[];
  },
): void {
  const benchmark = result.meta.benchmark;
  if (result.meta.benchmarkTier !== "published") {
    addIssue(options.issues, benchmark, resultPath, "not-published-tier", `Expected published tier, got ${result.meta.benchmarkTier}.`);
  }
  if (result.meta.mode !== "full") {
    addIssue(options.issues, benchmark, resultPath, "not-full-mode", `Expected full mode, got ${result.meta.mode}.`);
  }
  if (result.meta.status === "partial") {
    addIssue(options.issues, benchmark, resultPath, "partial-result", `Result is partial: ${result.meta.failureReason ?? "unknown failure"}.`);
  }
  if (result.config.runtimeProfile !== options.expectedRuntimeProfile) {
    addIssue(options.issues, benchmark, resultPath, "wrong-runtime-profile", `Expected runtimeProfile=${options.expectedRuntimeProfile}, got ${String(result.config.runtimeProfile)}.`);
  }
  if (options.expectedGitSha && !gitShaMatches(result.meta.gitSha, options.expectedGitSha)) {
    addIssue(options.issues, benchmark, resultPath, "wrong-git-sha", `Expected gitSha matching ${options.expectedGitSha}, got ${result.meta.gitSha}.`);
  }
  if (result.results.tasks.length === 0) {
    addIssue(options.issues, benchmark, resultPath, "empty-task-set", "Result has no per-task scores.");
  }
  if (Object.keys(result.results.aggregates).length === 0) {
    addIssue(options.issues, benchmark, resultPath, "empty-aggregates", "Result has no aggregate metrics.");
  }
  validateTaskScores(result, resultPath, options.issues);
  validateFullDatasetRunOptions(
    benchmark,
    resultPath,
    result.config.benchmarkOptions,
    options.issues,
  );
  for (const [metric, aggregate] of Object.entries(result.results.aggregates)) {
    if (!Number.isFinite(aggregate.mean)) {
      addIssue(options.issues, benchmark, resultPath, "non-finite-metric", `Aggregate ${metric}.mean is not finite.`);
    } else if (aggregate.mean < 0) {
      addIssue(
        options.issues,
        benchmark,
        resultPath,
        "negative-aggregate-metric",
        `Aggregate ${metric}.mean is negative (${aggregate.mean}); public evidence must not contain failure sentinels.`,
      );
    } else if (metric === "official_protocol_ready" && aggregate.mean < 1) {
      addIssue(
        options.issues,
        benchmark,
        resultPath,
        "official-protocol-not-ready",
        `Aggregate ${metric}.mean is ${aggregate.mean}; public evidence must include official protocol scoring.`,
      );
    }
  }

  validateProviderRole(result, resultPath, "systemProvider", result.config.systemProvider, options);
  validateProviderRole(result, resultPath, "judgeProvider", result.config.judgeProvider, options);
  if (options.requireInternalProvider || result.config.internalProvider) {
    validateProviderRole(result, resultPath, "internalProvider", result.config.internalProvider ?? null, options);
  }
}

function buildManifestArtifactHashIdentity(manifest: ReproManifest): unknown {
  return {
    schemaVersion: manifest.schemaVersion,
    run: {
      id: manifest.run?.id,
      ...(manifest.run?.mode ? { mode: manifest.run.mode } : {}),
      selectedBenchmarks: manifest.run?.selectedBenchmarks,
      runtimeProfiles: manifest.run?.runtimeProfiles,
      selectedWorkItems: manifest.run?.selectedWorkItems,
      ...(manifest.run && Object.prototype.hasOwnProperty.call(manifest.run, "limit")
        ? { limit: manifest.run.limit }
        : {}),
      ...(manifest.run && Object.prototype.hasOwnProperty.call(manifest.run, "seed")
        ? { seed: manifest.run.seed }
        : {}),
    },
    git: {
      commit: manifest.git?.commit,
      shortCommit: manifest.git?.shortCommit,
    },
    command: {
      argv: manifest.command?.argv,
      envKeys: manifest.command?.envKeys,
    },
    environment: {
      platform: manifest.environment?.platform,
      arch: manifest.environment?.arch,
      nodeVersion: manifest.environment?.nodeVersion,
      ...(manifest.environment?.packageManager
        ? { packageManager: manifest.environment.packageManager }
        : {}),
    },
    ...(manifest.qmd ? { qmd: manifest.qmd } : {}),
    configFiles: manifest.configFiles,
    datasets: manifest.datasets,
    results: manifest.results,
  };
}

function validateTaskScores(
  result: BenchmarkResult,
  resultPath: string,
  issues: PublicMatrixEvidenceIssue[],
): void {
  const benchmark = result.meta.benchmark;
  for (const task of result.results.tasks) {
    const error = task.details?.error;
    if (typeof error === "string" && error.trim().length > 0) {
      addIssue(
        issues,
        benchmark,
        resultPath,
        "task-error",
        `Task ${task.taskId} includes an error detail: ${error.trim()}.`,
      );
    }
    for (const [metric, score] of Object.entries(task.scores)) {
      if (!Number.isFinite(score)) {
        addIssue(
          issues,
          benchmark,
          resultPath,
          "non-finite-task-score",
          `Task ${task.taskId} metric ${metric} is not finite.`,
        );
        continue;
      }
      if (score < 0) {
        addIssue(
          issues,
          benchmark,
          resultPath,
          "negative-task-score",
          `Task ${task.taskId} metric ${metric} is negative (${score}); public evidence must not contain failure sentinels.`,
        );
        continue;
      }
      if (metric === "official_protocol_ready" && score < 1) {
        addIssue(
          issues,
          benchmark,
          resultPath,
          "official-protocol-not-ready",
          `Task ${task.taskId} metric ${metric} is ${score}; public evidence must include official protocol scoring.`,
        );
      }
    }
  }
}

function validateFullDatasetRunOptions(
  benchmark: string,
  resultPath: string,
  benchmarkOptions: BenchmarkResult["config"]["benchmarkOptions"],
  issues: PublicMatrixEvidenceIssue[],
): void {
  if (!benchmarkOptions || typeof benchmarkOptions !== "object") {
    return;
  }
  const disallowedKeys = ["limit", "trialLimit", "taskFilter"] as const;
  for (const key of disallowedKeys) {
    if (Object.prototype.hasOwnProperty.call(benchmarkOptions, key)) {
      addIssue(
        issues,
        benchmark,
        resultPath,
        "limited-result",
        `Full public-matrix evidence must not use benchmarkOptions.${key}.`,
      );
    }
  }
}

function validateProviderRole(
  result: BenchmarkResult,
  resultPath: string,
  role: ProviderRole,
  provider: ProviderConfig | null,
  options: {
    expectedModel: string;
    expectedReasoningEffort: BenchReasoningEffort;
    issues: PublicMatrixEvidenceIssue[];
  },
): void {
  const benchmark = result.meta.benchmark;
  if (!provider) {
    addIssue(options.issues, benchmark, resultPath, `missing-${role}`, `${role} is missing.`);
    return;
  }
  if (provider.provider !== "codex-cli") {
    addIssue(options.issues, benchmark, resultPath, `wrong-${role}-provider`, `${role}.provider must be codex-cli, got ${provider.provider}.`);
  }
  if (provider.model !== options.expectedModel) {
    addIssue(options.issues, benchmark, resultPath, `wrong-${role}-model`, `${role}.model must be ${options.expectedModel}, got ${provider.model}.`);
  }
  if (provider.reasoningEffort !== options.expectedReasoningEffort) {
    addIssue(options.issues, benchmark, resultPath, `wrong-${role}-reasoning`, `${role}.reasoningEffort must be ${options.expectedReasoningEffort}, got ${String(provider.reasoningEffort)}.`);
  }
}

async function loadReproManifest(
  manifestPath: string,
  issues: PublicMatrixEvidenceIssue[],
): Promise<ReproManifest | undefined> {
  if (!fs.existsSync(manifestPath)) {
    issues.push({
      code: "missing-manifest",
      path: manifestPath,
      message: `Repro manifest not found: ${manifestPath}.`,
    });
    return undefined;
  }

  try {
    return JSON.parse(await readFile(manifestPath, "utf8")) as ReproManifest;
  } catch (error) {
    issues.push({
      code: "invalid-manifest",
      path: manifestPath,
      message: `Could not parse repro manifest: ${error instanceof Error ? error.message : String(error)}.`,
    });
    return undefined;
  }
}

function validateManifest(
  manifest: ReproManifest,
  manifestPath: string,
  options: {
    benchmarks: string[];
    expectedGitSha: string | undefined;
    expectedRuntimeProfile: BenchRuntimeProfile;
    issues: PublicMatrixEvidenceIssue[];
  },
): void {
  if (!isSha256(manifest.artifactHash)) {
    options.issues.push({
      code: "manifest-missing-artifact-hash",
      path: manifestPath,
      message: "Repro manifest must include a SHA-256 artifactHash before diagnostics can be trusted.",
    });
  } else {
    const actualArtifactHash = sha256String(
      stableStringify(buildManifestArtifactHashIdentity(manifest)),
    );
    if (actualArtifactHash !== manifest.artifactHash.toLowerCase()) {
      options.issues.push({
        code: "manifest-artifact-hash-mismatch",
        path: manifestPath,
        message: `Manifest artifactHash mismatch: expected ${manifest.artifactHash.toLowerCase()}, got ${actualArtifactHash}.`,
      });
    }
  }
  if (manifest.git?.dirty !== false) {
    options.issues.push({
      code: "dirty-manifest-git",
      path: manifestPath,
      message: "Repro manifest was generated from a dirty worktree.",
    });
  }
  if (options.expectedGitSha && !gitShaMatches(manifest.git?.commit ?? manifest.git?.shortCommit ?? "", options.expectedGitSha)) {
    options.issues.push({
      code: "wrong-manifest-git",
      path: manifestPath,
      message: `Expected manifest git to match ${options.expectedGitSha}, got ${manifest.git?.commit ?? manifest.git?.shortCommit ?? "<missing>"}.`,
    });
  }
  if (manifest.run?.mode !== "full") {
    options.issues.push({
      code: "manifest-not-full-mode",
      path: manifestPath,
      message: `Expected manifest run.mode=full, got ${String(manifest.run?.mode)}.`,
    });
  }
  if (!isNonEmptyString(manifest.run?.id)) {
    options.issues.push({
      code: "manifest-missing-run-id",
      path: manifestPath,
      message: "Repro manifest must record run.id so shared Codex diagnostics can be scoped to this run.",
    });
  }
  if (manifest.run && Object.prototype.hasOwnProperty.call(manifest.run, "limit")) {
    options.issues.push({
      code: "manifest-limited-run",
      path: manifestPath,
      message: "Repro manifest records run.limit; full public-matrix evidence must use the full dataset.",
    });
  }
  if (!manifest.run?.runtimeProfiles?.includes(options.expectedRuntimeProfile)) {
    options.issues.push({
      code: "manifest-missing-runtime-profile",
      path: manifestPath,
      message: `Expected manifest runtimeProfiles to include ${options.expectedRuntimeProfile}.`,
    });
  }

  for (const benchmark of options.benchmarks) {
    const dataset = manifest.datasets?.find((entry) => entry.benchmark === benchmark);
    if (!dataset) {
      addIssue(options.issues, benchmark, manifestPath, "manifest-missing-dataset", "Manifest has no dataset entry for benchmark.");
    } else if (
      dataset.status !== "hashed" ||
      !isSha256(dataset.sha256) ||
      !Number.isInteger(dataset.fileCount) ||
      dataset.fileCount <= 0
    ) {
      addIssue(options.issues, benchmark, manifestPath, "manifest-dataset-not-hashed", `Dataset entry must be hashed with files; got status=${String(dataset.status)} fileCount=${String(dataset.fileCount)}.`);
    }

    const result = manifest.results?.find((entry) => entry.benchmark === benchmark);
    if (!result) {
      addIssue(options.issues, benchmark, manifestPath, "manifest-missing-result", "Manifest has no result entry for benchmark.");
    } else if (!isNonEmptyString(result.path)) {
      addIssue(options.issues, benchmark, manifestPath, "manifest-result-missing-path", "Manifest result entry must include a relative result path.");
    } else if (
      result.mode !== "full" ||
      !Number.isInteger(result.taskCount) ||
      result.taskCount <= 0
    ) {
      addIssue(options.issues, benchmark, manifestPath, "manifest-result-not-full", `Manifest result must be full with tasks; got mode=${String(result.mode)} taskCount=${String(result.taskCount)}.`);
    } else if (options.expectedGitSha && !gitShaMatches(result.gitSha ?? "", options.expectedGitSha)) {
      addIssue(options.issues, benchmark, manifestPath, "manifest-result-wrong-git", `Expected manifest result git to match ${options.expectedGitSha}, got ${String(result.gitSha)}.`);
    }
  }
}

async function resolveManifestResult(
  resultsDir: string,
  manifest: ReproManifest,
  benchmark: string,
  expectedRuntimeProfile: BenchRuntimeProfile,
  issues: PublicMatrixEvidenceIssue[],
): Promise<ManifestResultResolution | undefined> {
  const candidates = manifest.results?.filter((entry) => entry.benchmark === benchmark) ?? [];
  if (candidates.length === 0) {
    return undefined;
  }

  const candidateResults: ManifestResultResolution[] = [];
  for (const result of candidates) {
    if (!isNonEmptyString(result.path)) {
      continue;
    }
    const resolvedPath = resolveManifestEntryPath(
      resultsDir,
      benchmark,
      result.path,
      issues,
    );
    if (resolvedPath) {
      candidateResults.push({ entry: result, path: resolvedPath });
    }
  }
  if (candidateResults.length === 0) {
    return undefined;
  }

  for (const candidate of candidateResults) {
    try {
      const result = await loadBenchmarkResult(candidate.path);
      if (result.config.runtimeProfile === expectedRuntimeProfile) {
        return candidate;
      }
    } catch {
      continue;
    }
  }
  return candidateResults[0];
}

async function validateManifestResultFile(
  entry: ReproManifestResult,
  resultPath: string,
  benchmark: string,
  issues: PublicMatrixEvidenceIssue[],
): Promise<void> {
  if (!isSha256(entry.sha256)) {
    addIssue(
      issues,
      benchmark,
      resultPath,
      "manifest-result-missing-hash",
      "Manifest result entry must include the SHA-256 hash of the result file.",
    );
    return;
  }

  let actualHash: string;
  try {
    actualHash = await sha256File(resultPath);
  } catch (error) {
    addIssue(
      issues,
      benchmark,
      resultPath,
      "manifest-result-hash-unreadable",
      `Could not hash manifest result file: ${error instanceof Error ? error.message : String(error)}.`,
    );
    return;
  }

  const expectedHash = entry.sha256.toLowerCase();
  if (actualHash !== expectedHash) {
    addIssue(
      issues,
      benchmark,
      resultPath,
      "manifest-result-hash-mismatch",
      `Manifest result hash mismatch: expected ${expectedHash}, got ${actualHash}.`,
    );
  }
}

function validateManifestResultIdentity(
  entry: ReproManifestResult,
  result: BenchmarkResult,
  resultPath: string,
  issues: PublicMatrixEvidenceIssue[],
): void {
  if (!isNonEmptyString(entry.resultId)) {
    addIssue(
      issues,
      result.meta.benchmark,
      resultPath,
      "manifest-result-missing-id",
      "Manifest result entry must include resultId.",
    );
    return;
  }

  if (entry.resultId !== result.meta.id) {
    addIssue(
      issues,
      result.meta.benchmark,
      resultPath,
      "manifest-result-id-mismatch",
      `Manifest resultId ${entry.resultId} does not match loaded result id ${result.meta.id}.`,
    );
  }
}

function resolveManifestEntryPath(
  resultsDir: string,
  benchmark: string,
  manifestPath: string,
  issues: PublicMatrixEvidenceIssue[],
): string | undefined {
  if (path.isAbsolute(manifestPath)) {
    addIssue(
      issues,
      benchmark,
      manifestPath,
      "manifest-result-absolute-path",
      "Manifest result path must be relative to the results directory.",
    );
    return undefined;
  }

  const resolvedPath = path.resolve(resultsDir, manifestPath);
  const relativePath = path.relative(resultsDir, resolvedPath);
  if (
    relativePath.startsWith("..") ||
    path.isAbsolute(relativePath) ||
    relativePath.length === 0
  ) {
    addIssue(
      issues,
      benchmark,
      resolvedPath,
      "manifest-result-path-outside-dir",
      "Manifest result path must stay inside the results directory.",
    );
    return undefined;
  }
  return resolvedPath;
}

function resolveLatestResultPath(
  summaries: Awaited<ReturnType<typeof listBenchmarkResults>>,
  benchmark: string,
): string | undefined {
  return summaries
    .filter((candidate) => candidate.benchmark === benchmark)
    .filter((candidate) => candidate.mode === "full")
    .sort((left, right) => right.timestamp.localeCompare(left.timestamp))[0]
    ?.path;
}

async function validateDiagnostics(
  diagnosticsDir: string,
  options: {
    expectedRunId: string | undefined;
    requireRunId: boolean;
    expectedModel: string;
    expectedReasoningEffort: BenchReasoningEffort;
    expectedServiceTier: string;
    issues: PublicMatrixEvidenceIssue[];
  },
): Promise<number> {
  if (!fs.existsSync(diagnosticsDir)) {
    options.issues.push({
      code: "missing-codex-diagnostics",
      path: diagnosticsDir,
      message: `Codex CLI diagnostics directory not found: ${diagnosticsDir}.`,
    });
    return 0;
  }

  const files = (await readdir(diagnosticsDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => path.join(diagnosticsDir, entry.name))
    .sort((left, right) => left.localeCompare(right));
  if (files.length === 0) {
    options.issues.push({
      code: "empty-codex-diagnostics",
      path: diagnosticsDir,
      message: "Codex CLI diagnostics directory contains no JSON records.",
    });
    return 0;
  }
  if (options.requireRunId && !options.expectedRunId) {
    options.issues.push({
      code: "missing-diagnostic-run-id",
      path: diagnosticsDir,
      message: "Cannot validate shared Codex CLI diagnostics without manifest run.id. Regenerate evidence with a current MANIFEST.json or pass --no-manifest with an explicit diagnostics directory.",
    });
    return 0;
  }

  let checked = 0;
  for (const file of files) {
    let record: CodexDiagnosticRecord;
    try {
      record = JSON.parse(await readFile(file, "utf8")) as CodexDiagnosticRecord;
    } catch (error) {
      options.issues.push({
        code: "invalid-codex-diagnostic",
        path: file,
        message: `Could not parse diagnostic record: ${error instanceof Error ? error.message : String(error)}.`,
      });
      continue;
    }
    if (options.expectedRunId && record.runId !== options.expectedRunId) {
      continue;
    }
    checked += 1;
    if (record.provider !== "codex-cli") {
      options.issues.push({ code: "wrong-diagnostic-provider", path: file, message: `Expected provider=codex-cli, got ${String(record.provider)}.` });
    }
    if (record.model !== options.expectedModel) {
      options.issues.push({ code: "wrong-diagnostic-model", path: file, message: `Expected model=${options.expectedModel}, got ${String(record.model)}.` });
    }
    if (record.reasoningEffort !== options.expectedReasoningEffort) {
      options.issues.push({ code: "wrong-diagnostic-reasoning", path: file, message: `Expected reasoningEffort=${options.expectedReasoningEffort}, got ${String(record.reasoningEffort)}.` });
    }
    if (record.serviceTier !== options.expectedServiceTier) {
      options.issues.push({ code: "wrong-diagnostic-service-tier", path: file, message: `Expected serviceTier=${options.expectedServiceTier}, got ${String(record.serviceTier)}.` });
    }
    if (record.error) {
      options.issues.push({ code: "diagnostic-error", path: file, message: `Diagnostic captured an error: ${record.error}.` });
    }
    if (record.result?.status !== 0 || record.result?.signal) {
      options.issues.push({ code: "diagnostic-nonzero-exit", path: file, message: `Diagnostic result was status=${String(record.result?.status)} signal=${String(record.result?.signal)}.` });
    }
  }
  if (options.expectedRunId && checked === 0) {
    options.issues.push({
      code: "missing-run-codex-diagnostics",
      path: diagnosticsDir,
      message: `Codex CLI diagnostics directory contains no JSON records for manifest run.id=${options.expectedRunId}.`,
    });
  }
  return checked;
}

function resolveBenchmarks(rawBenchmarks: readonly string[] | undefined): string[] {
  const benchmarks = rawBenchmarks && rawBenchmarks.length > 0
    ? [...new Set(rawBenchmarks.flatMap((entry) => entry.split(",")).map((entry) => entry.trim()).filter(Boolean))]
    : [...PUBLISHED_BENCHMARK_ARTIFACT_IDS];
  const allowed = new Set<string>(PUBLISHED_BENCHMARK_ARTIFACT_IDS);
  const unsupported = benchmarks.filter((benchmark) => !allowed.has(benchmark));
  if (unsupported.length > 0) {
    throw new Error(
      `Unsupported public benchmark id(s): ${unsupported.join(", ")}. Supported: ${PUBLISHED_BENCHMARK_ARTIFACT_IDS.join(", ")}.`,
    );
  }
  return benchmarks;
}

function addIssue(
  issues: PublicMatrixEvidenceIssue[],
  benchmark: string,
  issuePath: string,
  code: string,
  message: string,
): void {
  issues.push({
    code,
    benchmark,
    ...(issuePath ? { path: issuePath } : {}),
    message,
  });
}

function gitShaMatches(actual: string, expected: string): boolean {
  if (!actual || !expected) {
    return false;
  }
  return actual === expected || actual.startsWith(expected) || expected.startsWith(actual);
}

function resolveExpectedGitSha(
  options: VerifyPublicMatrixEvidenceOptions,
  issues: PublicMatrixEvidenceIssue[],
): string | undefined {
  if (options.skipGitSha) {
    return undefined;
  }
  if (options.expectedGitSha !== undefined) {
    return options.expectedGitSha;
  }

  const currentGitSha = resolveCurrentGitSha(process.cwd());
  if (!currentGitSha) {
    issues.push({
      code: "missing-current-git-sha",
      message: "Could not resolve the current git SHA. Run from the repository root, pass --git-sha, or use --skip-git to opt out explicitly.",
    });
  }
  return currentGitSha;
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

async function sha256File(filePath: string): Promise<string> {
  const bytes = await readFile(filePath);
  return createHash("sha256").update(bytes).digest("hex");
}

function sha256String(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function resolveCurrentGitSha(cwd: string): string | undefined {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

function expandHome(value: string): string {
  if (value === "~") {
    return os.homedir();
  }
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

function parseArgs(args: string[]): VerifyPublicMatrixEvidenceOptions & { json: boolean } {
  let resultsDir = path.join(os.homedir(), ".remnic", "bench", "results");
  let diagnosticsDir: string | undefined;
  let manifestPath: string | undefined;
  let requireManifest = true;
  let requireDiagnostics = true;
  let requireInternalProvider = true;
  let expectedModel = DEFAULT_MODEL;
  let expectedReasoningEffort: BenchReasoningEffort = DEFAULT_REASONING_EFFORT;
  let expectedServiceTier = DEFAULT_SERVICE_TIER;
  let expectedRuntimeProfile: BenchRuntimeProfile = DEFAULT_RUNTIME_PROFILE;
  let expectedGitSha: string | undefined;
  let skipGitSha = false;
  let json = false;
  const benchmarks: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    const next = () => {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`${arg} requires a value.`);
      }
      index += 1;
      return value;
    };
    switch (arg) {
      case "--results-dir":
        resultsDir = next();
        break;
      case "--diagnostics-dir":
        diagnosticsDir = next();
        break;
      case "--manifest":
        manifestPath = next();
        break;
      case "--benchmarks":
        benchmarks.push(next());
        break;
      case "--model":
        expectedModel = next();
        break;
      case "--reasoning-effort":
        expectedReasoningEffort = parseReasoningEffort(next());
        break;
      case "--service-tier":
        expectedServiceTier = next();
        break;
      case "--runtime-profile":
        expectedRuntimeProfile = parseRuntimeProfile(next());
        break;
      case "--git-sha":
        expectedGitSha = next();
        skipGitSha = false;
        break;
      case "--skip-git":
        skipGitSha = true;
        expectedGitSha = undefined;
        break;
      case "--no-manifest":
        requireManifest = false;
        break;
      case "--no-diagnostics":
        requireDiagnostics = false;
        break;
      case "--allow-missing-internal-provider":
        requireInternalProvider = false;
        break;
      case "--json":
        json = true;
        break;
      case "--help":
      case "-h":
        throw new UsageRequested();
      default:
        throw new Error(`Unknown flag ${arg}.`);
    }
  }

  return {
    resultsDir,
    ...(benchmarks.length > 0 ? { benchmarks } : {}),
    ...(diagnosticsDir ? { diagnosticsDir } : {}),
    ...(manifestPath ? { manifestPath } : {}),
    requireManifest,
    requireDiagnostics,
    requireInternalProvider,
    expectedModel,
    expectedReasoningEffort,
    expectedServiceTier,
    expectedRuntimeProfile,
    expectedGitSha,
    skipGitSha,
    json,
  };
}

function parseReasoningEffort(value: string): BenchReasoningEffort {
  if (value === "low" || value === "medium" || value === "high" || value === "xhigh") {
    return value;
  }
  throw new Error(`Invalid --reasoning-effort ${JSON.stringify(value)}. Expected low, medium, high, or xhigh.`);
}

function parseRuntimeProfile(value: string): BenchRuntimeProfile {
  if (value === "baseline" || value === "real" || value === "openclaw-chain") {
    return value;
  }
  throw new Error(`Invalid --runtime-profile ${JSON.stringify(value)}. Expected baseline, real, or openclaw-chain.`);
}

class UsageRequested extends Error {}

function printUsage(): void {
  process.stdout.write(`Usage: scripts/bench/verify-public-matrix.ts [options]

Options:
  --results-dir <dir>                 Stored benchmark result directory
  --diagnostics-dir <dir>             Codex CLI diagnostics dir (default: <results-dir>/codex-cli-diagnostics)
  --manifest <path>                   Repro manifest path (default: <results-dir>/MANIFEST.json)
  --benchmarks <ids>                  Comma-separated subset; defaults to all public benchmarks
  --model <id>                        Expected Codex model (default: gpt-5.5)
  --reasoning-effort <value>          Expected reasoning effort (default: xhigh)
  --service-tier <value>              Expected Codex service tier (default: fast)
  --runtime-profile <profile>         Expected runtime profile (default: real)
  --git-sha <sha>                     Expected result git SHA
  --skip-git                          Do not compare result/manifest git SHA
  --no-manifest                       Skip MANIFEST.json checks
  --no-diagnostics                    Skip Codex diagnostics checks
  --allow-missing-internal-provider   Do not require internalProvider to be Codex CLI
  --json                              Print JSON report
`);
}

async function main(args: string[]): Promise<number> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs(args);
  } catch (error) {
    if (error instanceof UsageRequested) {
      printUsage();
      return 0;
    }
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    printUsage();
    return 2;
  }

  const { json, ...options } = parsed;
  const report = await verifyPublicMatrixEvidence(options);
  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else if (report.ok) {
    process.stdout.write(`OK public benchmark matrix evidence verified for ${report.rows.length} benchmark(s).\n`);
  } else {
    for (const issue of report.issues) {
      const location = [
        issue.benchmark ? `benchmark=${issue.benchmark}` : undefined,
        issue.path ? `path=${issue.path}` : undefined,
      ].filter(Boolean).join(" ");
      process.stderr.write(`FAIL ${issue.code}${location ? ` ${location}` : ""}: ${issue.message}\n`);
    }
  }
  return report.ok ? 0 : 1;
}

const invokedUrl = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : "";
if (import.meta.url === invokedUrl) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(
        `verify-public-matrix.ts crashed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    });
}
