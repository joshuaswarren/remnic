/**
 * @remnic/bench — Phase 1 benchmark engine types
 */

import type { BenchmarkIntegrityMeta, BenchmarkSplitType } from "./integrity/types.js";

export type BenchmarkMode = "full" | "quick";
export type BenchmarkTier = "published" | "remnic" | "custom";
export type BenchmarkStatus = "ready" | "planned";
export type BenchmarkCategory = "agentic" | "retrieval" | "conversational" | "ingestion";
export type BenchRuntimeProfile = "baseline" | "real" | "openclaw-chain" | "local-lab";
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
 *
 * `claude-cli` shells out to `claude -p` (Claude Code headless) as an
 * isolated benchmark-only responder/judge target, running against the
 * operator's Claude subscription rather than a metered API key. Like
 * `codex-cli`, it is intentionally not routed through Remnic memory or
 * OpenClaw gateway state.
 */
export type BuiltInProvider =
  | "openai"
  | "anthropic"
  | "ollama"
  | "litellm"
  | "local-llm"
  | "codex-cli"
  | "claude-cli";

export type BenchReasoningEffort = "low" | "medium" | "high" | "xhigh";

export interface ProviderConfig {
  provider: BuiltInProvider;
  model: string;
  /** Versioned grading rubric used by judge providers, persisted for reproducibility. */
  rubricVersion?: string;
  baseUrl?: string;
  apiKey?: string;
  retryOptions?: {
    maxAttempts?: number;
    baseBackoffMs?: number;
    timeoutMs?: number;
    retryOnTimeout?: boolean;
    max429WaitMs?: number;
  };
  /**
   * Provider transport timeout that must not be interpreted as a benchmark
   * phase timeout. Runtime profiles use this for safe provider defaults while
   * reserving retryOptions.timeoutMs for an explicit --request-timeout.
   */
  providerRequestTimeoutMs?: number;
  disableThinking?: boolean;
  reasoningEffort?: BenchReasoningEffort;
  responderContextBudgetChars?: number;
  responderPromptBudgetChars?: number;
  /**
   * Sampling temperature forwarded from a runtime profile manifest (e.g. the
   * local-lab manifest pins this to 0 for reproducibility). Optional; providers
   * that do not read it ignore the value.
   */
  temperature?: number;
  /**
   * Sampling seed forwarded from a runtime profile manifest so local-lab runs
   * are reproducible across invocations. Optional; providers that do not read
   * it ignore the value.
   */
  seed?: number;
}

export interface TaskTokenUsage {
  input: number;
  output: number;
}

export interface TaskAttributionWitnessRuntimeV1 {
  qmdCollection: string;
  qmdIndex: string;
  qmdMaxResults: number;
  attributionThreshold: number;
}

export interface TaskAttributionGoldWitnessV1 {
  goldMemory: string;
  storeMemoryIds: string[] | null;
  oracleMemoryIds: string[] | null;
}

export interface TaskAttributionRetrievalWitnessV1 {
  sessionId: string;
  appliedCap: number | null;
  atCapMemoryIds: string[] | null;
  headroomMemoryIds: string[] | null;
}

export interface TaskAttributionWitnessV1 {
  schemaVersion: 1;
  runtime: TaskAttributionWitnessRuntimeV1;
  golds: TaskAttributionGoldWitnessV1[];
  retrievals: TaskAttributionRetrievalWitnessV1[];
}

export type TaskAttributionWitness = TaskAttributionWitnessV1;

export interface TaskResult {
  taskId: string;
  question: string;
  expected: string;
  actual: string;
  scores: Record<string, number>;
  latencyMs: number;
  tokens: TaskTokenUsage;
  /** Plain-statement gold knowledge points for op-level failure attribution, issue #1954. */
  goldMemories?: string[];
  attributionWitness?: TaskAttributionWitness;
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
    /** Run-scoped identity shared with provider usage ledgers and manifests. */
    runId?: string;
    /** Git worktree state captured when benchmark execution begins. */
    gitDirty?: boolean;
    gitDirtyEntryCount?: number;
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
    /**
     * Effective canary floor (validated `REMNIC_BENCH_CANARY_FLOOR` or the
     * canonical default) that gated `canaryScore`. Persisted by
     * `writeBenchmarkResult` so readers judge the score against the
     * producing run's floor without the environment variable.
     */
    canaryFloor?: number;
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
    /**
     * Number of underlying judge model calls actually issued. When a content-
     * keyed judge-result cache is enabled (#1573 PR1) and answers are
     * unchanged, this equals the number of cache misses. Re-runs after the
     * first put perform zero new judge model calls.
     */
    judgeModelCalls?: number;
  };
  results: {
    tasks: TaskResult[];
    aggregates: AggregateMetrics;
    statistics?: StatisticalReport;
    /**
     * Optional per-category aggregate breakdown keyed by a benchmark-defined
     * category label (e.g. LoCoMo's single_hop/adversarial). Populated by
     * benchmarks whose tasks carry a `categoryName` detail so per-category
     * metrics — such as the adversarial-vs-answerable split issue #1878
     * tracks — are read straight from the artifact instead of hand-computed
     * from task ids.
     */
    categoryAggregates?: Record<string, AggregateMetrics>;
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

export interface PairedAnswerReplayEntry {
  sourceRuntimeProfile: BenchRuntimeProfile | null;
  finalAnswer: string;
  answeredText: string;
  model?: string;
}

export type PairedAnswerReplayCache = Map<string, PairedAnswerReplayEntry>;

export interface RunBenchmarkOptions {
  mode?: BenchmarkMode;
  datasetDir?: string;
  outputDir?: string;
  limit?: number;
  seed?: number;
  /** Override the number of full-mode benchmark iterations. Quick mode remains single-run. */
  iterations?: number;
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
  /** Live specialized judge used by MemCorrect; never persisted in result config. */
  memCorrectJudge?: import("./adapters/types.js").BenchJudge;
  /**
   * Force-disable the content-keyed judge-result cache (#1573 PR1). When
   * true, every judge call reaches the underlying model regardless of
   * whether `judgeCacheDir` is set. CLI flag: `--no-judge-cache`.
   */
  noJudgeCache?: boolean;
  /**
   * Override the on-disk directory used to persist judge verdicts. Defaults
   * to `<outputDir>/judge-cache` when outputDir is supplied; ignored when
   * `noJudgeCache` is true. The directory is created on demand.
   */
  judgeCacheDir?: string;
  /**
   * Ephemeral cross-profile answer cache for a paired benchmark matrix. A
   * cached answer may only be reused when the responder-facing input is
   * identical and it originated from a different runtime profile.
   */
  pairedAnswerReplayCache?: PairedAnswerReplayCache;
  /** Called after each task completes for progress logging and partial result tracking. */
  onTaskComplete?: (task: TaskResult, completedCount: number, totalCount?: number) => void;
  /** Called immediately before a non-resumed task begins its model work. */
  onTaskStart?: (taskId: string) => void;
  /**
   * Runtime-only completed task receipts for crash-safe published-benchmark
   * resume. Resumed tasks skip model calls; callers persist the receipts.
   */
  resumeTasks?: ReadonlyMap<string, TaskResult>;
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
