/**
 * @remnic/bench — Phase 1 benchmark engine types
 */

import type { BenchmarkIntegrityMeta, BenchmarkSplitType } from "./integrity/types.js";

export type BenchmarkMode = "full" | "quick";
export type BenchmarkTier = "published" | "remnic" | "custom";
export type BenchmarkStatus = "ready" | "planned";
export type BenchmarkCategory = "agentic" | "retrieval" | "conversational" | "ingestion";
export type BenchRuntimeProfile = "baseline" | "real" | "openclaw-chain";
export type AmaBenchJudgeProtocol = "default" | "recommended";
/**
 * Built-in LLM providers supported by the bench harness.
 *
 * `local-llm` targets a user-hosted OpenAI-compatible endpoint
 * (llama.cpp, vLLM, LM Studio, etc.) via `--base-url`. It mirrors
 * the `localLlm*` plugin config on the Remnic core side so that
 * `remnic bench published --provider local-llm` actually exercises
 * the same transport path as the running plugin. Issue #566 slice 5.
 *
 * `codex-cli` shells out to `codex exec` as an isolated benchmark-only
 * responder/judge target. It is intentionally not routed through Remnic
 * memory or OpenClaw gateway state.
 */
export type BuiltInProvider = "openai" | "anthropic" | "ollama" | "litellm" | "local-llm" | "codex-cli";

export type BenchReasoningEffort = "low" | "medium" | "high" | "xhigh";

export interface ProviderConfig {
  provider: BuiltInProvider;
  model: string;
  baseUrl?: string;
  apiKey?: string;
  retryOptions?: {
    maxAttempts?: number;
    baseBackoffMs?: number;
    timeoutMs?: number;
    retryOnTimeout?: boolean;
    max429WaitMs?: number;
  };
  disableThinking?: boolean;
  reasoningEffort?: BenchReasoningEffort;
  responderContextBudgetChars?: number;
  responderPromptBudgetChars?: number;
}

export interface TaskTokenUsage {
  input: number;
  output: number;
}

export interface TaskResult {
  taskId: string;
  question: string;
  expected: string;
  actual: string;
  scores: Record<string, number>;
  latencyMs: number;
  tokens: TaskTokenUsage;
  details?: Record<string, unknown>;
}

export interface MetricAggregate {
  mean: number;
  median: number;
  stdDev: number;
  min: number;
  max: number;
}

export type AggregateMetrics = Record<string, MetricAggregate>;

export interface ConfidenceInterval {
  lower: number;
  upper: number;
  level: number;
}

export type EffectSizeInterpretation = "negligible" | "small" | "medium" | "large";

export interface EffectSizeSummary {
  cohensD: number;
  interpretation: EffectSizeInterpretation;
}

export interface ComparisonMetricDelta {
  baseline: number;
  candidate: number;
  delta: number;
  percentChange: number;
  effectSize: EffectSizeSummary;
  ciOnDelta?: ConfidenceInterval;
}

export interface ComparisonResult {
  benchmark: string;
  metricDeltas: Record<string, ComparisonMetricDelta>;
  verdict: "pass" | "regression" | "improvement";
}

export interface StatisticalReport {
  confidenceIntervals: Record<string, ConfidenceInterval>;
  bootstrapSamples: number;
  effectSizes?: Record<string, EffectSizeSummary>;
  pairedComparison?: {
    baselineId: string;
    pValue: number;
    ciOnDelta: ConfidenceInterval;
  };
}

export interface BenchmarkResult {
  meta: {
    id: string;
    benchmark: string;
    benchmarkTier: BenchmarkTier;
    version: string;
    remnicVersion: string;
    gitSha: string;
    timestamp: string;
    mode: BenchmarkMode;
    runCount: number;
    seeds: number[];
    /**
     * Which dataset split produced this result. Public leaderboard scores
     * only accept `holdout`; `public` is for self-reporting and iteration.
     */
    splitType?: BenchmarkSplitType;
    /** SHA-256 of the sealed qrels artifact used by the judge. */
    qrelsSealedHash?: string;
    /** SHA-256 of the rendered judge prompt (post-template expansion). */
    judgePromptHash?: string;
    /** SHA-256 of the dataset payload as served to the runner. */
    datasetHash?: string;
    /**
     * Canary-adapter score from the audit run that produced this result.
     * Must stay below the benchmark's canary floor.
     */
    canaryScore?: number;
    /** "partial" if the benchmark was interrupted; absent or "complete" otherwise. */
    status?: "complete" | "partial";
    /** If partial, the error that caused interruption. */
    failureReason?: string;
  };
  config: {
    runtimeProfile?: BenchRuntimeProfile | null;
    systemProvider: ProviderConfig | null;
    judgeProvider: ProviderConfig | null;
    internalProvider?: ProviderConfig | null;
    adapterMode: string;
    remnicConfig: Record<string, unknown>;
    benchmarkOptions?: Record<string, unknown>;
  };
  cost: {
    totalTokens: number;
    inputTokens: number;
    outputTokens: number;
    estimatedCostUsd: number;
    totalLatencyMs: number;
    meanQueryLatencyMs: number;
  };
  results: {
    tasks: TaskResult[];
    aggregates: AggregateMetrics;
    statistics?: StatisticalReport;
  };
  environment: {
    os: string;
    nodeVersion: string;
    hardware?: string;
  };
}

export interface BenchmarkMeta {
  name: string;
  version: string;
  description: string;
  category: BenchmarkCategory;
  citation?: string;
  /**
   * Optional integrity metadata declared on the benchmark itself (as opposed
   * to each result). When set, the publishing pipeline pins result-time
   * integrity hashes against these values.
   */
  integrity?: BenchmarkIntegrityMeta;
}

export type { BenchmarkIntegrityMeta, BenchmarkSplitType } from "./integrity/types.js";

export interface BenchmarkDefinition {
  id: string;
  title: string;
  tier: BenchmarkTier;
  status: BenchmarkStatus;
  runnerAvailable: boolean;
  meta: BenchmarkMeta;
}

export interface RunBenchmarkOptions {
  mode?: BenchmarkMode;
  datasetDir?: string;
  outputDir?: string;
  limit?: number;
  seed?: number;
  adapterMode?: string;
  runtimeProfile?: BenchRuntimeProfile | null;
  system: import("./adapters/types.js").BenchMemoryAdapter;
  ingestionAdapter?: import("./ingestion-types.js").IngestionBenchAdapter;
  systemProvider?: ProviderConfig | null;
  judgeProvider?: ProviderConfig | null;
  internalProvider?: ProviderConfig | null;
  remnicConfig?: Record<string, unknown>;
  benchmarkOptions?: Record<string, unknown>;
  drainTimeoutMs?: number;
  amaBenchJudgeProtocol?: AmaBenchJudgeProtocol;
  amaBenchCrossJudge?: import("./adapters/types.js").BenchJudge;
  amaBenchCrossJudgeProvider?: ProviderConfig | null;
  /** Called after each task completes for progress logging and partial result tracking. */
  onTaskComplete?: (task: TaskResult, completedCount: number, totalCount?: number) => void;
}

export interface ResolvedRunBenchmarkOptions extends RunBenchmarkOptions {
  mode: BenchmarkMode;
  benchmark: BenchmarkDefinition;
}

// Legacy latency-benchmark surface retained for CLI compatibility while the
// richer phase-1 benchmark suite lands incrementally.
export type BenchTier =
  | "exact_match"
  | "category_match"
  | "keyword_overlap"
  | "high_confidence"
  | "semantic_search"
  | "full_search"
  | "no_results";

export interface TierDetail {
  tier: BenchTier;
  latencyMs: number;
  resultsCount: number;
}

export interface ExplainResult {
  query: string;
  tiersUsed: BenchTier[];
  tierResults: TierDetail[];
  durationMs: number;
  totalDurationMs: number;
}

export interface RecallMetrics {
  query: string;
  latencyMs: number;
  tiersUsed: BenchTier[];
  throughput: number;
  resultsCount: number;
  totalDurationMs: number;
  tierDetails: TierDetail[];
}

export interface BenchmarkReport {
  timestamp: string;
  queries: Array<{
    query: string;
    tiersUsed: BenchTier[];
    durationMs: number;
    resultsCount: number;
    throughput: number;
    tierDetails: TierDetail[];
  }>;
  totalDurationMs: number;
}

export interface BenchmarkSuiteResult {
  results: RecallMetrics[];
  report: BenchmarkReport;
  totalDurationMs: number;
  regressions: RegressionDetail[];
}

export interface SavedBaseline {
  version: number;
  timestamp: string;
  metrics: Record<string, number>;
}

export interface RegressionGateResult {
  passed: boolean;
  regressions: RegressionDetail[];
}

export interface RegressionDetail {
  metric: string;
  currentValue: number;
  baselineValue: number;
  tolerance: number;
  passed: boolean;
}

export interface BenchConfig {
  queries?: string[];
  iterations?: number;
  regressionTolerance?: number;
  baselinePath?: string;
  reportPath?: string;
  seed?: number;
  explain?: boolean;
}
