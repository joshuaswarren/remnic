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

export interface BulkImportBatchIngestResult {
  attemptedTurnCount: number;
  extractionCount: number;
  persistedCount: number;
  durableOutputCount: number;
  skippedCount: number;
  failedCount: number;
  postPersistMetadataFailureCount: number;
  processedTurnCount: number;
}

export class BulkImportBatchPartialFailureError extends Error {
  readonly partialResult: BulkImportBatchIngestResult;

  readonly originalError: unknown;

  constructor(
    message: string,
    partialResult: BulkImportBatchIngestResult,
    originalError: unknown,
  ) {
    super(message);
    this.name = "BulkImportBatchPartialFailureError";
    this.partialResult = partialResult;
    this.originalError = originalError;
  }
}

// Issue #1526 seam 15: ExtractionRunResult moved to orchestration/extraction-run.ts.
export type { ExtractionRunResult } from "./orchestration/extraction-run.js";

export interface GraphRecallSnapshot {
  recordedAt: string;
  mode: RecallPlanMode | string;
  queryHash: string;
  queryLength: number;
  namespaces: string[];
  seedCount: number;
  expandedCount: number;
  seeds: string[];
  expanded: GraphRecallExpandedEntry[];
  status?: "completed" | "skipped" | "aborted";
  reason?: string;
  shadowMode?: boolean;
  queryIntent?: MemoryIntent;
  seedResults?: GraphRecallRankedResult[];
  finalResults?: GraphRecallRankedResult[];
  shadowComparison?: GraphRecallShadowComparison;
}

export interface IntentDebugSnapshot {
  recordedAt: string;
  promptHash: string;
  promptLength: number;
  retrievalQueryHash: string;
  retrievalQueryLength: number;
  plannerEnabled: boolean;
  plannedMode: RecallPlanMode;
  effectiveMode: RecallPlanMode;
  recallResultLimit: number;
  queryIntent: MemoryIntent;
  graphExpandedIntentDetected: boolean;
  graphDecision: {
    status: "not_requested" | "skipped" | "completed" | "aborted";
    reason?: string;
    shadowMode: boolean;
    qmdAvailable: boolean;
    graphRecallEnabled: boolean;
    multiGraphMemoryEnabled: boolean;
  };
}

export interface QmdRecallSnapshot {
  recordedAt: string;
  queryHash: string;
  queryLength: number;
  collection?: string;
  namespaces: string[];
  fetchLimit: number;
  primaryResultCount: number;
  hybridResultCount: number;
  queryAwareSeedCount: number;
  resultCount: number;
  intentHint?: string;
  explainEnabled: boolean;
  hybridTopUpUsed: boolean;
  hybridTopUpSkippedReason?: string;
  results: QmdSearchResult[];
}

export interface RecallModeDecision {
  plannedMode: RecallPlanMode;
  effectiveMode: RecallPlanMode;
  graphExpandedIntentDetected: boolean;
  graphReason?: string;
  /**
   * Where `plannedMode` came from (issue #1367 / Option C). `"heuristic"` for
   * the regex planner; `"llm"` when the LLM planner classified it; and
   * `"heuristic-fallback"` when the LLM was enabled but errored/timed out and we
   * fell back. Absent on the synchronous heuristic-only path.
   */
  plannerSource?: "heuristic" | "llm" | "heuristic-fallback";
  /** Short rationale from the planner (for telemetry / x-ray). */
  plannerReason?: string;
  /** Wall-clock spent in the LLM planner call, when one was made. */
  plannerLatencyMs?: number;
  /** True when the LLM planner was enabled but fell back to the heuristic. */
  plannerFallbackUsed?: boolean;
  /** Model that served the LLM classification, when one was used. */
  plannerModelUsed?: string;
  /**
   * The regex-heuristic baseline mode, captured whenever the LLM planner ran
   * (any source). Lets operators compare planned-vs-heuristic during rollout —
   * distinct from `plannedMode`, which on the LLM path is the LLM's choice.
   */
  plannerHeuristicMode?: RecallPlanMode;
  /**
   * In shadow mode, the mode the LLM *would* have chosen (recorded for
   * comparison) while `effectiveMode` stays on the heuristic decision.
   */
  shadowLlmMode?: RecallPlanMode;
}

/**
 * Map the orchestrator's internal `recallSource` strings to the
 * X-ray `servedBy` vocabulary (issue #570 PR 1).  The X-ray tier
 * ladder intentionally flattens QMD / embedding / cold-fallback to
 * the `hybrid` tier because they all materialize through the same
 * hybrid BM25+vector pipeline from the caller's perspective.  The
 * `recent_scan` path gets its own dedicated tier because it bypasses
 * the hybrid pipeline entirely.  `none` is treated as `hybrid` on the
 * theory that a query that returned nothing still routed through the
 * hybrid pipeline — but callers should normally gate capture on
 * `recalledMemoryIds.length > 0`.
 */
export function mapRecallSourceToXrayServedBy(
  source:
    | "none"
    | "hot_qmd"
    | "hot_embedding"
    | "cold_fallback"
    | "recent_scan",
): RecallXrayServedBy {
  // Exhaustive switch: every current union member is explicitly
  // listed so TypeScript surfaces a compile error if a new source is
  // added without a deliberate mapping.  The `never`-typed fallthrough
  // keeps the function total at runtime — if the caller passes an
  // unexpected value that slipped past the type system (e.g. a JSON
  // deserialization), we still fall back to `hybrid`.
  switch (source) {
    case "recent_scan":
      return "recent-scan";
    case "hot_qmd":
    case "hot_embedding":
    case "cold_fallback":
    case "none":
      return "hybrid";
  }
  const _exhaustive: never = source;
  void _exhaustive;
  return "hybrid";
}

export interface RecallInvocationOptions {
  namespace?: string;
  topK?: number;
  mode?: RecallPlanMode;
  abortSignal?: AbortSignal;
  /**
   * Capture a `RecallXraySnapshot` for this recall (issue #570).  When
   * `true`, the orchestrator builds a snapshot from the data it has
   * already gathered and stashes it in memory, accessible via
   * `getLastXraySnapshot()`.  When `false` or absent, nothing is
   * captured and recall behavior is unchanged (schema-only slice).
   */
  xrayCapture?: boolean;
  /**
   * Per-invocation override for `recallBudgetChars` (issue #570 PR 3/4).
   * Flows through `getRecallBudgetChars()` for this recall only — no
   * shared config mutation, so concurrent recalls on the same
   * orchestrator are not affected (CLAUDE.md rule 47: no shared
   * mutable state across async boundaries).  Must be a non-negative
   * finite integer; non-conforming values are ignored and the
   * configured budget is used.
   */
  budgetCharsOverride?: number;
  /**
   * Per-invocation principal override (issue #570 PR 4).  When set,
   * the orchestrator uses this principal for ACL / namespace checks
   * instead of `resolvePrincipal(sessionKey, config)`.  This is the
   * escape hatch for access surfaces (HTTP / MCP) that have already
   * authenticated the caller upstream — threading an unmapped
   * principal through the session-key-based resolver would otherwise
   * collapse it to `"default"` and produce false denials in
   * namespace-enabled deployments (CLAUDE.md rule 42).
   */
  principalOverride?: string;
  /**
   * Historical recall point (issue #680).  When set, the orchestrator
   * filters out memories whose `valid_at` is after this timestamp OR
   * whose `invalid_at` is at-or-before this timestamp, so callers see
   * the corpus as it existed at `asOf`.  ISO 8601 string; comparisons
   * use `Date.parse()` so timezone-aware values round-trip correctly
   * (CLAUDE.md gotcha — never compare ISO strings lexicographically).
   * Invalid values must be rejected at input boundaries (CLAUDE.md
   * rule 51); the orchestrator does NOT silently fall back here.
   */
  asOf?: string;
  /**
   * Issue #681 — when `true`, bypasses `graphTraversalConfidenceFloor`
   * and includes edges below the floor in graph traversal.  Useful for
   * diagnostic recall queries that need to surface results that would
   * normally be pruned by confidence decay.  Default `false`.
   */
  includeLowConfidence?: boolean;
  /**
   * User-aware context scopes active for this recall. Used by X-ray
   * provenance safety checks so boundary-scoped memories are evaluated
   * against the caller's real context.
   */
  currentContextScopes?: readonly unknown[];
}

export type QueryAwarePrefilter = {
  candidatePaths: Set<string> | null;
  temporalFromDate: string | null;
  matchedTags: string[];
  expandedTags: string[];
  combination: "none" | "temporal" | "tag" | "intersection" | "union";
  filteredToFullSearch: boolean;
};

// Recall-specific abort helpers.  Thin wrappers over the shared
// `abort-error.ts` module so every abort in the codebase shares the
// same `name === "AbortError"` classification contract (`isAbortError`
// works uniformly).  We keep the "recall aborted" default message for
// back-compat with call-site logs; callers that pass an explicit
// message (e.g. "extraction aborted (before_extract)") are unaffected.
const abortRecallError = sharedAbortError;

export function throwIfRecallAborted(
  signal?: AbortSignal,
  message = "recall aborted",
): void {
  sharedThrowIfAborted(signal, message);
}

export async function raceRecallAbort<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
  message = "recall aborted",
): Promise<T> {
  throwIfRecallAborted(signal, message);
  if (!signal) return promise;

  let onAbort: (() => void) | null = null;
  const abortPromise = new Promise<T>((_resolve, reject) => {
    onAbort = () => reject(abortRecallError(message));
    signal.addEventListener("abort", onAbort, { once: true });
  });

  try {
    return await Promise.race([promise, abortPromise]);
  } finally {
    if (onAbort) {
      signal.removeEventListener("abort", onAbort);
    }
  }
}

/** Maximum age (ms) before a compaction-reset signal file is considered stale and removed. */
export const COMPACTION_SIGNAL_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour
const DEFAULT_QMD_STARTUP_COLLECTION_CHECK_TIMEOUT_MS = 10_000;

type DaySummaryGatherOptions = {
  timeZone?: string;
  now?: Date;
};

function normalizeIanaTimeZone(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  try {
    Intl.DateTimeFormat(undefined, { timeZone: trimmed });
    return trimmed;
  } catch {
    return undefined;
  }
}

function formatDateInTimeZone(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function utcDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function utcDateKeysAround(date: Date): string[] {
  const dayMs = 86_400_000;
  const keys = [
    utcDateKey(new Date(date.getTime() - dayMs)),
    utcDateKey(date),
    utcDateKey(new Date(date.getTime() + dayMs)),
  ];
  return keys.filter((value, index, array) => array.indexOf(value) === index);
}

function utcDateKeysForLocalDay(date: Date, timeZone: string): string[] {
  const targetLocalDate = formatDateInTimeZone(date, timeZone);
  const keys = new Set<string>();
  const hourMs = 3_600_000;
  const scanStart = date.getTime() - 48 * hourMs;
  const scanEnd = date.getTime() + 48 * hourMs;
  for (let ms = scanStart; ms <= scanEnd; ms += hourMs) {
    const candidate = new Date(ms);
    if (formatDateInTimeZone(candidate, timeZone) === targetLocalDate) {
      keys.add(utcDateKey(candidate));
    }
  }
  return keys.size > 0 ? [...keys].sort() : utcDateKeysAround(date);
}

function parseFiniteDate(value: unknown): Date | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function filterHourlySummaryMarkdownForLocalDay(
  raw: string,
  utcDate: string,
  timeZone: string,
  targetLocalDate: string,
): string | null {
  const hourHeaderPattern = /^## ([01]\d|2[0-3]):00[ \t]*$/gm;
  const matches = Array.from(raw.matchAll(hourHeaderPattern));
  if (matches.length === 0) return null;

  const firstSectionStart = matches[0]?.index ?? 0;
  const preamble = raw.slice(0, firstSectionStart).trim();
  const sections: string[] = [];
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const hour = match[1];
    if (!hour) continue;
    const sectionTimestamp = parseFiniteDate(`${utcDate}T${hour}:00:00.000Z`);
    if (
      !sectionTimestamp ||
      formatDateInTimeZone(sectionTimestamp, timeZone) !== targetLocalDate
    ) {
      continue;
    }
    const sectionStart = match.index ?? 0;
    const sectionEnd = matches[index + 1]?.index ?? raw.length;
    const section = raw.slice(sectionStart, sectionEnd).trim();
    if (section.length > 0) sections.push(section);
  }

  if (sections.length === 0) return null;
  return [preamble, ...sections]
    .filter((section) => section.length > 0)
    .join("\n\n");
}

type SearchCollectionState = "present" | "missing" | "unknown" | "skipped";

function qmdStartupCollectionCheckTimeoutMs(): number {
  const raw =
    process.env.REMNIC_QMD_STARTUP_COLLECTION_CHECK_TIMEOUT_MS ??
    process.env.ENGRAM_QMD_STARTUP_COLLECTION_CHECK_TIMEOUT_MS;
  if (raw === undefined) return DEFAULT_QMD_STARTUP_COLLECTION_CHECK_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 1_000
    ? Math.floor(parsed)
    : DEFAULT_QMD_STARTUP_COLLECTION_CHECK_TIMEOUT_MS;
}

async function qmdStartupCollectionCheckWithTimeout(
  promise: Promise<SearchCollectionState>,
  controller: AbortController,
  label: string,
): Promise<SearchCollectionState> {
  const timeoutMs = qmdStartupCollectionCheckTimeoutMs();
  let timer: NodeJS.Timeout | undefined;
  let settled = false;

  const timeoutPromise = new Promise<SearchCollectionState>((resolve) => {
    timer = setTimeout(() => {
      if (settled) return;
      controller.abort();
      log.warn(
        `QMD startup collection check for ${label} timed out after ${timeoutMs}ms; keeping search enabled fail-open`,
      );
      resolve("unknown");
    }, timeoutMs);
    timer.unref?.();
  });

  const checkedPromise = promise
    .catch((err): SearchCollectionState => {
      log.warn(
        `QMD startup collection check for ${label} failed; keeping search enabled fail-open: ${err}`,
      );
      return "unknown";
    })
    .finally(() => {
      settled = true;
      if (timer) clearTimeout(timer);
    });

  return await Promise.race([checkedPromise, timeoutPromise]);
}

/** Default workspace directory when no per-agent or config workspace is available. */
export function defaultWorkspaceDir(): string {
  return path.join(os.homedir(), ".openclaw", "workspace");
}

/**
 * Produce a collision-resistant, filesystem-safe identifier from a session key.
 *
 * Session keys follow colon-delimited forms (e.g., `agent:gpucodebot:main`).
 * A naive replace (`:` → `_`) is lossy: different keys like `agent:alpha` and
 * `agent/alpha` would collide. Instead we append a short SHA-256 hash of the
 * original key to the human-readable sanitized prefix, guaranteeing uniqueness
 * while keeping filenames debuggable.
 *
 * Format: `<sanitized>-<12-char-hex-hash>`
 * Example: `agent:gpucodebot:main` → `agent_gpucodebot_main-a1b2c3d4e5f6`
 */
export function sanitizeSessionKeyForFilename(sessionKey: string): string {
  const readable = sessionKey.replace(/[^a-zA-Z0-9._-]/g, "_");
  const hash = createHash("sha256")
    .update(sessionKey)
    .digest("hex")
    .slice(0, 12);
  return `${readable}-${hash}`;
}

function sourceValidAtMs(turn: BufferTurn): number | null {
  if (typeof turn.sourceValidAt !== "string") return null;
  return parseFlexibleIsoTimestamp(turn.sourceValidAt.trim());
}

const SOURCE_VALID_AT_CONTEXT_TURNS = 2;

function sourceValidAtSliceKey(turn: BufferTurn, index: number): string {
  const validAtMs = sourceValidAtMs(turn);
  return validAtMs === null ? `unknown:${index}` : String(validAtMs);
}

function asExtractionContextTurn(turn: BufferTurn): BufferTurn {
  return { ...turn, extractionContextOnly: true };
}

function asExtractionTargetTurn(turn: BufferTurn): BufferTurn {
  const { extractionContextOnly: _contextOnly, ...targetTurn } = turn;
  return targetTurn;
}

function sourceValidAtContextTurns(
  turns: readonly BufferTurn[],
  targetStart: number,
  targetEnd: number,
  targetValidAtMs: number | null,
): BufferTurn[] {
  if (targetValidAtMs === null) return [];
  return turns
    .flatMap((turn, index) => {
      if (index >= targetStart && index < targetEnd) return [];
      const contextValidAtMs = sourceValidAtMs(turn);
      if (contextValidAtMs === null || contextValidAtMs > targetValidAtMs) {
        return [];
      }
      return [{ turn, index, validAtMs: contextValidAtMs }];
    })
    .sort((a, b) => {
      if (a.validAtMs < b.validAtMs) return -1;
      if (a.validAtMs > b.validAtMs) return 1;
      if (a.index === b.index) return 0;
      return a.index < b.index ? -1 : 1;
    })
    .slice(-SOURCE_VALID_AT_CONTEXT_TURNS)
    .map(({ turn }) => asExtractionContextTurn(turn));
}

function targetSourceValidAtSortMs(turns: readonly BufferTurn[]): number {
  let latestMs: number | null = null;
  for (const turn of turns) {
    if (turn.extractionContextOnly === true) continue;
    const validAtMs = sourceValidAtMs(turn);
    if (validAtMs === null) continue;
    if (latestMs === null || validAtMs > latestMs) {
      latestMs = validAtMs;
    }
  }
  return latestMs ?? Number.POSITIVE_INFINITY;
}

function sortSourceValidAtSlicesChronologically(
  slices: BufferTurn[][],
): BufferTurn[][] {
  return slices
    .map((turns, order) => ({
      turns,
      order,
      targetValidAtMs: targetSourceValidAtSortMs(turns),
    }))
    .sort((a, b) => {
      if (a.targetValidAtMs < b.targetValidAtMs) return -1;
      if (a.targetValidAtMs > b.targetValidAtMs) return 1;
      if (a.order === b.order) return 0;
      return a.order < b.order ? -1 : 1;
    })
    .map((slice) => slice.turns);
}

function splitTurnsBySourceValidAt(
  turns: readonly BufferTurn[],
  options: { includeContext?: boolean } = {},
): BufferTurn[][] {
  if (turns.length === 0) return [];
  if (!turns.some((turn) => sourceValidAtMs(turn) !== null)) {
    return [[...turns]];
  }

  const slices: BufferTurn[][] = [];
  let start = 0;
  while (start < turns.length) {
    const targetValidAtMs = sourceValidAtMs(turns[start]);
    const activeKey = sourceValidAtSliceKey(turns[start], start);
    let end = start + 1;
    while (
      end < turns.length &&
      sourceValidAtSliceKey(turns[end], end) === activeKey
    ) {
      end += 1;
    }

    const contextTurns =
      options.includeContext === false
        ? []
        : sourceValidAtContextTurns(turns, start, end, targetValidAtMs);
    slices.push([
      ...contextTurns,
      ...turns.slice(start, end).map(asExtractionTargetTurn),
    ]);
    start = end;
  }
  return sortSourceValidAtSlicesChronologically(slices);
}

export function isArtifactMemoryPath(filePath: string): boolean {
  return /(?:^|[\\/])artifacts(?:[\\/]|$)/i.test(filePath);
}
// Issue #1526 seam 15: deriveTopicsFromExtraction moved to orchestration/extraction-run.ts.
export { deriveTopicsFromExtraction } from "./orchestration/extraction-run.js";
export function buildCompressionGuidelinesMarkdown(
  events: MemoryActionEvent[],
  generatedAtIso: string = new Date().toISOString(),
): string {
  return buildCompressionGuidelinesMarkdownV2(events, generatedAtIso);
}

export function filterRecallCandidates(
  candidates: QmdSearchResult[],
  options: {
    namespacesEnabled: boolean;
    recallNamespaces: string[];
    resolveNamespace: (path: string) => string;
    limit: number;
  },
): QmdSearchResult[] {
  const scopedByNamespace = options.namespacesEnabled
    ? candidates.filter((r) =>
        options.recallNamespaces.includes(options.resolveNamespace(r.path)),
      )
    : candidates;
  return scopedByNamespace
    .filter((r) => !isArtifactMemoryPath(r.path))
    .slice(0, Math.max(0, options.limit));
}

export function applyQueryAwareCandidateFilter(
  candidates: QmdSearchResult[],
  candidatePaths: Set<string> | null,
): QmdSearchResult[] {
  if (!candidatePaths) return candidates;
  if (candidatePaths.size === 0) return [];
  const filtered = candidates.filter((candidate) =>
    candidatePaths.has(candidate.path),
  );
  return filtered.length > 0 ? filtered : candidates;
}

function tokenizeRecallQuery(prompt: string): string[] {
  return prompt
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3);
}

function hasLifecycleMetadata(frontmatter: MemoryFrontmatter): boolean {
  return (
    frontmatter.lifecycleState !== undefined ||
    frontmatter.verificationState !== undefined ||
    frontmatter.policyClass !== undefined ||
    frontmatter.lastValidatedAt !== undefined ||
    frontmatter.decayScore !== undefined ||
    frontmatter.heatScore !== undefined
  );
}

export function shouldFilterLifecycleRecallCandidate(
  frontmatter: MemoryFrontmatter,
  options: {
    lifecyclePolicyEnabled: boolean;
    lifecycleFilterStaleEnabled: boolean;
  },
): boolean {
  if (!options.lifecyclePolicyEnabled || !options.lifecycleFilterStaleEnabled)
    return false;
  if (!hasLifecycleMetadata(frontmatter)) return false;
  const lifecycleState = resolveLifecycleState(frontmatter);
  return lifecycleState === "stale" || lifecycleState === "archived";
}

export function lifecycleRecallScoreAdjustment(
  frontmatter: MemoryFrontmatter,
  options: {
    lifecyclePolicyEnabled: boolean;
  },
): number {
  if (!options.lifecyclePolicyEnabled) return 0;
  if (!hasLifecycleMetadata(frontmatter)) return 0;

  let delta = 0;
  const lifecycleState = resolveLifecycleState(frontmatter);
  switch (lifecycleState) {
    case "active":
      delta += 0.05;
      break;
    case "validated":
      delta += 0.03;
      break;
    case "candidate":
      delta -= 0.01;
      break;
    case "stale":
      delta -= 0.06;
      break;
    case "archived":
      delta -= 0.08;
      break;
  }
  if (frontmatter.verificationState === "disputed") {
    delta -= 0.12;
  }
  return delta;
}

export function computeArtifactRecallLimit(
  recallMode: RecallPlanMode,
  recallResultLimit: number,
  verbatimArtifactsMaxRecall: number,
): number {
  if (recallMode === "no_recall") return 0;
  if (Math.max(0, recallResultLimit) === 0) return 0;
  const base = Math.max(0, verbatimArtifactsMaxRecall);
  if (recallMode === "minimal") {
    return Math.min(base, Math.max(0, recallResultLimit));
  }
  return base;
}

export function resolveEffectiveRecallMode(options: {
  plannerEnabled: boolean;
  graphRecallEnabled: boolean;
  multiGraphMemoryEnabled: boolean;
  graphExpandedIntentEnabled?: boolean;
  prompt: string;
}): RecallPlanMode {
  return resolveRecallModeDecision(options).effectiveMode;
}

interface RecallModeGraphOptions {
  plannerEnabled: boolean;
  graphRecallEnabled: boolean;
  multiGraphMemoryEnabled: boolean;
  graphExpandedIntentEnabled?: boolean;
  prompt: string;
}

/**
 * Apply the graph-mode overlay + gating to a planner-produced mode.
 *
 * Shared by the heuristic ({@link resolveRecallModeDecision}) and LLM
 * ({@link resolveRecallModeDecisionAsync}) paths so graph promotion and the
 * "graph disabled → fall back to full" gating behave identically regardless of
 * which planner produced `plannedModeRaw` (gotcha #39).
 */
function finalizeRecallModeDecision(
  plannedModeRaw: RecallPlanMode,
  options: RecallModeGraphOptions,
): RecallModeDecision {
  let plannedMode: RecallPlanMode = plannedModeRaw;
  const graphExpandedIntentDetected =
    options.plannerEnabled &&
    options.graphExpandedIntentEnabled === true &&
    hasBroadGraphIntent(options.prompt);
  if (plannedMode !== "graph_mode" && graphExpandedIntentDetected) {
    plannedMode = "graph_mode";
  }
  if (
    plannedMode === "graph_mode" &&
    (!options.graphRecallEnabled || !options.multiGraphMemoryEnabled)
  ) {
    return {
      plannedMode,
      effectiveMode: "full",
      graphExpandedIntentDetected,
      graphReason: !options.graphRecallEnabled
        ? "graph recall disabled by config"
        : "multi-graph memory disabled by config",
    };
  }
  return {
    plannedMode,
    effectiveMode: plannedMode,
    graphExpandedIntentDetected,
  };
}

export function resolveRecallModeDecision(options: RecallModeGraphOptions): RecallModeDecision {
  const plannedMode: RecallPlanMode = options.plannerEnabled
    ? planRecallMode(options.prompt)
    : "full";
  return finalizeRecallModeDecision(plannedMode, options);
}

/**
 * Async recall-mode decision with optional LLM-based planning (issue #1367 /
 * Option C). Falls back to the heuristic decision when the LLM planner is
 * disabled, in shadow mode, or unavailable/failed — so this is always safe to
 * await on the recall hot path. Provider-agnostic: the LLM call routes through
 * the gateway/fallback chain.
 *
 * `recallPlannerEnabled === false` keeps the legacy "always full" behavior and
 * skips the LLM entirely (the planner as a whole is off).
 */
export async function resolveRecallModeDecisionAsync(
  options: RecallModeGraphOptions & {
    config: PluginConfig;
    /**
     * Recall-operation capability gates (issue #1523). REQUIRED: the recall
     * orchestrator always passes a resolved set — the LLM planner gate reads
     * `caps.recallPlannerLlm`, never re-derives from config.
     */
    caps: CapabilitySet;
    hints?: string[];
    llm?: FallbackLlmClient;
    signal?: AbortSignal;
  },
): Promise<RecallModeDecision> {
  const heuristicDecision = resolveRecallModeDecision(options);

  // Planner globally off, or LLM planning not opted into → heuristic only.
  // Read the resolved capability (issue #1523) — never re-derive from config.
  const plannerLlmEnabled = options.caps.recallPlannerLlm;
  if (!options.plannerEnabled || !plannerLlmEnabled) {
    return heuristicDecision;
  }

  const { planRecallModeLLM } = await import("./recall-planner-llm.js");
  const planned = await planRecallModeLLM(
    options.prompt,
    options.hints,
    options.config,
    options.caps,
    options.llm,
    options.signal,
  );

  // Shadow mode: record what the LLM would have chosen but keep the heuristic
  // effective decision (safe rollout / comparison — gotcha #30).
  if (options.config.recallPlannerShadowMode) {
    return {
      ...heuristicDecision,
      plannerSource: planned.source,
      plannerReason: `shadow:${planned.reason}`,
      plannerLatencyMs: planned.latencyMs,
      plannerFallbackUsed: planned.fallbackUsed,
      plannerModelUsed: planned.modelUsed,
      plannerHeuristicMode: planned.heuristicMode,
      shadowLlmMode: planned.mode,
    };
  }

  const llmDecision = finalizeRecallModeDecision(planned.mode, options);
  return {
    ...llmDecision,
    plannerSource: planned.source,
    plannerReason: planned.reason,
    plannerLatencyMs: planned.latencyMs,
    plannerFallbackUsed: planned.fallbackUsed,
    plannerModelUsed: planned.modelUsed,
    plannerHeuristicMode: planned.heuristicMode,
  };
}

export function computeArtifactCandidateFetchLimit(
  targetCount: number,
): number {
  const cappedTarget = Math.max(0, targetCount);
  if (cappedTarget === 0) return 0;
  const headroom = Math.max(8, cappedTarget * 4);
  return Math.min(200, cappedTarget + headroom);
}

export function computeQmdHybridFetchLimit(
  recallFetchLimit: number,
  artifactsEnabled: boolean,
  maxArtifactRecall: number,
): number {
  const cappedRecallLimit = Math.max(0, recallFetchLimit);
  if (cappedRecallLimit === 0) return 0;
  if (!artifactsEnabled) return cappedRecallLimit;
  // Overscan when artifacts are enabled, then filter artifact paths before
  // re-applying the recall cap to avoid artifact-dominated top-N starvation.
  const artifactHeadroom = Math.max(20, Math.max(0, maxArtifactRecall) * 8);
  return Math.min(400, cappedRecallLimit + artifactHeadroom);
}
export function summarizeGraphShadowComparison(
  baseline: QmdSearchResult[],
  merged: QmdSearchResult[],
  topN: number,
): {
  baselineCount: number;
  graphCount: number;
  overlapCount: number;
  overlapRatio: number;
  averageOverlapDelta: number;
} {
  const limit = Math.max(0, Math.floor(topN));
  const baselineTop = limit > 0 ? baseline.slice(0, limit) : [];
  const graphTop = limit > 0 ? merged.slice(0, limit) : [];
  const baselineByPath = new Map(
    baselineTop.map((item) => [item.path, item.score]),
  );
  const graphByPath = new Map(graphTop.map((item) => [item.path, item.score]));

  let overlapCount = 0;
  let overlapDeltaSum = 0;
  for (const [p, baselineScore] of baselineByPath.entries()) {
    const graphScore = graphByPath.get(p);
    if (typeof graphScore !== "number") continue;
    overlapCount += 1;
    overlapDeltaSum += graphScore - baselineScore;
  }

  const baselineCount = baselineTop.length;
  return {
    baselineCount,
    graphCount: graphTop.length,
    overlapCount,
    overlapRatio: baselineCount > 0 ? overlapCount / baselineCount : 0,
    averageOverlapDelta: overlapCount > 0 ? overlapDeltaSum / overlapCount : 0,
  };
}

function parseGraphRecallRankedResults(
  value: unknown,
): GraphRecallRankedResult[] {
  if (!Array.isArray(value)) return [];
  const parsed: GraphRecallRankedResult[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const candidate = entry as Partial<GraphRecallRankedResult>;
    if (
      typeof candidate.path !== "string" ||
      typeof candidate.score !== "number"
    )
      continue;
    parsed.push({
      path: candidate.path,
      score: candidate.score,
      docid: typeof candidate.docid === "string" ? candidate.docid : undefined,
      sourceLabels: Array.isArray(candidate.sourceLabels)
        ? candidate.sourceLabels.filter(
            (item): item is string => typeof item === "string",
          )
        : [],
    });
  }
  return parsed.slice(0, 64);
}

function parseMemoryIntentSnapshot(value: unknown): MemoryIntent {
  const candidate =
    value && typeof value === "object" ? (value as Partial<MemoryIntent>) : {};
  return {
    goal: typeof candidate.goal === "string" ? candidate.goal : "unknown",
    actionType:
      typeof candidate.actionType === "string"
        ? candidate.actionType
        : "unknown",
    entityTypes: Array.isArray(candidate.entityTypes)
      ? candidate.entityTypes.filter(
          (item): item is string => typeof item === "string",
        )
      : [],
    taskInitiation: candidate.taskInitiation === true,
  };
}

function buildQmdIntentHint(intent: MemoryIntent): string | undefined {
  const parts: string[] = [];
  if (intent.goal !== "unknown") {
    parts.push(`goal:${intent.goal.replace(/_/g, " ")}`);
  }
  if (intent.actionType !== "unknown") {
    parts.push(`action:${intent.actionType.replace(/_/g, " ")}`);
  }
  if (intent.entityTypes.length > 0) {
    parts.push(`entities:${intent.entityTypes.join(",")}`);
  }
  if (intent.taskInitiation === true) {
    parts.push("task_initiation");
  }
  return parts.length > 0 ? parts.join(" ") : undefined;
}

function parseQmdRecallResults(value: unknown): QmdSearchResult[] {
  if (!Array.isArray(value)) return [];
  const parsed: QmdSearchResult[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const candidate = entry as Partial<QmdSearchResult>;
    if (
      typeof candidate.path !== "string" ||
      typeof candidate.score !== "number"
    )
      continue;
    parsed.push({
      docid: typeof candidate.docid === "string" ? candidate.docid : "",
      path: candidate.path,
      snippet: typeof candidate.snippet === "string" ? candidate.snippet : "",
      score: candidate.score,
      explain: parseQmdExplain(candidate.explain),
      transport:
        candidate.transport === "daemon" ||
        candidate.transport === "subprocess" ||
        candidate.transport === "hybrid" ||
        candidate.transport === "scoped_prefilter"
          ? candidate.transport
          : undefined,
    });
  }
  return parsed.slice(0, 32);
}

export function mergeArtifactRecallCandidates(
  candidatesByNamespace: MemoryFile[][],
  limit: number,
): MemoryFile[] {
  const cappedLimit = Math.max(0, limit);
  if (cappedLimit === 0) return [];

  const out: MemoryFile[] = [];
  const seen = new Set<string>();
  let offset = 0;
  while (out.length < cappedLimit) {
    let hasAnyCandidateAtOffset = false;
    for (const list of candidatesByNamespace) {
      if (offset >= list.length) continue;
      hasAnyCandidateAtOffset = true;
      const item = list[offset];
      const dedupeKey = `${item.frontmatter.id}:${item.frontmatter.sourceMemoryId ?? ""}:${item.content}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      out.push(item);
      if (out.length >= cappedLimit) break;
    }
    if (!hasAnyCandidateAtOffset) break;
    offset += 1;
  }
  return out;
}

export function resolveRecentThreadMemoryPaths(options: {
  threadEpisodeIds: string[];
  currentMemoryId: string;
  allMemsForGraph: MemoryFile[] | null | undefined;
  pathById?: Map<string, string>;
  storageDir: string;
  maxRecent: number;
}): string[] {
  const maxRecent = Math.max(0, options.maxRecent);
  if (options.threadEpisodeIds.length === 0 || maxRecent === 0) return [];
  const pathById =
    options.pathById ??
    buildMemoryPathById(options.allMemsForGraph, options.storageDir);
  if (pathById.size === 0) return [];

  // #1635 (defensive): skip pending_review ids from legacy episode sets.
  const pendingReviewIds = new Set<string>(
    (options.allMemsForGraph ?? [])
      .filter((m) => m.frontmatter.status === "pending_review" && m.frontmatter.id)
      .map((m) => m.frontmatter.id as string),
  );

  return options.threadEpisodeIds
    .filter((id) => id !== options.currentMemoryId)
    .filter((id) => !pendingReviewIds.has(id))
    .slice(-maxRecent)
    .map((id) => pathById.get(id))
    .filter((p): p is string => typeof p === "string" && p.length > 0);
}

export function buildMemoryPathById(
  allMemsForGraph: MemoryFile[] | null | undefined,
  storageDir: string,
): Map<string, string> {
  const pathById = new Map<string, string>();
  for (const mem of allMemsForGraph ?? []) {
    const id = mem.frontmatter.id;
    if (!id) continue;
    pathById.set(id, path.relative(storageDir, mem.path));
  }
  return pathById;
}

export function appendMemoryToGraphContext(options: {
  allMemsForGraph: MemoryFile[] | null | undefined;
  storageDir: string;
  memoryRelPath: string;
  memoryId: string;
  category: MemoryFile["frontmatter"]["category"];
  content: string;
  entityRef: string | undefined;
}): void {
  if (!Array.isArray(options.allMemsForGraph)) return;

  const nowIso = new Date().toISOString();
  options.allMemsForGraph.push({
    path: path.join(options.storageDir, options.memoryRelPath),
    content: options.content,
    frontmatter: {
      id: options.memoryId,
      category: options.category,
      created: nowIso,
      updated: nowIso,
      source: "extraction",
      confidence: 0.8,
      confidenceTier: "implied",
      tags: [],
      entityRef: options.entityRef,
      status: "active",
    },
  });
}

export function resolvePersistedMemoryRelativePath(options: {
  memoryId: string;
  pathById: Map<string, string>;
  category: string;
}): string {
  const persisted = options.pathById.get(options.memoryId);
  if (persisted) return persisted;
  if (options.category === "correction") {
    return path.join("corrections", `${options.memoryId}.md`);
  }
  // Pick the subtree that matches the StorageManager.writeMemory routing
  // so fallback paths (used before memoryPathById has seen the fresh
  // write) agree with where the file actually lives. Routing goes through
  // the shared categoryDirName() chokepoint (utils/category-dir.ts) so
  // every category — decisions/, preferences/, reasoning-traces/, ... —
  // resolves to the same dir the writer used; otherwise graph edges point
  // at the wrong subtree and graph expansion silently drops those nodes
  // when readMemoryByPath cannot resolve them (issue #564 PR 3 / #1546).
  const subtree = categoryDirName(options.category);
  const idParts = options.memoryId.split("-");
  const maybeTimestamp = Number(idParts[1]);
  if (Number.isFinite(maybeTimestamp) && maybeTimestamp > 0) {
    const day = new Date(maybeTimestamp).toISOString().slice(0, 10);
    return path.join(subtree, day, `${options.memoryId}.md`);
  }
  return path.join(subtree, `${options.memoryId}.md`);
}

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

  /**
   * Faithfulness gate verdict distribution (issue #1576). Consumed by the
   * console-state aggregator so `remnic doctor` can render how the gate is
   * performing. Returns a fresh object so callers cannot mutate the
   * internal counters. Returns `undefined` when the gate is off so the
   * console-state snapshot omits the faithfulness block entirely (cursor
   * review: an all-zero block would otherwise always be truthy and leak
   * into snapshots that document it as absent-when-off).
   */
  getConsoleFaithfulnessDistribution(): FaithfulnessGateCounters | undefined {
    if (this.config.extractionFaithfulnessGate === "off") return undefined;
    return { ...this.faithfulnessCounters };
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
  private static readonly ARTIFACT_STATUS_CACHE_TTL_MS = 60_000;

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
    const currentRank = this.namespaceStorageDirHintOwnershipRank(
      current,
      resolvedStorageDir,
      configured,
    );
    const candidateRank = this.namespaceStorageDirHintOwnershipRank(
      candidate,
      resolvedStorageDir,
      configured,
    );
    if (candidateRank < currentRank) return candidate;
    if (candidateRank > currentRank) return current;

    const byName = candidate.namespace.localeCompare(current.namespace);
    if (byName < 0) return candidate;
    if (byName > 0) return current;
    return candidate.identityToken.localeCompare(current.identityToken) < 0
      ? candidate
      : current;
  }

  private loadNamespaceStorageDirHintsFromCatalog(): void {
    if (this.namespaceStorageDirHintsLoaded || !this.namespaceCatalog.enabled) return;
    this.namespaceStorageDirHintsLoaded = true;
    const catalogPath = path.join(this.config.memoryDir, "state", "namespaces.jsonl");
    if (!existsSync(catalogPath)) return;

    let body: string;
    try {
      body = readFileSync(catalogPath, "utf8");
    } catch {
      return;
    }

    const compactedByNamespace = new Map<
      string,
      { namespace: string; identityToken: string; storageDir: string }
    >();
    for (const line of body.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
        const record = parsed as Record<string, unknown>;
        if (
          typeof record.namespace !== "string" ||
          typeof record.storageDir !== "string" ||
          typeof record.identityToken !== "string"
        ) {
          continue;
        }
        const namespace = normalizeNamespaceIdentity(record.namespace);
        if (!namespace || record.identityToken !== namespaceIdentityToken(namespace)) continue;
        compactedByNamespace.set(namespace, {
          namespace,
          identityToken: record.identityToken,
          storageDir: record.storageDir,
        });
      } catch {
        // Catalog hints are best-effort. The catalog reader still owns full recovery.
      }
    }

    const configured = new Set(
      this.configuredNamespaceList().map((namespace) => normalizeNamespaceIdentity(namespace)),
    );
    const preferredByStorageDir = new Map<
      string,
      { namespace: string; identityToken: string; storageDir: string }
    >();
    for (const record of compactedByNamespace.values()) {
      if (!this.storageDirMatchesNamespaceHint(record.namespace, record.storageDir)) {
        continue;
      }
      const resolvedStorageDir = path.resolve(record.storageDir);
      const current = preferredByStorageDir.get(resolvedStorageDir);
      preferredByStorageDir.set(
        resolvedStorageDir,
        current
          ? this.preferNamespaceStorageDirHintOwner(
              current,
              record,
              resolvedStorageDir,
              configured,
            )
          : record,
      );
    }
    for (const record of preferredByStorageDir.values()) {
      this.rememberNamespaceStorageDirHint(record.namespace, record.storageDir);
    }
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
    if (
      resolveNamespaceCapabilities(this.config).namespaces &&
      options.namespaces !== undefined &&
      options.namespaces.length === 0
    ) {
      return [];
    }
    const namespaces = resolveNamespaceCapabilities(this.config).namespaces
      ? Array.from(
          new Set(
            (options.namespaces?.length
              ? options.namespaces
              : this.configuredNamespaceList()
            )
              .map((value) => value.trim())
              .filter(Boolean),
          ),
        )
      : [this.config.defaultNamespace];

    if (!resolveNamespaceCapabilities(this.config).namespaces) {
      switch (options.mode) {
        case "hybrid":
          return await this.qmd.hybridSearch(
            options.query,
            undefined,
            options.maxResults,
            options.execution,
          );
        case "bm25":
          return await this.qmd.bm25Search(
            options.query,
            undefined,
            options.maxResults,
            options.execution,
          );
        case "vector":
          return await this.qmd.vectorSearch(
            options.query,
            undefined,
            options.maxResults,
            options.execution,
          );
        default:
          return await this.qmd.search(
            options.query,
            undefined,
            options.maxResults,
            options.searchOptions,
            options.execution,
          );
      }
    }

    return await this.namespaceSearchRouter.searchAcrossNamespaces({
      query: options.query,
      namespaces,
      maxResults: options.maxResults,
      mode: options.mode,
      searchOptions: options.searchOptions,
      execution: options.execution,
    });
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
    const index = await this.contentHashIndexForStorage(targetStorage);
    return index ? index.has(content) : false;
  }

  private async addContentHashDedup(
    targetStorage: StorageManager,
    content: string,
  ): Promise<void> {
    const index = await this.contentHashIndexForStorage(targetStorage);
    if (!index) return;
    index.add(content);
  }

  private async removeContentHashForMemory(
    targetStorage: StorageManager,
    memory: MemoryFile,
    context: string,
  ): Promise<void> {
    const index = await this.contentHashIndexForStorage(targetStorage);
    if (!index) return;

    if (memory.frontmatter.contentHash) {
      index.removeByHash(memory.frontmatter.contentHash);
      return;
    }

    log.warn(
      `[${context}] removing hash for legacy memory ${memory.frontmatter.id ?? "(unknown)"} via content fallback - no contentHash in frontmatter`,
    );
    index.remove(memory.content);
  }

  /**
   * Issue #1671 — backfill bi-temporal bounds onto an existing promoted/deduped
   * copy that was written BEFORE the source fact carried a resolved
   * `invalid_at`/`observedAt`/`eventTimeSource`.
   *
   * On re-extraction/backfill, a fact may now carry a resolved end bound (e.g.
   * "until June 2025") that the existing copy lacks because it was promoted
   * before bi-temporal wiring existed. Without this backfill, recall keeps
   * surfacing an expired fact even though the source copy now expires correctly.
   *
   * Finds the active fact in `targetStorage` matching `dedupContent`, then
   * patches the temporal frontmatter the existing copy is missing. Best-effort
   * / fail-open — any I/O error is logged and swallowed so the dedup
   * short-circuit is never blocked by a backfill failure.
   *
   * Matching: the stored `frontmatter.contentHash` is compared against
   * `ContentHashIndex.computeHash(dedupContent)` first (the exact hash the
   * content-hash index uses), then falls back to stripping citations and
   * comparing normalized bodies. This handles inline-attribution deployments
   * where the persisted body carries a citation marker the dedup key does not.
   *
   * I/O gate: only triggers when `invalidAt` is present (the end bound that
   * actually changes recall behavior by expiring the fact). `observedAt` and
   * `eventTimeSource` alone don'\''t expire a fact, so backfilling them without
   * an end bound would cause a full readAllMemories scan on every dedup hit
   * under biTemporal for no recall benefit.
   *
   * Only patches fields the existing copy LACKS — never overwrites a bound the
   * copy already carries.
   */
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
    // I/O gate: scan when there is a recall-relevant bound to backfill —
    // either an end bound (invalidAt, which expires the fact) or a corrected
    // EXTRACTED start bound. A start bound only changes recall when it is
    // extracted (the as-of filter excludes facts whose valid_at is after the
    // as-of instant); an "assumed" validFrom is just the ingestion anchor
    // (resolveFactEventTime sets one for every fact), so scanning on it would
    // run a full readAllMemories on every bi-temporal dedup hit for no benefit
    // (review cursor PRRT_OvHk / codex PRRT_OvHxVH). observedAt and
    // eventTimeSource alone never change recall.
    const hasExtractedStart =
      bounds.validFrom !== undefined && bounds.eventTimeSource === "extracted";
    if (!bounds.invalidAt && !hasExtractedStart) return;
    try {
      const incomingHash = ContentHashIndex.computeHash(dedupContent);
      const normalizedIncoming = ContentHashIndex.normalizeContent(dedupContent);
      // Normalize the entity for same-entity scoping when provided — two
      // entities can share identical fact text, and patching a different
      // entity'\''s fact would corrupt its temporal bounds (cursor review).
      const incomingEntityNorm = entityRef
        ? normalizeSupersessionKey(entityRef)
        : undefined;
      const all = await targetStorage.readAllMemories();
      const existing = all.find((m) => {
        if (m.frontmatter.category !== "fact") return false;
        if ((m.frontmatter.status ?? "active") !== "active") return false;
        // Same-entity guard: reject only when the stored fact carries a
        // DIFFERENT entity (two entities can share identical fact text, so
        // patching the other entity's copy would corrupt its bounds — codex
        // P2 PRRT_OvB4A). Legacy facts written before entity linkage (no
        // entityRef) have no entity to conflict with, so they stay eligible
        // for backfill (cursor PRRT_OvKnV: the guard must NOT silently
        // no-op for older promoted copies that predate entity linkage).
        if (
          incomingEntityNorm &&
          m.frontmatter.entityRef &&
          normalizeSupersessionKey(m.frontmatter.entityRef) !== incomingEntityNorm
        ) {
          return false;
        }
        // Prefer the stored contentHash (what the hash index actually keys
        // on) — it is computed from contentHashSource (the raw/enriched
        // body before citation), matching the dedupContent the caller passes.
        if (m.frontmatter.contentHash) {
          return m.frontmatter.contentHash === incomingHash;
        }
        // Legacy facts without a stored hash: strip citations then compare
        // normalized bodies so inline-attribution markers don'\''t prevent
        // a match.
        return (
          ContentHashIndex.normalizeContent(
            stripCitationForTemplate(m.content ?? "", this.config.inlineSourceAttributionFormat),
          ) === normalizedIncoming
        );
      });
      if (!existing) return;
      // Build a patch containing ONLY the fields the existing copy lacks.
      const patch: Partial<MemoryFrontmatter> = {};
      const fm = existing.frontmatter;
      if (bounds.invalidAt && (!fm.invalid_at || fm.invalid_at.length === 0)) {
        patch.invalid_at = bounds.invalidAt;
      }
      if (bounds.observedAt && (!fm.observedAt || fm.observedAt.length === 0)) {
        patch.observedAt = bounds.observedAt;
      }
      if (
        bounds.eventTimeSource &&
        (!fm.eventTimeSource || fm.eventTimeSource.length === 0)
      ) {
        patch.eventTimeSource = bounds.eventTimeSource;
      }
      // #1707 thread 2 — per-fact-anchored start bound. A re-extracted
      // duplicate whose event time resolves a real start bound must carry
      // that anchor onto the existing copy so as-of recall uses the corrected
      // valid_at instead of a stale batch-anchored value. Only an EXTRACTED
      // bound corrects; an "assumed" bound is just the ingestion anchor.
      //
      // No-clobber via equality, not provenance inference: exact-content dedup
      // re-extracts the SAME event-time expression, which #1670 per-fact
      // anchoring resolves deterministically to the same validFrom — so for
      // stable content the incoming validFrom EQUALS the copy's valid_at and
      // we skip the redundant write (the only no-clobber that holds without a
      // fragile provenance heuristic — review codex PRRT_Ov7LKC). When they
      // differ (a prior batch/assumed anchor, end-only assumed start, or a
      // non-deterministic re-resolution), the extracted validFrom is the
      // authoritative correction and overwrites. The eventTimeSource upgrade
      // below records that the start is now extracted-anchored.
      if (
        bounds.validFrom &&
        bounds.eventTimeSource === "extracted" &&
        fm.valid_at !== bounds.validFrom
      ) {
        patch.valid_at = bounds.validFrom;
        // Mark the copy extracted-anchored in the SAME patch so its provenance
        // reflects the correction (review cursor PRRT_OvHM / codex PRRT_OvHxVD):
        // without this, a copy upgraded from "assumed" would keep "assumed"
        // provenance while carrying an extracted start. (The earlier
        // eventTimeSource block only fills an EMPTY source.)
        if (fm.eventTimeSource !== "extracted") {
          patch.eventTimeSource = "extracted";
        }
      }
      if (Object.keys(patch).length === 0) return;
      const ok = await targetStorage.writeMemoryFrontmatter(existing, patch);
      if (ok) {
        log.debug(
          `bitemporal-backfill: patched ${Object.keys(patch).join(",")} onto existing fact ${fm.id ?? "(unknown)"} in ${targetStorage.dir}`,
        );
      }
    } catch (err) {
      log.warn(
        `bitemporal-backfill: failed open for ${targetStorage.dir}: ${err}`,
      );
    }
  }

  private async saveContentHashIndexes(): Promise<void> {
    const indexes = new Set<ContentHashIndex>();
    if (this.contentHashIndex) indexes.add(this.contentHashIndex);
    for (const index of this.contentHashIndexesByStorageDir.values()) {
      indexes.add(index);
    }
    for (const index of indexes) {
      await index.save();
    }
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
    const currentStatusVersion = storage.getMemoryStatusVersion();
    const cached = this.artifactSourceStatusCache.get(storage);
    let snapshot = cached;
    const isFresh =
      snapshot !== undefined &&
      Date.now() - snapshot.loadedAtMs <=
        Orchestrator.ARTIFACT_STATUS_CACHE_TTL_MS &&
      snapshot.statusVersion === currentStatusVersion;

    const rebuildSnapshot = async () => {
      const MAX_STABLE_READ_ATTEMPTS = 3;
      let latestStatuses = new Map<
        string,
        "active" | "superseded" | "archived" | "missing"
      >();
      let latestVersionAfter = storage.getMemoryStatusVersion();

      for (let attempt = 0; attempt < MAX_STABLE_READ_ATTEMPTS; attempt += 1) {
        const versionBefore = storage.getMemoryStatusVersion();
        const allMemories = await storage.readAllMemories();
        const versionAfter = storage.getMemoryStatusVersion();
        latestVersionAfter = versionAfter;
        latestStatuses = new Map(
          allMemories.map((m) => [
            m.frontmatter.id,
            (m.frontmatter.status ?? "active") as
              | "active"
              | "superseded"
              | "archived"
              | "missing",
          ]),
        );

        if (versionAfter === versionBefore) {
          const rebuilt = {
            loadedAtMs: Date.now(),
            statusVersion: versionAfter,
            statuses: latestStatuses,
          };
          this.artifactSourceStatusCache.set(storage, rebuilt);
          return rebuilt;
        }
      }

      // Sustained write churn: return latest read without caching a potentially torn snapshot.
      return {
        loadedAtMs: Date.now(),
        statusVersion: latestVersionAfter,
        statuses: latestStatuses,
      };
    };

    if (!isFresh) {
      snapshot = await rebuildSnapshot();
    } else {
      // Warm cache may miss brand-new sourceMemoryId values created after snapshot build.
      // Refresh once on-demand when unseen IDs are requested.
      const hasUnknownSourceIds = sourceIds.some(
        (id) => !snapshot?.statuses.has(id),
      );
      if (hasUnknownSourceIds) {
        snapshot = await rebuildSnapshot();
      }
    }

    // Persist negative lookups in the cached snapshot so stale source IDs do not
    // trigger repeated full snapshot rebuilds on every matching recall.
    for (const id of sourceIds) {
      if (!snapshot?.statuses.has(id)) {
        snapshot?.statuses.set(id, "missing");
      }
    }

    const statuses = new Map<
      string,
      "active" | "superseded" | "archived" | "missing"
    >();
    for (const id of sourceIds) {
      const status = snapshot?.statuses.get(id);
      if (status) {
        statuses.set(id, status);
      } else {
        statuses.set(id, "missing");
      }
    }
    return statuses;
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
    // Recreate the deferred-ready gate on every initialize() call.
    // The same Orchestrator instance may be reused across stop/start cycles
    // (src/index.ts does this). Without this reset, the second cycle's
    // `await orchestrator.deferredReady` resolves immediately (already settled
    // from the first cycle) while the new deferredInitialize() is still running.
    this.deferredReady = new Promise<void>((resolve) => {
      this.resolveDeferredReady = resolve;
    });

    try {
      await migrateFromEngram({
        quiet: true,
        logger: (message) => log.info(message),
      });
      await this.storage.ensureDirectories();
      await this.storage.loadAliases();
      if (resolveNamespaceCapabilities(this.config).namespaces) {
        const namespaces = new Set<string>([
          this.config.defaultNamespace,
          this.config.sharedNamespace,
          ...this.config.namespacePolicies.map((p) => p.name),
        ]);
        for (const ns of namespaces) {
          const sm = await this.storageRouter.storageFor(ns);
          await sm.ensureDirectories();
          await sm.loadAliases().catch(() => undefined);
        }
        // Explicitly seed the catalog with all configured namespaces at startup
        // (round 6, cursor Medium — NBLlR). The storageFor loop above fires the
        // router's onResolve hook, but a warm router cache (reused instance
        // across stop/start) can skip onResolve, leaving policy namespaces absent
        // from the live catalog until an operator runs `rebuild --apply`. This
        // call is cheap, idempotent, and best-effort: a catalog failure must
        // never break initialization (rule #13, #40).
        await this.namespaceCatalog.registerConfiguredNamespaces().catch(() => undefined);
      }
      // #1713 Item 2: recover stale `applying` correction plans left behind
      // by a process that died mid-apply. Best-effort — a failure here must
      // never block initialization (rule 13). Runs for every configured
      // namespace since correction plans can exist in any of them.
      try {
        // #1713 Item 2 + P2 (cursor): sweep ALL known namespaces — configured
        // + catalog-discovered — so stale applying plans in derived namespaces
        // (coding-scoped, session-derived) are also recovered.
        const correctionNamespaces = new Set(this.configuredNamespaceList());
        if (this.namespaceCatalog.enabled) {
          try {
            for (const rec of await this.namespaceCatalog.listNamespaces()) {
              correctionNamespaces.add(rec.namespace);
            }
          } catch { /* best-effort */ }
        }
        const recovered = await this.passiveCorrectionService().recoverStaleApplyingPlans(
          [...correctionNamespaces],
        );
        if (recovered > 0) {
          log.info(`correction: recovered ${recovered} stale applying plan(s) on startup`);
        }
      } catch (staleErr) {
        log.debug(`correction: stale-plan recovery skipped: ${staleErr instanceof Error ? staleErr.message : String(staleErr)}`);
      }
      await this.relevance.load();
      await this.negatives.load();
      await this.lastRecall.load();
      await this.handleHistory.load();
      await this.tierMigrationStatus.load();
      await this.sessionObserver.load();
      this.runtimePolicyValues = await this.policyRuntime.loadRuntimeValues();
      this.utilityRuntimeValues = await loadUtilityRuntimeValues({
        memoryDir: this.config.memoryDir,
        memoryUtilityLearningEnabled: resolveUtilityLearningCapabilities(this.config).memoryUtilityLearning,
        promotionByOutcomeEnabled: resolveUtilityLearningCapabilities(this.config).promotionByOutcome,
      });

      // Initialize content-hash dedup index
      if (resolveRecallAuxiliaryCapabilities(this.config).factDeduplication) {
        this.contentHashIndex = this.storage.createContentHashIndex();
        await this.contentHashIndex.load();
        log.info(
          `content-hash dedup: loaded ${this.contentHashIndex.size} hashes`,
        );
      }
      await this.transcript.initialize();
      await this.summarizer.initialize();
      if (this.sharedContext) {
        await this.sharedContext.ensureStructure();
      }
      if (this.compounding) {
        await this.compounding.ensureDirs();
      }

      // Buffer and compaction cleanup are fast and needed for basic operation —
      // load them before the init gate so turn buffering works immediately.
      try {
        await this.buffer.load();
      } catch (bufErr) {
        log.error(
          `buffer.load() failed (init gate will still open): ${bufErr}`,
        );
        this.buffer.resetToEmpty();
      }
      if (resolveRecallAuxiliaryCapabilities(this.config).compactionReset) {
        try {
          const wsDir = this.config.workspaceDir || defaultWorkspaceDir();
          const files = await readdir(wsDir).catch(() => [] as string[]);
          for (const f of files) {
            if (!f.startsWith(".compaction-reset-signal-")) continue;
            const fp = path.join(wsDir, f);
            const s = await stat(fp).catch(() => null);
            if (s && Date.now() - s.mtimeMs >= COMPACTION_SIGNAL_MAX_AGE_MS) {
              await unlink(fp).catch(() => {});
              log.debug(`initialize: removed stale compaction signal ${f}`);
            }
          }
        } catch (err) {
          log.debug("initialize: stale signal sweep failed:", err);
        }
      }

      // QMD probe + collection check: determines the final QMD state (real
      // client vs NoopSearchBackend). Must complete BEFORE the init gate opens
      // so that recall() — which awaits initPromise — always observes the final
      // QMD state. Without this ordering, a concurrent recall() could read
      // this.qmd while it's still the real client, then get errors when
      // deferredInitialize() swaps it to NoopSearchBackend mid-query.
      try {
        const available = await this.qmd.probe();
        if (available) {
          log.info(`Search backend: available ${this.qmd.debugStatus()}`);
          // Ensure collections at startup for the catalog-union namespace set, not
          // just the configured set (issue #1499 sweep, same class as NHZEV): a
          // dynamic namespace that exists only in the persisted catalog must have
          // its QMD collection checked/ensured on boot so recall against it works
          // after a restart. `registerConfiguredNamespaces()` already seeded the
          // catalog above, so `maintenanceNamespaces()` is readable here; it falls
          // back to the configured set on any catalog read failure.
          const namespaces = resolveNamespaceCapabilities(this.config).namespaces
            ? await this.maintenanceNamespaces()
            : [this.config.defaultNamespace];
          const states = await Promise.all(
            namespaces.map(async (namespace) => {
              const collectionCheckAbort = new AbortController();
              const state = await qmdStartupCollectionCheckWithTimeout(
                resolveNamespaceCapabilities(this.config).namespaces
                  ? this.namespaceSearchRouter.ensureNamespaceCollection(
                      namespace,
                      { signal: collectionCheckAbort.signal },
                    )
                  : this.qmd.ensureCollection(
                      this.config.memoryDir,
                      this.config.qmdCollection,
                      { signal: collectionCheckAbort.signal },
                    ),
                collectionCheckAbort,
                namespace,
              );
              return { namespace, state };
            }),
          );
          const defaultState =
            states.find(
              (entry) => entry.namespace === this.config.defaultNamespace,
            )?.state ?? "unknown";
          if (defaultState === "missing") {
            await this.disposeSearchBackendIfNeeded();
            this.qmd = new NoopSearchBackend();
            log.warn(
              "Search collection missing for Remnic memory store; disabling search retrieval for this runtime (fallback retrieval remains enabled)",
            );
          } else if (defaultState === "unknown") {
            log.warn(
              "Search collection check unavailable; keeping search retrieval enabled for fail-open behavior",
            );
          } else if (defaultState === "skipped") {
            log.debug(
              "Search collection check skipped (remote or daemon-only mode)",
            );
          }
          for (const entry of states) {
            if (entry.namespace === this.config.defaultNamespace) continue;
            if (entry.state === "missing") {
              log.warn(
                `Search collection missing for namespace '${entry.namespace}'; namespace retrieval will fail open to non-search paths`,
              );
            }
          }
        } else if (this.qmd instanceof NoopSearchBackend) {
          log.debug(`Search backend: noop (search intentionally disabled)`);
        } else {
          log.warn(`Search backend: not available ${this.qmd.debugStatus()}`);
        }
      } catch (err) {
        log.error(`QMD probe/collection check failed (non-fatal): ${err}`);
      }

      // Open the init gate — essential state (storage, aliases, relevance,
      // transcript, summarizer, buffer) is loaded AND QMD state is finalized
      // (probe + collection check complete, NoopSearchBackend swap done if
      // needed). Warmup, sync, caches, and remaining heavy operations run in
      // the background after this point via deferredInitialize().
      if (this.resolveInit) {
        this.resolveInit();
        this.resolveInit = null;
        log.info("init gate opened (essential state + QMD state loaded)");
      }

      // Deferred init: QMD sync, warmup, conversation index, caches, cron.
      // Runs in background so gateway_start returns fast. On low-power hardware
      // (Umbrel, RPi) QMD warmup/sync alone can take 30-60s and cause gateway
      // restart loops when they block the startup path. See issue #462.
      // Note: QMD probe + collection check (including NoopSearchBackend swap)
      // already ran above before the init gate, so this.qmd is finalized.
      //
      // Capture the resolver by value so a concurrent re-initialize() cannot
      // overwrite this.resolveDeferredReady before .finally() runs — that would
      // cause the first cycle's .finally() to resolve the *second* cycle's
      // promise prematurely while leaving the first cycle's promise pending.
      const resolveDeferred = this.resolveDeferredReady;
      this.resolveDeferredReady = null;
      this.deferredInitAbort = new AbortController();
      this.deferredInitialize(this.deferredInitAbort.signal)
        .catch((err) => {
          log.error(`deferred initialization failed (non-fatal): ${err}`);
        })
        .finally(() => {
          resolveDeferred?.();
        });
    } catch (err) {
      // Resolve both gates so callers never hang on permanently-pending promises
      // after catching the initialize() error:
      //
      // - initPromise: recall(), generateDaySummary(), etc. await this as a
      //   readiness gate with a 15s timeout. Leaving it pending means every
      //   subsequent call pays that timeout penalty.
      //
      // - deferredReady: CLI callers await this for full QMD readiness. Without
      //   resolution it hangs forever since deferredInitialize() never ran.
      if (this.resolveInit) {
        this.resolveInit();
        this.resolveInit = null;
      }
      if (this.resolveDeferredReady) {
        this.resolveDeferredReady();
        this.resolveDeferredReady = null;
      }
      throw err;
    }
  }

  private async deferredInitialize(signal: AbortSignal): Promise<void> {
    const lifecycleCaps = resolveMemoryLifecycleCapabilities(this.config);

    // Sync QMD index with current disk state so recall finds recently-written
    // facts. Without this, the index stays stale from the last extraction-
    // triggered update — which can be days ago if the daemon restarted without
    // new extractions. This is the root cause of "0 memories" recall results
    // despite thousands of facts on disk.
    if (this.qmd.isAvailable() && resolveQmdCapabilities(this.config).qmdMaintenance) {
      try {
        log.info("QMD startup sync: updating index to match current disk state");
        if (resolveNamespaceCapabilities(this.config).namespaces) {
          // Cover cataloged dynamic namespaces at startup too (NHZEV, codex P2):
          // a dynamic namespace written before a daemon restart must be synced on
          // boot, not only by the debounced runQmdMaintenance() path. Same union +
          // catalog-read-failure fallback as runQmdMaintenance.
          await this.namespaceSearchRouter.updateNamespaces(
            await this.maintenanceNamespaces(),
            { signal },
          );
        } else {
          await this.qmd.update({ signal });
        }
        log.info("QMD startup sync: complete");
        this.deferredSyncSucceeded = true;
      } catch (err) {
        log.warn(`QMD startup sync failed (non-fatal): ${err}`);
        // deferredSyncSucceeded stays false — server retry will attempt sync
      }
    } else if (!(this.qmd.isAvailable())) {
      // QMD not available at deferred init time — server retry will handle it
    } else {
      // QMD available but maintenance disabled — consider sync not needed
      this.deferredSyncSucceeded = true;
    }

    if (signal.aborted) return;

    // Warmup: run cheap searches to pre-load QMD embedding models and the
    // embedding-fallback JSON index so the first real recall is fast.
    const warmupPromises: Promise<void>[] = [];
    if (this.qmd.isAvailable()) {
      const warmupNs = this.config.defaultNamespace;
      log.info("QMD warmup: pre-loading models with a test search");
      warmupPromises.push(
        this.qmd
          .search("warmup", warmupNs, 1, undefined, { signal })
          .then(() => {
            log.info("QMD warmup: complete");
          })
          .catch((err) => {
            log.debug(`QMD warmup search failed (non-fatal): ${err}`);
          }),
      );
    }
    if (resolveMemoryLifecycleCapabilities(this.config).embeddingFallback) {
      warmupPromises.push(
        this.embeddingFallback
          .isAvailable()
          .then((ok) => {
            log.info(
              `Embedding fallback warmup: ${ok ? "available" : "unavailable (no provider)"}`,
            );
          })
          .catch((err) => {
            log.debug(`Embedding fallback warmup failed (non-fatal): ${err}`);
          }),
      );
    }
    await Promise.all(warmupPromises);
    if (signal.aborted) return;

    // Pre-warm knowledge index, memory, and entity caches.
    // Awaited so callers of `deferredReady` can rely on warmups being complete
    // and shutdown sequencing does not race with in-flight cache builds.
    const cacheWarmups: Promise<void>[] = [];
    if (resolveRecallAuxiliaryCapabilities(this.config).knowledgeIndex) {
      cacheWarmups.push(
        (async () => {
          try {
            const t0 = Date.now();
            await this.storage.buildKnowledgeIndex(this.config);
            log.info(`Knowledge Index warmup: complete in ${Date.now() - t0}ms`);
          } catch (err) {
            log.debug(`Knowledge Index warmup failed (non-fatal): ${err}`);
          }
        })(),
      );
    }
    cacheWarmups.push(this.storage.readAllMemories().then(() => {}).catch(() => {}));
    cacheWarmups.push(this.storage.readAllEntityFiles().then(() => {}).catch(() => {}));
    await Promise.all(cacheWarmups);
    if (signal.aborted) return;

    if (resolveIndexingCapabilities(this.config).conversationIndex && this.conversationIndexBackend) {
      try {
        const init = await this.conversationIndexBackend.initialize();
        if (!init.enabled) {
          this.config.conversationIndexEnabled = false;
        }
        if (init.logLevel === "info") {
          log.info(init.message);
        } else if (init.logLevel === "warn") {
          log.warn(init.message);
        } else {
          log.debug(init.message);
        }
      } catch (err) {
        log.error(`Conversation index initialization failed (non-fatal): ${err}`);
        this.config.conversationIndexEnabled = false;
      }
    }

    if (signal.aborted) return;

    if (resolveLocalLlmCapabilities(this.config).localLlm) {
      try {
        await this.validateLocalLlmModel();
      } catch (err) {
        log.error(`Local LLM validation failed (non-fatal): ${err}`);
      }
    }

    if (signal.aborted) return;

    // Await cron auto-registration so callers that `await deferredReady` can
    // rely on cron jobs being registered when it resolves. Without this, the
    // fire-and-forget pattern lets deferredReady settle while cron writes are
    // still in flight. Errors are non-fatal — catch individually.
    // Auto-register every cron job in one pass. Each registration is gated
    // by its config flag inside the scheduler and individually non-fatal
    // (issue #1526 PR1 — moved to MaintenanceScheduler).
    await this.maintenanceScheduler.autoRegisterCrons(signal);

    // First-start lifecycle migration (issue #686 retention-completion).
    // When lifecyclePolicyEnabled is true and the memoryDir has never been
    // touched by the lifecycle policy, run a one-time rate-limited demotion
    // sweep (capped at 50 demotions) so the hot tier isn't flooded on the
    // first real cron pass. Non-fatal — a failure here must not break init.
    if (signal.aborted) return;
    if (lifecycleCaps.lifecyclePolicy && resolveQmdCapabilities(this.config).qmdTierMigration) {
      try {
        const { runFirstStartMigration } = await import(
          "./maintenance/first-start-migration.js"
        );
        const result = await runFirstStartMigration({
          storage: this.storage,
          config: this.config,
          qmd: this.qmd,
          hotCollection: this.config.qmdCollection,
          coldCollection: this.config.qmdColdCollection,
          signal,
        });
        if (!result.skipped) {
          log.info(
            `first-start lifecycle migration: demoted ${result.demotedCount} of ${result.candidateCount} candidates (cap=${result.cappedAt})`,
          );
        } else {
          log.debug(`first-start lifecycle migration skipped: ${result.skipReason}`);
        }
      } catch (err) {
        log.warn(`first-start lifecycle migration failed (non-fatal): ${err}`);
      }
    }

    // Wearables auto-sync: in-process periodic transcript refresh for
    // long-lived hosts (default on). Today's transcript keeps growing
    // while the wearable records; a once-per-local-day deep pass picks
    // up late uploads and provider re-processing. Static config gate —
    // sources can't appear at runtime, so checking once here is safe.
    // The timer is unref'd, so one-shot CLI runs exit naturally without
    // ever ticking; idempotent across stop/start cycles via the handle
    // guard. Non-fatal: a failure to start must not break init.
    if (signal.aborted) return;
    if (
      !this.wearablesAutoSyncHandle &&
      this.config.wearables.enabled &&
      this.config.wearables.autoSyncEnabled &&
      Object.values(this.config.wearables.sources).some((source) => source.enabled)
    ) {
      try {
        const { startWearablesAutoSync } = await import("./wearables/auto-sync.js");
        // Re-check after the await: destroy() may have aborted while
        // the import was in flight, having found no handle to stop —
        // starting now would leave a live interval on a destroyed
        // orchestrator (Cursor review on PR #1464). Handle creation
        // below is synchronous, so no further window exists.
        if (signal.aborted) return;
        this.wearablesAutoSyncHandle = startWearablesAutoSync(
          {
            intervalMinutes: this.config.wearables.autoSyncIntervalMinutes,
            days: this.config.wearables.autoSyncDays,
            deepDays: this.config.wearables.autoSyncDeepDays,
            ...(this.config.wearables.timezone !== undefined
              ? { timezone: this.config.wearables.timezone }
              : {}),
          },
          {
            sync: (options) => this.getWearablesService().sync(options),
            log: {
              info: (message) => log.info(message),
              warn: (message) => log.warn(message),
            },
          },
        );
        log.info(
          `wearables auto-sync started: every ${this.config.wearables.autoSyncIntervalMinutes}m over ${this.config.wearables.autoSyncDays}d (deep ${this.config.wearables.autoSyncDeepDays}d daily)`,
        );
      } catch (err) {
        const { displayErrorDetail } = await import("./runtime/better-sqlite.js");
        log.warn(
          `wearables auto-sync failed to start (non-fatal): ${displayErrorDetail(err)}`,
        );
      }
    }

    log.info("orchestrator initialized (full — deferred steps complete)");
  }

  /**
   * Namespace-aware startup search sync. Re-probes QMD, ensures collections
   * (namespace-aware when namespacesEnabled), runs update, and warms up search.
   * Designed for server retry paths that run after the deferred init completes
   * when QMD was not available during initial startup.
   *
   * Accepts an optional AbortSignal so callers can interrupt the sync during
   * shutdown. The signal is checked between phases and forwarded into the QMD
   * update and warmup search calls so a long-running `qmd update` subprocess
   * is killed promptly rather than left in flight after `httpServer.stop()`.
   *
   * Returns true if the sync succeeded (QMD now available), false otherwise.
   */
  async startupSearchSync(signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) return false;

    const available = await this.qmd.probe();
    if (!available) return false;
    if (signal?.aborted) {
      log.debug("startupSearchSync: aborted after probe");
      return false;
    }

    log.info(`startupSearchSync: backend now available ${this.qmd.debugStatus()}`);

    // Clear namespace router cache so re-probe picks up newly available backends
    if (resolveNamespaceCapabilities(this.config).namespaces) {
      this.namespaceSearchRouter.clearCache();
    }

    // Ensure collections — namespace-aware when enabled.
    // Use the catalog-union namespace set (issue #1499 sweep, same class as
    // NHZEV): this is the QMD startup-recovery sync that ensures collections AND
    // runs `updateNamespaces(...)` below over the SAME `namespaces` set. A dynamic
    // namespace that exists only in the persisted catalog must be ensured and
    // re-synced here too, otherwise after a backend-was-unavailable-at-boot
    // recovery its collection stays stale. Falls back to the configured set on any
    // catalog read failure.
    const namespaces = resolveNamespaceCapabilities(this.config).namespaces
      ? await this.maintenanceNamespaces()
      : [this.config.defaultNamespace];

    const states = await Promise.all(
      namespaces.map(async (namespace) => ({
        namespace,
        state: resolveNamespaceCapabilities(this.config).namespaces
          ? await this.namespaceSearchRouter.ensureNamespaceCollection(namespace, { signal })
          : await this.qmd.ensureCollection(this.config.memoryDir, this.config.qmdCollection, { signal }),
      })),
    );

    if (signal?.aborted) {
      log.debug("startupSearchSync: aborted after ensureCollection");
      return false;
    }

    const defaultState =
      states.find((e) => e.namespace === this.config.defaultNamespace)?.state ?? "unknown";
    if (defaultState === "missing") {
      // Reset the real backend's available flag before replacing it with noop.
      // probe() set available=true earlier in this call; without this reset,
      // any code that captured a reference to the old backend (e.g. a concurrent
      // recall() that read this.qmd before the reassignment) would observe
      // isAvailable()===true against a backend with a missing collection.
      if ("available" in this.qmd) {
        (this.qmd as any).available = false;
      }
      await this.disposeSearchBackendIfNeeded();
      this.qmd = new NoopSearchBackend();
      log.warn("startupSearchSync: search collection missing; disabling search (fallback retrieval remains enabled)");
      return false;
    }

    // Run index update — namespace-aware when enabled.
    // qmd.update() swallows errors internally, so we: (1) snapshot fail/run
    // timestamps, (2) reset throttles so the update isn't skipped by stale
    // backoff, and (3) verify timestamps after update to confirm it executed
    // and didn't fail silently.
    // The abort signal is forwarded into the QMD subprocess call so the
    // long-running `qmd update` process is killed promptly on shutdown.
    if (resolveQmdCapabilities(this.config).qmdMaintenance) {
      try {
        const failTsBefore = "lastUpdateFailedAtMs" in this.qmd
          ? (this.qmd as any).lastUpdateFailedAtMs as number | null
          : null;
        const hasRunTs = "lastUpdateRanAtMs" in this.qmd;
        if ("resetUpdateThrottles" in this.qmd) {
          (this.qmd as any).resetUpdateThrottles();
        }
        log.info("startupSearchSync: updating index to match current disk state");
        let namespacesUpdated = 0;
        if (resolveNamespaceCapabilities(this.config).namespaces) {
          namespacesUpdated = await this.namespaceSearchRouter.updateNamespaces(
            namespaces,
            { signal },
          );
        } else {
          await this.qmd.update({ signal });
        }
        if (signal?.aborted) {
          log.debug("startupSearchSync: aborted after update");
          return false;
        }
        const failTsAfter = "lastUpdateFailedAtMs" in this.qmd
          ? (this.qmd as any).lastUpdateFailedAtMs as number | null
          : null;
        const runTsAfter = hasRunTs
          ? (this.qmd as any).lastUpdateRanAtMs as number | null
          : null;
        if (failTsAfter !== null && failTsAfter !== failTsBefore) {
          log.warn("startupSearchSync: update silently failed (detected via fail timestamp)");
          return false;
        }
        if (resolveNamespaceCapabilities(this.config).namespaces) {
          if (namespacesUpdated === 0) {
            log.warn("startupSearchSync: no namespace backends were eligible for update (all unavailable or collections missing)");
            return false;
          }
          log.info(`startupSearchSync: namespace updates succeeded (${namespacesUpdated}/${namespaces.length} namespaces updated)`);
        } else if (hasRunTs && runTsAfter === null) {
          log.warn("startupSearchSync: update was throttled/skipped (run timestamp is null after reset + update)");
          return false;
        }
        log.info("startupSearchSync: sync complete");
      } catch (err) {
        log.warn(`startupSearchSync: update failed: ${err}`);
        return false;
      }
    }

    // Warmup search to pre-load embedding models
    if (!signal?.aborted) {
      try {
        await this.qmd.search("warmup", this.config.defaultNamespace, 1, undefined, { signal });
        log.info("startupSearchSync: warmup complete");
      } catch (err) {
        log.debug(`startupSearchSync: warmup search failed (non-fatal): ${err}`);
      }
    }

    return true;
  }

  /**
   * Run the pattern-reinforcement maintenance job (issue #687 PR 2/4).
   *
   * Cadence-gated on `patternReinforcementCadenceMs` so every caller
   * (orchestrator cron path, MCP tool, CLI) shares a single floor —
   * none can call this on a hot loop and burn the corpus.  When the
   * feature is disabled or the cadence has not elapsed, returns a
   * synthetic "skipped" result rather than throwing.
   *
   * Cadence tracking is per-namespace so a tenant-scoped MCP run in
   * one namespace does not silence a cron run in another (PR #730
   * review feedback, Codex P2).  Pass `force: true` for ad-hoc
   * operator runs that must bypass the cadence floor — mirrors the
   * pattern used by other maintenance MCP tools.
   *
   * `force` deliberately does NOT bypass the master
   * `patternReinforcementEnabled` flag (PR #730 review feedback,
   * Cursor Medium).  Operators who have explicitly disabled the
   * feature must not have their corpus mutated by an MCP tool call —
   * the only way to run the job is to enable the feature in config.
   */
  async runPatternReinforcement(options: {
    force?: boolean;
    namespace?: string;
  } = {}): Promise<{
    ran: boolean;
    skippedReason?: "disabled" | "cadence";
    namespace: string;
    result?: PatternReinforcementResult;
  }> {
    const cadenceKey = options.namespace ?? "";
    // Master switch: a disabled feature is never bypassed, even with
    // force=true.  `force` only relaxes the cadence floor below.
    if (!resolveConsolidationCapabilities(this.config).patternReinforcement) {
      return { ran: false, skippedReason: "disabled", namespace: cadenceKey };
    }
    const cadence = this.config.patternReinforcementCadenceMs;
    const lastAt = this.lastPatternReinforcementAtByNs.get(cadenceKey);
    if (
      !options.force &&
      cadence > 0 &&
      lastAt !== undefined &&
      Date.now() - lastAt < cadence
    ) {
      return { ran: false, skippedReason: "cadence", namespace: cadenceKey };
    }
    const storage = options.namespace
      ? await this.getStorage(options.namespace)
      : this.storage;
    const result = await runPatternReinforcement(storage, {
      categories: this.config.patternReinforcementCategories,
      minCount: this.config.patternReinforcementMinCount,
    });
    this.lastPatternReinforcementAtByNs.set(cadenceKey, Date.now());
    log.debug(
      `pattern reinforcement [ns=${cadenceKey || "(default)"}]: clusters=${result.clustersFound} canonicalsUpdated=${result.canonicalsUpdated} duplicatesSuperseded=${result.duplicatesSuperseded}`,
    );
    return { ran: true, result, namespace: cadenceKey };
  }

  /**
   * Fan out pattern reinforcement across all maintained namespaces (issue #1500).
   * Delegates per-namespace execution to {@link runPatternReinforcement} while
   * the planner handles discovery, budgeting, locking, and status recording.
   * When namespaces are disabled, runs once against default storage.
   */
  async runPatternReinforcementFanout(options: {
    force?: boolean;
  } = {}): Promise<NamespaceMaintenanceSummary> {
    return this.runNamespaceMaintenanceFanoutForJob(
      "pattern-reinforcement",
      async (ctx) => {
        const result = await this.runPatternReinforcement({
          namespace: ctx.candidate.namespace,
          force: options.force,
        });
        // runPatternReinforcement has its own per-namespace cadence gate
        // (lastPatternReinforcementAtByNs). When it throttles (ran:false),
        // signal skip so the planner records state:"skipped" and does NOT
        // touch lastMaintenanceAt — otherwise a throttled namespace would
        // look maintained while pattern reinforcement never ran (#1500
        // review: cadence-skip accuracy).
        if (!result.ran) {
          return {
            skipped: true,
            skipReason: result.skippedReason ?? "throttled",
          };
        }
        return result.result
          ? { itemCount: result.result.clustersFound }
          : { itemCount: 0 };
      },
      { enabled: resolveConsolidationCapabilities(this.config).patternReinforcement },
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
    const hygiene = this.config.fileHygiene;
    if (!hygiene?.enabled) return;

    const now = Date.now();
    if (now - this.lastFileHygieneRunAtMs < hygiene.runMinIntervalMs) return;
    this.lastFileHygieneRunAtMs = now;

    // Rotation first (keeps bootstrap files small).
    if (hygiene.rotateEnabled) {
      for (const rel of hygiene.rotatePaths) {
        const abs = path.isAbsolute(rel)
          ? rel
          : path.join(this.config.workspaceDir, rel);
        try {
          const raw = await readFile(abs, "utf-8");
          if (raw.length > hygiene.rotateMaxBytes) {
            const archiveDir = path.join(
              this.config.workspaceDir,
              hygiene.archiveDir,
            );
            const base = path.basename(abs);
            const prefix =
              base
                .toUpperCase()
                .replace(/\.MD$/i, "")
                .replace(/[^A-Z0-9]+/g, "-") || "FILE";
            const { newContent } = await rotateMarkdownFileToArchive({
              filePath: abs,
              archiveDir,
              archivePrefix: prefix,
              keepTailChars: hygiene.rotateKeepTailChars,
            });
            await writeFile(abs, newContent, "utf-8");
          }
        } catch {
          // ignore missing/unreadable targets
        }
      }
    }

    // Lint (warn before truncation risk).
    if (hygiene.lintEnabled) {
      const warnings = await lintWorkspaceFiles({
        workspaceDir: this.config.workspaceDir,
        paths: hygiene.lintPaths,
        budgetBytes: hygiene.lintBudgetBytes,
        warnRatio: hygiene.lintWarnRatio,
      });
      for (const w of warnings) {
        log.warn(w.message);
      }

      if (hygiene.warningsLogEnabled && warnings.length > 0) {
        const fp = path.join(this.config.memoryDir, hygiene.warningsLogPath);
        await mkdir(path.dirname(fp), { recursive: true });
        const stamp = new Date().toISOString();
        const block =
          `\n\n## ${stamp}\n\n` +
          warnings.map((w) => `- ${w.message}`).join("\n") +
          "\n";
        let existing = "";
        try {
          existing = await readFile(fp, "utf-8");
        } catch {
          existing = "# Engram File Hygiene Warnings\n";
        }
        await writeFile(fp, existing + block, "utf-8");
      }
    }
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

  /**
   * Read today's facts and hourly summaries from storage, returning them
   * as a formatted string suitable for generateDaySummary().
   */
  async gatherTodayFacts(
    namespace?: string,
    options: DaySummaryGatherOptions = {},
  ): Promise<string> {
    const ns =
      namespace && namespace.length > 0
        ? namespace
        : this.config.defaultNamespace;
    const storage = await this.storageRouter.storageFor(ns);
    const configuredTimeZone = normalizeIanaTimeZone(options.timeZone)
      ?? normalizeIanaTimeZone(this.config.daySummaryTimezone);
    const timeZone =
      configuredTimeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    const now = options.now instanceof Date && Number.isFinite(options.now.getTime())
      ? options.now
      : new Date();
    const targetLocalDate = formatDateInTimeZone(now, timeZone);
    // Facts are stored under UTC date directories, while the summary target is
    // a local calendar day. Scan the UTC-date envelope that overlaps the local
    // day, then filter parseable fact timestamps to that configured local day.
    const datesToScan = utcDateKeysForLocalDay(now, timeZone);
    const MAX_CHARS = 100_000;

    // --- Read memory files from each category dir × date directory ---
    // Iterate every recall category dir (RECALL_FALLBACK_DIRS — single source
    // of truth) so the day summary includes decisions/, moments/, ... not just
    // facts/ (#1546). corrections/ is flat, so corrections/<date>/ never exists
    // and is skipped by the ENOENT guard — preserving the prior exclusion. The
    // per-file created→local-day filter below is unchanged.
    //
    // Symlink/containment hardening (mirrors scanDir / the CLI walker): the
    // gathered contents feed the day-summary LLM input, so a symlinked category
    // dir (decisions/ → outside memoryDir) must not be followed and leak files.
    // Resolve the store root once; skip symlinked / out-of-root dirs and
    // entries; skip the scan gracefully if the root can't be resolved.
    const facts: MemoryFile[] = [];
    let memoryRootReal: string | null = null;
    try {
      memoryRootReal = await realpath(storage.dir);
    } catch {
      memoryRootReal = null;
    }
    for (const categoryDir of RECALL_FALLBACK_DIRS) {
      if (memoryRootReal === null) break;
      for (const date of datesToScan) {
        const dateDir = path.join(storage.dir, categoryDir, date);
        try {
          const dirStat = await lstat(dateDir);
          if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) continue;
          assertPathInsideRoot(memoryRootReal, await realpath(dateDir), dateDir);
          const entries = await readdir(dateDir, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.isSymbolicLink()) continue;
            if (!entry.name.endsWith(".md")) continue;
            const fullPath = path.join(dateDir, entry.name);
            try {
              assertPathInsideRoot(memoryRootReal, await realpath(fullPath), fullPath);
              const raw = await readFile(fullPath, "utf-8");
              const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
              if (!fmMatch) continue;
              const fmBlock = fmMatch[1];
              const content = fmMatch[2].trim();
              const fm: Record<string, string> = {};
              for (const line of fmBlock.split("\n")) {
                const colonIdx = line.indexOf(":");
                if (colonIdx === -1) continue;
                fm[line.slice(0, colonIdx).trim()] = line
                  .slice(colonIdx + 1)
                  .trim();
              }
              const created = fm.created || "unknown";
              const createdAt = parseFiniteDate(created);
              if (
                createdAt &&
                formatDateInTimeZone(createdAt, timeZone) !== targetLocalDate
              ) {
                continue;
              }
              facts.push({
                path: fullPath,
                frontmatter: {
                  id: fm.id || path.basename(entry.name, ".md"),
                  category: (fm.category as any) || "fact",
                  created,
                  updated: fm.updated || created,
                  source: fm.source || "unknown",
                  confidence: parseFloat(fm.confidence || "0.8"),
                  confidenceTier: (fm.confidenceTier as any) || "implied",
                  tags: [],
                },
                content,
              });
            } catch {
              // Skip unreadable files
            }
          }
        } catch {
          // Absent dir (ENOENT), symlinked/out-of-root dir, or containment
          // violation — skip this category/date without aborting the summary.
        }
      }
    }

    // Sort facts by created timestamp (most recent last) so truncation keeps newest
    facts.sort((a, b) => {
      if (a.frontmatter.created === b.frontmatter.created) return 0;
      return a.frontmatter.created < b.frontmatter.created ? -1 : 1;
    });

    // --- Read hourly summaries for the scanned dates ---
    const hourlySummaries: string[] = [];
    const hourlyBaseDir = path.join(storage.dir, "summaries", "hourly");
    try {
      const sessionKeys = await readdir(hourlyBaseDir, { withFileTypes: true });
      for (const sk of sessionKeys) {
        if (!sk.isDirectory()) continue;
        for (const date of datesToScan) {
          const summaryFile = path.join(hourlyBaseDir, sk.name, `${date}.md`);
          try {
            const raw = await readFile(summaryFile, "utf-8");
            const filtered = filterHourlySummaryMarkdownForLocalDay(
              raw,
              date,
              timeZone,
              targetLocalDate,
            );
            if (filtered) {
              hourlySummaries.push(filtered);
            }
          } catch {
            // No summary file for this session/date
          }
        }
      }
    } catch {
      // No hourly summaries directory
    }

    // --- Format and truncate ---
    let formatted = formatDaySummaryMemories(facts);
    if (hourlySummaries.length > 0) {
      formatted +=
        "\n\n---\n## Hourly Summaries\n\n" +
        hourlySummaries.join("\n\n---\n\n");
    }

    // Truncate intelligently if over budget: drop oldest facts first
    if (formatted.length > MAX_CHARS) {
      // Re-build with fewer facts, keeping most recent
      while (facts.length > 1 && formatted.length > MAX_CHARS) {
        facts.shift(); // drop oldest
        formatted = formatDaySummaryMemories(facts);
        if (hourlySummaries.length > 0) {
          formatted +=
            "\n\n---\n## Hourly Summaries\n\n" +
            hourlySummaries.join("\n\n---\n\n");
        }
      }
      // If still over, hard truncate
      if (formatted.length > MAX_CHARS) {
        formatted = formatted.slice(0, MAX_CHARS);
      }
    }

    log.info(
      `gatherTodayFacts: collected ${facts.length} facts, ${hourlySummaries.length} hourly summaries for ${targetLocalDate} (${timeZone}, ${formatted.length} chars)`,
    );

    return formatted;
  }

  previewMemoryActionEvent(
    event: Omit<MemoryActionEvent, "timestamp"> & { timestamp?: string },
  ): MemoryActionEvent {
    const namespace =
      typeof event.namespace === "string" && event.namespace.length > 0
        ? event.namespace
        : this.config.defaultNamespace;
    const eligibility = parseMemoryActionEligibilityContext(
      event.policyEligibility,
    );
    const policy = evaluateMemoryActionPolicy({
      action: event.action,
      eligibility,
      options: {
        actionsEnabled: resolveCompressionCapabilities(this.config).contextCompressionActions,
        maxCompressionTokensPerHour: this.config.maxCompressionTokensPerHour,
      },
    });
    const dryRun = event.dryRun === true;

    const normalizedOutcome = dryRun
      ? event.outcome === "failed"
        ? "failed"
        : "skipped"
      : policy.decision === "allow"
        ? event.outcome
        : event.outcome === "failed"
          ? "failed"
          : "skipped";
    const sourceSessionKey =
      typeof event.sourceSessionKey === "string" &&
      event.sourceSessionKey.length > 0
        ? event.sourceSessionKey
        : typeof event.sessionKey === "string" && event.sessionKey.length > 0
          ? event.sessionKey
          : undefined;
    const outputMemoryIds = Array.isArray(event.outputMemoryIds)
      ? Array.from(
          new Set(
            event.outputMemoryIds.filter(
              (value): value is string =>
                typeof value === "string" && value.length > 0,
            ),
          ),
        )
      : [];

    const reasonParts = [
      event.reason,
      `policy:${policy.decision}`,
      policy.rationale,
    ].filter(
      (part): part is string => typeof part === "string" && part.length > 0,
    );

    return {
      ...event,
      schemaVersion: event.schemaVersion ?? 1,
      actionId:
        typeof event.actionId === "string" && event.actionId.length > 0
          ? event.actionId
          : `memact-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      outcome: normalizedOutcome,
      status:
        event.status ??
        (dryRun && policy.decision === "allow" && event.outcome !== "failed"
          ? "validated"
          : normalizedOutcome === "applied"
            ? "applied"
            : "rejected"),
      actor:
        typeof event.actor === "string" && event.actor.length > 0
          ? event.actor
          : "engram",
      subsystem:
        typeof event.subsystem === "string" && event.subsystem.length > 0
          ? event.subsystem
          : "memory_action",
      reason: reasonParts.join(" | "),
      namespace,
      sessionKey: sourceSessionKey ?? event.sessionKey,
      sourceSessionKey,
      inputSummary:
        typeof event.inputSummary === "string" && event.inputSummary.length > 0
          ? event.inputSummary
          : undefined,
      outputMemoryIds,
      dryRun,
      policyVersion:
        typeof event.policyVersion === "string" &&
        event.policyVersion.length > 0
          ? event.policyVersion
          : "memory-action-policy.v1",
      timestamp:
        typeof event.timestamp === "string" && event.timestamp.length > 0
          ? event.timestamp
          : new Date().toISOString(),
      policyDecision: policy.decision,
      policyRationale: policy.rationale,
      policyEligibility: eligibility,
    };
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
    const storage = await this.getStorage(namespace);
    const snapshotPath = path.join(
      storage.dir,
      "state",
      "last_graph_recall.json",
    );
    try {
      const raw = await readFile(snapshotPath, "utf-8");
      const parsed = JSON.parse(raw) as Partial<GraphRecallSnapshot>;
      if (!parsed || typeof parsed !== "object") return null;
      return {
        recordedAt:
          typeof parsed.recordedAt === "string" ? parsed.recordedAt : "",
        mode: typeof parsed.mode === "string" ? parsed.mode : "full",
        queryHash: typeof parsed.queryHash === "string" ? parsed.queryHash : "",
        queryLength:
          typeof parsed.queryLength === "number" ? parsed.queryLength : 0,
        namespaces: Array.isArray(parsed.namespaces)
          ? parsed.namespaces.filter((v): v is string => typeof v === "string")
          : [],
        seedCount: typeof parsed.seedCount === "number" ? parsed.seedCount : 0,
        expandedCount:
          typeof parsed.expandedCount === "number" ? parsed.expandedCount : 0,
        seeds: Array.isArray(parsed.seeds)
          ? parsed.seeds.filter((v): v is string => typeof v === "string")
          : [],
        expanded: clampGraphRecallExpandedEntries(parsed.expanded, 64),
        status:
          parsed.status === "completed" ||
          parsed.status === "skipped" ||
          parsed.status === "aborted"
            ? parsed.status
            : undefined,
        reason: typeof parsed.reason === "string" ? parsed.reason : undefined,
        shadowMode: parsed.shadowMode === true,
        queryIntent: parseMemoryIntentSnapshot(parsed.queryIntent),
        seedResults: parseGraphRecallRankedResults(parsed.seedResults),
        finalResults: parseGraphRecallRankedResults(parsed.finalResults),
        shadowComparison:
          parsed.shadowComparison && typeof parsed.shadowComparison === "object"
            ? {
                baselineCount:
                  typeof parsed.shadowComparison.baselineCount === "number"
                    ? parsed.shadowComparison.baselineCount
                    : 0,
                graphCount:
                  typeof parsed.shadowComparison.graphCount === "number"
                    ? parsed.shadowComparison.graphCount
                    : 0,
                overlapCount:
                  typeof parsed.shadowComparison.overlapCount === "number"
                    ? parsed.shadowComparison.overlapCount
                    : 0,
                overlapRatio:
                  typeof parsed.shadowComparison.overlapRatio === "number"
                    ? parsed.shadowComparison.overlapRatio
                    : 0,
                averageOverlapDelta:
                  typeof parsed.shadowComparison.averageOverlapDelta ===
                  "number"
                    ? parsed.shadowComparison.averageOverlapDelta
                    : 0,
              }
            : undefined,
      };
    } catch {
      return null;
    }
  }

  async getLastIntentSnapshot(
    namespace?: string,
  ): Promise<IntentDebugSnapshot | null> {
    const storage = await this.getStorage(namespace);
    const snapshotPath = path.join(storage.dir, "state", "last_intent.json");
    try {
      const raw = await readFile(snapshotPath, "utf-8");
      const parsed = JSON.parse(raw) as Partial<IntentDebugSnapshot>;
      if (!parsed || typeof parsed !== "object") return null;
      const graphDecision =
        parsed.graphDecision && typeof parsed.graphDecision === "object"
          ? parsed.graphDecision
          : undefined;
      return {
        recordedAt:
          typeof parsed.recordedAt === "string" ? parsed.recordedAt : "",
        promptHash:
          typeof parsed.promptHash === "string" ? parsed.promptHash : "",
        promptLength:
          typeof parsed.promptLength === "number" ? parsed.promptLength : 0,
        retrievalQueryHash:
          typeof parsed.retrievalQueryHash === "string"
            ? parsed.retrievalQueryHash
            : "",
        retrievalQueryLength:
          typeof parsed.retrievalQueryLength === "number"
            ? parsed.retrievalQueryLength
            : 0,
        plannerEnabled: parsed.plannerEnabled !== false,
        plannedMode:
          parsed.plannedMode === "no_recall" ||
          parsed.plannedMode === "minimal" ||
          parsed.plannedMode === "full" ||
          parsed.plannedMode === "graph_mode"
            ? parsed.plannedMode
            : "full",
        effectiveMode:
          parsed.effectiveMode === "no_recall" ||
          parsed.effectiveMode === "minimal" ||
          parsed.effectiveMode === "full" ||
          parsed.effectiveMode === "graph_mode"
            ? parsed.effectiveMode
            : "full",
        recallResultLimit:
          typeof parsed.recallResultLimit === "number"
            ? parsed.recallResultLimit
            : 0,
        queryIntent: parseMemoryIntentSnapshot(parsed.queryIntent),
        graphExpandedIntentDetected:
          parsed.graphExpandedIntentDetected === true,
        graphDecision: {
          status:
            graphDecision?.status === "skipped" ||
            graphDecision?.status === "completed" ||
            graphDecision?.status === "aborted"
              ? graphDecision.status
              : "not_requested",
          reason:
            typeof graphDecision?.reason === "string"
              ? graphDecision.reason
              : undefined,
          shadowMode: graphDecision?.shadowMode === true,
          qmdAvailable: graphDecision?.qmdAvailable !== false,
          graphRecallEnabled: graphDecision?.graphRecallEnabled !== false,
          multiGraphMemoryEnabled:
            graphDecision?.multiGraphMemoryEnabled !== false,
        },
      };
    } catch {
      return null;
    }
  }

  async getLastQmdRecallSnapshot(
    namespace?: string,
  ): Promise<QmdRecallSnapshot | null> {
    const storage = await this.getStorage(namespace);
    const snapshotPath = path.join(
      storage.dir,
      "state",
      "last_qmd_recall.json",
    );
    try {
      const raw = await readFile(snapshotPath, "utf-8");
      const parsed = JSON.parse(raw) as Partial<QmdRecallSnapshot>;
      if (!parsed || typeof parsed !== "object") return null;
      return {
        recordedAt:
          typeof parsed.recordedAt === "string" ? parsed.recordedAt : "",
        queryHash: typeof parsed.queryHash === "string" ? parsed.queryHash : "",
        queryLength:
          typeof parsed.queryLength === "number" ? parsed.queryLength : 0,
        collection:
          typeof parsed.collection === "string" ? parsed.collection : undefined,
        namespaces: Array.isArray(parsed.namespaces)
          ? parsed.namespaces.filter(
              (value): value is string => typeof value === "string",
            )
          : [],
        fetchLimit:
          typeof parsed.fetchLimit === "number" ? parsed.fetchLimit : 0,
        primaryResultCount:
          typeof parsed.primaryResultCount === "number"
            ? parsed.primaryResultCount
            : 0,
        hybridResultCount:
          typeof parsed.hybridResultCount === "number"
            ? parsed.hybridResultCount
            : 0,
        queryAwareSeedCount:
          typeof parsed.queryAwareSeedCount === "number"
            ? parsed.queryAwareSeedCount
            : 0,
        resultCount:
          typeof parsed.resultCount === "number" ? parsed.resultCount : 0,
        intentHint:
          typeof parsed.intentHint === "string" ? parsed.intentHint : undefined,
        explainEnabled: parsed.explainEnabled === true,
        hybridTopUpUsed: parsed.hybridTopUpUsed === true,
        hybridTopUpSkippedReason:
          typeof parsed.hybridTopUpSkippedReason === "string"
            ? parsed.hybridTopUpSkippedReason
            : undefined,
        results: parseQmdRecallResults(parsed.results),
      };
    } catch {
      return null;
    }
  }

  async explainLastGraphRecall(options?: {
    namespace?: string;
    maxExpanded?: number;
  }): Promise<string> {
    const snapshot = await this.getLastGraphRecallSnapshot(options?.namespace);
    if (!snapshot) return "No graph-recall snapshot found yet.";
    const maxExpanded = Math.max(1, Math.min(50, options?.maxExpanded ?? 10));
    const expanded = snapshot.expanded.slice(0, maxExpanded);
    const seedResults = (snapshot.seedResults ?? []).slice(0, maxExpanded);
    const finalResults = (snapshot.finalResults ?? []).slice(0, maxExpanded);
    const queryIntent = snapshot.queryIntent ?? {
      goal: "unknown",
      actionType: "unknown",
      entityTypes: [],
    };
    return [
      "## Last Graph Recall",
      "",
      `Recorded at: ${snapshot.recordedAt || "unknown"}`,
      `Mode: ${snapshot.mode}`,
      `Status: ${snapshot.status ?? "completed"}${snapshot.shadowMode ? " (shadow)" : ""}`,
      `Reason: ${snapshot.reason ?? "n/a"}`,
      `Query hash: ${snapshot.queryHash || "unknown"} (len=${snapshot.queryLength})`,
      `Query intent: goal=${queryIntent.goal}, action=${queryIntent.actionType}, entityTypes=${queryIntent.entityTypes.length > 0 ? queryIntent.entityTypes.join(", ") : "none"}`,
      `Namespaces: ${snapshot.namespaces.length > 0 ? snapshot.namespaces.join(", ") : "none"}`,
      `Seed results (${snapshot.seedResults?.length ?? 0}, showing ${seedResults.length}):`,
      ...seedResults.map(
        (entry) =>
          `- ${entry.path} (score=${entry.score.toFixed(3)}, sources=${entry.sourceLabels.join(",") || "baseline"})`,
      ),
      `Seed paths (${snapshot.seedCount}):`,
      ...snapshot.seeds.map((p) => `- ${p}`),
      `Expanded paths (${snapshot.expandedCount}, showing ${expanded.length}):`,
      ...expanded.map((e) => {
        // Issue #681 PR 3/3 — surface per-edge confidence in the
        // graph-explain document. Legacy snapshots without
        // `edgeConfidence` render as `conf=n/a` so older payloads
        // remain readable.
        const confLabel =
          typeof e.edgeConfidence === "number" && Number.isFinite(e.edgeConfidence)
            ? e.edgeConfidence.toFixed(2)
            : "n/a";
        return `- ${e.path} (score=${e.score.toFixed(3)}, ns=${e.namespace}, seed=${e.seed || "unknown"}, hop=${e.hopDepth}, w=${e.decayedWeight.toFixed(3)}, type=${e.graphType}, conf=${confLabel})`;
      }),
      `Final ranked results (${snapshot.finalResults?.length ?? 0}, showing ${finalResults.length}):`,
      ...finalResults.map(
        (entry) =>
          `- ${entry.path} (score=${entry.score.toFixed(3)}, sources=${entry.sourceLabels.join(",") || "baseline"})`,
      ),
      ...(snapshot.shadowComparison
        ? [
            `Shadow comparison: baseline=${snapshot.shadowComparison.baselineCount}, graph=${snapshot.shadowComparison.graphCount}, overlap=${snapshot.shadowComparison.overlapCount} (${snapshot.shadowComparison.overlapRatio.toFixed(2)}), avgDelta=${snapshot.shadowComparison.averageOverlapDelta.toFixed(3)}`,
          ]
        : []),
    ].join("\n");
  }

  async explainLastIntent(options?: { namespace?: string }): Promise<string> {
    const snapshot = await this.getLastIntentSnapshot(options?.namespace);
    if (!snapshot) return "No intent-debug snapshot found yet.";
    return [
      "## Last Intent Debug",
      "",
      `Recorded at: ${snapshot.recordedAt || "unknown"}`,
      `Prompt hash: ${snapshot.promptHash || "unknown"} (len=${snapshot.promptLength})`,
      `Retrieval query hash: ${snapshot.retrievalQueryHash || "unknown"} (len=${snapshot.retrievalQueryLength})`,
      `Planner enabled: ${snapshot.plannerEnabled ? "yes" : "no"}`,
      `Planned mode: ${snapshot.plannedMode}`,
      `Effective mode: ${snapshot.effectiveMode}`,
      `Recall result limit: ${snapshot.recallResultLimit}`,
      `Query intent: goal=${snapshot.queryIntent.goal}, action=${snapshot.queryIntent.actionType}, entityTypes=${snapshot.queryIntent.entityTypes.length > 0 ? snapshot.queryIntent.entityTypes.join(", ") : "none"}`,
      `Broad graph intent: ${snapshot.graphExpandedIntentDetected ? "yes" : "no"}`,
      `Graph decision: status=${snapshot.graphDecision.status}, reason=${snapshot.graphDecision.reason ?? "n/a"}, shadow=${snapshot.graphDecision.shadowMode ? "yes" : "no"}, qmdAvailable=${snapshot.graphDecision.qmdAvailable ? "yes" : "no"}, graphRecallEnabled=${snapshot.graphDecision.graphRecallEnabled ? "yes" : "no"}, multiGraphMemoryEnabled=${snapshot.graphDecision.multiGraphMemoryEnabled ? "yes" : "no"}`,
    ].join("\n");
  }

  async explainLastQmdRecall(options?: {
    namespace?: string;
    maxResults?: number;
  }): Promise<string> {
    const snapshot = await this.getLastQmdRecallSnapshot(options?.namespace);
    if (!snapshot) return "No QMD recall snapshot found yet.";
    const maxResults = Math.max(1, Math.min(25, options?.maxResults ?? 10));
    const shown = snapshot.results.slice(0, maxResults);
    return [
      "## Last QMD Recall",
      "",
      `Recorded at: ${snapshot.recordedAt || "unknown"}`,
      `Query hash: ${snapshot.queryHash || "unknown"} (len=${snapshot.queryLength})`,
      `Collection: ${snapshot.collection ?? "default"}`,
      `Namespaces: ${snapshot.namespaces.length > 0 ? snapshot.namespaces.join(", ") : "none"}`,
      `Fetch limit: ${snapshot.fetchLimit}`,
      `Primary results: ${snapshot.primaryResultCount}`,
      `Hybrid top-up results: ${snapshot.hybridResultCount}`,
      `Query-aware seeds: ${snapshot.queryAwareSeedCount}`,
      `Final results: ${snapshot.resultCount}`,
      `Intent hint: ${snapshot.intentHint ?? "none"}`,
      `Explain enabled: ${snapshot.explainEnabled ? "yes" : "no"}`,
      `Hybrid top-up used: ${snapshot.hybridTopUpUsed ? "yes" : "no"}`,
      `Hybrid top-up skipped reason: ${snapshot.hybridTopUpSkippedReason ?? "n/a"}`,
      `Top results (${shown.length}):`,
      ...shown.map((result) => {
        const explainParts = [
          typeof result.explain?.blendedScore === "number"
            ? `blended=${result.explain.blendedScore.toFixed(3)}`
            : null,
          typeof result.explain?.rerankScore === "number"
            ? `rerank=${result.explain.rerankScore.toFixed(3)}`
            : null,
          typeof result.explain?.rrf === "number"
            ? `rrf=${result.explain.rrf.toFixed(3)}`
            : null,
        ].filter((entry): entry is string => Boolean(entry));
        const explainText =
          explainParts.length > 0 ? `, explain=${explainParts.join("/")}` : "";
        return `- ${result.path} (score=${result.score.toFixed(3)}, transport=${result.transport ?? "unknown"}${explainText})`;
      }),
    ].join("\n");
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

  /**
   * Validate local LLM model availability and context window compatibility.
   * Warns the user if there's a mismatch.
   */
  private async validateLocalLlmModel(): Promise<void> {
    log.debug("Local LLM: validating model configuration");
    try {
      const modelInfo = await this.localLlm.getLoadedModelInfo();
      if (!modelInfo) {
        log.warn(
          "Local LLM validation: Could not query model info from server",
        );
        log.warn(
          "Local LLM validation: Could not query model info. " +
            "Ensure LM Studio/Ollama is running with the model loaded.",
        );
        return;
      }

      // Check for context window mismatch
      const configuredMaxContext = this.config.localLlmMaxContext;

      if (modelInfo.contextWindow) {
        log.debug(
          `Local LLM: ${modelInfo.id} loaded with ${modelInfo.contextWindow.toLocaleString()} token context window`,
        );

        if (
          configuredMaxContext &&
          configuredMaxContext > modelInfo.contextWindow
        ) {
          log.warn(
            `Local LLM context mismatch: engram configured for ${configuredMaxContext.toLocaleString()} tokens, ` +
              `but ${modelInfo.id} only supports ${modelInfo.contextWindow.toLocaleString()}. ` +
              `Reducing to ${modelInfo.contextWindow.toLocaleString()} to avoid errors.`,
          );
          // Update the config in-memory to match actual capability
          // (This is a temporary fix - user should update their config)
          (this.config as { localLlmMaxContext?: number }).localLlmMaxContext =
            modelInfo.contextWindow;
        }
      } else {
        log.debug(
          `Local LLM: ${modelInfo.id} loaded (context window not reported by server)`,
        );

        if (!configuredMaxContext) {
          log.warn(
            "Local LLM: Server did not report context window. " +
              "If you get 'context length exceeded' errors, set localLlmMaxContext in your config. " +
              "Common defaults: LM Studio (32K), Ollama (2K-128K depending on model).",
          );
        }
      }
    } catch (err) {
      log.warn(`Local LLM validation failed: ${err}`);
    }
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

  /**
   * Await the in-flight observation-mode direct-answer annotation chain.
   * Resolves to true when settled, false on timeout.
   */
  async waitForDirectAnswerObservationIdle(
    timeoutMs: number = 60_000,
  ): Promise<boolean> {
    let timeoutHandle: NodeJS.Timeout | null = null;
    try {
      const timeoutPromise = new Promise<"timeout">((resolve) => {
        timeoutHandle = setTimeout(() => resolve("timeout"), timeoutMs);
      });
      const result = await Promise.race([
        this.directAnswerObservationChain.then(() => "ok" as const),
        timeoutPromise,
      ]);
      if (result === "timeout") {
        log.warn(
          `waitForDirectAnswerObservationIdle timed out after ${timeoutMs}ms`,
        );
        return false;
      }
      return true;
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  }

  private enqueueDirectAnswerObservation(
    prompt: string,
    sessionKey: string,
    namespaceOverride: string | undefined,
    principalOverride: string | undefined,
    caps: CapabilitySet,
    namespacesEnabled: boolean,
  ): void {
    const expectedSnapshot = this.lastRecall.get(sessionKey);
    if (expectedSnapshot === null) return;
    if (expectedSnapshot.plannerMode === "no_recall") return;

    // Resolve the observation namespace set through the SAME ScopePlan resolver
    // the main recall path uses (#1521). The observe path does NOT throw on an
    // unreadable override (it falls through to the coding/legacy branches), so
    // we skip the readability gate the recall path enforces.
    const observationScopePlan = resolveScopePlan({
      config: this.config,
      sessionKey,
      namespace: namespaceOverride,
      principalOverride,
      codingContext: sessionKey
        ? this.getCodingContextForSession(sessionKey)
        : null,
      namespacesEnabled,
    });
    const observationNamespaces = observationScopePlan.readNamespaces;
    const observationQueryPolicy = buildRecallQueryPolicy(prompt, sessionKey, {
      cronRecallPolicyEnabled: resolveRecallAuxiliaryCapabilities(this.config).cronRecallPolicy,
      cronRecallNormalizedQueryMaxChars:
        this.config.cronRecallNormalizedQueryMaxChars,
      cronRecallInstructionHeavyTokenCap:
        this.effectiveCronRecallInstructionHeavyTokenCap(),
      cronConversationRecallMode: this.config.cronConversationRecallMode,
    });
    const observationQuery = observationQueryPolicy.retrievalQuery || prompt;
    const expectedIdentity = {
      writeNonce: expectedSnapshot.writeNonce,
      traceId: expectedSnapshot.traceId,
      recordedAt: expectedSnapshot.recordedAt,
    };
    const previous = this.directAnswerObservationChain;
    this.directAnswerObservationChain = previous
      .catch(() => undefined)
      .then(async () => {
        try {
          await this.annotateDirectAnswerTier(
            observationQuery,
            sessionKey,
            observationNamespaces,
            expectedIdentity,
            caps,
            undefined,
          );
        } catch (err) {
          log.debug(`direct-answer observation chain error: ${err}`);
        }
      });
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
    const tierStart = Date.now();
    try {
      if (namespaces.length === 0) return;

      const trustZoneByNsAndRecordId = new Map<
        string,
        "quarantine" | "working" | "trusted"
      >();
      const trustZoneKey = (ns: string, recordId: string) =>
        `${ns}\u0000${recordId}`;
      const scopedStorages = new Map<
        string,
        Awaited<ReturnType<typeof this.storageRouter.storageFor>>
      >();

      for (const ns of namespaces) {
        const storage = await this.storageRouter.storageFor(ns);
        scopedStorages.set(ns, storage);
        const trustZones = await listTrustZoneRecords({
          memoryDir: storage.dir,
          trustZoneStoreDir: this.config.trustZoneStoreDir,
          limit: 200,
        }).catch(() => ({
          allRecords: [] as Array<{
            recordId: string;
            zone: "quarantine" | "working" | "trusted";
          }>,
        }));
        for (const record of trustZones.allRecords ?? []) {
          trustZoneByNsAndRecordId.set(
            trustZoneKey(ns, record.recordId),
            record.zone,
          );
        }
      }

      const memoryNamespaceByPath = new Map<string, string>();
      const memoryNamespaceById = new Map<string, string>();
      let candidatesConsidered = 0;

      const sources: DirectAnswerSources = {
        taxonomy: DEFAULT_TAXONOMY,
        listCandidateMemories: async (options: { namespace: string; abortSignal?: AbortSignal }) => {
          const targetNs = options.namespace;
          const storage =
            scopedStorages.get(targetNs) ??
            (await this.storageRouter.storageFor(targetNs));
          const all = await storage.readAllMemories();
          const active: MemoryFile[] = [];
          for (const m of all) {
            if ((m.frontmatter.status ?? "active") === "active") {
              active.push(m);
              memoryNamespaceByPath.set(m.path, targetNs);
              if (m.frontmatter.id) {
                memoryNamespaceById.set(m.frontmatter.id, targetNs);
              }
            }
          }
          candidatesConsidered += active.length;
          return active;
        },
        trustZoneFor: async (memoryId: string) => {
          const ns = memoryNamespaceById.get(memoryId);
          if (!ns) return null;
          return (
            trustZoneByNsAndRecordId.get(
              trustZoneKey(ns, memoryId),
            ) ?? null
          );
        },
        importanceFor: (memory) =>
          typeof memory.frontmatter.importance?.score === "number"
            ? memory.frontmatter.importance.score
            : 0,
      };

      let result: import("./direct-answer.js").DirectAnswerResult | undefined;
      for (const ns of namespaces) {
        const r = await tryDirectAnswer({
          query: prompt,
          namespace: ns,
          config: this.config,
          enabled: caps.recallDirectAnswer,
          sources,
        });
        if (r.eligible && r.winner) {
          result = r;
          break;
        }
      }

      if (!result?.eligible || !result?.winner) return;

      const explain: RecallTierExplain = {
        tier: "direct-answer",
        tierReason: result.narrative,
        filteredBy: result.filteredBy,
        candidatesConsidered,
        latencyMs: Date.now() - tierStart,
        sourceAnchors: [{ path: result.winner.memory.path }],
      };

      await this.lastRecall.annotateTierExplain(
        sessionKey,
        explain,
        expectedIdentity,
      );
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return;
      log.debug(`direct-answer observation failed: ${err}`);
    }
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
    const storage = await this.storageRouter.storageFor(namespace);
    let fetchLimit = computeArtifactCandidateFetchLimit(targetCount);
    const maxFetchLimit = Math.min(800, Math.max(fetchLimit, targetCount * 8));
    const MAX_ATTEMPTS = 4;
    let bestFiltered: MemoryFile[] = [];

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const rawResults = await storage.searchArtifacts(prompt, fetchLimit);
      const sourceIds = Array.from(
        new Set(
          rawResults
            .map((a) => a.frontmatter.sourceMemoryId)
            .filter(
              (id): id is string => typeof id === "string" && id.length > 0,
            ),
        ),
      );
      const sourceStatus =
        sourceIds.length > 0
          ? await this.resolveArtifactSourceStatuses(storage, sourceIds)
          : new Map<string, "active" | "superseded" | "archived" | "missing">();

      const filtered: MemoryFile[] = [];
      for (const artifact of rawResults) {
        const sourceId = artifact.frontmatter.sourceMemoryId;
        if (!sourceId) {
          filtered.push(artifact);
          if (filtered.length >= targetCount) break;
          continue;
        }
        const status = sourceStatus.get(sourceId) ?? "missing";
        if (status !== "active") continue;
        filtered.push(artifact);
        if (filtered.length >= targetCount) break;
      }

      if (filtered.length >= targetCount) return filtered.slice(0, targetCount);
      if (filtered.length > bestFiltered.length) {
        bestFiltered = filtered;
      }
      if (rawResults.length === 0) return filtered;
      if (rawResults.length < fetchLimit && filtered.length > 0)
        return filtered;
      if (fetchLimit >= maxFetchLimit) return filtered;

      const growth = Math.max(targetCount * 2, 12);
      fetchLimit = Math.min(maxFetchLimit, fetchLimit + growth);
    }

    return bestFiltered;
  }

  private async recallArtifactsAcrossNamespaces(
    prompt: string,
    recallNamespaces: string[],
    targetCount: number,
  ): Promise<MemoryFile[]> {
    if (targetCount <= 0) return [];
    const namespaces = Array.from(new Set(recallNamespaces));
    const filteredByNamespace = await Promise.all(
      namespaces.map((namespace) =>
        this.fetchActiveArtifactsForNamespace(namespace, prompt, targetCount),
      ),
    );

    return mergeArtifactRecallCandidates(filteredByNamespace, targetCount);
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
    if (!resolveIndexingCapabilities(this.config).queryAwareIndexing || !prompt.trim()) {
      return {
        candidatePaths: null,
        temporalFromDate: null,
        matchedTags: [],
        expandedTags: [],
        combination: "none",
        filteredToFullSearch: false,
      };
    }

    const temporalFromDate = isTemporalQuery(prompt)
      ? recencyWindowFromPrompt(prompt, Date.now())
      : null;
    const [rawTemporal, tagSignals] = await Promise.all([
      temporalFromDate
        ? queryByDateRangeAsync(this.config.memoryDir, temporalFromDate)
        : Promise.resolve<Set<string> | null>(null),
      resolvePromptTagPrefilterAsync(this.config.memoryDir, prompt).catch(
        () => ({
          matchedTags: extractTagsFromPrompt(prompt),
          expandedTags: extractTagsFromPrompt(prompt),
          paths: null,
        }),
      ),
    ]);

    const temporalCandidates = this.scopeQueryAwarePaths(
      rawTemporal,
      recallNamespaces,
    );
    const tagCandidates = this.scopeQueryAwarePaths(
      tagSignals.paths,
      recallNamespaces,
    );
    const maxCandidates = this.config.queryAwareIndexingMaxCandidates;

    let candidatePaths: Set<string> | null = null;
    let combination: QueryAwarePrefilter["combination"] = "none";
    let filteredToFullSearch = false;

    if (
      tagSignals.matchedTags.length > 0 &&
      tagCandidates !== null &&
      tagCandidates.size === 0
    ) {
      candidatePaths = tagCandidates;
      combination = "tag";
    } else if (temporalCandidates !== null && tagCandidates !== null) {
      const intersection = new Set(
        Array.from(temporalCandidates).filter((memoryPath) =>
          tagCandidates.has(memoryPath),
        ),
      );
      if (intersection.size > 0) {
        candidatePaths = intersection;
        combination = "intersection";
      } else {
        candidatePaths = new Set([...temporalCandidates, ...tagCandidates]);
        combination = "union";
      }
    } else if (temporalCandidates !== null) {
      candidatePaths = temporalCandidates;
      combination = "temporal";
    } else if (tagCandidates !== null) {
      candidatePaths = tagCandidates;
      combination = "tag";
    }

    if (
      candidatePaths &&
      maxCandidates > 0 &&
      candidatePaths.size > maxCandidates
    ) {
      filteredToFullSearch = true;
      candidatePaths = null;
    }

    return {
      candidatePaths,
      temporalFromDate,
      matchedTags: tagSignals.matchedTags,
      expandedTags: tagSignals.expandedTags,
      combination,
      filteredToFullSearch,
    };
  }

  private async searchScopedMemoryCandidates(
    candidatePaths: Set<string>,
    query: string,
    limit: number,
    options?: {
      allowArchived?: boolean;
    },
  ): Promise<QmdSearchResult[]> {
    const cappedLimit = Math.max(0, limit);
    if (cappedLimit === 0 || candidatePaths.size === 0) return [];

    const tokens = Array.from(new Set(tokenizeRecallQuery(query)));
    const memories = (
      await Promise.all(
        Array.from(candidatePaths).map(async (memoryPath) => {
          const namespace = resolveNamespaceCapabilities(this.config).namespaces
            ? this.namespaceFromPath(memoryPath)
            : this.config.defaultNamespace;
          const storage = await this.storageRouter.storageFor(namespace);
          return await storage.readMemoryByPath(memoryPath);
        }),
      )
    ).filter((memory): memory is MemoryFile => memory !== null);

    const results: QmdSearchResult[] = [];
    for (const memory of memories) {
      const status = memory.frontmatter.status ?? "active";
      if (!options?.allowArchived && status !== "active") continue;

      const haystack = [
        memory.content,
        memory.frontmatter.category,
        ...(memory.frontmatter.tags ?? []),
      ]
        .join(" ")
        .toLowerCase();
      let hits = 0;
      for (const token of tokens) {
        if (haystack.includes(token)) hits += 1;
      }
      const score = tokens.length > 0 ? hits / tokens.length : 0.01;
      if (tokens.length > 0 && hits === 0) continue;

      results.push({
        docid: memory.frontmatter.id,
        path: memory.path,
        score,
        snippet: memory.content.slice(0, 400).replace(/\n/g, " "),
        transport: "scoped_prefilter",
      });
    }

    return results.sort((a, b) => b.score - a.score).slice(0, cappedLimit);
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
    throwIfRecallAborted(options.abortSignal);
    const queryAwarePrefilter =
      options.queryAwarePrefilter ??
      (await this.buildQueryAwarePrefilter(prompt, options.recallNamespaces));
    const scopedSeedResults = queryAwarePrefilter.candidatePaths?.size
      ? await this.searchScopedMemoryCandidates(
          queryAwarePrefilter.candidatePaths,
          prompt,
          qmdFetchLimit,
          { allowArchived: options.collection !== undefined },
        )
      : [];

    let fetchLimit = Math.max(qmdFetchLimit, qmdHybridFetchLimit);
    const maxFetchLimit = Math.min(
      320,
      Math.max(fetchLimit, qmdFetchLimit * 5),
    );
    const MAX_ATTEMPTS = 2;
    const qmdRecallBudgetMs = this.config.recallEnrichmentDeadlineMs ?? 25_000;
    const qmdRecallBudgetEnabled = qmdRecallBudgetMs > 0;
    const startedAtMs = Date.now();
    let lastPrimaryResultCount = 0;
    let lastHybridResultCount = 0;
    let lastHybridTopUpUsed = false;
    let lastHybridTopUpSkippedReason: string | undefined;
    const backendHonorsQmdSearchSignals =
      (this.config.searchBackend ?? "qmd") === "qmd";
    const resolvedSearchOptions = (() => {
      const resolver = (
        this.qmd as {
          resolveSupportedSearchOptions?: (
            options?: SearchQueryOptions,
          ) => SearchQueryOptions | undefined;
        }
      ).resolveSupportedSearchOptions;
      if (typeof resolver === "function") {
        return resolver.call(this.qmd, options.searchOptions);
      }
      return options.searchOptions;
    })();
    const primarySearchOptions = backendHonorsQmdSearchSignals
      ? resolvedSearchOptions
      : options.searchOptions;
    const debugSearchOptions = backendHonorsQmdSearchSignals
      ? resolvedSearchOptions
      : undefined;
    let bestFiltered = filterRecallCandidates(scopedSeedResults, {
      namespacesEnabled: options.namespacesEnabled,
      recallNamespaces: options.recallNamespaces,
      resolveNamespace: options.resolveNamespace,
      limit: qmdFetchLimit,
    });
    const emitDebugSnapshot = async (
      results: QmdSearchResult[],
      currentFetchLimit: number,
    ) => {
      if (!options.onDebugSnapshot) return;
      await options.onDebugSnapshot({
        recordedAt: new Date().toISOString(),
        queryHash: createHash("sha256").update(prompt).digest("hex"),
        queryLength: prompt.length,
        collection: options.collection,
        namespaces: options.recallNamespaces,
        fetchLimit: currentFetchLimit,
        primaryResultCount: lastPrimaryResultCount,
        hybridResultCount: lastHybridResultCount,
        queryAwareSeedCount: scopedSeedResults.length,
        resultCount: results.length,
        intentHint: debugSearchOptions?.intent,
        explainEnabled: debugSearchOptions?.explain === true,
        hybridTopUpUsed: lastHybridTopUpUsed,
        hybridTopUpSkippedReason: lastHybridTopUpSkippedReason,
        results: results.slice(0, 32).map((result) => ({
          ...result,
          snippet: result.snippet.slice(0, 280),
        })),
      });
    };
    if (queryAwarePrefilter.candidatePaths?.size === 0) {
      await emitDebugSnapshot([], fetchLimit);
      return [];
    }

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      throwIfRecallAborted(options.abortSignal);
      if (
        qmdRecallBudgetEnabled &&
        Date.now() - startedAtMs >= qmdRecallBudgetMs
      ) {
        break;
      }

      const primaryResults = options.collection
        ? options.abortSignal
          ? await this.qmd.search(
              prompt,
              options.collection,
              fetchLimit,
              primarySearchOptions,
              {
                signal: options.abortSignal,
                onDegradation: options.onDegradation,
              },
            )
          : await this.qmd.search(
              prompt,
              options.collection,
              fetchLimit,
              primarySearchOptions,
              { onDegradation: options.onDegradation },
            )
        : await this.searchAcrossNamespaces({
            query: prompt,
            namespaces: options.namespacesEnabled
              ? options.recallNamespaces
              : undefined,
            maxResults: fetchLimit,
            mode: "search",
            searchOptions: primarySearchOptions,
            execution: {
              signal: options.abortSignal,
              onDegradation: options.onDegradation,
            },
          });
      lastPrimaryResultCount = primaryResults.length;
      lastHybridResultCount = 0;
      lastHybridTopUpUsed = false;
      lastHybridTopUpSkippedReason = undefined;
      let mergedResults = primaryResults;

      // Backfill with hybrid results only when primary retrieval underfills.
      if (
        primaryResults.length < qmdFetchLimit &&
        (!qmdRecallBudgetEnabled ||
          Date.now() - startedAtMs < qmdRecallBudgetMs)
      ) {
        if (debugSearchOptions?.intent) {
          lastHybridTopUpSkippedReason = "intent_hint_active";
        } else if (this.config.qmdSearchStrategy === "lex") {
          // BM25-only strategy: a hybrid top-up runs vectorSearch (see
          // QmdClient.hybridSearch), which would reintroduce the vector path the
          // operator opted out of. Keep "lex" BM25-only end-to-end so the gate is
          // uniform across primary + top-up (gotcha #39). Issue #1335 (codex review #1422).
          lastHybridTopUpSkippedReason = "lex_strategy";
        } else {
          const hybridResults = options.collection
            ? await this.qmd.hybridSearch(
                prompt,
                options.collection,
                fetchLimit,
                {
                  signal: options.abortSignal,
                  onDegradation: options.onDegradation,
                },
              )
            : await this.searchAcrossNamespaces({
                query: prompt,
                namespaces: options.namespacesEnabled
                  ? options.recallNamespaces
                  : undefined,
                maxResults: fetchLimit,
                mode: "hybrid",
                execution: {
                  signal: options.abortSignal,
                  onDegradation: options.onDegradation,
                },
              });
          lastHybridResultCount = hybridResults.length;
          lastHybridTopUpUsed = hybridResults.length > 0;
          if (hybridResults.length > 0) {
            const mergedByPath = new Map<string, QmdSearchResult>();
            for (const result of [...primaryResults, ...hybridResults]) {
              const key = result.path || result.docid;
              const existing = mergedByPath.get(key);
              if (!existing || result.score > existing.score) {
                mergedByPath.set(key, {
                  ...result,
                  transport: result.transport ?? "hybrid",
                  snippet: result.snippet || existing?.snippet || "",
                });
              }
            }
            mergedResults = [...mergedByPath.values()]
              .sort((a, b) => b.score - a.score)
              .slice(0, fetchLimit);
          }
        }
      }

      if (scopedSeedResults.length > 0) {
        const mergedByPath = new Map<string, QmdSearchResult>();
        for (const result of [...scopedSeedResults, ...mergedResults]) {
          const key = result.path || result.docid;
          const existing = mergedByPath.get(key);
          if (!existing || result.score > existing.score) {
            mergedByPath.set(key, {
              ...result,
              snippet: result.snippet || existing?.snippet || "",
            });
          }
        }
        mergedResults = [...mergedByPath.values()]
          .sort((a, b) => b.score - a.score)
          .slice(0, fetchLimit);
      }

      const filteredResults = filterRecallCandidates(mergedResults, {
        namespacesEnabled: options.namespacesEnabled,
        recallNamespaces: options.recallNamespaces,
        resolveNamespace: options.resolveNamespace,
        limit: fetchLimit,
      });

      if (filteredResults.length >= qmdFetchLimit) {
        const capped = filteredResults.slice(0, qmdFetchLimit);
        await emitDebugSnapshot(capped, fetchLimit);
        return capped;
      }
      if (filteredResults.length > bestFiltered.length) {
        bestFiltered = filteredResults;
      }
      if (mergedResults.length === 0) {
        await emitDebugSnapshot(filteredResults, fetchLimit);
        return filteredResults;
      }
      if (mergedResults.length < fetchLimit && filteredResults.length > 0) {
        await emitDebugSnapshot(filteredResults, fetchLimit);
        return filteredResults;
      }
      if (fetchLimit >= maxFetchLimit) {
        break;
      }

      const growth = Math.max(20, Math.floor(fetchLimit / 2));
      fetchLimit = Math.min(maxFetchLimit, fetchLimit + growth);
    }

    const capped = bestFiltered.slice(0, qmdFetchLimit);
    await emitDebugSnapshot(capped, fetchLimit);
    return capped;
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
  // Issue #1526 (seam 14): graph-recall snapshot moved to
  // GraphRecallCoordinator. Thin delegation keeps the private API stable.
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
    return this.graphRecallCoordinator.recordLastGraphRecallSnapshot(options);
  }
  private async recordLastIntentSnapshot(options: {
    storage: StorageManager;
    snapshot: IntentDebugSnapshot;
  }): Promise<void> {
    try {
      const snapshotPath = path.join(
        options.storage.dir,
        "state",
        "last_intent.json",
      );
      await mkdir(path.dirname(snapshotPath), { recursive: true });
      await writeFile(
        snapshotPath,
        JSON.stringify(options.snapshot, null, 2),
        "utf-8",
      );
    } catch (err) {
      log.debug(`last intent write failed: ${err}`);
    }
  }

  private async recordLastQmdRecallSnapshot(options: {
    storage: StorageManager;
    snapshot: QmdRecallSnapshot;
  }): Promise<void> {
    try {
      const snapshotPath = path.join(
        options.storage.dir,
        "state",
        "last_qmd_recall.json",
      );
      await mkdir(path.dirname(snapshotPath), { recursive: true });
      await writeFile(
        snapshotPath,
        JSON.stringify(options.snapshot, null, 2),
        "utf-8",
      );
    } catch (err) {
      log.debug(`last qmd recall write failed: ${err}`);
    }
  }

  private async recordLastIntentSnapshotForNamespace(options: {
    namespace: string;
    snapshot: IntentDebugSnapshot;
  }): Promise<void> {
    try {
      const stateDir = await this.resolveStateDirForNamespace(
        options.namespace,
      );
      const snapshotPath = path.join(stateDir, "last_intent.json");
      await mkdir(path.dirname(snapshotPath), { recursive: true });
      await writeFile(
        snapshotPath,
        JSON.stringify(options.snapshot, null, 2),
        "utf-8",
      );
    } catch (err) {
      log.debug(`last intent write failed: ${err}`);
    }
  }

  private async resolveStateDirForNamespace(
    namespace: string,
  ): Promise<string> {
    if (!resolveNamespaceCapabilities(this.config).namespaces) {
      return path.join(this.config.memoryDir, "state");
    }
    if (namespace !== this.config.defaultNamespace) {
      return path.join(this.config.memoryDir, "namespaces", namespace, "state");
    }
    const candidate = path.join(
      this.config.memoryDir,
      "namespaces",
      this.config.defaultNamespace,
    );
    try {
      const candidateStat = await stat(candidate);
      if (candidateStat.isDirectory()) {
        return path.join(candidate, "state");
      }
    } catch {
      // Fall back to the legacy root when the migrated default namespace directory is absent.
    }
    return path.join(this.config.memoryDir, "state");
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
      // eslint-disable-next-line @typescript-eslint/no-this-alias
      const self = this;
      this._recallInternalCoordinator = new RecallInternalCoordinator({
        get _recallWorkspaceOverrides() { return self._recallWorkspaceOverrides; },
        appendRecallSection: (sectionBuckets, sectionId, content) => self.appendRecallSection(sectionBuckets, sectionId, content),
        applyColdFallbackPipeline: (options) => self.applyColdFallbackPipeline(options),
        applyTrustScoreToBranch: (results, namespaces, caps, label) => self.applyTrustScoreToBranch(results, namespaces, caps, label),
        assembleRecallSections: (sectionBuckets, budgetOverride) => self.assembleRecallSections(sectionBuckets, budgetOverride),
        boostSearchResults: (results, _recallNamespaces, prompt, preloadedMemoryMap, options) => self.boostSearchResults(results, _recallNamespaces, prompt, preloadedMemoryMap, options),
        boxBuilderFor: (storage) => self.boxBuilderFor(storage),
        buildCompressionGuidelineRecallSection: () => self.buildCompressionGuidelineRecallSection(),
        buildConfiguredQmdSearchOptions: (queryText) => self.buildConfiguredQmdSearchOptions(queryText),
        buildGraphRecallRankedResults: (results, sourceLabelResolver, limit) => self.buildGraphRecallRankedResults(results, sourceLabelResolver, limit),
        buildIdentityContinuitySection: (options) => self.buildIdentityContinuitySection(options),
        buildLastRecallBudgetSummary: (options) => self.buildLastRecallBudgetSummary(options),
        buildQueryAwarePrefilter: (prompt, recallNamespaces) => self.buildQueryAwarePrefilter(prompt, recallNamespaces),
        collectLastRecallSources: (sectionBuckets, recallSource) => self.collectLastRecallSources(sectionBuckets, recallSource),
        get compounding() { return self.compounding; },
        get config() { return self.config; },
        currentPolicyVersion: () => self.currentPolicyVersion(),
        diversifyAndLimitRecallResults: (sectionId, results, limit, retrievalQuery, caps) => self.diversifyAndLimitRecallResults(sectionId, results, limit, retrievalQuery, caps),
        effectiveCronRecallInstructionHeavyTokenCap: () => self.effectiveCronRecallInstructionHeavyTokenCap(),
        emitTrace: (event) => self.emitTrace(event),
        expandResultsViaGraph: (options) => self.expandResultsViaGraph(options),
        extractMemoryIdsFromResults: (results) => self.extractMemoryIdsFromResults(results),
        get fastLlmForRerank() { return self.fastLlmForRerank; },
        fetchQmdMemoryResultsWithArtifactTopUp: (prompt, qmdFetchLimit, qmdHybridFetchLimit, options) => self.fetchQmdMemoryResultsWithArtifactTopUp(prompt, qmdFetchLimit, qmdHybridFetchLimit, options),
        filterSearchResultsForRecall: (results, preloadedMemoryMap, options) => self.filterSearchResultsForRecall(results, preloadedMemoryMap, options),
        formatCausalTrajectoryResults: (results) => self.formatCausalTrajectoryResults(results),
        formatConversationRecallSection: (results, maxChars) => self.formatConversationRecallSection(results, maxChars),
        formatHarmonicRetrievalResults: (results) => self.formatHarmonicRetrievalResults(results),
        formatObjectiveStateResults: (results) => self.formatObjectiveStateResults(results),
        formatQmdResults: (title, results, sessionKey, trustByPath) => self.formatQmdResults(title, results, sessionKey, trustByPath),
        formatTrustZoneResults: (results) => self.formatTrustZoneResults(results),
        formatVerifiedEpisodeResults: (results) => self.formatVerifiedEpisodeResults(results),
        formatVerifiedSemanticRuleResults: (results) => self.formatVerifiedSemanticRuleResults(results),
        formatWorkProductResults: (results) => self.formatWorkProductResults(results),
        getCodingContextForSession: (sessionKey) => self.getCodingContextForSession(sessionKey),
        getPeerIdForSession: (sessionKey) => self.getPeerIdForSession(sessionKey),
        getRecallBudgetChars: (override) => self.getRecallBudgetChars(override),
        getRecallSectionEntry: (sectionId) => self.getRecallSectionEntry(sectionId),
        getRecallSectionMaxChars: (sectionId) => self.getRecallSectionMaxChars(sectionId),
        getRecallSectionNumber: (sectionId, key) => self.getRecallSectionNumber(sectionId, key),
        getStorage: (namespace) => self.getStorage(namespace),
        get handleHistory() { return self.handleHistory; },
        isRecallSectionEnabled: (sectionId, defaultEnabled) => self.isRecallSectionEnabled(sectionId, defaultEnabled),
        isSpecializedRecallSectionEnabled: (sectionId, topLevelEnabled) => self.isSpecializedRecallSectionEnabled(sectionId, topLevelEnabled),
        get lastQmdReprobeAtMs() { return self.lastQmdReprobeAtMs; },
        set lastQmdReprobeAtMs(value) { self.lastQmdReprobeAtMs = value; },
        get lastRecall() { return self.lastRecall; },
        get lastXraySnapshot() { return self.lastXraySnapshot; },
        set lastXraySnapshot(value) { self.lastXraySnapshot = value; },
        get lcmEngine() { return self.lcmEngine; },
        get namespaceCatalog() { return self.namespaceCatalog; },
        namespaceFromPath: (p) => self.namespaceFromPath(p),
        get profiler() { return self.profiler; },
        publishRecallResults: (options) => self.publishRecallResults(options),
        get qmd() { return self.qmd; },
        queueEvalShadowRecall: (record) => self.queueEvalShadowRecall(record),
        readAllMemoriesForNamespaces: (namespaces) => self.readAllMemoriesForNamespaces(namespaces),
        recallArtifactsAcrossNamespaces: (prompt, recallNamespaces, targetCount) => self.recallArtifactsAcrossNamespaces(prompt, recallNamespaces, targetCount),
        recallAssemblyClockMs: () => self.recallAssemblyClockMs(),
        recordLastGraphRecallSnapshot: (options) => self.recordLastGraphRecallSnapshot(options),
        recordLastIntentSnapshot: (options) => self.recordLastIntentSnapshot(options),
        recordLastIntentSnapshotForNamespace: (options) => self.recordLastIntentSnapshotForNamespace(options),
        recordLastQmdRecallSnapshot: (options) => self.recordLastQmdRecallSnapshot(options),
        get rerankCache() { return self.rerankCache; },
        searchConversationRecallResults: (retrievalQuery, topK) => self.searchConversationRecallResults(retrievalQuery, topK),
        searchEmbeddingFallback: (query, limit) => self.searchEmbeddingFallback(query, limit),
        get sharedContext() { return self.sharedContext; },
        get storage() { return self.storage; },
        get storageRouter() { return self.storageRouter; },
        get summarizer() { return self.summarizer; },
        get tmtBuilder() { return self.tmtBuilder; },
        get transcript() { return self.transcript; },
        truncateArtifactForRecall: (text, maxChars) => self.truncateArtifactForRecall(text, maxChars),
        truncateRecallSectionToBudget: (content, maxChars) => self.truncateRecallSectionToBudget(content, maxChars),
      });
    }
    return this._recallInternalCoordinator;
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
    if (role !== "user" && role !== "assistant") {
      log.debug(`processTurn: ignoring unsupported role=${String(role)}`);
      return;
    }
    if (shouldSkipImplicitExtraction(this.config)) {
      log.debug(
        "processTurn: skipping implicit extraction because captureMode=explicit",
      );
      return;
    }

    const bufferKey =
      typeof options.bufferKey === "string" && options.bufferKey.length > 0
        ? options.bufferKey
        : typeof sessionKey === "string" && sessionKey.length > 0
          ? sessionKey
          : "default";
    const captureTimestamp = new Date().toISOString();
    // Issue #1582 hygiene §2 — strip any echoed `[m:xxxx]` handle before the
    // turn enters the extraction buffer so handles never become memory content
    // or get QMD-indexed (rule 23). Gated on the feature flag: when handles are
    // off none are ever injected, so there is nothing to strip and the buffer
    // stays byte-identical to the pre-#1582 path.
    const bufferedContent = this.config.recallMemoryHandles
      ? stripHandles(content)
      : content;
    const turn: BufferTurn = {
      role,
      content: bufferedContent,
      timestamp: captureTimestamp,
      // #1578: anchor live-capture turns to wall-clock when bi-temporal is on;
      // replay/import turns carry sourceValidAt explicitly (codex P1).
      ...(this.config.temporalBiTemporal
        ? { sourceValidAt: captureTimestamp }
        : {}),
      sessionKey,
      logicalSessionKey: options.logicalSessionKey ?? bufferKey,
      providerThreadId: options.providerThreadId ?? null,
      turnFingerprint: options.turnFingerprint,
      persistProcessedFingerprint: options.persistProcessedFingerprint === true,
    };

    const outcome =
      typeof this.buffer.addTurnWithOutcome === "function"
        ? await this.buffer.addTurnWithOutcome(bufferKey, turn)
        : { decision: await this.buffer.addTurn(bufferKey, turn) };

    if (outcome.decision === "keep_buffering") return;
    await this.queueBufferedExtraction(
      outcome.extractionTurns ?? this.buffer.getTurns(bufferKey),
      "trigger_mode",
      { bufferKey },
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
    if (!Array.isArray(turns) || turns.length === 0) return;
    if (options.abortSignal?.aborted) {
      throw options.abortSignal.reason instanceof Error
        ? options.abortSignal.reason
        : new Error("ingestReplayBatch aborted");
    }
    if (shouldSkipImplicitExtraction(this.config)) {
      log.debug(
        "ingestReplayBatch: skipping implicit extraction because captureMode=explicit",
      );
      return;
    }

    const bySession = new Map<string, BufferTurn[]>();
    for (const turn of turns) {
      if (turn.role !== "user" && turn.role !== "assistant") continue;
      const key = normalizeReplaySessionKey(turn.sessionKey);
      const list = bySession.get(key) ?? [];
      list.push({
        role: turn.role,
        content: turn.content,
        timestamp: turn.timestamp,
        sourceValidAt: turn.sourceValidAt,
        sessionKey: key,
        parts: turn.parts,
        rawContent: turn.rawContent,
        sourceFormat: turn.sourceFormat,
      });
      bySession.set(key, list);
    }

    const replaySlices: Array<{
      bufferKey: string;
      order: number;
      targetValidAtMs: number;
      turns: BufferTurn[];
    }> = [];
    for (const [key, sessionTurns] of bySession.entries()) {
      if (sessionTurns.length === 0) continue;
      if (options.abortSignal?.aborted) {
        throw options.abortSignal.reason instanceof Error
          ? options.abortSignal.reason
          : new Error("ingestReplayBatch aborted");
      }
      if (options.archiveLcm !== false && this.lcmEngine?.enabled) {
        await this.lcmEngine.observeMessages(
          key,
          sessionTurns.map((turn) => ({
            role: turn.role,
            content: turn.content,
            parts: turn.parts,
            rawContent: turn.rawContent,
            sourceFormat: turn.sourceFormat,
          })),
        );
      }
      for (const sessionSlice of splitTurnsBySourceValidAt(sessionTurns)) {
        replaySlices.push({
          bufferKey: key,
          order: replaySlices.length,
          targetValidAtMs: targetSourceValidAtSortMs(sessionSlice),
          turns: sessionSlice,
        });
      }
    }

    const replayTasks = replaySlices
      .sort((a, b) => {
        if (a.targetValidAtMs < b.targetValidAtMs) return -1;
        if (a.targetValidAtMs > b.targetValidAtMs) return 1;
        if (a.order === b.order) return 0;
        return a.order < b.order ? -1 : 1;
      })
      .map(
        ({ bufferKey, turns: sessionSlice }) =>
          new Promise<void>((resolve, reject) => {
            void this.queueBufferedExtraction(sessionSlice, "trigger_mode", {
              skipDedupeCheck: true,
              clearBufferAfterExtraction: false,
              skipCharThreshold: true,
              skipUserTurnThreshold: true,
              bufferKey,
              extractionDeadlineMs: options.deadlineMs,
              abortSignal: options.abortSignal,
              writeNamespaceOverride: options.writeNamespaceOverride,
              principalOverride: options.principalOverride,
              onTaskSettled: (err) => (err ? reject(err) : resolve()),
            }).catch(reject);
          }),
      );
    if (replayTasks.length > 0) {
      const settled = await Promise.allSettled(replayTasks);
      const firstRejected = settled.find(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      );
      if (firstRejected) {
        throw firstRejected.reason;
      }
    }
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

  /**
   * Lazily-constructed wearables service (Limitless / Bee / Omi
   * transcript ingestion). All wearables surfaces — CLI, MCP tools,
   * HTTP routes — share this one instance so sync state, search, and
   * memory writes stay consistent. Writes are pinned to the same
   * deterministic namespace bulk-import uses.
   */
  getWearablesService(): WearablesService {
    if (!this.wearablesServiceInstance) {
      this.wearablesServiceInstance = new WearablesService({
        config: this.config.wearables,
        getStorage: async () =>
          await this.getStorageForNamespace(this.bulkImportWriteNamespace()),
        extract: (turns) => this.extraction.extract(turns),
        // Smart memoryMode runs candidates through the SAME extraction
        // judge (cache + defer counters included) the live extraction
        // pipeline uses, so wearable facts get identical LLM-as-judge
        // durability gating.
        judgeFacts: (candidates) =>
          judgeFactDurability(
            candidates,
            this.config,
            this.localLlm,
            new FallbackLlmClient(
              this.config.gatewayConfig,
              fallbackLlmRuntimeContextFromConfig(this.config),
            ),
            this.judgeVerdictCache,
            this.judgeDeferCounts,
          ),
        searchBackend: {
          search: async (query, maxResults) => {
            if (!this.qmd.isAvailable()) return null;
            try {
              const results = await this.qmd.search(query, undefined, maxResults);
              return results.map((result) => ({
                path: result.path,
                score: result.score,
                preview: result.snippet,
              }));
            } catch {
              // Backend hiccup → tell the service "unavailable" so it
              // runs its bounded scan fallback instead of returning a
              // silent empty result (CLAUDE.md rule 34).
              return null;
            }
          },
        },
        reindexSearch: async () => {
          await this.qmd.update();
        },
      });
    }
    return this.wearablesServiceInstance;
  }

  /**
   * Ingest a batch of bulk-import turns (#460). Like ingestReplayBatch, this
   * normalizes user/assistant turns into the extraction buffer and awaits
   * settlement, but it intentionally bypasses the captureMode="explicit"
   * gate because bulk-import is itself an explicit user action — the user
   * ran `bulk-import --source <name> --file ...` and would be surprised to
   * see the command silently no-op when capture is otherwise restricted.
   *
   * Turns with role="other" are skipped (not supported by the extraction
   * pipeline).
   *
   * Two design decisions worth calling out:
   *
   * - **sessionKey is truthy and per-batch-unique.**
   *   `ThreadingManager.shouldStartNewThread` only applies the session-key
   *   boundary check when `turn.sessionKey` is truthy (threading.ts:82);
   *   with an empty string, imported turns could attach to the current
   *   live thread or merge across unrelated import batches. A unique
   *   `bulk-import:batch:<timestamp>-<rand>` key forces a fresh thread per
   *   batch without matching common prefix/map rules in
   *   `principalFromSessionKeyRules`. (Catch-all regex rules could still
   *   remap the principal, but that only affects metadata provenance —
   *   see the next point for why write routing is unaffected.)
   *
   * - **writeNamespaceOverride pins the storage target.**
   *   We pass `writeNamespaceOverride: this.bulkImportWriteNamespace()` to
   *   `queueBufferedExtraction`, which tells `runExtraction` to skip
   *   `defaultNamespaceForPrincipal` and write directly into the
   *   orchestrator's declared bulk-import write namespace. This keeps
   *   writes deterministic even when namespace policies named `"default"`
   *   exist alongside a different `config.defaultNamespace`, and also
   *   guards against regex-catch-all principal rules steering bulk-import
   *   into an unexpected tenant.
   *
   * Per-invocation namespace routing (letting callers target a namespace
   * other than `bulkImportWriteNamespace()`) is a separate feature tracked
   * as a follow-up — the hook is the `writeNamespaceOverride` option, but
   * the CLI surface does not yet expose a `--namespace` flag.
   */
  async ingestBulkImportBatch(
    turns: ImportTurn[],
    options: {
      deadlineMs?: number;
      failOnExtractionFailure?: boolean;
      includeSourceValidAtContext?: boolean;
    } = {},
  ): Promise<BulkImportBatchIngestResult> {
    if (!Array.isArray(turns) || turns.length === 0) {
      return {
        attemptedTurnCount: 0,
        extractionCount: 0,
        persistedCount: 0,
        durableOutputCount: 0,
        skippedCount: 0,
        failedCount: 0,
        postPersistMetadataFailureCount: 0,
        processedTurnCount: 0,
      };
    }

    // Per-batch unique sessionKey keeps threading honest without matching
    // typical prefix/map routing rules.  Combined with writeNamespaceOverride
    // below, the storage target is independent of principal resolution.
    // Uses crypto.randomBytes (not Math.random) so CodeQL does not flag a
    // security-context insecure-randomness use even though this value never
    // leaves the process; the bytes just need to be collision-resistant
    // across concurrent bulk-import batches.
    const shouldUseStableBatchKey = turns.some(
      (turn) =>
        turn.persistProcessedFingerprint === true ||
        (typeof turn.turnFingerprint === "string" &&
          turn.turnFingerprint.length > 0),
    );
    const stableBatchFingerprint = shouldUseStableBatchKey
      ? createHash("sha256")
        .update(
          turns
            .map((turn) =>
              [
                turn.role,
                typeof turn.turnFingerprint === "string" &&
                turn.turnFingerprint.length > 0
                  ? turn.turnFingerprint
                  : turn.content.replace(/\s+/g, " ").trim(),
              ].join(":"),
            )
            .join("\n"),
        )
        .digest("hex")
        .slice(0, 32)
      : undefined;
    const sessionKey = stableBatchFingerprint
      ? `bulk-import:batch:${stableBatchFingerprint}`
      : `bulk-import:batch:${Date.now().toString(36)}-${randomBytes(6).toString("hex")}`;

    const sessionTurns: BufferTurn[] = [];
    for (const turn of turns) {
      if (turn.role !== "user" && turn.role !== "assistant") continue;
      sessionTurns.push({
        role: turn.role,
        content: turn.content,
        timestamp: turn.timestamp,
        sourceValidAt: turn.timestamp,
        sessionKey,
        parts: turn.parts,
        rawContent: turn.rawContent,
        sourceFormat: turn.sourceFormat,
        importProvenance: turn.importProvenance,
        turnFingerprint: turn.turnFingerprint,
        persistProcessedFingerprint: turn.persistProcessedFingerprint === true,
      });
    }
    if (sessionTurns.length === 0) {
      return {
        attemptedTurnCount: 0,
        extractionCount: 0,
        persistedCount: 0,
        durableOutputCount: 0,
        skippedCount: 0,
        failedCount: 0,
        postPersistMetadataFailureCount: 0,
        processedTurnCount: 0,
      };
    }

    if (this.lcmEngine?.enabled) {
      await this.lcmEngine.observeMessages(
        sessionKey,
        sessionTurns.map((turn) => ({
          role: turn.role,
          content: turn.content,
          parts: turn.parts,
          rawContent: turn.rawContent,
          sourceFormat: turn.sourceFormat,
        })),
      );
    }

    const sessionSlices = splitTurnsBySourceValidAt(sessionTurns, {
      includeContext: options.includeSourceValidAtContext !== false,
    });
    const results: ExtractionRunResult[] = [];
    let processedTurnCount = 0;
    let firstRejected: unknown;
    for (const sessionSlice of sessionSlices) {
      try {
        const result = await new Promise<ExtractionRunResult>(
          (resolve, reject) => {
            void this.queueBufferedExtraction(sessionSlice, "trigger_mode", {
              skipDedupeCheck: true,
              clearBufferAfterExtraction: false,
              skipCharThreshold: true,
              skipUserTurnThreshold: true,
              bufferKey: sessionKey,
              extractionDeadlineMs: options.deadlineMs,
              failOnExtractionFailure: options.failOnExtractionFailure === true,
              writeNamespaceOverride: this.bulkImportWriteNamespace(),
              onTaskSettled: (err, result) =>
                err
                  ? reject(err)
                  : resolve(
                      result ?? {
                        status: "skipped",
                        reason: "missing_extraction_result",
                        persistedCount: 0,
                        durableOutputCount: 0,
                      },
                    ),
            }).catch(reject);
          },
        );
        results.push(result);
        processedTurnCount += sessionSlice.filter(
          (turn) => turn.extractionContextOnly !== true,
        ).length;
      } catch (err) {
        firstRejected = err;
        break;
      }
    }
    const rejectedCount = firstRejected ? 1 : 0;
    const ingestResult: BulkImportBatchIngestResult = {
      attemptedTurnCount: sessionTurns.length,
      extractionCount: results.length,
      persistedCount: results.reduce(
        (sum, result) => sum + result.persistedCount,
        0,
      ),
      durableOutputCount: results.reduce(
        (sum, result) => sum + result.durableOutputCount,
        0,
      ),
      skippedCount: results.filter((result) => result.status === "skipped").length,
      failedCount: rejectedCount,
      postPersistMetadataFailureCount: results.filter(
        (result) => result.postPersistMetadataFailed === true,
      ).length,
      processedTurnCount:
        rejectedCount === 0 ? sessionTurns.length : processedTurnCount,
    };
    if (firstRejected) {
      if (processedTurnCount > 0) {
        throw new BulkImportBatchPartialFailureError(
          "bulk import failed after partial processing",
          ingestResult,
          firstRejected,
        );
      }
      throw firstRejected;
    }
    return ingestResult;
  }

  async observeSessionHeartbeat(
    sessionKey: string,
    options: { bufferKey?: string } = {},
  ): Promise<void> {
    if (resolvePipelineProcessingCapabilities(this.config).sessionObserver !== true) return;
    if (!sessionKey || sessionKey.length === 0) return;

    const bufferKey =
      typeof options.bufferKey === "string" && options.bufferKey.length > 0
        ? options.bufferKey
        : sessionKey;
    const previous =
      this.heartbeatObserverChains.get(sessionKey) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        const turns = this.buffer.getTurns(bufferKey);
        if (turns.length === 0) return;
        const normalizedSessionKey = normalizeReplaySessionKey(sessionKey);
        const allowSharedSessionBuffer = bufferKey.startsWith(
          CODEX_THREAD_KEY_PREFIX,
        );
        if (
          !allowSharedSessionBuffer &&
          turns.some(
            (turn) =>
              turn.sessionKey &&
              normalizeReplaySessionKey(turn.sessionKey) !== normalizedSessionKey,
          )
        ) {
          log.debug(
            `heartbeat observer skipped: mixed-session buffer contents for ${bufferKey}`,
          );
          return;
        }
        if (!this.shouldQueueExtraction(turns, {
          commit: false,
          bufferKey,
        })) {
          log.debug(
            `heartbeat observer skipped: extraction dedupe for ${bufferKey}`,
          );
          return;
        }
        const footprint =
          await this.transcript.estimateSessionFootprint(sessionKey);
        const decision = await this.sessionObserver.observe({
          sessionKey,
          totalBytes: footprint.bytes,
          totalTokens: footprint.tokens,
        });
        if (!decision.triggered) return;
        log.debug(
          `heartbeat observer trigger: session=${sessionKey} deltaBytes=${decision.deltaBytes} deltaTokens=${decision.deltaTokens}`,
        );
        await this.queueBufferedExtraction(turns, "heartbeat_observer", {
          bufferKey,
        });
      });

    this.heartbeatObserverChains.set(sessionKey, next);
    try {
      await next;
    } finally {
      if (this.heartbeatObserverChains.get(sessionKey) === next) {
        this.heartbeatObserverChains.delete(sessionKey);
      }
    }
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
    const bufferKey = options.bufferKey ?? turnsToExtract[0]?.sessionKey ?? "default";
    if (
      !options.skipDedupeCheck &&
      !this.shouldQueueExtraction(turnsToExtract, { bufferKey })
    ) {
      log.debug(`extraction dedupe skip: preserving buffer (${reason})`);
      options.onTaskSettled?.(undefined, {
        status: "skipped",
        reason: "dedupe",
        persistedCount: 0,
        durableOutputCount: 0,
      });
      return;
    }

    const extractionDeadlineMs =
      typeof options.extractionDeadlineMs === "number" &&
      Number.isFinite(options.extractionDeadlineMs)
        ? options.extractionDeadlineMs
        : undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const clearQueueWaitTimer = (): void => {
      if (timeout) {
        clearTimeout(timeout);
        timeout = undefined;
      }
    };
    const settleTask = (
      error?: unknown,
      result?: ExtractionRunResult,
    ): boolean => {
      if (settled) return false;
      settled = true;
      clearQueueWaitTimer();
      options.onTaskSettled?.(error, result);
      return true;
    };

    if (typeof extractionDeadlineMs === "number") {
      const remainingMs = extractionDeadlineMs - Date.now();
      if (remainingMs <= 0) {
        settleTask(new Error("replay extraction deadline exceeded (queue_wait)"));
        return;
      }
      timeout = setTimeout(() => {
        settleTask(new Error("replay extraction deadline exceeded (queue_wait)"));
      }, remainingMs);
    }

    this.extractionQueueCoordinator.enqueue(async () => {
      if (settled) return;
      if (
        typeof extractionDeadlineMs === "number" &&
        extractionDeadlineMs <= Date.now()
      ) {
        settleTask(new Error("replay extraction deadline exceeded (queue_wait)"));
        return;
      }
      clearQueueWaitTimer();
      try {
        const result = await this.runExtraction(turnsToExtract, {
          clearBufferAfterExtraction:
            options.clearBufferAfterExtraction ?? true,
          skipCharThreshold: options.skipCharThreshold ?? false,
          skipUserTurnThreshold: options.skipUserTurnThreshold ?? false,
          deadlineMs: extractionDeadlineMs,
          bufferKey,
          abortSignal: options.abortSignal,
          failOnExtractionFailure: options.failOnExtractionFailure === true,
          writeNamespaceOverride: options.writeNamespaceOverride,
          principalOverride: options.principalOverride,
        });
        settleTask(undefined, result);
      } catch (err) {
        if (settleTask(err)) {
          throw err;
        }
      }
    });

    log.debug(`queued extraction from ${reason}`);
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

  /**
   * Passive correction capture (issue #1581) — detects corrections expressed
   * passively in conversation turns and routes them to the Correction Contract
   * (#1580). Called from `runExtraction` after persistence completes.
   *
   * Thin wiring: delegates ALL correction logic to the detector + capture
   * modules + the CorrectionService. This method only checks gates, calls the
   * detector, and routes results. Fail-open: capture errors never block the
   * extraction return path.
   */
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
    const mode = this.config.correctionCaptureMode;
    if (mode === "off") return;
    if (!resolveRecallAuxiliaryCapabilities(this.config).correction) return;

    try {
      const corrections = detectPassiveCorrections(
        turns.map((t) => ({ role: t.role, content: t.content })),
      );
      if (corrections.length === 0) return;

      // Replay/import: force queue-only mode even if config says auto.
      const effectiveMode = opts.isLiveSession ? mode : "queue";
      const captureConfig: PassiveCaptureConfig = {
        mode: effectiveMode,
        confidenceFloor: this.config.correctionCaptureConfidenceFloor,
        autoApplyMaxAffected: this.config.correctionCaptureAutoApplyMaxAffected,
      };

      const service = this.passiveCorrectionService();
      const result = await capturePassiveCorrections(
        corrections,
        {
          correctionEnabled: resolveRecallAuxiliaryCapabilities(this.config).correction,
          isLiveSession: opts.isLiveSession,
          bufferKey: opts.bufferKey,
          sessionKey: opts.sessionKey,
          principal: opts.principal,
          namespace: opts.namespace,
        },
        captureConfig,
        {
          planCorrection: (req) => service.plan(req),
          applyCorrection: (planId, applyOpts) => service.apply(planId, applyOpts),
          storageDir: async (ns) => (await this.getStorage(ns)).dir,
          // Resolve `[m:xxxx]` handles to concrete memory ids via the single
          // shared helper (#1582). Returns null on miss/ambiguity so the
          // capture loop drops the handle and the planner falls back to text
          // search (review: "memory handles not resolved").
          resolveHandle: (ref, sessionKey) => {
            try {
              return this.resolveMemoryIdOrHandle(ref, sessionKey);
            } catch {
              return null;
            }
          },
        },
        this.passiveCorrectionDedup,
      );

      // Accumulate telemetry
      this.passiveCorrectionTelemetry.detected += result.telemetry.detected;
      this.passiveCorrectionTelemetry.queued += result.telemetry.queued;
      this.passiveCorrectionTelemetry.autoApplied += result.telemetry.autoApplied;
      for (const [reason, count] of Object.entries(result.telemetry.suppressedReasons)) {
        this.passiveCorrectionTelemetry.suppressedReasonCounts[reason] =
          (this.passiveCorrectionTelemetry.suppressedReasonCounts[reason] ?? 0) + count;
      }
    } catch (err) {
      // Fail-open: passive capture never blocks extraction.
      log.debug(
        `passive-correction: capture failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
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
    if (!resolveMemoryLifecycleCapabilities(this.config).embeddingFallback) return;
    if (!(await this.embeddingFallback.isAvailable())) return;
    const memory = await storage.getMemoryById(memoryId);
    if (!memory) return;
    await this.embeddingFallback.indexFile(
      memoryId,
      memory.content,
      memory.path,
    );
  }

  /**
   * Build a graph edge for a persisted memory (v8.2).
   * Shared helper used by both the chunked and non-chunked write paths to avoid duplication.
   * Fail-open: caller wraps in try/catch.
   */
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
    // Entity siblings: other memories sharing the same entityRef
    const entitySiblings: string[] = [];
    if (entityRef) {
      try {
        const allMems = allMemsForGraph ?? [];
        for (const m of allMems) {
          if (m.frontmatter.entityRef === entityRef) {
            const rel = path.relative(storage.dir, m.path);
            if (rel !== memoryRelPath) entitySiblings.push(rel);
          }
        }
      } catch {
        /* fail-open */
      }
    }
    // Recent thread memories for time graph
    const recentInThread: string[] = [];
    if (threadIdForEdge && threadEpisodeIdsForGraph?.length) {
      try {
        recentInThread.push(
          ...resolveRecentThreadMemoryPaths({
            threadEpisodeIds: threadEpisodeIdsForGraph,
            currentMemoryId: memoryId,
            allMemsForGraph,
            pathById: memoryPathById,
            storageDir: storage.dir,
            maxRecent: 3,
          }),
        );
      } catch {
        /* fail-open */
      }
    }
    if (
      recentInThread.length === 0 &&
      graphCaps.graphWriteSessionAdjacency &&
      fallbackCausalPredecessor &&
      fallbackCausalPredecessor !== memoryRelPath
    ) {
      recentInThread.push(fallbackCausalPredecessor);
    }
    const causalPredecessor =
      recentInThread[recentInThread.length - 1] ?? fallbackCausalPredecessor;
    await this.graphIndexFor(storage).onMemoryWritten({
      memoryPath: memoryRelPath,
      entityRef,
      content: factContent,
      created: new Date().toISOString(),
      threadId: threadIdForEdge,
      recentInThread,
      entitySiblings,
      causalPredecessor,
      graphCapsOverride: {
        entityGraph: graphCaps.entityGraph,
        timeGraph: graphCaps.timeGraph,
        causalGraph: graphCaps.causalGraph,
        multiGraphMemory: graphCaps.multiGraphMemory,
      },
    });
  }

  private graphIndexFor(storage: StorageManager): GraphIndex {
    const key = storage.dir;
    const existing = this.graphIndexes.get(key);
    if (existing) return existing;
    const created = new GraphIndex(key, this.config);
    this.graphIndexes.set(key, created);
    return created;
  }

  /**
   * Batch-update temporal and tag indexes after extraction (v8.1).
   * Reads each persisted memory's path + frontmatter and adds them to
   * state/index_time.json and state/index_tags.json.
   * Fail-open: any error is logged but does not abort extraction.
   */
  private async updateTemporalTagIndexes(
    storage: StorageManager,
    persistedIds: string[],
  ): Promise<void> {
    const caps = resolveCapabilities(this.config); // #1566 Cluster C
    // Build temporal/tag indexes whenever either consumer is enabled:
    // - queryAwareIndexingEnabled: uses indexes for query-aware prefiltering in recall
    // - parallelRetrievalEnabled: temporal agent reads index_time.json for date-range lookup
    // Enabling only parallelRetrievalEnabled without queryAwareIndexingEnabled would silently
    // produce an empty temporal index, leaving the temporal agent with no data to work from.
    if (
      !resolveIndexingCapabilities(this.config).queryAwareIndexing &&
      !caps.parallelRetrieval
    )
      return;
    // Check for missing indexes BEFORE the early-return so first-time enablement
    // can bootstrap the full corpus even when this extraction turn persisted nothing.
    const needsFullRebuild = !indexesExist(this.config.memoryDir);
    if (!needsFullRebuild && persistedIds.length === 0) return;
    try {
      // Read the corpus once to avoid N separate full-corpus scans.
      // On full rebuild with namespaces enabled, span all configured namespaces so
      // memories written to other namespaces before the index existed are also captured.
      const allMemories =
        needsFullRebuild && resolveNamespaceCapabilities(this.config).namespaces
          ? await this.readAllMemoriesForNamespaces(
              Array.from(
                new Set<string>([
                  this.config.defaultNamespace,
                  this.config.sharedNamespace,
                  ...this.config.namespacePolicies.map((p) => p.name),
                ]),
              ),
            )
          : await storage.readAllMemories();

      // Bootstrap: index only active (non-archived, non-superseded) memories.
      // Incremental: index only the newly persisted IDs.
      const pool = needsFullRebuild
        ? allMemories.filter((m) => isActiveMemoryStatus(m.frontmatter.status))
        : (() => {
            const idSet = new Set(persistedIds);
            return allMemories.filter((m) => idSet.has(m.frontmatter.id));
          })();

      const entries: Array<{
        path: string;
        createdAt: string;
        tags: string[];
      }> = [];
      for (const mem of pool) {
        if (mem.path && mem.frontmatter?.created) {
          entries.push({
            path: mem.path,
            createdAt: mem.frontmatter.created,
            tags: mem.frontmatter.tags ?? [],
          });
        }
      }
      if (needsFullRebuild) {
        // Always write empty indexes on full rebuild — even when the active pool
        // is empty (e.g. store contains only archived/superseded entries).
        // This marks bootstrap completion so indexesExist() returns true and
        // subsequent extractions skip the full-corpus scan.
        clearIndexes(this.config.memoryDir);
        if (entries.length > 0) {
          indexMemoriesBatch(this.config.memoryDir, entries);
        }
        log.info(
          `temporal-index: bootstrapped from ${entries.length} active memories`,
        );
      } else if (entries.length > 0) {
        indexMemoriesBatch(this.config.memoryDir, entries);
      }
    } catch (err) {
      log.debug(`temporal-index update failed (non-fatal): ${err}`);
    }
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
  /** Threshold (bytes) at which IDENTITY.md reflections get auto-consolidated */
  private static readonly IDENTITY_CONSOLIDATE_THRESHOLD = 8_000;

  private async autoConsolidateIdentity(): Promise<void> {
    // Fan out over the catalog-union namespace set (issue #1499 sweep): a dynamic
    // namespace that accumulated IDENTITY.md reflections must also be eligible for
    // auto-consolidation, otherwise its identity file grows unbounded and is never
    // consolidated. Falls back to the configured set on any catalog read failure.
    const namespaces = resolveNamespaceCapabilities(this.config).namespaces
      ? await this.maintenanceNamespaces()
      : [this.config.defaultNamespace];

    for (const namespace of namespaces) {
      const storage = await this.storageRouter.storageFor(namespace);
      const identityNamespace =
        resolveNamespaceCapabilities(this.config).namespaces &&
        namespace !== this.config.defaultNamespace
          ? namespace
          : undefined;
      const reflectionsContent =
        (await storage.readIdentityReflections()) ?? "";

      const existingIdentity = await storage.readIdentity(
        this.config.workspaceDir,
        identityNamespace,
      );
      const headerEnd =
        existingIdentity.indexOf("## Learned Patterns") !== -1
          ? existingIdentity.indexOf("## Learned Patterns")
          : existingIdentity.indexOf("## Reflection");
      const staticHeader =
        (headerEnd !== -1
          ? existingIdentity.slice(0, headerEnd)
          : existingIdentity
        ).trimEnd() || "# IDENTITY";
      const identityContent = `${staticHeader}\n\n${reflectionsContent.trim()}\n`;
      if (identityContent.length < Orchestrator.IDENTITY_CONSOLIDATE_THRESHOLD)
        continue;

      log.info(
        `IDENTITY(${namespace}) is ${identityContent.length} chars — auto-consolidating reflections`,
      );
      const result = await this.extraction.consolidateIdentity(
        identityContent,
        "## Reflection",
      );

      if (!result || result.learnedPatterns.length === 0) {
        log.warn(
          `identity consolidation produced no patterns for namespace=${namespace}`,
        );
        continue;
      }

      const patternsSection = [
        "## Learned Patterns (consolidated from reflections, " +
          new Date().toISOString().slice(0, 10) +
          ")",
        "",
        ...result.learnedPatterns.map((p) => `- ${p}`),
        "",
      ].join("\n");

      const newContent = staticHeader + "\n\n" + patternsSection + "\n";

      await storage.writeIdentity(
        this.config.workspaceDir,
        newContent,
        identityNamespace,
      );
      await storage.writeIdentityReflections("");
      // NRcCL (codex P2): record a per-namespace catalog write for THIS namespace
      // after the identity files are updated. This fan-out can mutate a dynamic
      // namespace via `writeIdentity`/`writeIdentityReflections`, but the
      // consolidation pass's only consolidated touch covers `this.storage` (the
      // default) and only fires when `memoryItemMutated` was set by OTHER work — so
      // a namespace whose sole mutation in the pass is identity consolidation would
      // otherwise keep a stale `lastWriteAt`, making `listNamespaces({ writtenSince })`
      // and catalog-recency consumers miss the write. Best-effort and
      // failure-tolerant (the storage chokepoint (#1522) swallows errors, never crashing the
      // consolidation; gotcha #13, rule #40). No double-count with the consolidated
      // touch above: that one is gated on `memoryItemMutated` (which identity
      // consolidation does not set), and `markWrite` is idempotent regardless.
      log.info(
        `IDENTITY(${namespace}) consolidated: ${identityContent.length} → ${newContent.length} chars, ${result.learnedPatterns.length} patterns`,
      );
    }
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

  /**
   * Issue #373 — nearest-neighbor lookup for the write-time semantic dedup
   * guard. Returns the top-K embedding hits against the currently indexed
   * memories, or an empty array when the embedding backend is unavailable.
   * Intentionally does NOT throw; `decideSemanticDedup` treats both "empty"
   * and "error" outcomes as fail-open (keep the candidate).
   *
   * PR #399 P1 fix: when namespaces are enabled the lookup must be scoped
   * to the SAME namespace as the fact being written. Otherwise a
   * high-similarity memory from another namespace can suppress a write in
   * the target namespace — cross-tenant data loss. Callers pass the target
   * storage so we can translate its root directory into the correct index
   * path prefix (and, for the legacy default-namespace layout at
   * `memoryDir` root, an exclusion list for `namespaces/*`).
   */
  async semanticDedupLookup(
    content: string,
    limit: number,
    targetStorage: StorageManager,
  ): Promise<SemanticDedupHit[]> {
    // Round 6 fix (Finding 3): backend-unavailable conditions must THROW so
    // that `decideSemanticDedup`'s catch block can return
    // reason="backend_unavailable".  Previously all error/unavailable paths
    // returned [] — causing decideSemanticDedup to always report
    // reason="no_candidates" even when the provider was actually down.
    //
    // Contract after this fix:
    //   • embeddingFallbackEnabled=false  → throw (feature not configured;
    //     caller treats this as backend_unavailable and fails open).
    //   • isAvailable() returns false     → throw (provider is reachable but
    //     reports itself unavailable; distinct from empty index).
    //   • search() throws                 → re-throw (network/provider error).
    //   • search() returns []             → return [] (empty index, not a
    //     backend failure; decideSemanticDedup reports no_candidates).
    if (!resolveMemoryLifecycleCapabilities(this.config).embeddingFallback) {
      throw new Error("semantic dedup: embedding backend not configured");
    }
    if (!(await this.embeddingFallback.isAvailable())) {
      log.debug("semantic dedup: embedding backend unavailable, skipping");
      throw new Error("semantic dedup: embedding backend unavailable");
    }
    // search() may throw — let it propagate so decideSemanticDedup catches it
    // and returns reason="backend_unavailable". Pass throwOnTimeout:true so
    // EmbeddingTimeoutError is re-thrown here (Round 10 fix, Ui1J+Ui1L: the
    // recall-path caller searchEmbeddingFallback does NOT pass this flag,
    // keeping its fail-open [] contract on timeout).
    const scope = this.semanticDedupScopeFor(targetStorage);
    const hits = await this.embeddingFallback.search(content, limit, { ...scope, throwOnTimeout: true });
    if (!Array.isArray(hits) || hits.length === 0) return [];
    return hits.map((hit) => ({
      id: hit.id,
      score: hit.score,
      path: hit.path,
    }));
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
    if (!resolveMemoryLifecycleCapabilities(this.config).embeddingFallback) return [];
    if (!(await this.embeddingFallback.isAvailable())) return [];
    const hits = await this.embeddingFallback.search(query, limit);
    if (hits.length === 0) return [];

    const results: QmdSearchResult[] = [];
    for (const hit of hits) {
      const fullPath = path.isAbsolute(hit.path)
        ? hit.path
        : path.join(this.config.memoryDir, hit.path);
      const memory = await this.storage.readMemoryByPath(fullPath);
      if (!memory) continue;
      results.push({
        docid: hit.id,
        path: fullPath,
        score: hit.score,
        snippet: memory.content.slice(0, 400).replace(/\n/g, " "),
      });
    }
    return results;
  }

  /**
   * Long-term fallback retrieval.
   * Searches archived memories only, and is invoked only when hot recall returns zero hits.
   */
  private async searchLongTermArchiveFallback(
    prompt: string,
    recallNamespaces: string[],
    limit: number,
    queryAwarePrefilter?: QueryAwarePrefilter,
    abortSignal?: AbortSignal,
  ): Promise<QmdSearchResult[]> {
    throwIfRecallAborted(abortSignal);
    const cappedLimit = Math.max(0, limit);
    if (cappedLimit === 0) return [];
    if (queryAwarePrefilter?.candidatePaths?.size === 0) return [];

    const scopedSeedResults = queryAwarePrefilter?.candidatePaths?.size
      ? await this.searchScopedMemoryCandidates(
          queryAwarePrefilter.candidatePaths,
          prompt,
          cappedLimit,
          { allowArchived: true },
        )
      : [];
    if (scopedSeedResults.length >= cappedLimit) {
      return scopedSeedResults
        .filter((result) => !isArtifactMemoryPath(result.path))
        .slice(0, cappedLimit);
    }

    const tokens = Array.from(new Set(tokenizeRecallQuery(prompt)));
    if (tokens.length === 0) return scopedSeedResults;

    throwIfRecallAborted(abortSignal);
    const archivedMemories =
      await this.readArchivedMemoriesForNamespaces(recallNamespaces);
    if (archivedMemories.length === 0) return scopedSeedResults;

    // Issue #1674: off-load the CPU-bound archive-scoring loop to a
    // worker_threads pool so concurrent recall requests run on separate
    // cores instead of serializing on the main JS thread. The pure scoring
    // function is identical to the old inline loop — only the execution
    // context changed. Aborts are checked at the boundaries (before submit
    // and after result); the worker's work is bounded by the file count.
    throwIfRecallAborted(abortSignal);
    const scoring = getDefaultArchiveScoring();
    const scoredResults = await scoring.score(archivedMemories.map(memoryFileToScoreItem), tokens, abortSignal);
    throwIfRecallAborted(abortSignal);
    const scored: QmdSearchResult[] = scoredResults.map((r) => ({
      docid: r.docid,
      path: r.path,
      score: r.score,
      snippet: r.snippet,
    }));

    const mergedByPath = new Map<string, QmdSearchResult>();
    for (const result of [...scopedSeedResults, ...scored]) {
      const key = result.path || result.docid;
      const existing = mergedByPath.get(key);
      if (!existing || result.score > existing.score) {
        mergedByPath.set(key, {
          ...result,
          snippet: result.snippet || existing?.snippet || "",
        });
      }
    }

    return [...mergedByPath.values()]
      .filter((result) => !isArtifactMemoryPath(result.path))
      .sort((a, b) => b.score - a.score)
      .slice(0, cappedLimit);
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
    // Prefer the threaded set; fall back to a config-derived set so direct
    // callers (unit tests) behave identically to the recall pipeline (#1523).
    const caps = options.caps ?? resolveCapabilities(this.config);
    const graphCaps = options.graphCaps ?? resolveGraphConstructionCapabilities(this.config);
    if (options.queryAwarePrefilter?.candidatePaths?.size === 0) {
      if (options.xrayPoolSizeSink) options.xrayPoolSizeSink.size = 0;
      return [];
    }
    const deadlineRemainingMs = (): number | null =>
      typeof options.deadlineAtMs === "number"
        ? Math.max(0, options.deadlineAtMs - Date.now())
        : null;
    const runColdStepWithinDeadline = async <T>(
      label: string,
      fallback: T,
      task: () => Promise<T>,
      // Invoked when the deadline abandons this step (before it started or
      // while it runs), so callers can report the abandonment and gate off
      // late observer callbacks (#1536, cursor round-6 on #1544).
      onDeadline?: () => void,
    ): Promise<T> => {
      throwIfRecallAborted(options.abortSignal);
      const remainingMs = deadlineRemainingMs();
      if (remainingMs === 0) {
        try {
          onDeadline?.();
        } catch {
          // Observers must never break recall.
        }
        log.debug(`cold-tier recall ${label} skipped: shared assembly deadline expired`);
        return fallback;
      }
      if (remainingMs === null) return task();

      let timeoutHandle: NodeJS.Timeout | undefined;
      let timedOut = false;
      const taskPromise = task().catch((err) => {
        if (timedOut) {
          log.debug(`cold-tier recall ${label} failed after deadline: ${err}`);
          return fallback;
        }
        throw err;
      });

      try {
        return await Promise.race<T>([
          taskPromise,
          new Promise<T>((resolve) => {
            timeoutHandle = setTimeout(() => {
              timedOut = true;
              try {
                onDeadline?.();
              } catch {
                // Observers must never break recall.
              }
              log.debug(
                `cold-tier recall ${label} skipped: shared assembly deadline expired`,
              );
              resolve(fallback);
            }, remainingMs);
          }),
        ]);
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
      }
    };

    const coldQmdEnabled = resolveQmdCapabilities(this.config).qmdColdTier === true;
    const coldCollection =
      this.config.qmdColdCollection ?? "openclaw-engram-cold";
    const coldMaxResults =
      this.config.qmdColdMaxResults ?? this.config.qmdMaxResults;

    let longTerm: QmdSearchResult[] = [];
    if (coldQmdEnabled && this.qmd.isAvailable()) {
      const coldFetchLimit = Math.max(
        0,
        Math.min(options.recallResultLimit, Math.max(0, coldMaxResults)),
      );
      if (coldFetchLimit > 0) {
        const coldHybridLimit = computeQmdHybridFetchLimit(
          coldFetchLimit,
          false,
          0,
        );
        // Deadline-gated observer (#1536, cursor round-6 on #1544): when the
        // shared assembly deadline abandons this lookup, the still-running
        // fetch's LATE reports must not land after the recall snapshot has
        // been recorded — gate them off and report the abandonment itself
        // deterministically at resolution time instead.
        let coldQmdObserverActive = true;
        const reportColdQmdDeadline = () => {
          coldQmdObserverActive = false;
          try {
            options.onDegradation?.({
              backend: "qmd",
              code: "deadline_exceeded",
              detail: "cold-tier qmd lookup abandoned (assembly deadline)",
            });
          } catch {
            // Observers must never break recall.
          }
        };
        longTerm = await runColdStepWithinDeadline(
          "qmd lookup",
          [],
          () =>
            this.fetchQmdMemoryResultsWithArtifactTopUp(
              options.prompt,
              coldFetchLimit,
              coldHybridLimit,
              {
                namespacesEnabled: resolveNamespaceCapabilities(this.config).namespaces,
                recallNamespaces: options.recallNamespaces,
                resolveNamespace: (p) => this.namespaceFromPath(p),
                collection: coldCollection,
                queryAwarePrefilter: options.queryAwarePrefilter,
                searchOptions: this.buildConfiguredQmdSearchOptions(options.prompt),
                abortSignal: options.abortSignal,
                onDegradation: (degradation) => {
                  if (coldQmdObserverActive) {
                    options.onDegradation?.(degradation);
                  }
                },
              },
            ),
          reportColdQmdDeadline,
        );
        // Normal completion also closes the gate: a deadline that fires
        // after this await has nothing left to suppress, and a fetch that
        // limps home later cannot mutate a recorded recall's collector.
        coldQmdObserverActive = false;
        if (longTerm.length > 0) {
          log.debug(
            `cold-tier recall source=cold-qmd collection=${coldCollection} hits=${longTerm.length}`,
          );
        }
      }
    }
    if (longTerm.length === 0) {
      // Deadline-aware abort: terminate the scoring worker when the shared
      // assembly deadline wins, not just when the caller aborts (#1674).
      const da = new AbortController();
      if (options.abortSignal?.aborted) da.abort();
      else options.abortSignal?.addEventListener("abort", () => da.abort(), { once: true });
      longTerm = await runColdStepWithinDeadline(
        "archive scan", [],
        () => this.searchLongTermArchiveFallback(
          options.prompt, options.recallNamespaces, options.recallResultLimit,
          options.queryAwarePrefilter, da.signal),
        () => da.abort(),
      );
      if (longTerm.length > 0) {
        log.debug("cold-tier recall source=archive-scan");
      }
    }
    if (longTerm.length === 0) return [];

    let results = longTerm;
    if (resolveNamespaceCapabilities(this.config).namespaces) {
      const recallRoots: string[] = [];
      const seenRecallRoots = new Set<string>();
      for (const namespace of options.recallNamespaces) {
        try {
          const storage = await this.storageRouter.storageFor(namespace);
          const storageDir =
            typeof (storage as { dir?: unknown }).dir === "string" &&
            (storage as { dir?: string }).dir
              ? (storage as { dir: string }).dir
              : null;
          if (!storageDir) continue;
          const recallRoot = path.resolve(storageDir);
          if (seenRecallRoots.has(recallRoot)) continue;
          seenRecallRoots.add(recallRoot);
          recallRoots.push(recallRoot);
        } catch (err) {
          log.debug("cold-tier recall namespace root lookup skipped", {
            namespace,
            error: (err as Error).message,
          });
        }
      }
      const scopedResults: QmdSearchResult[] = [];
      for (const result of results) {
        if (options.abortSignal?.aborted || deadlineRemainingMs() === 0) break;
        const parts = qmdCollectionPathParts(result.path);
        if (parts?.collection === coldCollection) {
          const resolvedCold = await this.resolveColdQmdResultForRecall(
            result,
            this.storage,
            options.recallNamespaces,
          );
          if (resolvedCold) scopedResults.push(resolvedCold.result);
          continue;
        }
        if (path.isAbsolute(result.path)) {
          const resolvedPath = path.resolve(result.path);
          if (
            recallRoots.some((recallRoot) =>
              isPathInsideStorageRoot(recallRoot, resolvedPath),
            )
          ) {
            scopedResults.push(result);
          }
          continue;
        }
        if (options.recallNamespaces.includes(this.namespaceFromPath(result.path))) {
          scopedResults.push(result);
        }
      }
      results = scopedResults;
    }
    // Artifact isolation contract: generic recall paths must exclude artifacts.
    results = results.filter((r) => !isArtifactMemoryPath(r.path));
    if (results.length === 0) return [];

    const isFullModeGraphAssist =
      resolveQmdCapabilities(this.config).qmdTierParityGraph &&
      graphCaps.multiGraphMemory &&
      caps.graphAssistInFullMode &&
      options.recallMode === "full" &&
      results.length >= Math.max(1, this.config.graphAssistMinSeedResults ?? 3);
    const shouldRunGraphExpansion =
      resolveQmdCapabilities(this.config).qmdTierParityGraph &&
      (options.recallMode === "graph_mode" || isFullModeGraphAssist);

    if (shouldRunGraphExpansion) {
      const { merged } = await this.expandResultsViaGraph({
        memoryResults: results,
        recallNamespaces: options.recallNamespaces,
        recallResultLimit: options.recallResultLimit,
        deadlineAtMs: options.deadlineAtMs,
        ...(options.includeLowConfidence === true ? { includeLowConfidence: true } : {}),
      });
      results = merged;
    }

    const boostInput = await this.filterSearchResultsForRecall(
      results,
      undefined,
      {
        allowLifecycleFiltered: true,
        asOfMs: options.asOfMs,
        deadlineAtMs: options.deadlineAtMs,
        abortSignal: options.abortSignal,
        dropUnresolved: true,
        recallNamespaces: options.recallNamespaces,
      },
    );
    results = boostInput.results;
    const boostTimeoutMs =
      typeof options.deadlineAtMs === "number"
        ? Math.max(0, options.deadlineAtMs - Date.now())
        : null;
    if (boostTimeoutMs !== 0) {
      let timeoutHandle: NodeJS.Timeout | undefined;
      try {
        const boosted = await (boostTimeoutMs !== null
          ? Promise.race<QmdSearchResult[] | { status: "timed_out" }>([
              this.boostSearchResults(
                boostInput.results,
                options.recallNamespaces,
                options.prompt,
                boostInput.memoryByPath,
                { allowLifecycleFiltered: true, asOfMs: options.asOfMs },
              ),
              new Promise<{ status: "timed_out" }>((resolve) => {
                timeoutHandle = setTimeout(
                  () => resolve({ status: "timed_out" }),
                  boostTimeoutMs,
                );
              }),
            ])
          : this.boostSearchResults(
              boostInput.results,
              options.recallNamespaces,
              options.prompt,
              boostInput.memoryByPath,
              { allowLifecycleFiltered: true, asOfMs: options.asOfMs },
            ));
        if (
          typeof boosted === "object" &&
          boosted !== null &&
          "status" in boosted &&
          boosted.status === "timed_out"
        ) {
          log.debug("cold-tier recall boost skipped: shared assembly deadline expired");
        } else if (Array.isArray(boosted)) {
          results = boosted;
        } else {
          results = boostInput.results;
        }
      } catch (err) {
        log.debug(`cold-tier recall boost failed open: ${err}`);
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
      }
    } else {
      log.debug("cold-tier recall boost skipped: shared assembly deadline already expired");
    }

    if (caps.rerank && this.config.rerankProvider === "local") {
      const ranked = await rerankLocalOrNoop({
        query: options.prompt,
        candidates: results
          .slice(0, this.config.rerankMaxCandidates)
          .map((r) => ({
            id: r.path,
            snippet: r.snippet || r.path,
          })),
        local: this.fastLlmForRerank,
        enabled: true,
        timeoutMs: this.config.rerankTimeoutMs,
        maxCandidates: this.config.rerankMaxCandidates,
        cache: this.rerankCache,
        cacheEnabled: caps.rerankCache,
        cacheTtlMs: this.config.rerankCacheTtlMs,
      });
      if (ranked && ranked.length > 0) {
        const byPath = new Map(results.map((r) => [r.path, r]));
        const reordered: QmdSearchResult[] = [];
        for (const p of ranked) {
          const it = byPath.get(p);
          if (it) reordered.push(it);
        }
        const rankedSet = new Set(ranked);
        for (const r of results) {
          if (!rankedSet.has(r.path)) reordered.push(r);
        }
        results = reordered;
      }
    }
    if (caps.rerank && this.config.rerankProvider === "cloud") {
      log.debug(
        "rerankProvider=cloud is reserved/experimental in v2.2.0; skipping rerank",
      );
    }

    // Trust-reweighting — must fire on the cold fallback path too, or the
    // feature flag produces divergent behavior by retrieval path (rule 39).
    // TrustScore subsumes the Memory Worth multiplier; run exactly one.
    // Fail-open on lookup errors.
    if (caps.recallTrustScore && results.length > 0) {
      try {
        const trustOutcome = await this.applyTrustScoreRerank(results, options.recallNamespaces);
        results = trustOutcome.results;
        if (options.trustByPathSink) options.trustByPathSink.trustByPath = trustOutcome.trustByPath;
      } catch (err) {
        log.debug("trust-score stage (cold) failed open", {
          error: (err as Error).message,
        });
      }
    } else if (caps.recallMemoryWorthFilter && results.length > 0) {
      try {
        results = await this.applyMemoryWorthRerank(results, options.recallNamespaces);
      } catch (err) {
        log.debug("memory-worth filter (cold) failed open", {
          error: (err as Error).message,
        });
      }
    }

    // Apply MMR before final truncation so the cold fallback path mirrors
    // the diversification policy applied in the hot QMD/embedding/recent
    // paths. Running MMR post-slice would be unable to promote diverse
    // candidates sitting just below the cutoff.
    if (options.xrayPoolSizeSink) {
      options.xrayPoolSizeSink.size = Math.max(
        options.xrayPoolSizeSink.size,
        results.length,
      );
    }
    return this.diversifyAndLimitRecallResults(
      "memories",
      results,
      options.recallResultLimit,
      options.prompt,
      caps,
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

  /**
   * Flush access tracking buffer to disk.
   * Called during consolidation or when buffer is full.
   */
  async flushAccessTracking(): Promise<void> {
    if (this.accessTrackingBuffer.size === 0) return;

    // Build entries from buffer, merging with existing counts
    const entries: AccessTrackingEntry[] = [];
    const namespaces = resolveNamespaceCapabilities(this.config).namespaces
      ? Array.from(
          new Set<string>([
            this.config.defaultNamespace,
            this.config.sharedNamespace,
            ...this.config.namespacePolicies.map((p) => p.name),
          ]),
        )
      : [this.config.defaultNamespace];
    const memories = await this.readAllMemoriesForNamespaces(namespaces);
    const memoryMap = new Map(memories.map((m) => [m.frontmatter.id, m]));

    for (const [memoryId, update] of this.accessTrackingBuffer) {
      const memory = memoryMap.get(memoryId);
      const existingCount = memory?.frontmatter.accessCount ?? 0;
      entries.push({
        memoryId,
        newCount: existingCount + update.count,
        lastAccessed: update.lastAccessed,
      });
    }

    const byNamespace = new Map<string, AccessTrackingEntry[]>();
    for (const e of entries) {
      const m = memoryMap.get(e.memoryId);
      if (!m) continue;
      const ns = this.namespaceFromPath(m.path);
      const list = byNamespace.get(ns) ?? [];
      list.push(e);
      byNamespace.set(ns, list);
    }
    for (const [ns, list] of byNamespace) {
      const sm = await this.storageRouter.storageFor(ns);
      await sm.flushAccessTracking(list);
    }
    this.accessTrackingBuffer.clear();
    log.debug(`flushed ${entries.length} access tracking entries`);
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
    const memoryByPath: Map<string, MemoryFile> = preloadedMemoryMap
      ? new Map(preloadedMemoryMap)
      : new Map();
    const checkedPaths = new Set<string>();
    const unreadablePaths = new Set<string>();

    const markChecked = (result: QmdSearchResult): void => {
      if (result.path) checkedPaths.add(result.path);
    };
    const markUnreadable = (result: QmdSearchResult, err: unknown): void => {
      if (!result.path) return;
      checkedPaths.add(result.path);
      unreadablePaths.add(result.path);
      log.warn("recall safety filter dropped unreadable secure-store candidate", {
        path: result.path,
        error: (err as Error).message,
      });
    };
    const deadlineExpired = (): boolean =>
      typeof options?.deadlineAtMs === "number" &&
      Date.now() >= options.deadlineAtMs;

    if (options?.deadlineAtMs == null) {
      const batchSize = options?.abortSignal ? 16 : results.length;
      for (let offset = 0; offset < results.length; offset += batchSize) {
        if (options?.abortSignal?.aborted) {
          return {
            memoryByPath,
            checkedPaths,
            unreadablePaths,
            completed: false,
          };
        }
        await Promise.all(
          results.slice(offset, offset + batchSize).map(async (r) => {
            if (!r.path) return;
            if (memoryByPath.has(r.path)) {
              markChecked(r);
              return;
            }
            try {
              const mem = await this.readQmdResultMemory(
                r.path,
                this.storage,
                options?.recallNamespaces,
              );
              markChecked(r);
              if (mem) memoryByPath.set(r.path, mem);
            } catch (err) {
              if (err instanceof SecureStoreLockedError) {
                markUnreadable(r, err);
                return;
              }
              throw err;
            }
          }),
        );
      }

      return { memoryByPath, checkedPaths, unreadablePaths, completed: true };
    }

    for (const result of results) {
      if (!result.path) continue;
      if (memoryByPath.has(result.path)) {
        markChecked(result);
        continue;
      }
      if (options?.abortSignal?.aborted || deadlineExpired()) {
        return { memoryByPath, checkedPaths, unreadablePaths, completed: false };
      }
      try {
        const mem = await this.readQmdResultMemory(
          result.path,
          this.storage,
          options?.recallNamespaces,
        );
        markChecked(result);
        if (mem) memoryByPath.set(result.path, mem);
      } catch (err) {
        if (err instanceof SecureStoreLockedError) {
          markUnreadable(result, err);
          continue;
        }
        throw err;
      }
    }

    return { memoryByPath, checkedPaths, unreadablePaths, completed: true };
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
    const lifecycleCaps = resolveMemoryLifecycleCapabilities(this.config);
    let lifecycleFilteredCount = 0;
    let temporalSupersededFilteredCount = 0;
    let biTemporalExpiredFilteredCount = 0;
    let dedicatedSurfaceFilteredCount = 0;
    let forgottenFilteredCount = 0;
    let blockedPathFilteredCount = 0;
    const filtered: QmdSearchResult[] = [];
    for (const r of results) {
      if (r.path && options?.blockedPaths?.has(r.path)) {
        blockedPathFilteredCount += 1;
        continue;
      }
      const memory = memoryByPath.get(r.path);
      if (memory) {
        // Review-lifecycle statuses never enter active recall injection
        // (forgotten, pending_review, rejected, quarantined). Superseded and
        // archived have dedicated filters below. #1576: the faithfulness gate
        // routes unsupported/contradicted facts to pending_review — they must
        // not leak back via the QMD/embedding path. chatgpt P2.
        const recallStatus = memory.frontmatter.status;
        if (
          recallStatus === "forgotten" ||
          recallStatus === "pending_review" ||
          recallStatus === "rejected" ||
          recallStatus === "quarantined"
        ) {
          forgottenFilteredCount += 1;
          continue;
        }

        if (
          options?.allowLifecycleFiltered !== true &&
          shouldFilterLifecycleRecallCandidate(memory.frontmatter, {
            lifecyclePolicyEnabled: lifecycleCaps.lifecyclePolicy,
            lifecycleFilterStaleEnabled:
              lifecycleCaps.lifecycleFilterStale,
          })
        ) {
          lifecycleFilteredCount += 1;
          continue;
        }

        // Historical recall (issue #680): when the caller pinned the
        // recall to a specific point in time, evaluate temporal validity
        // at that instant FIRST and bypass the supersession filter
        // entirely. A fact that is currently superseded but was valid
        // at `as_of` is exactly what historical recall should surface;
        // running supersession filtering before the as_of check would
        // drop it and break the worked example in docs/temporal-recall.md
        // (codex P1 / cursor High on PR #713).
        const asOfActive =
          typeof options?.asOfMs === "number" && Number.isFinite(options.asOfMs);
        if (asOfActive) {
          if (!isValidAsOf(memory.frontmatter, options!.asOfMs!)) {
            temporalSupersededFilteredCount += 1;
            continue;
          }
        } else if (
          // Temporal supersession filter (issue #375): drop memories that
          // a newer fact has retired, unless the caller opted in to history.
          // NOTE: This check is intentionally independent of
          // allowLifecycleFiltered (Finding A fix) — cold fallback sets
          // allowLifecycleFiltered=true to include archived/retired
          // candidates, but superseded memories must still be filtered
          // unless temporalSupersessionIncludeInRecall is set.
          // Skipped entirely when `as_of` is active (above branch); the
          // half-open `[valid_at, invalid_at)` evaluation in isValidAsOf
          // is the authoritative gate for historical recall.
          shouldFilterSupersededFromRecall(memory.frontmatter, {
            enabled: lifecycleCaps.temporalSupersession,
            includeInRecall: this.config.temporalSupersessionIncludeInRecall,
          })
        ) {
          temporalSupersededFilteredCount += 1;
          continue;
        }
        // Bi-temporal INJECTION filter (issue #1578): when the master gate
        // is on and the caller did NOT pin `as_of`, drop facts whose event-
        // time interval has ended before now. This lives ONLY in the recall
        // injection path (filterSearchResultsByRecallSafety) — explicit
        // search (access-service.memorySearch → searchAcrossNamespaces /
        // qmd.search) never routes through here, so expired-validity facts
        // remain findable by memory_search and `as_of` queries (escape
        // hatch: the as_of branch above also admits historically-valid
        // records). Gated off entirely when `temporalExpiredInInjection` is
        // set. Status-orthogonal: an `active` fact can be validity-expired;
        // a `superseded` one may still be within its window.
        if (
          !asOfActive &&
          this.config.temporalBiTemporal &&
          !this.config.temporalExpiredInInjection &&
          isValidityExpiredNow(memory.frontmatter, Date.now())
        ) {
          biTemporalExpiredFilteredCount += 1;
          continue;
        }

        if (
          options?.allowDedicatedSurface !== true &&
          (memory.frontmatter.memoryKind === "dream" ||
            memory.frontmatter.memoryKind === "procedural")
        ) {
          dedicatedSurfaceFilteredCount += 1;
          continue;
        }
      }
      filtered.push(r);
    }
    if (lifecycleFilteredCount > 0) {
      log.debug(
        `lifecycle retrieval filter removed ${lifecycleFilteredCount} stale/archived candidates`,
      );
    }
    if (temporalSupersededFilteredCount > 0) {
      log.debug(
        `temporal supersession filter removed ${temporalSupersededFilteredCount} superseded candidates`,
      );
    }
    if (biTemporalExpiredFilteredCount > 0) {
      log.debug(
        `bi-temporal validity filter removed ${biTemporalExpiredFilteredCount} expired-validity candidates from injection (temporal.biTemporal on)`,
      );
    }
    if (dedicatedSurfaceFilteredCount > 0) {
      log.debug(
        `dedicated surface filter removed ${dedicatedSurfaceFilteredCount} dream/procedural candidates from generic recall`,
      );
    }
    if (forgottenFilteredCount > 0) {
      log.debug(
        `forgotten status filter removed ${forgottenFilteredCount} candidates from recall`,
      );
    }
    if (blockedPathFilteredCount > 0) {
      log.debug(
        `unreadable-path filter removed ${blockedPathFilteredCount} candidates from recall`,
      );
    }
    return filtered;
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
    if (results.length === 0) {
      return {
        results,
        memoryByPath: preloadedMemoryMap ? new Map(preloadedMemoryMap) : new Map(),
      };
    }
    const loaded = await this.loadSearchResultMemoryMap(
      results,
      preloadedMemoryMap,
      options,
    );
    const candidateResults = loaded.completed
      ? results
      : results.filter((result) => !result.path || loaded.checkedPaths.has(result.path));
    if (!loaded.completed) {
      log.debug(
        `recall safety filter stopped before validating all candidates (${candidateResults.length}/${results.length} eligible)`,
      );
    }
    const blockedPaths = new Set(loaded.unreadablePaths);
    if (options?.dropUnresolved === true) {
      for (const resultPath of loaded.checkedPaths) {
        if (!loaded.memoryByPath.has(resultPath)) {
          blockedPaths.add(resultPath);
        }
      }
    }
    return {
      results: this.filterSearchResultsByRecallSafety(
        candidateResults,
        loaded.memoryByPath,
        { ...options, blockedPaths },
      ),
      memoryByPath: loaded.memoryByPath,
    };
  }

  /**
   * Apply recency, access count, and importance boosting to QMD search results.
   * Returns re-ranked results.
   */
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
    const lifecycleCaps = resolveMemoryLifecycleCapabilities(this.config);
    if (results.length === 0) return results;

    const safety = await this.filterSearchResultsForRecall(
      results,
      preloadedMemoryMap,
      { ...options, recallNamespaces: _recallNamespaces },
    );
    const safeResults = safety.results;
    const memoryByPath = safety.memoryByPath;
    if (safeResults.length === 0) return safeResults;

    const now = Date.now();

    // Determine temporal/tag query params before index I/O (pure computation).
    const resultPaths = new Set(
      safeResults.map((r) => r.path).filter(Boolean) as string[],
    );
    let temporalFromDate: string | null = null;
    let promptTags: string[] = [];
    if (resolveIndexingCapabilities(this.config).queryAwareIndexing && prompt) {
      if (isTemporalQuery(prompt)) {
        temporalFromDate = recencyWindowFromPrompt(prompt, now);
      }
      promptTags = extractTagsFromPrompt(prompt);
    }

    const [rawTemporal, rawTags] = await Promise.all([
      temporalFromDate !== null
        ? queryByDateRangeAsync(this.config.memoryDir, temporalFromDate)
        : Promise.resolve<Set<string> | null>(null),
      promptTags.length > 0
        ? queryByTagsAsync(this.config.memoryDir, promptTags)
        : Promise.resolve<Set<string> | null>(null),
    ]);

    const queryIntent =
      resolveConversationContextCapabilities(this.config).intentRouting && prompt
        ? inferIntentFromText(prompt)
        : null;

    // v8.1: Temporal + Tag prefilter candidate set
    // Scope to result paths first so cross-namespace paths don't consume the cap.
    let temporalCandidates: Set<string> | null = null;
    let tagCandidates: Set<string> | null = null;
    if (resolveIndexingCapabilities(this.config).queryAwareIndexing && prompt) {
      const maxCandidates = this.config.queryAwareIndexingMaxCandidates;
      const capSet = (s: Set<string> | null): Set<string> | null => {
        if (!s) return null;
        // Intersect with result paths first so out-of-scope paths don't exhaust the budget
        const scoped = new Set(Array.from(s).filter((p) => resultPaths.has(p)));
        if (maxCandidates === 0 || scoped.size <= maxCandidates)
          return scoped;
        return new Set(Array.from(scoped).slice(0, maxCandidates));
      };
      if (temporalFromDate !== null) {
        temporalCandidates = capSet(rawTemporal);
      }
      if (promptTags.length > 0) {
        tagCandidates = capSet(rawTags);
      }
    }

    const boosted: QmdSearchResult[] = [];
    const recencyWeight = this.effectiveRecencyWeight();
    for (const r of safeResults) {
      const memory = memoryByPath.get(r.path);
      let score = r.score;

      if (memory) {
        // Recency boost: exponential decay over 7 days
        if (recencyWeight > 0) {
          const createdAt = new Date(memory.frontmatter.created).getTime();
          const ageMs = now - createdAt;
          const ageDays = ageMs / (1000 * 60 * 60 * 24);
          const halfLifeDays = 7;
          const recencyScore = Math.pow(0.5, ageDays / halfLifeDays);
          score = score * (1 - recencyWeight) + recencyScore * recencyWeight;
        }

        // Access count boost: log scale, capped
        if (this.config.boostAccessCount && memory.frontmatter.accessCount) {
          const accessBoost =
            Math.log10(memory.frontmatter.accessCount + 1) / 3;
          score += applyUtilityRankingRuntimeDelta(
            Math.min(accessBoost, 0.1),
            this.utilityRuntimeValues,
            "boost",
          );
        }

        // Importance boost (Phase 1B): higher importance = higher rank
        if (memory.frontmatter.importance) {
          const importanceScore = memory.frontmatter.importance.score;
          // Boost important memories, slightly penalize trivial ones
          // Scale: trivial (-0.05) to critical (+0.15)
          const importanceBoost = (importanceScore - 0.4) * 0.25;
          score += applyUtilityRankingRuntimeDelta(
            importanceBoost,
            this.utilityRuntimeValues,
            importanceBoost >= 0 ? "boost" : "suppress",
          );
        }

        // Feedback bias (v2.2): apply small user-provided up/down vote adjustments.
        if (resolveRecallEnhancementCapabilities(this.config).feedback) {
          const match = memory.path.match(/([^/]+)\.md$/);
          const memoryId = match ? match[1] : null;
          if (memoryId) {
            const feedbackDelta = this.relevance.adjustment(memoryId);
            score += applyUtilityRankingRuntimeDelta(
              feedbackDelta,
              this.utilityRuntimeValues,
              feedbackDelta >= 0 ? "boost" : "suppress",
            );
          }
        }

        // Negative examples (v2.2): apply a small penalty for memories repeatedly marked "not useful".
        if (resolvePipelineProcessingCapabilities(this.config).negativeExamples) {
          const match = memory.path.match(/([^/]+)\.md$/);
          const memoryId = match ? match[1] : null;
          if (memoryId) {
            const negativePenalty = this.negatives.penalty(memoryId, {
              perHit: this.config.negativeExamplesPenaltyPerHit,
              cap: this.config.negativeExamplesPenaltyCap,
            });
            score -= applyUtilityRankingRuntimeDelta(
              negativePenalty,
              this.utilityRuntimeValues,
              "suppress",
            );
          }
        }

        if (
          queryIntent &&
          memory.frontmatter.intentGoal &&
          memory.frontmatter.intentActionType
        ) {
          const compatibility = intentCompatibilityScore(queryIntent, {
            goal: memory.frontmatter.intentGoal,
            actionType: memory.frontmatter.intentActionType,
            entityTypes: memory.frontmatter.intentEntityTypes ?? [],
          });
          score += applyUtilityRankingRuntimeDelta(
            compatibility * this.config.intentRoutingBoost,
            this.utilityRuntimeValues,
            "boost",
          );
        }

        // v8.1: Temporal + Tag index boost
        // Results that match the detected temporal window or tag query get a small additive boost.
        if (resolveIndexingCapabilities(this.config).queryAwareIndexing && r.path) {
          if (temporalCandidates?.has(r.path)) {
            score += applyUtilityRankingRuntimeDelta(
              0.08,
              this.utilityRuntimeValues,
              "boost",
            );
          }
          if (tagCandidates?.has(r.path)) {
            score += applyUtilityRankingRuntimeDelta(
              0.06,
              this.utilityRuntimeValues,
              "boost",
            );
          }
        }

        // v8.3: lifecycle retrieval weighting (fail-open on legacy memories).
        const lifecycleDelta = lifecycleRecallScoreAdjustment(
          memory.frontmatter,
          {
            lifecyclePolicyEnabled: lifecycleCaps.lifecyclePolicy,
          },
        );
        score += applyUtilityRankingRuntimeDelta(
          lifecycleDelta,
          this.utilityRuntimeValues,
          lifecycleDelta >= 0 ? "boost" : "suppress",
        );

        // Reinforcement recall boost (issue #687 PR 3/4).
        // Applies an additive score bonus proportional to how many times the
        // pattern-reinforcement job has promoted this memory as a canonical.
        // Formula: min(reinforcement_count * weight, max).
        // Gated by reinforcementRecallBoostEnabled (default false).
        let reinforcementBoost = 0;
        if (
          resolveRecallEnhancementCapabilities(this.config).reinforcementRecallBoost &&
          typeof memory.frontmatter.reinforcement_count === "number" &&
          memory.frontmatter.reinforcement_count > 0
        ) {
          reinforcementBoost = Math.min(
            memory.frontmatter.reinforcement_count *
              this.config.reinforcementRecallBoostWeight,
            this.config.reinforcementRecallBoostMax,
          );
          score += reinforcementBoost;
        }
        if (reinforcementBoost > 0) {
          boosted.push({
            ...r,
            score,
            explain: { ...(r.explain ?? {}), reinforcementBoost },
          });
          continue;
        }
      }

      boosted.push({ ...r, score });
    }

    // Re-sort by boosted score
    return boosted.sort((a, b) => b.score - a.score);
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
    if (!resolveNamespaceCapabilities(this.config).namespaces) return this.config.defaultNamespace;
    const parts = qmdCollectionPathParts(p);
    const collectionNamespace = parts
      ? this.qmdCollectionNamespaceFromPrefix(parts.collection)
      : null;
    if (collectionNamespace) return collectionNamespace;
    const m = p.match(/[\\/]+namespaces[\\/]+([^\\/]+)(?:[\\/]|$)/);
    if (!m?.[1]) return this.config.defaultNamespace;
    return namespaceIdentityFromToken(m[1]) ?? m[1];
  }

  private storageDirNamespace(storageDir: string): string {
    // #1521: delegates to the scope-module resolver. The inline dir→namespace
    // derivation (token round-trip guard, catalog hints) is retired so the
    // adHocNamespaceResolutions ratchet no longer counts this site. Hints are
    // loaded lazily via the callback (only after early returns, matching the
    // original behavior — codex P2).
    return resolveNamespaceFromStorageDir(storageDir, {
      config: this.config,
      configuredNamespaces: this.configuredNamespaceList(),
      hints: this.namespaceStorageDirHints,
      loadHints: () => this.loadNamespaceStorageDirHintsFromCatalog(),
    });
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
    const uniq = Array.from(new Set(namespaces.filter(Boolean)));
    const lists = await Promise.all(
      uniq.map(async (ns) => {
        const sm = await this.storageRouter.storageFor(ns);
        return sm.readAllMemories();
      }),
    );
    return lists.flat();
  }

  private async readArchivedMemoriesForNamespaces(
    namespaces: string[],
  ): Promise<MemoryFile[]> {
    const uniq = Array.from(new Set(namespaces.filter(Boolean)));
    const lists = await Promise.all(
      uniq.map(async (ns) => {
        const sm = await this.storageRouter.storageFor(ns);
        return sm.readArchivedMemories();
      }),
    );
    return lists.flat();
  }
}
