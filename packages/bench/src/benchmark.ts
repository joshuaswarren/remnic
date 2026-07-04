/**
 * Public benchmark execution helpers.
 */

import fs from "node:fs";

import path from "node:path";
import { createHash } from "node:crypto";

import { EngramAccessService, expandTildePath } from "@remnic/core";
import {
  createTimeoutGuardedAdapter,
  createTimeoutGuardedIngestionAdapter,
  resolveBenchmarkPhaseTimeoutMs,
  resolveBenchmarkProgressLogging,
} from "./adapters/timeout-guard.js";
import { createSyntheticEmailIngestionAdapter } from "./ingestion-adapters/synthetic-email-adapter.js";
import type { BenchJudge, BenchMemoryAdapter } from "./adapters/types.js";
import {
  JUDGE_CACHE_PROTOCOL_VERSION,
  JudgeCache,
  runJudgeWithCache,
  stableStringify,
  type JudgeCacheCounters,
} from "./judges/judge-cache.js";
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
  ProviderConfig,
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

  // PR #1591 round-5 OTHlr: capture the caller's original judge (and
  // cross judge) references so we can restore them after the run —
  // mutating options.system.judge permanently replaces the adapter's
  // judge, so a second run reusing the same adapter (with noJudgeCache,
  // a different cacheDir, or different provider) would silently hit
  // the stale wrapper or wrap the wrapper.
  const originalSystemJudge = options.system.judge;
  const originalCrossJudge = options.amaBenchCrossJudge;
  let judgeCacheCounters: JudgeCacheCounters | undefined;
  // Issue #1573 PR1: optionally route judge calls through a content-keyed
  // cache. Wrap before createTimeoutGuardedAdapter so timeout-phase
  // enforcement still applies to underlying model calls on cache misses.
  // When noJudgeCache is set, no judge is wired, or no cache directory can
  // be derived (neither judgeCacheDir nor outputDir), the system judge is
  // left untouched — preserving the byte-identical baseline.
  // PR #1591 P2 (thread #10): AMA-Bench can run a separate cross judge
  // (`options.amaBenchCrossJudge`) whose calls must hit the same content-
  // keyed cache as the primary system judge. Build cache wiring once for
  // any role so primary and cross judges can share the helper below.
  let cachedCrossJudge: BenchJudge | undefined;
  let crossJudgeCacheCounters: JudgeCacheCounters | undefined;

  // PR #1591 round-6 (OUojs / OUnib): capture the drain handles for
  // both wrapped judges so the run-block finally can await them before
  // returning — fire-and-forget cache writes (round-5 OTHls) require a
  // drain when the run finishes so a follow-up run in the same process
  // doesn't miss still-pending entries.
  let primaryDrainPendingWrites: (() => Promise<void>) | undefined;
  let crossDrainPendingWrites: (() => Promise<void>) | undefined;
  // Issue #1573 PR1: optionally route judge calls through a content-keyed
  // cache. Wrap before createTimeoutGuardedAdapter so timeout-phase
  // enforcement still applies to underlying model calls on cache misses.
  // PR #1591 P2 (round-3 follow-up, reviewer chatgpt-codex-connector):
  // when no `judgeProvider` config is supplied we cannot identify the
  // judge by model/baseUrl — two factory-created judges with identical
  // source text but different closure-captured thresholds/prompts would
  // collide on the same cache key. Skip caching for unidentified judges
  // and leave the unwrapped judge in place so the harness sees the
  // byte-identical baseline.
  // PR #1591 P2 (thread #10): AMA-Bench can run a separate cross judge
  // (`options.amaBenchCrossJudge`) that shares the same content-keyed
  // cache as the primary system judge (when both have provider config).
  // PR #1591 P2 (round-4 OS_ny): when `options.system.judge` is unset
  // (no primary judge) but a configured cross judge exists, still wire
  // the cache for the cross judge path. The primary-judge check only
  // skips primary wrapping, not the shared cache / cross-judge path.
  const baseSystem: BenchMemoryAdapter = (() => {
    if (options.noJudgeCache) {
      return options.system;
    }
    // Determine whether cache wrapping is in play at all. If neither
    // the primary nor the cross judge will be wrapped, fall back to
    // the byte-identical baseline.
    const willWrapPrimary = options.system.judge !== undefined
      && (options.judgeProvider ?? null) !== null;
    const willWrapCross = options.amaBenchCrossJudge !== undefined
      && (options.amaBenchCrossJudgeProvider ?? null) !== null;
    if (!willWrapPrimary && !willWrapCross) {
      return options.system;
    }
    // An explicit judgeCacheDir enables caching on its own — programmatic
    // callers do not need outputDir for the flag to work (PR #1591, Low).
    // PR #1591 (round-3 cursor bugbot): Node's path.resolve does not
    // expand a leading `~`; resolve it manually so programmatic callers
    // (the CLI already expands via shell) can pass `~/bench-cache` and
    const cacheDir = options.judgeCacheDir
      ? path.resolve(expandTildePath(options.judgeCacheDir))
      : options.outputDir
        ? path.join(path.resolve(expandTildePath(options.outputDir)), "judge-cache")
        : undefined;
    if (cacheDir === undefined) {
      return options.system;
    }
    const cache = new JudgeCache({ dir: cacheDir });
    let baseSystemInner: BenchMemoryAdapter = options.system;
    if (willWrapPrimary) {
      const primary = wrapJudgeWithCache({
        role: "primary",
        judge: options.system.judge!,
        benchmarkId,
        datasetVersion: definition.meta.version,
        amaBenchJudgeProtocol: options.amaBenchJudgeProtocol ?? "default",
        provider: options.judgeProvider ?? null,
        cache,
      });
      judgeCacheCounters = primary.counters;
      primaryDrainPendingWrites = primary.drainPendingWrites;
      // BenchMemoryAdapter uses #private fields and/or non-enumerable
      // own state that only exist on the receiver. Cloning via
      // Object.create+Object.assign preserves the prototype but not
      // the receiver's private slots, so methods like `recall()` or
      // `destroy()` would throw at runtime even though the unwrapped
      // adapter worked. The benchmark harness receives the same
      // adapter instance, only the `judge` slot is swapped for the
      // cached wrapper. Direct property assignment is enough because
      // `BenchJudge` is a method-bag interface — no class hierarchy
      // gates the field.
      options.system.judge = primary.judge;
    }
    // AMA-Bench cross judge: only wrap when a cross-judge provider config
    // identifies it. Without provider config, leave the cross judge
    // untouched so unidentified closure-based judges cannot collide.
    if (willWrapCross) {
      const wrapped = wrapJudgeWithCache({
        role: "cross",
        judge: options.amaBenchCrossJudge!,
        benchmarkId,
        datasetVersion: definition.meta.version,
        amaBenchJudgeProtocol: options.amaBenchJudgeProtocol ?? "default",
        provider: options.amaBenchCrossJudgeProvider ?? null,
        cache,
      });
      cachedCrossJudge = wrapped.judge;
      crossJudgeCacheCounters = wrapped.counters;
      crossDrainPendingWrites = wrapped.drainPendingWrites;
    }
    return baseSystemInner;
  })();
  const system = !shouldGuardSystem
    ? baseSystem
    : createTimeoutGuardedAdapter(baseSystem, {
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
      // PR #1591 P2 (thread #10): when caching is on AND a cross judge is
      // configured, hand the cached cross judge to the runner so AMA-Bench
      // cross-judge calls participate in the same content-keyed cache as
      // the primary system judge. Without this override, the runner kept
      // calling the unwrapped cross judge on every iteration.
      ...(cachedCrossJudge ? { amaBenchCrossJudge: cachedCrossJudge } : {}),
      ...(ingestionAdapter ? { ingestionAdapter } : {}),
      mode: options.mode ?? "quick",
      benchmark: definition,
    });
  } finally {
    // PR #1591 round-6 (OUnif): the judge-restore step is its own
    // try/finally so it always runs, even when ingestion teardown
    // throws — leaving a cached wrapper installed on a reused
    // adapter would silently feed stale verdicts into the next run.
    try {
      await destroyOwnedIngestionAdapter();
    } finally {
      options.system.judge = originalSystemJudge;
      if (originalCrossJudge !== undefined) {
        options.amaBenchCrossJudge = originalCrossJudge;
      }
    }
    // PR #1591 round-6 (OUojs / OUnib): drain all pending cache
    // writes before finalizing the report. Runs outside the phase
    // timeout because the judge call has already completed; only
    // disk I/O remains. Without this drain, a follow-up run in the
    // same process with the same cacheDir would miss still-pending
    // entries and issue extra judge calls on cached answers.
    if (primaryDrainPendingWrites) {
      await primaryDrainPendingWrites();
    }
    if (crossDrainPendingWrites) {
      await crossDrainPendingWrites();
    }
  }

  // Issue #1573 PR1: surface the judge-call counter on the run report so the
  // "judge model calls" line is observable (zero on a cached re-run).
  // PR #1591 P2 (thread #10): when a cross judge was cached too, include
  // its model calls so the counter reflects every judge the harness called.
  // PR #1591 (round-3 cursor bugbot): always surface both — if the
  // primary judge is unwrapped (no judgeProvider) but the cross judge IS
  // wrapped, the cross-judge model calls must still be reported.
  const primaryCalls = judgeCacheCounters?.modelCalls ?? 0;
  const crossCalls = crossJudgeCacheCounters?.modelCalls ?? 0;
  // PR #1591 (round-3 cursor bugbot, OS7QC): report `0` on a fully-cached
  // re-run so the JSON observability contract holds — the field is
  // written whenever any judge was wrapped (primary or cross), not just
  // when at least one underlying model call actually fired.
  if (judgeCacheCounters !== undefined || crossJudgeCacheCounters !== undefined) {
    result.cost.judgeModelCalls = primaryCalls + crossCalls;
  }
  return finalizeBenchmarkResultConfig(result, options);
}

// Local expandTilde removed in PR #1591 round-5 OTGi5; expandTildePath
// from @remnic/core is the canonical helper and prefers the HOME
// environment variable when set, falling back to os.homedir().

/**
 * Wrap a single judge (primary system judge or AMA-Bench cross judge) in
 * {@link runJudgeWithCache} with a role-discriminated cache key so the two
 * judge families can share one on-disk cache without colliding on the same
 * key namespace (PR #1591 P2, thread #10).
 */
function wrapJudgeWithCache(args: {
  role: "primary" | "cross";
  judge: BenchJudge;
  benchmarkId: string;
  datasetVersion: string;
  amaBenchJudgeProtocol: string;
  provider: ProviderConfig | null;
  cache: JudgeCache;
}): { judge: BenchJudge; counters: JudgeCacheCounters; drainPendingWrites: () => Promise<void> } {
  // PR #1591 P2 (round-3 follow-up, reviewer chatgpt-codex-connector):
  // caller guarantees `provider !== null` here — providerless judges are
  // passed through unwrapped so two factory-created judges with identical
  // source text but different closure-captured state cannot collide on
  // the cache key.
  const crossJudgeIdSuffix = args.role === "cross" ? "-cross" : "";
  const wrapped = runJudgeWithCache({
    judge: args.judge,
    cache: args.cache,
    keyExtras: {
      benchmarkId: `${args.benchmarkId}${crossJudgeIdSuffix}`,
      datasetVersion: args.datasetVersion,
      // Protocol identity: bench judge protocol version + the selected
      // judge protocol variant, suffixed by role so primary vs cross
      // differentiator is part of the prompt hash. Bumping
      // JUDGE_CACHE_PROTOCOL_VERSION invalidates verdicts when judge
      // prompt/parse semantics change (PR #1591, High).
      judgePromptHash: createHash("sha256")
        .update(JUDGE_CACHE_PROTOCOL_VERSION)
        .update("\u0001")
        .update(args.amaBenchJudgeProtocol)
        .update("\u0001")
        .update(args.role)
        .digest("hex"),
      judgeModelId:
        args.provider?.model !== undefined && args.provider.model.length > 0
          ? `${args.provider.model}${crossJudgeIdSuffix}`
          : `unknown-${args.role}-judge`,
      // Full judge configuration, deterministically serialized (sorted
      // keys) so provider/base-url/retry changes produce fresh cache
      // keys. `role` is included so primary and cross judges never
      // share a paramsHash.
      judgeParamsHash: createHash("sha256")
        .update(
          stableStringify({
            role: args.role,
            provider: args.provider,
          }),
        )
        .digest("hex"),
    },
  });
  return {
    judge: wrapped as unknown as BenchJudge,
    counters: wrapped.counters,
    drainPendingWrites: wrapped.drainPendingWrites,
  };
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
