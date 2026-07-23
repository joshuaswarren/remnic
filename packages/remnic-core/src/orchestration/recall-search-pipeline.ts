/**
 * Recall search-pipeline coordinator — extracted from the orchestrator
 * (issue #1526, seam 19).
 *
 * Owns the QMD search post-processing helpers that feed recall assembly:
 *   - query-aware prefiltering and artifact top-up fetch
 *   - embedding/archive/cold-collection fallback pipelines
 *   - recall-safety filtering and memory-map loading
 *   - result boosting (recency, access, importance, relevance)
 *
 * Behavior-preserving move from orchestrator.ts. No logic changes — the
 * orchestrator keeps thin delegating methods (the private API callers and
 * tests keep working), and every member the moved code consults flows back
 * through RecallSearchPipelineDeps into the orchestrator's own overridable
 * members, so instance-level test stubs keep taking effect (the same
 * late-binding rule as seam 18).
 */

import { createHash } from "node:crypto";
import path from "node:path";
import { abortError } from "../abort-error.js";
import { type CapabilitySet, type GraphConstructionCapabilitySet, resolveCapabilities, resolveConversationContextCapabilities, resolveGraphConstructionCapabilities, resolveIndexingCapabilities, resolveMemoryLifecycleCapabilities, resolveNamespaceCapabilities, resolvePipelineProcessingCapabilities, resolveQmdCapabilities, resolveRecallEnhancementCapabilities } from "../capabilities.js";
import { EmbeddingFallback } from "../embedding-fallback.js";
import { StorageManager } from "../index.js";
import { inferIntentFromText, intentCompatibilityScore } from "../intent.js";
import { log } from "../logger.js";
import { NamespaceStorageRouter } from "../namespaces/storage.js";
import { NegativeExampleStore } from "../negative.js";
import { qmdCollectionPathParts } from "./qmd-result-resolver.js";
import type { GraphRecallExpandedEntry } from "../recall-state.js";
import { getDefaultArchiveScoring, memoryFileToScoreItem } from "../recall/archive-scoring.js";
import { RelevanceStore } from "../relevance.js";
import { RerankCache, rerankLocalOrNoop, reorderByRankedKeys } from "../rerank.js";
import type { SearchBackend, SearchDegradation, SearchExecutionOptions, SearchQueryOptions } from "../search/port.js";
import { SecureStoreLockedError } from "../secure-store/index.js";
import { isPathInsideStorageRoot } from "../storage-paths.js";
import { extractTagsFromPrompt, isTemporalQuery, queryByDateRangeAsync, queryByTagsAsync, readIndexSnapshotAsync, recencyWindowFromPrompt, resolvePromptTagPrefilterAsync } from "../temporal-index.js";
import { shouldFilterSupersededFromRecall } from "../temporal-supersession.js";
import { isValidAsOf, isValidityExpiredNow } from "../temporal-validity.js";
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
import { type UtilityRuntimeValues, applyUtilityRankingRuntimeDelta } from "../utility-runtime.js";
import {
  computeArtifactCandidateFetchLimit,
  lifecycleRecallScoreAdjustment,
  shouldFilterLifecycleRecallCandidate,
  computeQmdHybridFetchLimit,
  filterRecallCandidates,
  throwIfRecallAborted,
  tokenizeRecallQuery,
  type QmdRecallSnapshot,
  type QueryAwarePrefilter,
} from "../orchestrator.js";
import { isActivityDigestPath, isGenericRecallExcludedPath } from "./orchestrator-helpers.js";

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
    },
  ): Promise<QmdSearchResult[]>;
  buildConfiguredQmdSearchOptions(
    queryText: string,
  ): SearchQueryOptions | undefined;
  buildQueryAwarePrefilter(
    prompt: string,
    recallNamespaces: string[],
  ): Promise<QueryAwarePrefilter>;
  readonly config: PluginConfig;
  diversifyAndLimitRecallResults(
    sectionId: string,
    results: QmdSearchResult[],
    limit: number,
    retrievalQuery?: string,
    caps?: CapabilitySet,
  ): QmdSearchResult[];
  effectiveRecencyWeight(): number;
  readonly embeddingFallback: EmbeddingFallback;
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
  readArchivedMemoriesForNamespaces(namespaces: string[]): Promise<MemoryFile[]>;
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
  searchLongTermArchiveFallback(
    prompt: string,
    recallNamespaces: string[],
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
  ): Promise<MemoryFile[]> {
    const storage = await this.deps.storageRouter.storageFor(namespace);
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
          ? await this.deps.resolveArtifactSourceStatuses(storage, sourceIds)
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

  async buildQueryAwarePrefilter(
    prompt: string,
    recallNamespaces: string[],
  ): Promise<QueryAwarePrefilter> {
    if (!resolveIndexingCapabilities(this.deps.config).queryAwareIndexing || !prompt.trim()) {
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
    // Read the temporal + tag prefilter indexes as ONE consistent snapshot
    // (issue #1911, Codex Medium) so a concurrent async index mutation can't be
    // observed half-applied (new temporal row, tag membership not yet written),
    // which would drop the current memory from the tag prefilter.
    const [rawTemporal, tagSignals] = await readIndexSnapshotAsync(
      this.deps.config.memoryDir,
      () =>
        Promise.all([
          temporalFromDate
            ? queryByDateRangeAsync(this.deps.config.memoryDir, temporalFromDate)
            : Promise.resolve<Set<string> | null>(null),
          resolvePromptTagPrefilterAsync(this.deps.config.memoryDir, prompt).catch(
            () => ({
              matchedTags: extractTagsFromPrompt(prompt),
              expandedTags: extractTagsFromPrompt(prompt),
              paths: null,
            }),
          ),
        ]),
    );

    const temporalCandidates = this.deps.scopeQueryAwarePaths(
      rawTemporal,
      recallNamespaces,
    );
    const tagCandidates = this.deps.scopeQueryAwarePaths(
      tagSignals.paths,
      recallNamespaces,
    );
    const maxCandidates = this.deps.config.queryAwareIndexingMaxCandidates;

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
          // Overfetch the FULL scoped candidate set BEFORE the generic-recall
          // exclusion `filterRecallCandidates` applies below (L464). Capping to
          // `qmdFetchLimit` here lets excluded paths (artifacts, activity digests,
          // meeting records) consume the caller's budget and drop legitimate hits
          // with no refill — the hot-path mirror of the archive-fallback fix. The
          // candidate set is an already-bounded prefilter, so its size is the
          // natural ceiling; the post-exclusion cap is applied by filterRecallCandidates.
          queryAwarePrefilter.candidatePaths.size,
          { allowArchived: options.collection !== undefined },
        )
      : [];
    // Drop generic-recall-excluded records before the fetchLimit cap so they can't starve valid memories (#1995).
    const recallable = (r: QmdSearchResult) => !isGenericRecallExcludedPath(r.path, this.deps.config.memoryDir);

    let fetchLimit = Math.max(qmdFetchLimit, qmdHybridFetchLimit);
    const maxFetchLimit = Math.min(
      320,
      Math.max(fetchLimit, qmdFetchLimit * 5),
    );
    const MAX_ATTEMPTS = 2;
    const qmdRecallBudgetMs = this.deps.config.recallEnrichmentDeadlineMs ?? 25_000;
    const qmdRecallBudgetEnabled = qmdRecallBudgetMs > 0;
    const startedAtMs = Date.now();
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
    let bestFiltered = filterRecallCandidates(scopedSeedResults, {
      namespacesEnabled: options.namespacesEnabled,
      recallNamespaces: options.recallNamespaces,
      resolveNamespace: options.resolveNamespace,
      limit: qmdFetchLimit,
      memoryRoot: this.deps.config.memoryDir,
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
        } else if (this.deps.config.qmdSearchStrategy === "lex") {
          // BM25-only strategy: a hybrid top-up runs vectorSearch (see
          // QmdClient.hybridSearch), which would reintroduce the vector path the
          // operator opted out of. Keep "lex" BM25-only end-to-end so the gate is
          // uniform across primary + top-up (gotcha #39). Issue #1335 (codex review #1422).
          lastHybridTopUpSkippedReason = "lex_strategy";
        } else {
          const hybridResults = options.collection
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
          lastHybridResultCount = hybridResults.length;
          lastHybridTopUpUsed = hybridResults.length > 0;
          if (hybridResults.length > 0) {
            // Dedup by composite (namespace, path) so a hit never injects twice (#2020).
            mergedResults = dedupeResultsByNamespace(
              [...primaryResults, ...hybridResults],
              this.deps.namespaceFromPath,
              fetchLimit,
              { transportFallback: "hybrid", filter: recallable },
            );
          }
        }
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
        memoryRoot: this.deps.config.memoryDir,
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

  async searchEmbeddingFallback(
    query: string,
    limit: number,
  ): Promise<QmdSearchResult[]> {
    if (!resolveMemoryLifecycleCapabilities(this.deps.config).embeddingFallback) return [];
    if (!(await this.deps.embeddingFallback.isAvailable())) return [];
    const hits = await this.deps.embeddingFallback.search(query, limit);
    if (hits.length === 0) return [];

    const results: QmdSearchResult[] = [];
    for (const hit of hits) {
      const fullPath = path.isAbsolute(hit.path)
        ? hit.path
        : path.join(this.deps.config.memoryDir, hit.path);
      const memory = await this.deps.storage.readMemoryByPath(fullPath);
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
  async searchLongTermArchiveFallback(
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

    const candidatePaths = queryAwarePrefilter?.candidatePaths;
    const scopedSeedResults = (
      candidatePaths?.size
        ? await this.deps.searchScopedMemoryCandidates(
            candidatePaths,
            prompt,
            // Overfetch the FULL scoped candidate set BEFORE the generic-recall
            // exclusion below. Capping to `cappedLimit` first lets excluded paths
            // (artifacts, activity digests, meeting records) consume the caller's
            // budget and drop legitimate hits with no refill — e.g. a prefilter of
            // [meetingRecord, facts/a.md] at limit 1 would return nothing. The
            // candidate set is an already-bounded prefilter, so its size is the
            // natural ceiling; the post-exclusion cap is applied below.
            candidatePaths.size,
            { allowArchived: true },
          )
        : []
    ).filter((result) => !isGenericRecallExcludedPath(result.path, this.deps.config.memoryDir));
    // Non-recallable seed paths (artifacts, activity digests, meeting records) are
    // excluded above AFTER an unconstrained candidate fetch, so the cap here counts
    // only recallable seeds — and EVERY early-return / direct-caller path below
    // returns already-filtered, budget-honoring seeds.
    if (scopedSeedResults.length >= cappedLimit) {
      return scopedSeedResults.slice(0, cappedLimit);
    }

    const tokens = Array.from(new Set(tokenizeRecallQuery(prompt)));
    if (tokens.length === 0) return scopedSeedResults;

    throwIfRecallAborted(abortSignal);
    const archivedMemories =
      await this.deps.readArchivedMemoriesForNamespaces(recallNamespaces);
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

    return dedupeResultsByNamespace(
      [...scopedSeedResults, ...scored],
      this.deps.namespaceFromPath,
      cappedLimit,
      { filter: (result) => !isGenericRecallExcludedPath(result.path, this.deps.config.memoryDir) },
    );
  }

  async applyColdFallbackPipeline(options: {
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
      // Invoked when the deadline abandons this step (before it started or
      // while it runs), so callers can report the abandonment and gate off
      // late observer callbacks (#1536, cursor round-6 on #1544).
      onDeadline?: () => void,
    ): Promise<T> => {
      throwIfRecallAborted(options.abortSignal);
      const remainingMs = deadlineRemainingMs();
      // Step-level deadline abort (#1907): compose the caller's request signal with
      // a per-step controller so a disconnect OR this step's deadline stops the task.
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
                searchOptions: this.deps.buildConfiguredQmdSearchOptions(options.prompt),
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
      // The archive-scan scoring worker terminates when EITHER the caller
      // aborts or this step's own deadline wins — both flow through the
      // step signal injected by runColdStepWithinDeadline (#1674, #1907).
      longTerm = await runColdStepWithinDeadline(
        "archive scan", [],
        (stepSignal) => this.deps.searchLongTermArchiveFallback(
          options.prompt, options.recallNamespaces, options.recallResultLimit,
          options.queryAwarePrefilter, stepSignal),
      );
      if (longTerm.length > 0) {
        log.debug("cold-tier recall source=archive-scan");
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
    // Dedicated-surface isolation: generic recall must exclude artifacts and
    // activity digests (both remain readable via explicit search).
    results = results.filter((r) => !isGenericRecallExcludedPath(r.path, this.deps.config.memoryDir));
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
      });
      results = merged;
    }

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
                { allowLifecycleFiltered: true, asOfMs: options.asOfMs },
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

    if (caps.rerank && this.deps.config.rerankProvider === "local") {
      // (namespace, path) id so same-relative-path cross-namespace hits are not collapsed (#2020).
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
    return this.deps.diversifyAndLimitRecallResults(
      "memories",
      results,
      options.recallResultLimit,
      options.prompt,
      caps,
    );
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
    },
  ): QmdSearchResult[] {
    const lifecycleCaps = resolveMemoryLifecycleCapabilities(this.deps.config);
    let lifecycleFilteredCount = 0;
    let temporalSupersededFilteredCount = 0;
    let biTemporalExpiredFilteredCount = 0;
    let dedicatedSurfaceFilteredCount = 0;
    let forgottenFilteredCount = 0;
    let blockedPathFilteredCount = 0;
    const filtered: QmdSearchResult[] = [];
    for (const r of results) {
      if (options?.blockedPaths && resultHasKey(options.blockedPaths, r)) {
        blockedPathFilteredCount += 1;
        continue;
      }
      const memory = memoryForResult(memoryByPath, r);
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
            includeInRecall: this.deps.config.temporalSupersessionIncludeInRecall,
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
          this.deps.config.temporalBiTemporal &&
          !this.deps.config.temporalExpiredInInjection &&
          isValidityExpiredNow(memory.frontmatter, Date.now())
        ) {
          biTemporalExpiredFilteredCount += 1;
          continue;
        }

        // Activity day-digests are a dedicated searchable surface (explicit
        // activity search), never generic recall — captured screen text must not
        // auto-inject into ordinary prompts (issue #1899). Keyed on the PATH:
        // the digest's `kind` frontmatter marker does not survive parseFrontmatter.
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
    // Always block secure-store-locked candidates that failed to load: they
    // must never re-enter ranking/injection without a loaded memory, whether or
    // not dropUnresolved is set. Keyed by composite (namespace, path).
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

  /**
   * Apply recency, access count, and importance boosting to QMD search results.
   * Returns re-ranked results.
   */
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

    // Determine temporal/tag query params before index I/O (pure computation).
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

    // Consistent temporal+tag snapshot (issue #1911, Codex Medium): read both
    // indexes under one op-lock so an in-flight async mutation is never observed
    // half-applied.
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
    // Scope to result paths first so cross-namespace paths don't consume the cap.
    let temporalCandidates: Set<string> | null = null;
    let tagCandidates: Set<string> | null = null;
    if (resolveIndexingCapabilities(this.deps.config).queryAwareIndexing && prompt) {
      const maxCandidates = this.deps.config.queryAwareIndexingMaxCandidates;
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
    const recencyWeight = this.deps.effectiveRecencyWeight();
    for (const r of safeResults) {
      const memory = memoryForResult(memoryByPath, r);
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
        if (this.deps.config.boostAccessCount && memory.frontmatter.accessCount) {
          const accessBoost =
            Math.log10(memory.frontmatter.accessCount + 1) / 3;
          score += applyUtilityRankingRuntimeDelta(
            Math.min(accessBoost, 0.1),
            this.deps.utilityRuntimeValues,
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
        // Results that match the detected temporal window or tag query get a small additive boost.
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

    // Re-sort by boosted score
    return boosted.sort((a, b) => b.score - a.score);
  }
}
