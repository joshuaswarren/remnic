import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BenchmarkMode, BenchmarkResult } from "./types.js";
import {
  assertIntegrityMetaPresent,
  integrityMetaIsComplete,
} from "./integrity/types.js";
import {
  checkDatasetContamination,
  EMPTY_CONTAMINATION_MANIFEST,
  type ContaminationManifest,
} from "./integrity/contamination.js";

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

function isBenchmarkResult(value: unknown): value is BenchmarkResult {
  if (!value || typeof value !== "object") {
    return false;
  }

  const meta = (value as { meta?: Record<string, unknown> }).meta;
  if (!meta || typeof meta !== "object") {
    return false;
  }

  return (
    typeof meta.id === "string" &&
    typeof meta.benchmark === "string" &&
    typeof meta.timestamp === "string" &&
    isBenchmarkMode(meta.mode) &&
    typeof (value as { config?: unknown }).config === "object" &&
    (value as { config?: unknown }).config !== null &&
    typeof (value as { cost?: unknown }).cost === "object" &&
    (value as { cost?: unknown }).cost !== null &&
    typeof (value as { environment?: unknown }).environment === "object" &&
    (value as { environment?: unknown }).environment !== null &&
    typeof (value as { results?: { tasks?: unknown; aggregates?: unknown } }).results === "object" &&
    (value as { results?: unknown }).results !== null &&
    Array.isArray((value as { results?: { tasks?: unknown } }).results?.tasks) &&
    typeof (value as { results?: { aggregates?: unknown } }).results?.aggregates === "object" &&
    (value as { results?: { aggregates?: unknown } }).results?.aggregates !== null
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
  if (!isBenchmarkResult(parsed)) {
    throw new Error(`Invalid benchmark result file: ${filePath}`);
  }
  return parsed;
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

    latestByBenchmark.set(
      summary.benchmark,
      toPublishedBenchmarkFeedEntry(result),
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

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll(`"`, "&quot;")
    .replaceAll("'", "&#39;");
}

function renderHtmlKeyValueRows(entries: Array<[string, string | number]>): string {
  return entries.map(([label, value]) => `        <tr><th>${escapeHtml(label)}</th><td>${escapeHtml(String(value))}</td></tr>`).join("\n");
}

function renderBenchmarkResultHtml(result: BenchmarkResult): string {
  const seeds = Array.isArray(result.meta.seeds)
    ? result.meta.seeds.join(", ")
    : "Unknown";
  const aggregateRows = Object.keys(result.results.aggregates)
    .sort()
    .map((metric) => {
      const aggregate = result.results.aggregates[metric]!;
      return `          <tr><th>${escapeHtml(metric)}</th><td>${escapeHtml(String(aggregate.mean))}</td><td>${escapeHtml(String(aggregate.median))}</td><td>${escapeHtml(String(aggregate.stdDev))}</td><td>${escapeHtml(String(aggregate.min))}</td><td>${escapeHtml(String(aggregate.max))}</td></tr>`;
    })
    .join("\n");

  const statisticsBlock = result.results.statistics
    ? `\n    <section>\n      <h2>Statistics</h2>\n      <pre>${escapeHtml(JSON.stringify(result.results.statistics, null, 2))}</pre>\n    </section>`
    : "";
  const remnicConfigKeyCount = Object.keys(result.config.remnicConfig ?? {}).length;
  const renderedConfig = {
    systemProvider: result.config.systemProvider,
    judgeProvider: result.config.judgeProvider,
    internalProvider: result.config.internalProvider,
    remnicConfig:
      remnicConfigKeyCount === 0
        ? "[empty]"
        : `[redacted ${remnicConfigKeyCount} key${remnicConfigKeyCount === 1 ? "" : "s"}]`,
  };

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Remnic Bench Report: ${escapeHtml(result.meta.benchmark)}</title>
    <style>
      :root {
        color-scheme: light;
        font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      body {
        margin: 0;
        background: #f5f7fb;
        color: #18202a;
      }
      main {
        max-width: 1080px;
        margin: 0 auto;
        padding: 32px 20px 48px;
      }
      header {
        margin-bottom: 24px;
      }
      h1, h2 {
        margin: 0 0 12px;
      }
      p {
        margin: 0;
        line-height: 1.5;
      }
      section {
        background: #ffffff;
        border: 1px solid #d8dee8;
        border-radius: 12px;
        padding: 20px;
        margin-top: 16px;
        box-shadow: 0 8px 24px rgba(15, 23, 42, 0.05);
      }
      table {
        width: 100%;
        border-collapse: collapse;
      }
      th, td {
        text-align: left;
        padding: 10px 12px;
        border-top: 1px solid #e5eaf1;
        vertical-align: top;
      }
      thead th {
        border-top: none;
        font-size: 0.85rem;
        letter-spacing: 0.02em;
        text-transform: uppercase;
        color: #526173;
      }
      tbody th {
        width: 30%;
      }
      pre {
        margin: 0;
        overflow-x: auto;
        white-space: pre-wrap;
        word-break: break-word;
        background: #f5f7fb;
        border-radius: 10px;
        padding: 14px;
        border: 1px solid #e5eaf1;
      }
      .muted {
        color: #526173;
        margin-top: 6px;
      }
      .empty {
        color: #526173;
        font-style: italic;
      }
    </style>
  </head>
  <body>
    <main>
      <header>
        <h1>Remnic Bench Report</h1>
        <p>${escapeHtml(result.meta.benchmark)} · ${escapeHtml(result.meta.id)}</p>
        <p class="muted">Generated from a stored benchmark result export.</p>
      </header>
      <section>
        <h2>Run Summary</h2>
        <table>
          <tbody>
${renderHtmlKeyValueRows([
  ["Result ID", result.meta.id],
  ["Benchmark", result.meta.benchmark],
  ["Benchmark Tier", result.meta.benchmarkTier],
  ["Timestamp", result.meta.timestamp],
  ["Mode", result.meta.mode],
  ["Run Count", result.meta.runCount],
  ["Task Count", result.results.tasks.length],
  ["Remnic Version", result.meta.remnicVersion],
  ["Benchmark Version", result.meta.version],
  ["Git SHA", result.meta.gitSha],
  ["Seeds", seeds],
])}
          </tbody>
        </table>
      </section>
      <section>
        <h2>Aggregate Metrics</h2>
${aggregateRows.length > 0
    ? `        <table>\n          <thead>\n            <tr><th>Metric</th><th>Mean</th><th>Median</th><th>Std Dev</th><th>Min</th><th>Max</th></tr>\n          </thead>\n          <tbody>\n${aggregateRows}\n          </tbody>\n        </table>`
    : '        <p class="empty">No aggregate metrics recorded for this run.</p>'}
      </section>
      <section>
        <h2>Cost</h2>
        <table>
          <tbody>
${renderHtmlKeyValueRows([
  ["Total Tokens", result.cost.totalTokens],
  ["Input Tokens", result.cost.inputTokens],
  ["Output Tokens", result.cost.outputTokens],
  ["Estimated Cost (USD)", result.cost.estimatedCostUsd],
  ["Total Latency (ms)", result.cost.totalLatencyMs],
  ["Mean Query Latency (ms)", result.cost.meanQueryLatencyMs],
])}
          </tbody>
        </table>
      </section>
      <section>
        <h2>Environment</h2>
        <table>
          <tbody>
${renderHtmlKeyValueRows([
  ["OS", result.environment.os],
  ["Node Version", result.environment.nodeVersion],
  ["Hardware", result.environment.hardware ?? "Unknown"],
])}
          </tbody>
        </table>
      </section>
      <section>
        <h2>Configuration</h2>
        <table>
          <tbody>
${renderHtmlKeyValueRows([
  ["Adapter Mode", result.config.adapterMode],
])}
          </tbody>
        </table>
        <pre>${escapeHtml(JSON.stringify(renderedConfig, null, 2))}</pre>
      </section>${statisticsBlock}
    </main>
  </body>
</html>
`;
}

export function renderBenchmarkResultExport(
  result: BenchmarkResult,
  format: BenchmarkExportFormat,
): string {
  if (format === "json") {
    return `${JSON.stringify(result, null, 2)}\n`;
  }

  if (format === "html") {
    return renderBenchmarkResultHtml(result);
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
