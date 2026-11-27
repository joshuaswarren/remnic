
import { createHash } from "node:crypto";
import path from "node:path";
import { abortError } from "../abort-error.js";
import { type CapabilitySet, type GraphConstructionCapabilitySet, resolveCapabilities, resolveConversationContextCapabilities, resolveGraphConstructionCapabilities, resolveIndexingCapabilities, resolveMemoryLifecycleCapabilities, resolveNamespaceCapabilities, resolvePipelineProcessingCapabilities, resolveQmdCapabilities, resolveRecallEnhancementCapabilities } from "../capabilities.js";
import { EmbeddingFallback } from "../embedding-fallback.js";
import { StorageManager } from "../index.js";
import { applyDirectorySidecarDrillDown, isDirectorySidecarsEnabledForDir } from "../directory-sidecars.js";
import { inferIntentFromText, intentCompatibilityScore } from "../intent.js";
import { log } from "../logger.js";
import { NamespaceStorageRouter } from "../namespaces/storage.js";
import { NegativeExampleStore } from "../negative.js";
import { normalizeFlatQmdResults, qmdCollectionPathParts } from "./qmd-result-resolver.js";
import type { RecallRerankCoordinator, RecallResultPartitionSink } from "./recall-rerank-coordinator.js";
import type { GraphRecallExpansionOptions, GraphRecallExpansionResult } from "./graph-recall-coordinator.js";
import { RelevanceStore } from "../relevance.js";
import { RerankCache, rerankLocalOrNoop, reorderByRankedKeys } from "../rerank.js";
import type { SearchBackend, SearchDegradation, SearchExecutionOptions, SearchQueryOptions } from "../search/port.js";
import { SecureStoreLockedError } from "../secure-store/index.js";
import { isPathInsideStorageRoot } from "../storage-paths.js";
import { applyRecencyBoost, collectMtimeFallbackContext } from "../memory-age.js";
import type { CorpusReadOptions } from "../corpus-read-cancellation.js";
import { extractTagsFromPrompt, isTemporalQuery, queryByDateRangeAsync, queryByTagsAsync, readIndexSnapshotAsync, recencyWindowFromPrompt } from "../temporal-index.js";
import {
  buildQueryAwarePrefilter as buildQueryAwarePrefilterHelper,
  fetchActiveArtifactsForNamespace as fetchActiveArtifactsForNamespaceHelper,
  searchEmbeddingFallback as searchEmbeddingFallbackHelper,
  searchQueryAwareFallback as searchQueryAwareFallbackHelper,
  type ArtifactRecallOptions,
} from "./recall-search-prefilter.js";
import { shouldFilterSupersededFromRecall } from "../temporal-supersession.js";
import { isValidAsOf, isValidityExpiredNow } from "../temporal-validity.js";
import { StateViewAnchorTracker, stateViewPacketActive } from "../recall-state-view-anchors.js";
import type { TrustStageResultItem } from "../trust-score-stage.js";
import type { MemoryFile, PluginConfig, QmdSearchResult, RecallPlanMode } from "../types.js";
import {
  dedupeResultsByNamespace,
  hasMemoryForResult,
  markResultKey,
  memoryForResult,
  memoryMapKey,
  resultHasKey,
} from "../recall-memory-map.js";
import { applyOutcomePriorScores, outcomePriorBoostActive } from "../rerank-outcome.js";
import { type UtilityRuntimeValues, applyUtilityRankingRuntimeDelta } from "../utility-runtime.js";
import {
  lifecycleRecallScoreAdjustment,
  shouldFilterLifecycleRecallCandidate,
  computeQmdHybridFetchLimit,
  filterRecallCandidates,
  throwIfRecallAborted,
  type QmdRecallSnapshot,
  type QueryAwarePrefilter,
} from "../orchestrator.js";
import { isActivityDigestPath } from "./orchestrator-helpers.js";
import { runInQmdSearchCacheRecallScope } from "../memory-cache.js";
import { isGenericRecallExcludedPath, isTopLevelArchivePath } from "./generic-recall-paths.js";
import { isSupportPassportPrivateMemory } from "../support-passport/card-projection.js";

export interface RecallSearchPipelineDeps {
  applyMemoryWorthRerank(
    results: QmdSearchResult[],
    namespaces: string[],
    preloadedFrontmatter?: ReadonlyMap<string, MemoryFile>,
  ): Promise<QmdSearchResult[]>;
  applyTrustScoreRerank(
    results: QmdSearchResult[],
    namespaces: string[],
    preloadedFrontmatter?: ReadonlyMap<string, MemoryFile>,
  ): Promise<{
    results: QmdSearchResult[];
    trustByPath: Map<string, TrustStageResultItem> | null;
  }>;
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
      /** #1952 state-view admission — see filterSearchResultsByRecallSafety. */
      stateViewActive?: boolean;
      requestingConnector?: string;
    },
  ): Promise<QmdSearchResult[]>;
  buildConfiguredQmdSearchOptions(queryText: string, requestOverride?: SearchQueryOptions): SearchQueryOptions | undefined;
  buildQueryAwarePrefilter(
    prompt: string,
    recallNamespaces: string[],
  ): Promise<QueryAwarePrefilter>;
  readonly config: PluginConfig;
  readonly recallRerankCoordinator: Pick<
    RecallRerankCoordinator,
    "diversifyRecallResultsWithHeadroom" | "applyPreferenceDriftStage"
  >;
  diversifyAndLimitRecallResults(
    sectionId: string,
    results: QmdSearchResult[],
    limit: number,
    retrievalQuery?: string,
    caps?: CapabilitySet,
  ): QmdSearchResult[];
  effectiveRecencyWeight(): number;
  readonly embeddingFallback: EmbeddingFallback;
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
      onDegradation?: (degradation: SearchDegradation) => void;
      abortSignal?: AbortSignal;
    },
  ): Promise<QmdSearchResult[]>;
  filterSearchResultsByRecallSafety(
    results: QmdSearchResult[],
    memoryByPath: Map<string, MemoryFile>,
    options?: {
      allowLifecycleFiltered?: boolean;
      allowDedicatedSurface?: boolean;
      asOfMs?: number;
      blockedPaths?: Set<string>;
      requestingConnector?: string;
    },
  ): QmdSearchResult[];
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
      /** #1952 state-view admission — see filterSearchResultsByRecallSafety. */
      stateViewActive?: boolean;
    },
  ): Promise<{ results: QmdSearchResult[]; memoryByPath: Map<string, MemoryFile> }>;
  loadSearchResultMemoryMap(
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
  }>;
  namespaceFromPath(p: string): string;
  readonly negatives: NegativeExampleStore;
  readonly qmd: SearchBackend;
  readQmdResultMemory(
    resultPath: string,
    fallbackStorage: StorageManager,
    recallNamespaces?: readonly string[],
    preferredNamespace?: string,
  ): Promise<MemoryFile | null>;
  readonly relevance: RelevanceStore;
  readonly rerankCache: RerankCache;
  resolveArtifactSourceStatuses(
    storage: StorageManager,
    sourceIds: string[],
    options?: CorpusReadOptions,
  ): Promise<Map<string, "active" | "superseded" | "archived" | "missing">>;
  resolveColdQmdResultForRecall(
    result: QmdSearchResult,
    fallbackStorage: StorageManager,
    recallNamespaces?: readonly string[],
  ): Promise<{ namespace: string; result: QmdSearchResult } | null>;
  scopeQueryAwarePaths(
    paths: Set<string> | null,
    recallNamespaces: string[],
  ): Set<string> | null;
  searchAcrossNamespaces(options: {
    query: string;
    namespaces?: string[];
    maxResults?: number;
    mode?: "search" | "hybrid" | "bm25" | "vector";
    searchOptions?: SearchQueryOptions;
    execution?: SearchExecutionOptions;
  }): Promise<QmdSearchResult[]>;
  searchQueryAwareFallback(
    prompt: string,
    limit: number,
    queryAwarePrefilter?: QueryAwarePrefilter,
    abortSignal?: AbortSignal,
  ): Promise<QmdSearchResult[]>;
  searchScopedMemoryCandidates(
    candidatePaths: Set<string>,
    query: string,
    limit: number,
    options?: {
      allowArchived?: boolean;
    },
  ): Promise<QmdSearchResult[]>;
  readonly storage: StorageManager;
  readonly storageRouter: NamespaceStorageRouter;
  readonly utilityRuntimeValues: UtilityRuntimeValues | null;
}

export class RecallSearchPipelineCoordinator {
  constructor(
    private readonly deps: RecallSearchPipelineDeps,
  ) {}

  async fetchActiveArtifactsForNamespace(
    namespace: string,
    prompt: string,
    targetCount: number,
    options: ArtifactRecallOptions = {},
  ): Promise<MemoryFile[]> {
    return fetchActiveArtifactsForNamespaceHelper(
      this.deps,
      namespace,
      prompt,
      targetCount,
      options,
    );
  }

  async buildQueryAwarePrefilter(
    prompt: string,
    recallNamespaces: string[],
  ): Promise<QueryAwarePrefilter> {
    return buildQueryAwarePrefilterHelper(this.deps, prompt, recallNamespaces);
  }

  async fetchQmdMemoryResultsWithArtifactTopUp(
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
  ): Promise<QmdSearchResult[]> {
    throwIfRecallAborted(options.abortSignal);
    const queryAwarePrefilter =
      options.queryAwarePrefilter ??
      (await this.deps.buildQueryAwarePrefilter(prompt, options.recallNamespaces));
    const scopedSeedResults = queryAwarePrefilter.candidatePaths?.size
      ? await this.deps.searchScopedMemoryCandidates(
          queryAwarePrefilter.candidatePaths,
          prompt,
          queryAwarePrefilter.candidatePaths.size,
          { allowArchived: options.collection !== undefined },
        )
      : [];
    const recallable = (r: QmdSearchResult) => !isGenericRecallExcludedPath(r.path, this.deps.config, "qmd");

    let fetchLimit = Math.max(qmdFetchLimit, qmdHybridFetchLimit);
    const maxFetchLimit = Math.min(
      320,
      Math.max(fetchLimit, qmdFetchLimit * 5),
    );
    const qmdRecallBudgetMs = this.deps.config.recallEnrichmentDeadlineMs ?? 60_000;
    const qmdRecallBudgetEnabled = qmdRecallBudgetMs > 0;
    const startedAtMs = Date.now();
    return runInQmdSearchCacheRecallScope(qmdRecallBudgetMs, async () => {
    let lastPrimaryResultCount = 0;
    let lastHybridResultCount = 0;
    let lastHybridTopUpUsed = false;
    let lastHybridTopUpSkippedReason: string | undefined;
    const backendHonorsQmdSearchSignals =
      (this.deps.config.searchBackend ?? "qmd") === "qmd";
    const resolvedSearchOptions = (() => {
      const resolver = (
        this.deps.qmd as {
          resolveSupportedSearchOptions?: (
            options?: SearchQueryOptions,
          ) => SearchQueryOptions | undefined;
        }
      ).resolveSupportedSearchOptions;
      if (typeof resolver === "function") {
        return resolver.call(this.deps.qmd, options.searchOptions);
      }
      return options.searchOptions;
    })();
    const primarySearchOptions = backendHonorsQmdSearchSignals
      ? resolvedSearchOptions
      : options.searchOptions;
    const debugSearchOptions = backendHonorsQmdSearchSignals
      ? resolvedSearchOptions
      : undefined;
    const crossScriptVectorHits = options.crossScript
      ? await this.searchEmbeddingFallback(prompt, fetchLimit)
      : [];
    let bestFiltered = filterRecallCandidates(scopedSeedResults, {
      namespacesEnabled: options.namespacesEnabled,
      recallNamespaces: options.recallNamespaces,
      resolveNamespace: options.resolveNamespace,
      limit: qmdFetchLimit,
      pathPolicy: this.deps.config,
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

    for (;;) {
      throwIfRecallAborted(options.abortSignal);
      if (
        qmdRecallBudgetEnabled &&
        Date.now() - startedAtMs >= qmdRecallBudgetMs
      ) {
        break;
      }

      let primaryResults = options.collection
        ? options.abortSignal
          ? await this.deps.qmd.search(
              prompt,
              options.collection,
              fetchLimit,
              primarySearchOptions,
              {
                signal: options.abortSignal,
                onDegradation: options.onDegradation,
              },
            )
          : await this.deps.qmd.search(
              prompt,
              options.collection,
              fetchLimit,
              primarySearchOptions,
              { onDegradation: options.onDegradation },
            )
        : await this.deps.searchAcrossNamespaces({
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
      primaryResults = normalizeFlatQmdResults(primaryResults, this.deps.config, options.collection);
      lastPrimaryResultCount = primaryResults.length;
      lastHybridResultCount = 0;
      lastHybridTopUpUsed = false;
      lastHybridTopUpSkippedReason = undefined;
      let mergedResults = primaryResults;
      const primaryDeliverableCount = filterRecallCandidates(primaryResults, {
        namespacesEnabled: options.namespacesEnabled,
        recallNamespaces: options.recallNamespaces,
        resolveNamespace: options.resolveNamespace,
        limit: qmdFetchLimit,
        pathPolicy: this.deps.config,
      }).length;
      const primaryIncludesArchivePath = primaryResults.some((result) =>
        isTopLevelArchivePath(result.path, this.deps.config, "qmd"),
      );
      if (primaryDeliverableCount >= qmdFetchLimit) {
        lastHybridTopUpSkippedReason = "primary_deliverable_sufficient";
      } else if (
        (primaryResults.length < qmdFetchLimit || primaryIncludesArchivePath) &&
        (!qmdRecallBudgetEnabled ||
          Date.now() - startedAtMs < qmdRecallBudgetMs)
      ) {
        if (debugSearchOptions?.intent) {
          lastHybridTopUpSkippedReason = "intent_hint_active";
        } else if (this.deps.config.qmdSearchStrategy === "lex") {
          lastHybridTopUpSkippedReason = "lex_strategy";
        } else {
          let hybridResults = options.collection
            ? await this.deps.qmd.hybridSearch(
                prompt,
                options.collection,
                fetchLimit,
                {
                  signal: options.abortSignal,
                  onDegradation: options.onDegradation,
                },
              )
            : await this.deps.searchAcrossNamespaces({
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
          hybridResults = normalizeFlatQmdResults(hybridResults, this.deps.config, options.collection);
          lastHybridResultCount = hybridResults.length;
          lastHybridTopUpUsed = hybridResults.length > 0;
          if (hybridResults.length > 0) {
            mergedResults = dedupeResultsByNamespace(
              [...primaryResults, ...hybridResults],
              this.deps.namespaceFromPath,
              fetchLimit,
              { transportFallback: "hybrid", filter: recallable },
            );
          }
        }
      }

      if (crossScriptVectorHits.length > 0) {
        mergedResults = dedupeResultsByNamespace(
          [...mergedResults, ...crossScriptVectorHits],
          this.deps.namespaceFromPath,
          fetchLimit,
          { filter: recallable },
        );
      }
      if (scopedSeedResults.length > 0) {
        mergedResults = dedupeResultsByNamespace(
          [...scopedSeedResults, ...mergedResults],
          this.deps.namespaceFromPath,
          fetchLimit,
          { filter: recallable },
        );
      }

      const filteredResults = filterRecallCandidates(mergedResults, {
        namespacesEnabled: options.namespacesEnabled,
        recallNamespaces: options.recallNamespaces,
        resolveNamespace: options.resolveNamespace,
        limit: fetchLimit,
        pathPolicy: this.deps.config,
      });

      if (filteredResults.length >= qmdFetchLimit) {
        const capped = filteredResults.slice(0, qmdFetchLimit);
        await emitDebugSnapshot(capped, fetchLimit);
        return await applyDirectorySidecarDrillDown(this.deps.storage?.dir ?? "", prompt, capped, { enabled: Boolean(this.deps.storage?.dir) && isDirectorySidecarsEnabledForDir(this.deps.storage.dir), namespaces: options.namespacesEnabled ? options.recallNamespaces ?? [] : undefined });
      }
      if (filteredResults.length > bestFiltered.length) {
        bestFiltered = filteredResults;
      }
      if (primaryResults.length < fetchLimit) {
        await emitDebugSnapshot(filteredResults, fetchLimit);
        return await applyDirectorySidecarDrillDown(this.deps.storage?.dir ?? "", prompt, filteredResults, { enabled: Boolean(this.deps.storage?.dir) && isDirectorySidecarsEnabledForDir(this.deps.storage.dir), namespaces: options.namespacesEnabled ? options.recallNamespaces ?? [] : undefined });
      }
      if (fetchLimit >= maxFetchLimit) {
        break;
      }

      const growth = Math.max(20, Math.floor(fetchLimit / 2));
      fetchLimit = Math.min(maxFetchLimit, fetchLimit + growth);
    }

    const capped = bestFiltered.slice(0, qmdFetchLimit);
    await emitDebugSnapshot(capped, fetchLimit);
    return await applyDirectorySidecarDrillDown(this.deps.storage?.dir ?? "", prompt, capped, { enabled: Boolean(this.deps.storage?.dir) && isDirectorySidecarsEnabledForDir(this.deps.storage.dir), namespaces: options.namespacesEnabled ? options.recallNamespaces ?? [] : undefined });
    });
  }

  async searchEmbeddingFallback(
    query: string,
    limit: number,
  ): Promise<QmdSearchResult[]> {
    return searchEmbeddingFallbackHelper(this.deps, query, limit);
  }

  async searchQueryAwareFallback(
    prompt: string,
    limit: number,
    queryAwarePrefilter?: QueryAwarePrefilter,
    abortSignal?: AbortSignal,
  ): Promise<QmdSearchResult[]> {
    return searchQueryAwareFallbackHelper(this.deps, prompt, limit, queryAwarePrefilter, abortSignal);
  }

  async applyColdFallbackPipeline(options: {
    prompt: string;
    recallNamespaces: string[];
    recallResultLimit: number;
    recallMode: RecallPlanMode;
    caps?: CapabilitySet;
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
    /** #1577 trust map out-param (xrayPoolSizeSink pattern). */
    trustByPathSink?: { trustByPath: Map<string, TrustStageResultItem> | null };
    deadlineAtMs?: number | null;
    includeLowConfidence?: boolean;
    stateViewActive?: boolean;
    searchOptions?: SearchQueryOptions;
  }): Promise<QmdSearchResult[]> {
    const caps = options.caps ?? resolveCapabilities(this.deps.config);
    const graphCaps = options.graphCaps ?? resolveGraphConstructionCapabilities(this.deps.config);
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
      task: (stepSignal: AbortSignal) => Promise<T>,
      onDeadline?: () => void,
    ): Promise<T> => {
      throwIfRecallAborted(options.abortSignal);
      const remainingMs = deadlineRemainingMs();
      const stepController = new AbortController();
      const stepSignal = options.abortSignal
        ? AbortSignal.any([options.abortSignal, stepController.signal])
        : stepController.signal;
      const abandonToDeadline = () => {
        stepController.abort(abortError(`cold-tier recall ${label} deadline exceeded`));
        try {
          onDeadline?.();
        } catch {
          // Observers must never break recall.
        }
        log.debug(`cold-tier recall ${label} skipped: shared assembly deadline expired`);
      };
      if (remainingMs === 0) {
        abandonToDeadline();
        return fallback;
      }
      if (remainingMs === null) return task(stepSignal);
      let timeoutHandle: NodeJS.Timeout | undefined;
      let timedOut = false;
      const taskPromise = task(stepSignal).catch((err) => {
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
              abandonToDeadline();
              resolve(fallback);
            }, remainingMs);
          }),
        ]);
      } finally {
        clearTimeout(timeoutHandle);
      }
    };

    const coldQmdEnabled = resolveQmdCapabilities(this.deps.config).qmdColdTier === true;
    const coldCollection =
      this.deps.config.qmdColdCollection ?? "openclaw-engram-cold";
    const coldMaxResults =
      this.deps.config.qmdColdMaxResults ?? this.deps.config.qmdMaxResults;

    let longTerm: QmdSearchResult[] = [];
    if (coldQmdEnabled && this.deps.qmd.isAvailable()) {
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
          (stepSignal) =>
            this.deps.fetchQmdMemoryResultsWithArtifactTopUp(
              options.prompt,
              coldFetchLimit,
              coldHybridLimit,
              {
                namespacesEnabled: resolveNamespaceCapabilities(this.deps.config).namespaces,
                recallNamespaces: options.recallNamespaces,
                resolveNamespace: (p) => this.deps.namespaceFromPath(p),
                collection: coldCollection,
                queryAwarePrefilter: options.queryAwarePrefilter,
                searchOptions: this.deps.buildConfiguredQmdSearchOptions(options.prompt, options.searchOptions),
                abortSignal: stepSignal,
                onDegradation: (degradation) => {
                  if (coldQmdObserverActive) {
                    options.onDegradation?.(degradation);
                  }
                },
              },
            ),
          reportColdQmdDeadline,
        );
        coldQmdObserverActive = false;
        if (longTerm.length > 0) {
          log.debug(`cold-tier recall source=cold-qmd collection=${coldCollection} hits=${longTerm.length}`);
        }
      }
    }
    if (longTerm.length === 0) {
      longTerm = await runColdStepWithinDeadline(
        "query-aware fallback",
        [],
        (stepSignal) =>
          this.deps.searchQueryAwareFallback(
            options.prompt,
            options.recallResultLimit,
            options.queryAwarePrefilter,
            stepSignal,
          ),
      );
      if (longTerm.length > 0) {
        log.debug("cold-tier recall source=query-aware-fallback");
      }
    }
    if (longTerm.length === 0) return [];

    let results = longTerm;
    if (resolveNamespaceCapabilities(this.deps.config).namespaces) {
      const recallRoots: string[] = [];
      const seenRecallRoots = new Set<string>();
      for (const namespace of options.recallNamespaces) {
        try {
          const storage = await this.deps.storageRouter.storageFor(namespace);
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
          const resolvedCold = await this.deps.resolveColdQmdResultForRecall(
            result,
            this.deps.storage,
            options.recallNamespaces,
          );
          if (resolvedCold) scopedResults.push(resolvedCold.result);
          continue;
        }
        if (path.isAbsolute(result.path)) {
          if (recallRoots.some((recallRoot) => isPathInsideStorageRoot(recallRoot, path.resolve(result.path)))) {
            scopedResults.push(result);
          }
          continue;
        }
        if (options.recallNamespaces.includes(result.namespace ?? this.deps.namespaceFromPath(result.path))) scopedResults.push(result);
      }
      results = scopedResults;
    }
    results = results.filter((r) => !isGenericRecallExcludedPath(r.path, this.deps.config, "qmd"));
    if (results.length === 0) return [];

    const isFullModeGraphAssist =
      resolveQmdCapabilities(this.deps.config).qmdTierParityGraph &&
      graphCaps.multiGraphMemory &&
      caps.graphAssistInFullMode &&
      options.recallMode === "full" &&
      results.length >= Math.max(1, this.deps.config.graphAssistMinSeedResults ?? 3);
    const shouldRunGraphExpansion =
      resolveQmdCapabilities(this.deps.config).qmdTierParityGraph &&
      (options.recallMode === "graph_mode" || isFullModeGraphAssist);

    if (shouldRunGraphExpansion) {
      const { merged } = await this.deps.expandResultsViaGraph({
        memoryResults: results,
        recallNamespaces: options.recallNamespaces,
        recallResultLimit: options.recallResultLimit,
        deadlineAtMs: options.deadlineAtMs,
        ...(options.includeLowConfidence === true ? { includeLowConfidence: true } : {}),
        ...(typeof options.asOfMs === "number" ? { asOfMs: options.asOfMs } : {}),
      });
      results = merged;
    }
    results = results.filter(
      (result) => !isGenericRecallExcludedPath(result.path, this.deps.config, "qmd"),
    );

    const boostInput = await this.deps.filterSearchResultsForRecall(
      results,
      undefined,
      {
        allowLifecycleFiltered: true,
        asOfMs: options.asOfMs,
        deadlineAtMs: options.deadlineAtMs,
        abortSignal: options.abortSignal,
        dropUnresolved: true,
        recallNamespaces: options.recallNamespaces,
        requestingConnector: options.requestingConnector,
        stateViewActive: options.stateViewActive,
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
              this.deps.boostSearchResults(
                boostInput.results,
                options.recallNamespaces,
                options.prompt,
                boostInput.memoryByPath,
                {
                  allowLifecycleFiltered: true,
                  asOfMs: options.asOfMs,
                  stateViewActive: options.stateViewActive,
                  requestingConnector: options.requestingConnector,
                },
              ),
              new Promise<{ status: "timed_out" }>((resolve) => {
                timeoutHandle = setTimeout(
                  () => resolve({ status: "timed_out" }),
                  boostTimeoutMs,
                );
              }),
            ])
          : this.deps.boostSearchResults(
              boostInput.results,
              options.recallNamespaces,
              options.prompt,
              boostInput.memoryByPath,
              {
                allowLifecycleFiltered: true,
                asOfMs: options.asOfMs,
                stateViewActive: options.stateViewActive,
                requestingConnector: options.requestingConnector,
              },
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

    if (caps.rerank && this.deps.config.rerankProvider === "local") {
      const rerankId = (r: QmdSearchResult): string => `${r.namespace ?? ""}|${r.path}`;
      const ranked = await rerankLocalOrNoop({
        query: options.prompt,
        candidates: results
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
        results = reorderByRankedKeys(results, ranked, rerankId);
      }
    }
    if (caps.rerank && this.deps.config.rerankProvider === "cloud") {
      log.debug("rerankProvider=cloud is reserved/experimental in v2.2.0; skipping rerank");
    }

    if (caps.recallTrustScore && results.length > 0) {
      try {
        const trustOutcome = await this.deps.applyTrustScoreRerank(results, options.recallNamespaces, boostInput.memoryByPath);
        results = trustOutcome.results;
        if (options.trustByPathSink) options.trustByPathSink.trustByPath = trustOutcome.trustByPath;
      } catch (err) {
        log.debug("trust-score stage (cold) failed open", {
          error: (err as Error).message,
        });
      }
    } else if (caps.recallMemoryWorthFilter && results.length > 0) {
      try {
        results = await this.deps.applyMemoryWorthRerank(results, options.recallNamespaces, boostInput.memoryByPath);
      } catch (err) {
        log.debug("memory-worth filter (cold) failed open", {
          error: (err as Error).message,
        });
      }
    }
    if (results.length > 0) {
      results = await this.deps.recallRerankCoordinator.applyPreferenceDriftStage(
        results,
        options.recallNamespaces,
        boostInput.memoryByPath,
      );
    }

    if (options.xrayPoolSizeSink) {
      options.xrayPoolSizeSink.size = Math.max(
        options.xrayPoolSizeSink.size,
        results.length,
      );
    }
    if (options.resultPartitionSink) {
      const partition = this.deps.recallRerankCoordinator.diversifyRecallResultsWithHeadroom(
        "memories",
        results,
        options.recallResultLimit,
        options.prompt,
        caps,
        stateViewPacketActive(options.stateViewActive, options.asOfMs),
      );
      options.resultPartitionSink.partition = partition;
      return partition.appliedResults;
    }
    return this.deps.recallRerankCoordinator
      .diversifyRecallResultsWithHeadroom(
        "memories",
        results,
        options.recallResultLimit,
        options.prompt,
        caps,
        stateViewPacketActive(options.stateViewActive, options.asOfMs),
      )
      .appliedResults;
  }

  async loadSearchResultMemoryMap(
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
      if (result.path) markResultKey(checkedPaths, result);
    };
    const markUnreadable = (result: QmdSearchResult, err: unknown): void => {
      if (!result.path) return;
      markChecked(result);
      markResultKey(unreadablePaths, result);
      log.warn("recall safety filter dropped unreadable secure-store candidate", {
        path: result.path,
        namespace: result.namespace,
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
          if (hasMemoryForResult(memoryByPath, r)) {
            markChecked(r);
            return;
          }
          try {
            const mem = await this.deps.readQmdResultMemory(
              r.path,
              this.deps.storage,
              options?.recallNamespaces,
              r.namespace,
            );
            markChecked(r);
            if (mem) memoryByPath.set(memoryMapKey(r), mem);
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
      if (hasMemoryForResult(memoryByPath, result)) {
        markChecked(result);
        continue;
      }
      if (options?.abortSignal?.aborted || deadlineExpired()) {
        return { memoryByPath, checkedPaths, unreadablePaths, completed: false };
      }
      try {
        const mem = await this.deps.readQmdResultMemory(
          result.path,
          this.deps.storage,
          options?.recallNamespaces,
          result.namespace,
        );
        markChecked(result);
        if (mem) memoryByPath.set(memoryMapKey(result), mem);
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

  filterSearchResultsByRecallSafety(
    results: QmdSearchResult[],
    memoryByPath: Map<string, MemoryFile>,
    options?: {
      allowLifecycleFiltered?: boolean;
      allowDedicatedSurface?: boolean;
      asOfMs?: number;
      blockedPaths?: Set<string>;
      requestingConnector?: string;
      stateViewActive?: boolean;
    },
  ): QmdSearchResult[] {
    const stateViewActive = options?.stateViewActive === true;
    const stateViewAnchors = stateViewActive ? new StateViewAnchorTracker() : null;
    const stateViewDeferred: number[] = [];
    const stateViewBuilt: (QmdSearchResult | null)[] | null = stateViewActive
      ? new Array<QmdSearchResult | null>(results.length).fill(null)
      : null;
    const buildRecallRow = (r: QmdSearchResult, memory: MemoryFile | undefined): QmdSearchResult => ({
      ...r,
      snippet: memory && !resolveNamespaceCapabilities(this.deps.config).namespaces ? memory.content : r.snippet,
      line: memory && !resolveNamespaceCapabilities(this.deps.config).namespaces ? undefined : r.line,
      sourceConnector: memory ? memory.frontmatter.sourceConnector : undefined,
      origin: memory ? memory.frontmatter.origin : undefined,
      ...(stateViewActive && memory
        ? {
            id: memory.frontmatter.id,
            status: memory.frontmatter.status,
            supersedes: memory.frontmatter.supersedes,
            supersededBy: memory.frontmatter.supersededBy,
            supersededAt: memory.frontmatter.supersededAt,
            validAt: memory.frontmatter.valid_at,
            invalidAt: memory.frontmatter.invalid_at,
          }
        : {}),
    });
    let stateViewAdmittedCount = 0;
    const lifecycleCaps = resolveMemoryLifecycleCapabilities(this.deps.config);
    let lifecycleFilteredCount = 0;
    let temporalSupersededFilteredCount = 0;
    let biTemporalExpiredFilteredCount = 0;
    let dedicatedSurfaceFilteredCount = 0;
    let forgottenFilteredCount = 0;
    let blockedPathFilteredCount = 0;
    let connectorPartitionFilteredCount = 0;
    let supportPassportFilteredCount = 0;
    const filtered: QmdSearchResult[] = [];
    for (let resultIdx = 0; resultIdx < results.length; resultIdx += 1) {
      const r = results[resultIdx]!;
      let stateViewPending = false;
      if (options?.blockedPaths && resultHasKey(options.blockedPaths, r)) {
        blockedPathFilteredCount += 1;
        continue;
      }
      const memory = memoryForResult(memoryByPath, r);
      if (memory) {
        const memoryConnector = memory.frontmatter.sourceConnector?.trim();
        const requestingConnector = options?.requestingConnector?.trim();
        if (
          lifecycleCaps.extractionScopeClassification &&
          memory.frontmatter.toolScoped === true &&
          memoryConnector &&
          requestingConnector &&
          memoryConnector !== requestingConnector
        ) {
          connectorPartitionFilteredCount += 1;
          continue;
        }
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

        if (isSupportPassportPrivateMemory(memory)) {
          supportPassportFilteredCount += 1;
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

        const asOfActive =
          typeof options?.asOfMs === "number" && Number.isFinite(options.asOfMs);
        if (asOfActive) {
          if (!isValidAsOf(memory.frontmatter, options!.asOfMs!)) {
            temporalSupersededFilteredCount += 1;
            continue;
          }
        } else if (
          shouldFilterSupersededFromRecall(memory.frontmatter, {
            enabled: lifecycleCaps.temporalSupersession,
            includeInRecall: this.deps.config.temporalSupersessionIncludeInRecall,
          })
        ) {
          if (stateViewActive) {
            stateViewPending = true;
          } else {
            temporalSupersededFilteredCount += 1;
            continue;
          }
        }
        if (
          !asOfActive &&
          this.deps.config.temporalBiTemporal &&
          !this.deps.config.temporalExpiredInInjection &&
          isValidityExpiredNow(memory.frontmatter, Date.now())
        ) {
          biTemporalExpiredFilteredCount += 1;
          continue;
        }

        if (
          options?.allowDedicatedSurface !== true &&
          (memory.frontmatter.memoryKind === "dream" ||
            memory.frontmatter.memoryKind === "procedural" ||
            isActivityDigestPath(memory.path, this.deps.config.memoryDir))
        ) {
          dedicatedSurfaceFilteredCount += 1;
          continue;
        }
      }
      if (stateViewPending) {
        stateViewDeferred.push(resultIdx);
        continue;
      }
      const builtRow = buildRecallRow(r, memory);
      if (stateViewBuilt !== null) {
        stateViewBuilt[resultIdx] = builtRow;
        if (memory && stateViewAnchors) stateViewAnchors.admit(r.namespace, memory.frontmatter);
      }
      filtered.push(builtRow);
    }
    if (stateViewDeferred.length > 0) {
      const admitted = new Set<number>();
      for (let progress = true; progress; ) {
        progress = false;
        for (const deferredIdx of stateViewDeferred) {
          if (admitted.has(deferredIdx)) continue;
          const deferredRow = results[deferredIdx]!;
          const deferredMemory = memoryForResult(memoryByPath, deferredRow);
          if (!deferredMemory) continue;
          if (stateViewAnchors!.anchored(deferredRow.namespace, deferredMemory.frontmatter)) {
            admitted.add(deferredIdx);
            stateViewAnchors!.admit(deferredRow.namespace, deferredMemory.frontmatter);
            progress = true;
          }
        }
      }
      for (const deferredIdx of stateViewDeferred) {
        const deferredMemory = memoryForResult(memoryByPath, results[deferredIdx]!);
        if (admitted.has(deferredIdx) && deferredMemory) {
          stateViewAdmittedCount += 1;
          stateViewBuilt![deferredIdx] = buildRecallRow(results[deferredIdx]!, deferredMemory);
        } else {
          temporalSupersededFilteredCount += 1;
        }
      }
      filtered.length = 0;
      for (const builtRow of stateViewBuilt!) {
        if (builtRow) filtered.push(builtRow);
      }
    }
    if (connectorPartitionFilteredCount > 0) {
      log.debug(`connector partition filter removed ${connectorPartitionFilteredCount} tool-scoped candidates from recall`);
    }
    if (supportPassportFilteredCount > 0) {
      log.debug(
        `support passport filter removed ${supportPassportFilteredCount} owner-controlled records from generic recall`,
      );
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
    if (stateViewAdmittedCount > 0) {
      log.debug(
        `state views admitted ${stateViewAdmittedCount} superseded candidates anchored on in-set successors (#1952)`,
      );
    }
    if (biTemporalExpiredFilteredCount > 0) {
      log.debug(
        `bi-temporal validity filter removed ${biTemporalExpiredFilteredCount} expired-validity candidates from injection (temporal.biTemporal on)`,
      );
    }
    if (dedicatedSurfaceFilteredCount > 0) {
      log.debug(
        `dedicated surface filter removed ${dedicatedSurfaceFilteredCount} dream/procedural/activity-digest candidates from generic recall`,
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

  async filterSearchResultsForRecall(
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
      /** #1952 state-view admission — see filterSearchResultsByRecallSafety. */
      stateViewActive?: boolean;
    },
  ): Promise<{ results: QmdSearchResult[]; memoryByPath: Map<string, MemoryFile> }> {
    if (results.length === 0) {
      return {
        results,
        memoryByPath: preloadedMemoryMap ? new Map(preloadedMemoryMap) : new Map(),
      };
    }
    const loaded = await this.deps.loadSearchResultMemoryMap(
      results,
      preloadedMemoryMap,
      options,
    );
    const candidateResults = loaded.completed
      ? results
      : results.filter((result) => !result.path || resultHasKey(loaded.checkedPaths, result));
    if (!loaded.completed) {
      log.debug(
        `recall safety filter stopped before validating all candidates (${candidateResults.length}/${results.length} eligible)`,
      );
    }
    const blockedPaths = new Set<string>(loaded.unreadablePaths);
    if (options?.dropUnresolved === true) {
      for (const result of candidateResults) {
        if (result.path && resultHasKey(loaded.checkedPaths, result) && !hasMemoryForResult(loaded.memoryByPath, result)) {
          markResultKey(blockedPaths, result);
        }
      }
    }
    return {
      results: this.deps.filterSearchResultsByRecallSafety(
        candidateResults,
        loaded.memoryByPath,
        { ...options, blockedPaths },
      ),
      memoryByPath: loaded.memoryByPath,
    };
  }

  async boostSearchResults(
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
      /** #1952 state-view admission — flows into filterSearchResultsForRecall. */
      stateViewActive?: boolean;
      requestingConnector?: string;
    },
  ): Promise<QmdSearchResult[]> {
    const lifecycleCaps = resolveMemoryLifecycleCapabilities(this.deps.config);
    if (results.length === 0) return results;

    const safety = await this.deps.filterSearchResultsForRecall(
      results,
      preloadedMemoryMap,
      { ...options, recallNamespaces: _recallNamespaces },
    );
    const safeResults = safety.results;
    const memoryByPath = safety.memoryByPath;
    if (safeResults.length === 0) return safeResults;

    const now = Date.now();

    const resultPaths = new Set(
      safeResults.map((r) => r.path).filter(Boolean) as string[],
    );
    let temporalFromDate: string | null = null;
    let promptTags: string[] = [];
    if (resolveIndexingCapabilities(this.deps.config).queryAwareIndexing && prompt) {
      if (isTemporalQuery(prompt)) {
        temporalFromDate = recencyWindowFromPrompt(prompt, now);
      }
      promptTags = extractTagsFromPrompt(prompt);
    }

    const [rawTemporal, rawTags] = await readIndexSnapshotAsync(
      this.deps.config.memoryDir,
      () =>
        Promise.all([
          temporalFromDate !== null
            ? queryByDateRangeAsync(this.deps.config.memoryDir, temporalFromDate)
            : Promise.resolve<Set<string> | null>(null),
          promptTags.length > 0
            ? queryByTagsAsync(this.deps.config.memoryDir, promptTags)
            : Promise.resolve<Set<string> | null>(null),
        ]),
    );

    const queryIntent =
      resolveConversationContextCapabilities(this.deps.config).intentRouting && prompt
        ? inferIntentFromText(prompt)
        : null;

    // v8.1: Temporal + Tag prefilter candidate set
    let temporalCandidates: Set<string> | null = null;
    let tagCandidates: Set<string> | null = null;
    if (resolveIndexingCapabilities(this.deps.config).queryAwareIndexing && prompt) {
      const maxCandidates = this.deps.config.queryAwareIndexingMaxCandidates;
      const capSet = (s: Set<string> | null): Set<string> | null => {
        if (!s) return null;
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
    const recencyWeight = this.deps.effectiveRecencyWeight();
    const mtimeFallback =
      recencyWeight > 0
        ? await collectMtimeFallbackContext(
            safeResults.flatMap((r) => { const m = memoryForResult(memoryByPath, r); return m ? [m] : []; }),
          )
        : null;
    for (const r of safeResults) {
      const memory = memoryForResult(memoryByPath, r);
      let score = r.score;

      if (memory) {
        // Recency boost: 7-day exponential decay over the shared age resolver
        // (#2976): content dates first, trusted mtime as fallback, unknown
        // age never fresh. See memory-age.ts.
        score = applyRecencyBoost(score, memory, recencyWeight, now, mtimeFallback);

        // Access count boost: log scale, capped
        if (this.deps.config.boostAccessCount && memory.frontmatter.accessCount) {
          const accessBoost =
            Math.log10(memory.frontmatter.accessCount + 1) / 3;
          score += applyUtilityRankingRuntimeDelta(
            Math.min(accessBoost, 0.1),
            this.deps.utilityRuntimeValues,
            "boost",
          );
        }

        if (memory.frontmatter.importance) {
          const importanceScore = memory.frontmatter.importance.score;
          // Boost important memories, slightly penalize trivial ones
          // Scale: trivial (-0.05) to critical (+0.15)
          const importanceBoost = (importanceScore - 0.4) * 0.25;
          score += applyUtilityRankingRuntimeDelta(
            importanceBoost,
            this.deps.utilityRuntimeValues,
            importanceBoost >= 0 ? "boost" : "suppress",
          );
        }

        // Feedback bias (v2.2): apply small user-provided up/down vote adjustments.
        if (resolveRecallEnhancementCapabilities(this.deps.config).feedback) {
          const match = memory.path.match(/([^/]+)\.md$/);
          const memoryId = match ? match[1] : null;
          if (memoryId) {
            const feedbackDelta = this.deps.relevance.adjustment(memoryId);
            score += applyUtilityRankingRuntimeDelta(
              feedbackDelta,
              this.deps.utilityRuntimeValues,
              feedbackDelta >= 0 ? "boost" : "suppress",
            );
          }
        }

        // Negative examples (v2.2): apply a small penalty for memories repeatedly marked "not useful".
        if (resolvePipelineProcessingCapabilities(this.deps.config).negativeExamples) {
          const match = memory.path.match(/([^/]+)\.md$/);
          const memoryId = match ? match[1] : null;
          if (memoryId) {
            const negativePenalty = this.deps.negatives.penalty(memoryId, {
              perHit: this.deps.config.negativeExamplesPenaltyPerHit,
              cap: this.deps.config.negativeExamplesPenaltyCap,
            });
            score -= applyUtilityRankingRuntimeDelta(
              negativePenalty,
              this.deps.utilityRuntimeValues,
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
            compatibility * this.deps.config.intentRoutingBoost,
            this.deps.utilityRuntimeValues,
            "boost",
          );
        }

        // v8.1: Temporal + Tag index boost
        if (resolveIndexingCapabilities(this.deps.config).queryAwareIndexing && r.path) {
          if (temporalCandidates?.has(r.path)) {
            score += applyUtilityRankingRuntimeDelta(
              0.08,
              this.deps.utilityRuntimeValues,
              "boost",
            );
          }
          if (tagCandidates?.has(r.path)) {
            score += applyUtilityRankingRuntimeDelta(
              0.06,
              this.deps.utilityRuntimeValues,
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
          this.deps.utilityRuntimeValues,
          lifecycleDelta >= 0 ? "boost" : "suppress",
        );

        // Reinforcement recall boost (issue #687 PR 3/4).
        // Applies an additive score bonus proportional to how many times the
        // pattern-reinforcement job has promoted this memory as a canonical.
        // Formula: min(reinforcement_count * weight, max).
        // Gated by reinforcementRecallBoostEnabled (default false).
        let reinforcementBoost = 0;
        if (
          resolveRecallEnhancementCapabilities(this.deps.config).reinforcementRecallBoost &&
          typeof memory.frontmatter.reinforcement_count === "number" &&
          memory.frontmatter.reinforcement_count > 0
        ) {
          reinforcementBoost = Math.min(
            memory.frontmatter.reinforcement_count *
              this.deps.config.reinforcementRecallBoostWeight,
            this.deps.config.reinforcementRecallBoostMax,
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

    if (outcomePriorBoostActive(this.deps.config)) applyOutcomePriorScores(boosted, memoryByPath, this.deps.config);

    return boosted.sort((a, b) => b.score - a.score);
  }
}
