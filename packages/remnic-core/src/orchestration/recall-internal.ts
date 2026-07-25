/**
 * Recall-internal coordinator — extracted from the orchestrator
 * (issue #1526, seam 18).
 *
 * Owns the `recallInternal` pipeline: the ~5k-LOC method that turns a
 * prompt into the injected memory-context string. Hosts the full recall
 * assembly flow:
 *   - intent planning + recall-mode gating
 *   - QMD tier search with artifact top-up and cold-fallback pipeline
 *   - specialized recall sections (entity, explicit-cue, targeted-fact,
 *     response-guidance, event-order, conversation, compression guidelines)
 *   - graph expansion, trust scoring, rerank, MMR diversification
 *   - budget accounting, X-ray capture, and last-recall snapshots
 *
 * Behavior-preserving move from orchestrator.ts. No logic changes — the
 * orchestrator keeps a thin delegating method so existing call sites and
 * tests continue to work. Every gate the moved code consults flows back
 * through RecallInternalDeps into the orchestrator's own (overridable)
 * members, so test seams like `recallAssemblyClockMs` keep working.
 */

import { createHash } from "node:crypto";
import { readFile, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { BoxBuilder, type BoxFrontmatter } from "../boxes.js";
import { type CapabilitySet, type GraphConstructionCapabilitySet, type MemoryLifecycleCapabilitySet, resolveCapabilities, resolveCompressionCapabilities, resolveConsolidationCapabilities, resolveConversationContextCapabilities, resolveCreationMemoryCapabilities, resolveGraphConstructionCapabilities, resolveIdentityContinuityCapabilities, resolveIndexingCapabilities, resolveMemoryLifecycleCapabilities, resolveNamespaceCapabilities, resolveObjectiveStateCapabilities, resolvePipelineProcessingCapabilities, resolvePresentationCapabilities, resolveQmdCapabilities, resolveRecallAuxiliaryCapabilities, resolveRecallEnhancementCapabilities, resolveSecurityCapabilities } from "../capabilities.js";
import { type CausalTrajectorySearchResult, searchCausalTrajectories } from "../causal-trajectory.js";
import { CompoundingEngine } from "../compounding/engine.js";
import { buildEntityRecallSection, entityRecentTranscriptLookbackHours, readRecentEntityTranscriptEntries } from "../entity-retrieval.js";
import type { EvalShadowRecallRecord } from "../evals.js";
import { buildEventOrderRecallSection, shouldRecallEventOrderEvidence } from "../event-order-recall.js";
import { buildExplicitCueRecallSection } from "../explicit-cue-recall.js";
import { buildFocusedListRecallSection, shouldRecallFocusedListEvidence } from "../focused-list-recall.js";
import { type HarmonicRetrievalResult, searchHarmonicRetrieval } from "../harmonic-retrieval.js";
import { StorageManager } from "../index.js";
import { inferIntentFromText, planRecallMode } from "../intent.js";
import { LcmEngine } from "../lcm/index.js";
import { log } from "../logger.js";
import { isActiveMemoryStatus } from "../memory-lifecycle-ledger-utils.js";
import { buildRetrievedMemoryProvenance } from "../memory-provenance.js";
import { NamespaceCatalog } from "../namespaces/catalog.js";
import { canReadNamespace, resolvePrincipal } from "../namespaces/principal.js";
import { NamespaceStorageRouter } from "../namespaces/storage.js";
import { collectNativeKnowledgeChunks, formatNativeKnowledgeSection, searchNativeKnowledge } from "../native-knowledge.js";
import { type ObjectiveStateSearchResult, objectiveStateStoreOverrideForNamespace, searchObjectiveStateSnapshots } from "../objective-state.js";
import { type GraphRecallRankedResult, type GraphRecallShadowComparison, mergeGraphExpandedResults } from "./graph-recall-coordinator.js";
import { buildProcedureRecallSection } from "../procedural/procedure-recall.js";
import { ProfilingCollector } from "../profiling.js";
import { buildQmdRecallCacheKey, getCachedQmdRecall, setCachedQmdRecall } from "../qmd-recall-cache.js";
import { MEMORY_ID_PATTERN } from "../recall-handles.js";
import {
  boundRecallContextComposition,
  composeRecallContext,
  contextBudgetForFooter,
  formatCuriosityFooter,
  selectCuriosityQuestion,
  type RecallContextComposition,
} from "../recall-context-composition.js";
import { createRecallSectionMetricRecorder } from "../recall-qos.js";
import { buildRecallQueryPolicy } from "../recall-query-policy.js";
import { type GraphRecallExpandedEntry, type LastRecallBudgetSummary, type LastRecallSnapshot, LastRecallStore, RecallHandleHistoryStore } from "../recall-state.js";
import { type RecallFilterTrace, type RecallXrayResult, type RecallXrayScoreDecomposition, type RecallXraySnapshot, buildXraySnapshot } from "../recall-xray.js";
import { foldQueueWaitTiming, recordRecallTiming } from "../recall-timings.js";
import { findUnresolvedEntityRefs } from "../reconstruct.js";
import { RerankCache, rerankLocalOrNoop, reorderByRankedKeys } from "../rerank.js";
import { buildResponseGuidanceRecallSection, shouldRecallResponseGuidance } from "../response-guidance-recall.js";
import { type ParallelSearchResult, mergeWithAgentResults, runDirectAgent, runTemporalAgent, shouldRunAgent } from "../retrieval-agents.js";
import { resolveScopePlan } from "../scopes/scope-plan.js";
import type { SearchBackend, SearchDegradation, SearchQueryOptions } from "../search/port.js";
import { type VerifiedSemanticRuleResult, compareVerifiedSemanticRuleResults, searchVerifiedSemanticRules } from "../semantic-rule-verifier.js";
import { SharedContextManager } from "../shared-context/manager.js";
import { isDisagreementPrompt } from "../signal.js";
import { HourlySummarizer } from "../summarizer.js";
import { buildTargetedFactRecallSection, shouldRecallTargetedFactEvidence } from "../targeted-fact-recall.js";
import { shouldFilterSupersededFromRecall } from "../temporal-supersession.js";
import { queryTemporalTimelineAsync } from "../temporal-index.js";
import { buildTemporalTimelineRecallSection, type TemporalTimelineRecallItem } from "../temporal-timeline-recall.js";
import { isValidAsOf } from "../temporal-validity.js";
import { TmtBuilder } from "../tmt.js";
import { TranscriptManager } from "../transcript.js";
import { type TrustStageResultItem, projectTrustForXray } from "../trust-score-stage.js";
import { type TrustZoneSearchResult, searchTrustZoneRecords } from "../trust-zones.js";
import type { CodingContext, EngramTraceEvent, IdentityInjectionMode, MemoryFile, MemoryIntent, PluginConfig, QmdSearchResult, RecallPlanMode, RecallSectionConfig } from "../types.js";
import { type VerifiedEpisodeResult, compareVerifiedEpisodeResults, searchVerifiedEpisodes } from "../verified-recall.js";
import { type WorkProductLedgerSearchResult, searchWorkProductLedgerEntries } from "../work-product-ledger.js";
import { abortError } from "../abort-error.js";
import {
  applyQueryAwareCandidateFilter,
  filterRecallCandidates,
  mapRecallSourceToXrayServedBy,
  COMPACTION_SIGNAL_MAX_AGE_MS,
  computeArtifactRecallLimit,
  computeQmdHybridFetchLimit,
  defaultWorkspaceDir,
  raceRecallAbort,
  resolveRecallModeDecision,
  resolveRecallModeDecisionAsync,
  sanitizeSessionKeyForFilename,
  summarizeGraphShadowComparison,
  throwIfRecallAborted,
  type GraphRecallSnapshot,
  type IntentDebugSnapshot,
  type QmdRecallSnapshot,
  type QueryAwarePrefilter,
  type RecallInvocationOptions,
} from "../orchestrator.js";
import { isGenericRecallExcludedPath } from "./orchestrator-helpers.js";

import type {
  RecallSectionAppendOptions,
  RecallSectionBuckets,
} from "./recall-section-coordinator.js";

export interface RecallInternalDeps {
  readonly _recallWorkspaceOverrides: Map<string, string>;
  appendRecallSection(
    sectionBuckets: RecallSectionBuckets,
    sectionId: string,
    content: string,
    options?: RecallSectionAppendOptions,
  ): boolean;
  applyColdFallbackPipeline(options: {
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
  }): Promise<QmdSearchResult[]>;
  applyTrustScoreToBranch(
    results: QmdSearchResult[],
    namespaces: string[],
    caps: CapabilitySet,
    label: string,
    preloadedFrontmatter?: ReadonlyMap<string, MemoryFile>,
    abortSignal?: AbortSignal,
  ): Promise<{
    results: QmdSearchResult[];
    trustByPath: Map<string, TrustStageResultItem> | null;
  }>;
  assembleRecallSections(
    sectionBuckets: RecallSectionBuckets,
    budgetOverride?: number,
  ): {
    sections: string[];
    includedIds: string[];
    omittedIds: string[];
    truncated: boolean;
    finalChars: number;
    includedMemoryIds: string[];
    includedMemoryPaths: string[];
    includedMemoryNamespaces: Array<string | undefined>;
    omittedMemoryIds: string[];
  };
  boostSearchResults(
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
  ): Promise<QmdSearchResult[]>;
  boxBuilderFor(storage: StorageManager): BoxBuilder;
  buildCompressionGuidelineRecallSection(): Promise<string | null>;
  buildConfiguredQmdSearchOptions(
    queryText: string,
  ): SearchQueryOptions | undefined;
  buildGraphRecallRankedResults(
    results: QmdSearchResult[],
    sourceLabelResolver: (path: string) => string[],
    limit?: number,
  ): GraphRecallRankedResult[];
  buildIdentityContinuitySection(options: {
    storage: StorageManager;
    recallMode: RecallPlanMode;
    prompt: string;
  }): Promise<{
    section: string;
    mode: IdentityInjectionMode;
    injectedChars: number;
    truncated: boolean;
  } | null>;
  buildLastRecallBudgetSummary(options: {
    requestedTopK?: number;
    recallResultLimit: number;
    qmdFetchLimit: number;
    qmdHybridFetchLimit: number;
    finalContextChars?: number;
    truncated?: boolean;
    includedSections?: string[];
    omittedSections?: string[];
    includedMemoryIds?: string[];
    includedMemoryPaths?: string[];
    includedMemoryNamespaces?: Array<string | undefined>;
    omittedMemoryIds?: string[];
  }): LastRecallBudgetSummary;
  buildQueryAwarePrefilter(
    prompt: string,
    recallNamespaces: string[],
  ): Promise<QueryAwarePrefilter>;
  collectLastRecallSources(
    sectionBuckets: RecallSectionBuckets,
    recallSource:
      | "none"
      | "hot_qmd"
      | "hot_embedding"
      | "cold_fallback"
      | "recent_scan",
  ): string[];
  readonly compounding?: CompoundingEngine;
  readonly config: PluginConfig;
  currentPolicyVersion(): string;
  diversifyAndLimitRecallResults(
    sectionId: string,
    results: QmdSearchResult[],
    limit: number,
    retrievalQuery?: string,
    caps?: CapabilitySet,
  ): QmdSearchResult[];
  effectiveCronRecallInstructionHeavyTokenCap(): number;
  emitTrace(event: EngramTraceEvent): void;
  expandResultsViaGraph(options: {
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
  }>;
  extractMemoryIdsFromResults(results: QmdSearchResult[]): string[];
  readonly fastLlmForRerank: {
    chatCompletion: (
      messages: Array<{ role: string; content: string }>,
      options?: { maxTokens?: number; temperature?: number; timeoutMs?: number; operation?: string; priority?: "recall-critical" | "background" },
    ) => Promise<{ content: string } | null>;
  };
  fetchQmdMemoryResultsWithArtifactTopUp(
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
  ): Promise<QmdSearchResult[]>;
  filterSearchResultsForRecall(
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
  ): Promise<{ results: QmdSearchResult[]; memoryByPath: Map<string, MemoryFile> }>;
  formatCausalTrajectoryResults(
    results: CausalTrajectorySearchResult[],
  ): string;
  formatConversationRecallSection(
    results: Array<{ path: string; snippet: string; score: number }>,
    maxChars: number,
  ): string | null;
  formatHarmonicRetrievalResults(
    results: HarmonicRetrievalResult[],
  ): string;
  formatObjectiveStateResults(
    results: ObjectiveStateSearchResult[],
  ): string;
  formatQmdResults(
    title: string,
    results: QmdSearchResult[],
    sessionKey?: string,
    trustByPath?: Map<string, TrustStageResultItem> | null,
  ): string;
  formatTrustZoneResults(results: TrustZoneSearchResult[]): string;
  formatVerifiedEpisodeResults(
    results: VerifiedEpisodeResult[],
  ): string;
  formatVerifiedSemanticRuleResults(
    results: VerifiedSemanticRuleResult[],
  ): string;
  formatWorkProductResults(
    results: WorkProductLedgerSearchResult[],
  ): string;
  getCodingContextForSession(sessionKey: string | undefined): CodingContext | null;
  getPeerIdForSession(sessionKey: string | undefined): string | null;
  getRecallBudgetChars(override?: number): number;
  getRecallSectionEntry(
    sectionId: string,
  ): RecallSectionConfig | undefined;
  getRecallSectionMaxChars(
    sectionId: string,
  ): number | null | undefined;
  getRecallSectionNumber(
    sectionId: string,
    key: keyof RecallSectionConfig,
  ): number | undefined;
  getStorage(namespace?: string): Promise<StorageManager>;
  readonly handleHistory: RecallHandleHistoryStore;
  trackMemoryAccess(
    memoryIds: string[],
    memoryPaths?: string[],
    memoryNamespaces?: Array<string | undefined>,
  ): void;
  trackRecallBackgroundWrite(promise: Promise<void>, label: string): void;
  isRecallSectionEnabled(
    sectionId: string,
    defaultEnabled?: boolean,
  ): boolean;
  isSpecializedRecallSectionEnabled(
    sectionId: string,
    topLevelEnabled: boolean,
  ): boolean;
  lastQmdReprobeAtMs: number;
  readonly lastRecall: LastRecallStore;
  lastXraySnapshot: RecallXraySnapshot | null;
  readonly lcmEngine: LcmEngine | null;
  readonly namespaceCatalog: NamespaceCatalog;
  namespaceFromPath(p: string): string;
  readonly profiler: ProfilingCollector;
  publishRecallResults(options: {
    title: string;
    results: QmdSearchResult[];
    sectionBuckets: RecallSectionBuckets;
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
  }): void;
  readonly qmd: SearchBackend;
  queueEvalShadowRecall(
    record: Omit<EvalShadowRecallRecord, "schemaVersion">,
  ): void;
  readAllMemoriesForNamespaces(
    namespaces: string[],
  ): Promise<MemoryFile[]>;
  recallArtifactsAcrossNamespaces(
    prompt: string,
    recallNamespaces: string[],
    targetCount: number,
  ): Promise<MemoryFile[]>;
  recallAssemblyClockMs(): number;
  recordLastGraphRecallSnapshot(options: {
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
  }): Promise<void>;
  recordLastIntentSnapshot(options: {
    storage: StorageManager;
    snapshot: IntentDebugSnapshot;
  }): Promise<void>;
  recordLastIntentSnapshotForNamespace(options: {
    namespace: string;
    snapshot: IntentDebugSnapshot;
  }): Promise<void>;
  recordLastQmdRecallSnapshot(options: {
    storage: StorageManager;
    snapshot: QmdRecallSnapshot;
  }): Promise<void>;
  readonly rerankCache: RerankCache;
  searchConversationRecallResults(
    retrievalQuery: string,
    topK: number,
  ): Promise<Array<{ path: string; snippet: string; score: number }>>;
  searchEmbeddingFallback(
    query: string,
    limit: number,
  ): Promise<QmdSearchResult[]>;
  readonly sharedContext?: SharedContextManager;
  readonly storage: StorageManager;
  readonly storageRouter: NamespaceStorageRouter;
  readonly summarizer: HourlySummarizer;
  readonly tmtBuilder: TmtBuilder;
  readonly transcript: TranscriptManager;
  truncateArtifactForRecall(text: string, maxChars?: number): string;
  truncateRecallSectionToBudget(
    content: string,
    maxChars: number,
  ): string;
}

export class RecallInternalCoordinator {
  constructor(
    private readonly deps: RecallInternalDeps,
  ) {}

  async recallInternal(
    prompt: string,
    sessionKey?: string,
    options: RecallInvocationOptions = {},
    caps: CapabilitySet = resolveCapabilities(this.deps.config),
    graphCaps: GraphConstructionCapabilitySet = resolveGraphConstructionCapabilities(this.deps.config),
    lifecycleCaps: MemoryLifecycleCapabilitySet = resolveMemoryLifecycleCapabilities(this.deps.config),
  ): Promise<string> {
    const recallStart = Date.now();
    // Backend degradations observed by this recall's QMD searches (#1536):
    // collected via the execution-options observer and attached to the
    // LastRecallSnapshot after it is recorded, so surfaces can distinguish
    // "no matches" from "backend could not answer" (CLAUDE.md rule 34).
    const backendDegradations: SearchDegradation[] = [];
    // Issue #680 — historical recall.  Parse `options.asOf` once at the
    // top of the recall so each boost-pass uses identical filter logic.
    // Invalid values are rejected at input boundaries (CLI / HTTP / MCP)
    // per CLAUDE.md rule 51; if a malformed value sneaks through here,
    // we treat it as "no historical pin" rather than throwing inside
    // recall — the upstream surfaces are the source of truth.
    let asOfMs: number | undefined;
    if (typeof options.asOf === "string" && options.asOf.length > 0) {
      const parsed = Date.parse(options.asOf);
      if (Number.isFinite(parsed)) asOfMs = parsed;
    }
    const timings = foldQueueWaitTiming(options.queueWaitMs); // #1906 queue-wait phase
    const profileTraceId = this.deps.profiler.startTrace("recall", sessionKey, {
      qmdEnabled: resolveQmdCapabilities(this.deps.config).qmd,
      rerankEnabled: caps.rerank,
      parallelRetrieval: caps.parallelRetrieval,
    });
    this.deps.profiler.startSpan("planning", profileTraceId);
    let profileTraceClosed = false;
    const closeProfileTrace = () => {
      if (profileTraceClosed) return;
      profileTraceClosed = true;
      this.deps.profiler.endTrace(profileTraceId); // persists to JSONL file
    };
    const recallSectionDeadlineMs = this.deps.config.recallCoreDeadlineMs ?? 75_000;
    const enrichmentSectionDeadlineMs =
      this.deps.config.recallEnrichmentDeadlineMs ?? 25_000;
    // Wrap entire recall body in try/finally so profiling trace is always closed,
    // even on unexpected exceptions (e.g., throwIfRecallAborted, phase-1 errors).
    try {
    type DeferredEnrichmentOutcome<T> =
      | { status: "resolved"; value: T }
      | { status: "rejected"; error: unknown };
    type ObservedDeferredEnrichmentPromise<T> =
      Promise<DeferredEnrichmentOutcome<T>> & {
        getSettledOutcome: () => DeferredEnrichmentOutcome<T> | undefined;
        cancel: () => void;
      };
    const createEnrichmentAbortHandle = (parentSignal?: AbortSignal) => {
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      if (parentSignal?.aborted) {
        controller.abort();
      } else if (parentSignal) {
        parentSignal.addEventListener("abort", onAbort, { once: true });
      }
      let disposed = false;
      const dispose = () => {
        if (disposed) return;
        disposed = true;
        parentSignal?.removeEventListener("abort", onAbort);
      };
      return {
        signal: controller.signal,
        cancel: () => {
          controller.abort();
          dispose();
        },
        dispose,
      };
    };
    const observeEnrichmentPromise = <T>(
      promise: Promise<T>,
      cancel: () => void = () => {},
    ): ObservedDeferredEnrichmentPromise<T> => {
      let settledOutcome: DeferredEnrichmentOutcome<T> | undefined;
      const observed = promise
        .then<DeferredEnrichmentOutcome<T>, DeferredEnrichmentOutcome<T>>(
          (value) => ({ status: "resolved", value }),
          (error) => ({ status: "rejected", error }),
        )
        .then((outcome) => {
          settledOutcome = outcome;
          return outcome;
        }) as ObservedDeferredEnrichmentPromise<T>;
      observed.getSettledOutcome = () => settledOutcome;
      observed.cancel = cancel;
      return observed;
    };
    const recordRecallSectionMetric = createRecallSectionMetricRecorder({
      timings,
      logger: log,
    });
    const promptHash = createHash("sha256").update(prompt).digest("hex");
    const traceId = createHash("sha256")
      .update(`${sessionKey ?? "default"}:${recallStart}:${promptHash}`)
      .digest("hex")
      .slice(0, 16);
    const sectionBuckets: RecallSectionBuckets = new Map();
    // The effective LCM read session_id SET is computed below from
    // `recallNamespaces` (the SAME read-authorized namespace set normal QMD/file
    // recall searches, incl. coding `readFallbacks`). See the
    // `lcmReadSessionIds` derivation after `recallNamespaces` is built.
    const queryPolicy = buildRecallQueryPolicy(prompt, sessionKey, {
      cronRecallPolicyEnabled: resolveRecallAuxiliaryCapabilities(this.deps.config).cronRecallPolicy,
      cronRecallNormalizedQueryMaxChars:
        this.deps.config.cronRecallNormalizedQueryMaxChars,
      cronRecallInstructionHeavyTokenCap:
        this.deps.effectiveCronRecallInstructionHeavyTokenCap(),
      cronConversationRecallMode: this.deps.config.cronConversationRecallMode,
    });
    const retrievalQuery = queryPolicy.retrievalQuery || prompt;
    const retrievalQueryHash = createHash("sha256")
      .update(retrievalQuery)
      .digest("hex");
    const policyVersion = this.deps.currentPolicyVersion();
    let recallSource:
      | "none"
      | "hot_qmd"
      | "hot_embedding"
      | "cold_fallback"
      | "recent_scan" = "none";
    let recalledMemoryCount = 0;
    let recalledMemoryIds: string[] = [];
    let recalledMemoryPaths: string[] = [];
    let recalledMemoryNamespaces: Array<string | undefined> = [];
    // Boosted QmdSearchResult array for the serving branch (issue #687 PR 3/4).
    // Populated alongside recalledMemoryPaths so the X-ray capture can read
    // per-result explain data (e.g. reinforcementBoost) from the result that
    // was actually served.
    let xrayRecalledResults: QmdSearchResult[] = [];
    // Issue #1577 — per-recall trust map (admitted + quarantined items).
    // A LOCAL, not instance state, so concurrent recalls on the same
    // orchestrator cannot race on it (review: shared-trust-map concurrency).
    // Populated by applyTrustScoreRerank on whichever recall path runs;
    // consumed by formatQmdResults (epistemic hedge), publishRecallResults
    // (quarantine filtering on ALL paths), and the X-ray capture (trust
    // projection + quarantined-item visibility — rule 34).
    let recallTrustByPath: Map<string, TrustStageResultItem> | null = null;
    // Issue #1577 — sink for the cold-fallback pipeline's trust map. The cold
    // pipeline scores internally (applyColdFallbackPipeline) and writes its
    // per-path trust map here; each cold caller reads it back into
    // recallTrustByPath so cold/embedding/recent paths feed the same X-ray +
    // epistemic-rendering + publisher-quarantine consumers the hot path uses
    // (rule 41: the feature gate applies across ALL parallel recall paths).
    const trustByPathSink: { trustByPath: Map<string, TrustStageResultItem> | null } = {
      trustByPath: null,
    };
    const lcmStructuredXrayResults: RecallXrayResult[] = [];
    // Per-branch pre-limit candidate pool size for the X-ray filter
    // trace (issue #570 PR 1).  `recalledMemoryCount` is assigned
    // AFTER MMR + truncation so using it alone would make the
    // `recall-result-limit` trace report `considered == admitted`
    // even when many candidates were dropped.  Each entry captures
    // the pool size BEFORE truncation at that branch.  The X-ray
    // capture block picks the pool that corresponds to the branch
    // that actually produced the admitted results (via `recallSource`)
    // so a pool from a branch whose candidates were killed by an
    // earlier gate cannot leak into the `considered` count.
    const xrayBranchPoolSize: Record<
      "hot_qmd" | "hot_embedding" | "cold_fallback" | "recent_scan",
      number
    > = {
      hot_qmd: 0,
      hot_embedding: 0,
      cold_fallback: 0,
      recent_scan: 0,
    };
    // Shared out-parameter sink the cold-fallback pipeline writes
    // its pre-truncation pool size into (issue #570 PR 1).  Declared
    // once so every call to `applyColdFallbackPipeline` (four call
    // sites) updates the same counter; the X-ray capture block
    // reads this as the cold-fallback pool.
    const xrayColdPoolSink = { size: 0 };
    let identityInjectionModeUsed: IdentityInjectionMode | "none" = "none";
    let identityInjectedChars = 0;
    let identityInjectionTruncated = false;
    timings.queryPolicy = `${queryPolicy.promptShape}/${queryPolicy.retrievalBudgetMode}${queryPolicy.skipConversationRecall ? "/skip-conv" : ""}`;
    const recallModeDecisionOptions = {
      plannerEnabled: caps.recallPlanner,
      graphRecallEnabled: caps.graphRecall,
      multiGraphMemoryEnabled: graphCaps.multiGraphMemory,
      graphExpandedIntentEnabled: caps.graphExpandedIntent,
      prompt,
    };
    // Issue #1547 — let the heuristic decide no_recall BEFORE the planner/non-planner fork so it fires with planner on OR off.
    const requestedMode: RecallPlanMode | undefined = options.mode ?? (planRecallMode(prompt) === "no_recall" ? "no_recall" : undefined);
    // planner entirely — the decision is overridden anyway. Otherwise consult
    // the LLM planner when opted in (issue #1367 / Option C); it falls back to
    // the heuristic on disable / shadow / timeout / error.
    const recallDecision =
      requestedMode !== undefined
        ? resolveRecallModeDecision(recallModeDecisionOptions)
        : await resolveRecallModeDecisionAsync({
            ...recallModeDecisionOptions,
            config: this.deps.config,
            caps,
            signal: options.abortSignal,
          });
    if (
      resolveRecallEnhancementCapabilities(this.deps.config).recallPlannerTelemetry &&
      recallDecision.plannerSource &&
      recallDecision.plannerSource !== "heuristic"
    ) {
      log.debug(
        `[recall-planner] mode=${recallDecision.shadowLlmMode ?? recallDecision.effectiveMode} ` +
          `source=${recallDecision.plannerSource} ` +
          `planned=${recallDecision.plannedMode} ` +
          `heuristic=${recallDecision.plannerHeuristicMode ?? recallDecision.plannedMode} ` +
          `model=${recallDecision.plannerModelUsed ?? "n/a"} ` +
          `latencyMs=${recallDecision.plannerLatencyMs ?? 0} ` +
          `fallback=${recallDecision.plannerFallbackUsed ?? false}` +
          (recallDecision.shadowLlmMode ? " (shadow)" : ""),
      );
    }
    this.deps.profiler.endSpan("planning", profileTraceId);
    const recallMode: RecallPlanMode =
      requestedMode ?? recallDecision.effectiveMode;
    const queryIntent = inferIntentFromText(retrievalQuery);
    const qmdSearchOptions =
      this.deps.buildConfiguredQmdSearchOptions(retrievalQuery);
    timings.recallPlan = recallMode;
    const plannerRecallResultLimit =
      recallMode === "no_recall"
        ? 0
        : recallMode === "minimal"
          ? Math.max(
              0,
              Math.min(
                this.deps.config.qmdMaxResults,
                this.deps.config.recallPlannerMaxQmdResultsMinimal,
              ),
            )
          : this.deps.config.qmdMaxResults;
    const policyMinimalLimit = Math.max(
      0,
      Math.min(
        this.deps.config.qmdMaxResults,
        this.deps.config.recallPlannerMaxQmdResultsMinimal,
      ),
    );
    const baseRecallResultLimit =
      recallMode !== "no_recall" &&
      queryPolicy.retrievalBudgetMode === "minimal"
        ? Math.min(plannerRecallResultLimit, policyMinimalLimit)
        : plannerRecallResultLimit;
    const memoriesSectionEnabled = this.deps.isRecallSectionEnabled("memories");
    const memorySectionMaxResults = this.deps.getRecallSectionNumber(
      "memories",
      "maxResults",
    );
    const requestedTopK =
      typeof options.topK === "number" && Number.isFinite(options.topK)
        ? Math.max(0, Math.min(200, Math.floor(options.topK)))
        : undefined;
    const recallResultLimit = memoriesSectionEnabled
      ? (() => {
          let limit = baseRecallResultLimit;
          if (memorySectionMaxResults !== undefined) {
            limit = Math.min(limit, memorySectionMaxResults);
          }
          if (requestedTopK !== undefined) {
            limit = Math.min(limit, requestedTopK);
          }
          return limit;
        })()
      : 0;
    const recallHeadroom = resolvePresentationCapabilities(this.deps.config).verbatimArtifacts
      ? Math.max(12, this.deps.config.verbatimArtifactsMaxRecall * 4)
      : 12;
    const computedFetchLimit =
      recallResultLimit === 0
        ? 0
        : Math.max(
            recallResultLimit,
            Math.min(200, recallResultLimit + recallHeadroom),
          );
    const qmdFetchLimit = computedFetchLimit;
    const qmdHybridFetchLimit = computeQmdHybridFetchLimit(
      qmdFetchLimit,
      resolvePresentationCapabilities(this.deps.config).verbatimArtifacts,
      this.deps.config.verbatimArtifactsMaxRecall,
    );
    const embeddingFetchLimit = computedFetchLimit;
    // Principal resolution honours the access-surface override (issue
    // #570 PR 4).  Access surfaces that have already authenticated the
    // caller at the transport layer (HTTP / MCP) pass their resolved
    // principal directly so namespace ACL decisions use the same
    // identity the surface authorized, instead of re-running
    // `resolvePrincipal(sessionKey)` which only maps raw session keys
    // through configured rules and otherwise collapses to `"default"`.
    const principal =
      typeof options.principalOverride === "string"
        && options.principalOverride.length > 0
        ? options.principalOverride
        : resolvePrincipal(sessionKey, this.deps.config);
    const namespacesEnabled = resolveNamespaceCapabilities(this.deps.config).namespaces;
    if (namespacesEnabled && !principal) {
      throw new Error("authentication required: namespaces are enabled and no principal was supplied");
    }
    const namespaceOverride = options.namespace?.trim() || undefined;
    if (
      namespaceOverride &&
      !canReadNamespace(principal, namespaceOverride, this.deps.config)
    ) {
      throw new Error(
        `namespace override is not readable: ${namespaceOverride}`,
      );
    }
    // Resolve every namespace-bearing field through ONE ScopePlan (#1521): the
    // read set, the LCM read keys, the coding overlay, and the scope-profile plan
    // all come from a single pure resolver that delegates to the same helpers
    // the inline code used. Parity snapshots in scope-plan.test.ts pin the
    // outputs so this migration cannot change behavior.
    //
    // Catalog read touch (issue #1499) is recorded LATER — after the Phase 1
    // abort gate — so it fires only when retrieval actually runs, not for
    // aborted / short-circuited recalls.
    const codingContext = sessionKey
      ? this.deps.getCodingContextForSession(sessionKey)
      : null;
    const scopePlan = resolveScopePlan({
      config: this.deps.config,
      sessionKey,
      namespace: options.namespace,
      principalOverride:
        typeof options.principalOverride === "string"
          && options.principalOverride.length > 0
          ? options.principalOverride
          : undefined,
      codingContext,
      namespacesEnabled,
    });
    const {
      readNamespaces: recallNamespaces,
      baseNamespace: selfNamespace,
      scopeProfilePlan,
      lcmReadSessionIds,
    } = scopePlan;
    // Query an LCM-backed read across the ordered read key set and return the
    // FIRST non-empty result (#1505 fallback-namespace unification). The primary
    // overlay key is tried first; if a branch-scoped session has no rows under its
    // branch key, the project / root fallback keys are tried in order.
    //
    // #1505 codex P2 ("Merge LCM fallback reads instead of short-circuiting"): the
    // query-SCORED sections (explicit-cue, targeted-facts, focused-list,
    // response-guidance, event-order, structured message-parts) no longer use this
    // helper — they MERGE candidates across EVERY authorized key under their single
    // budget (a weak primary-key hit must not mask stronger fallback evidence; the
    // section builders take `sessionIds`, structured-parts merges inline below).
    // This first-non-empty helper now serves ONLY the compressed-history section,
    // which is a per-session HOLISTIC DAG narrative with no per-item id to merge or
    // dedupe on — see its call site for the rationale.
    //
    // When the set is a single key (single-user / no-overlay / explicit-namespace),
    // this is exactly one call — unchanged. `lcmSessionId` is `string | undefined`:
    // a legacy SESSIONLESS recall yields the single `undefined` key so the read
    // runs ONE archive-wide read with no `session_id` filter (pre-#1505 behavior).
    // Hosted scope profiles are stricter: without a session key there is no
    // namespace-scoped LCM key to query, so the key set stays empty and LCM cannot
    // bypass the profile read stack via an archive-wide read. NEVER the literal
    // "default" session id (codex P2).
    const firstNonEmptyLcmRead = async <T>(
      read: (lcmSessionId: string | undefined) => Promise<T>,
      isEmpty: (value: T) => boolean,
      empty: T,
    ): Promise<T> => {
      for (const lcmSessionId of lcmReadSessionIds) {
        const value = await read(lcmSessionId);
        if (!isEmpty(value)) return value;
      }
      return empty;
    };
    const qmdAvailable = this.deps.qmd.isAvailable();
    let graphDecisionStatus: IntentDebugSnapshot["graphDecision"]["status"] =
      recallDecision.plannedMode === "graph_mode" ? "skipped" : "not_requested";
    let graphDecisionReason = recallDecision.graphReason;
    let graphDecisionShadowMode = false;
    let shouldPersistGraphSnapshot =
      recallDecision.plannedMode === "graph_mode";
    let graphSnapshotStatus: GraphRecallSnapshot["status"] | undefined =
      recallDecision.plannedMode === "graph_mode" ? "skipped" : undefined;
    let graphSnapshotReason = recallDecision.graphReason;
    let graphSnapshotSeedPaths: string[] = [];
    let graphSnapshotExpandedPaths: GraphRecallExpandedEntry[] = [];
    let graphSnapshotSeedResults: GraphRecallRankedResult[] = [];
    let graphSnapshotFinalResults: GraphRecallRankedResult[] = [];
    let graphSnapshotShadowComparison: GraphRecallShadowComparison | undefined;
    const graphBaselinePaths = new Set<string>();
    const graphExpandedResultPaths = new Set<string>();
    const graphSourceLabelsForPath = (resultPath: string): string[] => {
      const labels: string[] = [];
      const normalizedPath = resultPath.split(path.sep).join("/");
      const isEntityPath =
        normalizedPath.startsWith("entities/") ||
        normalizedPath.includes("/entities/");
      if (graphBaselinePaths.has(resultPath)) labels.push("baseline");
      if (graphExpandedResultPaths.has(resultPath))
        labels.push("graph_expanded");
      if (isEntityPath) labels.push("reconstructed_entity");
      return labels.length > 0 ? labels : ["baseline"];
    };
    const buildIntentDebugSnapshot = (): IntentDebugSnapshot => ({
      recordedAt: new Date().toISOString(),
      promptHash,
      promptLength: prompt.length,
      retrievalQueryHash,
      retrievalQueryLength: retrievalQuery.length,
      plannerEnabled: caps.recallPlanner,
      plannedMode: requestedMode ?? recallDecision.plannedMode,
      effectiveMode: recallMode,
      recallResultLimit,
      queryIntent,
      graphExpandedIntentDetected: recallDecision.graphExpandedIntentDetected,
      graphDecision: {
        status: graphDecisionStatus,
        reason: graphDecisionReason,
        shadowMode: graphDecisionShadowMode,
        qmdAvailable,
        graphRecallEnabled: caps.graphRecall,
        multiGraphMemoryEnabled: graphCaps.multiGraphMemory,
      },
    });

    if (recallMode === "no_recall") {
      const intentSnapshot = buildIntentDebugSnapshot();
      await this.deps.recordLastIntentSnapshotForNamespace({
        namespace: selfNamespace,
        snapshot: intentSnapshot,
      });
      // Clean up workspace selection before early return to prevent Map leaks.
      const earlySessionKey = sessionKey ?? "default";
      this.deps._recallWorkspaceOverrides.delete(earlySessionKey);
      timings.total = `${Date.now() - recallStart}ms`;
      recordRecallTiming(this.deps.config, {
        ...timings,
        timestamp: new Date().toISOString(),
        namespace: selfNamespace,
        total: timings.total,
        recallPlan: timings.recallPlan,
        queryPolicy: timings.queryPolicy,
      });
      // X-ray capture for the `no_recall` early-return path
      // (issue #570 PR 1).  `no_recall` skips retrieval entirely, so
      // the snapshot carries zero results and an empty-budget accounting
      // — but we STILL capture it when the caller opts in so
      // `getLastXraySnapshot()` returns a useful debug document rather
      // than silently `null` (or a stale prior capture).
      //
      // Skip capture when the caller has already aborted this recall —
      // otherwise a canceled call could clobber a prior successful
      // capture (issue #570 PR 1 review follow-up).
      if (
        options.xrayCapture === true &&
        !options.abortSignal?.aborted
      ) {
        try {
          this.deps.lastXraySnapshot = buildXraySnapshot({
            query: retrievalQuery,
            tierExplain: null,
            results: [],
            filters: [
              {
                name: "planner-mode",
                considered: 0,
                admitted: 0,
                reason: "no_recall",
              },
            ],
            budget: {
              chars: this.deps.getRecallBudgetChars(options.budgetCharsOverride),
              used: 0,
            },
            sessionKey,
            namespace: selfNamespace,
            traceId,
          });
        } catch (err) {
          // Capture is a best-effort side channel: a capture failure
          // must NEVER propagate into the primary recall path.
          log.debug(`x-ray capture (no_recall) failed: ${err}`);
        }
      }
      if (sessionKey) {
        this.deps.trackRecallBackgroundWrite(
          this.deps.lastRecall.record({
            sessionKey,
            query: retrievalQuery,
            memoryIds: [],
            namespace: selfNamespace,
            traceId,
            plannerMode: recallMode,
            requestedMode,
            source: recallSource,
            fallbackUsed: false,
            sourcesUsed: [],
            budgetsApplied: this.deps.buildLastRecallBudgetSummary({
              requestedTopK,
              recallResultLimit,
              qmdFetchLimit,
              qmdHybridFetchLimit,
            }),
            latencyMs: Date.now() - recallStart,
            resultPaths: [],
            policyVersion,
            appendImpression: this.deps.config.recordEmptyRecallImpressions,
            identityInjection: {
              mode: identityInjectionModeUsed,
              injectedChars: identityInjectedChars,
              truncated: identityInjectionTruncated,
            },
          }),
          "last recall record",
        );
      }
      if (sessionKey) {
        this.deps.queueEvalShadowRecall({
          traceId,
          recordedAt: new Date().toISOString(),
          sessionKey,
          promptHash,
          promptLength: prompt.length,
          retrievalQueryHash,
          retrievalQueryLength: retrievalQuery.length,
          recallMode,
          recallResultLimit,
          source: recallSource,
          recalledMemoryCount,
          injected: false,
          contextChars: 0,
          memoryIds: [],
          policyVersion,
          identityInjectionMode: identityInjectionModeUsed,
          identityInjectedChars,
          identityInjectionTruncated,
          durationMs: Date.now() - recallStart,
          timings: { ...timings },
        });
      }
      closeProfileTrace();
      this.deps.emitTrace({
        kind: "recall_summary",
        traceId,
        operation: "recall",
        sessionKey,
        promptHash,
        promptLength: prompt.length,
        retrievalQueryHash,
        retrievalQueryLength: retrievalQuery.length,
        recallMode,
        recallResultLimit,
        qmdEnabled: resolveQmdCapabilities(this.deps.config).qmd,
        qmdAvailable: this.deps.qmd.isAvailable(),
        recallNamespaces: [],
        source: recallSource,
        recalledMemoryCount,
        injected: false,
        contextChars: 0,
        policyVersion,
        identityInjectionMode: identityInjectionModeUsed,
        identityInjectedChars,
        identityInjectionTruncated,
        durationMs: Date.now() - recallStart,
        timings: { ...timings },
      });
      return "";
    }

    const profileStorageNamespaces = scopeProfilePlan ? recallNamespaces : [selfNamespace];
    const profileStorages = await Promise.all(
      profileStorageNamespaces.map((namespace) => this.deps.storageRouter.storageFor(namespace)),
    );
    const emptyProfileStorage = new Proxy(
      { dir: path.join(this.deps.config.memoryDir, ".empty-scope-profile") } as any,
      {
        get(target, prop: string | symbol) {
          if (prop in target) return target[prop];
          if (prop === "readProfile") return async () => "";
          if (
            prop === "readQuestions" ||
            prop === "listEntityNames" ||
            prop === "readContinuityIncidents"
          )
            return async () => [];
          if (
            prop === "readIdentityAnchor" ||
            prop === "readIdentityImprovementLoops"
          )
            return async () => "";
          if (prop === "readEntity" || prop === "readMemoryByPath")
            return async () => null;
          return async () => [];
        },
      },
    );
    const profileStorage =
      profileStorages.length <= 1
        ? profileStorages[0] ?? emptyProfileStorage
        : new Proxy(profileStorages[0] as any, {
            get(target, prop: string | symbol) {
              if (prop === "readProfile") {
                return async () => {
                  for (const storage of profileStorages) {
                    const profile = await storage.readProfile();
                    if (profile.trim().length > 0) return profile;
                  }
                  return "";
                };
              }
              if (prop === "readQuestions") {
                return async (...args: any[]) => {
                  const merged: any[] = [];
                  const seen = new Set<string>();
                  const priorityOf = (question: any): number => {
                    const priority = Number(question?.priority ?? 0);
                    return Number.isFinite(priority) ? priority : 0;
                  };
                  for (const storage of profileStorages) {
                    const questions = await (storage.readQuestions as any)(...args);
                    for (const question of questions) {
                      const key = typeof question === "string" ? question : JSON.stringify(question);
                      if (seen.has(key)) continue;
                      seen.add(key);
                      merged.push(question);
                    }
                  }
                  return merged.sort(
                    (left, right) =>
                      priorityOf(right) - priorityOf(left) ||
                      String(left?.id ?? "").localeCompare(String(right?.id ?? "")),
                  );
                };
              }
              if (prop === "readIdentityAnchor") {
                return async () => {
                  for (const storage of profileStorages) {
                    const anchor = (await storage.readIdentityAnchor()) ?? "";
                    if (anchor.trim().length > 0) return anchor;
                  }
                  return "";
                };
              }
              if (prop === "readIdentityImprovementLoops") {
                return async () => {
                  const sections: string[] = [];
                  const seen = new Set<string>();
                  for (const storage of profileStorages) {
                    const loops = ((await storage.readIdentityImprovementLoops()) ?? "").trim();
                    if (!loops || seen.has(loops)) continue;
                    seen.add(loops);
                    sections.push(loops);
                  }
                  return sections.join("\n\n");
                };
              }
              if (prop === "readContinuityIncidents") {
                return async (...args: any[]) => {
                  const limit = typeof args[0] === "number" && Number.isFinite(args[0]) ? Math.max(0, args[0]) : undefined;
                  const incidents: any[] = [];
                  const seen = new Set<string>();
                  const incidentTime = (incident: any): number => {
                    const raw = incident?.updatedAt ?? incident?.openedAt ?? incident?.createdAt;
                    const parsed = typeof raw === "string" ? Date.parse(raw) : Number.NaN;
                    return Number.isFinite(parsed) ? parsed : 0;
                  };
                  for (const storage of profileStorages) {
                    for (const incident of await (storage.readContinuityIncidents as any)(...args)) {
                      const key = JSON.stringify(incident);
                      if (seen.has(key)) continue;
                      seen.add(key);
                      incidents.push(incident);
                    }
                  }
                  incidents.sort(
                    (left, right) =>
                      incidentTime(right) - incidentTime(left) ||
                      String(left?.id ?? "").localeCompare(String(right?.id ?? "")),
                  );
                  return limit === undefined ? incidents : incidents.slice(0, limit);
                };
              }
              if (prop === "listEntityNames") {
                return async (...args: any[]) => {
                  const names = new Set<string>();
                  for (const storage of profileStorages) {
                    for (const name of await (storage.listEntityNames as any)(...args)) names.add(name);
                  }
                  return [...names];
                };
              }
              if (prop === "readEntity" || prop === "readMemoryByPath") {
                return async (...args: any[]) => {
                  for (const storage of profileStorages) {
                    const value = await (storage as any)[prop](...args);
                    if (value) return value;
                  }
                  return null;
                };
              }
              if (prop === "readAllMemories") {
                return async (...args: any[]) => {
                  const memories: any[] = [];
                  const seen = new Set<string>();
                  for (const storage of profileStorages) {
                    for (const memory of await (storage.readAllMemories as any)(...args)) {
                      const key = String(memory?.path ?? memory?.frontmatter?.id ?? JSON.stringify(memory));
                      if (seen.has(key)) continue;
                      seen.add(key);
                      memories.push(memory);
                    }
                  }
                  return memories;
                };
              }
              return target[prop];
            },
          });
    const profileStorageDirs = Array.from(
      new Set(profileStorages.map((storage) => storage.dir).filter((dir): dir is string => typeof dir === "string" && dir.length > 0)),
    );

    // --- Phase 1: Launch ALL independent data fetches in parallel ---
    throwIfRecallAborted(options.abortSignal);

    // Catalog read touch (issue #1499): record reads against the recalled
    // namespaces HERE — after the abort gate, immediately before retrieval
    // actually runs — so `lastReadAt` reflects a real read, not a recall that was
    // aborted/errored/short-circuited before reaching this point (round 3/4/6,
    // codex/cursor — no_recall, zero-limit, aborted, and pre-read-error cases).
    // `no_recall` already returned earlier, so it cannot reach here. Best-effort
    // and failure-tolerant.
    if (
      this.deps.namespaceCatalog.enabled &&
      recallResultLimit > 0 &&
      !options.abortSignal?.aborted
    ) {
      for (const ns of recallNamespaces) this.deps.storageRouter.recordRead(ns);
    }

    // 0. Shared context (v4.0, optional)
    const sharedContextPromise = (async (): Promise<string | null> => {
      if (
        !this.deps.isRecallSectionEnabled(
          "shared-context",
          resolveConversationContextCapabilities(this.deps.config).sharedContext === true,
        )
      )
        return null;
      if (!this.deps.sharedContext) return null;
      if (
        scopeProfilePlan &&
        !(
          scopeProfilePlan.profile.readOrder.includes("serverShared") &&
          scopeProfilePlan.readNamespaces.includes(this.deps.config.sharedNamespace)
        )
      )
        return null;
      const t0 = Date.now();
      const [priorities, roundtable, crossSignals] = await Promise.all([
        this.deps.sharedContext.readPriorities(),
        this.deps.sharedContext.readLatestRoundtable(),
        this.deps.sharedContext.readLatestCrossSignals(),
      ]);
      const max = Math.max(500, this.deps.config.sharedContextMaxInjectChars);
      const capSection = (
        label: string,
        body: string | null,
        limit: number,
      ): string => {
        const trimmedBody = body?.trim();
        if (!trimmedBody) return "";
        const safeLimit = Math.max(120, limit);
        const section = `${label}\n\n${trimmedBody}`;
        return section.length > safeLimit
          ? `${section.slice(0, safeLimit)}\n\n...(trimmed)\n`
          : section;
      };

      const prioritiesSection = capSection(
        "### Priorities",
        priorities,
        Math.floor(max * 0.35),
      );
      const crossSignalsSection = capSection(
        "### Latest Cross-Signals",
        crossSignals,
        Math.floor(max * 0.35),
      );
      const fixedSections = [prioritiesSection, crossSignalsSection].filter(
        (section) => section.trim().length > 0,
      );
      const fixedPrefix = ["## Shared Context", ...fixedSections].join("\n\n");
      const reserved = fixedPrefix.length + "\n\n".length;
      const roundtableBudget = Math.max(160, max - reserved);
      const roundtableSection = capSection(
        "### Latest Roundtable",
        roundtable,
        roundtableBudget,
      );
      const combined = [
        "## Shared Context",
        ...fixedSections,
        roundtableSection,
      ]
        .filter((s) => s.trim().length > 0)
        .join("\n\n");

      const trimmed =
        combined.length > max
          ? combined.slice(0, max) + "\n\n...(trimmed)\n"
          : combined;
      recordRecallSectionMetric({
        section: "sharedCtx",
        priority: "core",
        durationMs: Date.now() - t0,
        deadlineMs: recallSectionDeadlineMs,
        source: "fresh",
        success: true,
      });
      return trimmed.trim().length > 0 ? trimmed : null;
    })();

    // 1. Profile
    const profilePromise = (async (): Promise<string | null> => {
      if (!this.deps.isRecallSectionEnabled("profile")) return null;
      const t0 = Date.now();
      const profile = await profileStorage.readProfile();
      recordRecallSectionMetric({
        section: "profile",
        priority: "core",
        durationMs: Date.now() - t0,
        deadlineMs: recallSectionDeadlineMs,
        source: "fresh",
        success: true,
      });
      return profile || null;
    })();

    // 1p. Peer profile injection (issue #679 PR 3/5).
    // Reads the profile.md for the peer registered on this session and
    // injects the most-recently-updated N fields into context. Wrapped
    // in a try-catch (CLAUDE.md #13 — external I/O must not crash the
    // primary recall flow). Gate: `peerProfileRecallEnabled` must be
    // true AND `peerProfileRecallMaxFields` must be > 0 AND a peer ID
    // must be registered for this session (rule 30 — new
    // filters/transforms must have configuration gates).
    //
    // Issue #679 completion: side-channel annotation for recall X-ray.
    // We capture the peer id and injected-field count separately from
    // the promise result string so the xray snapshot builder can record
    // them without re-parsing the rendered section text.
    //
    // Three-state semantics (mirrors docs/peers.md X-ray contract):
    //   undefined — feature off, no peer registered, or maxFields=0 (field
    //               absent from snapshot — peerProfileInjection not set).
    //   null      — feature enabled + peer registered, but no profile or no
    //               fields found (snapshot carries explicit null).
    //   object    — injection occurred (snapshot carries { peerId, fieldsInjected }).
    //
    // Cursor Bugbot (PR #764): must start as `undefined` so early-return
    // paths that never enter the feature-enabled branch leave the annotation
    // absent. Starting as `null` incorrectly sets peerProfileInjection:null
    // on the snapshot even when peerProfileRecallEnabled is false.
    let peerProfileXrayAnnotation:
      | { peerId: string; fieldsInjected: number }
      | null
      | undefined = undefined;
    const peerProfileRecallPromise = (async (): Promise<string | null> => {
      if (!resolveRecallEnhancementCapabilities(this.deps.config).peerProfileRecall) return null;
      if (this.deps.config.peerProfileRecallMaxFields <= 0) return null;
      const peerId = this.deps.getPeerIdForSession(sessionKey);
      if (!peerId) return null;
      const t0 = Date.now();
      try {
        const { readPeerProfile: _readPeerProfile } = await import("../peers/index.js");
        const peerProfile = await _readPeerProfile(this.deps.config.memoryDir, peerId);
        recordRecallSectionMetric({
          section: "peerProfile",
          priority: "core",
          durationMs: Date.now() - t0,
          deadlineMs: recallSectionDeadlineMs,
          source: "fresh",
          success: true,
        });
        if (!peerProfile) {
          // Feature on + peer registered, but no profile written yet.
          // Three-state contract: explicit null = "enabled but no profile".
          peerProfileXrayAnnotation = null;
          return null;
        }
        const allFields = Object.entries(peerProfile.fields);
        if (allFields.length === 0) {
          // Profile exists but has no fields — same semantic as no profile.
          peerProfileXrayAnnotation = null;
          return null;
        }
        // Select the top-N most-recently-updated fields by consulting
        // provenance. Fields without provenance get epoch-0 ms so they
        // sort last (least recent).
        // Codex P2: parse ISO-8601 to epoch ms rather than comparing
        // strings. ISO-8601 strings with different timezone offsets
        // (e.g. "2026-04-20T00:00:00+05:00" vs "2026-04-20T00:00:00Z")
        // can order incorrectly under lexicographic comparison even
        // though they may refer to different instants. `Date.parse`
        // returns NaN on malformed input — we fall back to 0 (epoch)
        // so invalid timestamps sort last rather than causing NaN
        // comparison instability.
        const fieldsByRecency = allFields
          .map(([key, value]) => {
            const prov = peerProfile.provenance[key];
            // Find the most recent observedAt (epoch ms) across all
            // provenance entries for this field. Fall back to 0 if none
            // recorded or if all entries are malformed.
            let latestMs = 0;
            if (Array.isArray(prov) && prov.length > 0) {
              for (const p of prov) {
                if (typeof p.observedAt === "string") {
                  const parsed = Date.parse(p.observedAt);
                  if (Number.isFinite(parsed) && parsed > latestMs) {
                    latestMs = parsed;
                  }
                }
              }
            }
            return { key, value, latestMs };
          })
          // Descending: most-recently-updated first (rule 19 — sort
          // comparators must return 0 for equal items so use secondary key).
          .sort((a, b) => {
            if (b.latestMs !== a.latestMs) return b.latestMs - a.latestMs;
            return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
          });
        const capped = fieldsByRecency.slice(0, this.deps.config.peerProfileRecallMaxFields);
        const lines = capped.map(({ key, value }) => `**${key}**: ${value}`);
        // Record xray annotation: peerId + how many fields were injected.
        peerProfileXrayAnnotation = { peerId, fieldsInjected: capped.length };
        return `## Peer Profile\n\n${lines.join("\n\n")}`;
      } catch (err) {
        recordRecallSectionMetric({
          section: "peerProfile",
          priority: "core",
          durationMs: Date.now() - t0,
          deadlineMs: recallSectionDeadlineMs,
          source: "fresh",
          success: false,
          timing: `error(${err instanceof Error ? err.message : String(err)})`,
        });
        log.debug(`peer profile recall injection failed (non-fatal): ${err}`);
        return null;
      }
    })();

    // 1a. Identity continuity signals (v8.4)
    const identityContinuityPromise = (async () => {
      if (
        !this.deps.isRecallSectionEnabled(
          "identity-continuity",
          resolveIdentityContinuityCapabilities(this.deps.config).identityContinuity === true,
        )
      )
        return null;
      const t0 = Date.now();
      const section = await this.deps.buildIdentityContinuitySection({
        storage: profileStorage,
        recallMode,
        prompt: retrievalQuery,
      });
      recordRecallSectionMetric({
        section: "identityContinuity",
        priority: "core",
        durationMs: Date.now() - t0,
        deadlineMs: recallSectionDeadlineMs,
        source: "fresh",
        success: true,
      });
      return section;
    })();

    const entityRetrievalPromise = (async (): Promise<string | null> => {
      if (
        !this.deps.isRecallSectionEnabled(
          "entity-retrieval",
          resolveRecallAuxiliaryCapabilities(this.deps.config).entityRetrieval,
        )
      )
        return null;
      if (!resolveRecallAuxiliaryCapabilities(this.deps.config).entityRetrieval) return null;
      const maxChars =
        this.deps.getRecallSectionMaxChars("entity-retrieval") ??
        this.deps.config.entityRetrievalMaxChars;
      const maxHints =
        this.deps.getRecallSectionNumber("entity-retrieval", "maxHints") ??
        this.deps.config.entityRetrievalMaxHints;
      const maxSupportingFacts =
        this.deps.getRecallSectionNumber("entity-retrieval", "maxSupportingFacts") ??
        this.deps.config.entityRetrievalMaxSupportingFacts;
      const maxRelatedEntities =
        this.deps.getRecallSectionNumber("entity-retrieval", "maxRelatedEntities") ??
        this.deps.config.entityRetrievalMaxRelatedEntities;
      const recentTurns =
        this.deps.getRecallSectionNumber("entity-retrieval", "recentTurns") ??
        this.deps.config.entityRetrievalRecentTurns;
      if (maxChars === 0 || maxHints === 0 || maxSupportingFacts === 0) {
        recordRecallSectionMetric({
          section: "entityRetrieval",
          priority: "core",
          durationMs: 0,
          deadlineMs: recallSectionDeadlineMs,
          source: "skip",
          success: true,
          timing: "skip(limit=0)",
        });
        return null;
      }
      const t0 = Date.now();
      const transcriptEntries = sessionKey
        ? await readRecentEntityTranscriptEntries(
            this.deps.transcript.readRecent(
              entityRecentTranscriptLookbackHours,
              sessionKey,
            ),
            recentTurns,
          )
        : [];
      const section = await buildEntityRecallSection({
        config: this.deps.config,
        storage: profileStorage,
        namespaceStorage: (namespace) => this.deps.getStorage(namespace),
        query: retrievalQuery,
        recallNamespaces,
        recentTurns,
        maxHints,
        maxSupportingFacts,
        maxRelatedEntities,
        maxChars,
        transcriptEntries,
      }).catch((err) => {
        log.warn(`entity retrieval build failed: ${err}`);
        return null;
      });
      recordRecallSectionMetric({
        section: "entityRetrieval",
        priority: "core",
        durationMs: Date.now() - t0,
        deadlineMs: recallSectionDeadlineMs,
        source: "fresh",
        success: true,
      });
      return section;
    })();

    // 1b. Knowledge Index (v7.0)
    const knowledgeIndexPromise = (async (): Promise<{
      result: string;
      cached: boolean;
    } | null> => {
      if (
        !this.deps.isRecallSectionEnabled(
          "knowledge-index",
          resolveRecallAuxiliaryCapabilities(this.deps.config).knowledgeIndex,
        )
      )
        return null;
      if (!resolveRecallAuxiliaryCapabilities(this.deps.config).knowledgeIndex) return null;
      const t0 = Date.now();
      try {
        const knowledgeIndexMaxChars =
          this.deps.getRecallSectionNumber("knowledge-index", "maxChars") ??
          this.deps.config.knowledgeIndexMaxChars;
        const knowledgeIndexMaxEntities =
          this.deps.getRecallSectionNumber("knowledge-index", "maxEntities") ??
          this.deps.config.knowledgeIndexMaxEntities;
        const knowledgeIndexOptions = {
          maxEntities: knowledgeIndexMaxEntities,
          maxChars: knowledgeIndexMaxChars,
        };
        const ki = scopeProfilePlan
          ? await (async () => {
              const perLayerOptions = {
                ...knowledgeIndexOptions,
                maxEntities: Number.MAX_SAFE_INTEGER,
                maxChars: Number.MAX_SAFE_INTEGER,
              };
              const results = await Promise.all(
                profileStorages.map((storage) =>
                  storage.buildKnowledgeIndex(this.deps.config, perLayerOptions),
                ),
              );
              const sections = results
                .map((result) => result.result.trim())
                .filter((section) => section.length > 0);
              const maxRows = Math.max(0, Math.floor(knowledgeIndexMaxEntities));
              const rows: string[] = [];
              let header: string[] | null = null;
              for (const section of sections) {
                const lines = section
                  .split("\n")
                  .map((line) => line.trimEnd())
                  .filter((line) => line.length > 0);
                const tableHeaderIndex = lines.findIndex((line) =>
                  line.startsWith("| Entity |"),
                );
                if (tableHeaderIndex === -1) continue;
                header ??= lines.slice(0, tableHeaderIndex + 2);
                for (const row of lines.slice(tableHeaderIndex + 2)) {
                  if (!row.startsWith("|")) continue;
                  if (rows.length >= maxRows) break;
                  rows.push(row);
                }
                if (rows.length >= maxRows) break;
              }
              const merged =
                header && rows.length > 0
                  ? `${header.join("\n")}\n${rows.join("\n")}\n`
                  : "";
              return {
                result: this.deps.truncateRecallSectionToBudget(
                  merged,
                  knowledgeIndexMaxChars,
                ),
                cached: results.every((result) => result.cached),
              };
            })()
          : await this.deps.storage.buildKnowledgeIndex(this.deps.config, knowledgeIndexOptions);
        recordRecallSectionMetric({
          section: "ki",
          priority: "core",
          durationMs: Date.now() - t0,
          deadlineMs: recallSectionDeadlineMs,
          source: ki.cached ? "stale" : "fresh",
          success: true,
          timing: `${Date.now() - t0}ms${ki.cached ? " (cached)" : ""}`,
        });
        return ki.result ? ki : null;
      } catch (err) {
        recordRecallSectionMetric({
          section: "ki",
          priority: "core",
          durationMs: Date.now() - t0,
          deadlineMs: recallSectionDeadlineMs,
          source: "skip",
          success: false,
          timing: `${Date.now() - t0}ms (err)`,
        });
        log.warn(`Knowledge Index build failed: ${err}`);
        return null;
      }
    })();

    // 1c. Verbatim artifacts (v8.0 phase 1)
    const artifactsPromise = (async (): Promise<MemoryFile[]> => {
      if (
        !this.deps.isRecallSectionEnabled(
          "verbatim-artifacts",
          resolvePresentationCapabilities(this.deps.config).verbatimArtifacts === true,
        )
      )
        return [];
      if (!resolvePresentationCapabilities(this.deps.config).verbatimArtifacts) return [];
      const t0 = Date.now();
      const targetCount = computeArtifactRecallLimit(
        recallMode,
        recallResultLimit,
        this.deps.config.verbatimArtifactsMaxRecall,
      );
      if (targetCount <= 0) {
        recordRecallSectionMetric({
          section: "artifacts",
          priority: "core",
          durationMs: 0,
          deadlineMs: recallSectionDeadlineMs,
          source: "skip",
          success: true,
          timing: "skip(limit=0)",
        });
        return [];
      }
      const results = await this.deps.recallArtifactsAcrossNamespaces(
        retrievalQuery,
        recallNamespaces,
        targetCount,
      );

      recordRecallSectionMetric({
        section: "artifacts",
        priority: "core",
        durationMs: Date.now() - t0,
        deadlineMs: recallSectionDeadlineMs,
        source: "fresh",
        success: true,
      });
      return results;
    })();

    const objectiveStatePromise = (async (): Promise<string | null> => {
      const t0 = Date.now();
      if (
        !resolveObjectiveStateCapabilities(this.deps.config).objectiveStateMemory ||
        !resolveObjectiveStateCapabilities(this.deps.config).objectiveStateRecall ||
        !this.deps.isRecallSectionEnabled(
          "objective-state",
          resolveObjectiveStateCapabilities(this.deps.config).objectiveStateRecall === true,
        )
      ) {
        recordRecallSectionMetric({
          section: "objectiveState",
          priority: "core",
          durationMs: 0,
          deadlineMs: recallSectionDeadlineMs,
          source: "skip",
          success: true,
          timing: "skip",
        });
        return null;
      }
      const maxResults =
        this.deps.getRecallSectionNumber("objective-state", "maxResults") ?? 4;
      if (maxResults <= 0) {
        recordRecallSectionMetric({
          section: "objectiveState",
          priority: "core",
          durationMs: 0,
          deadlineMs: recallSectionDeadlineMs,
          source: "skip",
          success: true,
          timing: "skip(limit=0)",
        });
        return null;
      }

      const objectiveStateSearches = await Promise.all(
        recallNamespaces.map(async (namespace) => {
          const storage = resolveNamespaceCapabilities(this.deps.config).namespaces
            ? await this.deps.getStorage(namespace)
            : null;
          return searchObjectiveStateSnapshots({
            memoryDir: resolveNamespaceCapabilities(this.deps.config).namespaces
              ? storage!.dir
              : this.deps.config.memoryDir,
            objectiveStateStoreDir: objectiveStateStoreOverrideForNamespace({
              memoryDir: this.deps.config.memoryDir,
              configuredStoreDir: this.deps.config.objectiveStateStoreDir,
              namespacesEnabled: resolveNamespaceCapabilities(this.deps.config).namespaces,
              namespace,
            }),
            query: retrievalQuery,
            maxResults,
            sessionKey,
          });
        }),
      );
      const results = objectiveStateSearches
        .flat()
        .sort((left, right) => {
          if (right.score !== left.score) return right.score - left.score;
          return right.snapshot.recordedAt.localeCompare(left.snapshot.recordedAt);
        })
        .slice(0, maxResults);

      recordRecallSectionMetric({
        section: "objectiveState",
        priority: "core",
        durationMs: Date.now() - t0,
        deadlineMs: recallSectionDeadlineMs,
        source: "fresh",
        success: true,
      });
      return results.length > 0
        ? this.deps.formatObjectiveStateResults(results)
        : null;
    })();

    const causalTrajectoryPromise = (async (): Promise<string | null> => {
      const t0 = Date.now();
      if (
        !resolveRecallEnhancementCapabilities(this.deps.config).causalTrajectoryMemory ||
        !resolveRecallEnhancementCapabilities(this.deps.config).causalTrajectoryRecall ||
        !this.deps.isRecallSectionEnabled(
          "causal-trajectories",
          resolveRecallEnhancementCapabilities(this.deps.config).causalTrajectoryRecall === true,
        )
      ) {
        recordRecallSectionMetric({
          section: "causalTrajectories",
          priority: "core",
          durationMs: 0,
          deadlineMs: recallSectionDeadlineMs,
          source: "skip",
          success: true,
          timing: "skip",
        });
        return null;
      }
      const maxResults =
        this.deps.getRecallSectionNumber("causal-trajectories", "maxResults") ?? 3;
      if (maxResults <= 0) {
        recordRecallSectionMetric({
          section: "causalTrajectories",
          priority: "core",
          durationMs: 0,
          deadlineMs: recallSectionDeadlineMs,
          source: "skip",
          success: true,
          timing: "skip(limit=0)",
        });
        return null;
      }

      const results = await searchCausalTrajectories({
        memoryDir: this.deps.config.memoryDir,
        causalTrajectoryStoreDir: this.deps.config.causalTrajectoryStoreDir,
        query: retrievalQuery,
        maxResults,
        sessionKey,
      });

      recordRecallSectionMetric({
        section: "causalTrajectories",
        priority: "core",
        durationMs: Date.now() - t0,
        deadlineMs: recallSectionDeadlineMs,
        source: "fresh",
        success: true,
      });
      return results.length > 0
        ? this.deps.formatCausalTrajectoryResults(results)
        : null;
    })();

    const cmcRetrievalPromise = (async (): Promise<string | null> => {
      const t0 = Date.now();
      if (
        !resolveRecallEnhancementCapabilities(this.deps.config).cmcRetrieval ||
        !this.deps.isRecallSectionEnabled(
          "cmc-causal-chains",
          resolveRecallEnhancementCapabilities(this.deps.config).cmcRetrieval === true,
        )
      ) {
        recordRecallSectionMetric({
          section: "cmcCausalChains",
          priority: "core",
          durationMs: 0,
          deadlineMs: recallSectionDeadlineMs,
          source: "skip",
          success: true,
          timing: "skip",
        });
        return null;
      }
      try {
        const { retrieveCausalChains } = await import("../causal-retrieval.js");
        const section = await retrieveCausalChains({
          memoryDir: this.deps.config.memoryDir,
          causalTrajectoryStoreDir: this.deps.config.causalTrajectoryStoreDir,
          query: retrievalQuery,
          sessionKey,
          config: {
            maxDepth: this.deps.config.cmcRetrievalMaxDepth,
            maxChars: this.deps.config.cmcRetrievalMaxChars,
            counterfactualBoost: this.deps.config.cmcRetrievalCounterfactualBoost,
          },
        });
        recordRecallSectionMetric({
          section: "cmcCausalChains",
          priority: "core",
          durationMs: Date.now() - t0,
          deadlineMs: recallSectionDeadlineMs,
          source: "fresh",
          success: true,
        });
        return section;
      } catch (err) {
        log.warn("[cmc] causal retrieval failed (non-fatal)", err);
        recordRecallSectionMetric({
          section: "cmcCausalChains",
          priority: "core",
          durationMs: Date.now() - t0,
          deadlineMs: recallSectionDeadlineMs,
          source: "skip",
          success: false,
          timing: "error",
        });
        return null;
      }
    })();

    const calibrationPromise = (async (): Promise<string | null> => {
      const t0 = Date.now();
      if (
        !resolveConsolidationCapabilities(this.deps.config).calibration ||
        !this.deps.isRecallSectionEnabled(
          "calibration-rules",
          resolveConsolidationCapabilities(this.deps.config).calibration === true,
        )
      ) {
        recordRecallSectionMetric({
          section: "calibrationRules",
          priority: "core",
          durationMs: 0,
          deadlineMs: recallSectionDeadlineMs,
          source: "skip",
          success: true,
          timing: "skip",
        });
        return null;
      }
      try {
        const { getCalibrationRulesForRecall, buildCalibrationRecallSection } =
          await import("../calibration.js");
        const rules = await getCalibrationRulesForRecall(this.deps.config.memoryDir);
        if (rules.length === 0) {
          recordRecallSectionMetric({
            section: "calibrationRules",
            priority: "core",
            durationMs: Date.now() - t0,
            deadlineMs: recallSectionDeadlineMs,
            source: "skip",
            success: true,
            timing: "skip(no-rules)",
          });
          return null;
        }
        const section = buildCalibrationRecallSection(
          rules.slice(0, this.deps.config.calibrationMaxRulesPerRecall),
          retrievalQuery,
          this.deps.config.calibrationMaxChars,
        );
        recordRecallSectionMetric({
          section: "calibrationRules",
          priority: "core",
          durationMs: Date.now() - t0,
          deadlineMs: recallSectionDeadlineMs,
          source: "fresh",
          success: true,
        });
        return section;
      } catch (err) {
        log.warn("[calibration] recall section failed (non-fatal)", err);
        recordRecallSectionMetric({
          section: "calibrationRules",
          priority: "core",
          durationMs: Date.now() - t0,
          deadlineMs: recallSectionDeadlineMs,
          source: "skip",
          success: false,
          timing: "error",
        });
        return null;
      }
    })();

    const trustZonePromise = (async (): Promise<string | null> => {
      const t0 = Date.now();
      if (
        !resolveSecurityCapabilities(this.deps.config).trustZones ||
        !resolveSecurityCapabilities(this.deps.config).trustZoneRecall ||
        !this.deps.isRecallSectionEnabled(
          "trust-zones",
          resolveSecurityCapabilities(this.deps.config).trustZoneRecall === true,
        )
      ) {
        recordRecallSectionMetric({
          section: "trustZones",
          priority: "core",
          durationMs: 0,
          deadlineMs: recallSectionDeadlineMs,
          source: "skip",
          success: true,
          timing: "skip",
        });
        return null;
      }
      const maxResults =
        this.deps.getRecallSectionNumber("trust-zones", "maxResults") ?? 3;
      if (maxResults <= 0) {
        recordRecallSectionMetric({
          section: "trustZones",
          priority: "core",
          durationMs: 0,
          deadlineMs: recallSectionDeadlineMs,
          source: "skip",
          success: true,
          timing: "skip(limit=0)",
        });
        return null;
      }

      const results = await searchTrustZoneRecords({
        memoryDir: this.deps.config.memoryDir,
        trustZoneStoreDir: this.deps.config.trustZoneStoreDir,
        query: retrievalQuery,
        maxResults,
        sessionKey,
      });

      recordRecallSectionMetric({
        section: "trustZones",
        priority: "core",
        durationMs: Date.now() - t0,
        deadlineMs: recallSectionDeadlineMs,
        source: "fresh",
        success: true,
      });
      return results.length > 0 ? this.deps.formatTrustZoneResults(results) : null;
    })();

    const harmonicRetrievalAbort = createEnrichmentAbortHandle(
      options.abortSignal,
    );
    const harmonicRetrievalPromise = observeEnrichmentPromise(
      (async (): Promise<string | null> => {
        const t0 = Date.now();
        if (
          !caps.harmonicRetrieval ||
          !this.deps.isRecallSectionEnabled(
            "harmonic-retrieval",
            caps.harmonicRetrieval,
          )
        ) {
          recordRecallSectionMetric({
            section: "harmonicRetrieval",
            priority: "enrichment",
            durationMs: 0,
            deadlineMs: enrichmentSectionDeadlineMs,
            source: "skip",
            success: true,
            timing: "skip",
          });
          return null;
        }
        const maxResults =
          this.deps.getRecallSectionNumber("harmonic-retrieval", "maxResults") ?? 3;
        if (maxResults <= 0) {
          recordRecallSectionMetric({
            section: "harmonicRetrieval",
            priority: "enrichment",
            durationMs: 0,
            deadlineMs: enrichmentSectionDeadlineMs,
            source: "skip",
            success: true,
            timing: "skip(limit=0)",
          });
          return null;
        }

        const harmonicSearchDirs = scopeProfilePlan ? profileStorageDirs : [this.deps.config.memoryDir];
        const harmonicResultsByDir = await Promise.all(
          harmonicSearchDirs.map((memoryDir) =>
            searchHarmonicRetrieval({
              memoryDir,
              abstractionNodeStoreDir: scopeProfilePlan ? undefined : this.deps.config.abstractionNodeStoreDir,
              query: retrievalQuery,
              maxResults,
              sessionKey,
              anchorsEnabled: resolveConsolidationCapabilities(this.deps.config).abstractionAnchors,
              abortSignal: harmonicRetrievalAbort.signal,
            }),
          ),
        );
        const harmonicByNodeId = new Map<string, HarmonicRetrievalResult>();
        for (const result of harmonicResultsByDir.flat()) {
          const existing = harmonicByNodeId.get(result.node.nodeId);
          if (!existing || result.score > existing.score) {
            harmonicByNodeId.set(result.node.nodeId, result);
          }
        }
        const results = [...harmonicByNodeId.values()]
          .sort(
            (left, right) =>
              right.score - left.score ||
              right.anchorScore - left.anchorScore ||
              right.node.recordedAt.localeCompare(left.node.recordedAt) ||
              left.node.nodeId.localeCompare(right.node.nodeId),
          )
          .slice(0, maxResults);

        recordRecallSectionMetric({
          section: "harmonicRetrieval",
          priority: "enrichment",
          durationMs: Date.now() - t0,
          deadlineMs: enrichmentSectionDeadlineMs,
          source: "fresh",
          success: true,
        });
        return results.length > 0
          ? this.deps.formatHarmonicRetrievalResults(results)
          : null;
      })().finally(() => harmonicRetrievalAbort.dispose()),
      () => harmonicRetrievalAbort.cancel(),
    );

    // Verified recall and semantic rules both need readAllMemories().
    // Instead of a shared preload (which has namespace/dir mismatch issues),
    // each subsystem calls readAllMemories() on its correct storage instance.
    // The version-keyed hot-memories cache (keyed by baseDir + the corpus
    // version sentinel, issue #1902) serves repeat reads within a version epoch
    // from memory, so these subsystems share one disk scan; a memory write
    // between recalls bumps the corpus version and forces exactly one rescan.

    const verifiedRecallPromise = (async (): Promise<string | null> => {
      const t0 = Date.now();
      if (
        !resolveRecallAuxiliaryCapabilities(this.deps.config).verifiedRecall ||
        !this.deps.isRecallSectionEnabled(
          "verified-episodes",
          resolveRecallAuxiliaryCapabilities(this.deps.config).verifiedRecall === true,
        )
      ) {
        recordRecallSectionMetric({
          section: "verifiedRecall",
          priority: "core",
          durationMs: 0,
          deadlineMs: recallSectionDeadlineMs,
          source: "skip",
          success: true,
          timing: "skip",
        });
        return null;
      }
      const maxResults =
        this.deps.getRecallSectionNumber("verified-episodes", "maxResults") ?? 3;
      if (maxResults <= 0) {
        recordRecallSectionMetric({
          section: "verifiedRecall",
          priority: "core",
          durationMs: 0,
          deadlineMs: recallSectionDeadlineMs,
          source: "skip",
          success: true,
          timing: "skip(limit=0)",
        });
        return null;
      }

      const VERIFIED_RECALL_TIMEOUT_MS = 15_000;
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      const results = await Promise.race([
        Promise.all(
          profileStorageDirs.map((memoryDir) =>
            searchVerifiedEpisodes({
              memoryDir,
              query: retrievalQuery,
              maxResults,
              boxRecallDays: this.deps.config.boxRecallDays,
              hotMemoriesCacheEnabled: this.deps.config.hotMemoriesCacheEnabled,
            }).catch((err) => {
              log.debug(`verified recall directory scan failed: ${err}`);
              return [] as VerifiedEpisodeResult[];
            }),
          ),
        ).then((groups) => {
          const merged: VerifiedEpisodeResult[] = [];
          const seen = new Set<string>();
          for (const result of groups.flat()) {
            const key = result.box.id || JSON.stringify(result);
            if (seen.has(key)) continue;
            seen.add(key);
            merged.push(result);
          }
          return merged.sort(compareVerifiedEpisodeResults).slice(0, maxResults);
        }),
        new Promise<[]>((resolve) => {
          timeoutHandle = setTimeout(
            () => resolve([]),
            VERIFIED_RECALL_TIMEOUT_MS,
          );
        }),
      ]).catch(() => [] as VerifiedEpisodeResult[]);
      if (timeoutHandle) clearTimeout(timeoutHandle);

      const durationMs = Date.now() - t0;
      if (durationMs >= VERIFIED_RECALL_TIMEOUT_MS) {
        log.debug(
          `verified recall: timed out after ${VERIFIED_RECALL_TIMEOUT_MS}ms`,
        );
      }
      recordRecallSectionMetric({
        section: "verifiedRecall",
        priority: "core",
        durationMs,
        deadlineMs: VERIFIED_RECALL_TIMEOUT_MS,
        source: "fresh",
        success: true,
      });
      return results.length > 0
        ? this.deps.formatVerifiedEpisodeResults(results)
        : null;
    })();

    const verifiedRulesPromise = (async (): Promise<string | null> => {
      const t0 = Date.now();
      if (
        !resolveRecallAuxiliaryCapabilities(this.deps.config).semanticRuleVerification ||
        !this.deps.isRecallSectionEnabled(
          "verified-rules",
          resolveRecallAuxiliaryCapabilities(this.deps.config).semanticRuleVerification === true,
        )
      ) {
        recordRecallSectionMetric({
          section: "verifiedRules",
          priority: "core",
          durationMs: 0,
          deadlineMs: recallSectionDeadlineMs,
          source: "skip",
          success: true,
          timing: "skip",
        });
        return null;
      }
      const maxResults =
        this.deps.getRecallSectionNumber("verified-rules", "maxResults") ?? 3;
      if (maxResults <= 0) {
        recordRecallSectionMetric({
          section: "verifiedRules",
          priority: "core",
          durationMs: 0,
          deadlineMs: recallSectionDeadlineMs,
          source: "skip",
          success: true,
          timing: "skip(limit=0)",
        });
        return null;
      }

      const VERIFIED_RULES_TIMEOUT_MS = 15_000;
      let rulesTimeoutHandle: ReturnType<typeof setTimeout> | undefined;
      const results = await Promise.race([
        Promise.all(
          profileStorageDirs.map((memoryDir) =>
            searchVerifiedSemanticRules({
              memoryDir,
              query: retrievalQuery,
              maxResults,
              hotMemoriesCacheEnabled: this.deps.config.hotMemoriesCacheEnabled,
            }).catch((err) => {
              log.debug(`verified rules directory scan failed: ${err}`);
              return [] as VerifiedSemanticRuleResult[];
            }),
          ),
        ).then((groups) => {
          const merged: VerifiedSemanticRuleResult[] = [];
          const seen = new Set<string>();
          for (const result of groups.flat()) {
            const key = result.rule.frontmatter.id || result.rule.path || JSON.stringify(result);
            if (seen.has(key)) continue;
            seen.add(key);
            merged.push(result);
          }
          return merged.sort(compareVerifiedSemanticRuleResults).slice(0, maxResults);
        }),
        new Promise<[]>((resolve) => {
          rulesTimeoutHandle = setTimeout(
            () => resolve([]),
            VERIFIED_RULES_TIMEOUT_MS,
          );
        }),
      ]).catch(() => [] as VerifiedSemanticRuleResult[]);
      if (rulesTimeoutHandle) clearTimeout(rulesTimeoutHandle);

      const durationMs = Date.now() - t0;
      if (durationMs >= VERIFIED_RULES_TIMEOUT_MS) {
        log.debug(
          `verified rules: timed out after ${VERIFIED_RULES_TIMEOUT_MS}ms`,
        );
      }
      recordRecallSectionMetric({
        section: "verifiedRules",
        priority: "core",
        durationMs,
        deadlineMs: VERIFIED_RULES_TIMEOUT_MS,
        source: "fresh",
        success: true,
      });
      return results.length > 0
        ? this.deps.formatVerifiedSemanticRuleResults(results)
        : null;
    })();

    const workProductsPromise = (async (): Promise<string | null> => {
      const t0 = Date.now();
      if (
        !resolveCreationMemoryCapabilities(this.deps.config).creationMemory ||
        !resolveRecallAuxiliaryCapabilities(this.deps.config).workProductRecall ||
        !this.deps.isRecallSectionEnabled(
          "work-products",
          resolveRecallAuxiliaryCapabilities(this.deps.config).workProductRecall === true,
        )
      ) {
        recordRecallSectionMetric({
          section: "workProducts",
          priority: "core",
          durationMs: 0,
          deadlineMs: recallSectionDeadlineMs,
          source: "skip",
          success: true,
          timing: "skip",
        });
        return null;
      }
      const maxResults =
        this.deps.getRecallSectionNumber("work-products", "maxResults") ?? 3;
      if (maxResults <= 0) {
        recordRecallSectionMetric({
          section: "workProducts",
          priority: "core",
          durationMs: 0,
          deadlineMs: recallSectionDeadlineMs,
          source: "skip",
          success: true,
          timing: "skip(limit=0)",
        });
        return null;
      }

      const workProductSearchDirs = scopeProfilePlan ? profileStorageDirs : [this.deps.config.memoryDir];
      const workProductResultsByDir = await Promise.all(
        workProductSearchDirs.map((memoryDir) =>
          searchWorkProductLedgerEntries({
            memoryDir,
            workProductLedgerDir: scopeProfilePlan ? undefined : this.deps.config.workProductLedgerDir,
            query: retrievalQuery,
            maxResults,
            sessionKey,
          }),
        ),
      );
      const workProductByEntryId = new Map<string, WorkProductLedgerSearchResult>();
      for (const result of workProductResultsByDir.flat()) {
        const existing = workProductByEntryId.get(result.entry.entryId);
        if (!existing || result.score > existing.score) {
          workProductByEntryId.set(result.entry.entryId, result);
        }
      }
      const results = [...workProductByEntryId.values()]
        .sort(
          (left, right) =>
            right.score - left.score ||
            right.entry.recordedAt.localeCompare(left.entry.recordedAt) ||
            left.entry.entryId.localeCompare(right.entry.entryId),
        )
        .slice(0, maxResults);

      recordRecallSectionMetric({
        section: "workProducts",
        priority: "core",
        durationMs: Date.now() - t0,
        deadlineMs: recallSectionDeadlineMs,
        source: "fresh",
        success: true,
      });
      return results.length > 0 ? this.deps.formatWorkProductResults(results) : null;
    })();

    const queryAwarePrefilterPromise =
      (async (): Promise<QueryAwarePrefilter> => {
        const t0 = Date.now();
        if (!resolveIndexingCapabilities(this.deps.config).queryAwareIndexing || !prompt.trim()) {
          recordRecallSectionMetric({
            section: "queryAware",
            priority: "enrichment",
            durationMs: 0,
            deadlineMs: enrichmentSectionDeadlineMs,
            source: "skip",
            success: true,
            timing: "skip",
          });
          return {
            candidatePaths: null,
            temporalFromDate: null,
            matchedTags: [],
            expandedTags: [],
            combination: "none",
            filteredToFullSearch: false,
          };
        }

        const prefilter = await this.deps.buildQueryAwarePrefilter(
          retrievalQuery,
          recallNamespaces,
        );
        const candidateCount = prefilter.candidatePaths?.size ?? 0;
        const temporalLabel = prefilter.temporalFromDate ?? "-";
        const tagLabel =
          prefilter.expandedTags.length > 0
            ? prefilter.expandedTags.join("|")
            : "-";
        const fallbackLabel = prefilter.filteredToFullSearch
          ? "/full-search"
          : "";
        recordRecallSectionMetric({
          section: "queryAware",
          priority: "enrichment",
          durationMs: Date.now() - t0,
          deadlineMs: enrichmentSectionDeadlineMs,
          source: prefilter.filteredToFullSearch ? "stale" : "fresh",
          success: true,
          timing: `${Date.now() - t0}ms(${prefilter.combination}${fallbackLabel};count=${candidateCount};time=${temporalLabel};tags=${tagLabel})`,
        });
        return prefilter;
      })();

    // 2. QMD search (the slow part — runs in parallel with preamble)
    type QmdPhaseResult = {
      memoryResultsLists: QmdSearchResult[][];
      globalResults: QmdSearchResult[];
      /** Top QMD score BEFORE contextual weight scaling from the agent merge.
       * Used by the confidence gate so that enabling parallel retrieval doesn't
       * silently lower scores below the calibrated gate threshold. */
      preAugmentTopScore: number;
      /** Max score from direct + temporal agents (post-weight) BEFORE merge.
       * Included in the confidence gate so that strong specialized hits (e.g.
       * an exact entity-name match) are not discarded just because the QMD
       * contextual pass returned a weak result. */
      maxSpecializedScore: number;
      /**
       * Degradations observed while producing this phase result (#1536).
       * Cached WITH the result so cache hits replay them — a served-from-
       * cache partial result must still explain why it is partial (codex
       * round-4 review on #1544).
       */
      degradations?: SearchDegradation[];
    } | null;

    const qmdEnrichmentAbort = createEnrichmentAbortHandle(options.abortSignal);
    const qmdPromise = observeEnrichmentPromise(
      (async (): Promise<QmdPhaseResult> => {
        const t0 = Date.now();
        // Degradation accounting for this phase (#1536): everything pushed
        // after this mark belongs to this phase and is cached with its
        // result; cache hits and stale fallbacks replay stored degradations
        // so served-from-cache results still explain their gaps, and every
        // path that skips QMD entirely reports backend_unavailable.
        const phaseDegradationsStart = backendDegradations.length;
        const replayCachedDegradations = (value: {
          degradations?: SearchDegradation[];
        }) => {
          for (const degradation of value.degradations ?? []) {
            backendDegradations.push(degradation);
          }
        };
        const reportRecallQmdUnavailable = (detail: string) => {
          backendDegradations.push({
            backend: "qmd",
            code: "backend_unavailable",
            detail,
          });
        };
        if (recallResultLimit <= 0) {
          recordRecallSectionMetric({
            section: "qmd",
            priority: "enrichment",
            durationMs: Date.now() - t0,
            deadlineMs: enrichmentSectionDeadlineMs,
            source: "skip",
            success: true,
            timing: "skip(limit=0)",
          });
          return null;
        }

        const qmdCacheKey = buildQmdRecallCacheKey({
          query: retrievalQuery,
          namespaces: recallNamespaces,
          recallMode,
          maxResults: qmdFetchLimit,
          memoryDir: this.deps.config.memoryDir,
          searchOptions: qmdSearchOptions,
          searchStrategy: this.deps.config.qmdSearchStrategy,
          subprocessStrategy: this.deps.config.qmdSubprocessStrategy,
        });
        const cachedQmd = getCachedQmdRecall<Exclude<QmdPhaseResult, null>>(
          qmdCacheKey,
          {
            freshTtlMs: this.deps.config.qmdRecallCacheTtlMs ?? 60_000,
            staleTtlMs: this.deps.config.qmdRecallCacheStaleTtlMs ?? 10 * 60_000,
          },
        );
        const staleQmdFallback =
          cachedQmd?.source === "stale" ? cachedQmd : null;
        const queryAwarePrefilter = await queryAwarePrefilterPromise;
        const queryAwarePrefilterIsEmpty =
          queryAwarePrefilter.candidatePaths?.size === 0;
        const emptyQueryAwareQmdResult: Exclude<QmdPhaseResult, null> = {
          memoryResultsLists: [[]],
          globalResults: [],
          preAugmentTopScore: 0,
          maxSpecializedScore: 0,
        };
        if (cachedQmd?.source === "fresh") {
          recordRecallSectionMetric({
            section: "qmd",
            priority: "enrichment",
            durationMs: Date.now() - t0,
            deadlineMs: enrichmentSectionDeadlineMs,
            source: cachedQmd.source,
            success: true,
            timing: `${Math.max(0, Math.round(cachedQmd.ageMs))}ms-cache`,
          });
          replayCachedDegradations(cachedQmd.value);
          if (queryAwarePrefilterIsEmpty) {
            return emptyQueryAwareQmdResult;
          }
          return cachedQmd.value;
        }

        if (!this.deps.qmd.isAvailable()) {
          const now = Date.now();
          const QMD_REPROBE_COOLDOWN_MS = 60_000;
          if (
            this.deps.lastQmdReprobeAtMs &&
            now - this.deps.lastQmdReprobeAtMs < QMD_REPROBE_COOLDOWN_MS
          ) {
            if (staleQmdFallback) {
              recordRecallSectionMetric({
                section: "qmd",
                priority: "enrichment",
                durationMs: Date.now() - t0,
                deadlineMs: enrichmentSectionDeadlineMs,
                source: "stale",
                success: true,
                timing: `stale-cache(reprobe-cooldown:${Math.max(0, Math.round(staleQmdFallback.ageMs))}ms)`,
              });
              reportRecallQmdUnavailable("served stale recall cache (reprobe cooldown)");
              replayCachedDegradations(staleQmdFallback.value);
              if (queryAwarePrefilterIsEmpty) {
                return emptyQueryAwareQmdResult;
              }
              return staleQmdFallback.value;
            }
            recordRecallSectionMetric({
              section: "qmd",
              priority: "enrichment",
              durationMs: Date.now() - t0,
              deadlineMs: enrichmentSectionDeadlineMs,
              source: "skip",
              success: true,
              timing: "skip(reprobe-cooldown)",
            });
            reportRecallQmdUnavailable("recall skipped QMD (reprobe cooldown)");
            return null;
          }
          this.deps.lastQmdReprobeAtMs = now;
          const reprobed = await this.deps.qmd.probe();
          if (!reprobed) {
            if (staleQmdFallback) {
              recordRecallSectionMetric({
                section: "qmd",
                priority: "enrichment",
                durationMs: Date.now() - t0,
                deadlineMs: enrichmentSectionDeadlineMs,
                source: "stale",
                success: true,
                timing: `stale-cache(reprobe-failed:${Math.max(0, Math.round(staleQmdFallback.ageMs))}ms)`,
              });
              reportRecallQmdUnavailable("served stale recall cache (reprobe failed)");
              replayCachedDegradations(staleQmdFallback.value);
              if (queryAwarePrefilterIsEmpty) {
                return emptyQueryAwareQmdResult;
              }
              return staleQmdFallback.value;
            }
            recordRecallSectionMetric({
              section: "qmd",
              priority: "enrichment",
              durationMs: Date.now() - t0,
              deadlineMs: enrichmentSectionDeadlineMs,
              source: "skip",
              success: true,
              timing: "skip",
            });
            log.debug(
              `Search skip (re-probe failed): ${this.deps.qmd.debugStatus()}`,
            );
            reportRecallQmdUnavailable("recall skipped QMD (reprobe failed)");
            return null;
          }
          log.info(`QMD re-probe succeeded: ${this.deps.qmd.debugStatus()}`);
        }

        const maxPerAgent = this.deps.config.parallelMaxResultsPerAgent;
        const specializedAgentPromise: Promise<
          [ParallelSearchResult[], ParallelSearchResult[]]
        > | null =
          !queryAwarePrefilterIsEmpty &&
          caps.parallelRetrieval && maxPerAgent > 0
            ? Promise.all([
                shouldRunAgent("direct", retrievalQuery, 0)
                  ? Promise.all(
                      profileStorageDirs.map((memoryDir) =>
                        runDirectAgent(
                          retrievalQuery,
                          memoryDir,
                          maxPerAgent,
                          (p) => this.deps.namespaceFromPath(p),
                        ).catch((err) => {
                          log.debug(`DirectAgent pre-start failed: ${err}`);
                          return [] as ParallelSearchResult[];
                        }),
                      ),
                    ).then((groups) => {
                      const merged: ParallelSearchResult[] = [];
                      const seen = new Set<string>();
                      for (const result of groups.flat()) {
                        const key = `${(result as any).namespace ?? ""}\0${(result as any).path ?? JSON.stringify(result)}`;
                        if (seen.has(key)) continue;
                        seen.add(key);
                        merged.push(result);
                      }
                      return merged
                        .sort((a, b) => b.score - a.score)
                        .slice(0, maxPerAgent);
                    })
                  : Promise.resolve([] as ParallelSearchResult[]),
                shouldRunAgent("temporal", retrievalQuery, 0)
                  ? Promise.all(
                      profileStorageDirs.map((memoryDir) =>
                        runTemporalAgent(
                          retrievalQuery,
                          memoryDir,
                          maxPerAgent,
                          queryAwarePrefilter.candidatePaths,
                          (p) => this.deps.namespaceFromPath(p),
                        ).catch((err) => {
                          log.debug(`TemporalAgent pre-start failed for ${memoryDir}: ${err}`);
                          return [] as ParallelSearchResult[];
                        }),
                      ),
                    ).then((groups) => {
                      const merged: ParallelSearchResult[] = [];
                      const seen = new Set<string>();
                      for (const result of groups.flat()) {
                        const key = `${(result as any).namespace ?? ""}\0${(result as any).path ?? JSON.stringify(result)}`;
                        if (seen.has(key)) continue;
                        seen.add(key);
                        merged.push(result);
                      }
                      return merged
                        .sort((a, b) => b.score - a.score)
                        .slice(0, maxPerAgent);
                    })
                  : Promise.resolve([] as ParallelSearchResult[]),
              ])
            : null;

        try {
          const filteredResults =
            await this.deps.fetchQmdMemoryResultsWithArtifactTopUp(
              retrievalQuery,
              qmdFetchLimit,
              qmdHybridFetchLimit,
              {
                namespacesEnabled: resolveNamespaceCapabilities(this.deps.config).namespaces,
                recallNamespaces,
                resolveNamespace: (p) => this.deps.namespaceFromPath(p),
                queryAwarePrefilter,
                searchOptions: qmdSearchOptions,
                abortSignal: qmdEnrichmentAbort.signal,
                onDegradation: (degradation) => {
                  backendDegradations.push(degradation);
                },
                onDebugSnapshot: async (snapshot) => {
                  await this.deps.recordLastQmdRecallSnapshot({
                    storage: profileStorage,
                    snapshot,
                  });
                },
              },
            );

          const preAugmentTopScore =
            filteredResults.length > 0
              ? Math.max(...filteredResults.map((r) => r.score))
              : 0;
          let augmentedResults = filteredResults;
          let maxSpecializedScore = 0;
          if (caps.parallelRetrieval && specializedAgentPromise) {
            try {
              const [directResults, temporalResults] =
                await specializedAgentPromise;
              if (filteredResults.length > 0) {
                const w = this.deps.config.parallelAgentWeights;
                maxSpecializedScore = Math.max(
                  directResults.length > 0
                    ? Math.max(...directResults.map((r) => r.score * w.direct))
                    : 0,
                  temporalResults.length > 0
                    ? Math.max(
                        ...temporalResults.map((r) => r.score * w.temporal),
                      )
                    : 0,
                );
                const lifecycleHeadroom =
                  this.deps.config.parallelMaxResultsPerAgent * 2;
                augmentedResults = await mergeWithAgentResults(
                  filteredResults,
                  directResults,
                  temporalResults,
                  this.deps.config.parallelAgentWeights,
                  qmdFetchLimit + lifecycleHeadroom,
                  this.deps.config.memoryDir,
                  // Derive agent-hit namespace so a same (namespace,path) memory merges once (#2020).
                  (p) => this.deps.namespaceFromPath(p),
                );
              }
            } catch (err) {
              log.debug(
                `parallelRetrieval augmentation failed, using base results: ${err}`,
              );
              maxSpecializedScore = 0;
            }
          }

          const phaseDegradations = backendDegradations.slice(
            phaseDegradationsStart,
          );
          const result = {
            memoryResultsLists: [augmentedResults],
            globalResults: [],
            preAugmentTopScore,
            maxSpecializedScore,
            ...(phaseDegradations.length > 0
              ? { degradations: phaseDegradations }
              : {}),
          };
          if (
            augmentedResults.length > 0 ||
            result.globalResults.length > 0
          ) {
            setCachedQmdRecall(qmdCacheKey, result, {
              maxEntries: this.deps.config.qmdRecallCacheMaxEntries ?? 128,
            });
          }
          recordRecallSectionMetric({
            section: "qmd",
            priority: "enrichment",
            durationMs: Date.now() - t0,
            deadlineMs: enrichmentSectionDeadlineMs,
            source: "fresh",
            success: true,
          });
          return result;
        } catch (err) {
          if (staleQmdFallback) {
            recordRecallSectionMetric({
              section: "qmd",
              priority: "enrichment",
              durationMs: Date.now() - t0,
              deadlineMs: enrichmentSectionDeadlineMs,
              source: "stale",
              success: true,
              timing: `stale-cache(${err instanceof Error ? err.message : String(err)})`,
            });
            reportRecallQmdUnavailable("served stale recall cache (qmd phase error)");
            replayCachedDegradations(staleQmdFallback.value);
            if (queryAwarePrefilterIsEmpty) {
              return emptyQueryAwareQmdResult;
            }
            return staleQmdFallback.value;
          }
          throw err;
        }
      })()
        .catch((err): QmdPhaseResult => {
          if (options.abortSignal?.aborted) {
            log.debug(
              `recall phase-1 enrichment [qmd]: skipped after abort at +${Date.now() - phase1Start}ms`,
            );
            return null;
          }
          log.warn(
            `recall phase-1 enrichment [qmd] failed open: ${err instanceof Error ? err.message : String(err)}`,
          );
          return null;
        })
        .finally(() => qmdEnrichmentAbort.dispose()),
      () => {
        // The enrichment budget abandoned the hot QMD phase mid-flight
        // (#1536, codex round-7 on #1544): QmdClient treats this abort as
        // caller cancellation and never reports, so report the abandonment
        // deterministically here — the exact mirror of the cold-tier
        // deadline gate. Guarded: a CALLER abort also routes through this
        // cancel callback, and an aborted recall is not a backend
        // degradation (no snapshot is recorded for it anyway).
        if (!options.abortSignal?.aborted) {
          backendDegradations.push({
            backend: "qmd",
            code: "deadline_exceeded",
            detail: "hot qmd enrichment abandoned (enrichment deadline)",
          });
        }
        qmdEnrichmentAbort.cancel();
      },
    );

    const transcriptPromise = (async (): Promise<string | null> => {
      const t0 = Date.now();
      if (
        !resolvePresentationCapabilities(this.deps.config).transcript ||
        !this.deps.isRecallSectionEnabled("transcript", true)
      ) {
        recordRecallSectionMetric({
          section: "transcript",
          priority: "core",
          durationMs: 0,
          deadlineMs: recallSectionDeadlineMs,
          source: "skip",
          success: true,
          timing: "skip",
        });
        return null;
      }
      const transcriptMaxTokens =
        this.deps.getRecallSectionNumber("transcript", "maxTokens") ??
        this.deps.config.maxTranscriptTokens;
      const transcriptMaxTurns =
        this.deps.getRecallSectionNumber("transcript", "maxTurns") ??
        this.deps.config.maxTranscriptTurns;
      const transcriptLookbackHours =
        this.deps.getRecallSectionNumber("transcript", "lookbackHours") ??
        this.deps.config.transcriptRecallHours;
      if (
        transcriptMaxTokens === 0 ||
        transcriptMaxTurns === 0 ||
        transcriptLookbackHours === 0
      ) {
        recordRecallSectionMetric({
          section: "transcript",
          priority: "core",
          durationMs: 0,
          deadlineMs: recallSectionDeadlineMs,
          source: "skip",
          success: true,
          timing: "skip(limit=0)",
        });
        return null;
      }

      let section: string | null = null;
      // Try checkpoint first (post-compaction recovery)
      let checkpointInjected = false;
      if (resolvePipelineProcessingCapabilities(this.deps.config).checkpoint) {
        const checkpoint = await this.deps.transcript.loadCheckpoint(sessionKey);
        log.debug(
          `recall: checkpoint loaded, turns=${checkpoint?.turns?.length ?? 0}`,
        );
        if (checkpoint && checkpoint.turns.length > 0) {
          const formatted = this.deps.transcript.formatForRecall(
            checkpoint.turns,
            transcriptMaxTokens,
          );
          if (formatted) {
            section = `## Working Context (Recovered)\n\n${formatted}`;
            checkpointInjected = true;
            // Clear checkpoint after injection
            await this.deps.transcript.clearCheckpoint();
          }
        }
      }

      if (!checkpointInjected) {
        const entries = await this.deps.transcript.readRecent(
          transcriptLookbackHours,
          sessionKey,
        );
        log.debug(
          `recall: read ${entries.length} transcript entries for sessionKey=${sessionKey}`,
        );

        // Apply max turns cap
        const cappedEntries = entries.slice(-transcriptMaxTurns);
        if (cappedEntries.length > 0) {
          log.debug(
            `recall: injecting ${cappedEntries.length} transcript entries`,
          );
          const formatted = this.deps.transcript.formatForRecall(
            cappedEntries,
            transcriptMaxTokens,
          );
          if (formatted) section = formatted;
        }
      }

      recordRecallSectionMetric({
        section: "transcript",
        priority: "core",
        durationMs: Date.now() - t0,
        deadlineMs: recallSectionDeadlineMs,
        source: "fresh",
        success: true,
      });
      return section;
    })();

    // Compaction reset runs independently of transcript — it must work even when
    // transcriptEnabled=false, since compaction recovery is a separate concern.
    const compactionPromise = (async (): Promise<string | null> => {
      // Always clean up per-session workspace selections, even if the feature is off,
      // to prevent the Map from accumulating stale entries on long-running gateways.
      const effectiveSessionKey = sessionKey ?? "default";
      const compactionWorkspaceDir =
        this.deps._recallWorkspaceOverrides.get(effectiveSessionKey);
      this.deps._recallWorkspaceOverrides.delete(effectiveSessionKey);

      if (!resolveRecallAuxiliaryCapabilities(this.deps.config).compactionReset) return null;

      const workspaceDir =
        compactionWorkspaceDir ||
        this.deps.config.workspaceDir ||
        defaultWorkspaceDir();
      const safeSessionKey = sanitizeSessionKeyForFilename(effectiveSessionKey);
      const signalPath = path.join(
        workspaceDir,
        `.compaction-reset-signal-${safeSessionKey}`,
      );
      const bootPath = path.join(workspaceDir, "BOOT.md");

      try {
        const signalStat = await stat(signalPath).catch(() => null);
        if (!signalStat) return null;

        const signalAge = Date.now() - signalStat.mtimeMs;
        const signalData = JSON.parse(await readFile(signalPath, "utf-8"));

        // Validate signal belongs to this session (defense-in-depth: filename
        // is already per-session, but the sessionKey inside provides a second check).
        // Use strict !== so missing/null sessionKey also fails validation.
        if (signalData.sessionKey !== effectiveSessionKey) {
          log.debug(
            `recall: compaction signal is for ${signalData.sessionKey}, not ${effectiveSessionKey} — skipping`,
          );
          return null;
        }

        if (signalAge >= COMPACTION_SIGNAL_MAX_AGE_MS) {
          log.debug(
            `recall: stale compaction signal (${Math.round(signalAge / 1000)}s old), skipping`,
          );
          await unlink(signalPath).catch(() => {});
          return null;
        }

        // Signal is fresh and belongs to this session — build recovery context
        let section = "\n\n## Session Recovery (Post-Compaction)\n\n";
        section += `⚠️ A compaction occurred at ${signalData.compactedAt} and this is a fresh session.\n\n`;

        try {
          const bootContent = await readFile(bootPath, "utf-8");
          section += "### BOOT.md (working state before compaction)\n\n";
          section += bootContent + "\n";
        } catch {
          section += "### ⚠️ BOOT.md is MISSING\n\n";
          section +=
            "The memory flush may not have written BOOT.md before compaction. ";
          section += "Ask the user what you were working on — do not guess.\n";
        }

        log.info(
          `recall: injected compaction reset context for ${effectiveSessionKey}`,
        );
        await unlink(signalPath).catch(() => {});
        return section;
      } catch (err) {
        log.debug("recall: compaction signal check failed:", err);
        // Remove corrupt/unreadable signal files so they don't cause repeated
        // parse failures on every recall() until the 1-hour sweep runs.
        await unlink(signalPath).catch(() => {});
        return null;
      }
    })();

    const summariesPromise = (async (): Promise<string | null> => {
      const t0 = Date.now();
      if (
        !resolvePipelineProcessingCapabilities(this.deps.config).hourlySummaries ||
        !sessionKey ||
        !this.deps.isRecallSectionEnabled("summaries", true)
      ) {
        recordRecallSectionMetric({
          section: "summaries",
          priority: "core",
          durationMs: 0,
          deadlineMs: recallSectionDeadlineMs,
          source: "skip",
          success: true,
          timing: "skip",
        });
        return null;
      }
      const summariesLookbackHours =
        this.deps.getRecallSectionNumber("summaries", "lookbackHours") ??
        this.deps.config.summaryRecallHours;
      const summariesMaxCount =
        this.deps.getRecallSectionNumber("summaries", "maxCount") ??
        this.deps.config.maxSummaryCount;
      if (summariesLookbackHours <= 0 || summariesMaxCount <= 0) {
        recordRecallSectionMetric({
          section: "summaries",
          priority: "core",
          durationMs: 0,
          deadlineMs: recallSectionDeadlineMs,
          source: "skip",
          success: true,
          timing: "skip(limit=0)",
        });
        return null;
      }

      const summaries = await this.deps.summarizer.readRecent(
        sessionKey,
        summariesLookbackHours,
      );
      const cappedSummaries = summaries.slice(0, summariesMaxCount);
      const section =
        cappedSummaries.length > 0
          ? this.deps.summarizer.formatForRecall(cappedSummaries, summariesMaxCount)
          : null;
      recordRecallSectionMetric({
        section: "summaries",
        priority: "core",
        durationMs: Date.now() - t0,
        deadlineMs: recallSectionDeadlineMs,
        source: "fresh",
        success: true,
      });
      return section;
    })();

    const nativeKnowledgeAbort = createEnrichmentAbortHandle(
      options.abortSignal,
    );
    const nativeKnowledgePromise = observeEnrichmentPromise(
      (async (): Promise<string | null> => {
        const t0 = Date.now();
        if (
          !this.deps.config.nativeKnowledge?.enabled ||
          !this.deps.isRecallSectionEnabled(
            "native-knowledge",
            this.deps.config.nativeKnowledge.enabled,
          )
        ) {
          recordRecallSectionMetric({
            section: "nativeKnowledge",
            priority: "enrichment",
            durationMs: 0,
            deadlineMs: enrichmentSectionDeadlineMs,
            source: "skip",
            success: true,
            timing: "skip",
          });
          return null;
        }
        if (
          this.deps.config.nativeKnowledge.maxResults === 0 ||
          this.deps.config.nativeKnowledge.maxChars === 0
        ) {
          recordRecallSectionMetric({
            section: "nativeKnowledge",
            priority: "enrichment",
            durationMs: 0,
            deadlineMs: enrichmentSectionDeadlineMs,
            source: "skip",
            success: true,
            timing: "skip(limit=0)",
          });
          return null;
        }

        const chunks = await collectNativeKnowledgeChunks({
          workspaceDir: this.deps.config.workspaceDir,
          memoryDir: this.deps.config.memoryDir,
          config: this.deps.config.nativeKnowledge,
          recallNamespaces: resolveNamespaceCapabilities(this.deps.config).namespaces
            ? recallNamespaces
            : undefined,
          defaultNamespace: this.deps.config.defaultNamespace,
          abortSignal: nativeKnowledgeAbort.signal,
        }).catch(() => []);
        const results = searchNativeKnowledge({
          query: retrievalQuery,
          chunks,
          maxResults:
            this.deps.getRecallSectionNumber("native-knowledge", "maxResults") ??
            this.deps.config.nativeKnowledge.maxResults,
        });
        const section = formatNativeKnowledgeSection({
          results,
          maxChars:
            this.deps.getRecallSectionNumber("native-knowledge", "maxChars") ??
            this.deps.config.nativeKnowledge.maxChars,
        });
        recordRecallSectionMetric({
          section: "nativeKnowledge",
          priority: "enrichment",
          durationMs: Date.now() - t0,
          deadlineMs: enrichmentSectionDeadlineMs,
          source: "fresh",
          success: true,
        });
        return section;
      })().finally(() => nativeKnowledgeAbort.dispose()),
      () => nativeKnowledgeAbort.cancel(),
    );

    const conversationRecallPromise = (async (): Promise<string | null> => {
      const t0 = Date.now();
      if (
        !resolveIndexingCapabilities(this.deps.config).conversationIndex ||
        queryPolicy.skipConversationRecall ||
        !this.deps.isRecallSectionEnabled("conversation-recall", true)
      ) {
        recordRecallSectionMetric({
          section: "convRecall",
          priority: "core",
          durationMs: 0,
          deadlineMs: recallSectionDeadlineMs,
          source: "skip",
          success: true,
          timing: "skip",
        });
        return null;
      }

      const topKOverride = this.deps.getRecallSectionNumber(
        "conversation-recall",
        "topK",
      );
      if (topKOverride === 0) {
        recordRecallSectionMetric({
          section: "convRecall",
          priority: "core",
          durationMs: 0,
          deadlineMs: recallSectionDeadlineMs,
          source: "skip",
          success: true,
          timing: "skip(topK=0)",
        });
        return null;
      }

      const startedAtMs = Date.now();
      const timeoutMs = Math.max(
        200,
        this.deps.getRecallSectionNumber("conversation-recall", "timeoutMs") ??
          this.deps.config.conversationRecallTimeoutMs,
      );
      const topK = Math.max(
        1,
        topKOverride ?? this.deps.config.conversationRecallTopK,
      );
      const maxChars = Math.max(
        400,
        this.deps.getRecallSectionNumber("conversation-recall", "maxChars") ??
          this.deps.config.conversationRecallMaxChars,
      );

      const results = (await Promise.race([
        this.deps.searchConversationRecallResults(retrievalQuery, topK),
        new Promise<[]>((resolve) => setTimeout(() => resolve([]), timeoutMs)),
      ]).catch(() => [])) as Array<{
        path: string;
        snippet: string;
        score: number;
      }>;

      const durationMs = Date.now() - startedAtMs;
      if (durationMs >= timeoutMs) {
        log.debug(`conversation recall: timed out after ${timeoutMs}ms`);
      }

      const section = this.deps.formatConversationRecallSection(results, maxChars);
      recordRecallSectionMetric({
        section: "convRecall",
        priority: "core",
        durationMs: Date.now() - t0,
        deadlineMs: timeoutMs,
        source: "fresh",
        success: true,
      });
      return section;
    })();

    const procedureRecallPromise = (async (): Promise<string | null> => {
      if (this.deps.config.procedural?.enabled !== true) return null;
      if (!this.deps.isRecallSectionEnabled("procedure-recall", true)) return null;
      try {
        return await buildProcedureRecallSection(
          profileStorage,
          retrievalQuery,
          this.deps.config,
        );
      } catch (err) {
        log.debug(
          `procedure-recall: failed open: ${err instanceof Error ? err.message : String(err)}`,
        );
        return null;
      }
    })();

    const compoundingPromise = observeEnrichmentPromise(
      (async (): Promise<string | null> => {
        const t0 = Date.now();
        if (
          !this.deps.compounding ||
          !resolveRecallEnhancementCapabilities(this.deps.config).compoundingInject ||
          !this.deps.isRecallSectionEnabled("compounding", true)
        ) {
          recordRecallSectionMetric({
            section: "compounding",
            priority: "enrichment",
            durationMs: 0,
            deadlineMs: enrichmentSectionDeadlineMs,
            source: "skip",
            success: true,
            timing: "skip",
          });
          return null;
        }
        const maxPatterns =
          this.deps.getRecallSectionNumber("compounding", "maxPatterns") ?? 40;
        const maxRubrics =
          this.deps.getRecallSectionNumber("compounding", "maxRubrics") ?? 4;
        if (maxPatterns === 0 && maxRubrics === 0) {
          recordRecallSectionMetric({
            section: "compounding",
            priority: "enrichment",
            durationMs: 0,
            deadlineMs: enrichmentSectionDeadlineMs,
            source: "skip",
            success: true,
            timing: "skip(limit=0)",
          });
          return null;
        }
        const section = await this.deps.compounding.buildRecallSection(
          retrievalQuery,
          { maxPatterns, maxRubrics },
        );
        recordRecallSectionMetric({
          section: "compounding",
          priority: "enrichment",
          durationMs: Date.now() - t0,
          deadlineMs: enrichmentSectionDeadlineMs,
          source: "fresh",
          success: true,
        });
        return section;
      })(),
    );

    // Start memory-boxes read in parallel with the rest of phase-1 (it can take
    // several seconds on large box directories due to sequential I/O). We kick it
    // off here so it overlaps with QMD and other concurrent work rather than
    // running sequentially in phase-2 and blocking assembly.
    const recentBoxesPromise = observeEnrichmentPromise(
      this.deps.isRecallSectionEnabled(
        "memory-boxes",
        resolvePresentationCapabilities(this.deps.config).memoryBoxes === true,
      ) &&
        resolvePresentationCapabilities(this.deps.config).memoryBoxes &&
        this.deps.config.boxRecallDays > 0
        ? Promise.all(
            profileStorages.map((storage) =>
              this.deps.boxBuilderFor(storage)
                .readRecentBoxes(this.deps.config.boxRecallDays)
                .catch(() => [] as BoxFrontmatter[]),
            ),
          ).then((groups) => {
            const boxes: BoxFrontmatter[] = [];
            const seen = new Set<string>();
            for (const box of groups.flat()) {
              const key = JSON.stringify(box);
              if (seen.has(key)) continue;
              seen.add(key);
              boxes.push(box);
            }
            return boxes.sort((a, b) => {
              const aTime = Date.parse(a.sealedAt ?? "");
              const bTime = Date.parse(b.sealedAt ?? "");
              const aRank = Number.isFinite(aTime) ? aTime : 0;
              const bRank = Number.isFinite(bTime) ? bTime : 0;
              return bRank - aRank;
            });
          })
        : Promise.resolve([] as BoxFrontmatter[]),
    );

    // --- Wait for core sections first, then bounded enrichment ---
    this.deps.profiler.startSpan("phase-1-parallel", profileTraceId);
    const phase1Start = Date.now();
    log.info(
      `recall phase-1: starting parallel work at +${phase1Start - recallStart}ms`,
    );
    const [
      sharedCtx,
      profile,
      identityContinuity,
      entityRetrievalSection,
      kiResult,
      artifacts,
      objectiveStateSection,
      causalTrajectorySection,
      cmcCausalChainsSection,
      calibrationSection,
      procedureRecallSection,
      trustZoneSection,
      verifiedRecallSection,
      verifiedRulesSection,
      workProductsSection,
      transcriptSection,
      compactionSection,
      summariesSection,
      conversationRecallSection,
      peerProfileSection,
    ] = await raceRecallAbort(
      Promise.all(
        (
          [
            ["shared", sharedContextPromise],
            ["profile", profilePromise],
            ["identity", identityContinuityPromise],
            ["entity", entityRetrievalPromise],
            ["ki", knowledgeIndexPromise],
            ["artifacts", artifactsPromise],
            ["objState", objectiveStatePromise],
            ["causalTraj", causalTrajectoryPromise],
            ["cmc", cmcRetrievalPromise],
            ["calibration", calibrationPromise],
            ["procedureRecall", procedureRecallPromise],
            ["trustZone", trustZonePromise],
            ["verifiedRecall", verifiedRecallPromise],
            ["verifiedRules", verifiedRulesPromise],
            ["workProducts", workProductsPromise],
            ["transcript", transcriptPromise],
            ["compaction", compactionPromise],
            ["summaries", summariesPromise],
            ["convRecall", conversationRecallPromise],
            ["peerProfile", peerProfileRecallPromise],
          ] as const
        ).map(([name, p]) =>
          (p as Promise<unknown>).then((v) => {
            log.debug(
              `recall phase-1 core [${name}]: resolved at +${Date.now() - phase1Start}ms`,
            );
            return v;
          }),
        ),
      ) as Promise<
        [
          typeof sharedContextPromise extends Promise<infer T> ? T : never,
          typeof profilePromise extends Promise<infer T> ? T : never,
          typeof identityContinuityPromise extends Promise<infer T> ? T : never,
          typeof entityRetrievalPromise extends Promise<infer T> ? T : never,
          typeof knowledgeIndexPromise extends Promise<infer T> ? T : never,
          typeof artifactsPromise extends Promise<infer T> ? T : never,
          typeof objectiveStatePromise extends Promise<infer T> ? T : never,
          typeof causalTrajectoryPromise extends Promise<infer T> ? T : never,
          typeof cmcRetrievalPromise extends Promise<infer T> ? T : never,
          typeof calibrationPromise extends Promise<infer T> ? T : never,
          typeof procedureRecallPromise extends Promise<infer T> ? T : never,
          typeof trustZonePromise extends Promise<infer T> ? T : never,
          typeof verifiedRecallPromise extends Promise<infer T> ? T : never,
          typeof verifiedRulesPromise extends Promise<infer T> ? T : never,
          typeof workProductsPromise extends Promise<infer T> ? T : never,
          typeof transcriptPromise extends Promise<infer T> ? T : never,
          typeof compactionPromise extends Promise<infer T> ? T : never,
          typeof summariesPromise extends Promise<infer T> ? T : never,
          typeof conversationRecallPromise extends Promise<infer T> ? T : never,
          typeof peerProfileRecallPromise extends Promise<infer T> ? T : never,
        ]
      >,
      options.abortSignal,
      "recall aborted during phase-one preamble",
    );

    this.deps.profiler.endSpan("phase-1-parallel", profileTraceId);
    log.info(
      `recall phase-1: core work done at +${Date.now() - recallStart}ms ` +
        `(phase took ${Date.now() - phase1Start}ms); continuing with incremental enrichment assembly`,
    );
    throwIfRecallAborted(options.abortSignal);

    const enrichmentAssemblyDeadlineAtMs =
      enrichmentSectionDeadlineMs > 0
        ? this.deps.recallAssemblyClockMs() + enrichmentSectionDeadlineMs
        : null;

    const awaitEnrichmentSection = async <T>(
      name: string,
      promise: ObservedDeferredEnrichmentPromise<T>,
    ): Promise<T | null> => {
      const finalizeEnrichmentOutcome = (
        outcome: DeferredEnrichmentOutcome<T>,
      ): T | null => {
        if (outcome.status === "resolved") {
          log.debug(
            `recall phase-1 enrichment [${name}]: resolved at +${Date.now() - phase1Start}ms`,
          );
          return outcome.value;
        }

        if (options.abortSignal?.aborted) {
          log.debug(
            `recall phase-1 enrichment [${name}]: skipped after abort at +${Date.now() - phase1Start}ms`,
          );
          return null;
        }
        log.warn(
          `recall phase-1 enrichment [${name}] failed open: ` +
            `${outcome.error instanceof Error ? outcome.error.message : String(outcome.error)}`,
        );
        return null;
      };

      if (options.abortSignal?.aborted) {
        promise.cancel();
        log.debug(
          `recall phase-1 enrichment [${name}]: skipped after abort at +${Date.now() - phase1Start}ms`,
        );
        return null;
      }

      let timeoutHandle: NodeJS.Timeout | undefined;
      const timeoutMs =
        enrichmentAssemblyDeadlineAtMs === null
          ? null
          : Math.max(0, enrichmentAssemblyDeadlineAtMs - this.deps.recallAssemblyClockMs());
      if (timeoutMs === 0) {
        const settledOutcome = promise.getSettledOutcome();
        if (settledOutcome) {
          log.debug(
            `recall phase-1 enrichment [${name}]: consumed already-settled result after shared ${enrichmentSectionDeadlineMs}ms budget expired ` +
              `at +${Date.now() - phase1Start}ms`,
          );
          return finalizeEnrichmentOutcome(settledOutcome);
        }
        log.debug(
          `recall phase-1 enrichment [${name}]: skipped after shared ${enrichmentSectionDeadlineMs}ms budget expired ` +
            `at +${Date.now() - phase1Start}ms`,
        );
        promise.cancel();
        return null;
      }

      const outcome = await (timeoutMs !== null
        ? Promise.race<DeferredEnrichmentOutcome<T> | { status: "timed_out" }>([
            promise,
            new Promise<{ status: "timed_out" }>((resolve) => {
              timeoutHandle = setTimeout(
                () => resolve({ status: "timed_out" }),
                timeoutMs,
              );
            }),
          ])
        : promise);
      if (timeoutHandle) clearTimeout(timeoutHandle);

      if (outcome.status === "timed_out") {
        log.debug(
          `recall phase-1 enrichment [${name}]: timed out within shared ${enrichmentSectionDeadlineMs}ms budget ` +
            `at +${Date.now() - phase1Start}ms`,
        );
        promise.cancel();
        return null;
      }

      return finalizeEnrichmentOutcome(outcome);
    };

    const remainingEnrichmentAssemblyMs = (): number | null =>
      enrichmentAssemblyDeadlineAtMs === null
        ? null
        : Math.max(0, enrichmentAssemblyDeadlineAtMs - this.deps.recallAssemblyClockMs());

    const awaitAssemblyStep = async <T>(
      name: string,
      task: (stepSignal: AbortSignal) => Promise<T>,
      fallback: T,
    ): Promise<T> => {
      if (options.abortSignal?.aborted) {
        log.debug(
          `recall phase-1 assembly [${name}]: skipped after abort at +${Date.now() - phase1Start}ms`,
        );
        return fallback;
      }

      const timeoutMs = remainingEnrichmentAssemblyMs();
      if (timeoutMs === 0) {
        log.debug(
          `recall phase-1 assembly [${name}]: skipped after shared ${enrichmentSectionDeadlineMs}ms budget expired ` +
            `at +${Date.now() - phase1Start}ms`,
        );
        return fallback;
      }

      // Task-level deadline abort (#1907): give the step a child controller and
      // pass its signal into the task so the losing task cooperatively stops
      // instead of running to completion on the daemon thread after the race is
      // lost. Compose with the request signal so a client disconnect ALSO stops
      // the step's cooperative reads. This step controller only maps to the
      // step's `fallback` (fail-open, rule 41); it never rejects the recall —
      // a request-level abort rejects at the next throwIfRecallAborted boundary.
      const stepController = new AbortController();
      const stepSignal = options.abortSignal
        ? AbortSignal.any([options.abortSignal, stepController.signal])
        : stepController.signal;

      let timeoutHandle: NodeJS.Timeout | undefined;
      try {
        const result = await (timeoutMs !== null
          ? Promise.race<T | { status: "timed_out" }>([
              task(stepSignal),
              new Promise<{ status: "timed_out" }>((resolve) => {
                timeoutHandle = setTimeout(
                  () => resolve({ status: "timed_out" }),
                  timeoutMs,
                );
              }),
            ])
          : task(stepSignal));
        if (timeoutHandle) clearTimeout(timeoutHandle);
        if (
          typeof result === "object" &&
          result !== null &&
          "status" in result &&
          result.status === "timed_out"
        ) {
          stepController.abort(abortError(`recall assembly [${name}] deadline exceeded`));
          log.debug(
            `recall phase-1 assembly [${name}]: timed out within shared ${enrichmentSectionDeadlineMs}ms budget ` +
              `at +${Date.now() - phase1Start}ms`,
          );
          return fallback;
        }
        return result as T;
      } catch (err) {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        stepController.abort(abortError(`recall assembly [${name}] failed`));
        log.warn(
          `recall phase-1 assembly [${name}] failed open: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        return fallback;
      }
    };

    // --- Phase 2: Assemble sections in correct order ---
    this.deps.profiler.startSpan("assembly", profileTraceId);

    // 0. Shared context
    if (sharedCtx)
      this.deps.appendRecallSection(sectionBuckets, "shared-context", sharedCtx);

    // 0a. Explicit cue evidence
    const explicitCueMaxChars =
      this.deps.getRecallSectionMaxChars("explicit-cue") ??
      this.deps.config.explicitCueRecallMaxChars;
    if (
      resolveRecallEnhancementCapabilities(this.deps.config).explicitCueRecall &&
      this.deps.isRecallSectionEnabled("explicit-cue") &&
      explicitCueMaxChars !== 0 &&
      this.deps.lcmEngine?.enabled &&
      (recallMode as RecallPlanMode) !== "no_recall"
    ) {
      try {
        const explicitCueSection = await buildExplicitCueRecallSection({
          engine: this.deps.lcmEngine,
          // #1495 thread 3 + #1505 fallback unification: read across the ordered
          // LCM read key set (primary overlay → coding fallbacks) so a
          // branch-scoped session finds its own explicit-cue evidence even when
          // archived at project/root scope (rule 39). #1505 codex P2: the builder
          // MERGES candidates across every key under its single budget instead of
          // short-circuiting on the first non-empty key.
          sessionIds: lcmReadSessionIds,
          query: retrievalQuery,
          maxChars: explicitCueMaxChars,
          maxReferences:
            this.deps.getRecallSectionNumber("explicit-cue", "maxResults") ??
            this.deps.config.explicitCueRecallMaxReferences,
        });
        if (explicitCueSection) {
          this.deps.appendRecallSection(
            sectionBuckets,
            "explicit-cue",
            explicitCueSection,
          );
        }
      } catch (err) {
        log.debug(`Explicit cue recall assembly error: ${err}`);
      }
    }

    // 0b. Targeted factual evidence. This is query-triggered and lossless:
    // it uses the LCM archive to recover exact numeric facts that broad
    // compressed-history or search sections can crowd out.
    const targetedFactMaxChars =
      this.deps.getRecallSectionMaxChars("targeted-facts") ??
      this.deps.config.targetedFactRecallMaxChars;
    if (
      this.deps.isSpecializedRecallSectionEnabled(
        "targeted-facts",
        resolveRecallEnhancementCapabilities(this.deps.config).targetedFactRecall,
      ) &&
      targetedFactMaxChars !== 0 &&
      this.deps.lcmEngine?.enabled &&
      (recallMode as RecallPlanMode) !== "no_recall" &&
      shouldRecallTargetedFactEvidence(retrievalQuery)
    ) {
      try {
        const targetedFactSection = await buildTargetedFactRecallSection({
          engine: this.deps.lcmEngine,
          // #1495 + #1505 fallback unification: read across the ordered LCM read
          // key set so a branch-scoped session finds its own targeted-fact
          // evidence even when archived at project/root scope. #1505 codex P2: the
          // builder MERGES candidates across every key under its single budget.
          sessionIds: lcmReadSessionIds,
          query: retrievalQuery,
          maxChars: targetedFactMaxChars,
          maxSearchResults:
            this.deps.getRecallSectionNumber("targeted-facts", "maxResults") ??
            this.deps.config.targetedFactRecallMaxResults,
          maxScanWindowTurns:
            this.deps.getRecallSectionNumber("targeted-facts", "maxTurns") ??
            this.deps.config.targetedFactRecallScanWindowTurns,
          maxScanWindowTokens:
            this.deps.getRecallSectionNumber("targeted-facts", "maxTokens") ??
            this.deps.config.targetedFactRecallScanWindowTokens,
        });
        if (targetedFactSection) {
          this.deps.appendRecallSection(
            sectionBuckets,
            "targeted-facts",
            targetedFactSection,
          );
        }
      } catch (err) {
        log.debug(`Targeted fact recall assembly error: ${err}`);
      }
    }

    // 0c. Focused list/count evidence. This recovers user-specific list
    // candidates and countable facts that are easy to bury in broad search
    // results, while staying gated to explicit list/count/recommendation
    // prompts.
    const focusedListMaxChars =
      this.deps.getRecallSectionMaxChars("focused-list") ??
      this.deps.config.focusedListRecallMaxChars;
    if (
      this.deps.isSpecializedRecallSectionEnabled(
        "focused-list",
        resolveRecallEnhancementCapabilities(this.deps.config).focusedListRecall,
      ) &&
      focusedListMaxChars !== 0 &&
      this.deps.lcmEngine?.enabled &&
      (recallMode as RecallPlanMode) !== "no_recall" &&
      shouldRecallFocusedListEvidence(retrievalQuery)
    ) {
      try {
        const focusedListSection = await buildFocusedListRecallSection({
          engine: this.deps.lcmEngine,
          // #1495 thread 3 + #1505 fallback unification: read across the ordered
          // LCM read key set so a branch-scoped session reads its own
          // focused-list/count evidence even at project/root scope (rule 39).
          // #1505 codex P2: the builder MERGES candidates across every key under
          // its single budget.
          sessionIds: lcmReadSessionIds,
          query: retrievalQuery,
          maxChars: focusedListMaxChars,
          maxSearchResults:
            this.deps.getRecallSectionNumber("focused-list", "maxResults") ??
            this.deps.config.focusedListRecallMaxResults,
          maxScanWindowTurns:
            this.deps.getRecallSectionNumber("focused-list", "maxTurns") ??
            this.deps.config.focusedListRecallScanWindowTurns,
          maxScanWindowTokens:
            this.deps.getRecallSectionNumber("focused-list", "maxTokens") ??
            this.deps.config.focusedListRecallScanWindowTokens,
        });
        if (focusedListSection) {
          this.deps.appendRecallSection(
            sectionBuckets,
            "focused-list",
            focusedListSection,
          );
        }
      } catch (err) {
        log.debug(`Focused list recall assembly error: ${err}`);
      }
    }

    // 0d. Response guidance evidence. This recovers durable user
    // instructions and preferences that affect how an answer should be shaped
    // for the current query, such as requested date formats, tool/version
    // details, or preferred editing workflows.
    const responseGuidanceMaxChars =
      this.deps.getRecallSectionMaxChars("response-guidance") ??
      this.deps.config.responseGuidanceRecallMaxChars;
    const responseGuidanceEntry = this.deps.getRecallSectionEntry("response-guidance");
    const responseGuidanceMatchesQuery = shouldRecallResponseGuidance(retrievalQuery);
    const responseGuidanceForcedByPipeline =
      responseGuidanceEntry?.forceGeneric === true && !responseGuidanceMatchesQuery;
    if (
      this.deps.isSpecializedRecallSectionEnabled(
        "response-guidance",
        resolveRecallEnhancementCapabilities(this.deps.config).responseGuidanceRecall,
      ) &&
      responseGuidanceMaxChars !== 0 &&
      this.deps.lcmEngine?.enabled &&
      (recallMode as RecallPlanMode) !== "no_recall" &&
      (responseGuidanceMatchesQuery || responseGuidanceForcedByPipeline)
    ) {
      try {
        const responseGuidanceSection = await buildResponseGuidanceRecallSection({
          engine: this.deps.lcmEngine,
          // #1495 thread 3 + #1505 fallback unification: read across the ordered
          // LCM read key set so a branch-scoped session reads its own
          // response-guidance evidence even at project/root scope (rule 39).
          // #1505 codex P2: the builder MERGES candidates across every key under
          // its single budget.
          sessionIds: lcmReadSessionIds,
          query: retrievalQuery,
          maxChars: responseGuidanceMaxChars,
          maxSearchResults:
            this.deps.getRecallSectionNumber("response-guidance", "maxResults") ??
            this.deps.config.responseGuidanceRecallMaxResults,
          maxScanWindowTurns:
            this.deps.getRecallSectionNumber("response-guidance", "maxTurns") ??
            this.deps.config.responseGuidanceRecallScanWindowTurns,
          maxScanWindowTokens:
            this.deps.getRecallSectionNumber("response-guidance", "maxTokens") ??
            this.deps.config.responseGuidanceRecallScanWindowTokens,
          forceGeneric: responseGuidanceForcedByPipeline,
        });
        if (responseGuidanceSection) {
          this.deps.appendRecallSection(
            sectionBuckets,
            "response-guidance",
            responseGuidanceSection,
          );
        }
      } catch (err) {
        log.debug(`Response guidance recall assembly error: ${err}`);
      }
    }

    // 0e. Chronological event-order evidence. Prefer the ingest-time temporal
    // index, which can safely merge event times across source sessions. Fall
    // back to the legacy per-session LCM turn order when the index is absent.
    const eventOrderMaxChars =
      this.deps.getRecallSectionMaxChars("event-order") ??
      this.deps.config.eventOrderRecallMaxChars;
    const eventOrderMaxItems =
      this.deps.getRecallSectionNumber("event-order", "maxResults") ??
      this.deps.config.eventOrderRecallMaxResults;
    if (
      this.deps.isSpecializedRecallSectionEnabled(
        "event-order",
        resolveRecallEnhancementCapabilities(this.deps.config).eventOrderRecall,
      ) &&
      eventOrderMaxChars !== 0 &&
      eventOrderMaxItems > 0 &&
      (recallMode as RecallPlanMode) !== "no_recall" &&
      shouldRecallEventOrderEvidence(retrievalQuery)
    ) {
      try {
        const maxItems = eventOrderMaxItems;
        let eventOrderSection = "";
        const timelineCandidateLimit = Math.min(256, Math.max(48, maxItems * 12));
        const timeline = await queryTemporalTimelineAsync(this.deps.config.memoryDir, {
          query: retrievalQuery,
          limit: timelineCandidateLimit,
        });
        if (timeline) {
          const timelineItems: TemporalTimelineRecallItem[] = [];
          // Sequential reads keep file-descriptor pressure bounded. The index
          // query above has already capped total reads deterministically.
          for (const event of timeline) {
            const namespace = this.deps.namespaceFromPath(event.path);
            if (
              resolveNamespaceCapabilities(this.deps.config).namespaces &&
              !recallNamespaces.includes(namespace)
            ) {
              continue;
            }
            try {
              const storage = resolveNamespaceCapabilities(this.deps.config).namespaces
                ? await this.deps.storageRouter.storageFor(namespace)
                : this.deps.storage;
              const memory = await storage.readMemoryByPath(event.path);
              if (!memory || !isActiveMemoryStatus(memory.frontmatter.status)) continue;
              if (!isValidAsOf(memory.frontmatter, asOfMs ?? Date.now())) continue;
              timelineItems.push({
                memory,
                eventAt: event.eventAt,
                ...(event.observedAt ? { observedAt: event.observedAt } : {}),
                ...(event.sessionKey ? { sessionKey: event.sessionKey } : {}),
                ...(event.validUntil ? { validUntil: event.validUntil } : {}),
              });
            } catch {
              continue;
            }
          }
          eventOrderSection = buildTemporalTimelineRecallSection({
            items: timelineItems,
            query: retrievalQuery,
            maxChars: eventOrderMaxChars,
            maxItems,
          });
        }

        // Legacy fallback: LCM turn indexes are local to one session, so keep
        // first-non-empty semantics and never interleave them across sessions.
        if (!eventOrderSection && this.deps.lcmEngine?.enabled) {
          eventOrderSection = await firstNonEmptyLcmRead(
            (lcmSessionId) =>
              buildEventOrderRecallSection({
                engine: this.deps.lcmEngine,
                sessionId: lcmSessionId,
                query: retrievalQuery,
                maxChars: eventOrderMaxChars,
                maxItems,
                maxScanWindowTurns:
                  this.deps.getRecallSectionNumber("event-order", "maxTurns") ??
                  this.deps.config.eventOrderRecallScanWindowTurns,
                maxScanWindowTokens:
                  this.deps.getRecallSectionNumber("event-order", "maxTokens") ??
                  this.deps.config.eventOrderRecallScanWindowTokens,
              }),
            (s) => !s,
            "",
          );
        }
        if (eventOrderSection) {
          this.deps.appendRecallSection(
            sectionBuckets,
            "event-order",
            eventOrderSection,
          );
        }
      } catch (err) {
        log.debug(`Event order recall assembly error: ${err}`);
      }
    }

    // 1. Profile
    if (profile)
      this.deps.appendRecallSection(
        sectionBuckets,
        "profile",
        `## User Profile\n\n${profile}`,
      );

    // 1p. Peer profile (issue #679 PR 3/5)
    // Codex P2 (PR #764): only finalize the xray annotation when the section
    // was actually appended — appendRecallSection may drop it (disabled,
    // maxChars===0). We clear the annotation when the section is dropped so
    // the xray snapshot never reports injection that didn't happen.
    if (peerProfileSection) {
      const peerSectionAppended = this.deps.appendRecallSection(
        sectionBuckets,
        "peer-profile",
        peerProfileSection,
      );
      if (!peerSectionAppended) {
        // Section was gated out — treat as null (feature on + peer registered,
        // but no context actually injected).
        peerProfileXrayAnnotation = null;
      }
    }

    // 1-pre. Calibration rules (injected early so model sees adjustments first)
    if (calibrationSection) {
      this.deps.appendRecallSection(
        sectionBuckets,
        "calibration-rules",
        calibrationSection,
      );
    }

    if (procedureRecallSection) {
      this.deps.appendRecallSection(
        sectionBuckets,
        "procedure-recall",
        procedureRecallSection,
      );
    }

    // 1a. Identity continuity
    if (identityContinuity) {
      this.deps.appendRecallSection(
        sectionBuckets,
        "identity-continuity",
        identityContinuity.section,
      );
      identityInjectionModeUsed = identityContinuity.mode;
      identityInjectedChars = identityContinuity.injectedChars;
      identityInjectionTruncated = identityContinuity.truncated;
    }

    if (entityRetrievalSection) {
      this.deps.appendRecallSection(
        sectionBuckets,
        "entity-retrieval",
        entityRetrievalSection,
      );
    }

    // 1b. Knowledge Index
    if (kiResult?.result) {
      this.deps.appendRecallSection(
        sectionBuckets,
        "knowledge-index",
        kiResult.result,
      );
      log.debug(
        `Knowledge Index: ${kiResult.result.split("\n").length - 4} entities, ${kiResult.result.length} chars${kiResult.cached ? " (cached)" : ""}`,
      );
    }

    const nativeKnowledgeSection = await awaitEnrichmentSection(
      "nativeKnowledge",
      nativeKnowledgePromise,
    );
    if (nativeKnowledgeSection) {
      this.deps.appendRecallSection(
        sectionBuckets,
        "native-knowledge",
        nativeKnowledgeSection,
      );
    }

    // 1c. Verbatim artifacts (quote-first anchors)
    if (artifacts.length > 0) {
      const lines = artifacts.map((a) => {
        const artifactType = a.frontmatter.artifactType ?? "fact";
        const createdRaw =
          typeof a.frontmatter.created === "string"
            ? a.frontmatter.created
            : "";
        const created = createdRaw
          ? createdRaw.slice(0, 19).replace("T", " ")
          : "unknown-time";
        return `- [${artifactType}] "${this.deps.truncateArtifactForRecall(a.content)}" (${created})`;
      });
      this.deps.appendRecallSection(
        sectionBuckets,
        "verbatim-artifacts",
        `## Verbatim Artifacts\n\n${lines.join("\n")}`,
      );
    }

    // 1d. Memory Boxes (topic continuity windows, v8.0 Phase 2A)
    // recentBoxesPromise was kicked off before phase-1 so it ran concurrently.
    {
      const recentBoxes = await awaitEnrichmentSection(
        "memory-boxes",
        recentBoxesPromise,
      );
      if (recentBoxes && recentBoxes.length > 0) {
        const boxLines = recentBoxes.slice(0, 5).map((b: BoxFrontmatter) => {
          const sealedDate = b.sealedAt
            ? b.sealedAt.slice(0, 16).replace("T", " ")
            : "?";
          const traceNote = b.traceId
            ? ` [trace: ${b.traceId.slice(0, 12)}]`
            : "";
          return `- [${sealedDate}${traceNote}] Topics: ${b.topics.join(", ")} (${b.memoryIds.length} memories)`;
        });
        this.deps.appendRecallSection(
          sectionBuckets,
          "memory-boxes",
          `## Recent Topic Windows\n\n${boxLines.join("\n")}`,
        );
      }
    }

    // 1e. TMT node (temporal memory tree, v8.2)
    if (
      this.deps.isRecallSectionEnabled(
        "temporal-memory-tree",
        lifecycleCaps.temporalMemoryTree,
      ) &&
      lifecycleCaps.temporalMemoryTree &&
      recallMode !== "minimal" &&
      (recallMode as RecallPlanMode) !== "no_recall"
    ) {
      const tmtNode = await this.deps.tmtBuilder.getMostRelevantNode();
      if (tmtNode) {
        const levelLabel =
          tmtNode.level.charAt(0).toUpperCase() + tmtNode.level.slice(1);
        this.deps.appendRecallSection(
          sectionBuckets,
          "temporal-memory-tree",
          `## Memory Timeline (${levelLabel})\n\n${tmtNode.summary}`,
        );
      }
    }

    // LCM compressed history section
    if (
      this.deps.lcmEngine?.enabled &&
      recallMode !== "minimal" &&
      (recallMode as RecallPlanMode) !== "no_recall"
    ) {
      try {
        // #1495 + #1505 fallback unification: read across the ordered LCM read
        // key set so a branch-scoped session reads its own structured
        // message-part evidence even when archived at project/root scope.
        // #1505 codex P2: structured matches are query-SCORED evidence, so MERGE
        // across EVERY key (primary overlay → project/root fallbacks) instead of
        // short-circuiting on the first non-empty key — a weak branch-key hit must
        // not mask stronger project-fallback parts. Keys are queried in priority
        // order; dedupe by session_id+turn_index+part_id keeps the primary key's
        // row on collision. `formatStructuredRecall` applies the single budget
        // below. A sessionless key (`undefined`) normalizes to "" → no matches
        // (structured parts are inherently per-session; pre-#1505 behavior, codex
        // P2).
        // FAULT ISOLATION (allSettled, not all): the pre-#1505 first-non-empty read
        // short-circuited, so a fallback key was often never queried and its latent
        // search failure never surfaced. Querying every key eagerly must NOT let one
        // key's failure (e.g. a SqliteError from a corrupt/locked fallback index)
        // reject the batch and discard the OTHER keys' parts — or, since this and
        // the compressed-history read below share one try block, silently drop the
        // compressed-history section a healthy primary key would still produce. So
        // read each key independently and keep the fulfilled batches.
        const structuredSettled = await Promise.allSettled(
          lcmReadSessionIds.map((lcmSessionId) =>
            this.deps.lcmEngine!.searchStructuredParts(lcmSessionId ?? "", retrievalQuery),
          ),
        );
        for (const settled of structuredSettled) {
          if (settled.status === "rejected") {
            log.debug(
              `LCM structured-parts read failed for one key: ${settled.reason}`,
            );
          }
        }
        const seenStructuredParts = new Set<string>();
        const structuredMatches = structuredSettled
          .flatMap((settled) => (settled.status === "fulfilled" ? settled.value : []))
          .filter((match) => {
            const key = `${match.session_id} ${match.turn_index} ${match.part_id}`;
            if (seenStructuredParts.has(key)) return false;
            seenStructuredParts.add(key);
            return true;
          })
          // Restore the archive's per-key ordering (score DESC, then turn DESC)
          // across the MERGED set so the strongest parts win the shared budget in
          // `formatStructuredRecall` — otherwise weak primary-key parts could crowd
          // out stronger fallback parts. Stable sort: a single key is already in
          // this order, so it stays byte-for-byte the pre-#1505 behavior.
          // `?? 0` is defensive: `LcmStructuredRecallMatch.score` is always a
          // number here, but a bare `b.score - a.score` would yield NaN (falsy)
          // for any future unscored match and silently fall through to turn order.
          .sort(
            (a, b) =>
              (b.score ?? 0) - (a.score ?? 0) || b.turn_index - a.turn_index,
          );
        const structuredSection = this.deps.lcmEngine.formatStructuredRecall(
          structuredMatches,
          Math.ceil(this.deps.config.recallBudgetChars * 0.08),
        );
        if (structuredSection) {
          const structuredAppended = this.deps.appendRecallSection(
            sectionBuckets,
            "lcm-message-parts",
            structuredSection,
          );
          if (structuredAppended) {
            for (const match of structuredMatches) {
              lcmStructuredXrayResults.push({
                memoryId: `lcm-message-part-${match.part_id}`,
                path: `lcm://${match.session_id}/turn/${match.turn_index}/part/${match.part_id}`,
                servedBy: match.file_path ? "lcm-file-parts" : "lcm-tool-parts",
                scoreDecomposition: { final: match.score },
                admittedBy: ["lcm-message-parts"],
              });
            }
          }
        }
        // #1495 + #1505 fallback unification: read across the ordered LCM read key
        // set so a branch-scoped session reads its own compressed-history evidence
        // even at project/root scope. UNLIKE the query-scored sections above, the
        // compressed history is a per-session HOLISTIC DAG narrative, not a set of
        // independently-rankable evidence items — concatenating two sessions'
        // summaries would double-count the conversation and blow the budget, and
        // there is no per-item id to dedupe on. So this section deliberately keeps
        // first-non-empty semantics (#1505 codex P2 scope: "merge the query-matched
        // sections"): the highest-priority authorized key (primary overlay →
        // project/root) that actually has a compressed history wins. A sessionless
        // key (`undefined`) normalizes to empty → no section (pre-#1505 behavior).
        const lcmSection = await firstNonEmptyLcmRead(
          (lcmSessionId) =>
            this.deps.lcmEngine!.assembleRecall(
              lcmSessionId ?? "",
              this.deps.config.recallBudgetChars,
            ),
          (s) => !s,
          "",
        );
        if (lcmSection) {
          this.deps.appendRecallSection(
            sectionBuckets,
            "lcm-compressed-history",
            lcmSection,
          );
        }
      } catch (err) {
        log.debug(`LCM recall assembly error: ${err}`);
      }
    }

    if (objectiveStateSection) {
      this.deps.appendRecallSection(
        sectionBuckets,
        "objective-state",
        objectiveStateSection,
      );
    }

    if (causalTrajectorySection) {
      this.deps.appendRecallSection(
        sectionBuckets,
        "causal-trajectories",
        causalTrajectorySection,
      );
    }

    if (cmcCausalChainsSection) {
      this.deps.appendRecallSection(
        sectionBuckets,
        "cmc-causal-chains",
        cmcCausalChainsSection,
      );
    }

    if (trustZoneSection) {
      this.deps.appendRecallSection(sectionBuckets, "trust-zones", trustZoneSection);
    }

    const harmonicRetrievalSection = await awaitEnrichmentSection(
      "harmonic",
      harmonicRetrievalPromise,
    );
    if (harmonicRetrievalSection) {
      this.deps.appendRecallSection(
        sectionBuckets,
        "harmonic-retrieval",
        harmonicRetrievalSection,
      );
    }

    if (verifiedRecallSection) {
      this.deps.appendRecallSection(
        sectionBuckets,
        "verified-episodes",
        verifiedRecallSection,
      );
    }

    if (verifiedRulesSection) {
      this.deps.appendRecallSection(
        sectionBuckets,
        "verified-rules",
        verifiedRulesSection,
      );
    }

    if (workProductsSection) {
      this.deps.appendRecallSection(
        sectionBuckets,
        "work-products",
        workProductsSection,
      );
    }

    // 2. QMD results — post-process and format
    const qmdWasSettledBeforeAssemblyWait =
      qmdPromise.getSettledOutcome() !== undefined;
    const qmdResult = await awaitEnrichmentSection("qmd", qmdPromise);
    if (qmdResult) {
      const t0 = Date.now();
      const {
        memoryResultsLists,
        globalResults,
        preAugmentTopScore,
        maxSpecializedScore,
      } = qmdResult;

      // Merge/dedupe by namespace and path; keep the best score and first non-empty snippet.
      const memoryResultsRaw = mergeGraphExpandedResults(
        memoryResultsLists.flat(),
        [],
      );

      let memoryResults = memoryResultsRaw;

      if (resolveNamespaceCapabilities(this.deps.config).namespaces) {
        memoryResults = memoryResults.filter((r) =>
          recallNamespaces.includes(r.namespace ?? this.deps.namespaceFromPath(r.path)));
      }
      // Artifacts + activity digests are dedicated surfaces, never generic recall.
      memoryResults = memoryResults.filter((r) => !isGenericRecallExcludedPath(r.path, this.deps.config.memoryDir));

      const isFullModeGraphAssist =
        graphCaps.multiGraphMemory &&
        caps.graphAssistInFullMode &&
        recallMode === "full" &&
        memoryResults.length >=
          Math.max(1, this.deps.config.graphAssistMinSeedResults ?? 3);
      const shouldRunGraphExpansion =
        recallMode === "graph_mode" || isFullModeGraphAssist;
      const graphShadowEvalEnabled =
        isFullModeGraphAssist &&
        resolveRecallEnhancementCapabilities(this.deps.config).graphAssistShadowEval === true;
      if (shouldRunGraphExpansion) {
        shouldPersistGraphSnapshot = true;
        graphDecisionShadowMode = graphShadowEvalEnabled;
      }
      if (shouldRunGraphExpansion) {
        const baselineMemoryResults = memoryResults;
        graphBaselinePaths.clear();
        baselineMemoryResults.forEach((result) =>
          graphBaselinePaths.add(result.path),
        );
        if (baselineMemoryResults.length === 0) {
          graphSnapshotStatus = "skipped";
          graphDecisionStatus = "skipped";
          graphDecisionReason =
            "graph recall skipped because baseline retrieval produced no seed results";
          graphSnapshotReason = graphDecisionReason;
          graphSnapshotSeedPaths = [];
          graphSnapshotSeedResults = [];
          graphSnapshotExpandedPaths = [];
          graphExpandedResultPaths.clear();
        } else {
          try {
            const graphExpansion = await awaitAssemblyStep(
              "graph-expansion",
              () =>
                this.deps.expandResultsViaGraph({
                  memoryResults,
                  recallNamespaces,
                  recallResultLimit,
                  deadlineAtMs: enrichmentAssemblyDeadlineAtMs,
                  ...(options.includeLowConfidence === true ? { includeLowConfidence: true } : {}),
                }),
              null as Awaited<ReturnType<typeof this.deps.expandResultsViaGraph>> | null,
            );
            if (!graphExpansion) {
              graphSnapshotStatus = "aborted";
              graphDecisionStatus = "aborted";
              graphDecisionReason = options.abortSignal?.aborted
                ? "graph expansion skipped because recall assembly was aborted"
                : "graph expansion skipped because shared post-retrieval assembly budget expired";
              graphSnapshotReason = graphDecisionReason;
              graphSnapshotSeedPaths = baselineMemoryResults
                .slice(0, Math.max(1, recallResultLimit))
                .map((result) => result.path);
              graphSnapshotSeedResults = this.deps.buildGraphRecallRankedResults(
                baselineMemoryResults,
                () => ["baseline"],
              );
              graphSnapshotExpandedPaths = [];
              graphExpandedResultPaths.clear();
              memoryResults = baselineMemoryResults;
            } else {
              const {
                merged,
                seedPaths,
                expandedPaths,
                seedResults = baselineMemoryResults,
              } = graphExpansion;
              graphSnapshotStatus = "completed";
              graphDecisionStatus = "completed";
              graphDecisionReason = graphShadowEvalEnabled
                ? "graph shadow evaluation completed without altering injected context"
                : "graph expansion merged into recall ranking";
              graphSnapshotReason = graphDecisionReason;
              graphSnapshotSeedPaths = seedPaths;
              graphSnapshotExpandedPaths = expandedPaths;
              graphSnapshotSeedResults = this.deps.buildGraphRecallRankedResults(
                seedResults,
                () => ["baseline"],
              );
              graphExpandedResultPaths.clear();
              expandedPaths.forEach((entry) =>
                graphExpandedResultPaths.add(entry.path),
              );
              memoryResults = graphShadowEvalEnabled
                ? baselineMemoryResults
                : merged;

              if (graphShadowEvalEnabled) {
                const comparison = summarizeGraphShadowComparison(
                  baselineMemoryResults,
                  merged,
                  recallResultLimit,
                );
                graphSnapshotShadowComparison = comparison;
                recordRecallSectionMetric({
                  section: "graphShadow",
                  priority: "enrichment",
                  durationMs: Date.now() - t0,
                  deadlineMs: enrichmentSectionDeadlineMs,
                  source: "fresh",
                  success: true,
                  timing:
                    `on b=${comparison.baselineCount} g=${comparison.graphCount} ` +
                    `ov=${comparison.overlapCount} (${comparison.overlapRatio.toFixed(2)}) ` +
                    `avgDelta=${comparison.averageOverlapDelta.toFixed(3)}`,
                });
              }
            }
          } catch (err) {
            graphSnapshotStatus = "aborted";
            graphDecisionStatus = "aborted";
            graphDecisionReason = `graph expansion failed: ${err instanceof Error ? err.message : String(err)}`;
            graphSnapshotReason = graphDecisionReason;
            graphSnapshotSeedPaths = baselineMemoryResults
              .slice(0, Math.max(1, recallResultLimit))
              .map((result) => result.path);
            graphSnapshotSeedResults = this.deps.buildGraphRecallRankedResults(
              baselineMemoryResults,
              () => ["baseline"],
            );
            graphSnapshotExpandedPaths = [];
            graphExpandedResultPaths.clear();
            log.warn(`graph recall failed open: ${graphDecisionReason}`);
            memoryResults = baselineMemoryResults;
          }
        }
      }

      // Apply mandatory recall safety filters before deadline-bound scoring
      // enrichment. If scoring times out, we must fall back to this filtered
      // list rather than raw QMD hits; boostSearchResults also removes
      // forgotten, lifecycle-filtered, superseded/as_of-invalid, and
      // dream/procedural memories.
      const qmdBoostInput = await this.deps.filterSearchResultsForRecall(
        memoryResults,
        undefined,
        {
          asOfMs,
          // If QMD had already settled before the ordered assembly reached it,
          // do not let unrelated slow enrichment turn those known results into
          // unchecked misses. QMD that only settles during its own wait remains
          // bounded by the shared post-retrieval assembly deadline.
          deadlineAtMs: qmdWasSettledBeforeAssemblyWait
            ? null
            : enrichmentAssemblyDeadlineAtMs,
          abortSignal: options.abortSignal,
          dropUnresolved: true,
          recallNamespaces,
        },
      );

      // Apply recency and access count boosting
      memoryResults = await awaitAssemblyStep(
        "qmd-boost",
        () =>
          this.deps.boostSearchResults(
            qmdBoostInput.results,
            recallNamespaces,
            retrievalQuery,
            qmdBoostInput.memoryByPath,
            { asOfMs },
          ),
        qmdBoostInput.results,
      );

      // Optional LLM reranking (default off). Fail-open if rerank fails/slow.
      if (caps.rerank && this.deps.config.rerankProvider === "local") {
        // (namespace, path) id so cross-namespace same-path hits don't collapse; LLM-safe + cache-stable (#2020).
        const rerankId = (r: QmdSearchResult): string => `${r.namespace ?? ""}|${r.path}`;
        const ranked = await rerankLocalOrNoop({
          query: retrievalQuery,
          candidates: memoryResults
            .slice(0, this.deps.config.rerankMaxCandidates)
            .map((r) => ({
              id: rerankId(r),
              snippet: r.snippet || r.path,
            })),
          local: this.deps.fastLlmForRerank,
          enabled: true,
          timeoutMs: this.deps.config.rerankTimeoutMs,
          maxCandidates: this.deps.config.rerankMaxCandidates,
          cache: this.deps.rerankCache,
          cacheEnabled: caps.rerankCache,
          cacheTtlMs: this.deps.config.rerankCacheTtlMs,
        });
        if (ranked && ranked.length > 0) {
          memoryResults = reorderByRankedKeys(memoryResults, ranked, rerankId);
        }
      }
      if (caps.rerank && this.deps.config.rerankProvider === "cloud") {
        log.debug(
          "rerankProvider=cloud is reserved/experimental in v2.2.0; skipping rerank",
        );
      }

      // Trust-reweighting stage. TrustScore (issue #1577) SUBSUMES the Memory
      // Worth multiplier — exactly one runs (rule 39; the double-multiplier
      // test in trust-score-stage.test.ts pins it structurally). Applied on
      // EVERY recall path via applyTrustScoreToBranch so the gate is consistent
      // (rule 41 parity). Fail-open on lookup errors so recall never breaks.
      {
        // Deadline-bound the trust stage (issue #1905): a slow corpus scan must
        // not outrun the shared enrichment-assembly budget (the source of the
        // 17s qmdPost outliers). On timeout/abort/error the fallback returns
        // the inputs unchanged — the stage is already documented fail-open.
        // Pass the frontmatter already loaded by the safety filter so the stage
        // does O(candidates) work instead of a full-corpus scan.
        const trustT0 = Date.now();
        // The fallback is a distinct object: identity-comparing the outcome to
        // it detects a deadline/abort/error fallback so the metric records the
        // truth. awaitAssemblyStep injects a step signal that aborts the losing
        // task on deadline (or when the request disconnects), so an orphaned
        // corpus scan stops at its next loop boundary (#1905/#1907).
        const trustFallback = { results: memoryResults, trustByPath: recallTrustByPath };
        const trustOutcome = await awaitAssemblyStep(
          "trustStage",
          (stepSignal) =>
            this.deps.applyTrustScoreToBranch(
              memoryResults,
              recallNamespaces,
              caps,
              "hot-qmd",
              qmdBoostInput.memoryByPath,
              stepSignal,
            ),
          trustFallback,
        );
        const trustFellBack = trustOutcome === trustFallback;
        memoryResults = trustOutcome.results;
        recallTrustByPath = trustOutcome.trustByPath;
        recordRecallSectionMetric({
          section: "trustStage",
          priority: "enrichment",
          durationMs: Date.now() - trustT0,
          deadlineMs: enrichmentSectionDeadlineMs,
          source: "fresh",
          success: !trustFellBack,
        });
      }

      // Synapse-inspired confidence gate: check scores BEFORE slicing so
      // reranking doesn't affect which score the gate evaluates.
      //
      // Gate exclusively on the pre-augmentation QMD top score so the threshold
      // stays on the same scale it was calibrated against (raw QMD scores, not
      // post-merge weighted scores). This avoids two pitfalls:
      //   1. The 0.7× contextual weight silently lowering scores below threshold.
      //   2. A direct/temporal hit on a different scale inflating the gate score.
      // We also include maxSpecializedScore so that a strong direct/temporal hit (e.g.
      // an exact entity-name match at score 1.0) is not discarded just because the QMD
      // contextual pass returned a weak result. maxSpecializedScore is post-weight, so
      // direct hits at weight 1.0 stay on the same 0-1 scale as QMD scores.
      // IMPORTANT: maxSpecializedScore is only included when QMD also found something
      // (preAugmentTopScore > 0). When QMD returns nothing, a weak specialized hit must
      // NOT block the embedding fallback safety net — that path exists precisely for the
      // case where QMD finds nothing. Setting effectiveGateScore = 0 when QMD is empty
      // preserves the original behaviour: empty QMD → gate skipped → fallback available.
      const effectiveGateScore =
        preAugmentTopScore > 0
          ? Math.max(preAugmentTopScore, maxSpecializedScore)
          : 0;
      // Capture pre-gate pool size for X-ray before the confidence
      // gate can zero `memoryResults`.  Placing the capture after the
      // gate would record 0 instead of the true pre-gate pool size
      // (issue #570 PR 1 review follow-up).
      xrayBranchPoolSize.hot_qmd = Math.max(
        xrayBranchPoolSize.hot_qmd,
        memoryResults.length,
      );
      let confidenceGateRejected = false;
      if (caps.recallConfidenceGate && effectiveGateScore > 0) {
        if (effectiveGateScore < this.deps.config.recallConfidenceGateThreshold) {
          log.debug(
            `recall: confidence gate rejected ${memoryResults.length} results (effective score ${effectiveGateScore.toFixed(3)} below ${this.deps.config.recallConfidenceGateThreshold})`,
          );
          memoryResults = [];
          confidenceGateRejected = true;
        }
      }

      // Diversify via MMR over the full candidate pool *before* truncating to
      // the final recall limit. Running MMR after the slice would be unable
      // to promote diverse candidates sitting just below the cutoff.
      memoryResults = this.deps.diversifyAndLimitRecallResults(
        "memories",
        memoryResults,
        recallResultLimit,
        retrievalQuery,
        caps,
      );

      // E-Mem-inspired memory reconstruction: fill gaps for referenced entities
      if (resolveRecallEnhancementCapabilities(this.deps.config).memoryReconstruction && memoryResults.length > 0) {
        try {
          const snippets = memoryResults.map((r) => r.snippet);
          // Extract entity paths already present in recall results to avoid duplicates
          const coveredRefs = memoryResults
            .map((r) => r.path)
            .filter((p) => p.startsWith("entities/"))
            .map((p) => p.replace(/^entities\//, "").replace(/\.md$/, ""));
          const knownEntities = await profileStorage.listEntityNames();
          const missing = findUnresolvedEntityRefs(
            snippets,
            coveredRefs,
            knownEntities,
          );
          if (missing.length > 0) {
            // Allow up to maxExpansions successful entity expansions
            const budget = this.deps.config.memoryReconstructionMaxExpansions;
            let expanded = 0;
            for (const entityName of missing) {
              if (expanded >= budget) break;
              const raw = await profileStorage.readEntity(entityName);
              if (raw && raw.length > 0) {
                const snippet =
                  raw.length > 300 ? raw.slice(0, 300) + "…" : raw;
                memoryResults.push({
                  docid: `entity:${entityName}`,
                  path: `entities/${entityName}.md`,
                  snippet: `[Entity: ${entityName}] ${snippet}`,
                  score: 0.1,
                });
                expanded++;
              }
            }
            if (expanded > 0) {
              log.debug(`recall: reconstructed ${expanded} entity contexts`);
            }
          }
        } catch (err) {
          log.warn("recall: memory reconstruction failed (non-fatal)", err);
        }
      }

      if (memoryResults.length > 0) {
        if (shouldPersistGraphSnapshot) {
          graphSnapshotFinalResults = this.deps.buildGraphRecallRankedResults(
            memoryResults,
            graphSourceLabelsForPath,
          );
        }
        recallSource = "hot_qmd";
        recalledMemoryCount = memoryResults.length;
        this.deps.publishRecallResults({
          title: "Relevant Memories",
          results: memoryResults,
          sectionBuckets,
          retrievalQuery,
          sessionKey,
          identityInjection: {
            mode: identityInjectionModeUsed,
            injectedChars: identityInjectedChars,
            truncated: identityInjectionTruncated,
          },
        trustByPath: recallTrustByPath,
        });
        recalledMemoryPaths = memoryResults
          .map((result) => result.path)
          .filter(Boolean);
        xrayRecalledResults = memoryResults;
      } else if (!confidenceGateRejected) {
        // Only attempt fallback paths if the confidence gate did NOT fire.
        // When the gate rejects, all recall pathways are skipped to prevent
        // low-relevance results from polluting context.
        const queryAwarePrefilter = await queryAwarePrefilterPromise;
        if (queryAwarePrefilter.candidatePaths?.size !== 0) {
        let scoped = await awaitAssemblyStep(
          "embedding-fallback",
          async () => {
            const embeddingResults = await this.deps.searchEmbeddingFallback(
              retrievalQuery,
              embeddingFetchLimit,
            );
            const prefilteredEmbeddingResults = applyQueryAwareCandidateFilter(
              embeddingResults,
              queryAwarePrefilter.candidatePaths,
            );
            const scopedCandidates = filterRecallCandidates(
              prefilteredEmbeddingResults,
              {
                namespacesEnabled: resolveNamespaceCapabilities(this.deps.config).namespaces,
                recallNamespaces,
                resolveNamespace: (p) => this.deps.namespaceFromPath(p),
                limit: embeddingFetchLimit,
                memoryRoot: this.deps.config.memoryDir,
              },
            );
            const boostedScoped = await this.deps.boostSearchResults(
              scopedCandidates,
              recallNamespaces,
              retrievalQuery,
              undefined,
              { asOfMs },
            );
            // MMR runs on the pre-truncation pool so diverse candidates just
            // below the cutoff can be promoted into the injected set.
            xrayBranchPoolSize.hot_embedding = Math.max(
              xrayBranchPoolSize.hot_embedding,
              boostedScoped.length,
            );
            return this.deps.diversifyAndLimitRecallResults(
              "memories",
              boostedScoped,
              recallResultLimit,
              retrievalQuery,
              caps,
            );
          },
          [] as QmdSearchResult[],
        );
        // Issue #1577 — apply TrustScore on the embedding-fallback path so the
        // feature gate is consistent across ALL recall paths (rule 41 parity).
        {
          // Deadline-bound (issue #1905). This branch has no preloaded
          // frontmatter map (boost ran without one), so pass undefined and let
          // the stage's corpus/direct-read fallback cover it — identical lookup
          // semantics (rule 41 parity).
          const trustT0 = Date.now();
          const trustFallback = { results: scoped, trustByPath: recallTrustByPath };
          const trustOutcome = await awaitAssemblyStep(
            "trustStage",
            (stepSignal) =>
              this.deps.applyTrustScoreToBranch(
                scoped,
                recallNamespaces,
                caps,
                "embedding-fallback",
                undefined,
                stepSignal,
              ),
            trustFallback,
          );
          const trustFellBack = trustOutcome === trustFallback;
          scoped = trustOutcome.results;
          recallTrustByPath = trustOutcome.trustByPath;
          recordRecallSectionMetric({
            section: "trustStage",
            priority: "enrichment",
            durationMs: Date.now() - trustT0,
            deadlineMs: enrichmentSectionDeadlineMs,
            source: "fresh",
            success: !trustFellBack,
          });
        }
        if (scoped.length > 0) {
          if (shouldPersistGraphSnapshot) {
            graphSnapshotFinalResults = this.deps.buildGraphRecallRankedResults(
              scoped,
              graphSourceLabelsForPath,
            );
          }
          recallSource = "hot_embedding";
          recalledMemoryCount = scoped.length;
          this.deps.publishRecallResults({
            title: "Relevant Memories",
            results: scoped,
            sectionBuckets,
            retrievalQuery,
            sessionKey,
            identityInjection: {
              mode: identityInjectionModeUsed,
              injectedChars: identityInjectedChars,
              truncated: identityInjectionTruncated,
            },
          trustByPath: recallTrustByPath,
          });
          recalledMemoryPaths = scoped
            .map((result) => result.path)
            .filter(Boolean);
          xrayRecalledResults = scoped;
        } else {
          const longTerm = await this.deps.applyColdFallbackPipeline({
            prompt: retrievalQuery,
            recallNamespaces,
            recallResultLimit,
            recallMode,
            caps,
            graphCaps,
            queryAwarePrefilter,
            abortSignal: options.abortSignal,
            onDegradation: (degradation) => {
              backendDegradations.push(degradation);
            },
            xrayPoolSizeSink: xrayColdPoolSink,
            trustByPathSink,
            deadlineAtMs: enrichmentAssemblyDeadlineAtMs,
            asOfMs,
            ...(options.includeLowConfidence === true ? { includeLowConfidence: true } : {}),
          });
          // Issue #1577 — read the cold pipeline's trust map back so cold
          // results feed X-ray + epistemic rendering + publisher quarantine
          // filtering (rule 41 parity; review: the sink was never read back).
          recallTrustByPath = trustByPathSink.trustByPath;
          if (longTerm.length > 0) {
            if (shouldPersistGraphSnapshot) {
              graphSnapshotFinalResults = this.deps.buildGraphRecallRankedResults(
                longTerm,
                graphSourceLabelsForPath,
              );
            }
            recallSource = "cold_fallback";
            recalledMemoryCount = longTerm.length;
            this.deps.publishRecallResults({
              title: "Long-Term Memories (Fallback)",
              results: longTerm,
              sectionBuckets,
              retrievalQuery,
              sessionKey,
              identityInjection: {
                mode: identityInjectionModeUsed,
                injectedChars: identityInjectedChars,
                truncated: identityInjectionTruncated,
              },
            trustByPath: recallTrustByPath,
            });
            recalledMemoryPaths = longTerm
              .map((result) => result.path)
              .filter(Boolean);
            xrayRecalledResults = longTerm;
          }
        }
        }
      }

      if (globalResults.length > 0) {
        this.deps.appendRecallSection(
          sectionBuckets,
          "workspace-context",
          this.deps.formatQmdResults("Workspace Context", globalResults, sessionKey, recallTrustByPath),
        );
      }

      recordRecallSectionMetric({
        section: "qmdPost",
        priority: "enrichment",
        durationMs: Date.now() - t0,
        deadlineMs: enrichmentSectionDeadlineMs,
        source: "fresh",
        success: true,
      });

      // If the user is pushing back ("that's not right", "why did you say that"),
      // gently suggest an explicit workflow to inspect what was recalled and record feedback.
      // IMPORTANT: this is suggestion-only; never auto-mark negatives.
      if (isDisagreementPrompt(prompt)) {
        this.deps.appendRecallSection(
          sectionBuckets,
          "memories",
          [
            "## Retrieval Feedback Helper",
            "",
            "The user may be disputing an answer. To debug whether retrieval misled the response:",
            "- Use tool `memory_last_recall` to see which memory IDs were injected into context.",
            "- Use tool `memory_intent_debug` to inspect the planner mode decision and graph fallback reason.",
            "- If negative examples are enabled, you can use `memory_feedback_last_recall` to mark specific recalled IDs as not useful.",
            "",
            "Safety: do not mass-mark negatives automatically; prefer explicit IDs.",
          ].join("\n"),
        );
      }
    } else if (recallResultLimit > 0 && !this.deps.qmd.isAvailable()) {
      // Fallback: embeddings first, then recency-only.
      const queryAwarePrefilter = await queryAwarePrefilterPromise;
      if (queryAwarePrefilter.candidatePaths?.size !== 0) {
        let scoped = await awaitAssemblyStep(
          "embedding-fallback",
          async () => {
            const embeddingResults = await this.deps.searchEmbeddingFallback(
              retrievalQuery,
              embeddingFetchLimit,
            );
            const prefilteredEmbeddingResults = applyQueryAwareCandidateFilter(
              embeddingResults,
              queryAwarePrefilter.candidatePaths,
            );
            const scopedCandidates = filterRecallCandidates(
              prefilteredEmbeddingResults,
              {
                namespacesEnabled: resolveNamespaceCapabilities(this.deps.config).namespaces,
                recallNamespaces,
                resolveNamespace: (p) => this.deps.namespaceFromPath(p),
                limit: embeddingFetchLimit,
                memoryRoot: this.deps.config.memoryDir,
              },
            );
            const boostedScoped = await this.deps.boostSearchResults(
              scopedCandidates,
              recallNamespaces,
              retrievalQuery,
              undefined,
              { asOfMs },
            );
            // MMR runs on the pre-truncation pool so diverse candidates just
            // below the cutoff can be promoted into the injected set.
            xrayBranchPoolSize.hot_embedding = Math.max(
              xrayBranchPoolSize.hot_embedding,
              boostedScoped.length,
            );
            return this.deps.diversifyAndLimitRecallResults(
              "memories",
              boostedScoped,
              recallResultLimit,
              retrievalQuery,
              caps,
            );
          },
          [] as QmdSearchResult[],
        );
        // Issue #1577 — apply TrustScore on the embedding-fallback path so the
        // feature gate is consistent across ALL recall paths (rule 41 parity).
        {
          // Deadline-bound (issue #1905); no preloaded map on this branch.
          const trustT0 = Date.now();
          const trustFallback = { results: scoped, trustByPath: recallTrustByPath };
          const trustOutcome = await awaitAssemblyStep(
            "trustStage",
            (stepSignal) =>
              this.deps.applyTrustScoreToBranch(
                scoped,
                recallNamespaces,
                caps,
                "embedding-fallback",
                undefined,
                stepSignal,
              ),
            trustFallback,
          );
          const trustFellBack = trustOutcome === trustFallback;
          scoped = trustOutcome.results;
          recallTrustByPath = trustOutcome.trustByPath;
          recordRecallSectionMetric({
            section: "trustStage",
            priority: "enrichment",
            durationMs: Date.now() - trustT0,
            deadlineMs: enrichmentSectionDeadlineMs,
            source: "fresh",
            success: !trustFellBack,
          });
        }
      if (scoped.length > 0) {
        if (shouldPersistGraphSnapshot) {
          graphSnapshotFinalResults = this.deps.buildGraphRecallRankedResults(
            scoped,
            graphSourceLabelsForPath,
          );
        }
        recallSource = "hot_embedding";
        recalledMemoryCount = scoped.length;
        this.deps.publishRecallResults({
          title: "Relevant Memories",
          results: scoped,
          sectionBuckets,
          retrievalQuery,
          sessionKey,
          identityInjection: {
            mode: identityInjectionModeUsed,
            injectedChars: identityInjectedChars,
            truncated: identityInjectionTruncated,
          },
        trustByPath: recallTrustByPath,
        });
        recalledMemoryPaths = scoped
          .map((result) => result.path)
          .filter(Boolean);
        xrayRecalledResults = scoped;
      } else {
        const memories = await awaitAssemblyStep(
          "recent-memory-read",
          () => this.deps.readAllMemoriesForNamespaces(recallNamespaces),
          [] as MemoryFile[],
        );
        if (memories.length > 0) {
          // Filter out non-active memories.  Delegate to
          // shouldFilterSupersededFromRecall for superseded-status logic so
          // that the recent-scan path and the boostSearchResults (QMD) path
          // have identical semantics:
          //   • temporalSupersessionEnabled=false  → never filter superseded
          //     (mirrors QMD path; user disabled the feature, so old marks
          //     are ignored and all memories surface)
          //   • temporalSupersessionIncludeInRecall=true → never filter (audit mode)
          //   • enabled=true + includeInRecall=false → filter superseded
          // Previously the recent-scan path checked `enabled && includeInRecall`
          // directly, which disagreed with the QMD path when enabled=false
          // (memories were still filtered, contrary to the kill-switch intent).
          // Using the shared gate fixes both Finding 2 and Finding 3 from
          // PR #402 (round 6).
          const supersessionOptions = {
            enabled: lifecycleCaps.temporalSupersession,
            includeInRecall: this.deps.config.temporalSupersessionIncludeInRecall,
          };
          // Cursor Medium on PR #713: when `as_of` is active, the
          // recent-scan path used to strip every non-active status
          // (including superseded) before `boostSearchResults` ran,
          // so the as_of bypass inside boostSearchResults never had
          // a chance to admit historically-valid records. Pass
          // superseded candidates through here when as_of is active;
          // boostSearchResults's `[valid_at, invalid_at)` evaluation
          // is the authoritative gate. Other non-active statuses
          // (archived, forgotten, rejected) stay excluded — historical
          // recall is about supersession history, not about reviving
          // records the operator explicitly dropped.
          const asOfActive =
            typeof asOfMs === "number" && Number.isFinite(asOfMs);
          const activeMemories = memories.filter(
            (m) => {
              if (isGenericRecallExcludedPath(m.path, this.deps.config.memoryDir)) return false;
              const status = m.frontmatter.status;
              if (!status || status === "active") return true;
              if (status === "superseded") {
                if (asOfActive) return true;
                // Include superseded memory only if the canonical gate says
                // NOT to filter it (kill switch off or audit mode on).
                return !shouldFilterSupersededFromRecall(m.frontmatter, supersessionOptions);
              }
              // Other non-active statuses (archived, retired, etc.) are
              // excluded from the recent-scan path by default.
              return false;
            },
          );
          // Convert all active memories to QmdSearchResult with recency-based
          // baseline score, then pass through boostSearchResults so temporal/tag
          // boosts apply consistently with the primary QMD retrieval path.
          // Cap AFTER boosting so boosted-but-recency-ranked memories can surface.
          // Pass a pre-populated memoryByPath so boostSearchResults skips redundant
          // disk reads for files already loaded by readAllMemoriesForNamespaces.
          const queryAwareScopedMemories = queryAwarePrefilter.candidatePaths
            ? activeMemories.filter((memory) =>
                queryAwarePrefilter.candidatePaths?.has(memory.path),
              )
            : activeMemories;
          if (
            queryAwarePrefilter.candidatePaths &&
            queryAwareScopedMemories.length === 0
          ) {
            const longTerm = await this.deps.applyColdFallbackPipeline({
              prompt: retrievalQuery,
              recallNamespaces,
              recallResultLimit,
              recallMode,
              caps,
              graphCaps,
              queryAwarePrefilter,
              abortSignal: options.abortSignal,
              onDegradation: (degradation) => {
                backendDegradations.push(degradation);
              },
              xrayPoolSizeSink: xrayColdPoolSink,
              trustByPathSink,
              deadlineAtMs: enrichmentAssemblyDeadlineAtMs,
              asOfMs,
              ...(options.includeLowConfidence === true ? { includeLowConfidence: true } : {}),
            });
            // Issue #1577 — read the cold pipeline's trust map back (rule 41).
            recallTrustByPath = trustByPathSink.trustByPath;
            if (longTerm.length > 0) {
              recallSource = "cold_fallback";
              recalledMemoryCount = longTerm.length;
              this.deps.publishRecallResults({
                title: "Long-Term Memories (Fallback)",
                results: longTerm,
                sectionBuckets,
                retrievalQuery,
                sessionKey,
                identityInjection: {
                  mode: identityInjectionModeUsed,
                  injectedChars: identityInjectedChars,
                  truncated: identityInjectionTruncated,
                },
              trustByPath: recallTrustByPath,
              });
              recalledMemoryPaths = longTerm
                .map((result) => result.path)
                .filter(Boolean);
              xrayRecalledResults = longTerm;
            }
          } else {
            let recent = await awaitAssemblyStep(
              "recent-memory-scan",
              async () => {
                const recentSorted = queryAwareScopedMemories.sort(
                  (a, b) =>
                    new Date(b.frontmatter.updated).getTime() -
                    new Date(a.frontmatter.updated).getTime(),
                );
                const preloadedMap = new Map<string, MemoryFile>(
                  queryAwareScopedMemories
                    .filter((m) => m.path)
                    .map((m) => [m.path, m]),
                );
                const recentAsResults: QmdSearchResult[] = recentSorted.map(
                  (m, i) => ({
                    docid: m.frontmatter.id,
                    path: m.path,
                    namespace: this.deps.namespaceFromPath(m.path),
                    snippet: m.content,
                    score: 1.0 - i / Math.max(recentSorted.length, 1),
                  }),
                );
                const boostedRecent = (
                  await this.deps.boostSearchResults(
                    recentAsResults,
                    recallNamespaces,
                    retrievalQuery,
                    preloadedMap,
                    { asOfMs },
                  )
                ).sort((a, b) => b.score - a.score);
                // MMR runs on the pre-truncation pool so diverse candidates just
                // below the cutoff can be promoted into the injected set.
                xrayBranchPoolSize.recent_scan = Math.max(
                  xrayBranchPoolSize.recent_scan,
                  boostedRecent.length,
                );
                return this.deps.diversifyAndLimitRecallResults(
                  "memories",
                  boostedRecent,
                  recallResultLimit,
                  retrievalQuery,
                  caps,
                );
              },
              [] as QmdSearchResult[],
            );
            // Issue #1577 — apply TrustScore on the recent-scan path so the
            // feature gate is consistent across ALL recall paths (rule 41).
            {
              // Deadline-bound (issue #1905). The recent-scan branch already
              // loaded every candidate's MemoryFile (queryAwareScopedMemories),
              // so hand that frontmatter to the stage as the preloaded map —
              // the trust/memory-worth lookup then does zero corpus scans.
              const trustT0 = Date.now();
              const recentPreloaded = new Map<string, MemoryFile>(
                queryAwareScopedMemories.filter((m) => m.path).map((m) => [m.path, m]),
              );
              const trustFallback = { results: recent, trustByPath: recallTrustByPath };
              const trustOutcome = await awaitAssemblyStep(
                "trustStage",
                (stepSignal) =>
                  this.deps.applyTrustScoreToBranch(
                    recent,
                    recallNamespaces,
                    caps,
                    "recent-scan",
                    recentPreloaded,
                    stepSignal,
                  ),
                trustFallback,
              );
              const trustFellBack = trustOutcome === trustFallback;
              recent = trustOutcome.results;
              recallTrustByPath = trustOutcome.trustByPath;
              recordRecallSectionMetric({
                section: "trustStage",
                priority: "enrichment",
                durationMs: Date.now() - trustT0,
                deadlineMs: enrichmentSectionDeadlineMs,
                source: "fresh",
                success: !trustFellBack,
              });
            }

            if (recent.length > 0) {
              if (shouldPersistGraphSnapshot) {
                graphSnapshotFinalResults = this.deps.buildGraphRecallRankedResults(
                  recent,
                  graphSourceLabelsForPath,
                );
              }
              recallSource = "recent_scan";
              recalledMemoryCount = recent.length;
              this.deps.publishRecallResults({
                title: "Recent Memories",
                results: recent,
                sectionBuckets,
                retrievalQuery,
                sessionKey,
                identityInjection: {
                  mode: identityInjectionModeUsed,
                  injectedChars: identityInjectedChars,
                  truncated: identityInjectionTruncated,
                },
              trustByPath: recallTrustByPath,
              });
              recalledMemoryPaths = recent
                .map((result) => result.path)
                .filter(Boolean);
              xrayRecalledResults = recent;
            } else {
              const longTerm = await this.deps.applyColdFallbackPipeline({
                prompt: retrievalQuery,
                recallNamespaces,
                recallResultLimit,
                recallMode,
                caps,
                graphCaps,
                queryAwarePrefilter,
                abortSignal: options.abortSignal,
                onDegradation: (degradation) => {
                  backendDegradations.push(degradation);
                },
                xrayPoolSizeSink: xrayColdPoolSink,
                trustByPathSink,
                deadlineAtMs: enrichmentAssemblyDeadlineAtMs,
                asOfMs,
                ...(options.includeLowConfidence === true ? { includeLowConfidence: true } : {}),
              });
              // Issue #1577 — read the cold pipeline's trust map back (rule 41).
              recallTrustByPath = trustByPathSink.trustByPath;
              if (longTerm.length > 0) {
                if (shouldPersistGraphSnapshot) {
                  graphSnapshotFinalResults =
                    this.deps.buildGraphRecallRankedResults(
                      longTerm,
                      graphSourceLabelsForPath,
                    );
                }
                recallSource = "cold_fallback";
                recalledMemoryCount = longTerm.length;
                this.deps.publishRecallResults({
                  title: "Long-Term Memories (Fallback)",
                  results: longTerm,
                  sectionBuckets,
                  retrievalQuery,
                  sessionKey,
                  identityInjection: {
                    mode: identityInjectionModeUsed,
                    injectedChars: identityInjectedChars,
                    truncated: identityInjectionTruncated,
                  },
                trustByPath: recallTrustByPath,
                });
                recalledMemoryPaths = longTerm
                  .map((result) => result.path)
                  .filter(Boolean);
                xrayRecalledResults = longTerm;
              }
            }
          }
        } else {
          const longTerm = await this.deps.applyColdFallbackPipeline({
            prompt: retrievalQuery,
            recallNamespaces,
            recallResultLimit,
            recallMode,
            caps,
            graphCaps,
            queryAwarePrefilter,
            abortSignal: options.abortSignal,
            onDegradation: (degradation) => {
              backendDegradations.push(degradation);
            },
            xrayPoolSizeSink: xrayColdPoolSink,
            trustByPathSink,
            deadlineAtMs: enrichmentAssemblyDeadlineAtMs,
            asOfMs,
            ...(options.includeLowConfidence === true ? { includeLowConfidence: true } : {}),
          });
          // Issue #1577 — read the cold pipeline's trust map back (rule 41).
          recallTrustByPath = trustByPathSink.trustByPath;
          if (longTerm.length > 0) {
            if (shouldPersistGraphSnapshot) {
              graphSnapshotFinalResults = this.deps.buildGraphRecallRankedResults(
                longTerm,
                graphSourceLabelsForPath,
              );
            }
            recallSource = "cold_fallback";
            recalledMemoryCount = longTerm.length;
            this.deps.publishRecallResults({
              title: "Long-Term Memories (Fallback)",
              results: longTerm,
              sectionBuckets,
              retrievalQuery,
              sessionKey,
              identityInjection: {
                mode: identityInjectionModeUsed,
                injectedChars: identityInjectedChars,
                truncated: identityInjectionTruncated,
              },
            trustByPath: recallTrustByPath,
            });
            recalledMemoryPaths = longTerm
              .map((result) => result.path)
              .filter(Boolean);
            xrayRecalledResults = longTerm;
          }
        }
      }
      }

      if (isDisagreementPrompt(prompt)) {
        this.deps.appendRecallSection(
          sectionBuckets,
          "memories",
          [
            "## Retrieval Feedback Helper",
            "",
            "The user may be disputing an answer. To debug whether retrieval misled the response:",
            "- Use tool `memory_last_recall` to see which memory IDs were injected into context.",
            "- Use tool `memory_intent_debug` to inspect the planner mode decision and graph fallback reason.",
            "- If graph recall is enabled, use `memory_graph_explain_last_recall` to inspect seed/expanded graph paths.",
            "- If negative examples are enabled, you can use `memory_feedback_last_recall` to mark specific recalled IDs as not useful.",
            "",
            "Safety: do not mass-mark negatives automatically; prefer explicit IDs.",
          ].join("\n"),
        );
      }
    }

    const phase2AfterQmdMs = Date.now() - recallStart;
    if (shouldPersistGraphSnapshot) {
      if (!graphSnapshotStatus) {
        graphSnapshotStatus = "skipped";
      }
      if (!graphSnapshotReason) {
        graphSnapshotReason = qmdAvailable
          ? "graph recall skipped before expansion"
          : "graph recall skipped because QMD was unavailable";
      }
      if (graphDecisionStatus === "not_requested") {
        graphDecisionStatus = graphSnapshotStatus;
      }
      if (!graphDecisionReason) {
        graphDecisionReason = graphSnapshotReason;
      }
      await this.deps.recordLastGraphRecallSnapshot({
        storage: profileStorage,
        prompt: retrievalQuery,
        recallMode,
        recallNamespaces,
        seedPaths: graphSnapshotSeedPaths,
        expandedPaths: graphSnapshotExpandedPaths,
        status: graphSnapshotStatus,
        reason: graphSnapshotReason,
        shadowMode: graphDecisionShadowMode,
        queryIntent,
        seedResults: graphSnapshotSeedResults,
        finalResults: graphSnapshotFinalResults,
        shadowComparison: graphSnapshotShadowComparison,
      });
    }
    await this.deps.recordLastIntentSnapshot({
      storage: profileStorage,
      snapshot: buildIntentDebugSnapshot(),
    });

    // 2.5. Compression guideline recall section (v8.11 Task 5)
    if (
      this.deps.isRecallSectionEnabled(
        "compression-guidelines",
        resolveCompressionCapabilities(this.deps.config).compressionGuidelineLearning === true,
      )
    ) {
      const compressionGuidelineSection =
        await this.deps.buildCompressionGuidelineRecallSection();
      if (compressionGuidelineSection) {
        this.deps.appendRecallSection(
          sectionBuckets,
          "compression-guidelines",
          compressionGuidelineSection,
        );
      }
    }

    // 3. Transcript/summaries/conversation/compounding are fetched in parallel above,
    // then assembled here according to recallPipeline order.
    if (transcriptSection) {
      this.deps.appendRecallSection(sectionBuckets, "transcript", transcriptSection);
    }
    // Compaction reset context — independent section so it works even when transcript is disabled.
    if (compactionSection) {
      this.deps.appendRecallSection(
        sectionBuckets,
        "compaction-reset",
        compactionSection,
      );
    }
    if (summariesSection) {
      this.deps.appendRecallSection(sectionBuckets, "summaries", summariesSection);
    }
    if (conversationRecallSection) {
      this.deps.appendRecallSection(
        sectionBuckets,
        "conversation-recall",
        conversationRecallSection,
      );
    }
    const compoundingSection = await awaitEnrichmentSection(
      "compounding",
      compoundingPromise,
    );
    if (compoundingSection) {
      this.deps.appendRecallSection(
        sectionBuckets,
        "compounding",
        compoundingSection,
      );
    }

    let curiosityFooter: string | undefined;
    if (
      this.deps.config.injectQuestions &&
      this.deps.isRecallSectionEnabled("questions", true)
    ) {
      const questions = await profileStorage.readQuestions({
        unresolvedOnly: true,
      });
      const topQuestion = selectCuriosityQuestion(questions);
      if (topQuestion) {
        curiosityFooter = formatCuriosityFooter(topQuestion);
      }
    }

    const phase2QuestionsDoneMs = Date.now() - recallStart;
    const finalizedQueryAwarePrefilter = await queryAwarePrefilterPromise;
    const phase2QapDoneMs = Date.now() - recallStart;
    throwIfRecallAborted(options.abortSignal);
    if (
      timings.queryAware &&
      finalizedQueryAwarePrefilter.candidatePaths?.size
    ) {
      const helpedCount = recalledMemoryPaths.filter((memoryPath) =>
        finalizedQueryAwarePrefilter.candidatePaths?.has(memoryPath),
      ).length;
      timings.queryAware = `${timings.queryAware};helped=${helpedCount}`;
    }

    // --- Timing summary ---
    timings.total = `${Date.now() - recallStart}ms`;
    this.deps.profiler.endSpan("assembly", profileTraceId);
    log.info(
      `recall phase-2 checkpoints: afterQmd=${phase2AfterQmdMs}ms, afterQuestions=${phase2QuestionsDoneMs}ms, afterQap=${phase2QapDoneMs}ms`,
    );
    const timingParts = Object.entries(timings)
      .map(([k, v]) => `${k}=${v}`)
      .join(", ");
    log.info(`recall timings: ${timingParts}`);
    recordRecallTiming(this.deps.config, {
      ...timings,
      timestamp: new Date().toISOString(),
      namespace: selfNamespace,
      total: timings.total,
      recallPlan: timings.recallPlan,
      queryPolicy: timings.queryPolicy,
    });

    const recallBudgetChars = this.deps.getRecallBudgetChars(
      options.budgetCharsOverride,
    );
    const assembledRecall = this.deps.assembleRecallSections(
      sectionBuckets,
      contextBudgetForFooter(recallBudgetChars, curiosityFooter),
    );
    recalledMemoryIds = assembledRecall.includedMemoryIds;
    recalledMemoryPaths = assembledRecall.includedMemoryPaths;
    recalledMemoryNamespaces = assembledRecall.includedMemoryNamespaces;
    recalledMemoryCount = assembledRecall.includedMemoryIds.length;
    this.deps.trackMemoryAccess(
      assembledRecall.includedMemoryIds,
      assembledRecall.includedMemoryPaths,
      assembledRecall.includedMemoryNamespaces,
    );
    const recalledContext =
      assembledRecall.sections.length === 0
        ? ""
        : assembledRecall.sections.join("\n\n---\n\n");
    const composition: RecallContextComposition = boundRecallContextComposition({
      context: recalledContext,
      footer: curiosityFooter,
      maxChars: recallBudgetChars,
    });
    const context = composeRecallContext(composition);
    options.onContextComposition?.(composition);
    const compositionTruncated =
      context.length <
      composeRecallContext({ context: recalledContext, footer: curiosityFooter }).length;
    const sourcesUsed = this.deps.collectLastRecallSources(
      sectionBuckets,
      recallSource,
    );
    const budgetsApplied = this.deps.buildLastRecallBudgetSummary({
      requestedTopK,
      recallResultLimit,
      qmdFetchLimit,
      qmdHybridFetchLimit,
      finalContextChars: context.length,
      truncated: assembledRecall.truncated || compositionTruncated,
      includedSections: assembledRecall.includedIds,
      omittedSections: assembledRecall.omittedIds,
      includedMemoryIds: assembledRecall.includedMemoryIds,
      includedMemoryPaths: assembledRecall.includedMemoryPaths,
      includedMemoryNamespaces: assembledRecall.includedMemoryNamespaces,
      omittedMemoryIds: assembledRecall.omittedMemoryIds,
    });

    // X-ray capture (issue #570 PR 1).  Only fires when the caller
    // explicitly opts in via `xrayCapture: true`.  No behavior change
    // when the flag is absent — this branch and the setter both
    // short-circuit.  Captured data is composed from values we have
    // already derived above, so capture cost is a single object
    // allocation; no new recall work is performed.
    //
    // Skip capture when the caller has already aborted this recall —
    // otherwise a canceled call could clobber a prior successful
    // capture that the capturing caller has not yet read back
    // (issue #570 PR 1 review follow-up).
    if (
      options.xrayCapture === true &&
      !options.abortSignal?.aborted
    ) {
      try {
        const servedBy = mapRecallSourceToXrayServedBy(recallSource);
        // Derive xray results from `recalledMemoryPaths` as the single
        // source of truth — `recalledMemoryIds` and `recalledMemoryPaths`
        // are built with two independent filters upstream
        // (`extractMemoryIdsFromResults` drops paths whose filename does
        // not match `*.md`, while `.map(path).filter(Boolean)` drops
        // empty paths only), so zipping them positionally would silently
        // misalign when the two filters differ.  Re-deriving `memoryId`
        // from the path here guarantees `memoryId` and `path` refer to
        // the same underlying result.
        const idFromPath = (p: string): string | null => {
          const match = p.match(/([^/\\]+)\.md$/);
          return match ? match[1] ?? null : null;
        };
        // Build a path → QmdSearchResult index so we can pull per-result
        // explain data (e.g. reinforcementBoost) from the result that
        // boostSearchResults annotated before surfacing to xray.
        const xrayResultByPath = new Map<string, QmdSearchResult>(
          xrayRecalledResults.map((xr) => [`${xr.namespace ?? ""}\0${xr.path}`, xr]),
        );
        const results: RecallXrayResult[] = [];
        for (let xrayIdx = 0; xrayIdx < recalledMemoryPaths.length; xrayIdx += 1) {
          const recalledPath = recalledMemoryPaths[xrayIdx]!;
          // Namespace from the aligned capture array, not re-derived from a relative path (#2020).
          const recalledNamespace = recalledMemoryNamespaces[xrayIdx];
          const derivedId = idFromPath(recalledPath);
          if (!derivedId) continue;
          const xrayResult = xrayResultByPath.get(`${recalledNamespace ?? ""}\0${recalledPath}`);
          const scoreDecomposition: RecallXrayScoreDecomposition = {
            final: xrayResult?.score ?? 0,
          };
          if (
            xrayResult?.explain?.reinforcementBoost !== undefined &&
            xrayResult.explain.reinforcementBoost > 0
          ) {
            scoreDecomposition.reinforcementBoost =
              xrayResult.explain.reinforcementBoost;
          }
          const resultNamespace = recalledNamespace ?? this.deps.namespaceFromPath(recalledPath);
          let provenance: RecallXrayResult["provenance"] | undefined;
          let sourceSpan: RecallXrayResult["sourceSpan"] | undefined;
          try {
            const resultStorage =
              await this.deps.storageRouter.storageFor(resultNamespace);
            const memory = await resultStorage.readMemoryByPath(recalledPath);
            if (memory) {
              provenance = buildRetrievedMemoryProvenance(memory, {
                namespace: resultNamespace,
                retrievalReason: `served-by=${servedBy}`,
                currentContextScopes: options.currentContextScopes,
              });
              // Claim-level provenance span (#1575 PR 3): surface the first
              // source excerpt so the X-ray shows the literal utterance this
              // fact derives from. Thin read from already-loaded frontmatter.
              const fm = memory.frontmatter;
              if (fm.sources && fm.sources.length > 0) {
                sourceSpan = {
                  quote: fm.sources[0]!.quote,
                  observedAt: fm.sources[0]!.observedAt,
                  provenance: fm.provenance ?? "none",
                };
              }
            }
          } catch {
            // X-ray capture is best-effort; missing provenance must not
            // perturb recall or suppress the surfaced result.
          }
          const trustItem =
            recallTrustByPath?.get(JSON.stringify([recalledNamespace ?? "", recalledPath])) ??
            recallTrustByPath?.get(recalledPath);
          results.push({
            memoryId: derivedId,
            path: recalledPath,
            servedBy,
            scoreDecomposition,
            admittedBy: [],
            ...(provenance ? { provenance } : {}),
            ...(sourceSpan ? { sourceSpan } : {}),
            // Issue #1577 — per-result trust projection for X-ray visibility.
            ...(trustItem ? { trust: projectTrustForXray(trustItem) } : {}),
          });
        }
        // Issue #1577 — surface quarantined items in X-ray with their exclusion
        // reason so operators see WHY a memory was dropped (rule 34 — exclusion
        // must never look like "no result"). These are NOT in recalledMemoryPaths
        // (they were excluded from injection) but ARE in the trust map.
        if (recallTrustByPath) {
          for (const qItem of recallTrustByPath.values()) {
            // Map is keyed by composite trustResultKey; read the plain path from the item (#2020).
            if (!qItem.quarantined || recalledMemoryPaths.includes(qItem.path)) continue;
            const qId = idFromPath(qItem.path);
            if (!qId) continue;
            results.push({
              memoryId: qId,
              path: qItem.path,
              servedBy,
              scoreDecomposition: { final: 0 },
              admittedBy: [],
              rejectedBy: "trust-score:quarantine",
              trust: projectTrustForXray(qItem),
            });
          }
        }
        // `considered` must reflect the pool size of the branch that
        // actually produced the admitted results, NOT the max across
        // every branch that ran.  Otherwise a flow where hot_qmd
        // assembled a large pool that was killed by the confidence
        // gate and a different branch (or none) ultimately served
        // the recall would report hot_qmd's pool as "considered" —
        // incorrectly attributing those drops to the result limit.
        // Pick the pool by `recallSource`; fall back to
        // `recalledMemoryCount` when no branch ran (e.g. every branch
        // returned zero).  This path never runs for `no_recall` —
        // that branch captures its own snapshot earlier.
        let xrayConsidered: number;
        switch (recallSource) {
          case "hot_qmd":
            xrayConsidered = xrayBranchPoolSize.hot_qmd;
            break;
          case "hot_embedding":
            xrayConsidered = xrayBranchPoolSize.hot_embedding;
            break;
          case "cold_fallback":
            xrayConsidered = xrayColdPoolSink.size;
            break;
          case "recent_scan":
            xrayConsidered = xrayBranchPoolSize.recent_scan;
            break;
          case "none":
            xrayConsidered = recalledMemoryCount;
            break;
          default: {
            // Compile-time guard: adding a new `recallSource` value
            // must force this switch to be updated.
            const _exhaustive: never = recallSource;
            void _exhaustive;
            xrayConsidered = recalledMemoryCount;
          }
        }
        // `considered` must never be less than `admitted` — in degenerate
        // flows where a branch's pool counter missed an assignment, prefer
        // the admitted count as the floor so the trace stays self-consistent.
        xrayConsidered = Math.max(xrayConsidered, recalledMemoryIds.length);
        const filters: RecallFilterTrace[] = [
          {
            name: "recall-result-limit",
            considered: xrayConsidered,
            admitted: recalledMemoryIds.length,
          },
        ];
        if (lcmStructuredXrayResults.length > 0) {
          filters.push({
            name: "lcm-message-parts",
            considered: lcmStructuredXrayResults.length,
            admitted: lcmStructuredXrayResults.length,
          });
        }
        this.deps.lastXraySnapshot = buildXraySnapshot({
          query: retrievalQuery,
          tierExplain: null,
          results: [...results, ...lcmStructuredXrayResults],
          filters,
          budget: {
            chars: this.deps.getRecallBudgetChars(options.budgetCharsOverride),
            used: context.length,
          },
          sessionKey,
          namespace: selfNamespace,
          traceId,
          // Issue #679 completion: record peer-profile injection in the
          // xray snapshot. peerProfileXrayAnnotation is set inside
          // peerProfileRecallPromise when injection actually occurred,
          // and stays null otherwise. By the time xray capture runs,
          // phase-1 parallel work is complete so the annotation is
          // guaranteed to be populated.
          peerProfileInjection: peerProfileXrayAnnotation,
        });
      } catch (err) {
        // Capture is a best-effort side channel: a capture failure
        // must NEVER propagate into the primary recall path.
        log.debug(`x-ray capture failed: ${err}`);
      }
    }

    if (sessionKey) {
      throwIfRecallAborted(options.abortSignal);
      this.deps.trackRecallBackgroundWrite(
        this.deps.lastRecall.record({
          sessionKey,
          query: retrievalQuery,
          memoryIds: recalledMemoryIds,
          namespace: selfNamespace,
          recallNamespaces,
          traceId,
          plannerMode: recallMode,
          requestedMode,
          source: recallSource,
          fallbackUsed: recallSource !== "none" && recallSource !== "hot_qmd",
          sourcesUsed,
          budgetsApplied,
          latencyMs: Date.now() - recallStart,
          resultPaths: recalledMemoryPaths,
          resultNamespaces: recalledMemoryNamespaces,
          policyVersion,
          appendImpression:
            recalledMemoryIds.length > 0 ||
            this.deps.config.recordEmptyRecallImpressions,
          identityInjection: {
            mode: identityInjectionModeUsed,
            injectedChars: identityInjectedChars,
            truncated: identityInjectionTruncated,
          },
          // Included at record time so the published snapshot is born
          // annotated — a post-record annotation leaves a window where
          // readers see the snapshot without degradations, and a concurrent
          // same-session recall could drop them entirely (codex + cursor
          // reviews on #1544).
          backendDegradations:
            backendDegradations.length > 0 ? backendDegradations : undefined,
        }),
        "last recall record",
      );
      // Issue #1582 — record the admitted memory-id set for handle resolution.
      // Only when handles are enabled: if injection is off, no handle is ever
      // rendered, so there is nothing to resolve and we skip the write.
      if (this.deps.config.recallMemoryHandles && recalledMemoryIds.length > 0) {
        // Only handle-eligible ids aid resolution; filter out non-memory .md
        // basenames (entity reconstructions) so the resolver never records a
        // citation target that cannot be loaded.
        const handleEligibleIds = recalledMemoryIds.filter((id) =>
          MEMORY_ID_PATTERN.test(id),
        );
        if (handleEligibleIds.length > 0) {
          this.deps.trackRecallBackgroundWrite(
            this.deps.handleHistory.record(sessionKey, handleEligibleIds),
            "handle history record",
          );
        }
      }
    }
    if (sessionKey) {
      this.deps.queueEvalShadowRecall({
        traceId,
        recordedAt: new Date().toISOString(),
        sessionKey,
        promptHash,
        promptLength: prompt.length,
        retrievalQueryHash,
        retrievalQueryLength: retrievalQuery.length,
        recallMode,
        recallResultLimit,
        source: recallSource,
        recalledMemoryCount,
        injected: context.length > 0,
        contextChars: context.length,
        memoryIds: recalledMemoryIds,
        policyVersion,
        identityInjectionMode: identityInjectionModeUsed,
        identityInjectedChars,
        identityInjectionTruncated,
        durationMs: Date.now() - recallStart,
        timings: { ...timings },
      });
    }
    closeProfileTrace();
    this.deps.emitTrace({
      kind: "recall_summary",
      traceId,
      operation: "recall",
      sessionKey,
      promptHash,
      promptLength: prompt.length,
      retrievalQueryHash,
      retrievalQueryLength: retrievalQuery.length,
      recallMode,
      recallResultLimit,
      qmdEnabled: resolveQmdCapabilities(this.deps.config).qmd,
      qmdAvailable: this.deps.qmd.isAvailable(),
      recallNamespaces,
      source: recallSource,
      recalledMemoryCount,
      injected: context.length > 0,
      contextChars: context.length,
      policyVersion,
      identityInjectionMode: identityInjectionModeUsed,
      identityInjectedChars,
      identityInjectionTruncated,
      durationMs: Date.now() - recallStart,
      timings: { ...timings },
      recalledContent:
        this.deps.config.traceRecallContent && context.length > 0
          ? context
          : undefined,
    });

    return context;
    } finally {
      closeProfileTrace();
    }
  }
}
