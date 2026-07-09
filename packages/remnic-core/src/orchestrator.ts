import { log } from "./logger.js";
import {
  buildChainFollowupGenerator,
  type BriefingFollowupGenerator,
} from "./briefing.js";
import path from "node:path";
import os from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { formatDaySummaryMemories } from "./day-summary.js";
import { resolveHomeDir } from "./runtime/env.js";
import { migrateFromEngram } from "./migrate/from-engram.js";
import { SmartBuffer } from "./buffer.js";
import { chunkContent, type ChunkingConfig } from "./chunking.js";
import { semanticChunkContent, type SemanticChunkResult } from "./semantic-chunking.js";
import { ExtractionEngine } from "./extraction.js";
import { detectPassiveCorrections } from "./correction/passive-correction-detector.js";
import { capturePassiveCorrections, type PassiveCaptureConfig } from "./correction/passive-capture.js";
import { createCorrectionService } from "./correction/correction-access-wiring.js";
import type { CorrectionService } from "./correction/correction-service.js";
import { isAboveImportanceThreshold, scoreImportance } from "./importance.js";
import {
  judgeFactDurability,
  createVerdictCache,
  createDeferCountMap,
  getVerdictKind,
  validateProcedureExtraction,
  type JudgeBatchResult,
  type JudgeCandidate,
  type JudgeVerdict,
} from "./extraction-judge.js";
import {
  applyFaithfulnessVerdict,
  createFaithfulnessCounters,
  runFaithfulnessGateBatch,
} from "./extraction-faithfulness.js";
import {
  contentMatchesRedactionRules,
  loadRedactionRules,
  type CompiledRedactionRule,
} from "./extraction-redaction-rules.js";
import type { FaithfulnessGateCounters } from "./extraction-faithfulness.js";
import {
  EXTRACTION_JUDGE_VERDICT_CATEGORY,
  recordJudgeVerdict,
} from "./extraction-judge-telemetry.js";
import { recordJudgeTrainingPair } from "./extraction-judge-training.js";
import { buildProcedurePersistBody } from "./procedural/procedure-types.js";
import { buildProcedureRecallSection } from "./procedural/procedure-recall.js";
import {
  attachCitation,
  type CitationContext,
  hasCitationForTemplate,
  stripCitationForTemplate,
} from "./source-attribution.js";
// stripCitation (default-format only) is intentionally NOT used on the
// legacy archive path — replaced by skip-with-warning (Finding 2 — Urgw).
// stripCitationForTemplate IS used for pre-tagged dedup canonicalization.
import { findUnresolvedEntityRefs } from "./reconstruct.js";
import type {
  SearchBackend,
  SearchDegradation,
  SearchExecutionOptions,
  SearchQueryOptions,
} from "./search/port.js";
import {
  createSearchBackend,
  createConversationIndexRuntime,
} from "./search/factory.js";
import { NoopSearchBackend } from "./search/noop-backend.js";
import {
  StorageManager,
  ContentHashIndex,
} from "./storage.js";
import { sanitizeMemoryContent } from "./sanitize.js";
import { ThreadingManager } from "./threading.js";
import { extractTopics } from "./topics.js";
import { TranscriptManager } from "./transcript.js";
import { HourlySummarizer } from "./summarizer.js";
import { LocalLlmClient } from "./local-llm.js";
import {
  FallbackLlmClient,
  fallbackLlmRuntimeContextFromConfig,
  gatewayTaskChainOptions,
} from "./fallback-llm.js";
import { MaintenanceScheduler } from "./orchestration/maintenance.js";
import { TierMigrationCoordinator } from "./orchestration/tier-migration-coordinator.js";
import { ExtractionQueueCoordinator } from "./orchestration/extraction-queue-coordinator.js";
import { CompressionGuidelineCoordinator } from "./orchestration/compression-guideline-coordinator.js";
import { SemanticConsolidationCoordinator } from "./orchestration/semantic-consolidation-coordinator.js";
import { LifecyclePolicyCoordinator } from "./orchestration/lifecycle-policy-coordinator.js";
import { EntitySynthesisCoordinator } from "./orchestration/entity-synthesis-coordinator.js";
import { RecallResultFormatter } from "./orchestration/recall-result-formatter.js";
import { ConversationIndexCoordinator } from "./orchestration/conversation-index-coordinator.js";
import { RecallRerankCoordinator } from "./orchestration/recall-rerank-coordinator.js";
import { RecallSectionCoordinator } from "./orchestration/recall-section-coordinator.js";
import { QmdResultResolver, qmdCollectionPathParts, qmdResultPathCandidates } from "./orchestration/qmd-result-resolver.js";
import { ContradictionLinkingCoordinator } from "./orchestration/contradiction-linking-coordinator.js";
import { ExtractionRunCoordinator, type ExtractionRunResult } from "./orchestration/extraction-run.js";
import { ConsolidationRunCoordinator } from "./orchestration/consolidation-run.js";
import { ExtractionPersistCoordinator } from "./orchestration/extraction-persist.js";
import { RecallInternalCoordinator } from "./orchestration/recall-internal.js";
import { RecallSearchPipelineCoordinator } from "./orchestration/recall-search-pipeline.js";
import { TurnIngestionCoordinator } from "./orchestration/turn-ingestion.js";
import { RecallIntrospectionCoordinator } from "./orchestration/recall-introspection.js";
import { OrchestratorInitCoordinator } from "./orchestration/orchestrator-init.js";
import { PersistenceIndexCoordinator } from "./orchestration/persistence-index.js";
import { WorkspaceOpsCoordinator } from "./orchestration/workspace-ops.js";
import { NamespaceReadFanoutCoordinator } from "./orchestration/namespace-read-fanout.js";
import { selfDeps } from "./orchestration/self-deps.js";
import {
  abortRecallError,
  buildCompressionGuidelinesMarkdown,
  buildQmdIntentHint,
  isArtifactMemoryPath,
  mergeArtifactRecallCandidates,
  tokenizeRecallQuery,
  type BulkImportBatchIngestResult,
  type DaySummaryGatherOptions,
  type GraphRecallSnapshot,
  type IntentDebugSnapshot,
  type QmdRecallSnapshot,
  type QueryAwarePrefilter,
  type RecallInvocationOptions,
} from "./orchestration/orchestrator-helpers.js";
// Issue #1526 seam 25: module-level helpers moved to
// orchestration/orchestrator-helpers.ts; re-exported here so existing
// importers (coordinators, tests, root shims) keep working.
export {
  BulkImportBatchPartialFailureError,
  COMPACTION_SIGNAL_MAX_AGE_MS,
  appendMemoryToGraphContext,
  applyQueryAwareCandidateFilter,
  buildCompressionGuidelinesMarkdown,
  buildMemoryPathById,
  computeArtifactCandidateFetchLimit,
  computeArtifactRecallLimit,
  computeQmdHybridFetchLimit,
  defaultWorkspaceDir,
  filterHourlySummaryMarkdownForLocalDay,
  filterRecallCandidates,
  formatDateInTimeZone,
  isArtifactMemoryPath,
  lifecycleRecallScoreAdjustment,
  mapRecallSourceToXrayServedBy,
  mergeArtifactRecallCandidates,
  normalizeIanaTimeZone,
  parseFiniteDate,
  parseGraphRecallRankedResults,
  parseMemoryIntentSnapshot,
  parseQmdRecallResults,
  qmdStartupCollectionCheckWithTimeout,
  raceRecallAbort,
  resolveEffectiveRecallMode,
  resolvePersistedMemoryRelativePath,
  resolveRecallModeDecision,
  resolveRecallModeDecisionAsync,
  resolveRecentThreadMemoryPaths,
  sanitizeSessionKeyForFilename,
  shouldFilterLifecycleRecallCandidate,
  splitTurnsBySourceValidAt,
  summarizeGraphShadowComparison,
  targetSourceValidAtSortMs,
  throwIfRecallAborted,
  tokenizeRecallQuery,
  utcDateKeysForLocalDay,
  type BulkImportBatchIngestResult,
  type DaySummaryGatherOptions,
  type GraphRecallSnapshot,
  type IntentDebugSnapshot,
  type QmdRecallSnapshot,
  type QueryAwarePrefilter,
  type RecallInvocationOptions,
  type RecallModeDecision,
} from "./orchestration/orchestrator-helpers.js";

export { hasIdentityRecoveryIntent, resolveEffectiveIdentityInjectionMode } from "./orchestration/recall-result-formatter.js";
import {
  GraphRecallCoordinator,
  mergeGraphExpandedResults,
  graphPathRelativeToStorage,
  blendGraphExpandedRecallScore,
  type GraphRecallRankedResult,
  type GraphRecallShadowComparison,
} from "./orchestration/graph-recall-coordinator.js";
export { mergeGraphExpandedResults, graphPathRelativeToStorage, blendGraphExpandedRecallScore } from "./orchestration/graph-recall-coordinator.js";
export type { GraphRecallRankedResult, GraphRecallShadowComparison } from "./orchestration/graph-recall-coordinator.js";
import {
  runLiveConnectorsOnce,
  type LiveConnectorsRunSummary,
} from "./live-connectors-runner.js";
import {
  runPatternReinforcement,
  type PatternReinforcementResult,
} from "./maintenance/pattern-reinforcement.js";
import { ModelRegistry } from "./model-registry.js";
import { applyRuntimeRetrievalPolicy, expandQuery } from "./retrieval.js";
import {
  mergeWithAgentResults,
  runDirectAgent,
  runTemporalAgent,
  shouldRunAgent,
  type ParallelSearchResult,
} from "./retrieval-agents.js";
import { RerankCache, rerankLocalOrNoop } from "./rerank.js";
import { projectTrustForXray } from "./trust-score-stage.js";
import type { TrustStageResultItem } from "./trust-score-stage.js";
import { buildRetrievedMemoryProvenance } from "./memory-provenance.js";
import {
  applyTemporalSupersession,
  normalizeSupersessionKey,
  shouldFilterSupersededFromRecall,
} from "./temporal-supersession.js";
import { isValidAsOf, isValidityExpiredNow } from "./temporal-validity.js";
import { pickFactEventTimeAnchor, resolveFactEventTime } from "./event-time.js";
import { RelevanceStore } from "./relevance.js";
import { NegativeExampleStore } from "./negative.js";
import {
  LastRecallStore,
  RecallHandleHistoryStore,
  type LastRecallBudgetSummary,
  TierMigrationStatusStore,
  clampGraphRecallExpandedEntries,
  type GraphRecallExpandedEntry,
  type LastRecallSnapshot,
  type TierMigrationCycleSummary,
  type TierMigrationStatusSnapshot,
} from "./recall-state.js";
import {
  buildHandleIndexForResults,
  MEMORY_ID_PATTERN,
  parseIdOrHandle,
  resolveHandle,
  stripHandles,
  type RecallSnapshotIds,
} from "./recall-handles.js";
import {
  buildXraySnapshot,
  type RecallFilterTrace,
  type RecallXrayResult,
  type RecallXrayScoreDecomposition,
  type RecallXraySnapshot,
  type RecallXrayServedBy,
} from "./recall-xray.js";
import {
  recordEvalShadowRecall,
  type EvalShadowRecallRecord,
} from "./evals.js";
import { SessionObserverState } from "./session-observer-state.js";
import {
  abortError as sharedAbortError,
  throwIfAborted as sharedThrowIfAborted,
} from "./abort-error.js";
import { CODEX_THREAD_KEY_PREFIX } from "./thread-key.js";
import { isDisagreementPrompt } from "./signal.js";
import { lintWorkspaceFiles, rotateMarkdownFileToArchive } from "./hygiene.js";
import { isPathInsideStorageRoot } from "./storage-paths.js";
import { EmbeddingFallback } from "./embedding-fallback.js";
import {
  decideSemanticDedup,
  type SemanticDedupDecision,
  type SemanticDedupHit,
} from "./dedup/semantic.js";
import { BootstrapEngine } from "./bootstrap.js";
import { parseQmdExplain } from "./qmd.js";
import {
  buildQmdRecallCacheKey,
  getCachedQmdRecall,
  setCachedQmdRecall,
} from "./qmd-recall-cache.js";
import {
  buildEntityRecallSection,
  entityRecentTranscriptLookbackHours,
  readRecentEntityTranscriptEntries,
} from "./entity-retrieval.js";
import { buildExplicitCueRecallSection } from "./explicit-cue-recall.js";
import {
  buildTargetedFactRecallSection,
  shouldRecallTargetedFactEvidence,
} from "./targeted-fact-recall.js";
import {
  buildFocusedListRecallSection,
  shouldRecallFocusedListEvidence,
} from "./focused-list-recall.js";
import {
  buildResponseGuidanceRecallSection,
  shouldRecallResponseGuidance,
} from "./response-guidance-recall.js";
import {
  buildEventOrderRecallSection,
  shouldRecallEventOrderEvidence,
} from "./event-order-recall.js";
import {
  hasBroadGraphIntent,
  inferIntentFromText,
  intentCompatibilityScore,
  planRecallMode,
} from "./intent.js";
import { buildRecallQueryPolicy } from "./recall-query-policy.js";
import { parseMemoryActionEligibilityContext } from "./schemas.js";
import { evaluateMemoryActionPolicy } from "./memory-action-policy.js";
import {
  buildCompressionGuidelinesMarkdown as buildCompressionGuidelinesMarkdownV2,
} from "./compression-optimizer.js";
export { formatCompressionGuidelinesForRecall } from "./orchestration/compression-guideline-coordinator.js";
import { createRecallSectionMetricRecorder } from "./recall-qos.js";
import { BoxBuilder, type BoxFrontmatter } from "./boxes.js";
import { classifyMemoryKind } from "./himem.js";
import { TmtBuilder } from "./tmt.js";
import {
  decideLifecycleTransition,
  resolveLifecycleState,
  type LifecycleSignals,
} from "./lifecycle.js";
import { isActiveMemoryStatus } from "./memory-lifecycle-ledger-utils.js";
import {
  indexMemoriesBatch,
  clearIndexes,
  indexesExist,
  deindexMemory,
  queryByDateRangeAsync,
  queryByTagsAsync,
  isTemporalQuery,
  recencyWindowFromPrompt,
  extractTagsFromPrompt,
  resolvePromptTagPrefilterAsync,
} from "./temporal-index.js";
import { GraphIndex } from "./graph.js";
import {
  searchCausalTrajectories,
  type CausalTrajectorySearchResult,
} from "./causal-trajectory.js";
import {
  objectiveStateStoreOverrideForNamespace,
  searchObjectiveStateSnapshots,
  type ObjectiveStateSearchResult,
} from "./objective-state.js";
import {
  listTrustZoneRecords,
  searchTrustZoneRecords,
  type TrustZoneSearchResult,
} from "./trust-zones.js";
import { tryDirectAnswer, type DirectAnswerSources } from "./direct-answer-wiring.js";
import { resolveNamespaceCapabilities,
  resolveCapabilities,
  resolveGraphConstructionCapabilities,
  resolveMemoryLifecycleCapabilities,
  resolveIndexingCapabilities,
  resolveCreationMemoryCapabilities,
  type CapabilitySet,
  type GraphConstructionCapabilitySet,
  type MemoryLifecycleCapabilitySet,
  type IndexingCapabilitySet,
  type CreationMemoryCapabilitySet,
  resolveQmdCapabilities,
  resolveIdentityContinuityCapabilities,
  resolveLocalLlmCapabilities,
  resolveSecurityCapabilities, resolveEvalCapabilities, resolveUtilityLearningCapabilities, resolveObjectiveStateCapabilities, resolveCompressionCapabilities, resolvePresentationCapabilities, resolveConsolidationCapabilities, resolveRecallAuxiliaryCapabilities ,
  resolveRecallEnhancementCapabilities,
  resolvePipelineProcessingCapabilities,
  resolveConversationContextCapabilities,
} from "./capabilities.js";
import { DEFAULT_TAXONOMY } from "./taxonomy/index.js";
import {
  searchHarmonicRetrieval,
  type HarmonicRetrievalResult,
} from "./harmonic-retrieval.js";
import {
  compareVerifiedEpisodeResults,
  searchVerifiedEpisodes,
  type VerifiedEpisodeResult,
} from "./verified-recall.js";
import {
  compareVerifiedSemanticRuleResults,
  searchVerifiedSemanticRules,
  type VerifiedSemanticRuleResult,
} from "./semantic-rule-verifier.js";
import { applyCommitmentLedgerLifecycle } from "./commitment-ledger.js";
import {
  searchWorkProductLedgerEntries,
  type WorkProductLedgerSearchResult,
} from "./work-product-ledger.js";
import {
  collectNativeKnowledgeChunks,
  formatNativeKnowledgeSection,
  searchNativeKnowledge,
} from "./native-knowledge.js";
import { normalizeReplaySessionKey, type ReplayTurn } from "./replay/types.js";
import type { ImportTurn } from "./bulk-import/types.js";
import { WearablesService } from "./wearables/service.js";
import {
  type AgentPersonaModelConfig,
  confidenceTier,
  type MemoryIntent,
  type MemorySummary,
} from "./types.js";
import { LcmEngine } from "./lcm/index.js";
import { shouldSkipImplicitExtraction } from "./explicit-capture.js";
import {
  findSimilarClusters,
  buildConsolidationPrompt,
  parseConsolidationResponse,
  buildOperatorAwareConsolidationPrompt,
  parseOperatorAwareConsolidationResponse,
  chooseConsolidationOperator,
  buildExtensionsBlockForConsolidation,
  materializeAfterSemanticConsolidation,
  type SemanticConsolidationLlmOperator,
  type SemanticConsolidationResult,
} from "./semantic-consolidation.js";
import {
  type ConversationIndexBackend,
  type ConversationIndexBackendInspection,
  type ConversationQmdRuntime,
} from "./conversation-index/backend.js";
import {
  NamespaceStorageRouter,
} from "./namespaces/storage.js";
import {
  NamespaceCatalog,
} from "./namespaces/catalog.js";
import {
  planNamespaceMaintenance,
  type NamespaceMaintenanceSummary,
} from "./maintenance/namespace-planner.js";
import {
  runNamespaceMaintenanceFanout,
  summarizeNamespaceMaintenanceHealth,
  type NamespaceMaintenanceFanoutRunnerContext,
  type NamespaceMaintenanceHealthSummary,
} from "./maintenance/namespace-maintenance-fanout.js";
import {
  namespaceIdentityFromToken,
  namespaceIdentityToken,
  normalizeNamespaceIdentity,
} from "./namespaces/identity.js";
import {
  canReadNamespace,
  canWriteNamespace,
  defaultNamespaceForPrincipal,
  recallNamespacesForPrincipal,
  resolvePrincipal,
} from "./namespaces/principal.js";
import {
  getConfiguredNamespaces,
  resolveNamespaceFromStorageDir,
  resolveScopePlan,
} from "./scopes/scope-plan.js";
import {
  expandScopeProfileReadNamespaces,
  resolveScopeProfilePlan,
  type ResolvedScopeProfilePlan,
} from "./namespaces/scope-profiles.js";
import {
  combineNamespaces,
  lcmReadSessionIdsForNamespaces,
  resolveCodingNamespaceOverlay,
} from "./coding/coding-namespace.js";
import type { CodingContext, ProvenanceSource } from "./types.js";
import {
  NamespaceSearchRouter,
  type NamespaceSearchHealth,
} from "./namespaces/search.js";
import { SharedContextManager } from "./shared-context/manager.js";
import {
  CompoundingEngine,
  defaultTierMigrationCycleBudget,
} from "./compounding/engine.js";
import { parseFlexibleIsoTimestamp } from "./utils/iso-timestamp.js";
import { categoryDirName, RECALL_FALLBACK_DIRS } from "./utils/category-dir.js";
import { assertPathInsideRoot } from "./utils/path-containment.js";
// IRC preference consolidation — used by eval adapter directly;
// orchestrator integration planned for future PR.
// import { consolidatePreferences, buildQueryAwarePreferenceSection, synthesizePreferencesFromLcm } from "./compounding/preference-consolidator.js";
import { TierMigrationExecutor } from "./tier-migration.js";
import { decideTierTransition, type MemoryTier } from "./tier-routing.js";
import {
  isSafeRouteNamespace,
  selectRouteRule,
  type RouteRule,
  type RoutingEngineOptions,
} from "./routing/engine.js";
import { RoutingRulesStore } from "./routing/store.js";
import {
  PolicyRuntimeManager,
  type RuntimePolicyValues,
} from "./policy-runtime.js";
import {
  applyUtilityPromotionRuntimePolicy,
  applyUtilityRankingRuntimeDelta,
  loadUtilityRuntimeValues,
  type UtilityRuntimeValues,
} from "./utility-runtime.js";
import {
  buildBehaviorSignalsForMemory,
  dedupeBehaviorSignalsByMemoryAndHash,
} from "./behavior-signals.js";
import { ProfilingCollector } from "./profiling.js";
import {
  keyring,
  secureStoreDir,
  SecureStoreLockedError,
} from "./secure-store/index.js";
import type {
  AccessTrackingEntry,
  BehaviorLoopPolicyState,
  BehaviorSignalEvent,
  BootstrapOptions,
  BootstrapResult,
  BufferTurn,
  ContinuityIncidentRecord,
  ConsolidationObservation,
  EngramTraceEvent,
  ExtractionResult,
  IdentityInjectionMode,
  LifecycleState,
  MemoryActionEvent,
  MemoryActionType,
  MemoryLink,
  MemoryFile,
  MemoryFrontmatter,
  DaySummaryResult,
  PluginConfig,
  QmdSearchResult,
  RecallPlanMode,
  RecallSectionConfig,
  RecallTierExplain,
} from "./types.js";
import { disposeDefaultArchiveScoring, getDefaultArchiveScoring, memoryFileToScoreItem } from "./recall/archive-scoring.js";


// Issue #1526 seam 15: ExtractionRunResult moved to orchestration/extraction-run.ts.
export type { ExtractionRunResult } from "./orchestration/extraction-run.js";


// Issue #1526 seam 15: deriveTopicsFromExtraction moved to orchestration/extraction-run.ts.
export { deriveTopicsFromExtraction } from "./orchestration/extraction-run.js";


export class Orchestrator {

  readonly storage: StorageManager;
  private readonly storageRouter: NamespaceStorageRouter;
  /** Rebuildable namespace catalog (issue #1499). Inert unless namespaces enabled. */
  readonly namespaceCatalog: NamespaceCatalog;
  private readonly namespaceStorageDirHints = new Map<string, Set<string>>();
  private namespaceStorageDirHintsLoaded = false;
  private readonly namespaceSearchRouter: NamespaceSearchRouter;
  qmd: SearchBackend;
  /**
   * Maintenance scheduler (issue #1526 PR1). Owns cron auto-registration,
   * debounced QMD index maintenance, and consolidation scheduling. Job
   * runners (consolidation/pattern-reinforcement/governance) stay here.
   */
  readonly maintenanceScheduler: MaintenanceScheduler;
  private readonly conversationQmd?: ConversationQmdRuntime;
  private readonly conversationFaiss?: ReturnType<
    typeof createConversationIndexRuntime
  >["faiss"];
  private readonly conversationIndexBackend?: ConversationIndexBackend;
  readonly sharedContext?: SharedContextManager;
  readonly compounding?: CompoundingEngine;
  readonly buffer: SmartBuffer;
  readonly transcript: TranscriptManager;
  readonly sessionObserver: SessionObserverState;
  readonly summarizer: HourlySummarizer;
  readonly localLlm: LocalLlmClient;
  readonly fastLlm: LocalLlmClient;
  private readonly judgeVerdictCache: Map<string, JudgeVerdict>;
  /**
   * Per-orchestrator defer-counter map (issue #562, PR 2). Tracks how many
   * times the judge has returned `"defer"` for a given candidate content
   * hash so the defer cap can be enforced.
   */
  private readonly judgeDeferCounts: Map<string, number>;
  /**
   * Faithfulness gate distribution counters (issue #1576). Per-orchestrator
   * running tally surfaced via console_state telemetry. No module-level state
   * (rule 11) — these hang off the orchestrator instance.
   */
  private faithfulnessCounters: FaithfulnessGateCounters = createFaithfulnessCounters();
  /**
   * Side-channel: number of facts deferred in the most recent
   * `persistExtraction` call (issue #562, PR 2). The caller reads this after
   * `persistExtraction` returns to decide whether to retain buffer turns for
   * the next extraction pass. Not part of the return signature because many
   * callers already destructure `persistedIds` by position.
   */
  private lastPersistExtractionDeferredCount: number = 0;
  /**
   * Side-channel (#1635): pending_review persisted ids from the last
   * persistExtraction; runExtraction excludes them from the thread episode set.
   */
  private lastPersistExtractionPendingReviewIds: string[] = [];
  private readonly _fastGatewayLlm: FallbackLlmClient | null;

  get fastGatewayLlm(): FallbackLlmClient | null {
    return this._fastGatewayLlm;
  }

  getConsoleFaithfulnessDistribution(): FaithfulnessGateCounters | undefined {
    return this.recallIntrospectionCoordinator.getConsoleFaithfulnessDistribution(
    );
  }
  readonly modelRegistry: ModelRegistry;
  readonly relevance: RelevanceStore;
  readonly negatives: NegativeExampleStore;
  readonly lastRecall: LastRecallStore;
  readonly handleHistory: RecallHandleHistoryStore;
  readonly tierMigrationStatus: TierMigrationStatusStore;
  readonly tierMigrationCoordinator: TierMigrationCoordinator;
  readonly compressionGuidelineCoordinator: CompressionGuidelineCoordinator;
  readonly semanticConsolidationCoordinator: SemanticConsolidationCoordinator;
  readonly lifecyclePolicyCoordinator: LifecyclePolicyCoordinator;
  readonly entitySynthesisCoordinator: EntitySynthesisCoordinator;
  /**
   * In-memory X-ray snapshot from the most recent `recall()` call that
   * was invoked with `xrayCapture: true` (issue #570 PR 1).  Scope is
   * per-process; later slices add CLI/HTTP/MCP surfaces that consume
   * this via the shared renderer.  `null` until the first capture, and
   * NEVER overwritten by a recall that did not request capture —
   * requests without the flag leave prior captures intact so the
   * capturing caller can still read their snapshot back.
   */
  private lastXraySnapshot: RecallXraySnapshot | null = null;
  readonly embeddingFallback: EmbeddingFallback;
  private readonly conversationIndexDir: string;
  private readonly extraction: ExtractionEngine;
  readonly config: PluginConfig;
  readonly profiler: ProfilingCollector;
  private readonly threading: ThreadingManager;
  /** v8.2: Per-namespace multi-graph memory indexes (entity/time/causal edges) */
  private readonly graphIndexes = new Map<string, GraphIndex>();
  /** Per-namespace BoxBuilders, keyed by the namespace root directory path. */
  private readonly boxBuilders = new Map<string, BoxBuilder>();
  /** Temporal Memory Tree builder — builds hour/day/week/persona summary nodes. */
  private readonly tmtBuilder: TmtBuilder;
  /** Lossless Context Management engine — proactive session archive + DAG summarization. */
  readonly lcmEngine: LcmEngine | null = null;
  private readonly rerankCache = new RerankCache();

  /**
   * Per-session workspace selections keyed by sessionKey.
   * Set by the before_agent_start hook so recall() uses the correct
   * agent workspace for BOOT.md injection. Cleared after each recall.
   * Using a Map prevents concurrent sessions from overwriting each other.
   */
  private _recallWorkspaceOverrides = new Map<string, string>();
  /**
   * Per-session coding-agent context (issue #569). Populated by connectors at
   * session-start (PRs 5/6/7) via `setCodingContextForSession`. Used by both
   * the recall path and the write path so that memory routing respects the
   * project/branch scope a session is operating in (rule 42 — read + write
   * through the same namespace layer).
   */
  private readonly _codingContextBySession = new Map<string, CodingContext>();
  /**
   * Per-session peer ID registry (issue #679 PR 3/5).
   * Set by connectors / hooks via `setPeerIdForSession` so `recallInternal`
   * can inject the peer's profile into recall context when
   * `peerProfileRecallEnabled` is true. Cleared when the session ends.
   * Keyed by sessionKey so concurrent sessions don't clobber each other
   * (rule 11 — scope globals per plugin ID / session).
   */
  private readonly _peerIdBySession = new Map<string, string>();
  private routingRulesStore: RoutingRulesStore | null = null;
  private contentHashIndex: ContentHashIndex | null = null;
  private readonly contentHashIndexesByStorageDir = new Map<string, ContentHashIndex>();
  private readonly artifactSourceStatusCache = new WeakMap<
    StorageManager,
    {
      loadedAtMs: number;
      statusVersion: number;
      statuses: Map<string, "active" | "superseded" | "archived" | "missing">;
    }
  >();
  /** Read by NamespaceReadFanoutCoordinator (seam 26), hence not `private`. */
  static readonly ARTIFACT_STATUS_CACHE_TTL_MS = 60_000;

  // Access tracking buffer (Phase 1A)
  // Maps memoryId -> {count, lastAccessed} for batched updates
  private accessTrackingBuffer: Map<
    string,
    { count: number; lastAccessed: string }
  > = new Map();

  // Passive correction capture (issue #1581) — dedup state + lazy service.
  private passiveCorrectionDedup: Set<string> = new Set();
  private _passiveCorrectionService: CorrectionService | null = null;
  private passiveCorrectionTelemetry: {
    detected: number;
    queued: number;
    autoApplied: number;
    suppressedReasonCounts: Record<string, number>;
  } = { detected: 0, queued: 0, autoApplied: 0, suppressedReasonCounts: {} };

  /**
   * Background serial extraction queue coordinator (issue #1526 — moved
   * from inline `extractionQueue`/`queueProcessing` fields). Owns queue
   * state + scheduling + the serial drain + failure classification; the
   * orchestrator builds each task closure in `queueBufferedExtraction` and
   * hands it to `enqueue`.
   */
  readonly extractionQueueCoordinator: ExtractionQueueCoordinator;
  /**
   * Extraction-run pipeline coordinator (issue #1526 seam 15). Owns
   * `runExtraction` + dedupe fingerprint helpers + processed-fingerprint
   * recording. The orchestrator delegates and injects its own methods.
   */
  private _extractionRunCoordinator: ExtractionRunCoordinator | undefined;

  /**
   * Lazy getter: creates the ExtractionRunCoordinator on first access using
   * the orchestrator's live field references. Supports Object.create(prototype)
   * tests that set fields post-construction without invoking the constructor.
   */
  private get extractionRunCoordinator(): ExtractionRunCoordinator {
    if (!this._extractionRunCoordinator) {
      this._extractionRunCoordinator = new ExtractionRunCoordinator({
        config: this.config,
        getBuffer: () => this.buffer,
        getExtraction: () => this.extraction,
        getStorageRouter: () => this.storageRouter,
        getThreading: () => this.threading,
        persistExtraction: (result, storage, threadId, sourceContext, baseNamespace, scopeProfileWritePlan, sourceText, graphCaps, lifecycleCaps) =>
          this.persistExtraction(result, storage, threadId, sourceContext, baseNamespace, scopeProfileWritePlan, sourceText, graphCaps, lifecycleCaps),
        maybeCapturePassiveCorrections: (turns, opts) => this.maybeCapturePassiveCorrections(turns, opts),
        resolveSelfNamespace: (sessionKey) => this.resolveSelfNamespace(sessionKey),
        getCodingContextForSession: (sessionKey) => this.getCodingContextForSession(sessionKey),
        applyCodingNamespaceOverlay: (sessionKey, namespace) => this.applyCodingNamespaceOverlay(sessionKey, namespace),
        boxBuilderFor: (storage) => this.boxBuilderFor(storage),
        appendPersistedThreadEpisodes: (threadId, ids) => this.appendPersistedThreadEpisodes(threadId, ids),
        maybeScheduleConsolidation: (nonZero) => this.maybeScheduleConsolidation(nonZero),
        requestQmdMaintenance: () => this.requestQmdMaintenance(),
        runTierMigrationCycle: (storage, trigger, options) => this.runTierMigrationCycle(storage, trigger, options),
        getLastPersistExtractionDeferredCount: () => this.lastPersistExtractionDeferredCount,
        recordProcessedExtractionFingerprint: (storage, fingerprint, preloadedMeta) =>
          this.recordProcessedExtractionFingerprint(storage, fingerprint, preloadedMeta),
      });
    }
    return this._extractionRunCoordinator;
  }
  /**
   * Consolidation-run coordinator (issue #1526 seam 17). Owns
   * the full consolidation maintenance pass (LLM merge/invalidate/update,
   * entity merge, commitment/TTL cleanup, lifecycle policy, compression
   * guideline learning, tier migration, fact archival, semantic consolidation,
   * identity consolidation, profile consolidation, summarization, topic
   * extraction, TMT rebuild). The orchestrator delegates and injects
   * its own methods + coordinators.
   */
  private _consolidationRunCoordinator: ConsolidationRunCoordinator | undefined;

  private get consolidationRunCoordinator(): ConsolidationRunCoordinator {
    if (!this._consolidationRunCoordinator) {
      this._consolidationRunCoordinator = new ConsolidationRunCoordinator({
        config: this.config,
        getStorage: () => this.storage,
        getStorageRouter: () => this.storageRouter,
        getExtraction: () => this.extraction,
        embeddingFallback: this.embeddingFallback,
        tmtBuilder: this.tmtBuilder,
        consolidationObservers: this.consolidationObservers,
        getAccessTrackingBuffer: () => this.accessTrackingBuffer,
        lifecyclePolicyCoordinator: this.lifecyclePolicyCoordinator,
        compressionGuidelineCoordinator: this.compressionGuidelineCoordinator,
        semanticConsolidationCoordinator: this.semanticConsolidationCoordinator,
        entitySynthesisCoordinator: this.entitySynthesisCoordinator,
        recallSectionCoordinator: this.recallSectionCoordinator,
        tierMigrationCoordinator: this.tierMigrationCoordinator,
        flushAccessTracking: () => this.flushAccessTracking(),
        indexPersistedMemory: (storage, memoryId) => this.indexPersistedMemory(storage, memoryId),
        autoConsolidateIdentity: () => this.autoConsolidateIdentity(),
        fastChatCompletion: (messages, options) => this.fastChatCompletion(messages, options),
      });
    }
    return this._consolidationRunCoordinator;
  }

  /**
   * Extraction-persist coordinator (issue #1526 seam 16). Owns the
   * `persistExtraction` pipeline. Lazy: created on first access so
   * Object.create(prototype) tests that set fields post-construction work.
   */
  private _extractionPersistCoordinator: ExtractionPersistCoordinator | undefined;

  private get extractionPersistCoordinator(): ExtractionPersistCoordinator {
    if (!this._extractionPersistCoordinator) {
      this._extractionPersistCoordinator = new ExtractionPersistCoordinator({
        config: this.config,
        getStorageRouter: () => this.storageRouter,
        getThreading: () => this.threading,
        getLocalLlm: () => this.localLlm,
        getQmd: () => this.qmd,
        getJudgeVerdictCache: () => this.judgeVerdictCache,
        getJudgeDeferCounts: () => this.judgeDeferCounts,
        getFaithfulnessCounters: () => this.faithfulnessCounters,
        getEmbeddingFallback: () => this.embeddingFallback,
        setLastPersistExtractionDeferredCount: (v) => { this.lastPersistExtractionDeferredCount = v; },
        setLastPersistExtractionPendingReviewIds: (ids) => { this.lastPersistExtractionPendingReviewIds = ids; },
        addContentHashDedup: (targetStorage, content) => this.addContentHashDedup(targetStorage, content),
        hasContentHashDedup: (targetStorage, content) => this.hasContentHashDedup(targetStorage, content),
        backfillTemporalBoundsOnDedupHit: (targetStorage, dedupContent, bounds, entityRef) =>
          this.backfillTemporalBoundsOnDedupHit(targetStorage, dedupContent, bounds, entityRef),
        saveContentHashIndexes: () => this.saveContentHashIndexes(),
        artifactTypeForCategory: (category) => this.artifactTypeForCategory(category),
        loadRoutingRules: () => this.loadRoutingRules(),
        routeEngineOptions: () => this.routeEngineOptions(),
        semanticDedupLookup: (content, limit, targetStorage) =>
          this.semanticDedupLookup(content, limit, targetStorage),
        checkForContradiction: (content, category, namespaceScope) =>
          this.checkForContradiction(content, category, namespaceScope),
        applyDeferredContradictionResolve: (contradiction, storage, newMemoryId, postWriteGuard) =>
          this.applyDeferredContradictionResolve(contradiction, storage, newMemoryId, postWriteGuard),
        suggestLinksForMemory: (content, category, namespaceScope) =>
          this.suggestLinksForMemory(content, category, namespaceScope),
        storageDirNamespace: (storageDir) => this.storageDirNamespace(storageDir),
        indexPersistedMemory: (storage, memoryId) => this.indexPersistedMemory(storage, memoryId),
        buildGraphEdge: (storage, memoryRelPath, entityRef, memoryId, factContent, allMemsForGraph, memoryPathById, threadIdForEdge, threadEpisodeIdsForGraph, fallbackCausalPredecessor, graphCaps) =>
          this.buildGraphEdge(storage, memoryRelPath, entityRef, memoryId, factContent, allMemsForGraph, memoryPathById, threadIdForEdge, threadEpisodeIdsForGraph, fallbackCausalPredecessor, graphCaps),
        updateTemporalTagIndexes: (storage, persistedIds) =>
          this.updateTemporalTagIndexes(storage, persistedIds),
      });
    }
    return this._extractionPersistCoordinator;
  }
  /**
   * Issue #1526: recall result formatting + identity continuity section moved
   * to RecallResultFormatter.
   */
  readonly recallResultFormatter: RecallResultFormatter;
  /**
   * Issue #1526: conversation-index subsystem moved to
   * ConversationIndexCoordinator.
   */
  readonly conversationIndexCoordinator: ConversationIndexCoordinator;
  readonly recallRerankCoordinator: RecallRerankCoordinator;
  readonly recallSectionCoordinator: RecallSectionCoordinator;
  readonly qmdResultResolver: QmdResultResolver;
  readonly contradictionLinkingCoordinator: ContradictionLinkingCoordinator;
  readonly graphRecallCoordinator: GraphRecallCoordinator;
  private heartbeatObserverChains = new Map<string, Promise<void>>();
  private recentExtractionFingerprints = new Map<string, number>();
  private readonly consolidationObservers = new Set<
    (observation: ConsolidationObservation) => Promise<void> | void
  >();
  private wearablesServiceInstance: WearablesService | null = null;
  private wearablesAutoSyncHandle: { stop(): Promise<void> } | null = null;
  private lastQmdReprobeAtMs = 0;
  private lastFileHygieneRunAtMs = 0;
  // Pattern-reinforcement cadence gate (issue #687 PR 2/4).  Tracks the
  // last successful run so `runPatternReinforcement` can short-circuit
  // when the configured cadence has not elapsed.  Keyed by namespace
  // so MCP-triggered runs in tenant A don't suppress runs in tenant B
  // (PR #730 review feedback, Codex P2).  The default-tenant path
  // uses the empty-string key.
  private lastPatternReinforcementAtByNs = new Map<string, number>();
  private lastRecallFailureLogAtMs = 0;
  private lastRecallFailureAtMs = 0;
  private suppressedRecallFailures = 0;
  private readonly policyRuntime: PolicyRuntimeManager;
  private runtimePolicyValues: RuntimePolicyValues | null = null;
  private utilityRuntimeValues: UtilityRuntimeValues | null = null;
  private evalShadowWriteChain: Promise<void> = Promise.resolve();

  // Pending background observation-mode direct-answer annotations (#518).
  // Tracks fire-and-forget `annotateDirectAnswerTier` calls so callers (tests,
  // waitForDirectAnswerObservationIdle) can await settlement.
  private directAnswerObservationChain: Promise<void> = Promise.resolve();

  // Initialization gate: recall() awaits this before proceeding
  private initPromise: Promise<void> | null = null;
  private resolveInit: (() => void) | null = null;

  /**
   * Resolves when deferred initialization (QMD probe, warmup, caches, cron)
   * completes. CLI and http-serve callers that need `qmd.isAvailable()` to
   * reflect reality should `await orchestrator.deferredReady` after
   * `initialize()`. Gateway callers can ignore it — recall() degrades
   * gracefully when QMD isn't ready yet.
   *
   * Also resolves (without error) when `initialize()` throws before reaching
   * the deferred-init phase, so callers never hang on a permanently-pending
   * promise.
   *
   * Host adapters that need to tie deferred init to their stop() lifecycle
   * should `await orchestrator.deferredReady` before proceeding with teardown
   * to prevent background QMD/warmup/cron tasks from racing with shutdown.
   */
  deferredReady: Promise<void> = Promise.resolve();
  private resolveDeferredReady: (() => void) | null = null;
  private deferredInitAbort: AbortController | null = null;

  /**
   * Whether the deferred init's QMD startup sync completed successfully.
   * When false after deferredReady resolves, the server retry loop should
   * attempt startupSearchSync() even if `qmd.isAvailable()` is true —
   * availability only means probe succeeded, not that the index is current.
   */
  deferredSyncSucceeded = false;

  /**
   * Abort deferred initialization so background QMD sync/warmup stops
   * promptly on shutdown. Safe to call multiple times or before init.
   */
  abortDeferredInit(): void {
    if (this.deferredInitAbort) {
      this.deferredInitAbort.abort();
      this.deferredInitAbort = null;
    }
  }

  private async disposeSearchBackendIfNeeded(): Promise<void> {
    await (this.qmd as { dispose?: () => void | Promise<void> }).dispose?.();
  }

  /**
   * Stop background initialization and release runtime-owned handles.
   * Long-lived hosts should call this from their shutdown path; one-shot
   * commands should call it before returning to let Node exit naturally.
   */
  async destroy(): Promise<void> {
    this.abortDeferredInit();
    if (this.wearablesAutoSyncHandle) {
      // Aborts in-flight provider fetches and waits for the tick to
      // settle, so nothing is writing or reindexing past destroy().
      await this.wearablesAutoSyncHandle.stop();
      this.wearablesAutoSyncHandle = null;
    }
    this.maintenanceScheduler.dispose();
    await this.namespaceSearchRouter.dispose();
    await this.disposeSearchBackendIfNeeded();
    if (this.conversationQmd && this.conversationQmd !== this.qmd) {
      await (this.conversationQmd as { dispose?: () => void | Promise<void> }).dispose?.();
    }
    // Issue #1674: terminate archive-scoring worker threads on destroy.
    await disposeDefaultArchiveScoring();
  }

  /** Set per-session workspace for the next recall() call (compaction reset). @internal */
  setRecallWorkspaceOverride(sessionKey: string, dir: string): void {
    this._recallWorkspaceOverrides.set(sessionKey, dir);
  }

  /** Remove a per-session workspace selection (cleanup on error or early return). @internal */
  clearRecallWorkspaceOverride(sessionKey: string): void {
    this._recallWorkspaceOverrides.delete(sessionKey);
  }

  resolvePrincipal(sessionKey?: string): string | undefined {
    return resolvePrincipal(sessionKey, this.config);
  }

  resolveSelfNamespace(sessionKey?: string): string {
    const base = defaultNamespaceForPrincipal(
      this.resolvePrincipal(sessionKey),
      this.config,
    );
    return this.applyCodingNamespaceOverlay(sessionKey, base);
  }

  /**
   * Effective namespace a same-session LCM/structured-history READER must use
   * to find what the access `observe` surface WROTE (#1495 thread 2).
   *
   * This MUST mirror the `observe` scope plan's write-namespace resolution, NOT
   * `resolveSelfNamespace`: when no coding overlay applies, `observe` archives
   * under `config.defaultNamespace` (an unqualified observed turn is NOT moved
   * to the principal self namespace — identical to
   * `resolveCodingScopedWriteNamespace`/`memory_store`, rule 39). Only when a
   * coding overlay actually changes the namespace does the writer (and so the
   * reader) use the overlaid `project-*` namespace. Returning the self base for
   * the no-overlay case would prefix the read key with a namespace the writer
   * never used, so the reader would miss its own evidence.
   *
   * Honours the access-surface `principalOverride` (#1505 thread 2, codex): when
   * a recall supplies an authenticated principal NOT encoded in the raw
   * `sessionKey`, `observe` archived LCM under THAT principal's base namespace.
   * Deriving the base from `resolvePrincipal(sessionKey)` alone could fall back
   * to `default`, so principal `alice` observing `sess-1` would write under
   * `alice` but READ under `default`. Threading the override here keeps the read
   * base identical to the write base.
   *
   * READ-AUTHORIZATION gate (#1505 round 3, codex P2 "Gate LCM recall keys by
   * readable namespaces"): the overlay LCM read key is a `<principal>-project-*`
   * sub-namespace of the principal SELF base. The normal recall namespace set
   * below only substitutes the coding overlay when the principal SELF base is
   * actually in the readable recall set (`recallNamespacesForPrincipal` — gated
   * by `defaultRecallNamespaces.includes("self")` AND `canReadNamespace`). If a
   * principal can WRITE but not READ its self namespace (or `defaultRecall-
   * Namespaces` omits `self`), QMD/file recall never touches those overlay rows,
   * so neither may the LCM read key. When the self base is NOT readable, fall
   * back to the default store — exactly what an unqualified, unauthorized recall
   * resolves to — rather than injecting overlay rows the rest of recall excludes
   * (rule 42 read/write parity; rule 48 least-privilege).
   */
  private lcmReadNamespaceForSession(
    sessionKey?: string,
    principalOverride?: string,
  ): string {
    const principal =
      typeof principalOverride === "string" && principalOverride.length > 0
        ? principalOverride
        : this.resolvePrincipal(sessionKey);
    const base = defaultNamespaceForPrincipal(principal, this.config);
    const overlaid = this.applyCodingNamespaceOverlay(sessionKey, base);
    // No overlay → collapse to the default store so the LCM key is the raw
    // sessionKey, exactly what an unqualified observe archived under.
    if (overlaid === base) return this.config.defaultNamespace;
    // Overlay applied. Only honour it when the principal SELF base is in the
    // readable recall set (same gate the recall namespace set uses to
    // substitute the overlay). Otherwise the overlay rows are unauthorized for
    // this reader — fall back to the default store so the LCM read matches
    // what QMD/file recall would surface.
    const selfReadableInRecall = recallNamespacesForPrincipal(
      principal,
      this.config,
    ).includes(base);
    return selfReadableInRecall ? overlaid : this.config.defaultNamespace;
  }

  /**
   * Attach a coding-agent context to a session (issue #569). Called by the
   * Claude Code / Codex / Cursor connectors at session start after
   * `resolveGitContext(cwd)`. The context is consulted by the recall path
   * and the write path so that memories route to a project- (and optionally
   * branch-) scoped namespace.
   *
   * Pass `null` to clear.
   */
  setCodingContextForSession(sessionKey: string, codingContext: CodingContext | null): void {
    if (typeof sessionKey !== "string" || sessionKey.length === 0) return;
    // Defensive init — `Object.create(Orchestrator.prototype)` stubs in
    // legacy tests skip class-field initializers (rule 16 applies to test
    // teardown; we apply the same defensiveness on construction here so
    // PR 2 doesn't break those tests).
    if (!this._codingContextBySession) {
      (this as unknown as { _codingContextBySession: Map<string, CodingContext> })._codingContextBySession = new Map();
    }
    if (codingContext === null) {
      this._codingContextBySession.delete(sessionKey);
      return;
    }
    this._codingContextBySession.set(sessionKey, codingContext);
  }

  /**
   * Read-only accessor for the coding context attached to a session. Returns
   * `null` when none is set. Used by `remnic doctor` and by tests.
   *
   * Defensive `_codingContextBySession` lookup — legacy orchestrator-flush
   * tests use `Object.create(Orchestrator.prototype)` which does not run
   * class-field initializers, so the Map may be undefined on stubs.
   */
  getCodingContextForSession(sessionKey: string | undefined): CodingContext | null {
    if (typeof sessionKey !== "string" || sessionKey.length === 0) return null;
    return this._codingContextBySession?.get(sessionKey) ?? null;
  }

  /**
   * Shared helper used by both the recall path and the write path (rule 42).
   *
   * Given a base namespace computed from the principal, returns the overlaid
   * coding namespace when the session has a coding context AND
   * `codingMode.projectScope` is true AND `namespacesEnabled` is true.
   * Otherwise returns `baseNamespace` unchanged — CLAUDE.md #30 escape hatch.
   *
   * Principal isolation (CLAUDE.md rule 42): the overlay is COMBINED with
   * the principal-derived `baseNamespace` rather than replacing it, so two
   * principals working in the same repository do not share memories through
   * a common `project-*` namespace.
   *
   * Namespaces-disabled gate: when `namespacesEnabled` is false, the
   * storage router maps every namespace to the same `memoryDir`. Returning
   * `project-*` in that mode would create apparent route separation with
   * no actual storage isolation — a false-isolation trap. In that mode we
   * return `baseNamespace` unchanged so coding mode degrades to the existing
   * unscoped behavior.
   *
   * @internal
   */
  applyCodingNamespaceOverlay(sessionKey: string | undefined, baseNamespace: string): string {
    if (!resolveNamespaceCapabilities(this.config).namespaces) return baseNamespace;
    const codingContext = this.getCodingContextForSession(sessionKey);
    const overlay = resolveCodingNamespaceOverlay(codingContext, this.config.codingMode, this.config.defaultNamespace);
    if (!overlay) return baseNamespace;
    return combineNamespaces(baseNamespace, overlay.namespace);
  }

  /**
   * Register a peer ID for a session so recall can inject the peer's
   * profile into context (issue #679 PR 3/5). Pass `null` to clear.
   *
   * Connectors and the `before_agent_start` hook call this when the
   * session's counter-party is known. The ID is validated against
   * `PEER_ID_PATTERN` before storing.
   *
   * Fail-closed (Codex P1 review): an invalid peerId clears any
   * previously registered mapping for the session rather than silently
   * keeping stale data. This prevents a malformed metadata update from
   * mixing one peer's profile context into another session.
   *
   * Defensive init (Cursor review + rule 16): `Object.create(
   * Orchestrator.prototype)` stubs in legacy tests skip class-field
   * initializers, so `_peerIdBySession` may be undefined. Mirror the
   * same guard used by `setCodingContextForSession`.
   */
  setPeerIdForSession(sessionKey: string, peerId: string | null): void {
    if (typeof sessionKey !== "string" || sessionKey.length === 0) return;
    // Defensive init — mirrors setCodingContextForSession (rule 16).
    if (!this._peerIdBySession) {
      (this as unknown as { _peerIdBySession: Map<string, string> })._peerIdBySession = new Map();
    }
    if (peerId === null) {
      this._peerIdBySession.delete(sessionKey);
      return;
    }
    // Basic pattern guard — full validation lives in peers/storage.ts.
    // Invalid input is fail-closed: clear the existing mapping so stale
    // peer context can't bleed in after a bad metadata update (Codex P1).
    if (
      typeof peerId !== "string" ||
      peerId.length === 0 ||
      peerId.length > 64 ||
      !/^[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*$/.test(peerId)
    ) {
      log.warn(`setPeerIdForSession: invalid peerId — clearing session mapping`);
      this._peerIdBySession.delete(sessionKey);
      return;
    }
    this._peerIdBySession.set(sessionKey, peerId);
  }

  /**
   * Return the peer ID registered for a session, or `null` when none
   * is set. Used by `recallInternal` to inject the peer profile section.
   * Defensive `_peerIdBySession` lookup — legacy orchestrator-flush tests
   * use `Object.create(Orchestrator.prototype)` which skips class-field
   * initializers, so the Map may be undefined on stubs.
   */
  getPeerIdForSession(sessionKey: string | undefined): string | null {
    if (typeof sessionKey !== "string" || sessionKey.length === 0) return null;
    return this._peerIdBySession?.get(sessionKey) ?? null;
  }

  /**
   * Read-side overlay: returns the list of namespaces a session should read
   * from, including any read fallbacks (branch → project, global root).
   *
   * Returns `null` when:
   *   - `namespacesEnabled` is false (overlay would create false isolation)
   *   - no context attached to the session
   *   - `codingMode.projectScope` is false (CLAUDE.md #30 escape hatch)
   *
   * The returned `namespace` / `readFallbacks` are RAW overlay fragments
   * (e.g. `project-origin-ab12`). Callers MUST combine them with the
   * principal-derived base through `combineNamespaces()` before passing to
   * storage, so principal isolation is preserved (rule 42).
   *
   * @internal
   */
  applyCodingRecallOverlay(sessionKey: string | undefined): { namespace: string; readFallbacks: string[] } | null {
    if (!resolveNamespaceCapabilities(this.config).namespaces) return null;
    const codingContext = this.getCodingContextForSession(sessionKey);
    const overlay = resolveCodingNamespaceOverlay(codingContext, this.config.codingMode, this.config.defaultNamespace);
    if (!overlay) return null;
    return { namespace: overlay.namespace, readFallbacks: overlay.readFallbacks };
  }

  async getStorageForNamespace(namespace?: string): Promise<StorageManager> {
    const ns =
      typeof namespace === "string" && namespace.trim().length > 0
        ? namespace.trim()
        : this.config.defaultNamespace;
    return this.storageRouter.storageFor(ns);
  }

  private configuredNamespaceList(): string[] {
    // #1521: delegates to the scope-module resolver. The inline derivation is
    // retired so the adHocNamespaceResolutions ratchet no longer counts this
    // site.
    return getConfiguredNamespaces(this.config);
  }

  private rememberNamespaceStorageDirHint(namespace: string, storageDir?: string): void {
    if (!resolveNamespaceCapabilities(this.config).namespaces || !storageDir) return;
    const ns = normalizeNamespaceIdentity(namespace);
    if (!ns) return;
    const defaultNs = normalizeNamespaceIdentity(this.config.defaultNamespace);
    if (ns !== defaultNs && !isSafeRouteNamespace(ns)) return;

    if (!this.storageDirMatchesNamespaceHint(ns, storageDir)) return;

    const resolvedStorageDir = path.resolve(storageDir);
    let hints = this.namespaceStorageDirHints.get(resolvedStorageDir);
    if (!hints) {
      hints = new Set<string>();
      this.namespaceStorageDirHints.set(resolvedStorageDir, hints);
    }
    hints.add(ns);
  }

  private storageDirMatchesNamespaceHint(namespace: string, storageDir: string): boolean {
    const ns = normalizeNamespaceIdentity(namespace);
    if (!ns) return false;

    const resolvedStorageDir = path.resolve(storageDir);
    const resolvedMemoryDir = path.resolve(this.config.memoryDir);
    const defaultNs = normalizeNamespaceIdentity(this.config.defaultNamespace);
    if (resolvedStorageDir === resolvedMemoryDir) return ns === defaultNs;

    const resolvedNamespacesDir = path.join(resolvedMemoryDir, "namespaces");
    if (!isPathInsideStorageRoot(resolvedNamespacesDir, resolvedStorageDir)) return false;

    const rawRoot = path.resolve(resolvedNamespacesDir, ns);
    const tokenRoot = path.resolve(resolvedNamespacesDir, namespaceIdentityToken(ns));
    return resolvedStorageDir === rawRoot || resolvedStorageDir === tokenRoot;
  }

  private namespaceStorageDirHintOwnershipRank(
    record: { namespace: string },
    resolvedStorageDir: string,
    configured: Set<string>,
  ): number {
    if (resolvedStorageDir === path.resolve(this.config.memoryDir)) {
      return record.namespace === normalizeNamespaceIdentity(this.config.defaultNamespace)
        ? 0
        : 3;
    }

    const leaf = path.basename(resolvedStorageDir);
    const tokenOwnsRoot = namespaceIdentityToken(record.namespace) === leaf;
    if (tokenOwnsRoot && configured.has(record.namespace)) return 0;
    if (record.namespace === leaf) return 1;
    if (tokenOwnsRoot) return 2;
    return 3;
  }

  private preferNamespaceStorageDirHintOwner(
    current: { namespace: string; identityToken: string; storageDir: string },
    candidate: { namespace: string; identityToken: string; storageDir: string },
    resolvedStorageDir: string,
    configured: Set<string>,
  ): { namespace: string; identityToken: string; storageDir: string } {
    return this.namespaceReadFanoutCoordinator.preferNamespaceStorageDirHintOwner(
      current,
      candidate,
      resolvedStorageDir,
      configured,
    );
  }

  private loadNamespaceStorageDirHintsFromCatalog(): void {
    return this.namespaceReadFanoutCoordinator.loadNamespaceStorageDirHintsFromCatalog(
    );
  }

  private async maintenanceNamespaces(
    jobName = "qmd",
    budgetMode: "cycle" | "unbounded" = "unbounded",
  ): Promise<string[]> {
    const plan = await planNamespaceMaintenance(this.config, {
      jobName,
      catalog: this.namespaceCatalog,
      budgetMode,
    });
    return plan.namespaces.map((candidate) => candidate.namespace);
  }

  /**
   * Fan out a maintenance job across all maintained namespaces (issue #1500).
   *
   * Delegates to the namespace-maintenance-fanout coordinator, which plans
   * namespace discovery (configured + catalog), applies the cycle budget,
   * acquires per-job+namespace locks, records status files, and touches the
   * catalog's `lastMaintenanceAt`. The runner receives a per-namespace
   * candidate and a storage resolver wired to `this.getStorage(namespace)`.
   *
   * When namespaces are disabled the planner returns only the default
   * namespace, so the job runs exactly once — preserving single-user behavior.
   */
  async runNamespaceMaintenanceFanoutForJob(
    jobName: string,
    runner: (ctx: NamespaceMaintenanceFanoutRunnerContext) => Promise<{ itemCount?: number } | undefined>,
    options: { enabled?: boolean } = {},
  ): Promise<NamespaceMaintenanceSummary> {
    return runNamespaceMaintenanceFanout({
      config: this.config,
      catalog: this.namespaceCatalog,
      jobName,
      runner,
      resolveStorage: (namespace) => this.getStorage(namespace),
      enabled: options.enabled,
    });
  }

  /**
   * Read-only namespace maintenance health summary for doctor / dashboard /
   * CLI (issue #1500). Aggregates all per-namespace maintenance status files
   * into one report without running any maintenance.
   */
  async readNamespaceMaintenanceHealth(): Promise<NamespaceMaintenanceHealthSummary> {
    return summarizeNamespaceMaintenanceHealth(this.config);
  }

  private buildConfiguredQmdSearchOptions(
    queryText: string,
  ): SearchQueryOptions | undefined {
    const intentHint = resolveQmdCapabilities(this.config).qmdIntentHints
      ? buildQmdIntentHint(inferIntentFromText(queryText))
      : undefined;
    const explain = resolveQmdCapabilities(this.config).qmdExplain === true;
    const searchOptions: SearchQueryOptions = {};
    if (intentHint) {
      searchOptions.intent = intentHint;
    }
    if (explain) {
      searchOptions.explain = true;
    }
    return Object.keys(searchOptions).length > 0 ? searchOptions : undefined;
  }

  async searchAcrossNamespaces(options: {
    query: string;
    namespaces?: string[];
    maxResults?: number;
    mode?: "search" | "hybrid" | "bm25" | "vector";
    searchOptions?: SearchQueryOptions;
    execution?: SearchExecutionOptions;
  }): Promise<QmdSearchResult[]> {
    return this.namespaceReadFanoutCoordinator.searchAcrossNamespaces(
      options,
    );
  }

  async searchHealthForNamespace(
    namespace: string,
    execution?: SearchExecutionOptions,
  ): Promise<NamespaceSearchHealth> {
    return await this.namespaceSearchRouter.healthForNamespace(namespace, execution);
  }

  private isSearchAvailableForNamespaceRouting(): boolean {
    if (resolveNamespaceCapabilities(this.config).namespaces) return true;
    return this.qmd.isAvailable();
  }

  invalidateLiveContentHashIndex(): void {
    this.contentHashIndex = null;
    this.contentHashIndexesByStorageDir.clear();
  }

  private async contentHashIndexForStorage(
    targetStorage: StorageManager,
  ): Promise<ContentHashIndex | null> {
    if (!resolveRecallAuxiliaryCapabilities(this.config).factDeduplication) return null;

    if (targetStorage.dir === this.storage.dir) {
      if (!this.contentHashIndex) {
        this.contentHashIndex = this.storage.createContentHashIndex();
        await this.contentHashIndex.load();
      }
      return this.contentHashIndex;
    }

    const cached = this.contentHashIndexesByStorageDir.get(targetStorage.dir);
    if (cached) return cached;

    const index = targetStorage.createContentHashIndex();
    await index.load();
    this.contentHashIndexesByStorageDir.set(targetStorage.dir, index);
    log.info(
      `content-hash dedup: loaded ${index.size} hashes for storage ${targetStorage.dir}`,
    );
    return index;
  }

  private async hasContentHashDedup(
    targetStorage: StorageManager,
    content: string,
  ): Promise<boolean> {
    return this.persistenceIndexCoordinator.hasContentHashDedup(
      targetStorage,
      content,
    );
  }

  private async addContentHashDedup(
    targetStorage: StorageManager,
    content: string,
  ): Promise<void> {
    return this.persistenceIndexCoordinator.addContentHashDedup(
      targetStorage,
      content,
    );
  }

  private async removeContentHashForMemory(
    targetStorage: StorageManager,
    memory: MemoryFile,
    context: string,
  ): Promise<void> {
    return this.persistenceIndexCoordinator.removeContentHashForMemory(
      targetStorage,
      memory,
      context,
    );
  }

  private async backfillTemporalBoundsOnDedupHit(
    targetStorage: StorageManager,
    dedupContent: string,
    bounds: {
      invalidAt?: string;
      // #1707 thread 2 — per-fact start bound (valid_at). Carried so a
      // re-extracted duplicate whose event time yields only a start bound
      // ("since 2024", "yesterday", an absolute date) gets the corrected
      // per-fact anchoring onto the existing copy.
      validFrom?: string;
      observedAt?: string;
      eventTimeSource?: "extracted" | "assumed";
    },
    entityRef?: string,
  ): Promise<void> {
    return this.persistenceIndexCoordinator.backfillTemporalBoundsOnDedupHit(
      targetStorage,
      dedupContent,
      bounds,
      entityRef,
    );
  }

  private async saveContentHashIndexes(): Promise<void> {
    return this.persistenceIndexCoordinator.saveContentHashIndexes(
    );
  }

  constructor(config: PluginConfig) {
    this.config = config;
    this.profiler = new ProfilingCollector({
      enabled: resolvePipelineProcessingCapabilities(this.config).profiling,
      storageDir: config.profilingStorageDir || path.join(config.memoryDir, "profiling"),
      maxTraces: config.profilingMaxTraces,
    });
    // Namespace catalog (issue #1499): downstream, rebuildable metadata index.
    // Inert unless namespacesEnabled is true. Storage resolution registers
    // namespaces via the router's onResolve hook; the touch is best-effort and
    // a catalog write failure never affects storage resolution.
    this.namespaceCatalog = new NamespaceCatalog(config);
    this.storageRouter = new NamespaceStorageRouter(config, {
      // Return the registration promise (round 6, codex P2 — NEFoX) so the
      // router's resolve-hook dedup only marks a namespace notified when the
      // catalog actually APPENDED. A dropped append (rebuild-lock timeout) or a
      // failure resolves to `false`/rejects, so the next `storageFor` retries.
      onResolve: (namespace, storageDir) => {
        this.rememberNamespaceStorageDirHint(namespace, storageDir);
        return this.namespaceCatalog.registerResolved(namespace, storageDir);
      },
    }, this.namespaceCatalog);
    this.namespaceSearchRouter = new NamespaceSearchRouter(
      config,
      this.storageRouter,
    );
    this.storage = new StorageManager(config.memoryDir, config.entitySchemas);
    // Propagate the inline-attribution template so the storage layer can strip
    // citations from legacy facts during the hash-index rebuild path.
    this.storage.citationTemplate = config.inlineSourceAttributionFormat;
    // #1522: bind the post-write catalog touch at the storage chokepoint.
    if (config.defaultNamespace) this.storageRouter.bindCatalogWriteHook(this.storage, config.defaultNamespace);
    // Wire page-level versioning (issue #371)
    this.storage.setVersioningConfig({
      enabled: resolveRecallAuxiliaryCapabilities(config).versioning,
      maxVersionsPerPage: config.versioningMaxPerPage,
      sidecarDir: config.versioningSidecarDir,
    });
    // Wire the tombstone non-resurrection invariant (issue #1579) on the
    // primary default-namespace storage. Router-created namespace storages
    // get the same config via NamespaceStorageRouter.bindTombstonesConfig
    // (installed below) so every write path funnels through the chokepoint.
    const { tombstonesEnabled, tombstonesSemanticMatch, tombstonesSemanticThreshold } = config;
    this.storage.setTombstonesConfig({
      enabled: tombstonesEnabled,
      semanticMatch: tombstonesSemanticMatch,
      semanticThreshold: tombstonesSemanticThreshold,
      namespace: config.defaultNamespace,
    });
    this.storageRouter.bindTombstonesConfig(this.storage, config.defaultNamespace, {
      enabled: tombstonesEnabled,
      semanticMatch: tombstonesSemanticMatch,
      semanticThreshold: tombstonesSemanticThreshold,
    });
    // Wire at-rest encryption (issue #690 PR 3/4).
    // If secureStoreEnabled, check whether the keyring already holds a key
    // for this memory dir (e.g. operator unlocked before daemon restart).
    if (resolveRecallAuxiliaryCapabilities(config).secureStore) {
      // Mark the store as required so writes throw SecureStoreLockedError
      // instead of silently falling back to plaintext when locked (P1 finding
      // from Cursor review of PR #767).
      this.storage.setSecureStoreRequired(true);
      const storeId = secureStoreDir(config.memoryDir);
      const existingKey = keyring.getKey(storeId);
      if (existingKey) {
        this.storage.setSecureStoreKey(existingKey, config.secureStoreEncryptOnWrite);
      }
      // If no key is present the store remains locked until `remnic secure-store unlock`
      // is run — reads of encrypted files will throw SecureStoreLockedError,
      // and writes will throw SecureStoreLockedError via resolveWriteKey().
    }
    this.qmd = createSearchBackend(config);
    this.maintenanceScheduler = new MaintenanceScheduler({
      config,
      // Live accessor: the orchestrator reassigns this.qmd to NoopSearchBackend
      // after construction when the collection is missing (initialize /
      // startupSearchSync); the scheduler must read the current backend so
      // debounced maintenance never runs against a stale/disposed one.
      getQmd: () => this.qmd,
      namespaceSearchRouter: this.namespaceSearchRouter,
      namespaceCatalog: this.namespaceCatalog,
    });
    // Issue #1526: background extraction queue lives on its own coordinator.
    this.extractionQueueCoordinator = new ExtractionQueueCoordinator();

    this.recallResultFormatter = new RecallResultFormatter(this.config);
    const conversationIndexRuntime = createConversationIndexRuntime(config, {
      getQmd: () => this.conversationQmd,
      getFaiss: () => this.conversationFaiss,
    });
    this.conversationQmd = conversationIndexRuntime.qmd;
    this.conversationFaiss = conversationIndexRuntime.faiss;
    this.conversationIndexBackend = conversationIndexRuntime.backend;
    this.sharedContext = resolveConversationContextCapabilities(this.config).sharedContext
      ? new SharedContextManager(config)
      : undefined;
    this.compounding = resolveConsolidationCapabilities(config).compounding
      ? new CompoundingEngine(config, this.storage)
      : undefined;
    this.buffer = new SmartBuffer(config, this.storage);
    this.transcript = new TranscriptManager(config);
    this.conversationIndexDir = path.join(
      config.memoryDir,
      "conversation-index",
      "chunks",
    );
    this.conversationIndexCoordinator = new ConversationIndexCoordinator({
      config,
      getTranscript: () => this.transcript,
      getBackend: () => this.conversationIndexBackend,
      indexDir: this.conversationIndexDir,
    });
    this.recallRerankCoordinator = new RecallRerankCoordinator({
      getConfig: () => this.config,
      getStorage: (namespace) => this.getStorage(namespace),
      readQmdResultMemory: (resultPath, fallbackStorage, recallNamespaces) =>
        this.readQmdResultMemory(resultPath, fallbackStorage, recallNamespaces),
    });
    this.recallSectionCoordinator = new RecallSectionCoordinator({
      getConfig: () => this.config,
      resolveSectionEnabled: (id, def) => this.isRecallSectionEnabled(id, def),
    });
    this.contradictionLinkingCoordinator = new ContradictionLinkingCoordinator({
      getConfig: () => this.config,
      isSearchAvailable: () => this.isSearchAvailableForNamespaceRouting(),
      searchAcrossNamespaces: (options) => this.searchAcrossNamespaces(options),
      extractMemoryIdsFromResults: (results) => this.extractMemoryIdsFromResults(results),
      namespaceFromPath: (p) => this.namespaceFromPath(p),
      storageForNamespace: (namespace) => this.storageRouter.storageFor(namespace),
      getExtraction: () => this.extraction,
    });
    this.modelRegistry = new ModelRegistry(config.memoryDir);
    this.graphRecallCoordinator = new GraphRecallCoordinator({
      getConfig: () => this.config,
      getStorage: () => this.storage,
      storageFor: (namespace) => this.storageRouter.storageFor(namespace),
      graphIndexFor: (storage) => this.graphIndexFor(storage),
      namespaceFromPath: (p) => this.namespaceFromPath(p),
      resolveColdQmdResultForRecall: (result, fallbackStorage, recallNamespaces) =>
        this.resolveColdQmdResultForRecall(result, fallbackStorage, recallNamespaces),
      storageForAbsoluteQmdResultPath: (resultPath, fallbackStorage, recallNamespaces) =>
        this.storageForAbsoluteQmdResultPath(resultPath, fallbackStorage, recallNamespaces),
      readQmdResultMemory: (resultPath, fallbackStorage, recallNamespaces) =>
        this.readQmdResultMemory(resultPath, fallbackStorage, recallNamespaces),
    });
    this.relevance = new RelevanceStore(config.memoryDir);
    this.negatives = new NegativeExampleStore(config.memoryDir);
    this.lastRecall = new LastRecallStore(config.memoryDir);
    this.handleHistory = new RecallHandleHistoryStore(config.memoryDir, {
      maxDepth: config.recallHandleSnapshotDepth,
    });
    this.tierMigrationStatus = new TierMigrationStatusStore(config.memoryDir);
    this.tierMigrationCoordinator = new TierMigrationCoordinator({
      config,
      getQmd: () => this.qmd,
      tierMigrationStatus: this.tierMigrationStatus,
      getUtilityRuntimeValues: () => this.utilityRuntimeValues,
      getCompounding: () => this.compounding,
      createColdStorage: (parentDir) => new StorageManager(parentDir),
    });
    this.compressionGuidelineCoordinator = new CompressionGuidelineCoordinator({
      config,
      getStorage: () => this.storage,
      fastChatCompletion: (messages, options) =>
        this.fastChatCompletion(messages, options),
    });
    this.entitySynthesisCoordinator = new EntitySynthesisCoordinator({
      config,
      getStorage: (namespace) => this.getStorage(namespace),
      fastChatCompletion: (messages, options) =>
        this.fastChatCompletion(messages, options),
    });
    this.qmdResultResolver = new QmdResultResolver({
      getConfig: () => this.config,
      storageFor: (namespace) => this.storageRouter.storageFor(namespace),
      storageDirNamespace: (storageDir) => this.storageDirNamespace(storageDir),
      qmdCollectionNamespaceFromPrefix: (prefix) => this.qmdCollectionNamespaceFromPrefix(prefix),
      namespaceFromPath: (p) => this.namespaceFromPath(p),
    });

    this.sessionObserver = new SessionObserverState({
      memoryDir: config.memoryDir,
      debounceMs: config.sessionObserverDebounceMs ?? 120_000,
      bands: config.sessionObserverBands ?? [],
    });
    this.embeddingFallback = new EmbeddingFallback(config);
    this.policyRuntime = new PolicyRuntimeManager(config.memoryDir, config);
    this.summarizer = new HourlySummarizer(
      config,
      config.gatewayConfig,
      this.modelRegistry,
      this.transcript,
    );
    this.judgeVerdictCache = createVerdictCache();
    this.judgeDeferCounts = createDeferCountMap();
    this.localLlm = new LocalLlmClient(config, this.modelRegistry);
    // Issue #548: the main local-LLM client is used by extraction,
    // consolidation, and other structured-output tasks that gain
    // nothing from chain-of-thought reasoning.  Apply the operator's
    // configured preference (default true) so thinking-capable models
    // skip reasoning tokens and avoid the common 60s extraction
    // timeout.  Operators can set `localLlmDisableThinking: false`
    // when they want thinking enabled for narrative paths.
    this.localLlm.disableThinking = config.localLlmDisableThinking;
    this.fastLlm = resolvePipelineProcessingCapabilities(this.config).localLlmFast
      ? (() => {
          const client = new LocalLlmClient(
            {
              ...config,
              localLlmModel: config.localLlmFastModel || config.localLlmModel,
              localLlmUrl: config.localLlmFastUrl,
              localLlmTimeoutMs: config.localLlmFastTimeoutMs,
            },
            this.modelRegistry,
          );
          // Fast-tier always suppresses thinking — the contract of
          // `fastLlm` is "low latency at all costs" and that is
          // independent of the main-client config.
          client.disableThinking = true;
          return client;
        })()
      : this.localLlm;
    this.semanticConsolidationCoordinator = new SemanticConsolidationCoordinator({
      config,
      getStorage: () => this.storage,
      getFastLlm: () => this.fastLlm,
      embeddingFallback: this.embeddingFallback,
      removeContentHashForMemory: (targetStorage, memory, context) =>
        this.removeContentHashForMemory(targetStorage, memory, context),
      saveContentHashIndexes: () => this.saveContentHashIndexes(),
    });
    // Initialize gateway fast LLM for fast-tier ops when modelSource is "gateway"
    this._fastGatewayLlm = config.modelSource === "gateway"
      ? new FallbackLlmClient(
          config.gatewayConfig,
          fallbackLlmRuntimeContextFromConfig(config),
        )
      : null;
    if (config.modelSource === "gateway") {
      log.debug(
        `orchestrator: gateway model source active` +
          (config.gatewayAgentId ? ` (primary: ${config.gatewayAgentId})` : "") +
          (config.fastGatewayAgentId ? ` (fast: ${config.fastGatewayAgentId})` : ""),
      );
    }
    this.extraction = new ExtractionEngine(
      config,
      this.profiler,
      this.localLlm,
      config.gatewayConfig,
      this.modelRegistry,
    );
    this.lifecyclePolicyCoordinator = new LifecyclePolicyCoordinator({
      config,
      getStorage: () => this.storage,
      extraction: this.extraction,
      embeddingFallback: this.embeddingFallback,
      getEffectiveLifecycleThresholds: () => this.effectiveLifecycleThresholds(),
      removeContentHashForMemory: (targetStorage, memory, context) =>
        this.removeContentHashForMemory(targetStorage, memory, context),
      saveContentHashIndexes: () => this.saveContentHashIndexes(),
    });
    this.threading = new ThreadingManager(
      path.join(config.memoryDir, "threads"),
      config.threadingGapMinutes,
    );
    // BoxBuilders are created per-namespace on first use in runExtraction().

    const lifecycleCaps = resolveMemoryLifecycleCapabilities(config);
    // Temporal Memory Tree (v8.2) — lazy build during consolidation
    this.tmtBuilder = new TmtBuilder(config.memoryDir, {
      temporalMemoryTreeEnabled: lifecycleCaps.temporalMemoryTree,
      tmtHourlyMinMemories: config.tmtHourlyMinMemories,
      tmtSummaryMaxTokens: config.tmtSummaryMaxTokens,
    });

    // Lossless Context Management (LCM) — proactive session archive + DAG summarization
    if (resolvePipelineProcessingCapabilities(this.config).lcm) {
      const summarizeFn = async (
        text: string,
        targetTokens: number,
        aggressive: boolean,
      ) => {
        const instructionText = aggressive
          ? `Compress the following into bullet points. One bullet per distinct fact or decision. Maximum ${targetTokens} tokens total. No prose.`
          : `Compress the following conversation segment into a dense summary. Preserve: decisions made, code artifacts mentioned, errors encountered, open questions, and any commitments or next-steps. Omit: pleasantries, restatements, and anything the agent would not need to recall later. Output a single paragraph, maximum ${targetTokens} tokens.`;
        try {
          const messages = [
            { role: "system" as const, content: instructionText },
            { role: "user" as const, content: text.slice(0, 12000) },
          ];
          const result = this.config.modelSource === "gateway" && this._fastGatewayLlm
            ? await this._fastGatewayLlm.chatCompletion(messages, {
                maxTokens: targetTokens * 2,
                timeoutMs: this.config.localLlmFastTimeoutMs,
                // LCM is latency-sensitive. A configured fast persona is the
                // explicit fast-tier route; otherwise use taskModelChain so LCM
                // avoids falling to an expensive gateway default. Issue #1473.
                ...(this.config.fastGatewayAgentId
                  ? { agentId: this.config.fastGatewayAgentId }
                  : gatewayTaskChainOptions(this.config)),
              })
            : await this.localLlm.chatCompletion(messages, {
                maxTokens: targetTokens * 2,
                operation: "lcm-summarize",
                priority: "background",
              });
          return result?.content ?? null;
        } catch {
          return null;
        }
      };
      this.lcmEngine = new LcmEngine(config, summarizeFn);
    }

    // Create init gate — recall() will await this before proceeding
    this.initPromise = new Promise<void>((resolve) => {
      this.resolveInit = resolve;
    });

    // deferredReady is NOT created here — the property initializer provides a
    // safe default (Promise.resolve()), and initialize() recreates it on every
    // call. Creating a pending promise in the constructor would be orphaned
    // since initialize() unconditionally overwrites it.
  }

  /** Get or create a BoxBuilder for the given namespace storage root (namespace-isolated). */
  private boxBuilderFor(storage: StorageManager): BoxBuilder {
    const dir = storage.dir;
    if (!this.boxBuilders.has(dir)) {
      this.boxBuilders.set(
        dir,
        new BoxBuilder(dir, {
          memoryBoxesEnabled: resolvePresentationCapabilities(this.config).memoryBoxes,
          traceWeaverEnabled: resolvePipelineProcessingCapabilities(this.config).traceWeaver,
          boxTopicShiftThreshold: this.config.boxTopicShiftThreshold,
          boxTimeGapMs: this.config.boxTimeGapMs,
          boxMaxMemories: this.config.boxMaxMemories,
          traceWeaverLookbackDays: this.config.traceWeaverLookbackDays,
          traceWeaverOverlapThreshold: this.config.traceWeaverOverlapThreshold,
        }),
      );
    }
    return this.boxBuilders.get(dir)!;
  }

  private effectiveRecencyWeight(): number {
    return applyRuntimeRetrievalPolicy(
      { recencyWeight: this.config.recencyWeight },
      this.runtimePolicyValues,
    ).recencyWeight;
  }

  private effectiveCronRecallInstructionHeavyTokenCap(): number {
    return (
      this.runtimePolicyValues?.cronRecallInstructionHeavyTokenCap ??
      this.config.cronRecallInstructionHeavyTokenCap
    );
  }

  private currentPolicyVersion(): string {
    const thresholds = this.effectiveLifecycleThresholds();
    const payload = {
      recencyWeight: this.effectiveRecencyWeight(),
      lifecyclePromoteHeatThreshold: thresholds.promoteHeatThreshold,
      lifecycleStaleDecayThreshold: thresholds.staleDecayThreshold,
      cronRecallInstructionHeavyTokenCap:
        this.effectiveCronRecallInstructionHeavyTokenCap(),
      utilityRankingBoostMultiplier:
        this.utilityRuntimeValues?.rankingBoostMultiplier ?? 1,
      utilityRankingSuppressMultiplier:
        this.utilityRuntimeValues?.rankingSuppressMultiplier ?? 1,
      utilityPromoteThresholdDelta:
        this.utilityRuntimeValues?.promoteThresholdDelta ?? 0,
      utilityDemoteThresholdDelta:
        this.utilityRuntimeValues?.demoteThresholdDelta ?? 0,
    };
    return createHash("sha256")
      .update(JSON.stringify(payload))
      .digest("hex")
      .slice(0, 12);
  }

  private effectiveLifecycleThresholds(): {
    promoteHeatThreshold: number;
    staleDecayThreshold: number;
    archiveDecayThreshold: number;
  } {
    const archiveDecayThreshold = this.config.lifecycleArchiveDecayThreshold;
    const staleDecayThreshold = Math.min(
      this.runtimePolicyValues?.lifecycleStaleDecayThreshold ??
        this.config.lifecycleStaleDecayThreshold,
      archiveDecayThreshold,
    );
    return {
      promoteHeatThreshold:
        this.runtimePolicyValues?.lifecyclePromoteHeatThreshold ??
        this.config.lifecyclePromoteHeatThreshold,
      staleDecayThreshold,
      archiveDecayThreshold,
    };
  }

  private routeEngineOptions(): RoutingEngineOptions {
    const allowedNamespaces = resolveNamespaceCapabilities(this.config).namespaces
      ? Array.from(
          new Set([
            this.config.defaultNamespace,
            this.config.sharedNamespace,
            ...this.config.namespacePolicies.map((policy) => policy.name),
          ]),
        )
      : [this.config.defaultNamespace];
    return { allowedNamespaces };
  }

  private getRoutingRulesStore(): RoutingRulesStore {
    if (!this.routingRulesStore) {
      this.routingRulesStore = new RoutingRulesStore(
        this.config.memoryDir,
        this.config.routingRulesStateFile,
      );
    }
    return this.routingRulesStore;
  }

  private async loadRoutingRules(): Promise<RouteRule[]> {
    if (!resolvePipelineProcessingCapabilities(this.config).routingRules) return [];
    try {
      return await this.getRoutingRulesStore().read(this.routeEngineOptions());
    } catch (err) {
      log.warn(
        `routing rules unavailable; fail-open to default writes: ${err}`,
      );
      return [];
    }
  }

  private async resolveArtifactSourceStatuses(
    storage: StorageManager,
    sourceIds: string[],
  ): Promise<Map<string, "active" | "superseded" | "archived" | "missing">> {
    return this.namespaceReadFanoutCoordinator.resolveArtifactSourceStatuses(
      storage,
      sourceIds,
    );
  }

  /**
   * Execute a fast-tier LLM chat completion.
   * When gateway model source is active and fastGatewayAgentId is configured,
   * routes through the gateway chain. Otherwise uses the local fast LLM.
   */
  private async fastChatCompletion(
    messages: Array<{ role: string; content: string }>,
    options: { temperature?: number; maxTokens?: number; timeoutMs?: number; operation?: string; priority?: "background" | "recall-critical" },
  ): Promise<{ content: string } | null> {
    if (this._fastGatewayLlm && this.config.modelSource === "gateway") {
      const agentId =
        this.config.fastGatewayAgentId || this.config.gatewayAgentId || undefined;
      const result = await this._fastGatewayLlm.chatCompletion(
        messages as Array<{ role: "system" | "user" | "assistant"; content: string }>,
        { temperature: options.temperature, maxTokens: options.maxTokens, timeoutMs: options.timeoutMs, agentId },
      );
      return result ? { content: result.content } : null;
    }
    const result = await this.fastLlm.chatCompletion(messages, {
      ...options,
      forceDisableThinking: true,
    });
    return result ? { content: result.content } : null;
  }

  /**
   * Get a fast-tier LLM client compatible with the rerank interface.
   * When gateway model source is active, routes through the gateway fast chain.
   * Otherwise returns the local fast LLM directly.
   */
  get fastLlmForRerank(): {
    chatCompletion: (
      messages: Array<{ role: string; content: string }>,
      options?: { maxTokens?: number; temperature?: number; timeoutMs?: number; operation?: string; priority?: "recall-critical" | "background" },
    ) => Promise<{ content: string } | null>;
  } {
    if (this._fastGatewayLlm && this.config.modelSource === "gateway") {
      return {
        chatCompletion: (messages, options) =>
          this.fastChatCompletion(messages, options ?? {}),
      };
    }
    return {
      chatCompletion: (messages, options) =>
        this.fastLlm.chatCompletion(messages, {
          ...(options ?? {}),
          forceDisableThinking: true,
        }),
    };
  }

  /**
   * Build a briefing follow-up generator backed by the configured LLM chain
   * (gateway model source or local LLM). Returns `undefined` when no chain
   * is available so `buildBriefing` can surface a clear unavailable reason
   * instead of failing at call time. Used by the access service and CLI as
   * the fallback when no direct `openaiApiKey` is configured, so briefing
   * follow-ups ride the same routing as every other fast-tier LLM feature.
   */
  get briefingChainFollowupGenerator(): BriefingFollowupGenerator | undefined {
    // Plugin mode gates on `localLlmEnabled` alone: `LocalLlmClient.chatCompletion`
    // returns null when the master switch is off, so `localLlmFastEnabled` by
    // itself cannot serve requests (Cursor review on PR #1463).
    const chainAvailable =
      this.config.modelSource === "gateway"
        ? this._fastGatewayLlm?.isAvailable(
            this.config.fastGatewayAgentId || this.config.gatewayAgentId || undefined,
          ) === true
        : resolveLocalLlmCapabilities(this.config).localLlm;
    if (!chainAvailable) return undefined;
    return buildChainFollowupGenerator(this.fastLlmForRerank);
  }

  async initialize(): Promise<void> {
    return this.orchestratorInitCoordinator.initialize(
    );
  }

  private async deferredInitialize(signal: AbortSignal): Promise<void> {
    return this.orchestratorInitCoordinator.deferredInitialize(
      signal,
    );
  }

  async startupSearchSync(signal?: AbortSignal): Promise<boolean> {
    return this.orchestratorInitCoordinator.startupSearchSync(
      signal,
    );
  }

  async runPatternReinforcement(options: {
    force?: boolean;
    namespace?: string;
  } = {}): Promise<{
    ran: boolean;
    skippedReason?: "disabled" | "cadence";
    namespace: string;
    result?: PatternReinforcementResult;
  }> {
    return this.workspaceOpsCoordinator.runPatternReinforcement(
      options,
    );
  }

  async runPatternReinforcementFanout(options: {
    force?: boolean;
  } = {}): Promise<NamespaceMaintenanceSummary> {
    return this.workspaceOpsCoordinator.runPatternReinforcementFanout(
      options,
    );
  }

  /**
   * Fan out lifecycle/governance policy across all maintained namespaces
   * (issue #1500). Each namespace gets its own lifecycle pass against its
   * namespace-scoped storage. When namespaces are disabled, runs once against
   * default storage.
   */
  async runLifecyclePolicyFanout(): Promise<NamespaceMaintenanceSummary> {
    const lifecycleCaps = resolveMemoryLifecycleCapabilities(this.config);
    return this.runNamespaceMaintenanceFanoutForJob(
      "lifecycle",
      async (ctx) => {
        const storage = await this.getStorage(ctx.candidate.namespace);
        const corpus = await storage.readAllMemories();
        const assessed = await this.runLifecyclePolicyPass(corpus, storage);
        return { itemCount: assessed };
      },
      { enabled: lifecycleCaps.lifecyclePolicy },
    );
  }

  /**
   * Fan out semantic consolidation across all maintained namespaces (issue #1500).
   * Each namespace gets its own consolidation pass against its namespace-scoped
   * storage. When namespaces are disabled, runs once against default storage.
   */
  async runSemanticConsolidationFanout(options: {
    dryRun?: boolean;
  } = {}): Promise<NamespaceMaintenanceSummary> {
    return this.runNamespaceMaintenanceFanoutForJob(
      "semantic-consolidation",
      async (ctx) => {
        const storage = await this.getStorage(ctx.candidate.namespace);
        const result = await this.runSemanticConsolidation({
          dryRun: options.dryRun,
          thresholdOverride: undefined,
          force: true,
          storage,
        });
        return { itemCount: result.clustersFound };
      },
      { enabled: resolveConsolidationCapabilities(this.config).semanticConsolidation },
    );
  }

  /**
   * Fan out deep-sleep governance across all maintained namespaces (issue #1500).
   * Each namespace gets its own governance scan against its namespace-scoped
   * storage. When namespaces are disabled, runs once against default storage.
   */
  async runDeepSleepGovernanceFanout(options: {
    dryRun?: boolean;
  } = {}): Promise<NamespaceMaintenanceSummary> {
    return this.runNamespaceMaintenanceFanoutForJob(
      "governance",
      async (ctx) => {
        const storage = await this.getStorage(ctx.candidate.namespace);
        const result = await this.runDeepSleepGovernanceNow({
          dryRun: options.dryRun,
          storage,
        });
        return { itemCount: result.scannedMemories };
      },
      { enabled: this.config.dreamsPhases.deepSleep.enabled },
    );
  }

  async runLiveConnectors(options: {
    force?: boolean;
    abortSignal?: AbortSignal;
  } = {}): Promise<LiveConnectorsRunSummary> {
    return runLiveConnectorsOnce({
      memoryDir: this.config.memoryDir,
      connectors: this.config.connectors,
      force: options.force === true,
      abortSignal: options.abortSignal,
      ingestDocuments: async (docs) => {
        const fetchedAt = new Date().toISOString();
        const turns = docs.map((doc) => ({
          role: "assistant" as const,
          content: doc.title
            ? `# ${doc.title}\n\n${doc.content}`
            : doc.content,
          timestamp: fetchedAt,
        }));
        await this.ingestBulkImportBatch(turns);
      },
    });
  }


  async applyBehaviorRuntimePolicy(
    state: BehaviorLoopPolicyState,
  ): Promise<{
    applied: boolean;
    rolledBack: boolean;
    values: RuntimePolicyValues | null;
    reason: string;
  }> {
    const result = await this.policyRuntime.applyFromBehaviorState(state);
    this.runtimePolicyValues = await this.policyRuntime.loadRuntimeValues();
    return result;
  }

  async rollbackBehaviorRuntimePolicy(): Promise<boolean> {
    const rolledBack = await this.policyRuntime.rollback();
    this.runtimePolicyValues = await this.policyRuntime.loadRuntimeValues();
    return rolledBack;
  }

  async maybeRunFileHygiene(): Promise<void> {
    return this.workspaceOpsCoordinator.maybeRunFileHygiene(
    );
  }

  async runBootstrap(options: BootstrapOptions): Promise<BootstrapResult> {
    const engine = new BootstrapEngine(this.config, this);
    return engine.run(options);
  }

  async runConsolidationNow(): Promise<{
    memoriesProcessed: number;
    merged: number;
    invalidated: number;
  }> {
    return this.runConsolidation();
  }

  async reindexMemoryById(
    id: string,
    options?: { storage?: StorageManager },
  ): Promise<void> {
    await this.indexPersistedMemory(options?.storage ?? this.storage, id);
    this.requestQmdMaintenance();
  }

  registerConsolidationObserver(
    observer: (observation: ConsolidationObservation) => Promise<void> | void,
  ): () => void {
    this.consolidationObservers.add(observer);
    return () => {
      this.consolidationObservers.delete(observer);
    };
  }

  async runSemanticConsolidationNow(options?: {
    dryRun?: boolean;
    thresholdOverride?: number;
    storage?: StorageManager;
  }): Promise<SemanticConsolidationResult> {
    return this.runSemanticConsolidation({ ...options, force: true });
  }

  async runDeepSleepGovernanceNow(options?: {
    dryRun?: boolean;
    storage?: StorageManager;
  }): Promise<{ scannedMemories: number; appliedActionCount: number; notes?: string }> {
    const targetStorage = options?.storage ?? this.storage;
    const { runMemoryGovernance } = await import("./maintenance/memory-governance.js");
    const { summarizeGovernanceResultForDreams } = await import("./maintenance/dreams-ledger.js");
    const govResult = await runMemoryGovernance({
      memoryDir: targetStorage.dir,
      mode: options?.dryRun === true ? "shadow" : "apply",
    });
    if (options?.dryRun !== true) {
      try {
        await this.processEntitySynthesisQueue(
          this.storageDirNamespace(targetStorage.dir),
          5,
        );
      } catch (error) {
        log.debug(`deep-sleep governance: entity synthesis refresh failed after apply: ${error}`);
      }
    }
    return summarizeGovernanceResultForDreams(govResult, options?.dryRun === true);
  }

  // Issue #1526 (seam 5): semantic consolidation moved to
  // SemanticConsolidationCoordinator. Thin delegation keeps all
  // call sites (runConsolidation, runSemanticConsolidationNow,
  // runSemanticConsolidationFanout) stable.
  private async runSemanticConsolidation(options?: {
    dryRun?: boolean;
    thresholdOverride?: number;
    force?: boolean;
    storage?: StorageManager;
  }): Promise<SemanticConsolidationResult> {
    return this.semanticConsolidationCoordinator.runSemanticConsolidation(options);
  }

  async waitForExtractionIdle(timeoutMs: number = 60_000): Promise<boolean> {
    // Issue #1526: queue state + idle wait moved to ExtractionQueueCoordinator.
    return this.extractionQueueCoordinator.waitForIdle(timeoutMs);
  }

  async waitForConsolidationIdle(timeoutMs: number = 60_000): Promise<boolean> {
    const started = Date.now();
    while (this.maintenanceScheduler.isConsolidationInFlight()) {
      if (Date.now() - started > timeoutMs) {
        log.warn(`waitForConsolidationIdle timed out after ${timeoutMs}ms`);
        return false;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return true;
  }

  async getStorage(namespace?: string): Promise<StorageManager> {
    const ns =
      namespace && namespace.length > 0
        ? namespace
        : this.config.defaultNamespace;
    return this.storageRouter.storageFor(ns);
  }

  async processEntitySynthesisQueue(
    namespace?: string,
    maxEntities: number = 5,
  ): Promise<number> {
    // Issue #1526: entity synthesis lifecycle moved to EntitySynthesisCoordinator.
    // Thin delegation keeps all call sites (consolidation pass, access-service)
    // and tests that exercise the public API working unchanged.
    return this.entitySynthesisCoordinator.processQueue(namespace, maxEntities);
  }

  async generateDaySummary(
    memories: string | MemoryFile[],
  ): Promise<DaySummaryResult | null> {
    if (this.initPromise) {
      let initGateTimeoutHandle: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          this.initPromise.catch(() => undefined),
          new Promise((resolve) => {
            initGateTimeoutHandle = setTimeout(
              resolve,
              this.config.initGateTimeoutMs,
            );
          }),
        ]);
      } finally {
        if (initGateTimeoutHandle) clearTimeout(initGateTimeoutHandle);
      }
    }
    return this.extraction.generateDaySummary(memories);
  }

  /**
   * Auto-gather today's facts and hourly summaries from storage, then generate a day summary.
   * Returns null if no facts are found for today.
   */
  async generateDaySummaryAuto(
    namespace?: string,
    options: DaySummaryGatherOptions = {},
  ): Promise<DaySummaryResult | null> {
    const gathered = await this.gatherTodayFacts(namespace, options);
    if (!gathered || !gathered.trim()) {
      log.warn("generateDaySummaryAuto: no facts found for today, skipping");
      return null;
    }
    return this.generateDaySummary(gathered);
  }

  async gatherTodayFacts(
    namespace?: string,
    options: DaySummaryGatherOptions = {},
  ): Promise<string> {
    return this.workspaceOpsCoordinator.gatherTodayFacts(
      namespace,
      options,
    );
  }

  previewMemoryActionEvent(
    event: Omit<MemoryActionEvent, "timestamp"> & { timestamp?: string },
  ): MemoryActionEvent {
    return this.workspaceOpsCoordinator.previewMemoryActionEvent(
      event,
    );
  }

  async appendMemoryActionEvent(
    event: Omit<MemoryActionEvent, "timestamp"> & { timestamp?: string },
  ): Promise<boolean> {
    try {
      const toWrite = this.previewMemoryActionEvent(event);
      const storage = await this.getStorage(toWrite.namespace);
      await storage.appendMemoryActionEvents([toWrite]);
      return true;
    } catch (err) {
      log.warn(`appendMemoryActionEvent failed (non-fatal): ${err}`);
      return false;
    }
  }

  async getLastGraphRecallSnapshot(
    namespace?: string,
  ): Promise<GraphRecallSnapshot | null> {
    return this.recallIntrospectionCoordinator.getLastGraphRecallSnapshot(
      namespace,
    );
  }

  async getLastIntentSnapshot(
    namespace?: string,
  ): Promise<IntentDebugSnapshot | null> {
    return this.recallIntrospectionCoordinator.getLastIntentSnapshot(
      namespace,
    );
  }

  async getLastQmdRecallSnapshot(
    namespace?: string,
  ): Promise<QmdRecallSnapshot | null> {
    return this.recallIntrospectionCoordinator.getLastQmdRecallSnapshot(
      namespace,
    );
  }

  async explainLastGraphRecall(options?: {
    namespace?: string;
    maxExpanded?: number;
  }): Promise<string> {
    return this.recallIntrospectionCoordinator.explainLastGraphRecall(
      options,
    );
  }

  async explainLastIntent(options?: { namespace?: string }): Promise<string> {
    return this.recallIntrospectionCoordinator.explainLastIntent(
      options,
    );
  }

  async explainLastQmdRecall(options?: {
    namespace?: string;
    maxResults?: number;
  }): Promise<string> {
    return this.recallIntrospectionCoordinator.explainLastQmdRecall(
      options,
    );
  }

  private async searchConversationRecallResults(
    retrievalQuery: string,
    topK: number,
  ): Promise<Array<{ path: string; snippet: string; score: number }>> {
    return this.conversationIndexCoordinator.search(retrievalQuery, topK);
  }

  private formatConversationRecallSection(
    results: Array<{ path: string; snippet: string; score: number }>,
    maxChars: number,
  ): string | null {
    return this.conversationIndexCoordinator.formatRecallSection(
      results,
      maxChars,
    );
  }

  // Issue #1526: countConversationChunkDocs / buildConversationIndexChunks moved
  // to ConversationIndexCoordinator (internal helpers, no orchestrator callers).

  async getConversationIndexHealth(): Promise<{
    enabled: boolean;
    backend: "qmd" | "faiss";
    status: "ok" | "degraded" | "disabled";
    chunkDocCount: number;
    lastUpdateAt: string | null;
    qmdAvailable?: boolean;
    faiss?: {
      ok: boolean;
      status: "ok" | "degraded" | "error";
      indexPath: string;
      message?: string;
      manifest?: {
        version: number;
        modelId: string;
        normalizedModelId: string;
        dimension: number;
        chunkCount: number;
        updatedAt: string;
        lastSuccessfulRebuildAt: string;
      };
    };
  }> {
    return this.conversationIndexCoordinator.getHealth();
  }

  async inspectConversationIndex(): Promise<
    ConversationIndexBackendInspection & {
      enabled: boolean;
      chunkDocCount: number;
      lastUpdateAt: string | null;
    }
  > {
    return this.conversationIndexCoordinator.inspect();
  }

  async getRecoverySummary(sessionKey?: string): Promise<{
    generatedAt: string;
    sessionKey?: string;
    healthy: boolean;
    issueCount: number;
    incompleteTurns: number;
    brokenChains: number;
    checkpointHealthy: boolean;
  }> {
    return this.transcript.getRecoverySummary(sessionKey);
  }

  async updateConversationIndex(
    sessionKey: string,
    hours: number = 24,
    opts?: { embed?: boolean; enforceMinInterval?: boolean },
  ): Promise<{
    chunks: number;
    skipped: boolean;
    reason?: string;
    retryAfterMs?: number;
    embedded?: boolean;
  }> {
    return this.conversationIndexCoordinator.update(sessionKey, hours, opts);
  }

  async rebuildConversationIndex(
    sessionKey?: string,
    hours: number = 24,
    opts?: { embed?: boolean },
  ): Promise<{
    chunks: number;
    skipped: boolean;
    reason?: string;
    embedded?: boolean;
    rebuilt?: boolean;
  }> {
    return this.conversationIndexCoordinator.rebuild(sessionKey, hours, opts);
  }

  private async validateLocalLlmModel(): Promise<void> {
    return this.workspaceOpsCoordinator.validateLocalLlmModel(
    );
  }

  async recall(
    prompt: string,
    sessionKey?: string,
    options: RecallInvocationOptions = {},
  ): Promise<string> {
    // Resolve the recall-operation capability gates ONCE, at the operation
    // entry, and thread the frozen set down (issue #1523). Never re-read the
    // migrated flags off `this.config` mid-operation.
    const caps = resolveCapabilities(this.config);
    const graphCaps = resolveGraphConstructionCapabilities(this.config); // #1566 Cluster A
    const abortController = new AbortController();
    const onAbort = () => {
      abortController.abort();
    };
    if (options.abortSignal?.aborted) {
      abortController.abort();
    } else {
      options.abortSignal?.addEventListener("abort", onAbort, { once: true });
    }

    const principal =
      typeof options.principalOverride === "string" &&
      options.principalOverride.length > 0
        ? options.principalOverride
        : resolvePrincipal(sessionKey, this.config);
    const namespacesEnabled = resolveNamespaceCapabilities(this.config).namespaces;
    if (namespacesEnabled && !principal) {
      throw new Error("authentication required: namespaces are enabled and no principal was supplied");
    }

    // Wait for initialization to complete before attempting recall. The timeout
    // is configurable so OpenClaw's per-hook budget and Remnic's internal init
    // gate can stay aligned during cold starts.
    let initGateTimeoutHandle: NodeJS.Timeout | null = null;
    let onInitGateAbort: (() => void) | null = null;
    if (this.initPromise) {
      const gateResult = await Promise.race([
        this.initPromise.then(() => "ok" as const),
        new Promise<"timeout">((resolve) => {
          initGateTimeoutHandle = setTimeout(
            () => resolve("timeout"),
            this.config.initGateTimeoutMs,
          );
        }),
        abortController.signal.aborted
          ? Promise.resolve("aborted" as const)
          : new Promise<"aborted">((resolve) => {
              onInitGateAbort = () => resolve("aborted");
              abortController.signal.addEventListener(
                "abort",
                onInitGateAbort,
                { once: true },
              );
            }),
      ]);
      if (initGateTimeoutHandle) clearTimeout(initGateTimeoutHandle);
      if (onInitGateAbort)
        abortController.signal.removeEventListener("abort", onInitGateAbort);
      if (gateResult === "aborted") {
        this.logRecallFailure(abortRecallError("recall aborted before init"));
        return "";
      }
      if (gateResult === "timeout") {
        log.warn("recall: init gate timed out — proceeding without full init");
      }
    }

    // Secure-store lock gate (issue #690 PR 3/4).
    // If secure-store is enabled but the keyring holds no key for this
    // memory directory, reject recall with a clear human-readable error
    // rather than surfacing a cryptic SecureStoreLockedError from deep
    // inside the storage layer.
    if (resolveRecallAuxiliaryCapabilities(this.config).secureStore && !this.storage.isSecureStoreUnlocked()) {
      const lockedMsg =
        "[secure-store locked] Memory store is encrypted and locked. " +
        "Unlock the secure-store inside this daemon process, or restart the daemon through a secure-store aware launcher that installs the key.";
      log.warn("recall blocked: secure-store is locked");
      return lockedMsg;
    }

    // Keep outer recall timeout above worst-case serialized hybrid search:
    // QMD subprocess BM25 (30s) + vector (30s) can consume ~60s under contention.
    try {
      const recallPromise = this.recallInternal(prompt, sessionKey, {
        ...options,
        abortSignal: abortController.signal,
      }, caps, graphCaps);
      const RECALL_TIMEOUT_MS = this.config.recallOuterTimeoutMs ?? 75_000;
      if (RECALL_TIMEOUT_MS <= 0) {
        return await recallPromise;
      }

      let timeoutHandle: NodeJS.Timeout | null = null;
      const timeoutPromise = new Promise<string>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          abortController.abort();
          reject(new Error("recall timeout"));
        }, RECALL_TIMEOUT_MS);
      });

      let recallResult: string;
      try {
        recallResult = await Promise.race([recallPromise, timeoutPromise]);
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
      }

      // Observation-mode direct-answer tier (issue #518 slice 3c).
      // Runs after the user's recall already succeeded, fire-and-forget,
      // so annotation latency can never delay the caller's response.
      if (caps.recallDirectAnswer && sessionKey) {
        try {
          this.enqueueDirectAnswerObservation(
            prompt,
            sessionKey,
            options.namespace?.trim() || undefined,
            options.principalOverride,
            caps,
            namespacesEnabled,
          );
        } catch (err) {
          log.debug(`direct-answer observation setup failed: ${err}`);
        }
      }

      return recallResult;
    } catch (err) {
      this.logRecallFailure(err);
      // endTrace() is safe here: if no trace is active (disabled or already
      // closed by recallInternal's try/finally), it returns null immediately.
      this.profiler.endTrace();
      return ""; // Return empty context on timeout/error
    } finally {
      options.abortSignal?.removeEventListener("abort", onAbort);
    }
  }

  /**
   * Return the most recent X-ray snapshot captured during a
   * `recall()` call that passed `xrayCapture: true` (issue #570 PR 1).
   * Returns `null` when no such capture has occurred on this
   * orchestrator instance.  Returned snapshot is a deep copy so
   * caller mutation cannot tear the stored value.
   */
  getLastXraySnapshot(): RecallXraySnapshot | null {
    if (!this.lastXraySnapshot) return null;
    return structuredClone(this.lastXraySnapshot);
  }

  /** Clear the captured X-ray snapshot.  Exposed for tests / explicit reset. */
  clearLastXraySnapshot(): void {
    this.lastXraySnapshot = null;
  }

  async waitForDirectAnswerObservationIdle(
    timeoutMs: number = 60_000,
  ): Promise<boolean> {
    return this.recallIntrospectionCoordinator.waitForDirectAnswerObservationIdle(
      timeoutMs,
    );
  }

  private enqueueDirectAnswerObservation(
    prompt: string,
    sessionKey: string,
    namespaceOverride: string | undefined,
    principalOverride: string | undefined,
    caps: CapabilitySet,
    namespacesEnabled: boolean,
  ): void {
    return this.recallIntrospectionCoordinator.enqueueDirectAnswerObservation(
      prompt,
      sessionKey,
      namespaceOverride,
      principalOverride,
      caps,
      namespacesEnabled,
    );
  }

  private async annotateDirectAnswerTier(
    prompt: string,
    sessionKey: string,
    namespaces: string[],
    expectedIdentity:
      | { writeNonce?: string; traceId?: string; recordedAt?: string }
      | undefined,
    caps: CapabilitySet,
    _parentAbortSignal?: AbortSignal,
  ): Promise<void> {
    return this.recallIntrospectionCoordinator.annotateDirectAnswerTier(
      prompt,
      sessionKey,
      namespaces,
      expectedIdentity,
      caps,
      _parentAbortSignal,
    );
  }

  private logRecallFailure(err: unknown): void {
    const now = Date.now();
    const errorMsg = err instanceof Error ? err.message : String(err);
    const LOG_WINDOW_MS = 60_000;
    const idleSinceLastFailureMs = now - this.lastRecallFailureAtMs;
    this.lastRecallFailureAtMs = now;
    if (idleSinceLastFailureMs >= LOG_WINDOW_MS) {
      this.suppressedRecallFailures = 0;
    }

    if (now - this.lastRecallFailureLogAtMs >= LOG_WINDOW_MS) {
      const suffix =
        this.suppressedRecallFailures > 0
          ? ` (suppressed ${this.suppressedRecallFailures} similar failures in last minute)`
          : "";
      log.warn(`recall timed out or failed: ${errorMsg}${suffix}`);
      this.lastRecallFailureLogAtMs = now;
      this.suppressedRecallFailures = 0;
      return;
    }

    this.suppressedRecallFailures += 1;
    log.debug(`recall timed out or failed (suppressed): ${errorMsg}`);
  }

  private artifactTypeForCategory(
    category: string,
  ):
    | "decision"
    | "constraint"
    | "todo"
    | "definition"
    | "commitment"
    | "correction"
    | "fact" {
    if (category === "decision") return "decision";
    if (category === "commitment") return "commitment";
    if (category === "correction") return "correction";
    if (category === "principle") return "constraint";
    return "fact";
  }

  private truncateArtifactForRecall(text: string, maxChars = 280): string {
    if (text.length <= maxChars) return text;
    return `${text.slice(0, maxChars - 1)}…`;
  }

  private async fetchActiveArtifactsForNamespace(
    namespace: string,
    prompt: string,
    targetCount: number,
  ): Promise<MemoryFile[]> {
    return this.recallSearchPipelineCoordinator.fetchActiveArtifactsForNamespace(
      namespace,
      prompt,
      targetCount,
    );
  }

  private async recallArtifactsAcrossNamespaces(
    prompt: string,
    recallNamespaces: string[],
    targetCount: number,
  ): Promise<MemoryFile[]> {
    return this.namespaceReadFanoutCoordinator.recallArtifactsAcrossNamespaces(
      prompt,
      recallNamespaces,
      targetCount,
    );
  }

  private scopeQueryAwarePaths(
    paths: Set<string> | null,
    recallNamespaces: string[],
  ): Set<string> | null {
    if (!paths) return null;
    const scoped = new Set<string>();
    for (const memoryPath of paths) {
      if (!memoryPath || isArtifactMemoryPath(memoryPath)) continue;
      if (
        resolveNamespaceCapabilities(this.config).namespaces &&
        !recallNamespaces.includes(this.namespaceFromPath(memoryPath))
      ) {
        continue;
      }
      scoped.add(memoryPath);
    }
    return scoped;
  }

  private async buildQueryAwarePrefilter(
    prompt: string,
    recallNamespaces: string[],
  ): Promise<QueryAwarePrefilter> {
    return this.recallSearchPipelineCoordinator.buildQueryAwarePrefilter(
      prompt,
      recallNamespaces,
    );
  }

  private async searchScopedMemoryCandidates(
    candidatePaths: Set<string>,
    query: string,
    limit: number,
    options?: {
      allowArchived?: boolean;
    },
  ): Promise<QmdSearchResult[]> {
    return this.namespaceReadFanoutCoordinator.searchScopedMemoryCandidates(
      candidatePaths,
      query,
      limit,
      options,
    );
  }

  private async fetchQmdMemoryResultsWithArtifactTopUp(
    prompt: string,
    qmdFetchLimit: number,
    qmdHybridFetchLimit: number,
    options: {
      namespacesEnabled: boolean;
      recallNamespaces: string[];
      resolveNamespace: (path: string) => string;
      collection?: string;
      queryAwarePrefilter?: QueryAwarePrefilter;
      searchOptions?: SearchQueryOptions;
      onDebugSnapshot?: (snapshot: QmdRecallSnapshot) => Promise<void>;
      /** Backend degradation observer, threaded into every QMD call (#1536). */
      onDegradation?: (degradation: SearchDegradation) => void;
      abortSignal?: AbortSignal;
    },
  ): Promise<QmdSearchResult[]> {
    return this.recallSearchPipelineCoordinator.fetchQmdMemoryResultsWithArtifactTopUp(
      prompt,
      qmdFetchLimit,
      qmdHybridFetchLimit,
      options,
    );
  }

  // Issue #1526 (seam 14): graph-recall expansion moved to
  // GraphRecallCoordinator. Thin delegation keeps the private API stable
  // for callers (recallInternal, cold-fallback pipeline) + tests.
  private async expandResultsViaGraph(options: {
    memoryResults: QmdSearchResult[];
    recallNamespaces: string[];
    recallResultLimit: number;
    deadlineAtMs?: number | null;
    includeLowConfidence?: boolean;
  }): Promise<{
    merged: QmdSearchResult[];
    seedPaths: string[];
    expandedPaths: GraphRecallExpandedEntry[];
    seedResults: QmdSearchResult[];
  }> {
    return this.graphRecallCoordinator.expandResultsViaGraph(options);
  }
  private async recordLastGraphRecallSnapshot(options: {
    storage: StorageManager;
    prompt: string;
    recallMode: RecallPlanMode;
    recallNamespaces: string[];
    seedPaths: string[];
    expandedPaths: GraphRecallExpandedEntry[];
    status: "completed" | "skipped" | "aborted";
    reason?: string;
    shadowMode?: boolean;
    queryIntent: MemoryIntent;
    seedResults?: GraphRecallRankedResult[];
    finalResults?: GraphRecallRankedResult[];
    shadowComparison?: GraphRecallShadowComparison;
  }): Promise<void> {
    return this.recallIntrospectionCoordinator.recordLastGraphRecallSnapshot(
      options,
    );
  }
  private async recordLastIntentSnapshot(options: {
    storage: StorageManager;
    snapshot: IntentDebugSnapshot;
  }): Promise<void> {
    return this.recallIntrospectionCoordinator.recordLastIntentSnapshot(
      options,
    );
  }

  private async recordLastQmdRecallSnapshot(options: {
    storage: StorageManager;
    snapshot: QmdRecallSnapshot;
  }): Promise<void> {
    return this.recallIntrospectionCoordinator.recordLastQmdRecallSnapshot(
      options,
    );
  }

  private async recordLastIntentSnapshotForNamespace(options: {
    namespace: string;
    snapshot: IntentDebugSnapshot;
  }): Promise<void> {
    return this.recallIntrospectionCoordinator.recordLastIntentSnapshotForNamespace(
      options,
    );
  }

  private async resolveStateDirForNamespace(
    namespace: string,
  ): Promise<string> {
    return this.namespaceReadFanoutCoordinator.resolveStateDirForNamespace(
      namespace,
    );
  }

  private buildGraphRecallRankedResults(
    results: QmdSearchResult[],
    sourceLabelResolver: (path: string) => string[],
    limit: number = 64,
  ): GraphRecallRankedResult[] {
    return results.slice(0, limit).map((result) => ({
      path: result.path,
      score: result.score,
      docid: result.docid,
      sourceLabels: sourceLabelResolver(result.path),
    }));
  }

  // Issue #1526 (seam 13): recall section budgeting/assembly moved to
  // RecallSectionCoordinator. Thin delegation keeps the orchestrator's
  // recallInternal call sites stable.
  private getRecallSectionEntry(
    sectionId: string,
  ): RecallSectionConfig | undefined {
    return this.recallSectionCoordinator.getRecallSectionEntry(sectionId);
  }

  private isRecallSectionEnabled(
    sectionId: string,
    defaultEnabled: boolean = true,
  ): boolean {
    return this.recallSectionCoordinator.isRecallSectionEnabled(
      sectionId,
      defaultEnabled,
    );
  }

  private isSpecializedRecallSectionEnabled(
    sectionId: string,
    topLevelEnabled: boolean,
  ): boolean {
    return this.recallSectionCoordinator.isSpecializedRecallSectionEnabled(
      sectionId,
      topLevelEnabled,
    );
  }

  private getRecallSectionMaxChars(
    sectionId: string,
  ): number | null | undefined {
    return this.recallSectionCoordinator.getRecallSectionMaxChars(sectionId);
  }

  private getRecallSectionNumber(
    sectionId: string,
    key: keyof RecallSectionConfig,
  ): number | undefined {
    return this.recallSectionCoordinator.getRecallSectionNumber(sectionId, key);
  }

  private appendRecallSection(
    sectionBuckets: Map<string, string[]>,
    sectionId: string,
    content: string,
  ): boolean {
    return this.recallSectionCoordinator.appendRecallSection(
      sectionBuckets,
      sectionId,
      content,
    );
  }

  private truncateRecallSectionToBudget(
    content: string,
    maxChars: number,
  ): string {
    return this.recallSectionCoordinator.truncateRecallSectionToBudget(
      content,
      maxChars,
    );
  }

  private getRecallBudgetChars(override?: number): number {
    return this.recallSectionCoordinator.getRecallBudgetChars(override);
  }

  private assembleRecallSections(
    sectionBuckets: Map<string, string[]>,
    budgetOverride?: number,
  ): {
    sections: string[];
    includedIds: string[];
    omittedIds: string[];
    truncated: boolean;
    finalChars: number;
  } {
    return this.recallSectionCoordinator.assembleRecallSections(
      sectionBuckets,
      budgetOverride,
    );
  }


  /**
   * Clock source for the shared post-retrieval assembly/enrichment budget. The
   * deadline is set from this value and every expiry check reads it back, so a
   * test can drive the budget deterministically instead of racing the few-ms
   * wall-clock window that made the "skips … after budget expires" tests flaky.
   * Production behavior is unchanged — it returns the wall clock.
   */
  protected recallAssemblyClockMs(): number {
    return Date.now();
  }

  /**
   * Recall-internal coordinator (issue #1526 seam 18). Owns the full
   * `recallInternal` assembly pipeline. Lazy: created on first access so
   * Object.create(prototype) tests that set fields post-construction work,
   * and so subclass/test overrides of orchestrator members (e.g. the
   * `recallAssemblyClockMs` clock seam) are observed live via accessors.
   */
  private _recallInternalCoordinator: RecallInternalCoordinator | undefined;

  private get recallInternalCoordinator(): RecallInternalCoordinator {
    if (!this._recallInternalCoordinator) {
      this._recallInternalCoordinator = new RecallInternalCoordinator(
        selfDeps<ConstructorParameters<typeof RecallInternalCoordinator>[0]>(this),
      );
    }
    return this._recallInternalCoordinator;
  }

  /**
   * Recall search-pipeline coordinator (issue #1526 seam 19). Owns QMD
   * search post-processing (prefilter, fallbacks, safety filter, boost).
   * Lazy + accessor-wired for the same reasons as seam 18: instance-level
   * test overrides of orchestrator members must stay live.
   */
  private _recallSearchPipelineCoordinator: RecallSearchPipelineCoordinator | undefined;

  private get recallSearchPipelineCoordinator(): RecallSearchPipelineCoordinator {
    if (!this._recallSearchPipelineCoordinator) {
      this._recallSearchPipelineCoordinator = new RecallSearchPipelineCoordinator(
        selfDeps<ConstructorParameters<typeof RecallSearchPipelineCoordinator>[0]>(this),
      );
    }
    return this._recallSearchPipelineCoordinator;
  }

  /**
   * Turn-ingestion coordinator (issue #1526 seam 20). Owns the buffer-side
   * extraction entry points. Lazy + accessor-wired so prototype-call tests
   * and instance-level stubs stay live (same rule as seams 18/19).
   */
  private _turnIngestionCoordinator: TurnIngestionCoordinator | undefined;

  private get turnIngestionCoordinator(): TurnIngestionCoordinator {
    if (!this._turnIngestionCoordinator) {
      this._turnIngestionCoordinator = new TurnIngestionCoordinator(
        selfDeps<ConstructorParameters<typeof TurnIngestionCoordinator>[0]>(this),
      );
    }
    return this._turnIngestionCoordinator;
  }

  /**
   * Recall-introspection coordinator (issue #1526 seam 21). Owns the
   * last-recall snapshot/explain surfaces and direct-answer annotation.
   * Lazy + accessor-wired (late-binding rule, seams 18–20).
   */
  private _recallIntrospectionCoordinator: RecallIntrospectionCoordinator | undefined;

  private get recallIntrospectionCoordinator(): RecallIntrospectionCoordinator {
    if (!this._recallIntrospectionCoordinator) {
      this._recallIntrospectionCoordinator = new RecallIntrospectionCoordinator(
        selfDeps<ConstructorParameters<typeof RecallIntrospectionCoordinator>[0]>(this),
      );
    }
    return this._recallIntrospectionCoordinator;
  }

  /**
   * Orchestrator-init coordinator (issue #1526 seam 22). Owns
   * initialize/deferredInitialize/startupSearchSync. Lazy + accessor-wired
   * (late-binding rule, seams 18–21); the init gate fields stay on the
   * orchestrator and are mutated through set accessors.
   */
  private _orchestratorInitCoordinator: OrchestratorInitCoordinator | undefined;

  private get orchestratorInitCoordinator(): OrchestratorInitCoordinator {
    if (!this._orchestratorInitCoordinator) {
      this._orchestratorInitCoordinator = new OrchestratorInitCoordinator(
        selfDeps<ConstructorParameters<typeof OrchestratorInitCoordinator>[0]>(this),
      );
    }
    return this._orchestratorInitCoordinator;
  }

  /**
   * Persistence-index coordinator (issue #1526 seam 23). Owns post-persist
   * bookkeeping (content-hash dedup, temporal indexes, graph edges,
   * semantic dedup lookup). Lazy + accessor-wired (late-binding rule).
   */
  private _persistenceIndexCoordinator: PersistenceIndexCoordinator | undefined;

  private get persistenceIndexCoordinator(): PersistenceIndexCoordinator {
    if (!this._persistenceIndexCoordinator) {
      this._persistenceIndexCoordinator = new PersistenceIndexCoordinator(
        selfDeps<ConstructorParameters<typeof PersistenceIndexCoordinator>[0]>(this),
      );
    }
    return this._persistenceIndexCoordinator;
  }

  /**
   * Workspace-ops coordinator (issue #1526 seam 24). Owns periodic
   * workspace/operations surfaces. Lazy + accessor-wired (late-binding
   * rule, seams 18–23).
   */
  private _workspaceOpsCoordinator: WorkspaceOpsCoordinator | undefined;

  private get workspaceOpsCoordinator(): WorkspaceOpsCoordinator {
    if (!this._workspaceOpsCoordinator) {
      this._workspaceOpsCoordinator = new WorkspaceOpsCoordinator(
        selfDeps<ConstructorParameters<typeof WorkspaceOpsCoordinator>[0]>(this),
      );
    }
    return this._workspaceOpsCoordinator;
  }

  /**
   * Namespace read-fanout coordinator (issue #1526 seam 26). Owns
   * namespace-scoped read fanout (hints, cross-namespace search/reads,
   * artifact statuses). Lazy + accessor-wired (late-binding rule).
   */
  private _namespaceReadFanoutCoordinator: NamespaceReadFanoutCoordinator | undefined;

  private get namespaceReadFanoutCoordinator(): NamespaceReadFanoutCoordinator {
    if (!this._namespaceReadFanoutCoordinator) {
      this._namespaceReadFanoutCoordinator = new NamespaceReadFanoutCoordinator(
        selfDeps<ConstructorParameters<typeof NamespaceReadFanoutCoordinator>[0]>(this),
      );
    }
    return this._namespaceReadFanoutCoordinator;
  }

  private async recallInternal(
    prompt: string,
    sessionKey?: string,
    options: RecallInvocationOptions = {},
    caps: CapabilitySet = resolveCapabilities(this.config),
    graphCaps: GraphConstructionCapabilitySet = resolveGraphConstructionCapabilities(this.config),
    lifecycleCaps: MemoryLifecycleCapabilitySet = resolveMemoryLifecycleCapabilities(this.config),
  ): Promise<string> {
    return this.recallInternalCoordinator.recallInternal(
      prompt,
      sessionKey,
      options,
      caps,
      graphCaps,
      lifecycleCaps,
    );
  }

  async processTurn(
    role: "user" | "assistant",
    content: string,
    sessionKey?: string,
    options: {
      bufferKey?: string;
      logicalSessionKey?: string;
      providerThreadId?: string | null;
      turnFingerprint?: string;
      persistProcessedFingerprint?: boolean;
    } = {},
  ): Promise<void> {
    return this.turnIngestionCoordinator.processTurn(
      role,
      content,
      sessionKey,
      options,
    );
  }

  async flushSession(
    sessionKey: string,
    options: {
      reason: string;
      abortSignal?: AbortSignal;
      bufferKey?: string;
    },
  ): Promise<void> {
    const explicitBufferKey =
      typeof options.bufferKey === "string" && options.bufferKey.length > 0
        ? options.bufferKey
        : null;
    const discoveredBufferKeys =
      explicitBufferKey ||
      typeof sessionKey !== "string" ||
      sessionKey.length === 0 ||
      typeof this.buffer.findBufferKeysForSession !== "function"
        ? []
        : await this.buffer.findBufferKeysForSession(sessionKey);
    const bufferKeys = explicitBufferKey
      ? [explicitBufferKey]
      : discoveredBufferKeys.length > 0
        ? discoveredBufferKeys
        : typeof sessionKey === "string" && sessionKey.length > 0
          ? [sessionKey]
          : ["default"];
    for (const bufferKey of bufferKeys) {
      const turns = this.buffer.getTurns(bufferKey);
      if (turns.length === 0) continue;
      await new Promise<void>((resolve, reject) => {
        void this
          .queueBufferedExtraction(turns, "trigger_mode", {
            bufferKey,
            clearBufferAfterExtraction: true,
            skipDedupeCheck: true,
            abortSignal: options.abortSignal,
            onTaskSettled: (error) => (error ? reject(error) : resolve()),
          })
          .catch(reject);
      });
    }
  }

  async ingestReplayBatch(
    turns: ReplayTurn[],
    options: {
      deadlineMs?: number;
      archiveLcm?: boolean;
      abortSignal?: AbortSignal;
      /**
       * Pin extraction writes to this namespace instead of deriving one from
       * `defaultNamespaceForPrincipal(resolvePrincipal(sessionKey))` + the
       * coding overlay (#1495). The access `observe` surface resolves a single
       * effective scope plan and passes its `writeNamespace` here so the
       * extracted memories land in the SAME namespace as LCM archival,
       * objective-state snapshots, and project-scoped recall — without relying
       * on re-deriving the namespace from a namespace-prefixed session key.
       * Same hook bulk-import uses (#460).
       */
      writeNamespaceOverride?: string;
      /**
       * Pin the provenance PRINCIPAL instead of deriving it from
       * `resolvePrincipal(turn.sessionKey)` (#1495 thread 1). The access
       * `observe` surface authenticates the caller at the transport layer and
       * passes its resolved principal here so extracted-memory provenance uses
       * the SAME identity the surface authorized — independent of storage
       * routing (`writeNamespaceOverride`) and of whatever `resolvePrincipal`
       * would parse from the raw session key. Mirrors the recall path's
       * `principalOverride` (issue #570 PR 4).
       */
      principalOverride?: string;
    } = {},
  ): Promise<void> {
    return this.turnIngestionCoordinator.ingestReplayBatch(
      turns,
      options,
    );
  }

  /**
   * Return the namespace that `ingestBulkImportBatch` writes into (#460).
   *
   * Exposed so host CLIs can snapshot the same storage root that extraction
   * actually writes to, avoiding the "CLI counts files at namespace A while
   * writes land in namespace B" footgun that a naïve
   * `config.defaultNamespace` snapshot could hit when a namespace policy
   * named `"default"` also exists.
   *
   * Today bulk-import is pinned to `config.defaultNamespace`; future
   * per-invocation namespace routing would thread an explicit target here
   * and through `ingestBulkImportBatch`.
   */
  bulkImportWriteNamespace(): string {
    return this.config.defaultNamespace;
  }

  getWearablesService(): WearablesService {
    return this.workspaceOpsCoordinator.getWearablesService(
    );
  }

  async ingestBulkImportBatch(
    turns: ImportTurn[],
    options: {
      deadlineMs?: number;
      failOnExtractionFailure?: boolean;
      includeSourceValidAtContext?: boolean;
    } = {},
  ): Promise<BulkImportBatchIngestResult> {
    return this.turnIngestionCoordinator.ingestBulkImportBatch(
      turns,
      options,
    );
  }

  async observeSessionHeartbeat(
    sessionKey: string,
    options: { bufferKey?: string } = {},
  ): Promise<void> {
    return this.turnIngestionCoordinator.observeSessionHeartbeat(
      sessionKey,
      options,
    );
  }

  private async queueBufferedExtraction(
    turnsToExtract: BufferTurn[],
    reason: "trigger_mode" | "heartbeat_observer",
    options: {
      skipDedupeCheck?: boolean;
      clearBufferAfterExtraction?: boolean;
      skipCharThreshold?: boolean;
      skipUserTurnThreshold?: boolean;
      extractionDeadlineMs?: number;
      failOnExtractionFailure?: boolean;
      onTaskSettled?: (
        error?: unknown,
        result?: ExtractionRunResult,
      ) => void;
      bufferKey?: string;
      abortSignal?: AbortSignal;
      /**
       * Explicit namespace override for the write path (#460).  When set,
       * `runExtraction` writes to this namespace instead of deriving one
       * from `defaultNamespaceForPrincipal(resolvePrincipal(sessionKey))`.
       * Used by bulk-import to pin writes to a deterministic namespace
       * regardless of user-configured principal routing rules.
       */
      writeNamespaceOverride?: string;
      /**
       * Pin the provenance principal (#1495 thread 1). Forwarded to
       * `runExtraction` so access `observe` can record provenance under the
       * authenticated principal instead of `resolvePrincipal(sessionKey)`.
       */
      principalOverride?: string;
    } = {},
  ): Promise<void> {
    return this.turnIngestionCoordinator.queueBufferedExtraction(
      turnsToExtract,
      reason,
      options,
    );
  }

  private normalizeExtractionFingerprintTurns(turns: BufferTurn[]): string[] {
    return this.extractionRunCoordinator.normalizeExtractionFingerprintTurns(turns);
  }

  private buildExtractionFingerprint(turns: BufferTurn[], bufferKey: string): string | null {
    return this.extractionRunCoordinator.buildExtractionFingerprint(turns, bufferKey);
  }

  private shouldQueueExtraction(
    turns: BufferTurn[],
    options: { commit?: boolean; bufferKey?: string } = {},
  ): boolean {
    return this.extractionRunCoordinator.shouldQueueExtraction(turns, options);
  }

  private async maybeCapturePassiveCorrections(
    turns: readonly BufferTurn[],
    opts: {
      sessionKey: string;
      principal?: string;
      namespace: string;
      bufferKey: string;
      isLiveSession: boolean;
    },
  ): Promise<void> {
    return this.turnIngestionCoordinator.maybeCapturePassiveCorrections(
      turns,
      opts,
    );
  }

  /** Lazily construct the CorrectionService for passive capture. Stateless
   *  across requests (per #1580 design); cached for the orchestrator's life. */
  private passiveCorrectionService(): CorrectionService {
    if (this._passiveCorrectionService) return this._passiveCorrectionService;
    this._passiveCorrectionService = createCorrectionService({
      orchestrator: this,
      // Session-scoped write ACL (review: "passive capture bypasses write
      // ACL"). A correction detected in session S plans only against S readable
      // namespaces and applies only to writable ones (rule 42) — passive
      // capture never becomes a cross-tenant mutation vector. Mirrors the
      // access-service createCorrectionService wiring rather than bypassing it.
      resolveAuthorizedNamespace: async (req) => {
        const principal = req.principal || resolvePrincipal(req.sessionKey, this.config);
        const ns = req.namespace ?? defaultNamespaceForPrincipal(principal, this.config);
        if (!canWriteNamespace(principal, ns, this.config)) {
          throw new Error(
            `passive correction: namespace "${ns}" is not writable for principal ${principal ?? "(none)"}`,
          );
        }
        return ns;
      },
      resolveReadableNamespaces: (req) => {
        const principal = req.principal || resolvePrincipal(req.sessionKey, this.config);
        return recallNamespacesForPrincipal(principal, this.config);
      },
      canWriteNamespace: async (req) => {
        const principal = req.principal || resolvePrincipal(req.sessionKey, this.config);
        return canWriteNamespace(principal, req.namespace, this.config);
      },
      llmComplete: async ({ system, user }) => {
        const llmResult = await this.localLlm.chatCompletion(
          [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          { operation: "correction-classify", priority: "background" },
        );
        if (!llmResult) {
          throw new Error(
            "passive correction classify+draft: local LLM unavailable (disabled or in cooldown)",
          );
        }
        return llmResult.content;
      },
    });
    return this._passiveCorrectionService;
  }

  async runExtraction(
    ...args: Parameters<ExtractionRunCoordinator["runExtraction"]>
  ): Promise<ExtractionRunResult> {
    return this.extractionRunCoordinator.runExtraction(...args);
  }

  private async recordProcessedExtractionFingerprint(
    storage: StorageManager,
    fingerprint: string,
    preloadedMeta?: Awaited<ReturnType<StorageManager["loadMeta"]>>,
  ): Promise<void> {
    return this.extractionRunCoordinator.recordProcessedExtractionFingerprint(
      storage, fingerprint, preloadedMeta,
    );
  }

  private async runTierMigrationCycle(
    storage: StorageManager,
    trigger: "extraction" | "maintenance" | "manual",
    options?: {
      dryRun?: boolean;
      limitOverride?: number;
      force?: boolean;
    },
  ): Promise<TierMigrationCycleSummary> {
    return this.tierMigrationCoordinator.runCycle(storage, trigger, options);
  }

  async getTierMigrationStatus(): Promise<TierMigrationStatusSnapshot> {
    return this.tierMigrationStatus.get();
  }

  async runTierMigrationNow(options?: {
    dryRun?: boolean;
    limit?: number;
  }): Promise<TierMigrationCycleSummary> {
    return this.runTierMigrationCycle(this.storage, "manual", {
      dryRun: options?.dryRun === true,
      limitOverride: options?.limit,
      force: false,
    });
  }

  private maybeScheduleConsolidation(nonZeroExtraction: boolean): void {
    this.maintenanceScheduler.maybeScheduleConsolidation(
      nonZeroExtraction,
      () => this.runConsolidation(),
    );
  }

  requestQmdMaintenance(): void {
    this.maintenanceScheduler.requestQmdMaintenanceForTool("__internal__");
  }

  /**
   * Public entrypoint for tool-driven QMD maintenance requests.
   * Delegates to the maintenance scheduler (issue #1526 PR1).
   */
  requestQmdMaintenanceForTool(reason: string): void {
    this.maintenanceScheduler.requestQmdMaintenanceForTool(reason);
  }

  private async persistExtraction(
    result: ExtractionResult,
    storage: StorageManager,
    threadIdForExtraction?: string | null,
    sourceContext?: { sessionKey?: string; principal?: string; validAt?: string },
    baseNamespace?: string,
    scopeProfileWritePlan?: ResolvedScopeProfilePlan | null,
    /** Verbatim source turn text the facts were extracted from (faithfulness gate #1576). */
    sourceText?: string,
    graphCaps: GraphConstructionCapabilitySet = resolveGraphConstructionCapabilities(this.config),
    lifecycleCaps: MemoryLifecycleCapabilitySet = resolveMemoryLifecycleCapabilities(this.config),
  ): Promise<string[]> {
    return this.extractionPersistCoordinator.persistExtraction(
      result,
      storage,
      threadIdForExtraction,
      sourceContext,
      baseNamespace,
      scopeProfileWritePlan,
      sourceText,
      graphCaps,
      lifecycleCaps,
    );
  }
  /**
   * Append persisted ids to the thread episode set, excluding pending_review
   * fact ids (#1635) so they don't re-seed predecessor edges. Fail-open like
   * the raw appendEpisodeIds call it replaces.
   */
  private async appendPersistedThreadEpisodes(
    threadId: string,
    persistedIds: string[],
  ): Promise<void> {
    const pendingReviewIds = this.lastPersistExtractionPendingReviewIds ?? [];
    const episodeIds =
      pendingReviewIds.length > 0
        ? persistedIds.filter((id) => !pendingReviewIds.includes(id))
        : persistedIds;
    if (episodeIds.length === 0) return;
    try {
      await this.threading.appendEpisodeIds(threadId, episodeIds);
    } catch (err) {
      log.warn(
        "[threading] appendEpisodeIds failed after persistence (non-fatal)",
        err,
      );
    }
  }

  private async indexPersistedMemory(
    storage: StorageManager,
    memoryId: string,
  ): Promise<void> {
    return this.persistenceIndexCoordinator.indexPersistedMemory(
      storage,
      memoryId,
    );
  }

  private async buildGraphEdge(
    storage: StorageManager,
    memoryRelPath: string,
    entityRef: string | undefined,
    memoryId: string,
    factContent: string,
    allMemsForGraph: import("./types.js").MemoryFile[] | null | undefined,
    memoryPathById: Map<string, string>,
    threadIdForEdge: string | undefined,
    threadEpisodeIdsForGraph: string[] | undefined,
    fallbackCausalPredecessor: string | undefined,
    graphCaps: GraphConstructionCapabilitySet = resolveGraphConstructionCapabilities(this.config),
  ): Promise<void> {
    return this.persistenceIndexCoordinator.buildGraphEdge(
      storage,
      memoryRelPath,
      entityRef,
      memoryId,
      factContent,
      allMemsForGraph,
      memoryPathById,
      threadIdForEdge,
      threadEpisodeIdsForGraph,
      fallbackCausalPredecessor,
      graphCaps,
    );
  }

  private graphIndexFor(storage: StorageManager): GraphIndex {
    const key = storage.dir;
    const existing = this.graphIndexes.get(key);
    if (existing) return existing;
    const created = new GraphIndex(key, this.config);
    this.graphIndexes.set(key, created);
    return created;
  }

  private async updateTemporalTagIndexes(
    storage: StorageManager,
    persistedIds: string[],
  ): Promise<void> {
    return this.persistenceIndexCoordinator.updateTemporalTagIndexes(
      storage,
      persistedIds,
    );
  }

  /** IDs of facts persisted in the last extraction */
  private lastPersistedIds: string[] = [];

  private async runConsolidation(): Promise<{
    memoriesProcessed: number;
    merged: number;
    invalidated: number;
  }> {
    return this.consolidationRunCoordinator.run();
  }

  async optimizeCompressionGuidelines(options?: {
    dryRun?: boolean;
    eventLimit?: number;
  }) {
    return this.compressionGuidelineCoordinator.optimizeCompressionGuidelines(options);
  }

  async activateCompressionGuidelineDraft(options?: {
    expectedContentHash?: string;
    expectedGuidelineVersion?: number;
  }) {
    return this.compressionGuidelineCoordinator.activateCompressionGuidelineDraft(options);
  }

  // Issue #1526 (seam 4): compression-guideline learning moved to
  // CompressionGuidelineCoordinator. Thin delegation keeps the
  private async buildCompressionGuidelineRecallSection(): Promise<string | null> {
    return this.compressionGuidelineCoordinator.buildCompressionGuidelineRecallSection();
  }


  async runLifecyclePolicyNow(storage: StorageManager = this.storage): Promise<{ memoriesAssessed: number }> {
    const lifecycleCorpus = await storage.readAllMemories();
    // Record the catalog write when the pass rewrote any frontmatter (codex NR-tS).
    if ((await this.runLifecyclePolicyPass(lifecycleCorpus, storage)) > 0) {
    }
    return { memoriesAssessed: lifecycleCorpus.length };
  }

  private async runLifecyclePolicyPass(
    allMemories: MemoryFile[],
    storage: StorageManager = this.storage,
  ): Promise<number> {
    return this.lifecyclePolicyCoordinator.runLifecyclePolicyPass(allMemories, storage);
  }
  /**
   * Threshold (bytes) at which IDENTITY.md reflections get auto-consolidated.
   * Read by WorkspaceOpsCoordinator (seam 24) via `Orchestrator.…`, hence
   * not `private`.
   */
  static readonly IDENTITY_CONSOLIDATE_THRESHOLD = 8_000;

  private async autoConsolidateIdentity(): Promise<void> {
    return this.workspaceOpsCoordinator.autoConsolidateIdentity(
    );
  }

  // Issue #1526: recall result formatting moved to RecallResultFormatter. Thin
  // delegation keeps the private API stable for callers + tests.
  private formatQmdResults(
    title: string,
    results: QmdSearchResult[],
    sessionKey?: string,
    trustByPath?: Map<string, TrustStageResultItem> | null,
  ): string {
    return this.recallResultFormatter.formatQmdResults(title, results, sessionKey, trustByPath);
  }

  private formatObjectiveStateResults(
    results: ObjectiveStateSearchResult[],
  ): string {
    return this.recallResultFormatter.formatObjectiveStateResults(results);
  }

  private formatCausalTrajectoryResults(
    results: CausalTrajectorySearchResult[],
  ): string {
    return this.recallResultFormatter.formatCausalTrajectoryResults(results);
  }

  private formatTrustZoneResults(results: TrustZoneSearchResult[]): string {
    return this.recallResultFormatter.formatTrustZoneResults(results);
  }

  private formatHarmonicRetrievalResults(
    results: HarmonicRetrievalResult[],
  ): string {
    return this.recallResultFormatter.formatHarmonicRetrievalResults(results);
  }

  private formatWorkProductResults(
    results: WorkProductLedgerSearchResult[],
  ): string {
    return this.recallResultFormatter.formatWorkProductResults(results);
  }

  private formatVerifiedEpisodeResults(
    results: VerifiedEpisodeResult[],
  ): string {
    return this.recallResultFormatter.formatVerifiedEpisodeResults(results);
  }

  private formatVerifiedSemanticRuleResults(
    results: VerifiedSemanticRuleResult[],
  ): string {
    return this.recallResultFormatter.formatVerifiedSemanticRuleResults(results);
  }

  private summarizeIdentityText(
    raw: string,
    maxLines: number,
    maxChars: number,
  ): string {
    return this.recallResultFormatter.summarizeIdentityText(raw, maxLines, maxChars);
  }

  private formatOpenIncidentLine(
    incident: ContinuityIncidentRecord,
    includeDetails: boolean,
  ): string {
    return this.recallResultFormatter.formatOpenIncidentLine(incident, includeDetails);
  }

  private trimIdentitySection(
    content: string,
    maxChars: number,
  ): { text: string; truncated: boolean } {
    return this.recallResultFormatter.trimIdentitySection(content, maxChars);
  }

  private async buildIdentityContinuitySection(options: {
    storage: StorageManager;
    recallMode: RecallPlanMode;
    prompt: string;
  }): Promise<{
    section: string;
    mode: IdentityInjectionMode;
    injectedChars: number;
    truncated: boolean;
  } | null> {
    return this.recallResultFormatter.buildIdentityContinuitySection(options);
  }

  private emitTrace(event: EngramTraceEvent): void {
    try {
      const cb = (globalThis as any).__openclawEngramTrace;
      if (typeof cb === "function") cb(event);
    } catch (err) {
      log.debug(`trace callback failed: ${err}`);
    }
  }

  private queueEvalShadowRecall(
    record: Omit<EvalShadowRecallRecord, "schemaVersion">,
  ): void {
    if (!resolveEvalCapabilities(this.config).evalHarness || !resolveEvalCapabilities(this.config).evalShadowMode)
      return;
    this.evalShadowWriteChain = this.evalShadowWriteChain
      .catch(() => undefined)
      .then(async () => {
        try {
          await recordEvalShadowRecall({
            memoryDir: this.config.memoryDir,
            evalStoreDir: this.config.evalStoreDir,
            record: {
              schemaVersion: 1,
              ...record,
            },
          });
        } catch (err) {
          log.debug(`eval shadow recall write failed: ${err}`);
        }
      });
  }

  private publishRecallResults(options: {
    title: string;
    results: QmdSearchResult[];
    sectionBuckets: Map<string, string[]>;
    retrievalQuery: string;
    sessionKey: string | undefined;
    identityInjection?: {
      mode: IdentityInjectionMode | "none";
      injectedChars: number;
      truncated: boolean;
    };
    /**
     * Issue #1577 — per-recall trust map. When present, quarantined items
     * are filtered from injection on EVERY recall path (hot QMD, embedding
     * fallback, cold archive, recent) so a faithfulness-contradicted memory
     * cannot sneak in via a branch that bypasses trust scoring (review:
     * fallback paths bypass trust). The map is also threaded to
     * formatQmdResults for the epistemic hedge.
     */
    trustByPath?: Map<string, TrustStageResultItem> | null;
  }): void {
    const sectionId = "memories";
    // Filter quarantined items from ALL recall paths so no branch can inject
    // a hard-negative memory that trust scoring excluded on another path.
    const trustByPath = options.trustByPath ?? null;
    const injectable = trustByPath
      ? options.results.filter((r) => !trustByPath.get(r.path)?.quarantined)
      : options.results;
    const memoryIds = this.extractMemoryIdsFromResults(injectable);
    this.trackMemoryAccess(memoryIds);

    this.appendRecallSection(
      options.sectionBuckets,
      sectionId,
      this.formatQmdResults(options.title, injectable, options.sessionKey, trustByPath),
    );
  }

  /**
   * Apply MMR over the pre-truncation recall candidate pool and then slice
   * the result to `limit`. This is the single place in the pipeline where
   * MMR runs, and it must be called *before* callers throw away candidates
   * that would otherwise sit below the final cutoff. Running MMR post-slice
   * is a no-op in the cases we care about — diverse candidates just below
   * the cutoff are already gone and can never be promoted.
   *
   * Callers must pass the full candidate pool (post-rerank, pre-slice).
   */
  private qmdCollectionNamespaceFromPrefix(collectionPrefix: string): string | null {
    const baseCollection = this.config.qmdCollection;
    if (collectionPrefix === baseCollection) return this.config.defaultNamespace;
    const namespaceSuffix = collectionPrefix.startsWith(`${baseCollection}--`)
      ? collectionPrefix.slice(baseCollection.length + 2)
      : "";
    if (!namespaceSuffix) return null;

    const decoded = namespaceIdentityFromToken(namespaceSuffix);
    if (decoded !== null) return decoded || this.config.defaultNamespace;
    if (namespaceSuffix.startsWith("ns--")) {
      const legacyNamespace = namespaceSuffix.slice("ns--".length).trim();
      return legacyNamespace || null;
    }
    return null;
  }

  // Issue #1526 seam 11: QMD result-resolution methods moved to QmdResultResolver.
  // Thin delegation keeps the private API stable for callers + tests.
  private async readQmdResultMemory(
    resultPath: string,
    fallbackStorage: StorageManager,
    recallNamespaces: readonly string[] = [],
  ): Promise<MemoryFile | null> {
    return this.qmdResultResolver.readQmdResultMemory(resultPath, fallbackStorage, recallNamespaces);
  }

  private async resolveColdQmdResultForRecall(
    result: QmdSearchResult,
    fallbackStorage: StorageManager,
    recallNamespaces: readonly string[] = [],
  ): Promise<{ namespace: string; result: QmdSearchResult } | null> {
    return this.qmdResultResolver.resolveColdQmdResultForRecall(result, fallbackStorage, recallNamespaces);
  }

  private async storageForAbsoluteQmdResultPath(
    resultPath: string,
    fallbackStorage: StorageManager,
    recallNamespaces: readonly string[] = [],
  ): Promise<{ storage: StorageManager; dir: string; namespace: string } | null> {
    return this.qmdResultResolver.storageForAbsoluteQmdResultPath(resultPath, fallbackStorage, recallNamespaces);
  }

  // Issue #1526: recall-rerank methods moved to RecallRerankCoordinator.
  // Thin delegation keeps the private API stable for callers + tests.
  private async applyMemoryWorthRerank(
    results: QmdSearchResult[],
    namespaces: string[],
  ): Promise<QmdSearchResult[]> {
    return this.recallRerankCoordinator.applyMemoryWorthRerank(results, namespaces);
  }

  private async applyTrustScoreRerank(
    results: QmdSearchResult[],
    namespaces: string[],
  ): Promise<{
    results: QmdSearchResult[];
    trustByPath: Map<string, TrustStageResultItem> | null;
  }> {
    return this.recallRerankCoordinator.applyTrustScoreRerank(results, namespaces);
  }

  private async applyTrustScoreToBranch(
    results: QmdSearchResult[],
    namespaces: string[],
    caps: CapabilitySet,
    label: string,
  ): Promise<{
    results: QmdSearchResult[];
    trustByPath: Map<string, TrustStageResultItem> | null;
  }> {
    return this.recallRerankCoordinator.applyTrustScoreToBranch(results, namespaces, caps, label);
  }

  private diversifyAndLimitRecallResults(
    sectionId: string,
    results: QmdSearchResult[],
    limit: number,
    retrievalQuery?: string,
    caps: CapabilitySet = resolveCapabilities(this.config),
  ): QmdSearchResult[] {
    return this.recallRerankCoordinator.diversifyAndLimitRecallResults(sectionId, results, limit, retrievalQuery, caps);
  }

  private applyMmrToQmdResults(
    sectionId: string,
    results: QmdSearchResult[],
    caps: CapabilitySet = resolveCapabilities(this.config),
  ): QmdSearchResult[] {
    return this.recallRerankCoordinator.applyMmrToQmdResults(sectionId, results, caps);
  }

  private buildLastRecallBudgetSummary(options: {
    requestedTopK?: number;
    recallResultLimit: number;
    qmdFetchLimit: number;
    qmdHybridFetchLimit: number;
    finalContextChars?: number;
    truncated?: boolean;
    includedSections?: string[];
    omittedSections?: string[];
  }): LastRecallBudgetSummary {
    return this.recallSectionCoordinator.buildLastRecallBudgetSummary(options);
  }

  private collectLastRecallSources(
    sectionBuckets: Map<string, string[]>,
    recallSource:
      | "none"
      | "hot_qmd"
      | "hot_embedding"
      | "cold_fallback"
      | "recent_scan",
  ): string[] {
    return this.recallSectionCoordinator.collectLastRecallSources(
      sectionBuckets,
      recallSource,
    );
  }

  async semanticDedupLookup(
    content: string,
    limit: number,
    targetStorage: StorageManager,
  ): Promise<SemanticDedupHit[]> {
    return this.persistenceIndexCoordinator.semanticDedupLookup(
      content,
      limit,
      targetStorage,
    );
  }

  /**
   * Resolve the namespace-scoped filter to pass into
   * `EmbeddingFallback.search()` for semantic dedup. Returns an empty
   * object (no filter) when namespaces are disabled, preserving the
   * pre-PR #399 behavior for single-tenant installs.
   *
   * Index entries are stored as paths relative to `config.memoryDir`, so:
   *   - A non-default namespace `ns` lives under `namespaces/<ns>/…` and
   *     we include exactly that prefix.
   *   - The default namespace may live at `memoryDir` root (legacy) or at
   *     `memoryDir/namespaces/<default>/…` (migrated). When it lives at
   *     root we include everything but EXCLUDE all `namespaces/…` entries
   *     so facts from non-default namespaces can't cross-match.
   */
  private semanticDedupScopeFor(targetStorage: StorageManager): {
    pathPrefix?: string;
    pathExcludePrefixes?: readonly string[];
  } {
    if (!resolveNamespaceCapabilities(this.config).namespaces) return {};
    const memoryDir = path.resolve(this.config.memoryDir);
    const storageDir = path.resolve(targetStorage.dir);
    if (storageDir === memoryDir) {
      // Default namespace at legacy root. Include everything that isn't
      // under `namespaces/*` (those belong to other namespaces).
      return { pathExcludePrefixes: ["namespaces/"] };
    }
    let rel = path.relative(memoryDir, storageDir);
    if (!rel || rel.startsWith("..")) {
      // Round 12 fix (PR #399 thread PRRT_kwDORJXyws56U6Gj): when
      // targetStorage.dir is outside memoryDir (custom namespace routing),
      // toMemoryRelativePath() stores the absolute file path in the index
      // rather than a memoryDir-relative path. Return the absolute storageDir
      // as the pathPrefix so the search() filter still scopes the lookup to
      // the correct tenant's files. Previously this returned {} (no scoping),
      // which let high-similarity hits from other namespaces' absolute-path
      // entries suppress writes in the target namespace — a cross-tenant
      // dedup suppression path.
      log.debug(
        `semantic dedup: target storage dir ${storageDir} is outside memoryDir ${memoryDir}; scoping lookup to absolute path prefix`,
      );
      const absPrefix = storageDir.replace(/\\/g, "/");
      return { pathPrefix: absPrefix.endsWith("/") ? absPrefix : `${absPrefix}/` };
    }
    rel = rel.replace(/\\/g, "/");
    if (!rel.endsWith("/")) rel = `${rel}/`;
    return { pathPrefix: rel };
  }

  private async searchEmbeddingFallback(
    query: string,
    limit: number,
  ): Promise<QmdSearchResult[]> {
    return this.recallSearchPipelineCoordinator.searchEmbeddingFallback(
      query,
      limit,
    );
  }

  private async searchLongTermArchiveFallback(
    prompt: string,
    recallNamespaces: string[],
    limit: number,
    queryAwarePrefilter?: QueryAwarePrefilter,
    abortSignal?: AbortSignal,
  ): Promise<QmdSearchResult[]> {
    return this.recallSearchPipelineCoordinator.searchLongTermArchiveFallback(
      prompt,
      recallNamespaces,
      limit,
      queryAwarePrefilter,
      abortSignal,
    );
  }

  private async applyColdFallbackPipeline(options: {
    prompt: string;
    recallNamespaces: string[];
    recallResultLimit: number;
    recallMode: RecallPlanMode;
    /**
     * Recall-operation capability gates resolved once at recall entry (#1523).
     * OPTIONAL and additive: the recall pipeline threads a resolved set, but
     * callers that omit it (e.g. direct unit-test invocations) get an
     * equivalent config-derived set — behavior-preserving.
     */
    caps?: CapabilitySet;
    /** Graph-construction gates resolved at recall entry (#1566 Cluster A). */
    graphCaps?: GraphConstructionCapabilitySet;
    queryAwarePrefilter?: QueryAwarePrefilter;
    abortSignal?: AbortSignal;
    /** Backend degradation observer — cold-tier QMD must report like hot (#1536). */
    onDegradation?: (degradation: SearchDegradation) => void;
    /** Issue #680 — historical recall point in ms-since-epoch. */
    asOfMs?: number;
    /**
     * Optional out-parameter that receives the pre-MMR / pre-truncation
     * pool size captured inside the pipeline (issue #570 PR 1).  The
     * X-ray capture block in `recallInternal` passes a small sink so
     * the cold-fallback branch's pre-truncation pool size can be
     * attributed back to the branch when `recallSource === "cold_fallback"`.
     * Unset by default so existing call sites are unaffected.
     */
    xrayPoolSizeSink?: { size: number };
    /**
     * Issue #1577 — out-parameter that receives the TrustScore stage's
     * per-path trust map (admitted + quarantined) when the cold path runs
     * trust scoring. Mirrors the xrayPoolSizeSink pattern so recallInternal
     can propagate trust data for epistemic rendering and X-ray visibility
     without changing the cold pipeline's return type.
     */
    trustByPathSink?: { trustByPath: Map<string, TrustStageResultItem> | null };
    deadlineAtMs?: number | null;
    /** Issue #681 — when true, bypass graphTraversalConfidenceFloor. */
    includeLowConfidence?: boolean;
  }): Promise<QmdSearchResult[]> {
    return this.recallSearchPipelineCoordinator.applyColdFallbackPipeline(
      options,
    );
  }

  // ---------------------------------------------------------------------------
  // Access Tracking (Phase 1A)
  // ---------------------------------------------------------------------------

  /**
   * Record that memories were accessed (retrieved).
   * Updates are batched in memory and flushed during consolidation.
   */
  trackMemoryAccess(memoryIds: string[]): void {
    if (!resolveRecallEnhancementCapabilities(this.config).accessTracking) return;

    const now = new Date().toISOString();
    for (const id of memoryIds) {
      const existing = this.accessTrackingBuffer.get(id);
      this.accessTrackingBuffer.set(id, {
        count: (existing?.count ?? 0) + 1,
        lastAccessed: now,
      });
    }

    // Flush if buffer exceeds max size
    if (
      this.accessTrackingBuffer.size >= this.config.accessTrackingBufferMaxSize
    ) {
      this.flushAccessTracking().catch((err) =>
        log.debug(`background access tracking flush failed: ${err}`),
      );
    }
  }

  async flushAccessTracking(): Promise<void> {
    return this.workspaceOpsCoordinator.flushAccessTracking(
    );
  }

  private async loadSearchResultMemoryMap(
    results: QmdSearchResult[],
    preloadedMemoryMap?: Map<string, MemoryFile>,
    options?: {
      deadlineAtMs?: number | null;
      abortSignal?: AbortSignal;
      recallNamespaces?: readonly string[];
    },
  ): Promise<{
    memoryByPath: Map<string, MemoryFile>;
    checkedPaths: Set<string>;
    unreadablePaths: Set<string>;
    completed: boolean;
  }> {
    return this.recallSearchPipelineCoordinator.loadSearchResultMemoryMap(
      results,
      preloadedMemoryMap,
      options,
    );
  }

  private filterSearchResultsByRecallSafety(
    results: QmdSearchResult[],
    memoryByPath: Map<string, MemoryFile>,
    options?: {
      allowLifecycleFiltered?: boolean;
      allowDedicatedSurface?: boolean;
      asOfMs?: number;
      blockedPaths?: Set<string>;
    },
  ): QmdSearchResult[] {
    return this.recallSearchPipelineCoordinator.filterSearchResultsByRecallSafety(
      results,
      memoryByPath,
      options,
    );
  }

  private async filterSearchResultsForRecall(
    results: QmdSearchResult[],
    preloadedMemoryMap?: Map<string, MemoryFile>,
    options?: {
      allowLifecycleFiltered?: boolean;
      allowDedicatedSurface?: boolean;
      asOfMs?: number;
      deadlineAtMs?: number | null;
      abortSignal?: AbortSignal;
      dropUnresolved?: boolean;
      recallNamespaces?: readonly string[];
    },
  ): Promise<{ results: QmdSearchResult[]; memoryByPath: Map<string, MemoryFile> }> {
    return this.recallSearchPipelineCoordinator.filterSearchResultsForRecall(
      results,
      preloadedMemoryMap,
      options,
    );
  }

  private async boostSearchResults(
    results: QmdSearchResult[],
    _recallNamespaces: string[],
    prompt?: string,
    preloadedMemoryMap?: Map<string, MemoryFile>,
    options?: {
      allowLifecycleFiltered?: boolean;
      allowDedicatedSurface?: boolean;
      /**
       * Historical recall point in ms-since-epoch (issue #680).  When
       * set, drops candidates that were not authoritative at this
       * instant per `temporal-validity.isValidAsOf`.  Caller is
       * responsible for parsing/validating the user-supplied ISO
       * string at the input boundary (CLI / HTTP / MCP).
       */
      asOfMs?: number;
    },
  ): Promise<QmdSearchResult[]> {
    return this.recallSearchPipelineCoordinator.boostSearchResults(
      results,
      _recallNamespaces,
      prompt,
      preloadedMemoryMap,
      options,
    );
  }

  /**
   * Extract memory IDs from QMD search results for access tracking.
   */
  private extractMemoryIdsFromResults(results: QmdSearchResult[]): string[] {
    // QMD results have paths like /path/to/fact-123.md
    // Extract the ID from the filename
    return results
      .map((r) => {
        const match = r.path.match(/([^/]+)\.md$/);
        return match ? match[1] : null;
      })
      .filter((id): id is string => id !== null);
  }

  // ---------------------------------------------------------------------------
  // Contradiction Detection (Phase 2B)
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // Feedback (v2.2)
  // ---------------------------------------------------------------------------

  async recordMemoryFeedback(
    memoryId: string,
    vote: "up" | "down",
    note?: string,
  ): Promise<void> {
    await this.relevance.record(memoryId, vote, note);
  }

  // Negative Examples (v2.2)
  async recordNotUsefulMemories(
    memoryIds: string[],
    note?: string,
  ): Promise<void> {
    await this.negatives.recordNotUseful(memoryIds, note);
  }

  getLastRecall(sessionKey: string): LastRecallSnapshot | null {
    return this.lastRecall.get(sessionKey);
  }

  /**
   * Issue #1582 — resolve a memory handle (`[m:4f2a]` / bare hex) to its memory
   * id against THIS session's recent recall history. Returns the id on a unique
   * hit, `null` on a miss, and throws on ambiguity (callers must disambiguate —
   * rule 34/51). Resolution is per-session and snapshot-scoped; there is no
   * global handle→id map (rule 42).
   */
  resolveMemoryHandle(handle: string, sessionKey: string): string | null {
    if (!sessionKey) return null;
    const depth = this.config.recallHandleSnapshotDepth;
    const snapshots: RecallSnapshotIds[] = this.handleHistory
      .recent(sessionKey, depth)
      .map((ids) => ({ memoryIds: ids }));
    const result = resolveHandle(handle, snapshots, depth);
    if (result.ok) return result.memoryId;
    if (result.reason === "ambiguous") {
      throw new Error(
        `Memory handle ${handle} is ambiguous in session ${sessionKey}: ` +
          `${result.candidates.join(", ")}. Cite a unique memory id instead.`,
      );
    }
    return null;
  }

  /**
   * Issue #1582 — resolve a caller reference that may be EITHER a memory id or
   * a handle to a concrete memory id. Handles resolve against the session's
   * recall history; raw ids pass through unchanged. The single shared helper
   * every surface (memory_get / feedback / outcome / correction targetIds)
   * calls so handle resolution has one path (rule 22).
   */
  resolveMemoryIdOrHandle(ref: string, sessionKey?: string): string {
    const parsed = parseIdOrHandle(ref);
    if (!parsed.isHandle) return parsed.value;
    if (!sessionKey) {
      throw new Error(
        `Memory handle ${ref} cannot be resolved without a session key.`,
      );
    }
    const resolved = this.resolveMemoryHandle(parsed.value, sessionKey);
    if (resolved === null) {
      throw new Error(
        `Memory handle ${ref} was not found in the recent recall history for session ${sessionKey}.`,
      );
    }
    return resolved;
  }

  /**
   * Check if a new memory contradicts an existing one.
   * Uses QMD to find similar memories, then LLM to verify contradiction.
   */
  private async checkForContradiction(
    content: string,
    category: string,
    namespaceScope: string,
  ): Promise<{
    supersededId: string;
    confidence: number;
    reason: string;
    supersededPath: string;
    supersededCreated: string;
    supersededTags: string[];
  } | null> {
    return this.contradictionLinkingCoordinator.checkForContradiction(
      content,
      category,
      namespaceScope,
    );
  }

  /**
   * #1645: Complete the deferred contradiction auto-resolve after writeMemory
   * returns and the new write's tombstone status is known. Retires the old
   * memory + deindexes it ONLY when the new write is genuinely active (not
   * tombstone-blocked / pending_review). A blocked write must not retire the
   * only active copy — deferring here closes the "contradictionAutoResolve
   * supersedes before tombstone status is known" defect class.
   */
  private async applyDeferredContradictionResolve(
    contradiction: {
      supersededId: string;
      reason: string;
      supersededPath: string;
      supersededCreated: string;
      supersededTags: string[];
    } | null | undefined,
    storage: StorageManager,
    newMemoryId: string,
    postWriteGuard: boolean,
  ): Promise<void> {
    return this.contradictionLinkingCoordinator.applyDeferredContradictionResolve(
      contradiction,
      storage,
      newMemoryId,
      postWriteGuard,
    );
  }

  // ---------------------------------------------------------------------------
  // Memory Linking (Phase 3A)
  // ---------------------------------------------------------------------------

  /**
   * Suggest links for a new memory based on similar existing memories.
   */
  private async suggestLinksForMemory(
    content: string,
    category: string,
    namespaceScope: string,
  ): Promise<MemoryLink[]> {
    return this.contradictionLinkingCoordinator.suggestLinksForMemory(
      content,
      category,
      namespaceScope,
    );
  }

  private namespaceFromPath(p: string): string {
    return this.namespaceReadFanoutCoordinator.namespaceFromPath(
      p,
    );
  }

  private storageDirNamespace(storageDir: string): string {
    return this.namespaceReadFanoutCoordinator.storageDirNamespace(
      storageDir,
    );
  }

  // #1522: catalog touch methods removed — touches now happen at the storage chokepoint.

  /**
   * Public best-effort catalog write touch (issue #1499). User-facing explicit
   * captures (`memory_store`) and review-queue approvals persist via
   * `persistExplicitCapture()` → `storage.writeMemory()`, which bypasses the
   * extraction write path that owns the catalog touch. Without this their
   * namespaces never record `lastWriteAt`, so the catalog under-reports write
   * recency (round 5, codex P2). Fire-and-forget and failure-tolerant — a
   * catalog error must never affect the explicit write (gotcha #13, rule #40).
   *
   * An undefined/empty `namespace` means the write targeted the DEFAULT namespace
   * (`getStorage(undefined)` routes there), so we record it under the configured
   * default rather than skipping it (round 6, codex P2 — default `memory_store`
   * and inline-note writes were missing from `writtenSince`/maintenance).
   */


  // markCatalogRead removed — use storageRouter.recordRead() instead (#1522).

  private async readAllMemoriesForNamespaces(
    namespaces: string[],
  ): Promise<MemoryFile[]> {
    return this.namespaceReadFanoutCoordinator.readAllMemoriesForNamespaces(
      namespaces,
    );
  }

  private async readArchivedMemoriesForNamespaces(
    namespaces: string[],
  ): Promise<MemoryFile[]> {
    return this.namespaceReadFanoutCoordinator.readArchivedMemoriesForNamespaces(
      namespaces,
    );
  }
}
