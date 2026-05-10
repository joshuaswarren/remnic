/**
 * @remnic/bench — phase 1 bench foundation exports
 */

export type {
  BenchTier,
  TierDetail,
  ExplainResult,
  RecallMetrics,
  BenchmarkReport,
  BenchmarkSuiteResult,
  SavedBaseline,
  RegressionGateResult,
  RegressionDetail,
  BenchConfig,
  BenchmarkMode,
  BenchmarkTier,
  BenchmarkStatus,
  BenchmarkCategory,
  BenchRuntimeProfile,
  BenchReasoningEffort,
  BuiltInProvider,
  ProviderConfig,
  TaskTokenUsage,
  TaskResult,
  MetricAggregate,
  AggregateMetrics,
  ComparisonMetricDelta,
  ComparisonResult,
  ConfidenceInterval,
  EffectSizeInterpretation,
  EffectSizeSummary,
  StatisticalReport,
  BenchmarkResult,
  BenchmarkMeta,
  BenchmarkDefinition,
  RunBenchmarkOptions,
  ResolvedRunBenchmarkOptions,
} from "./types.js";
export type {
  CustomBenchmarkScoring,
  CustomBenchmarkSpec,
  CustomBenchmarkTask,
} from "./benchmarks/custom/types.js";

export type {
  Message,
  SearchResult,
  MemoryStats,
  BenchResponse,
  BenchResponder,
  BenchJudgeResult,
  BenchJudge,
  BenchMemoryAdapter,
  LlmJudge,
  MemorySystem,
} from "./adapters/types.js";

export type {
  GoldEntityType,
  GoldEntity,
  GoldLink,
  GoldPage,
  GoldGraph,
  ExtractedEntity,
  ExtractedLink,
  ExtractedPage,
  MemoryGraph,
  IngestionLog,
  IngestionBenchAdapter,
} from "./ingestion-types.js";

export { REQUIRED_FRONTMATTER_FIELDS } from "./ingestion-types.js";

export type {
  GeneratedFile,
  FixtureOutput,
  FixtureGenerator,
} from "./fixtures/inbox/types.js";

export {
  createLightweightAdapter,
  createRemnicAdapter,
} from "./adapters/remnic-adapter.js";
export {
  createTimeoutGuardedAdapter,
  resolveBenchmarkPhaseTimeoutMs,
  resolveBenchmarkProgressLogging,
} from "./adapters/timeout-guard.js";
export type { RemnicAdapterOptions } from "./adapters/remnic-adapter.js";
export {
  createSyntheticEmailIngestionAdapter,
} from "./ingestion-adapters/synthetic-email-adapter.js";
export type {
  SyntheticEmailIngestionAdapterOptions,
} from "./ingestion-adapters/synthetic-email-adapter.js";
export {
  MEMORY_EVAL_DIMENSIONS,
  MEMORY_EVAL_PUBLIC_LINE,
  getMemoryEvalDimension,
  listMemoryEvalBenchmarkIds,
  listMemoryEvalDimensions,
} from "./memory-evals.js";
export type {
  MemoryEvalCategory,
  MemoryEvalDimension,
  MemoryEvalDimensionId,
  MemoryEvalMetric,
} from "./memory-evals.js";
export type {
  AnthropicProviderConfig,
  CodexCliProviderConfig,
  CompletionOpts,
  CompletionResult,
  DiscoveredModel,
  TokenUsage,
  LlmProvider,
  LocalLlmProviderConfig,
  OllamaProviderConfig,
  OpenAiCompatibleProviderConfig,
  ProviderBaseConfig,
  ProviderDiscoveryResult,
  ProviderFactoryConfig,
} from "./providers/types.js";

export { BENCHMARK_RESULT_SCHEMA } from "./schema.js";
export {
  BENCHMARK_REPRO_MANIFEST_FILENAME,
  BENCHMARK_REPRO_MANIFEST_SCHEMA_VERSION,
  buildBenchmarkReproManifest,
  writeBenchmarkReproManifest,
} from "./repro-manifest.js";
export type {
  BuildBenchmarkReproManifestOptions,
  BenchmarkReproManifest,
  BenchmarkReproManifestDataset,
  BenchmarkReproManifestFile,
  BenchmarkReproManifestResult,
} from "./repro-manifest.js";
export {
  BENCHMARK_ARTIFACT_SCHEMA_VERSION,
  buildBenchmarkArtifact,
  buildBenchmarkArtifactFilename,
  hashBenchmarkArtifact,
  loadBenchmarkArtifact,
  parseBenchmarkArtifact,
  serializeBenchmarkArtifact,
  writeBenchmarkArtifact,
} from "./published-artifact.js";
export type {
  BenchmarkArtifact,
  BenchmarkArtifactEnvironment,
  BenchmarkArtifactPerTaskScore,
  BenchmarkArtifactSystem,
  BuildBenchmarkArtifactInput,
  PublishedBenchmarkId,
  WriteBenchmarkArtifactResult,
} from "./published-artifact.js";
export { createAnthropicProvider } from "./providers/anthropic.js";
export { createCodexCliProvider } from "./providers/codex-cli.js";
export { getRemnicVersion } from "./reporter.js";
export {
  createProvider,
  discoverAllProviders,
} from "./providers/factory.js";
export {
  answerBenchmarkQuestion,
} from "./answering.js";
export {
  buildAmaBenchLeaderboardRows,
  serializeJsonl,
  writeLeaderboardArtifactsForResult,
} from "./leaderboard-export.js";
export {
  AMA_BENCH_DIAGNOSTIC_VARIANTS,
  buildAmaBenchDiagnosticMatrixArtifact,
  buildAmaBenchDiagnosticVariantSummary,
  buildOracleTrajectoryRecall,
  createAmaBenchDiagnosticAdapter,
  extractMarkdownSectionsByTitle,
  isAmaBenchUnknownLikeAnswer,
  selectAmaBenchDiagnosticVariants,
} from "./benchmarks/published/ama-bench/diagnostics.js";
export type {
  AmaBenchDiagnosticAdapterOptions,
  AmaBenchDiagnosticAnswererMode,
  AmaBenchDiagnosticBreakdown,
  AmaBenchDiagnosticMatrixArtifact,
  AmaBenchDiagnosticRecallMode,
  AmaBenchDiagnosticRunContext,
  AmaBenchDiagnosticTaskEvidence,
  AmaBenchDiagnosticTaskRow,
  AmaBenchDiagnosticVariant,
  AmaBenchDiagnosticVariantSummary,
  SanitizedDiagnosticProvider,
} from "./benchmarks/published/ama-bench/diagnostics.js";
export type {
  LeaderboardArtifactWrite,
} from "./leaderboard-export.js";
export {
  createGatewayResponder,
  createProviderBackedAmaBenchRecommendedJudge,
  createProviderBackedJudge,
  createProviderBackedResponder,
  createProviderBackedStructuredJudge,
  createResponderFromProvider,
  createStructuredJudgeFromProvider,
} from "./responders.js";
export { createLiteLlmProvider } from "./providers/litellm.js";
export { createLocalLlmProvider } from "./providers/local-llm.js";
export { createOllamaProvider } from "./providers/ollama.js";
export { createOpenAiCompatibleProvider } from "./providers/openai-compatible.js";
export type {
  BenchModelSource,
  ResolveBenchRuntimeProfileOptions,
  ResolvedBenchRuntimeProfile,
} from "./runtime-profiles.js";
export { resolveBenchRuntimeProfile } from "./runtime-profiles.js";
export {
  buildBenchmarkRunSeeds,
  orchestrateBenchmarkRuns,
  resolveBenchmarkRunCount,
  runBenchmark,
  listBenchmarks,
  getBenchmark,
  redactBenchmarkResultSecrets,
  writeBenchmarkResult,
  loadBaseline,
  saveBaseline,
  runExplain,
  runBenchSuite,
  checkRegression,
  generateReport,
} from "./benchmark.js";
export {
  exactMatch,
  f1Score,
  rougeL,
  recallAtK,
  precisionAtK,
  containsAnswer,
  llmJudgeScore,
  llmJudgeScoreDetailed,
  timed,
  aggregateTaskScores,
} from "./scorer.js";
export {
  bootstrapMeanConfidenceInterval,
  pairedDeltaConfidenceInterval,
} from "./stats/bootstrap.js";
export { cohensD, interpretEffectSize } from "./stats/effect-size.js";
export { compareResults, getBenchmarkLowerIsBetter } from "./stats/comparison.js";
export {
  assertPublishableIntegrity,
  buildBenchmarkPublishFeed,
  deleteBenchmarkResults,
  defaultBenchmarkBaselineDir,
  defaultBenchmarkPublishPath,
  loadBenchmarkResult,
  loadBenchmarkBaseline,
  listBenchmarkBaselines,
  listBenchmarkResults,
  renderBenchmarkResultExport,
  resolveBenchmarkResultReference,
  saveBenchmarkBaseline,
  writeBenchmarkPublishFeed,
} from "./results-store.js";
export type {
  BuildBenchmarkPublishFeedOptions,
  PublishSkipReason,
  PublishSkipRecord,
  PublishedBenchmarkFeed,
  PublishedBenchmarkFeedEntry,
} from "./results-store.js";

// Published-benchmark dataset loaders (LongMemEval-S + LoCoMo-10).
export {
  LONG_MEM_EVAL_DATASET_FILENAMES,
  LOCOMO_DATASET_FILENAMES,
  formatMissingDatasetError,
  loadLoCoMo10,
  loadLongMemEvalS,
} from "./benchmarks/published/dataset-loader.js";
export {
  loadBeamDatasetPreview,
} from "./benchmarks/published/beam/runner.js";
export type {
  BeamDatasetPreview,
} from "./benchmarks/published/beam/runner.js";
export type {
  DatasetSource,
  LoadedDataset,
  LoadDatasetOptions,
} from "./benchmarks/published/dataset-loader.js";

// Integrity pipeline (sealed qrels, canary adapter, contamination, randomize).
export * from "./integrity/index.js";
export {
  loadCustomBenchmarkFile,
  parseCustomBenchmark,
} from "./benchmarks/custom/loader.js";
export {
  runCustomBenchmarkFile,
} from "./benchmarks/custom/runner.js";
export type {
  AbstentionRetrievalCase,
  PersonalizationRetrievalCase,
  SchemaTierCorpus,
  SchemaTierFixture,
  SchemaTierName,
  SchemaTierPage,
  SchemaTierPageFrontmatter,
  TemporalRetrievalCase,
} from "./fixtures/schema-tiers/index.js";
export {
  buildSchemaTierFixture,
  buildSchemaTierSmokeFixture,
  SCHEMA_TIER_FIXTURE,
  SCHEMA_TIER_SMOKE_FIXTURE,
} from "./fixtures/schema-tiers/index.js";

export {
  matchEntity,
  entityRecall,
  linkMatches,
  backlinkF1,
  schemaCompleteness,
} from "./ingestion-scorer.js";

export { emailFixture } from "./fixtures/inbox/email.js";
export { projectFolderFixture } from "./fixtures/inbox/project-folder.js";
export { calendarFixture } from "./fixtures/inbox/calendar.js";
export { chatFixture } from "./fixtures/inbox/chat.js";

// Assistant bench tier — sealed-rubric judge infrastructure.
export {
  ASSISTANT_RUBRIC_DIMENSIONS,
  buildJudgePayload,
  clampScore,
  createDeterministicSpotCheckLogger,
  createSpotCheckFileLogger,
  loadSealedRubric,
  parseRubricResponse,
  runSealedJudge,
  verifyRubricDigest,
  zeroScores,
} from "./judges/sealed-rubric.js";
export type {
  AssistantRubricDimension,
  AssistantRubricScores,
  SealedJudgeDecision,
  SealedJudgeInput,
  SealedRubric,
  SpotCheckLogger,
  StructuredJudge,
} from "./judges/sealed-rubric.js";
export {
  DEFAULT_ASSISTANT_RUBRIC_ID,
  SEALED_PROMPT_REGISTRY,
} from "./judges/sealed-prompts/index.js";

// Assistant bench tier — shared runner helpers.
export {
  ASSISTANT_AGENT_CONFIG_KEY,
  ASSISTANT_JUDGE_CONFIG_KEY,
  ASSISTANT_RUBRIC_ID_KEY,
  ASSISTANT_SEEDS_CONFIG_KEY,
  ASSISTANT_SPOT_CHECK_DIR_KEY,
  renderMemorySummaryForJudge,
  renderMemoryViewForAgent,
  resolveAssistantAgent,
  resolveAssistantRubricId,
  resolveAssistantSeeds,
  resolveAssistantSpotCheckDir,
  resolveStructuredJudge,
  runAssistantBenchmark,
} from "./benchmarks/remnic/_assistant-common/index.js";
export type {
  AssistantAgent,
  AssistantMemoryFact,
  AssistantMemoryGraph,
  AssistantRunnerOptions,
  AssistantScenario,
  AssistantStance,
} from "./benchmarks/remnic/_assistant-common/index.js";

// Assistant bench tier — individual benchmark exports.
export {
  ASSISTANT_MORNING_BRIEF_SCENARIOS,
  ASSISTANT_MORNING_BRIEF_SMOKE_SCENARIOS,
} from "./benchmarks/remnic/assistant-morning-brief/fixture.js";
export {
  assistantMorningBriefDefinition,
  runAssistantMorningBriefBenchmark,
} from "./benchmarks/remnic/assistant-morning-brief/runner.js";
export {
  ASSISTANT_MEETING_PREP_SCENARIOS,
  ASSISTANT_MEETING_PREP_SMOKE_SCENARIOS,
} from "./benchmarks/remnic/assistant-meeting-prep/fixture.js";
export {
  assistantMeetingPrepDefinition,
  runAssistantMeetingPrepBenchmark,
} from "./benchmarks/remnic/assistant-meeting-prep/runner.js";
export {
  ASSISTANT_NEXT_BEST_ACTION_SCENARIOS,
  ASSISTANT_NEXT_BEST_ACTION_SMOKE_SCENARIOS,
} from "./benchmarks/remnic/assistant-next-best-action/fixture.js";
export {
  assistantNextBestActionDefinition,
  runAssistantNextBestActionBenchmark,
} from "./benchmarks/remnic/assistant-next-best-action/runner.js";
export {
  ASSISTANT_SYNTHESIS_SCENARIOS,
  ASSISTANT_SYNTHESIS_SMOKE_SCENARIOS,
} from "./benchmarks/remnic/assistant-synthesis/fixture.js";
export {
  assistantSynthesisDefinition,
  runAssistantSynthesisBenchmark,
} from "./benchmarks/remnic/assistant-synthesis/runner.js";

// Procedural recall ablation harness (issue #567 PR 1/5).
export {
  runProceduralAblation,
  runProceduralAblationCli,
  loadAblationFixture,
  fixtureToAblationScenarios,
  createSeededRandom as createProceduralAblationSeededRandom,
  DEFAULT_ABLATION_BOOTSTRAP_SEED,
} from "./benchmarks/remnic/procedural-recall/ablation.js";
export type {
  ProceduralAblationArtifact,
  ProceduralAblationPerCase,
  ProceduralAblationScenario,
  RunProceduralAblationCliArgs,
  RunProceduralAblationOptions,
} from "./benchmarks/remnic/procedural-recall/ablation.js";

// Real-fixture procedural-recall scenarios + baseline (issue #567 PR 2/5).
export {
  PROCEDURAL_REAL_SCENARIOS,
  PROCEDURAL_REAL_SCENARIOS_SMOKE,
} from "./benchmarks/remnic/procedural-recall/real-scenarios.js";
export type {
  ProceduralRealScenario,
  ProceduralRealScenarioCategory,
} from "./benchmarks/remnic/procedural-recall/real-scenarios.js";

// Security — ADAM-style memory-extraction attack harness (issue #565).
// `createSeededRng` is exported here as `createAdamSeededRng` because
// `./integrity/index.js` already star-re-exports a differently-validated
// `createSeededRng`. Keep the names distinct to avoid shadowing (ESM's
// named re-exports take precedence over star re-exports, so a collision
// silently replaces the integrity implementation).
export {
  createSeededRng as createAdamSeededRng,
  createSyntheticTarget,
  OTHER_NAMESPACE_MEMORIES,
  runExtractionAttack,
  SYNTHETIC_MEMORIES,
} from "./security/extraction-attack/index.js";
export type {
  AttackerMode,
  AttackRecallOptions,
  AttackRetrievalHit,
  ExtractionAttackOptions,
  ExtractionAttackResult,
  ExtractionAttackTarget,
  HarnessRng,
  RecoveredMemory,
  SeededMemory,
  SyntheticTargetOptions,
  TimelineEntry,
} from "./security/extraction-attack/index.js";

// ADAM baseline runner + default scenarios (issue #565 PR 3/5).
export {
  DEFAULT_BASELINE_SCENARIOS,
  renderBaselineMarkdown,
  runBaseline,
} from "./security/extraction-attack/index.js";
export type {
  BaselineRow,
  BaselineScenario,
} from "./security/extraction-attack/index.js";
