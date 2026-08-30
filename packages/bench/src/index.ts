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
  TaskAttributionWitnessRuntimeV1,
  TaskAttributionGoldWitnessV1,
  TaskAttributionRetrievalWitnessV1,
  TaskAttributionWitnessV1,
  TaskAttributionWitness,
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
  PairedAnswerReplayCache,
  PairedAnswerReplayEntry,
} from "./types.js";
export {
  BUILD_WEEK_EVIDENCE_RECEIPT_SCHEMA_VERSION,
  BUILD_WEEK_LIMITATIONS,
  buildBuildWeekEvidenceReceipt,
  serializeBuildWeekEvidenceReceipt,
  writeBuildWeekEvidenceReceipt,
} from "./build-week-evidence-receipt.js";
export type {
  BuildBuildWeekEvidenceReceiptOptions,
  BuildWeekEvidenceReceipt,
  BuildWeekEvidenceReceiptProvider,
  BuildWeekLimitationCode,
} from "./build-week-evidence-receipt.js";
export type {
  CustomBenchmarkScoring,
  CustomBenchmarkSpec,
  CustomBenchmarkTask,
} from "./benchmarks/custom/types.js";
export type {
  MemCorrectSystemAdapter,
  MemCorrectGeneratorOptions,
} from "./benchmarks/remnic/memcorrect/types.js";

export {
  Mem0MemCorrectAdapter,
  ZepMemCorrectAdapter,
  LettaMemCorrectAdapter,
  MissingCredentialError,
} from "./benchmarks/remnic/memcorrect/third-party/index.js";
export type {
  Mem0AdapterConfig,
  ZepAdapterConfig,
  LettaAdapterConfig,
  ThirdPartyAdapterConfig,
} from "./benchmarks/remnic/memcorrect/third-party/index.js";

export type {
  Message,
  SearchResult,
  MemoryStats,
  BenchResponse,
  BenchRecallSupportStatus,
  BenchRecallSupportAssessment,
  BenchRecallSupportRequest,
  BenchResponder,
  BenchJudgeResult,
  MemCorrectJudgeRequest,
  MemCorrectJudgeResult,
  BenchJudge,
  BenchMemoryAdapter,
  BenchRecallOptions,
  BenchRecallLineageStatus,
  BenchRecallTraceRange,
  BenchRecallTraceSection,
  BenchRecallTraceSelection,
  BenchRecallTraceLcmCandidate,
  BenchRecallTraceCoreCapture,
  BenchRecallTrace,
  BenchRecallWithTraceResult,
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
  createMcpMemoryAdapter,
  createMcpDemoMemoryAdapter,
  createMcpDemoMemCorrectAdapter,
  createMcpMemCorrectAdapter,
  McpMemoryBackendError,
} from "./adapters/mcp-memory-adapter.js";
export type {
  McpArgumentSemantic,
  McpBackendErrorCode,
  McpBackendResult,
  McpBenchMemoryAdapter,
  McpConformanceResult,
  McpHttpTransportConfig,
  McpListedTool,
  McpMemCorrectAdapter,
  McpMemoryAdapterOptions,
  McpMemoryToolMapping,
  McpMemoryTransportConfig,
  McpStdioTransportConfig,
  McpToolCallResult,
  McpToolClient,
  McpToolMappingEntry,
  McpToolMappingValue,
  McpToolOperation,
} from "./adapters/mcp-memory-adapter.js";
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
  ClaudeCliProviderConfig,
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
  computeBenchmarkReproDatasetInventoryHash,
  computeBenchmarkReproManifestArtifactHash,
  writeBenchmarkReproManifest,
} from "./repro-manifest.js";
export type {
  BuildBenchmarkReproManifestOptions,
  BenchmarkReproManifest,
  BenchmarkReproManifestDataset,
  BenchmarkReproManifestFile,
  BenchmarkReproManifestResult,
  BenchmarkReproManifestSupplementalArtifact,
} from "./repro-manifest.js";
export {
  BENCHMARK_ARTIFACT_SCHEMA_VERSION,
  PUBLISHED_BENCHMARK_ARTIFACT_IDS,
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
  BenchmarkArtifactHardware,
  BenchmarkArtifactJudgeCalibration,
  BenchmarkArtifactPerTaskScore,
  BenchmarkArtifactSystem,
  BenchmarkArtifactTier,
  BuildBenchmarkArtifactInput,
  PublishedBenchmarkId,
  WriteBenchmarkArtifactResult,
} from "./published-artifact.js";
export { createAnthropicProvider } from "./providers/anthropic.js";
export { createClaudeCliProvider } from "./providers/claude-cli.js";
export { createCodexCliProvider } from "./providers/codex-cli.js";
export {
  buildCodexCreditReceipt,
  calculateCodexBudgetUnits,
  CodexCreditAccountingError,
  CodexCreditDispatchError,
  parseCodexJsonlUsage,
  reconcileCodexCreditLedger,
  resolveCodexCreditBudgetConfig,
  runWithinCodexCreditBudget,
} from "./providers/codex-credit-budget.js";
export type {
  CodexCliNativeUsage,
  CodexCreditBudgetConfig,
  CodexCreditReceipt,
  CodexCreditReceiptScope,
  CodexCreditReconciliationReceipt,
} from "./providers/codex-credit-budget.js";
export {
  captureBenchmarkExecutionProvenance,
  getGitSha,
  getRemnicVersion,
  sanitizeBenchmarkResultForJson,
  writeBenchmarkResult,
  type BenchmarkExecutionProvenance,
} from "./reporter.js";
export { resolveBenchmarkRunId } from "./run-identity.js";
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
  getProviderBackedJudgePromptIdentity,
  createProviderBackedResponder,
  createProviderBackedStructuredJudge,
  createResponderFromProvider,
  createStructuredJudgeFromProvider,
} from "./responders.js";
export { createLiteLlmProvider } from "./providers/litellm.js";
export { createLocalLlmProvider } from "./providers/local-llm.js";
export { createOllamaProvider } from "./providers/ollama.js";
export { createOpenAiCompatibleProvider } from "./providers/openai-compatible.js";
export {
  StructuredJudgeError,
  createStructuredBenchJudge,
  isStructuredJudgeProvider,
} from "./providers/structured-judge.js";
export type {
  AssistantRubricRequest,
  StructuredJudgeErrorCode,
  StructuredJudgeProvider,
  StructuredJudgeTelemetry,
  StructuredJudgeVerdict,
  StructuredJudgeVerdictResult,
  StructuredVerdictRequest,
} from "./providers/structured-judge.js";
export {
  DEFAULT_OPENAI_RESPONSES_JUDGE_MODEL,
  OpenAiResponsesJudgeError,
  OpenAiResponsesProvider,
  createOpenAiResponsesBenchJudge,
  createOpenAiResponsesProvider,
  judgeMemCorrectCorrectionAcceptance,
  judgeMemCorrectStaleMemoryHarm,
} from "./providers/openai-responses.js";
export type {
  OpenAiResponsesProviderConfig,
  OpenAiResponsesJudgeErrorCode,
  OpenAiResponsesJudgeTelemetry,
  OpenAiResponsesVerdict,
  OpenAiResponsesVerdictResult,
} from "./providers/openai-responses.js";
export {
  GENERAL_ANSWER_JUDGE_RUBRIC,
  MEMCORRECT_CORRECTION_ACCEPTANCE_RUBRIC,
  MEMCORRECT_CORRECTION_ACCEPTANCE_RUBRIC_VERSION,
  MEMCORRECT_STALE_HARM_RUBRIC,
  MEMCORRECT_STALE_HARM_RUBRIC_VERSION,
  OPENAI_RESPONSES_JUDGE_RUBRIC_VERSION,
} from "./judges/memcorrect-rubrics.js";
export type {
  BenchModelSource,
  ResolveBenchRuntimeProfileOptions,
  ResolvedBenchRuntimeProfile,
} from "./runtime-profiles.js";
export {
  resolveBenchRuntimeProfile,
  resolveLocalLabJudgeProviderConfig,
} from "./runtime-profiles.js";

export {
  LOCAL_LAB_PROVIDER_KINDS,
  loadLocalLabManifest,
  parseLocalLabManifest,
  preflightLocalLabRole,
  resolveLocalLabProfile,
  resolveLocalLabRole,
  runSequentialPhases,
  formatHandoffNote,
  discoveryEndpointFor,
  LocalLabPreflightError,
} from "./local-lab/index.js";
export type {
  LocalLabManifest,
  LocalLabManifestNotes,
  LocalLabPhase,
  LocalLabPhaseDescriptor,
  LocalLabPhaseExecute,
  LocalLabPhaseName,
  LocalLabPhaseOutcome,
  LocalLabPreflightFailure,
  LocalLabPreflightInput,
  LocalLabPreflightOptions,
  LocalLabPreflightResult,
  LocalLabPreflightSuccess,
  LocalLabProviderKind,
  LocalLabRoleConfig,
  PreflightDiscoveredModel,
  ResolvedLocalLabProfile,
  ResolvedLocalLabRole,
  RunSequentialPhasesOptions,
  SequentialPhaseHooks,
} from "./local-lab/index.js";
export {
  buildBenchmarkRunSeeds,
  orchestrateBenchmarkRuns,
  resolveBenchmarkRunCount,
  runBenchmark,
  listBenchmarks,
  getBenchmark,
  redactBenchmarkResultSecrets,
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
  diagnoseLoComoProfileDelta,
  renderLoComoProfileDeltaMarkdown,
} from "./stats/locomo-profile-delta.js";
export type {
  DiagnoseLoComoProfileDeltaOptions,
  LoComoCategoryDelta,
  LoComoMetricDelta,
  LoComoProfileArtifactEvidence,
  LoComoProfileDeltaReport,
  LoComoTaskRegression,
} from "./stats/locomo-profile-delta.js";
export {
  LOCOMO_FULL_TASK_COUNT,
  LOCOMO_RECALL_DIFF_LINE_LIMIT,
  LOCOMO_RECALL_EXCERPT_CHARS,
  diagnoseLoComoRecallDelta,
  renderLoComoRecallDeltaMarkdown,
  sanitizeLoComoResultReference,
} from "./stats/locomo-recall-delta.js";
export {
  LOCOMO_RETRIEVAL_TRACE_DELTA_SCHEMA_VERSION,
  diagnoseLoCoMoRetrievalTraceDelta,
  serializeLoCoMoRetrievalTraceDelta,
} from "./stats/locomo-retrieval-trace-delta.js";
export type {
  LoCoMoCategory,
  LoCoMoRetrievalMechanism,
  LoCoMoRetrievalMechanismSummary,
  LoCoMoRetrievalTaskDelta,
  LoCoMoRetrievalTraceDeltaReport,
  LoCoMoStructuralMultisetDelta,
} from "./stats/locomo-retrieval-trace-delta.js";
export {
  LOCOMO_RETRIEVAL_TRACE_BUDGET_VERSION,
  LOCOMO_RETRIEVAL_TRACE_SCHEMA_VERSION,
  LOCOMO_RETRIEVAL_TRACE_SELECTION_VERSION,
  buildProviderFreeLoCoMoRetrievalConfig,
  captureLoCoMoRetrievalTrace,
  preflightLoCoMoRetrievalTraceCapture,
  serializeLoCoMoRetrievalTraceReceipt,
} from "./benchmarks/published/locomo/retrieval-trace-runner.js";
export type {
  CaptureLoCoMoRetrievalTraceOptions,
  LoCoMoRetrievalSessionReceipt,
  LoCoMoRetrievalStructuralTrace,
  LoCoMoRetrievalTaskReceipt,
  LoCoMoRetrievalTraceCoreCaptureReceipt,
  LoCoMoRetrievalTraceProfile,
  LoCoMoRetrievalTraceReceipt,
  LoCoMoRetrievalTraceSelectionManifest,
  LoCoMoRetrievalTraceSelector,
} from "./benchmarks/published/locomo/retrieval-trace-runner.js";
export type {
  DiagnoseLoComoRecallDeltaOptions,
  LoComoFinalContextRegression,
  LoComoRawResultEvidence,
  LoComoRecallCategoryDelta,
  LoComoRecallContextSummary,
  LoComoRecallDeltaReport,
  LoComoRecallLineDelta,
  LoComoRecallLineEvidence,
  LoComoRecallMetricDelta,
  LoComoRecallResultProvenance,
  LoComoRecallTextDigest,
} from "./stats/locomo-recall-delta.js";
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
  loadBenchmarkReportCardProvenance,
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
export type { ReportCardProvenanceContext } from "./report-card.js";
export {
  loadBenchmarkResultSummaries,
  summarizeBenchmarkResult,
} from "./result-summary.js";
export type {
  BenchAggregateMetric,
  BenchAssistantTaskDetails,
  BenchIntegritySplit,
  BenchIntegritySummary,
  BenchMetricHighlight,
  BenchPerSeedScore,
  BenchResultFileWarning,
  BenchResultSummary,
  BenchResultSummaryPayload,
  BenchTaskScoreEntry,
  BenchTaskSummary,
} from "./result-summary.js";

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

// Cross-tier judge calibration — Cohen's kappa + calibration slice (issue #1573 PR3).
export {
  CALIBRATION_SLICE_SIZE,
  DEFAULT_KAPPA_BOOTSTRAP_SAMPLES,
  DEFAULT_KAPPA_CONFIDENCE_LEVEL,
  DEFAULT_JUDGE_BINARIZATION_THRESHOLD,
  JUDGE_CALIBRATION_KAPPA_THRESHOLD,
  JUDGE_CALIBRATION_PROTOCOL_VERSION,
  MIN_CALIBRATION_SOURCE_TASKS,
  binarizeJudgeScore,
  bootstrapCohensKappaConfidenceInterval,
  computeCohensKappa,
  loadJudgeCalibrationState,
  hashOrderedQuestionIds,
  runJudgeCalibration,
  selectCalibrationSlice,
  writeJudgeCalibrationState,
} from "./judges/calibration-slice.js";
export type {
  CalibrationAnswer,
  CalibrationVerdictPair,
  CohenKappaResult,
  BootstrapKappaOptions,
  BootstrapKappaResult,
  JudgeCalibrationIdentities,
  JudgeCalibrationCheckpointProvenance,
  JudgeCalibrationResult,
  JudgeCategory,
  KappaConfidenceInterval,
  LoadedJudgeCalibrationState,
  RunJudgeCalibrationOptions,
} from "./judges/calibration-slice.js";

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

// Single-flag ablation matrix for published benchmarks (issues #1574 §"Ablations" + #1730).
export {
  SINGLE_FLAG_ABLATION_MATRIX,
  DEFAULT_ABLATION_BENCHMARK,
  getAblationCell,
} from "./ablations/single-flag-matrix.js";
export type {
  SingleFlagAblationId,
  SingleFlagAblationCell,
  AblationConfigOverrides,
} from "./ablations/single-flag-matrix.js";

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
  MITIGATED_BASELINE_SCENARIOS,
  createMitigatedTarget,
  renderBaselineMarkdown,
  runBaseline,
  runMitigatedBaseline,
} from "./security/extraction-attack/index.js";
export type {
  BaselineRow,
  BaselineScenario,
  MitigatedBaselineConfig,
  MitigatedTargetConfig,
} from "./security/extraction-attack/index.js";

export {
  analyzeInjectionSuitePublicationRows,
  analyzeInjectionSuitePublicationRun,
  analyzeInjectionSuitePublicationUtility,
  analyzeInjectionSuitePublicationUtilityFile,
  analyzeInjectionSuiteRun,
  decideInjectionSuiteCampaign,
  analyzeInjectionSuiteUtility,
  H5_PUBLICATION_ANALYSIS_RULE,
  replayInjectionSuiteStatistics,
  runInjectionSuiteUtility,
  executeLocalRow,
  generateFamilyVariants,
  generateSuiteVariants,
  injectionSuiteResumeContractHash,
  planInjectionSuiteRows,
  runInjectionSuiteCliCommand,
  HOST_FAULT_RETRY_LIMIT,
  INJECTION_SUITE_ARMS,
  INJECTION_SUITE_FAMILIES,
  INJECTION_SUITE_STAGES,
  INJECTION_SUITE_VERSION,
} from "./security/injection-suite/index.js";
export type {
  InjectionSuiteArm,
  InjectionSuiteCliInput,
  InjectionSuiteCliResult,
  InjectionSuiteEpisodeRow,
  InjectionSuiteFamily,
  InjectionSuiteProductEvidence,
  InjectionSuiteRowIdentity,
  InjectionSuiteStage,
} from "./security/injection-suite/index.js";

// ---------------------------------------------------------------------------
// Coding-graph benchmark harness (issue #1557): deterministic synthetic repo
// generator, metric runner, and regression gate. Reached via the optional
// loader (rule 57). Bench-owned baseline JSON lives in baselines/.
// ---------------------------------------------------------------------------
export {
  createSeededRng as createCodingGraphSeededRng,
  generateSyntheticRepo,
  pickStableQualifiedName,
  runCodingGraphBenchmark,
  captureMachineFingerprint,
  checkCodingGraphRegression,
  extractMetrics as extractCodingGraphMetrics,
  buildBaselineFromReport,
  ControlledResponsesDriver,
  createControlledResponsesAgentDriver,
  runRepeatedFailureSuite,
  runRepeatedFailureCliCommand,
  replayRepeatedFailureStatistics,
  writeRepeatedFailurePaperArtifacts,
  runRepeatedFailurePaperReportCliCommand,
} from "./coding-graph/index.js";
export type {
  RegressionMetricKey as CodingGraphRegressionKey,
  SyntheticRepoConfig,
  GeneratedRepo,
  SyntheticFileIR,
  SyntheticSymbol,
  SyntheticEdge,
  MachineFingerprint as CodingGraphMachineFingerprint,
  MicroMetric,
  WallMetric,
  CodingGraphMetricKey,
  CodingGraphBenchReport,
  CodingGraphBaseline,
  RegressionMetricDetail as CodingGraphRegressionDetail,
  RegressionGateResult as CodingGraphRegressionResult,
  CodingGraphBenchConfig,
  ResponsesApiOutputItem,
  ResponsesApiUsage,
  ResponsesApiResponse,
  ResponsesApiRequest,
  ControlledResponsesTransport,
  RepeatedFailureToolExecutionResult,
  RepeatedFailureFinalRepoEvidence,
  ControlledResponsesToolDefinition,
  RepeatedFailureLocalToolHost,
  ControlledGateDecision,
  RepeatedFailureActionEvaluator,
  ControlledResponsesDriverConfig,
  ControlledResponsesAgentDriverConfig,
  ControlledResponsesCaps,
  ControlledResponsesEpisodeInput,
  ControlledResponsesResponseEvent,
  ControlledResponsesToolEvent,
  ControlledResponsesFault,
  ControlledResponsesDisposition,
  ControlledResponsesEpisodeResult,
  RepeatedFailureEpisodeDriver,
  RepeatedFailureEpisodeInput,
  RepeatedFailureArm,
  RepeatedFailureEpisode,
  RepeatedFailureEpisodeEvidence,
  RepeatedFailureEpisodeRow,
  RepeatedFailureExpectedDesign,
  RepeatedFailureRowIdentity,
  RunRepeatedFailureSuiteOptions,
  RunRepeatedFailureSuiteResult,
  RunRepeatedFailureCliCommandInput,
  RepeatedFailureCliCommandResult,
  ReplayRepeatedFailureStatisticsOptions,
} from "./coding-graph/index.js";
export {
  DEFAULT_SMOKE_FIXTURE as CODING_GRAPH_SMOKE_FIXTURE,
  DEFAULT_10K_FIXTURE as CODING_GRAPH_10K_FIXTURE,
  MIN_ITERATIONS as CODING_GRAPH_MIN_ITERATIONS,
  DEFAULT_TOLERANCE_PERCENT as CODING_GRAPH_DEFAULT_TOLERANCE,
  CODING_GRAPH_BENCH_SCHEMA_VERSION,
} from "./coding-graph/index.js";
export type {
  AttributionClass,
  RetrievalMissStage,
  StageStatus,
  StageObservation,
  AttributionLabel,
  GoldMemoryAttribution,
  TaskAttribution,
  AttributionReport,
  AttributionMemory,
  AttributionEnvironment,
  AttributeOptions,
} from "./attribution.js";
export {
  extractContentWords,
  lexicalSimilarity,
  isTaskFailed,
  attributeGoldMemory,
  attributeTask,
  attributeRun,
  renderAttributionReportTable,
  serializeAttributionReport,
} from "./attribution.js";
export { runAttributeCliCommand } from "./attribute-cli.js";
export {
  DRIFT_GEN_DEFAULTS,
  DRIFT_GEN_VERSION,
  buildDriftCorpus,
  generateDriftCorpus,
  runDriftGenCliCommand,
  validateDriftCorpus,
} from "./generators/drift-gen/index.js";
export type {
  DriftGenCorpus,
  DriftGenManifest,
  DriftGenOptions,
  DriftGenResult,
  DriftGenAuditRecord,
  DriftSession,
  DriftSessionTurn,
  DriftValidationReport,
  DriftValidationStats,
  GoldFact,
  GoldFactKind,
  GoldProbe,
  GoldProbeCategory,
} from "./generators/drift-gen/index.js";
export {
  createSeededRandom,
  pickOne,
  randomInt,
  shuffled,
} from "./seeded-random.js";
export type { SeededRandom } from "./seeded-random.js";
export * from "./coding-graph/repo-gen/index.js";
export * from "./coding-graph/repeated-failure-types.js";
export * from "./coding-graph/repeated-failure-store.js";
export * from "./coding-graph/repeated-failure-stats.js";
export * from "./coding-graph/repeated-failure-ollama-chat-driver.js";
export * from "./coding-graph/repeated-failure-trap-audit.js";
