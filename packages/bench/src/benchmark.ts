/**
 * Public benchmark execution helpers.
 */

import fs from "node:fs";
import path from "node:path";
import { EngramAccessService } from "@remnic/core";
import {
  createTimeoutGuardedAdapter,
  createTimeoutGuardedIngestionAdapter,
  resolveBenchmarkPhaseTimeoutMs,
  resolveBenchmarkProgressLogging,
} from "./adapters/timeout-guard.js";
import { createSyntheticEmailIngestionAdapter } from "./ingestion-adapters/synthetic-email-adapter.js";
import { getRegisteredBenchmark, listBenchmarks, getBenchmark } from "./registry.js";
import { finalizeBenchmarkResultConfig } from "./result-config.js";
import { buildBenchmarkRunSeeds } from "./run-seeds.js";
import type {
  BenchConfig,
  BenchTier,
  BenchmarkDefinition,
  BenchmarkMode,
  BenchmarkReport,
  BenchmarkResult,
  BenchmarkSuiteResult,
  ExplainResult,
  RecallMetrics,
  RegressionDetail,
  RegressionGateResult,
  RunBenchmarkOptions,
  SavedBaseline,
  TierDetail,
} from "./types.js";

export { listBenchmarks, getBenchmark } from "./registry.js";
export { redactBenchmarkResultSecrets, writeBenchmarkResult } from "./reporter.js";

const DEFAULT_BASELINE_PATH = path.join(process.cwd(), "benchmarks", "baseline.json");
const DEFAULT_REPORT_PATH = path.join(process.cwd(), "benchmarks", "report.json");
const BASELINE_VERSION = 1;
const DEFAULT_TOLERANCE = 10;
const DEFAULT_FULL_RUN_COUNT = 5;

const DEFAULT_QUERIES = [
  "What is the storage?",
  "How do I access storage?",
  "What categories exist?",
  "How is memory organized?",
  "What is the recall budget?",
  "What is the extraction pipeline?",
  "What facts are stored about the project?",
  "What is the architecture?",
];

interface MemorySummary {
  id: string;
  path: string;
  category: string;
  preview: string;
  tags: string[];
}

interface RecallResponse {
  results: MemorySummary[];
}

function hrTimeMs(): number {
  const [seconds, nanos] = process.hrtime();
  return seconds * 1_000 + Math.round(nanos / 1_000_000);
}

export function resolveBenchmarkRunCount(
  mode: BenchmarkMode,
  requestedIterations?: number,
): number {
  if (mode === "quick") {
    return 1;
  }

  if (requestedIterations === undefined) {
    return DEFAULT_FULL_RUN_COUNT;
  }

  if (!Number.isInteger(requestedIterations) || requestedIterations <= 0) {
    throw new Error("benchmark iterations must be a positive integer");
  }

  return requestedIterations;
}

export { buildBenchmarkRunSeeds } from "./run-seeds.js";

export async function orchestrateBenchmarkRuns<T>(
  mode: BenchmarkMode,
  executeRun: (seed: number, runIndex: number) => Promise<T>,
  requestedIterations?: number,
  baseSeed?: number,
): Promise<{ runCount: number; seeds: number[]; runs: T[] }> {
  const runCount = resolveBenchmarkRunCount(mode, requestedIterations);
  const seeds = buildBenchmarkRunSeeds(runCount, baseSeed);
  const runs: T[] = [];

  for (const [runIndex, seed] of seeds.entries()) {
    runs.push(await executeRun(seed, runIndex));
  }

  return {
    runCount,
    seeds,
    runs,
  };
}

export async function runBenchmark(
  benchmarkId: string,
  options: RunBenchmarkOptions,
): Promise<BenchmarkResult> {
  const registeredBenchmark = getRegisteredBenchmark(benchmarkId);
  if (!registeredBenchmark) {
    throw new Error(
      `Unknown benchmark "${benchmarkId}". Available benchmarks: ${listBenchmarks()
        .map((benchmark) => benchmark.id)
        .join(", ")}`,
    );
  }

  if (!registeredBenchmark.run) {
    throw new Error(
      `Benchmark "${benchmarkId}" is listed but has not been migrated into @remnic/bench yet.`,
    );
  }

  const definition = benchmarkDefinition(registeredBenchmark.id);
  const timeoutMs = resolveBenchmarkPhaseTimeoutMs(options);
  const shouldGuardSystem =
    timeoutMs !== undefined || options.drainTimeoutMs !== undefined;
  const logProgress = resolveBenchmarkProgressLogging(options.remnicConfig);
  const log = (message: string): void => {
    console.error(`  ${message}`);
  };
  const system =
    !shouldGuardSystem
      ? options.system
      : createTimeoutGuardedAdapter(options.system, {
          benchmarkId,
          ...(timeoutMs !== undefined ? { timeoutMs } : {}),
          ...(options.drainTimeoutMs !== undefined
            ? { drainTimeoutMs: options.drainTimeoutMs }
            : {}),
          logProgress,
          log,
        });
  const rawIngestionAdapter =
    options.ingestionAdapter ??
    (definition.meta.category === "ingestion"
      ? createSyntheticEmailIngestionAdapter({ system })
      : undefined);
  const ownsIngestionAdapter =
    options.ingestionAdapter === undefined && rawIngestionAdapter !== undefined;
  let ownedIngestionAdapterDestroyPromise: Promise<void> | undefined;
  const destroyOwnedIngestionAdapter = async (): Promise<void> => {
    if (!ownsIngestionAdapter) {
      return;
    }
    ownedIngestionAdapterDestroyPromise ??= rawIngestionAdapter.destroy();
    await ownedIngestionAdapterDestroyPromise;
  };
  if (definition.meta.category === "ingestion" && !rawIngestionAdapter) {
    throw new Error(
      `Benchmark "${benchmarkId}" requires an ingestion adapter. ` +
      `Pass ingestionAdapter via RunBenchmarkOptions or use the programmatic API.`,
    );
  }
  const ingestionAdapter =
    rawIngestionAdapter && timeoutMs !== undefined
      ? createTimeoutGuardedIngestionAdapter(rawIngestionAdapter, {
          benchmarkId,
          timeoutMs,
          logProgress,
          log,
          onTimeout: destroyOwnedIngestionAdapter,
        })
      : rawIngestionAdapter;

  let result: BenchmarkResult;
  try {
    result = await registeredBenchmark.run({
      ...options,
      system,
      ...(ingestionAdapter ? { ingestionAdapter } : {}),
      mode: options.mode ?? "quick",
      benchmark: definition,
    });
  } finally {
    await destroyOwnedIngestionAdapter();
  }

  return finalizeBenchmarkResultConfig(result, options);
}

function benchmarkDefinition(id: string): BenchmarkDefinition {
  const definition = getBenchmark(id);
  if (!definition) {
    throw new Error(`Benchmark definition disappeared for "${id}".`);
  }
  return definition;
}

export function loadBaseline(baselinePath?: string): SavedBaseline | undefined {
  const resolvedPath = baselinePath ?? DEFAULT_BASELINE_PATH;
  let rawText: string;
  try {
    rawText = fs.readFileSync(resolvedPath, "utf8");
  } catch (err) {
    if (isNodeError(err) && err.code === "ENOENT") {
      return undefined;
    }
    throw err;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(rawText);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse benchmark baseline at ${resolvedPath}: ${reason}`);
  }

  if (!isSavedBaseline(raw)) {
    throw new Error(`Invalid benchmark baseline shape at ${resolvedPath}`);
  }

  if (raw.version !== BASELINE_VERSION) {
    console.warn(
      `Baseline version mismatch: expected ${BASELINE_VERSION}, got ${raw.version}`,
    );
  }
  return raw;
}

export function saveBaseline(baselinePath: string, baseline: SavedBaseline): void {
  fs.mkdirSync(path.dirname(baselinePath), { recursive: true });
  fs.writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
}

function isSavedBaseline(value: unknown): value is SavedBaseline {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Partial<SavedBaseline>;
  if (!Number.isFinite(candidate.version)) {
    return false;
  }
  if (typeof candidate.timestamp !== "string") {
    return false;
  }
  if (!candidate.metrics || typeof candidate.metrics !== "object" || Array.isArray(candidate.metrics)) {
    return false;
  }
  return Object.values(candidate.metrics).every((metric) => Number.isFinite(metric));
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return typeof err === "object" && err !== null && "code" in err;
}

async function recallWithTiers(
  service: EngramAccessService,
  query: string,
): Promise<{ tiers: BenchTier[]; tierDetails: TierDetail[] }> {
  const tiers: BenchTier[] = [];
  const tierDetails: TierDetail[] = [];

  const exactStart = hrTimeMs();
  const exactResponse = (await service.recall({
    query,
    mode: "auto",
  })) as unknown as RecallResponse;
  const exactLatency = hrTimeMs() - exactStart;

  if (
    exactResponse.results?.some((memory) =>
      memory.preview.toLowerCase().includes(query.toLowerCase()),
    )
  ) {
    tiers.push("exact_match");
    tierDetails.push({
      tier: "exact_match",
      latencyMs: exactLatency,
      resultsCount: exactResponse.results.length,
    });
    return { tiers, tierDetails };
  }

  const keywordStart = hrTimeMs();
  const keywordResponse = (await service.recall({
    query,
    mode: "auto",
  })) as unknown as RecallResponse;
  const keywordLatency = hrTimeMs() - keywordStart;
  const queryWords = query
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word.length > 2);

  if (
    keywordResponse.results?.some((memory) =>
      queryWords.some((word) => memory.preview.toLowerCase().includes(word)),
    )
  ) {
    tiers.push("category_match");
    tierDetails.push({
      tier: "category_match",
      latencyMs: keywordLatency,
      resultsCount: keywordResponse.results.length,
    });
    return { tiers, tierDetails };
  }

  const confidenceStart = hrTimeMs();
  const confidenceResponse = (await service.recall({
    query,
    mode: "auto",
  })) as unknown as RecallResponse;
  const confidenceLatency = hrTimeMs() - confidenceStart;
  const taggedResults = (confidenceResponse.results ?? []).filter(
    (memory) => memory.tags?.length > 0,
  );

  if (taggedResults.length > 0) {
    tiers.push("high_confidence");
    tierDetails.push({
      tier: "high_confidence",
      latencyMs: confidenceLatency,
      resultsCount: taggedResults.length,
    });
    return { tiers, tierDetails };
  }

  const semanticStart = hrTimeMs();
  const semanticResponse = (await service.recall({
    query,
    mode: "auto",
  })) as unknown as RecallResponse;
  const semanticLatency = hrTimeMs() - semanticStart;

  if ((semanticResponse.results ?? []).length > 0) {
    tiers.push("semantic_search");
    tierDetails.push({
      tier: "semantic_search",
      latencyMs: semanticLatency,
      resultsCount: semanticResponse.results.length,
    });
    return { tiers, tierDetails };
  }

  const fullStart = hrTimeMs();
  const fullResponse = (await service.recall({
    query,
    mode: "full",
  })) as unknown as RecallResponse;
  const fullLatency = hrTimeMs() - fullStart;

  if ((fullResponse.results ?? []).length > 0) {
    tiers.push("full_search");
    tierDetails.push({
      tier: "full_search",
      latencyMs: fullLatency,
      resultsCount: fullResponse.results.length,
    });
    return { tiers, tierDetails };
  }

  tiers.push("no_results");
  tierDetails.push({
    tier: "no_results",
    latencyMs: exactLatency + keywordLatency + confidenceLatency + semanticLatency + fullLatency,
    resultsCount: 0,
  });
  return { tiers, tierDetails };
}

export async function runExplain(
  service: EngramAccessService,
  query: string,
): Promise<ExplainResult> {
  const start = hrTimeMs();
  const { tiers, tierDetails } = await recallWithTiers(service, query);
  const totalDurationMs = hrTimeMs() - start;
  return {
    query,
    tiersUsed: tiers,
    tierResults: tierDetails,
    durationMs: totalDurationMs,
    totalDurationMs,
  };
}

async function runSingle(
  service: EngramAccessService,
  queryText: string,
): Promise<RecallMetrics> {
  const start = hrTimeMs();
  const { tiers, tierDetails } = await recallWithTiers(service, queryText);
  const totalDurationMs = hrTimeMs() - start;
  return {
    query: queryText,
    latencyMs: totalDurationMs,
    tiersUsed: tiers,
    throughput: totalDurationMs > 0 ? 1 / (totalDurationMs / 1_000) : 0,
    resultsCount: tierDetails.reduce((sum, tier) => sum + tier.resultsCount, 0),
    totalDurationMs,
    tierDetails,
  };
}

export async function runBenchSuite(
  service: EngramAccessService,
  config: BenchConfig = {},
): Promise<BenchmarkSuiteResult> {
  const queries = config.queries ?? DEFAULT_QUERIES;
  const regressionTolerance = config.regressionTolerance ?? DEFAULT_TOLERANCE;
  const baselinePath = config.baselinePath ?? DEFAULT_BASELINE_PATH;
  const reportPath = config.reportPath ?? DEFAULT_REPORT_PATH;
  const explain = config.explain ?? false;

  const results: RecallMetrics[] = [];
  const suiteStart = hrTimeMs();

  for (const query of queries) {
    if (explain) {
      const explained = await runExplain(service, query);
      results.push({
        query: explained.query,
        latencyMs: explained.totalDurationMs,
        tiersUsed: explained.tiersUsed,
        throughput: explained.totalDurationMs > 0 ? 1 / (explained.totalDurationMs / 1_000) : 0,
        resultsCount: explained.tierResults.reduce(
          (sum, tier) => sum + tier.resultsCount,
          0,
        ),
        totalDurationMs: explained.totalDurationMs,
        tierDetails: explained.tierResults,
      });
    } else {
      results.push(await runSingle(service, query));
    }
  }

  const totalDurationMs = hrTimeMs() - suiteStart;
  const metrics: Record<string, number> = {};
  for (const result of results) {
    metrics[result.query] = result.latencyMs;
  }

  const report = generateReport(results, reportPath);
  const baseline = loadBaseline(baselinePath);
  const regressionResult = checkRegression(metrics, baseline, regressionTolerance);

  if (!baseline) {
    saveBaseline(baselinePath, {
      version: BASELINE_VERSION,
      timestamp: new Date().toISOString(),
      metrics,
    });
  }

  return {
    results,
    report,
    totalDurationMs,
    regressions: regressionResult.regressions,
  };
}

export function checkRegression(
  metrics: Record<string, number>,
  baseline: SavedBaseline | undefined,
  tolerance: number,
): RegressionGateResult {
  if (!baseline) {
    return { passed: true, regressions: [] };
  }

  const regressions: RegressionDetail[] = [];
  for (const [metric, currentValue] of Object.entries(metrics)) {
    const baselineValue = baseline.metrics[metric];
    if (baselineValue === undefined) {
      continue;
    }

    const passed = baselineValue === 0
      ? currentValue <= 0
      : ((currentValue - baselineValue) / baselineValue) * 100 <= tolerance;

    regressions.push({
      metric,
      currentValue,
      baselineValue,
      tolerance,
      passed,
    });
  }

  return {
    passed: regressions.every((regression) => regression.passed),
    regressions,
  };
}

export function generateReport(
  results: RecallMetrics[],
  reportPath?: string,
): BenchmarkReport {
  const report: BenchmarkReport = {
    timestamp: new Date().toISOString(),
    queries: results.map((result) => ({
      query: result.query,
      tiersUsed: result.tiersUsed,
      durationMs: result.latencyMs,
      resultsCount: result.resultsCount,
      throughput: result.throughput,
      tierDetails: result.tierDetails,
    })),
    totalDurationMs: results.reduce((sum, result) => sum + result.totalDurationMs, 0),
  };

  if (reportPath) {
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  }

  return report;
}
