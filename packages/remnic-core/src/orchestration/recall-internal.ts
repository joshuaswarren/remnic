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
import { type BoxFrontmatter } from "../boxes.js";
import { type CapabilitySet, type GraphConstructionCapabilitySet, type MemoryLifecycleCapabilitySet, type SecurityCapabilitySet, resolveCapabilities, resolveCompressionCapabilities, resolveConsolidationCapabilities, resolveConversationContextCapabilities, resolveCreationMemoryCapabilities, resolveGraphConstructionCapabilities, resolveIdentityContinuityCapabilities, resolveIndexingCapabilities, resolveMemoryLifecycleCapabilities, resolveNamespaceCapabilities, resolveObjectiveStateCapabilities, resolvePipelineProcessingCapabilities, resolvePresentationCapabilities, resolveQmdCapabilities, resolveRecallAuxiliaryCapabilities, resolveRecallEnhancementCapabilities, resolveSecurityCapabilities } from "../capabilities.js";
import { searchCausalTrajectories } from "../causal-trajectory.js";
import { detectLanguageHint, dominantCorpusLanguage, planCrossScript } from "../cross-lingual-recall.js";
import { buildEntityRecallSection, entityRecentTranscriptLookbackHours, readRecentEntityTranscriptEntries } from "../entity-retrieval.js";
import { buildEventOrderRecallSection, shouldRecallEventOrderEvidence } from "../event-order-recall.js";
import { buildExplicitCueRecallSection } from "../explicit-cue-recall.js";
import { buildFocusedListRecallSection, shouldRecallFocusedListEvidence } from "../focused-list-recall.js";
import { type HarmonicRetrievalResult, searchHarmonicRetrieval } from "../harmonic-retrieval.js";
import { inferIntentFromText, planRecallMode } from "../intent.js";
import { log } from "../logger.js";
import { isActiveMemoryStatus } from "../memory-lifecycle-ledger-utils.js";
import { buildRetrievedMemoryProvenance } from "../memory-provenance.js";
import { canReadNamespace, resolvePrincipal } from "../namespaces/principal.js";
import { collectNativeKnowledgeChunks, formatNativeKnowledgeSection, searchNativeKnowledge } from "../native-knowledge.js";
import { objectiveStateStoreOverrideForNamespace, searchObjectiveStateSnapshots } from "../objective-state.js";
import { type GraphRecallRankedResult, type GraphRecallShadowComparison, mergeGraphExpandedResults } from "./graph-recall-coordinator.js";
import { buildProcedureRecallSection, mergeProcedureInjections } from "../procedural/procedure-recall.js";
import { canRecallToolScopedMemory } from "../tool-scoped-memory.js";
import { buildQmdRecallCacheKey, getCachedQmdRecall, setCachedQmdRecall } from "../qmd-recall-cache.js";
import { MEMORY_ID_PATTERN } from "../recall-handles.js";
import { shouldRecordRecallAuthorityHistory } from "../recall-navigation-config.js";
import {
  contextBudgetForFooter,
  formatCuriosityFooter, renderAuthorityBoundContent, selectCuriosityQuestion,
} from "../recall-context-composition.js";
import {
  compactRecallContextFromBuckets,
  decideRecallContextComposition,
  notifyContextComposition,
} from "../recall-composition-decision.js";
import {
  createBoundedCoreSectionRunner,
  createRecallSectionMetricRecorder,
  resolveRecallCoreSectionDeadlineMs,
  resolveRecallOuterDeadlineAtMs,
} from "../recall-qos.js";
import { buildRecallQueryPolicy } from "../recall-query-policy.js";
import { type GraphRecallExpandedEntry, type LastRecallSnapshot } from "../recall-state.js";
import {
  type RecallFilterTrace,
  type RecallXrayResult,
  type RecallXrayScoreDecomposition,
  buildXraySnapshot,
} from "../recall-xray.js";
import { foldQueueWaitTiming } from "../recall-timings.js";
import { emitRecallTiming } from "../recall-attempt-timing.js";
import { createPhase2Timer, type Phase2AwaitStatus } from "../recall-phase2-timing.js";
import { createEnrichmentAbortHandle, observeEnrichmentPromise, type DeferredEnrichmentOutcome, type EnrichmentAbortHandle, type ObservedDeferredEnrichmentPromise } from "../recall-enrichment-promise.js";
import { findUnresolvedEntityRefs } from "../reconstruct.js";
import { rerankLocalOrNoop, reorderByRankedKeys } from "../rerank.js";
import { buildResponseGuidanceRecallSection, shouldRecallResponseGuidance } from "../response-guidance-recall.js";
import { type ParallelSearchResult, mergeWithAgentResults, runDirectAgent, runTemporalAgent, shouldRunAgent } from "../retrieval-agents.js";
import { resolveScopePlan } from "../scopes/scope-plan.js";
import type { SearchDegradation } from "../search/port.js";
import { type VerifiedSemanticRuleResult, compareVerifiedSemanticRuleResults, searchVerifiedSemanticRules } from "../semantic-rule-verifier.js";
import { isDisagreementPrompt } from "../signal.js";
import { buildTargetedFactRecallSection, shouldRecallTargetedFactEvidence } from "../targeted-fact-recall.js";
import { queryTemporalTimelineAsync } from "../temporal-index.js";
import { type TrustStageResultItem, projectTrustForXray } from "../trust-score-stage.js";
import { isValidAsOf } from "../temporal-validity.js";
import { buildTemporalTimelineRecallSection, type TemporalTimelineRecallItem } from "../temporal-timeline-recall.js";
import { searchTrustZoneRecords } from "../trust-zones.js";
import type { IdentityInjectionMode, MemoryFile, QmdSearchResult, RecallPlanMode } from "../types.js";
import { type VerifiedEpisodeResult, compareVerifiedEpisodeResults, searchVerifiedEpisodes } from "../verified-recall.js";
import { type WorkProductLedgerSearchResult, searchWorkProductLedgerEntries } from "../work-product-ledger.js";
import { abortError, isAbortError, raceAbort } from "../abort-error.js";
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
  type QueryAwarePrefilter,
  type RecallInvocationOptions,
} from "../orchestrator.js";
import { isGenericRecallExcludedPath } from "./generic-recall-paths.js";
import { filterRecentScanMemories } from "../recall-state-view-anchors.js";
import { indexStateViewAnnotatedResults, resolveRecallStateViewActive } from "../recall-state-view-admission.js";
import type { RecallSectionBuckets } from "./recall-section-coordinator.js";
import {
  reconcileRecallResultPartition,
  type RecallResultPartition,
  type RecallResultPartitionSink,
} from "./recall-rerank-coordinator.js";
import type { RecallInternalDeps } from "./recall-internal-deps.js";
import { appendEpisodicContextSection } from "./episodic-context-section.js";
import { resolveCompositeProfileStorage } from "./recall-profile-storage.js";
import { fetchQmdMemoryResultsWithRecognitionSwap } from "./recall-recognition-search.js";

export class RecallInternalCoordinator {
  private readonly securityCapabilities: SecurityCapabilitySet;
  constructor(private readonly deps: RecallInternalDeps) { this.securityCapabilities = resolveSecurityCapabilities(deps.config); }

  async recallInternal(
    prompt: string,
    sessionKey?: string,
    options: RecallInvocationOptions = {},
    caps: CapabilitySet = resolveCapabilities(this.deps.config),
    graphCaps: GraphConstructionCapabilitySet = resolveGraphConstructionCapabilities(this.deps.config),
    lifecycleCaps: MemoryLifecycleCapabilitySet = resolveMemoryLifecycleCapabilities(this.deps.config),
  ): Promise<string> {
    const recallStart = Date.now();
    const backendDegradations: SearchDegradation[] = [];
    let asOfMs: number | undefined;
    if (typeof options.asOf === "string" && options.asOf.length > 0) {
      const parsed = Date.parse(options.asOf);
      if (Number.isFinite(parsed)) asOfMs = parsed;
    }
    const timings = foldQueueWaitTiming(options.queueWaitMs); // #1906 queue-wait phase
    const phase2Timings: Record<string, string> = {};
    const phase2Timer = createPhase2Timer(phase2Timings, () => options.abortSignal?.aborted === true);
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
    const recallOuterTimeoutMs = this.deps.config.recallOuterTimeoutMs ?? 75_000;
    const enrichmentSectionDeadlineMs = this.deps.config.recallEnrichmentDeadlineMs ?? 60_000;
    try {
    const recordRecallSectionMetric =
      createRecallSectionMetricRecorder({ timings, logger: log });
    // The client's deadlineMs (issue #3499) caps the configured ceiling.
    const outerDeadlineAtMs = resolveRecallOuterDeadlineAtMs({
      recallStart, recallOuterTimeoutMs, clientDeadlineMs: options.deadlineMs,
    });
    const enrichmentAbort = () =>
      createEnrichmentAbortHandle(options.abortSignal, resolveRecallCoreSectionDeadlineMs({
        configuredCoreDeadlineMs: enrichmentSectionDeadlineMs,
        remainingOuterMs: outerDeadlineAtMs === null ? null : outerDeadlineAtMs - Date.now() }));
    const runBoundedCoreSection = createBoundedCoreSectionRunner({
      configuredDeadlineMs: recallSectionDeadlineMs,
      outerDeadlineAtMs,
      parentSignal: options.abortSignal,
      record: recordRecallSectionMetric,
      logger: log,
    });
    const promptHash = createHash("sha256").update(prompt).digest("hex");
    const traceId = createHash("sha256")
      .update(`${sessionKey ?? "default"}:${recallStart}:${promptHash}`)
      .digest("hex")
      .slice(0, 16);
    const sectionBuckets: RecallSectionBuckets = new Map();
    const queryPolicy = buildRecallQueryPolicy(prompt, sessionKey, {
      cronRecallPolicyEnabled: resolveRecallAuxiliaryCapabilities(this.deps.config).cronRecallPolicy,
      cronRecallNormalizedQueryMaxChars:
        this.deps.config.cronRecallNormalizedQueryMaxChars,
      cronRecallInstructionHeavyTokenCap:
        this.deps.effectiveCronRecallInstructionHeavyTokenCap(),
      cronConversationRecallMode: this.deps.config.cronConversationRecallMode,
    });
    const retrievalQuery = queryPolicy.retrievalQuery || prompt;
    const stateViewActive = resolveRecallStateViewActive(options, this.deps.config, prompt);
    const stateViewPacketActive =
      stateViewActive === true && !(typeof asOfMs === "number" && Number.isFinite(asOfMs));
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
    let xrayRecalledResults: QmdSearchResult[] = [];
    let recallTrustByPath: Map<string, TrustStageResultItem> | null = null;
    const trustByPathSink: { trustByPath: Map<string, TrustStageResultItem> | null } = {
      trustByPath: null,
    };
    const lcmStructuredXrayResults: RecallXrayResult[] = [];
    const xrayBranchPoolSize: Record<
      "hot_qmd" | "hot_embedding" | "cold_fallback" | "recent_scan",
      number
    > = {
      hot_qmd: 0,
      hot_embedding: 0,
      cold_fallback: 0,
      recent_scan: 0,
    };
    const xrayColdPoolSink = { size: 0 };
    let selectedResultPartition: RecallResultPartition | null = null;
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
    const requestedMode: RecallPlanMode | undefined = options.mode ?? (planRecallMode(prompt) === "no_recall" ? "no_recall" : undefined);
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
    const recallMode: RecallPlanMode = requestedMode ?? recallDecision.effectiveMode;
    const queryIntent = inferIntentFromText(retrievalQuery);
    const qmdSearchOptions = this.deps.buildConfiguredQmdSearchOptions(retrievalQuery, options.searchOptions);
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
    await options.onRecallPlanResolved?.(recallMode, recallNamespaces);
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
      const earlySessionKey = sessionKey ?? "default";
      this.deps._recallWorkspaceOverrides.delete(earlySessionKey);
      timings.total = `${Date.now() - recallStart}ms`;
      emitRecallTiming(this.deps.config, {
        ...timings,
        timestamp: new Date().toISOString(),
        namespace: selfNamespace,
        total: timings.total,
        recallPlan: timings.recallPlan,
        queryPolicy: timings.queryPolicy,
      });
      //
      if (
        options.xrayCapture === true &&
        !options.abortSignal?.aborted
      ) {
        try {
          this.deps.lastXraySnapshot = buildXraySnapshot({
            query: retrievalQuery,
            tierExplain: null,
            results: [],
            appliedResultLimit: recallResultLimit,
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
          log.debug(`x-ray capture (no_recall) failed: ${err}`);
        }
      }
      if (sessionKey) {
        this.deps.trackRecallBackgroundWrite(
          this.deps.lastRecall.record({
            sessionKey,
            query: prompt,
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
            timings: { ...timings },
            includedMemories: [],
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
    const { profileStorage, profileStorageDirs } = resolveCompositeProfileStorage({
      profileStorages,
      memoryDir: this.deps.config.memoryDir,
    });

    throwIfRecallAborted(options.abortSignal);

    if (
      this.deps.namespaceCatalog.enabled &&
      recallResultLimit > 0 &&
      !options.abortSignal?.aborted
    ) {
      for (const ns of recallNamespaces) this.deps.storageRouter.recordRead(ns);
    }

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
        this.deps.sharedContext.readPriorities(options.abortSignal),
        this.deps.sharedContext.readLatestRoundtable(options.abortSignal),
        this.deps.sharedContext.readLatestCrossSignals(options.abortSignal),
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

    //
    //
    //
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
          peerProfileXrayAnnotation = null;
          return null;
        }
        const allFields = Object.entries(peerProfile.fields);
        if (allFields.length === 0) {
          peerProfileXrayAnnotation = null;
          return null;
        }
        const fieldsByRecency = allFields
          .map(([key, value]) => {
            const prov = peerProfile.provenance[key];
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
      return await runBoundedCoreSection(
        "entityRetrieval",
        null as string | null,
        async (sectionSignal) => {
          const transcriptEntries = sessionKey
            ? await raceAbort(
                readRecentEntityTranscriptEntries(
                  this.deps.transcript.readRecent(
                    entityRecentTranscriptLookbackHours,
                    sessionKey,
                  ),
                  recentTurns,
                ),
                sectionSignal,
                "entity recall aborted",
              )
            : [];
          return await buildEntityRecallSection({
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
            originAuthorityEnabled: this.securityCapabilities.originAuthority, untrustedOrigins: this.deps.config.untrustedOrigins,
            abortSignal: sectionSignal,
          }).catch((err) => {
            if (isAbortError(err)) throw err;
            log.warn(`entity retrieval build failed: ${err}`);
            return null;
          });
        },
      );
    })();

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

    const artifactsPromise = (async (): Promise<MemoryFile[]> => {
      if (
        !this.deps.isRecallSectionEnabled(
          "verbatim-artifacts",
          resolvePresentationCapabilities(this.deps.config).verbatimArtifacts === true,
        )
      )
        return [];
      if (!resolvePresentationCapabilities(this.deps.config).verbatimArtifacts) return [];
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
      return await runBoundedCoreSection(
        "artifacts",
        [] as MemoryFile[],
        async (sectionSignal) => {
          const results = await this.deps.recallArtifactsAcrossNamespaces(
            retrievalQuery,
            recallNamespaces,
            targetCount,
            { abortSignal: sectionSignal },
          );
          return lifecycleCaps.extractionScopeClassification
            ? results.filter((artifact) =>
                canRecallToolScopedMemory(artifact.frontmatter, options.sourceConnector),
              )
            : results;
        },
      );
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
          rules, retrievalQuery, this.deps.config.calibrationMaxChars,
          this.deps.config.calibrationMaxRulesPerRecall,
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

    const harmonicStartedMs = performance.now();
    const harmonicRetrievalAbort = enrichmentAbort();
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
              temporalExpiredInInjection: this.deps.config.temporalExpiredInInjection,
              abortSignal: harmonicRetrievalAbort.signal, useGraphCache: true,
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

    const prefilterStartedMs = performance.now();
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

    type QmdPhaseResult = {
      memoryResultsLists: QmdSearchResult[][];
      globalResults: QmdSearchResult[];
      preAugmentTopScore: number;
      maxSpecializedScore: number;
      degradations?: SearchDegradation[];
    } | null;

    const crossScriptPlanPromise = (async () => {
      const queryLanguage = detectLanguageHint(retrievalQuery);
      if (queryLanguage === undefined) return null;
      const corpusLanguage = await dominantCorpusLanguage(this.deps.storage);
      if (corpusLanguage === undefined) return null;
      return planCrossScript({
        queryLanguage,
        corpusLanguage,
        vectorTierAvailable: resolveMemoryLifecycleCapabilities(this.deps.config).embeddingFallback,
      });
    })().catch(() => null);
    const qmdEnrichmentAbort = enrichmentAbort();
    const qmdPromise = observeEnrichmentPromise(
      (async (): Promise<QmdPhaseResult> => {
        const t0 = Date.now();
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
        const crossScriptPlan = await crossScriptPlanPromise;
        if (crossScriptPlan?.degradation) {
          backendDegradations.push(crossScriptPlan.degradation);
        }
        const crossScript = crossScriptPlan?.crossScript === true;
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
            await fetchQmdMemoryResultsWithRecognitionSwap(
              this.deps,
              retrievalQuery,
              qmdFetchLimit,
              qmdHybridFetchLimit,
              {
                namespacesEnabled: resolveNamespaceCapabilities(this.deps.config).namespaces,
                recallNamespaces,
                resolveNamespace: (p) => this.deps.namespaceFromPath(p),
                queryAwarePrefilter,
                searchOptions: qmdSearchOptions,
                crossScript,
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
            await this.deps.transcript.clearCheckpoint();
          }
        }
      }

      if (!checkpointInjected) {
        const entries = await this.deps.transcript.readRecent(transcriptLookbackHours, sessionKey, transcriptMaxTurns);
        log.debug(
          `recall: read ${entries.length} transcript entries for sessionKey=${sessionKey}`,
        );

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

    const compactionPromise = (async (): Promise<string | null> => {
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

    const nativeKnowledgeAbort = enrichmentAbort();
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

    const procedureInjectedMemories: Array<{ id: string; path: string; namespace?: string }> = [];
    const procedureRecallPromise = (async (): Promise<string | null> => {
      if (this.deps.config.procedural?.enabled !== true) return null;
      if (!this.deps.isRecallSectionEnabled("procedure-recall", true)) return null;
      try {
        return await buildProcedureRecallSection(
          profileStorage,
          retrievalQuery,
          this.deps.config,
          { partitionToolScoped: lifecycleCaps.extractionScopeClassification, requestingConnector: options.sourceConnector, injectedMemories: procedureInjectedMemories },
        );
      } catch (err) {
        log.debug(
          `procedure-recall: failed open: ${err instanceof Error ? err.message : String(err)}`,
        );
        return null;
      }
    })();

    const compoundingStartedMs = performance.now();
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
      onStatus?: (status: Phase2AwaitStatus) => void,
      sectionHandle?: EnrichmentAbortHandle,
    ): Promise<T | null> => {
      const finalizeEnrichmentOutcome = (
        outcome: DeferredEnrichmentOutcome<T>,
      ): T | null => {
        if (options.abortSignal?.aborted) {
          log.debug(
            `recall phase-1 enrichment [${name}]: skipped after abort at +${Date.now() - phase1Start}ms`,
          );
          onStatus?.("skipped");
          return null;
        }
        if (sectionHandle?.timedOut) {
          promise.cancel();
          if (outcome.status === "resolved" && outcome.value != null) {
            onStatus?.("ok");
            return outcome.value;
          }
          log.debug(`recall phase-1 enrichment [${name}]: section deadline fired at +${Date.now() - phase1Start}ms`);
          onStatus?.("timeout");
          return null;
        }
        if (outcome.status === "resolved") {
          log.debug(
            `recall phase-1 enrichment [${name}]: resolved at +${Date.now() - phase1Start}ms`,
          );
          onStatus?.("ok");
          return outcome.value;
        }
        log.warn(
          `recall phase-1 enrichment [${name}] failed open: ` +
            `${outcome.error instanceof Error ? outcome.error.message : String(outcome.error)}`,
        );
        onStatus?.("error");
        return null;
      };

      if (options.abortSignal?.aborted) {
        promise.cancel();
        log.debug(
          `recall phase-1 enrichment [${name}]: skipped after abort at +${Date.now() - phase1Start}ms`,
        );
        onStatus?.("skipped");
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
        onStatus?.("timeout");
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
        onStatus?.("timeout");
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

    this.deps.profiler.startSpan("assembly", profileTraceId);

    if (sharedCtx)
      this.deps.appendRecallSection(sectionBuckets, "shared-context", sharedCtx);

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
            originAuthorityEnabled: this.securityCapabilities.originAuthority, untrustedOrigins: this.deps.config.untrustedOrigins,
          });
        }

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

    if (peerProfileSection) {
      const peerSectionAppended = this.deps.appendRecallSection(
        sectionBuckets,
        "peer-profile",
        peerProfileSection,
      );
      if (!peerSectionAppended) {
        peerProfileXrayAnnotation = null;
      }
    }

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

    if (kiResult?.result) {
      const kiBody = this.securityCapabilities.originAuthority
        ? renderAuthorityBoundContent(kiResult.result, undefined, { enabled: true, untrustedOrigins: this.deps.config.untrustedOrigins })
        : kiResult.result;
      this.deps.appendRecallSection(sectionBuckets, "knowledge-index", kiBody);
      log.debug(
        `Knowledge Index: ${kiResult.result.split("\n").length - 4} entities, ${kiResult.result.length} chars${kiResult.cached ? " (cached)" : ""}`,
      );
    }

    const nativeKnowledgeSection = await awaitEnrichmentSection("nativeKnowledge", nativeKnowledgePromise, undefined, nativeKnowledgeAbort);
    if (nativeKnowledgeSection) {
      this.deps.appendRecallSection(
        sectionBuckets,
        "native-knowledge",
        nativeKnowledgeSection,
      );
    }

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
        const content = renderAuthorityBoundContent(this.deps.truncateArtifactForRecall(a.content), a.frontmatter.origin, {
          enabled: this.securityCapabilities.originAuthority,
          untrustedOrigins: this.deps.config.untrustedOrigins,
        });
        return `- [${artifactType}] "${content}" (${created})`;
      });
      this.deps.appendRecallSection(
        sectionBuckets,
        "verbatim-artifacts",
        `## Verbatim Artifacts\n\n${lines.join("\n")}`,
      );
    }

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

    if (
      this.deps.lcmEngine?.enabled &&
      recallMode !== "minimal" &&
      (recallMode as RecallPlanMode) !== "no_recall"
    ) {
      try {
        // #1495 + #1505 fallback unification: read across the ordered LCM read
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

    const qmdWasSettledBeforeAssemblyWait =
      qmdPromise.getSettledOutcome() !== undefined;
    const qmdResult = await awaitEnrichmentSection("qmd", qmdPromise, undefined, qmdEnrichmentAbort);
    if (qmdResult) {
      const t0 = Date.now();
      const {
        memoryResultsLists,
        globalResults,
        preAugmentTopScore,
        maxSpecializedScore,
      } = qmdResult;

      const memoryResultsRaw = mergeGraphExpandedResults(
        memoryResultsLists.flat(),
        [],
      );

      let memoryResults = memoryResultsRaw;

      if (resolveNamespaceCapabilities(this.deps.config).namespaces) {
        memoryResults = memoryResults.filter((r) =>
          recallNamespaces.includes(r.namespace ?? this.deps.namespaceFromPath(r.path)));
      }
      memoryResults = memoryResults.filter((r) => !isGenericRecallExcludedPath(r.path, this.deps.config, "qmd"));

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
                  ...(typeof asOfMs === "number" ? { asOfMs } : {}),
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
      memoryResults = memoryResults.filter((r) => !isGenericRecallExcludedPath(r.path, this.deps.config, "qmd"));

      const qmdBoostInput = await this.deps.filterSearchResultsForRecall(
        memoryResults,
        undefined,
        {
          asOfMs,
          stateViewActive,
          deadlineAtMs: qmdWasSettledBeforeAssemblyWait
            ? null
            : enrichmentAssemblyDeadlineAtMs,
          abortSignal: options.abortSignal,
          dropUnresolved: true,
          recallNamespaces,
          requestingConnector: options.sourceConnector,
        },
      );

      memoryResults = await awaitAssemblyStep(
        "qmd-boost",
        () =>
          this.deps.boostSearchResults(
            qmdBoostInput.results,
            recallNamespaces,
            retrievalQuery,
            qmdBoostInput.memoryByPath,
            { asOfMs, stateViewActive, requestingConnector: options.sourceConnector },
          ),
        qmdBoostInput.results,
      );

      if (caps.rerank && this.deps.config.rerankProvider === "local") {
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

      {
        const trustT0 = Date.now();
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
      //
      const effectiveGateScore =
        preAugmentTopScore > 0
          ? Math.max(preAugmentTopScore, maxSpecializedScore)
          : 0;
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
      const hotQmdPartition =
        options.xrayCapture === true
          ? this.deps.recallRerankCoordinator.diversifyRecallResultsWithHeadroom(
              "memories",
              memoryResults,
              recallResultLimit,
              retrievalQuery,
              caps,
              stateViewPacketActive,
            )
          : null;
      memoryResults = hotQmdPartition
        ? [...hotQmdPartition.appliedResults]
        : this.deps.recallRerankCoordinator.diversifyRecallResultsWithHeadroom(
            "memories",
            memoryResults,
            recallResultLimit,
            retrievalQuery,
            caps,
            stateViewPacketActive,
          ).appliedResults;
      if (resolveRecallEnhancementCapabilities(this.deps.config).memoryReconstruction && memoryResults.length > 0) {
        try {
          const snippets = memoryResults.map((r) => r.snippet);
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
        selectedResultPartition = hotQmdPartition;
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
        stateViewActive,
        asOfMs,
        trustByPath: recallTrustByPath,
        });
        recalledMemoryPaths = memoryResults
          .map((result) => result.path)
          .filter(Boolean);
        xrayRecalledResults = memoryResults;
      } else if (!confidenceGateRejected) {
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
                pathPolicy: this.deps.config,
              },
            );
            const boostedScoped = await this.deps.boostSearchResults(
              scopedCandidates,
              recallNamespaces,
              retrievalQuery,
              undefined,
              { asOfMs, stateViewActive, requestingConnector: options.sourceConnector },
            );
            xrayBranchPoolSize.hot_embedding = Math.max(
              xrayBranchPoolSize.hot_embedding,
              boostedScoped.length,
            );
            return boostedScoped;
          },
          [] as QmdSearchResult[],
        );
        {
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
        const embeddingPartition =
          options.xrayCapture === true
            ? this.deps.recallRerankCoordinator.diversifyRecallResultsWithHeadroom(
                "memories",
                scoped,
                recallResultLimit,
                retrievalQuery,
                caps,
                stateViewPacketActive,
              )
            : null;
        scoped =
          embeddingPartition?.appliedResults ??
          this.deps.recallRerankCoordinator.diversifyRecallResultsWithHeadroom(
            "memories",
            scoped,
            recallResultLimit,
            retrievalQuery,
            caps,
            stateViewPacketActive,
          ).appliedResults;
        if (scoped.length > 0) {
          if (shouldPersistGraphSnapshot) {
            graphSnapshotFinalResults = this.deps.buildGraphRecallRankedResults(
              scoped,
              graphSourceLabelsForPath,
            );
          }
          recallSource = "hot_embedding";
          recalledMemoryCount = scoped.length;
          selectedResultPartition = reconcileRecallResultPartition(embeddingPartition, scoped);
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
          stateViewActive,
          asOfMs,
          trustByPath: recallTrustByPath,
          });
          recalledMemoryPaths = scoped
            .map((result) => result.path)
            .filter(Boolean);
          xrayRecalledResults = scoped;
        } else {
          const coldPartitionSink: RecallResultPartitionSink | undefined =
            options.xrayCapture === true ? { partition: null } : undefined;
          const longTerm = await this.deps.applyColdFallbackPipeline({
            prompt: retrievalQuery,
            stateViewActive,
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
            resultPartitionSink: coldPartitionSink,
            trustByPathSink,
            deadlineAtMs: enrichmentAssemblyDeadlineAtMs,
            asOfMs,
            requestingConnector: options.sourceConnector,
            searchOptions: qmdSearchOptions,
            ...(options.includeLowConfidence === true ? { includeLowConfidence: true } : {}),
          });
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
            selectedResultPartition = coldPartitionSink?.partition ?? null;
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
            stateViewActive,
            asOfMs,
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
                pathPolicy: this.deps.config,
              },
            );
            const boostedScoped = await this.deps.boostSearchResults(
              scopedCandidates,
              recallNamespaces,
              retrievalQuery,
              undefined,
              { asOfMs, stateViewActive, requestingConnector: options.sourceConnector },
            );
            xrayBranchPoolSize.hot_embedding = Math.max(
              xrayBranchPoolSize.hot_embedding,
              boostedScoped.length,
            );
            return boostedScoped;
          },
          [] as QmdSearchResult[],
        );
        // Issue #1577 — trust filter before packet cap (AGENTS.md order).
        // Feature gate is consistent across ALL recall paths (rule 41 parity).
        {
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
        const embeddingPartition =
          options.xrayCapture === true
            ? this.deps.recallRerankCoordinator.diversifyRecallResultsWithHeadroom(
                "memories",
                scoped,
                recallResultLimit,
                retrievalQuery,
                caps,
                stateViewPacketActive,
              )
            : null;
        scoped =
          embeddingPartition?.appliedResults ??
          this.deps.recallRerankCoordinator.diversifyRecallResultsWithHeadroom(
            "memories",
            scoped,
            recallResultLimit,
            retrievalQuery,
            caps,
            stateViewPacketActive,
          ).appliedResults;
      if (scoped.length > 0) {
        if (shouldPersistGraphSnapshot) {
          graphSnapshotFinalResults = this.deps.buildGraphRecallRankedResults(
            scoped,
            graphSourceLabelsForPath,
          );
        }
        recallSource = "hot_embedding";
        recalledMemoryCount = scoped.length;
        selectedResultPartition = reconcileRecallResultPartition(embeddingPartition, scoped);
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
        stateViewActive,
        asOfMs,
        trustByPath: recallTrustByPath,
        });
        recalledMemoryPaths = scoped
          .map((result) => result.path)
          .filter(Boolean);
        xrayRecalledResults = scoped;
      } else {
        const memories = await awaitAssemblyStep(
          "recent-memory-read",
          (stepSignal) =>
            this.deps.readAllMemoriesForNamespaces(recallNamespaces, {
              abortSignal: stepSignal,
            }),
          [] as MemoryFile[],
        );
        if (memories.length > 0) {
          const activeMemories = filterRecentScanMemories(memories, {
            stateViewActive, asOfMs,
            namespaceOf: (p) => this.deps.namespaceFromPath(p),
            isExcluded: (p) => isGenericRecallExcludedPath(p, this.deps.config),
            supersessionOptions: {
              enabled: lifecycleCaps.temporalSupersession,
              includeInRecall: this.deps.config.temporalSupersessionIncludeInRecall,
            },
          });
          const queryAwareScopedMemories = queryAwarePrefilter.candidatePaths
            ? activeMemories.filter((memory) =>
                queryAwarePrefilter.candidatePaths?.has(memory.path),
              )
            : activeMemories;
          if (
            queryAwarePrefilter.candidatePaths &&
            queryAwareScopedMemories.length === 0
          ) {
            const coldPartitionSink: RecallResultPartitionSink | undefined =
              options.xrayCapture === true ? { partition: null } : undefined;
            const longTerm = await this.deps.applyColdFallbackPipeline({
              prompt: retrievalQuery,
              stateViewActive,
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
              resultPartitionSink: coldPartitionSink,
              trustByPathSink,
              deadlineAtMs: enrichmentAssemblyDeadlineAtMs,
              asOfMs,
              requestingConnector: options.sourceConnector,
              searchOptions: qmdSearchOptions,
              ...(options.includeLowConfidence === true ? { includeLowConfidence: true } : {}),
            });
            recallTrustByPath = trustByPathSink.trustByPath;
            if (longTerm.length > 0) {
              recallSource = "cold_fallback";
              recalledMemoryCount = longTerm.length;
              selectedResultPartition = coldPartitionSink?.partition ?? null;
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
              stateViewActive,
              asOfMs,
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
                    origin: m.frontmatter.origin,
                  }),
                );
                const boostedRecent = (
                  await this.deps.boostSearchResults(
                    recentAsResults,
                    recallNamespaces,
                    retrievalQuery,
                    preloadedMap,
                    { asOfMs, stateViewActive, requestingConnector: options.sourceConnector },
                  )
                ).sort((a, b) => b.score - a.score);
                xrayBranchPoolSize.recent_scan = Math.max(
                  xrayBranchPoolSize.recent_scan,
                  boostedRecent.length,
                );
                return boostedRecent;
              },
              [] as QmdSearchResult[],
            );
            // Issue #1577 — trust filter before packet cap (AGENTS.md order).
            {
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
            const recentPartition =
              options.xrayCapture === true
                ? this.deps.recallRerankCoordinator.diversifyRecallResultsWithHeadroom(
                    "memories",
                    recent,
                    recallResultLimit,
                    retrievalQuery,
                    caps,
                    stateViewPacketActive,
                  )
                : null;
            recent =
              recentPartition?.appliedResults ??
              this.deps.recallRerankCoordinator.diversifyRecallResultsWithHeadroom(
                "memories",
                recent,
                recallResultLimit,
                retrievalQuery,
                caps,
                stateViewPacketActive,
              ).appliedResults;
            if (recent.length > 0) {
              if (shouldPersistGraphSnapshot) {
                graphSnapshotFinalResults = this.deps.buildGraphRecallRankedResults(
                  recent,
                  graphSourceLabelsForPath,
                );
              }
              recallSource = "recent_scan";
              recalledMemoryCount = recent.length;
              selectedResultPartition = reconcileRecallResultPartition(recentPartition, recent);
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
              stateViewActive,
              asOfMs,
              trustByPath: recallTrustByPath,
              });
              recalledMemoryPaths = recent
                .map((result) => result.path)
                .filter(Boolean);
              xrayRecalledResults = recent;
            } else {
              const coldPartitionSink: RecallResultPartitionSink | undefined =
                options.xrayCapture === true ? { partition: null } : undefined;
              const longTerm = await this.deps.applyColdFallbackPipeline({
                prompt: retrievalQuery,
                stateViewActive,
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
                resultPartitionSink: coldPartitionSink,
                trustByPathSink,
                deadlineAtMs: enrichmentAssemblyDeadlineAtMs,
                asOfMs,
                requestingConnector: options.sourceConnector,
                searchOptions: qmdSearchOptions,
                ...(options.includeLowConfidence === true ? { includeLowConfidence: true } : {}),
              });
              // #1577: cold trust map back.
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
                selectedResultPartition = coldPartitionSink?.partition ?? null;
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
                stateViewActive,
                asOfMs,
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
          const coldPartitionSink: RecallResultPartitionSink | undefined =
            options.xrayCapture === true ? { partition: null } : undefined;
          const longTerm = await this.deps.applyColdFallbackPipeline({
            prompt: retrievalQuery,
            stateViewActive,
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
            resultPartitionSink: coldPartitionSink,
            trustByPathSink,
            deadlineAtMs: enrichmentAssemblyDeadlineAtMs,
            asOfMs,
            requestingConnector: options.sourceConnector,
            searchOptions: qmdSearchOptions,
            ...(options.includeLowConfidence === true ? { includeLowConfidence: true } : {}),
          });
          // #1577: cold trust map back.
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
            selectedResultPartition = coldPartitionSink?.partition ?? null;
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
            stateViewActive,
            asOfMs,
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

    const harmonicRetrievalSection = await phase2Timer.enrichment(
      "Harmonic",
      harmonicStartedMs,
      () => timings.harmonicRetrieval?.startsWith("skip") === true,
      (onStatus) => awaitEnrichmentSection("harmonic", harmonicRetrievalPromise, onStatus, harmonicRetrievalAbort),
    );
    if (harmonicRetrievalSection) {
      this.deps.appendRecallSection(
        sectionBuckets,
        "harmonic-retrieval",
        harmonicRetrievalSection,
      );
    }
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
      const persistedGraphSnapshotStatus = graphSnapshotStatus;
      await phase2Timer.step("GraphSnapshot", () => this.deps.recordLastGraphRecallSnapshot({
        storage: profileStorage,
        prompt: retrievalQuery,
        recallMode,
        recallNamespaces,
        seedPaths: graphSnapshotSeedPaths,
        expandedPaths: graphSnapshotExpandedPaths,
        status: persistedGraphSnapshotStatus,
        reason: graphSnapshotReason,
        shadowMode: graphDecisionShadowMode,
        queryIntent,
        seedResults: graphSnapshotSeedResults,
        finalResults: graphSnapshotFinalResults,
        shadowComparison: graphSnapshotShadowComparison,
      }));
    } else {
      phase2Timer.skipped("GraphSnapshot");
    }
    await phase2Timer.step("IntentSnapshot", () => this.deps.recordLastIntentSnapshot({
      storage: profileStorage,
      snapshot: buildIntentDebugSnapshot(),
    }));
    const compressionEnabled = this.deps.isRecallSectionEnabled(
      "compression-guidelines",
      resolveCompressionCapabilities(this.deps.config).compressionGuidelineLearning === true,
    );
    if (compressionEnabled) {
      const compressionGuidelineSection = await phase2Timer.step(
        "Compression",
        () => this.deps.buildCompressionGuidelineRecallSection(),
      );
      if (compressionGuidelineSection) {
        this.deps.appendRecallSection(
          sectionBuckets,
          "compression-guidelines",
          compressionGuidelineSection,
        );
      }
    } else {
      phase2Timer.skipped("Compression");
    }
    if (transcriptSection) {
      this.deps.appendRecallSection(sectionBuckets, "transcript", transcriptSection);
    }
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
    const compoundingSection = await phase2Timer.enrichment(
      "Compounding",
      compoundingStartedMs,
      () => timings.compounding?.startsWith("skip") === true,
      (onStatus) => awaitEnrichmentSection("compounding", compoundingPromise, onStatus),
    );
    if (compoundingSection) {
      this.deps.appendRecallSection(
        sectionBuckets,
        "compounding",
        compoundingSection,
      );
    }
    let curiosityFooter: string | undefined, curiosityQuestionSelected = false, curiosityFooterTruncated = false;
    const questionsEnabled = this.deps.config.injectQuestions &&
      this.deps.isRecallSectionEnabled("questions", true);
    const topQuestion = questionsEnabled
      ? selectCuriosityQuestion(
          await phase2Timer.step("Questions", () => profileStorage.readQuestions({ unresolvedOnly: true })),
        )
      : undefined;
    if (!questionsEnabled) phase2Timer.skipped("Questions");
    if (topQuestion) {
      curiosityQuestionSelected = true;
      const formattedFooter = formatCuriosityFooter(topQuestion);
      const questionMaxChars = this.deps.getRecallSectionMaxChars("questions");
      if (questionMaxChars !== 0) {
        curiosityFooter = typeof questionMaxChars === "number"
          ? this.deps.truncateRecallSectionToBudget(formattedFooter, questionMaxChars)
          : formattedFooter;
        curiosityFooterTruncated = curiosityFooter.length < formattedFooter.length;
      }
    }
    const phase2QuestionsDoneMs = Date.now() - recallStart;
    const finalizedQueryAwarePrefilter = await phase2Timer.enrichment(
      "Prefilter",
      prefilterStartedMs,
      () => timings.queryAware?.startsWith("skip") === true,
      () => queryAwarePrefilterPromise,
    );
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
    timings.total = `${Date.now() - recallStart}ms`;
    this.deps.profiler.endSpan("assembly", profileTraceId);
    log.info(
      `recall phase-2 checkpoints: afterQmd=${phase2AfterQmdMs}ms, afterQuestions=${phase2QuestionsDoneMs}ms, afterQap=${phase2QapDoneMs}ms`,
    );
    const timingParts = Object.entries(timings)
      .map(([k, v]) => `${k}=${v}`)
      .join(", ");
    log.info(`recall timings: ${timingParts}`);
    emitRecallTiming(this.deps.config, {
      ...timings,
      ...phase2Timings,
      timestamp: new Date().toISOString(),
      namespace: selfNamespace,
      total: timings.total,
      recallPlan: timings.recallPlan,
      queryPolicy: timings.queryPolicy,
    });
    const episodicNamespaceByPath = new Map<string, string | undefined>();
    for (const result of xrayRecalledResults) {
      if (result.path) episodicNamespaceByPath.set(result.path, result.namespace);
    }
    const episodicMemoryNamespaces = recalledMemoryPaths.map((memoryPath) =>
      episodicNamespaceByPath.get(memoryPath),
    );
    try {
      await appendEpisodicContextSection(this.deps, {
        sectionBuckets, recalledMemoryPaths,
        recalledMemoryNamespaces: episodicMemoryNamespaces,
        scopePlan, namespacesEnabled,
        enrichmentSectionDeadlineMs, outerDeadlineAtMs,
        recordMetric: recordRecallSectionMetric, abortSignal: options.abortSignal,
      });
    } catch (err) {
      log.debug("episodic-context: section degraded after error", err);
    }
    const recallBudgetChars = this.deps.getRecallBudgetChars(options.budgetCharsOverride);
    const assembledRecall = this.deps.assembleRecallSections(
      sectionBuckets, contextBudgetForFooter(recallBudgetChars, curiosityFooter),
    );
    if (procedureRecallSection !== null && assembledRecall.includedIds.includes("procedure-recall")) {
      assembledRecall.includedMemories = mergeProcedureInjections(assembledRecall.includedMemories, procedureInjectedMemories);
    }
    recalledMemoryIds = assembledRecall.includedMemories.map((memory) => memory.id);
    recalledMemoryPaths = assembledRecall.includedMemories.map((memory) => memory.path);
    recalledMemoryNamespaces = assembledRecall.includedMemories.map((memory) => memory.namespace);
    recalledMemoryCount = assembledRecall.includedMemories.length;
    this.deps.trackMemoryAccess(
      recalledMemoryIds,
      recalledMemoryPaths,
      recalledMemoryNamespaces,
    );
    const recalledContext = assembledRecall.sections.join("\n\n---\n\n");
    const { composition, context, truncated: compositionTruncated } =
      decideRecallContextComposition({
        context: recalledContext,
        compactContext: compactRecallContextFromBuckets(sectionBuckets),
        footer: curiosityFooter,
        maxChars: recallBudgetChars,
        backendDegradations,
        qmdExpected: this.deps.config.searchBackend !== "noop" && (this.deps.config.searchBackend !== "qmd" || resolveQmdCapabilities(this.deps.config).qmd),
      });
    if (options.degradationSink) {
      for (const d of backendDegradations) options.degradationSink.push(d);
    }
    notifyContextComposition(options.onContextComposition, composition, (err) => {
      log.warn("recall: context composition observer failed open", err);
    });
    const includedSections = [...assembledRecall.includedIds];
    const omittedSections = [...assembledRecall.omittedIds];
    if (composition.footer && !includedSections.includes("questions")) includedSections.push("questions");
    else if (!composition.footer && curiosityQuestionSelected && !omittedSections.includes("questions"))
      omittedSections.push("questions");
    const sourcesUsed = this.deps.collectLastRecallSources(sectionBuckets, recallSource);
    if (composition.footer && !sourcesUsed.includes("questions")) sourcesUsed.push("questions");
    const budgetsApplied = this.deps.buildLastRecallBudgetSummary({
      requestedTopK,
      recallResultLimit,
      qmdFetchLimit,
      qmdHybridFetchLimit,
      finalContextChars: context.length,
      truncated: assembledRecall.truncated || compositionTruncated || curiosityFooterTruncated,
      includedSections,
      omittedSections,
      omittedMemoryIds: assembledRecall.omittedMemoryIds,
    });
    //
    // Skip capture when the caller has already aborted this recall —
    // otherwise a canceled call could clobber a prior successful
    // (issue #570 PR 1 review follow-up).
    if (
      options.xrayCapture === true &&
      !options.abortSignal?.aborted
    ) {
      try {
        const servedBy = mapRecallSourceToXrayServedBy(recallSource);
        const toPartitionXrayResult = (
          candidate: QmdSearchResult,
        ): RecallXrayResult => {
          const scoreDecomposition: RecallXrayScoreDecomposition = {
            final: candidate.score,
          };
          if (
            candidate.explain?.reinforcementBoost !== undefined &&
            candidate.explain.reinforcementBoost > 0
          ) {
            scoreDecomposition.reinforcementBoost =
              candidate.explain.reinforcementBoost;
          }
          return {
            memoryId: candidate.docid,
            path: candidate.path,
            servedBy,
            scoreDecomposition,
            admittedBy: [],
          };
        };
        const appliedResults =
          selectedResultPartition?.appliedResults.map(toPartitionXrayResult) ?? [];
        const headroomResults =
          selectedResultPartition?.headroomResults.map(toPartitionXrayResult) ?? [];
        const idFromPath = (p: string): string | null => {
          const match = p.match(/([^/\\]+)\.md$/);
          return match ? match[1] ?? null : null;
        };
        const xrayResultByPath = indexStateViewAnnotatedResults(
          xrayRecalledResults, retrievalQuery, this.deps.config, stateViewActive, asOfMs,
        );
        const results: RecallXrayResult[] = [];
        for (let xrayIdx = 0; xrayIdx < recalledMemoryPaths.length; xrayIdx += 1) {
          const recalledPath = recalledMemoryPaths[xrayIdx]!;
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
            ...(xrayResult?.stateLabel ? { stateView: xrayResult.stateLabel } : {}),
            ...(xrayResult?.pathNodeIds ? { pathNodeIds: xrayResult.pathNodeIds } : {}),
            ...(typeof xrayResult?.pathPenaltyApplied === "boolean"
              ? { pathPenaltyApplied: xrayResult.pathPenaltyApplied }
              : {}),
            ...(provenance ? { provenance } : {}),
            ...(sourceSpan ? { sourceSpan } : {}),
            ...(trustItem ? { trust: projectTrustForXray(trustItem) } : {}),
          });
        }
        if (recallTrustByPath) {
          for (const qItem of recallTrustByPath.values()) {
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
            const _exhaustive: never = recallSource;
            void _exhaustive;
            xrayConsidered = recalledMemoryCount;
          }
        }
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
          appliedResultLimit: recallResultLimit,
          appliedResults,
          headroomResults,
          filters,
          budget: {
            chars: this.deps.getRecallBudgetChars(options.budgetCharsOverride),
            used: context.length,
          },
          ...(composition.degradation
            ? { degradation: composition.degradation }
            : {}),
          sessionKey,
          namespace: selfNamespace,
          traceId,
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
          query: prompt,
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
          timings: { ...timings },
          includedMemories: assembledRecall.includedMemories,
          policyVersion,
          appendImpression:
            recalledMemoryIds.length > 0 ||
            this.deps.config.recordEmptyRecallImpressions,
          identityInjection: {
            mode: identityInjectionModeUsed,
            injectedChars: identityInjectedChars,
            truncated: identityInjectionTruncated,
          },
          backendDegradations:
            backendDegradations.length > 0 ? backendDegradations : undefined,
        }),
        "last recall record",
      );
      if (shouldRecordRecallAuthorityHistory(this.deps.config) && recalledMemoryIds.length > 0) {
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
