/**
 * recall-internal-deps.ts — the `RecallInternalDeps` contract (issue #1526
 * seam 18), extracted from recall-internal.ts so that file can stay under
 * its frozen ratchet ceiling while recall work proceeds (#2183). Pure type
 * relocation: no behavior change, no renames, no member reordering.
 */

import type { BoxBuilder } from "../boxes.js";
import type { CapabilitySet, GraphConstructionCapabilitySet } from "../capabilities.js";
import type { CausalTrajectorySearchResult } from "../causal-trajectory.js";
import type { CompoundingEngine } from "../compounding/engine.js";
import type { EvalShadowRecallRecord } from "../evals.js";
import type { HarmonicRetrievalResult } from "../harmonic-retrieval.js";
import type { StorageManager } from "../index.js";
import type { LcmEngine } from "../lcm/index.js";
import type { RecallResultFormatter } from "./recall-result-formatter.js";
import type { NamespaceCatalog } from "../namespaces/catalog.js";
import type { NamespaceStorageRouter } from "../namespaces/storage.js";
import type { ObjectiveStateSearchResult } from "../objective-state.js";
import type { IntentDebugSnapshot, QmdRecallSnapshot, QueryAwarePrefilter } from "../orchestrator.js";
import type { CorpusReadOptions } from "../corpus-read-cancellation.js";
import type { ProfilingCollector } from "../profiling.js";
import type { GraphRecallExpandedEntry, IncludedMemory, LastRecallBudgetSummary, LastRecallStore, RecallHandleHistoryStore } from "../recall-state.js";
import type { RecallXraySnapshot } from "../recall-xray.js";
import type { RerankCache } from "../rerank.js";
import type { SearchBackend, SearchDegradation, SearchQueryOptions } from "../search/port.js";
import type { VerifiedSemanticRuleResult } from "../semantic-rule-verifier.js";
import type { SharedContextManager } from "../shared-context/manager.js";
import type { HourlySummarizer } from "../summarizer.js";
import type { isValidAsOf } from "../temporal-validity.js";
import type { TmtBuilder } from "../tmt.js";
import type { TranscriptManager } from "../transcript.js";
import type { TrustStageResultItem } from "../trust-score-stage.js";
import type { TrustZoneSearchResult } from "../trust-zones.js";
import type { CodingContext, EngramTraceEvent, IdentityInjectionMode, MemoryFile, MemoryIntent, PluginConfig, QmdSearchResult, RecallPlanMode, RecallSectionConfig } from "../types.js";
import type { VerifiedEpisodeResult } from "../verified-recall.js";
import type { WorkProductLedgerSearchResult } from "../work-product-ledger.js";
import type { GraphRecallRankedResult, GraphRecallShadowComparison } from "./graph-recall-coordinator.js";
import type {
  GraphRecallExpansionOptions,
  GraphRecallExpansionResult,
} from "./graph-recall-seam.js";
import type { RecallRerankCoordinator, RecallResultPartitionSink } from "./recall-rerank-coordinator.js";
import type { ArtifactRecallOptions } from "./recall-search-prefilter.js";
import type { RecallSectionAppendOptions, RecallSectionBuckets } from "./recall-section-coordinator.js";

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
    requestingConnector?: string;
    /**
     * Optional out-parameter that receives the pre-MMR / pre-truncation
     * pool size captured inside the pipeline (issue #570 PR 1).  The
     * X-ray capture block in `recallInternal` passes a small sink so
     * the cold-fallback branch's pre-truncation pool size can be
     * attributed back to the branch when `recallSource === "cold_fallback"`.
     * Unset by default so existing call sites are unaffected.
     */
    xrayPoolSizeSink?: { size: number };
    resultPartitionSink?: RecallResultPartitionSink;
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
    includedMemories: IncludedMemory[];
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
      requestingConnector?: string;
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
  readonly recallRerankCoordinator: Pick<RecallRerankCoordinator, "diversifyRecallResultsWithHeadroom">;
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
  expandResultsViaGraph(
    options: GraphRecallExpansionOptions,
  ): Promise<GraphRecallExpansionResult>;
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
      /** Cross-lingual plan flag (#2197): supplement the lexical page with vector-tier hits. */
      crossScript?: boolean;
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
      requestingConnector?: string;
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
  readonly recallResultFormatter: RecallResultFormatter;
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
    options?: CorpusReadOptions,
  ): Promise<MemoryFile[]>;
  recallArtifactsAcrossNamespaces(
    prompt: string,
    recallNamespaces: string[],
    targetCount: number,
    options?: ArtifactRecallOptions,
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
