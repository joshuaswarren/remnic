import { log } from "./logger.js";
import path from "node:path";
import os from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdir,
  readdir,
  readFile,
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
  SearchExecutionOptions,
  SearchQueryOptions,
} from "./search/port.js";
import {
  createSearchBackend,
  createConversationIndexRuntime,
} from "./search/factory.js";
import { NoopSearchBackend } from "./search/noop-backend.js";
import {
  compareEntityTimestamps,
  StorageManager,
  ContentHashIndex,
  fingerprintEntityStructuredFacts,
  normalizeEntityName,
  normalizeAttributePairs,
  parseEntityFile,
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
} from "./fallback-llm.js";
import {
  ensureDaySummaryCron,
  ensureNightlyGovernanceCron,
  ensureProceduralMiningCron,
  ensureContradictionScanCron,
  ensurePatternReinforcementCron,
  ensureGraphEdgeDecayCron,
  graphEdgeDecayCadenceToCronExpr,
} from "./maintenance/memory-governance-cron.js";
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
import {
  applyMemoryWorthFilter,
  buildMemoryWorthCounterMap,
  type MemoryWorthCounters,
} from "./memory-worth-filter.js";
import { reorderRecallResultsWithMmr } from "./recall-mmr.js";
import { applyReasoningTraceBoost } from "./reasoning-trace-recall.js";
import { buildRetrievedMemoryProvenance } from "./memory-provenance.js";
import {
  applyTemporalSupersession,
  normalizeSupersessionKey,
  shouldFilterSupersededFromRecall,
} from "./temporal-supersession.js";
import { isValidAsOf } from "./temporal-validity.js";
import { RelevanceStore } from "./relevance.js";
import { NegativeExampleStore } from "./negative.js";
import {
  LastRecallStore,
  type LastRecallBudgetSummary,
  TierMigrationStatusStore,
  clampGraphRecallExpandedEntries,
  type GraphRecallExpandedEntry,
  type LastRecallSnapshot,
  type TierMigrationCycleSummary,
  type TierMigrationStatusSnapshot,
} from "./recall-state.js";
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
  isAbortError,
  throwIfAborted as sharedThrowIfAborted,
} from "./abort-error.js";
import { CODEX_THREAD_KEY_PREFIX } from "./codex-thread-key.js";
import { isDisagreementPrompt } from "./signal.js";
import { lintWorkspaceFiles, rotateMarkdownFileToArchive } from "./hygiene.js";
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
  computeCompressionGuidelineCandidate,
  refineCompressionGuidelineCandidateSemantically,
  renderCompressionGuidelinesMarkdown,
} from "./compression-optimizer.js";
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
import { DEFAULT_TAXONOMY } from "./taxonomy/index.js";
import {
  searchHarmonicRetrieval,
  type HarmonicRetrievalResult,
} from "./harmonic-retrieval.js";
import {
  searchVerifiedEpisodes,
  type VerifiedEpisodeResult,
} from "./verified-recall.js";
import {
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
import {
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
import { chunkTranscriptEntries } from "./conversation-index/chunker.js";
import { writeConversationChunks } from "./conversation-index/indexer.js";
import { cleanupConversationChunks } from "./conversation-index/cleanup.js";
import {
  type ConversationIndexBackend,
  type ConversationIndexBackendInspection,
  type ConversationQmdRuntime,
} from "./conversation-index/backend.js";
import { NamespaceStorageRouter } from "./namespaces/storage.js";
import {
  canReadNamespace,
  defaultNamespaceForPrincipal,
  recallNamespacesForPrincipal,
  resolvePrincipal,
} from "./namespaces/principal.js";
import {
  combineNamespaces,
  resolveCodingNamespaceOverlay,
} from "./coding/coding-namespace.js";
import type { CodingContext } from "./types.js";
import { NamespaceSearchRouter } from "./namespaces/search.js";
import { SharedContextManager } from "./shared-context/manager.js";
import {
  CompoundingEngine,
  defaultTierMigrationCycleBudget,
} from "./compounding/engine.js";
import { parseFlexibleIsoTimestamp } from "./utils/iso-timestamp.js";
// IRC preference consolidation — used by eval adapter directly;
// orchestrator integration planned for future PR.
// import { consolidatePreferences, buildQueryAwarePreferenceSection, synthesizePreferencesFromLcm } from "./compounding/preference-consolidator.js";
import { TierMigrationExecutor } from "./tier-migration.js";
import { decideTierTransition, type MemoryTier } from "./tier-routing.js";
import {
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
import { keyring, secureStoreDir } from "./secure-store/index.js";
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
  EntityStructuredSection,
  EntityTimelineEntry,
} from "./types.js";

export function dedupeEntitySynthesisEvidenceEntries(
  entries: EntityTimelineEntry[],
): EntityTimelineEntry[] {
  const dedupedEvidenceEntries: EntityTimelineEntry[] = [];
  const evidenceByFact = new Map<string, {
    newest: EntityTimelineEntry;
    oldest: EntityTimelineEntry;
  }>();

  for (const entry of entries) {
    const normalizedFact = entry.text.trim();
    if (!normalizedFact) continue;
    const existing = evidenceByFact.get(normalizedFact);
    if (!existing) {
      evidenceByFact.set(normalizedFact, { newest: entry, oldest: entry });
      continue;
    }
    if (compareEntityTimestamps(entry.timestamp, existing.newest.timestamp) > 0) {
      existing.newest = entry;
    }
    if (compareEntityTimestamps(entry.timestamp, existing.oldest.timestamp) < 0) {
      existing.oldest = entry;
    }
  }

  for (const { newest, oldest } of evidenceByFact.values()) {
    dedupedEvidenceEntries.push(newest);
    const newestKey = [
      newest.timestamp,
      newest.source ?? "",
      newest.sessionKey ?? "",
      newest.principal ?? "",
      newest.text,
    ].join("\u0000");
    const oldestKey = [
      oldest.timestamp,
      oldest.source ?? "",
      oldest.sessionKey ?? "",
      oldest.principal ?? "",
      oldest.text,
    ].join("\u0000");
    if (oldestKey !== newestKey) {
      dedupedEvidenceEntries.push(oldest);
    }
  }

  return dedupedEvidenceEntries;
}

function flattenStructuredSectionEvidence(
  sections: EntityStructuredSection[] | undefined,
): EntityTimelineEntry[] {
  return (sections ?? []).flatMap((section) =>
    section.facts
      .map((fact) => fact.trim())
      .filter((fact) => fact.length > 0)
      .map((fact) => ({
        timestamp: "",
        text: fact,
        source: `section:${section.title}`,
      })),
  );
}

function fingerprintEntitySynthesisEvidence(entity: {
  timeline: EntityTimelineEntry[];
  structuredSections?: EntityStructuredSection[];
}): string {
  const fingerprint = createHash("sha256");
  const timelineEntries = entity.timeline
    .map((entry) => [
      entry.timestamp,
      entry.source ?? "",
      entry.sessionKey ?? "",
      entry.principal ?? "",
      entry.text,
    ].join("\u0000"))
    .sort();
  const timelineEntrySeparator = String.fromCharCode(1);
  const structuredFactsSeparator = String.fromCharCode(2);
  fingerprint.update(timelineEntries.join(timelineEntrySeparator));
  fingerprint.update(structuredFactsSeparator);
  fingerprint.update(fingerprintEntityStructuredFacts(entity) ?? "");
  return fingerprint.digest("hex");
}

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

export interface GraphRecallRankedResult {
  path: string;
  score: number;
  docid?: string;
  sourceLabels: string[];
}

export interface GraphRecallShadowComparison {
  baselineCount: number;
  graphCount: number;
  overlapCount: number;
  overlapRatio: number;
  averageOverlapDelta: number;
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
function mapRecallSourceToXrayServedBy(
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

type QueryAwarePrefilter = {
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

function throwIfRecallAborted(
  signal?: AbortSignal,
  message = "recall aborted",
): void {
  sharedThrowIfAborted(signal, message);
}

async function raceRecallAbort<T>(
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
const COMPACTION_SIGNAL_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour

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

function latestSourceValidAtFromTurns(turns: readonly BufferTurn[]): string | undefined {
  let latestMs: number | null = null;
  for (const turn of turns) {
    if (turn.extractionContextOnly === true) continue;
    if (typeof turn.sourceValidAt !== "string") continue;
    const parsed = parseFlexibleIsoTimestamp(turn.sourceValidAt.trim());
    if (parsed === null) continue;
    if (latestMs === null || parsed > latestMs) {
      latestMs = parsed;
    }
  }
  return latestMs === null ? undefined : new Date(latestMs).toISOString();
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

function splitTurnsBySourceValidAt(turns: readonly BufferTurn[]): BufferTurn[][] {
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

    slices.push([
      ...sourceValidAtContextTurns(
        turns,
        start,
        end,
        targetValidAtMs,
      ),
      ...turns.slice(start, end).map(asExtractionTargetTurn),
    ]);
    start = end;
  }
  return sortSourceValidAtSlicesChronologically(slices);
}

export function isArtifactMemoryPath(filePath: string): boolean {
  return /(?:^|[\\/])artifacts(?:[\\/]|$)/i.test(filePath);
}

export function deriveTopicsFromExtraction(result: ExtractionResult): string[] {
  const topics = new Set<string>();
  for (const fact of result.facts ?? []) {
    for (const tag of fact.tags ?? []) {
      if (tag && tag.length >= 2) topics.add(tag.toLowerCase());
    }
    if (fact.entityRef) topics.add(fact.entityRef.toLowerCase());
    if (fact.category) topics.add(fact.category);
  }
  for (const entity of (result as any).entities ?? []) {
    if (typeof entity.name === "string" && entity.name.length >= 2) {
      topics.add(entity.name.toLowerCase());
    }
  }
  return [...topics].slice(0, 16);
}

export function buildCompressionGuidelinesMarkdown(
  events: MemoryActionEvent[],
  generatedAtIso: string = new Date().toISOString(),
): string {
  return buildCompressionGuidelinesMarkdownV2(events, generatedAtIso);
}

export function formatCompressionGuidelinesForRecall(
  raw: string,
  maxLines: number = 5,
): string | null {
  if (typeof raw !== "string" || raw.trim().length === 0) return null;
  const sectionMatch = raw.match(
    /## Suggested Guidelines\s*\n([\s\S]*?)(?:\n##\s+|\s*$)/i,
  );
  if (!sectionMatch) return null;

  const lines = sectionMatch[1]
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .slice(0, Math.max(1, Math.floor(maxLines)));
  if (lines.length === 0) return null;

  return lines.join("\n");
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

function applyQueryAwareCandidateFilter(
  candidates: QmdSearchResult[],
  candidatePaths: Set<string> | null,
): QmdSearchResult[] {
  if (!candidatePaths || candidatePaths.size === 0) return candidates;
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

export function resolveRecallModeDecision(options: {
  plannerEnabled: boolean;
  graphRecallEnabled: boolean;
  multiGraphMemoryEnabled: boolean;
  graphExpandedIntentEnabled?: boolean;
  prompt: string;
}): RecallModeDecision {
  let plannedMode: RecallPlanMode = options.plannerEnabled
    ? planRecallMode(options.prompt)
    : "full";
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

export function hasIdentityRecoveryIntent(prompt: string): boolean {
  const text = typeof prompt === "string" ? prompt.toLowerCase() : "";
  if (!text) return false;
  return /\b(identity|continuity|recover(?:y|ing|ed)?|incident|drift|restore|regress(?:ion|ed|ing)?)\b/i.test(
    text,
  );
}

export function resolveEffectiveIdentityInjectionMode(options: {
  configuredMode: IdentityInjectionMode;
  recallMode: RecallPlanMode;
  prompt: string;
}): { mode: IdentityInjectionMode; shouldInject: boolean } {
  if (
    options.configuredMode === "recovery_only" &&
    !hasIdentityRecoveryIntent(options.prompt)
  ) {
    return { mode: "recovery_only", shouldInject: false };
  }
  if (options.recallMode === "minimal" && options.configuredMode === "full") {
    return { mode: "minimal", shouldInject: true };
  }
  return { mode: options.configuredMode, shouldInject: true };
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

export function mergeGraphExpandedResults(
  primary: QmdSearchResult[],
  expanded: QmdSearchResult[],
): QmdSearchResult[] {
  const mergedByPath = new Map<string, QmdSearchResult>();
  for (const item of [...primary, ...expanded]) {
    const prev = mergedByPath.get(item.path);
    if (!prev) {
      mergedByPath.set(item.path, item);
      continue;
    }
    const better = item.score > prev.score ? item : prev;
    const snippet = prev.snippet || item.snippet;
    mergedByPath.set(item.path, { ...better, snippet });
  }
  return Array.from(mergedByPath.values());
}

export function graphPathRelativeToStorage(
  storageDir: string,
  candidatePath: string,
): string | null {
  const absolutePath = path.isAbsolute(candidatePath)
    ? candidatePath
    : path.resolve(storageDir, candidatePath);
  const rel = path.relative(storageDir, absolutePath);
  if (!rel || rel === ".") return null;
  if (rel.startsWith("..")) return null;
  return rel.split(path.sep).join("/");
}

function normalizeGraphActivationScore(score: number): number {
  const bounded = Number.isFinite(score) && score > 0 ? score : 0;
  return bounded / (1 + bounded);
}

export function blendGraphExpandedRecallScore(options: {
  graphActivationScore: number;
  seedRecallScore: number;
  activationWeight: number;
  blendMin: number;
  blendMax: number;
}): number {
  const graphNorm = normalizeGraphActivationScore(options.graphActivationScore);
  const seedScore = Number.isFinite(options.seedRecallScore)
    ? Math.min(1, Math.max(0, options.seedRecallScore))
    : 0;
  const weight = Math.min(1, Math.max(0, options.activationWeight));
  const rawMin = Math.min(1, Math.max(0, options.blendMin));
  const rawMax = Math.min(1, Math.max(0, options.blendMax));
  const minBound = Math.min(rawMin, rawMax);
  const maxBound = Math.max(rawMin, rawMax);
  const blended = graphNorm * weight + seedScore * (1 - weight);
  return Math.max(minBound, Math.min(maxBound, blended));
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

  return options.threadEpisodeIds
    .filter((id) => id !== options.currentMemoryId)
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
  // write) agree with where the file actually lives. Without this branch,
  // reasoning_trace graph edges point at facts/<date>/, and subsequent
  // graph expansion silently drops those nodes when readMemoryByPath
  // cannot resolve them (issue #564 PR 3 review).
  const subtree =
    options.category === "procedure"
      ? "procedures"
      : options.category === "reasoning_trace"
        ? "reasoning-traces"
        : "facts";
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
  private readonly namespaceSearchRouter: NamespaceSearchRouter;
  qmd: SearchBackend;
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
   * Side-channel: number of facts deferred in the most recent
   * `persistExtraction` call (issue #562, PR 2). The caller reads this after
   * `persistExtraction` returns to decide whether to retain buffer turns for
   * the next extraction pass. Not part of the return signature because many
   * callers already destructure `persistedIds` by position.
   */
  private lastPersistExtractionDeferredCount: number = 0;
  private readonly _fastGatewayLlm: FallbackLlmClient | null;

  get fastGatewayLlm(): FallbackLlmClient | null {
    return this._fastGatewayLlm;
  }
  readonly modelRegistry: ModelRegistry;
  readonly relevance: RelevanceStore;
  readonly negatives: NegativeExampleStore;
  readonly lastRecall: LastRecallStore;
  readonly tierMigrationStatus: TierMigrationStatusStore;
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
   * Short-TTL cache for Memory Worth counter lookups so interactive recall
   * doesn't trigger a full `readAllMemories` scan per query. Keyed by
   * namespace; the filter unions across namespaces at query time. The TTL
   * is intentionally short (seconds, not minutes) because counters are
   * mutated by `recordMemoryOutcome` asynchronously and we'd rather serve
   * a 30-second-stale worth score than a stable-but-wrong one.
   */
  private readonly memoryWorthCounterCache = new Map<
    string,
    { at: number; counters: ReadonlyMap<string, MemoryWorthCounters> }
  >();
  private static readonly MEMORY_WORTH_CACHE_TTL_MS = 30_000;
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

  // Background serial queue for extractions (agent_end optimization)
  // Queue stores promises that resolve when extraction should run
  private extractionQueue: Array<() => Promise<void>> = [];
  private queueProcessing = false;
  private heartbeatObserverChains = new Map<string, Promise<void>>();
  private recentExtractionFingerprints = new Map<string, number>();
  private nonZeroExtractionsSinceConsolidation = 0;
  private lastConsolidationRunAtMs = 0;
  private consolidationInFlight = false;
  private readonly consolidationObservers = new Set<
    (observation: ConsolidationObservation) => Promise<void> | void
  >();
  private qmdMaintenanceTimer: NodeJS.Timeout | null = null;
  private qmdMaintenancePending = false;
  private qmdMaintenanceInFlight = false;
  private lastQmdEmbedAtMs = 0;
  private lastQmdReprobeAtMs = 0;
  private tierMigrationInFlight = false;
  private lastTierMigrationRunAtMs = 0;
  private readonly conversationIndexLastUpdateAtMs = new Map<string, number>();
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
    if (this.qmdMaintenanceTimer) {
      clearTimeout(this.qmdMaintenanceTimer);
      this.qmdMaintenanceTimer = null;
    }
    this.qmdMaintenancePending = false;
    await this.namespaceSearchRouter.dispose();
    await this.disposeSearchBackendIfNeeded();
    if (this.conversationQmd && this.conversationQmd !== this.qmd) {
      await (this.conversationQmd as { dispose?: () => void | Promise<void> }).dispose?.();
    }
  }

  /** Set per-session workspace for the next recall() call (compaction reset). @internal */
  setRecallWorkspaceOverride(sessionKey: string, dir: string): void {
    this._recallWorkspaceOverrides.set(sessionKey, dir);
  }

  /** Remove a per-session workspace selection (cleanup on error or early return). @internal */
  clearRecallWorkspaceOverride(sessionKey: string): void {
    this._recallWorkspaceOverrides.delete(sessionKey);
  }

  resolvePrincipal(sessionKey?: string): string {
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
    if (!this.config.namespacesEnabled) return baseNamespace;
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
    if (!this.config.namespacesEnabled) return null;
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

  private configuredNamespaces(): string[] {
    return Array.from(
      new Set(
        [
          this.config.defaultNamespace,
          this.config.sharedNamespace,
          ...this.config.namespacePolicies.map((policy) => policy.name),
        ]
          .map((value) => value.trim())
          .filter(Boolean),
      ),
    );
  }

  private buildConfiguredQmdSearchOptions(
    queryText: string,
  ): SearchQueryOptions | undefined {
    const intentHint = this.config.qmdIntentHintsEnabled
      ? buildQmdIntentHint(inferIntentFromText(queryText))
      : undefined;
    const explain = this.config.qmdExplainEnabled === true;
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
    const namespaces = this.config.namespacesEnabled
      ? Array.from(
          new Set(
            (options.namespaces?.length
              ? options.namespaces
              : this.configuredNamespaces()
            )
              .map((value) => value.trim())
              .filter(Boolean),
          ),
        )
      : [this.config.defaultNamespace];

    if (!this.config.namespacesEnabled) {
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

  private isSearchAvailableForNamespaceRouting(): boolean {
    if (this.config.namespacesEnabled) return true;
    return this.qmd.isAvailable();
  }

  invalidateLiveContentHashIndex(): void {
    this.contentHashIndex = null;
  }

  constructor(config: PluginConfig) {
    this.config = config;
    this.profiler = new ProfilingCollector({
      enabled: config.profilingEnabled,
      storageDir: config.profilingStorageDir || path.join(config.memoryDir, "profiling"),
      maxTraces: config.profilingMaxTraces,
    });
    this.storageRouter = new NamespaceStorageRouter(config);
    this.namespaceSearchRouter = new NamespaceSearchRouter(
      config,
      this.storageRouter,
    );
    this.storage = new StorageManager(config.memoryDir, config.entitySchemas);
    // Propagate the inline-attribution template so the storage layer can strip
    // citations from legacy facts during the hash-index rebuild path.
    this.storage.citationTemplate = config.inlineSourceAttributionFormat;
    // Wire page-level versioning (issue #371)
    this.storage.setVersioningConfig({
      enabled: config.versioningEnabled,
      maxVersionsPerPage: config.versioningMaxPerPage,
      sidecarDir: config.versioningSidecarDir,
    });
    // Wire at-rest encryption (issue #690 PR 3/4).
    // If secureStoreEnabled, check whether the keyring already holds a key
    // for this memory dir (e.g. operator unlocked before daemon restart).
    if (config.secureStoreEnabled) {
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
    const conversationIndexRuntime = createConversationIndexRuntime(config, {
      getQmd: () => this.conversationQmd,
      getFaiss: () => this.conversationFaiss,
    });
    this.conversationQmd = conversationIndexRuntime.qmd;
    this.conversationFaiss = conversationIndexRuntime.faiss;
    this.conversationIndexBackend = conversationIndexRuntime.backend;
    this.sharedContext = config.sharedContextEnabled
      ? new SharedContextManager(config)
      : undefined;
    this.compounding = config.compoundingEnabled
      ? new CompoundingEngine(config, this.storage)
      : undefined;
    this.buffer = new SmartBuffer(config, this.storage);
    this.transcript = new TranscriptManager(config);
    this.conversationIndexDir = path.join(
      config.memoryDir,
      "conversation-index",
      "chunks",
    );
    this.modelRegistry = new ModelRegistry(config.memoryDir);
    this.relevance = new RelevanceStore(config.memoryDir);
    this.negatives = new NegativeExampleStore(config.memoryDir);
    this.lastRecall = new LastRecallStore(config.memoryDir);
    this.tierMigrationStatus = new TierMigrationStatusStore(config.memoryDir);
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
    this.fastLlm = config.localLlmFastEnabled
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
    this.threading = new ThreadingManager(
      path.join(config.memoryDir, "threads"),
      config.threadingGapMinutes,
    );
    // BoxBuilders are created per-namespace on first use in runExtraction().

    // Temporal Memory Tree (v8.2) — lazy build during consolidation
    this.tmtBuilder = new TmtBuilder(config.memoryDir, {
      temporalMemoryTreeEnabled: config.temporalMemoryTreeEnabled,
      tmtHourlyMinMemories: config.tmtHourlyMinMemories,
      tmtSummaryMaxTokens: config.tmtSummaryMaxTokens,
    });

    // Lossless Context Management (LCM) — proactive session archive + DAG summarization
    if (config.lcmEnabled) {
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
                agentId:
                  this.config.fastGatewayAgentId ||
                  this.config.gatewayAgentId ||
                  undefined,
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
          memoryBoxesEnabled: this.config.memoryBoxesEnabled,
          traceWeaverEnabled: this.config.traceWeaverEnabled,
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
    const allowedNamespaces = this.config.namespacesEnabled
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
    if (!this.config.routingRulesEnabled) return [];
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
      if (this.config.namespacesEnabled) {
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
      }
      await this.relevance.load();
      await this.negatives.load();
      await this.lastRecall.load();
      await this.tierMigrationStatus.load();
      await this.sessionObserver.load();
      this.runtimePolicyValues = await this.policyRuntime.loadRuntimeValues();
      this.utilityRuntimeValues = await loadUtilityRuntimeValues({
        memoryDir: this.config.memoryDir,
        memoryUtilityLearningEnabled: this.config.memoryUtilityLearningEnabled,
        promotionByOutcomeEnabled: this.config.promotionByOutcomeEnabled,
      });

      // Initialize content-hash dedup index
      if (this.config.factDeduplicationEnabled) {
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
      if (this.config.compactionResetEnabled) {
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
          const namespaces = this.config.namespacesEnabled
            ? this.configuredNamespaces()
            : [this.config.defaultNamespace];
          const states = await Promise.all(
            namespaces.map(async (namespace) => ({
              namespace,
              state: this.config.namespacesEnabled
                ? await this.namespaceSearchRouter.ensureNamespaceCollection(
                    namespace,
                  )
                : await this.qmd.ensureCollection(this.config.memoryDir),
            })),
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

    // Sync QMD index with current disk state so recall finds recently-written
    // facts. Without this, the index stays stale from the last extraction-
    // triggered update — which can be days ago if the daemon restarted without
    // new extractions. This is the root cause of "0 memories" recall results
    // despite thousands of facts on disk.
    if (this.qmd.isAvailable() && this.config.qmdMaintenanceEnabled) {
      try {
        log.info("QMD startup sync: updating index to match current disk state");
        if (this.config.namespacesEnabled) {
          await this.namespaceSearchRouter.updateNamespaces(
            this.configuredNamespaces(),
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
    if (this.config.embeddingFallbackEnabled) {
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
    if (this.config.knowledgeIndexEnabled) {
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

    if (this.config.conversationIndexEnabled && this.conversationIndexBackend) {
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

    if (this.config.localLlmEnabled) {
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
    if (this.config.daySummaryEnabled) {
      try {
        await this.autoRegisterDaySummaryCron();
      } catch (err) {
        log.debug(`day-summary cron auto-register failed (non-fatal): ${err}`);
      }
    }
    if (this.config.nightlyGovernanceCronAutoRegister) {
      try {
        await this.autoRegisterNightlyGovernanceCron();
      } catch (err) {
        log.debug(`nightly governance cron auto-register failed (non-fatal): ${err}`);
      }
    }
    if (this.config.procedural?.proceduralMiningCronAutoRegister) {
      try {
        await this.autoRegisterProceduralMiningCron();
      } catch (err) {
        log.debug(`procedural mining cron auto-register failed (non-fatal): ${err}`);
      }
    }

    // Auto-register contradiction scan cron (gated by config)
    if (this.config.contradictionScan?.enabled) {
      try {
        await this.autoRegisterContradictionScanCron();
      } catch (err) {
        log.debug(`contradiction scan cron auto-register failed (non-fatal): ${err}`);
      }
    }

    // Auto-register pattern-reinforcement cron (issue #687 PR 2/4).
    // Gated on the feature flag so memory-only users without the
    // cron daemon installed never see a stray jobs.json mutation.
    if (this.config.patternReinforcementEnabled) {
      try {
        await this.autoRegisterPatternReinforcementCron();
      } catch (err) {
        log.debug(`pattern reinforcement cron auto-register failed (non-fatal): ${err}`);
      }
    }

    // Auto-register graph-edge decay cron (gated by config — issue #681 PR 2/3).
    if (this.config.graphEdgeDecayEnabled) {
      try {
        await this.autoRegisterGraphEdgeDecayCron();
      } catch (err) {
        log.debug(`graph edge decay cron auto-register failed (non-fatal): ${err}`);
      }
    }

    // First-start lifecycle migration (issue #686 retention-completion).
    // When lifecyclePolicyEnabled is true and the memoryDir has never been
    // touched by the lifecycle policy, run a one-time rate-limited demotion
    // sweep (capped at 50 demotions) so the hot tier isn't flooded on the
    // first real cron pass. Non-fatal — a failure here must not break init.
    if (signal.aborted) return;
    if (this.config.lifecyclePolicyEnabled && this.config.qmdTierMigrationEnabled) {
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
    if (this.config.namespacesEnabled) {
      this.namespaceSearchRouter.clearCache();
    }

    // Ensure collections — namespace-aware when enabled
    const namespaces = this.config.namespacesEnabled
      ? this.configuredNamespaces()
      : [this.config.defaultNamespace];

    const states = await Promise.all(
      namespaces.map(async (namespace) => ({
        namespace,
        state: this.config.namespacesEnabled
          ? await this.namespaceSearchRouter.ensureNamespaceCollection(namespace)
          : await this.qmd.ensureCollection(this.config.memoryDir),
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
    if (this.config.qmdMaintenanceEnabled) {
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
        if (this.config.namespacesEnabled) {
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
        if (this.config.namespacesEnabled) {
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
   * Auto-register the engram-day-summary cron job in OpenClaw if it doesn't exist.
   * Fire-and-forget — never blocks init or crashes on failure.
   */
  private async autoRegisterDaySummaryCron(): Promise<void> {
    const home = resolveHomeDir();
    const jobsPath = path.join(home, ".openclaw", "cron", "jobs.json");

    try {
      if (!existsSync(jobsPath)) {
        log.debug(
          "day-summary cron: jobs.json not found, skipping auto-register",
        );
        return;
      }
      const created = await ensureDaySummaryCron(jobsPath, {
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
      if (created.created) {
        log.info(
          `day-summary cron auto-registered (${created.jobId}, 23:47 ${Intl.DateTimeFormat().resolvedOptions().timeZone})`,
        );
      } else {
        log.debug("day-summary cron already exists, skipping auto-register");
      }
    } catch (err) {
      log.debug(`day-summary cron auto-register error: ${err}`);
    }
  }

  private async autoRegisterNightlyGovernanceCron(): Promise<void> {
    const home = resolveHomeDir();
    const jobsPath = path.join(home, ".openclaw", "cron", "jobs.json");

    try {
      if (!existsSync(jobsPath)) {
        log.debug("nightly governance cron: jobs.json not found, skipping auto-register");
        return;
      }

      const created = await ensureNightlyGovernanceCron(jobsPath, {
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
      if (created.created) {
        log.info(
          `nightly governance cron auto-registered (${created.jobId}, 02:23 ${Intl.DateTimeFormat().resolvedOptions().timeZone})`,
        );
      } else {
        log.debug("nightly governance cron already exists, skipping auto-register");
      }
    } catch (err) {
      log.debug(`nightly governance cron auto-register error: ${err}`);
    }
  }

  private async autoRegisterProceduralMiningCron(): Promise<void> {
    const home = resolveHomeDir();
    const jobsPath = path.join(home, ".openclaw", "cron", "jobs.json");
    try {
      if (!existsSync(jobsPath)) {
        log.debug("procedural mining cron: jobs.json not found, skipping auto-register");
        return;
      }
      const created = await ensureProceduralMiningCron(jobsPath, {
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
      if (created.created) {
        log.info(`procedural mining cron auto-registered (${created.jobId})`);
      } else {
        log.debug("procedural mining cron already exists, skipping auto-register");
      }
    } catch (err) {
      log.debug(`procedural mining cron auto-register error: ${err}`);
    }
  }

  private async autoRegisterContradictionScanCron(): Promise<void> {
    const home = resolveHomeDir();
    const jobsPath = path.join(home, ".openclaw", "cron", "jobs.json");
    try {
      if (!existsSync(jobsPath)) {
        log.debug("contradiction scan cron: jobs.json not found, skipping auto-register");
        return;
      }
      const created = await ensureContradictionScanCron(jobsPath, {
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
      if (created.created) {
        log.info(`contradiction scan cron auto-registered (${created.jobId})`);
      } else {
        log.debug("contradiction scan cron already exists, skipping auto-register");
      }
    } catch (err) {
      log.debug(`contradiction scan cron auto-register error: ${err}`);
    }
  }

  private async autoRegisterPatternReinforcementCron(): Promise<void> {
    const home = resolveHomeDir();
    const jobsPath = path.join(home, ".openclaw", "cron", "jobs.json");
    try {
      if (!existsSync(jobsPath)) {
        log.debug("pattern reinforcement cron: jobs.json not found, skipping auto-register");
        return;
      }
      const created = await ensurePatternReinforcementCron(jobsPath, {
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
      if (created.created) {
        log.info(`pattern reinforcement cron auto-registered (${created.jobId})`);
      } else {
        log.debug("pattern reinforcement cron already exists, skipping auto-register");
      }
    } catch (err) {
      log.debug(`pattern reinforcement cron auto-register error: ${err}`);
    }
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
    if (!this.config.patternReinforcementEnabled) {
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

  private async autoRegisterGraphEdgeDecayCron(): Promise<void> {
    const home = resolveHomeDir();
    const jobsPath = path.join(home, ".openclaw", "cron", "jobs.json");
    try {
      if (!existsSync(jobsPath)) {
        log.debug("graph edge decay cron: jobs.json not found, skipping auto-register");
        return;
      }
      const scheduleExpr = graphEdgeDecayCadenceToCronExpr(this.config.graphEdgeDecayCadenceMs);
      const created = await ensureGraphEdgeDecayCron(jobsPath, {
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        scheduleExpr,
      });
      if (created.created) {
        log.info(`graph edge decay cron auto-registered (${created.jobId}, ${scheduleExpr})`);
      } else {
        log.debug("graph edge decay cron already exists, skipping auto-register");
      }
    } catch (err) {
      log.debug(`graph edge decay cron auto-register error: ${err}`);
    }
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
          this.namespaceFromStorageDir(targetStorage.dir),
          5,
        );
      } catch (error) {
        log.debug(`deep-sleep governance: entity synthesis refresh failed after apply: ${error}`);
      }
    }
    return summarizeGovernanceResultForDreams(govResult, options?.dryRun === true);
  }

  private async runSemanticConsolidation(options?: {
    dryRun?: boolean;
    thresholdOverride?: number;
    force?: boolean;
    storage?: StorageManager;
  }): Promise<SemanticConsolidationResult> {
    const targetStorage = options?.storage ?? this.storage;
    const result: SemanticConsolidationResult = {
      clustersFound: 0,
      memoriesConsolidated: 0,
      memoriesArchived: 0,
      errors: 0,
      clusters: [],
    };

    if (!this.config.semanticConsolidationEnabled && !options?.force) {
      log.debug("[semantic-consolidation] disabled in config");
      return result;
    }

    log.info("[semantic-consolidation] starting run");

    const allMemories = await targetStorage.readAllMemories();
    if (allMemories.length < 10) {
      log.debug("[semantic-consolidation] too few memories, skipping");
      return result;
    }

    const threshold =
      options?.thresholdOverride ?? this.config.semanticConsolidationThreshold;
    const clusters = findSimilarClusters(allMemories, {
      threshold,
      minClusterSize: this.config.semanticConsolidationMinClusterSize,
      excludeCategories: this.config.semanticConsolidationExcludeCategories,
      maxPerRun: this.config.semanticConsolidationMaxPerRun,
    });

    result.clustersFound = clusters.length;
    result.clusters = clusters;

    if (clusters.length === 0) {
      log.info("[semantic-consolidation] no clusters found");
      return result;
    }

    log.info(`[semantic-consolidation] found ${clusters.length} cluster(s)`);

    if (options?.dryRun) {
      log.info(
        "[semantic-consolidation] dry run — skipping LLM synthesis and archival",
      );
      return result;
    }

    // Use FallbackLlmClient for LLM calls (same pattern as causal-consolidation.ts)
    // Honor semanticConsolidationModel: "auto" = primary, "fast" = local fast, or specific model
    const { FallbackLlmClient } = await import("./fallback-llm.js");
    const useGateway = this.config.modelSource === "gateway";
    const modelSetting = this.config.semanticConsolidationModel;
    if (modelSetting === "fast" && this.fastLlm && !useGateway) {
      log.info("[semantic-consolidation] using fast local LLM for synthesis");
    }
    const gatewayAgentId = useGateway
      ? (modelSetting === "fast" && this.config.fastGatewayAgentId
          ? this.config.fastGatewayAgentId
          : this.config.gatewayAgentId || undefined)
      : undefined;
    const llm = new FallbackLlmClient(
      this.config.gatewayConfig,
      fallbackLlmRuntimeContextFromConfig(this.config),
    );
    if (!llm.isAvailable(gatewayAgentId) && !(modelSetting === "fast" && this.fastLlm && !useGateway)) {
      log.warn(
        "[semantic-consolidation] no LLM available — skipping synthesis",
      );
      return result;
    }

    // Discover memory extensions once for all clusters (#382)
    let extensionsBlock = "";
    try {
      extensionsBlock = await buildExtensionsBlockForConsolidation(this.config);
    } catch (err) {
      log.warn(`[semantic-consolidation] extension discovery failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    }

    for (const cluster of clusters) {
      try {
        // Operator-aware prompt (issue #561 PR 3): ask the LLM to pick the
        // SPLIT/MERGE/UPDATE operator alongside the canonical output.  Falls
        // back to the legacy plain-blob prompt when operator-aware
        // consolidation is explicitly disabled via config, so rollbacks stay
        // clean.
        // Use the `=== true` idiom for default-false flags (PR #632
        // review, cursor Low): sibling disabled-by-default flags like
        // `semanticConsolidationEnabled` follow the same convention,
        // while `!== false` is reserved for default-on flags.
        const operatorAwareEnabled =
          this.config.operatorAwareConsolidationEnabled === true;
        let prompt = operatorAwareEnabled
          ? buildOperatorAwareConsolidationPrompt(cluster)
          : buildConsolidationPrompt(cluster);
        if (extensionsBlock.length > 0) {
          prompt += "\n\n" + extensionsBlock;
        }
        const messages = [
          {
            role: "system" as const,
            content: operatorAwareEnabled
              ? 'You are a memory consolidation system. Return ONLY a JSON object with two keys, "operator" and "output". The "operator" value MUST be one of the exact strings "merge", "update", or "split" — never a pipe-separated placeholder, never prose. The "output" value is the canonical memory text.'
              : "You are a memory consolidation system. Output only the consolidated memory text.",
          },
          { role: "user" as const, content: prompt },
        ];
        const llmOpts = { temperature: 0.2, maxTokens: 2000 };

        // Route to the configured model
        let response: { content: string } | null = null;
        if (useGateway) {
          // Gateway model source — use the appropriate agent chain
          response = await llm.chatCompletion(messages, { ...llmOpts, agentId: gatewayAgentId });
        } else if (modelSetting === "fast" && this.fastLlm) {
          const fastResult = await this.fastLlm.chatCompletion(messages, {
            operation: "semantic-consolidation",
            maxTokens: llmOpts.maxTokens,
            temperature: llmOpts.temperature,
            priority: "background",
            forceDisableThinking: true,
          });
          response = fastResult ? { content: fastResult.content } : null;
        } else {
          response = await llm.chatCompletion(messages, llmOpts);
        }

        if (!response?.content) {
          log.warn(
            `[semantic-consolidation] empty LLM response for cluster in "${cluster.category}"`,
          );
          result.errors++;
          continue;
        }

        // Operator-aware parse (issue #561 PR 3).  In legacy mode we fall
        // back to the plain-text parser and derive the operator from the
        // cluster-shape heuristic so `derived_via` still lands.
        // Restricted to `SemanticConsolidationLlmOperator`
        // (split/merge/update) — `pattern-reinforcement` joined the
        // wider `ConsolidationOperator` type in #687 PR 2/4 but is
        // reserved for the maintenance job and must never be assignable
        // here (Cursor Bugbot review, PR #730).
        let canonicalContent: string;
        let operator: SemanticConsolidationLlmOperator;
        if (operatorAwareEnabled) {
          const parsed = parseOperatorAwareConsolidationResponse(
            response.content,
            cluster,
          );
          canonicalContent = parsed.output;
          operator = parsed.operator;
        } else {
          canonicalContent = parseConsolidationResponse(response.content);
          operator = chooseConsolidationOperator(cluster);
        }
        cluster.canonicalContent = canonicalContent;

        // Pick the most recent memory's metadata as the basis for lineage
        const sorted = [...cluster.memories].sort(
          (a, b) =>
            new Date(b.frontmatter.created).getTime() -
            new Date(a.frontmatter.created).getTime(),
        );
        const newest = sorted[0];
        const lineageIds = cluster.memories.map((m) => m.frontmatter.id);

        // Consolidation provenance (issue #561 PR 2+3): snapshot each
        // source memory BEFORE archiving it, collecting
        // "<relpath>:<versionId>" pointers for the new canonical memory's
        // `derived_from` frontmatter field.  Snapshots are best-effort — if
        // page-versioning is disabled (default in `config.ts`) or a single
        // source fails to snapshot we simply omit that entry rather than
        // abort the consolidation.  The `derived_via` operator is chosen
        // above (PR 3) from the LLM response or the cluster-shape
        // heuristic fallback and emitted unconditionally so consolidation
        // outputs stay identifiable even when no snapshots are captured
        // (PR #624 review feedback).
        const derivedFromEntries: string[] = [];
        for (const m of cluster.memories) {
          if (!m.path) continue;
          const entry = await targetStorage.snapshotForProvenance(m.path);
          if (entry) derivedFromEntries.push(entry);
        }

        // Write the canonical memory
        const canonicalId = await targetStorage.writeMemory(
          newest.frontmatter.category,
          canonicalContent,
          {
            actor: "semantic-consolidation",
            confidence: newest.frontmatter.confidence,
            tags: [
              ...new Set(
                cluster.memories.flatMap((m) => m.frontmatter.tags ?? []),
              ),
            ],
            source: "semantic-consolidation",
            lineage: lineageIds,
            derivedFrom: derivedFromEntries.length > 0 ? derivedFromEntries : undefined,
            derivedVia: operator,
          },
        );

        result.memoriesConsolidated++;

        // Archive originals
        for (const m of cluster.memories) {
          const archiveResult = await targetStorage.archiveMemory(m, {
            actor: "semantic-consolidation",
            reasonCode: "semantic-consolidation",
            relatedMemoryIds: [canonicalId],
          });
          if (archiveResult) {
            // Remove from content-hash index.
            // Use the raw-content hash stored on the frontmatter at write
            // time (contentHash) — it is format-agnostic and survives any
            // citation template.  Legacy memories without contentHash are
            // skipped (see Finding 2 — Urgw).
            if (this.contentHashIndex) {
              if (m.frontmatter.contentHash) {
                // Modern memory: frontmatter.contentHash is already a SHA-256
                // hex string — use removeByHash to avoid double-hashing.
                this.contentHashIndex.removeByHash(m.frontmatter.contentHash);
              } else {
                // Legacy memory written before contentHash was stored on the
                // frontmatter.  Pre-#369 facts were stored without inline
                // citations, so m.content is the raw fact text and we can
                // remove the hash directly from the content.  This clears
                // stale dedup entries so the fact can be re-extracted.
                log.warn(
                  `[semantic-consolidation] removing hash for legacy memory ${m.frontmatter.id ?? "(unknown)"} via content fallback — no contentHash in frontmatter`,
                );
                this.contentHashIndex.remove(m.content);
              }
            }
            await this.embeddingFallback.removeFromIndex(m.frontmatter.id);
            if (
              this.config.queryAwareIndexingEnabled &&
              m.path &&
              m.frontmatter?.created
            ) {
              deindexMemory(
                targetStorage.dir,
                m.path,
                m.frontmatter.created,
                m.frontmatter.tags ?? [],
              );
            }
            result.memoriesArchived++;
          }
        }

        log.info(
          `[semantic-consolidation] consolidated ${cluster.memories.length} memories → ${canonicalId}`,
        );
      } catch (err) {
        log.warn(
          `[semantic-consolidation] cluster processing failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        result.errors++;
      }
    }

    // Save hash index if we modified it
    if (result.memoriesArchived > 0 && this.contentHashIndex) {
      await this.contentHashIndex
        .save()
        .catch((err) =>
          log.warn(
            `[semantic-consolidation] content-hash index save failed: ${err}`,
          ),
        );
    }

    log.info(
      `[semantic-consolidation] complete: clusters=${result.clustersFound}, consolidated=${result.memoriesConsolidated}, archived=${result.memoriesArchived}, errors=${result.errors}`,
    );

    // #378: fire the Codex materialize post-hook so `codexMaterializeOnConsolidation`
    // actually has a runtime effect. The helper silently no-ops when the
    // feature flag or the per-trigger toggle is off, when the sentinel is
    // missing, or when nothing has changed since the previous run, so it's
    // safe to always call here. Wrapped in a try/catch because a failed
    // materialize must never abort the consolidation result — consolidation
    // is the load-bearing operation; materialization is an optional mirror.
    try {
      await materializeAfterSemanticConsolidation({
        config: this.config,
        memoryDir: targetStorage.dir,
      });
    } catch (err) {
      log.warn(
        `[semantic-consolidation] Codex materialize post-hook failed (non-fatal): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    // Issue #679 PR 2/5 — async peer profile reasoner runs as part of
    // the REM phase, immediately after semantic consolidation. Gated
    // on `peerProfileReasonerEnabled` (default false, opt-in). Wrapped
    // in a try/catch because reasoner I/O (LLM call, peer-profile
    // writes) must never abort the consolidation result. The reasoner
    // itself also defends against partial failure — see profile-reasoner.ts.
    if (this.config.peerProfileReasonerEnabled) {
      try {
        const { runPeerProfileReasoner } = await import("./peers/index.js");
        const llm = new FallbackLlmClient(
          this.config.gatewayConfig,
          fallbackLlmRuntimeContextFromConfig(this.config),
        );
        const peerResult = await runPeerProfileReasoner({
          memoryDir: targetStorage.dir,
          enabled: true,
          llm,
          model: this.config.peerProfileReasonerModel,
          minInteractions: this.config.peerProfileReasonerMinInteractions,
          maxFieldsPerRun: this.config.peerProfileReasonerMaxFieldsPerRun,
          log: {
            debug: (msg) => log.debug(msg),
            info: (msg) => log.info(msg),
            warn: (msg) => log.warn(msg),
          },
        });
        log.info(
          `[peer-profile-reasoner] complete: peers=${peerResult.peersConsidered}, processed=${peerResult.peersProcessed}, fields=${peerResult.fieldsApplied}`,
        );
      } catch (err) {
        log.warn(
          `[peer-profile-reasoner] post-consolidation hook failed (non-fatal): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    return result;
  }

  async waitForExtractionIdle(timeoutMs: number = 60_000): Promise<boolean> {
    const started = Date.now();
    while (this.queueProcessing || this.extractionQueue.length > 0) {
      if (Date.now() - started > timeoutMs) {
        log.warn(`waitForExtractionIdle timed out after ${timeoutMs}ms`);
        return false;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return true;
  }

  async waitForConsolidationIdle(timeoutMs: number = 60_000): Promise<boolean> {
    const started = Date.now();
    while (this.consolidationInFlight) {
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
    if (
      !this.config.entitySummaryEnabled
      || maxEntities <= 0
      || this.config.entitySynthesisMaxTokens <= 0
    ) return 0;
    const storage = await this.getStorage(namespace);
    const queued = await storage.refreshEntitySynthesisQueue();
    let processed = 0;
    let attempted = 0;

    for (const entityName of queued) {
      if (attempted >= maxEntities) break;
      attempted += 1;
      try {
        const raw = await storage.readEntity(entityName);
        if (!raw) continue;
        const entity = parseEntityFile(raw, this.config.entitySchemas);
        const previousSynthesis = entity.synthesis || entity.summary || "";
        const sortedTimelineEntries = entity.timeline
          .slice()
          .sort((left, right) => compareEntityTimestamps(right.timestamp, left.timestamp));
        const newerTimelineEntries = sortedTimelineEntries.filter(
          (entry) =>
            !entity.synthesisUpdatedAt
            || compareEntityTimestamps(entry.timestamp, entity.synthesisUpdatedAt) > 0,
        );
        const appendedTimelineEntries = entity.synthesisTimelineCount === undefined
          ? []
          : entity.timeline.slice(Math.max(0, entity.synthesisTimelineCount));
        const structuredEvidenceEntries = flattenStructuredSectionEvidence(entity.structuredSections);
        const structuredEvidenceCount = structuredEvidenceEntries.length;
        const structuredEvidenceDigest = fingerprintEntityStructuredFacts(entity);
        const structuredEvidenceDrifted = structuredEvidenceDigest !== (entity.synthesisStructuredFactDigest?.trim() || undefined);
        const appendedStructuredEvidenceEntries = entity.synthesisStructuredFactCount === undefined
          || structuredEvidenceDrifted
          ? structuredEvidenceEntries
          : structuredEvidenceEntries.slice(Math.max(0, entity.synthesisStructuredFactCount));
        const candidateEvidenceEntries = [
          ...newerTimelineEntries,
          ...appendedTimelineEntries,
          ...appendedStructuredEvidenceEntries,
        ]
          .slice()
          .sort((left, right) => compareEntityTimestamps(right.timestamp, left.timestamp));
        const dedupedEvidenceEntries = dedupeEntitySynthesisEvidenceEntries(
          candidateEvidenceEntries.length > 0
            ? candidateEvidenceEntries
            : [...sortedTimelineEntries, ...structuredEvidenceEntries],
        );
        const chronologicalEvidenceEntries = dedupedEvidenceEntries
          .slice()
          .sort((left, right) => compareEntityTimestamps(left.timestamp, right.timestamp));
        if (chronologicalEvidenceEntries.length === 0) continue;
        const latestEvidenceTimestamp = chronologicalEvidenceEntries
          .slice()
          .reverse()
          .map((entry) => entry.timestamp?.trim() || undefined)
          .find((timestamp) => Boolean(timestamp));
        const previousSynthesisUpdatedAt = entity.synthesisUpdatedAt?.trim() || undefined;
        const nextSynthesisUpdatedAt = compareEntityTimestamps(
          latestEvidenceTimestamp,
          previousSynthesisUpdatedAt,
        ) >= 0
          ? latestEvidenceTimestamp
          : previousSynthesisUpdatedAt;
        const evidenceBatches: typeof chronologicalEvidenceEntries[] = [];
        for (let index = 0; index < chronologicalEvidenceEntries.length; index += 8) {
          evidenceBatches.push(chronologicalEvidenceEntries.slice(index, index + 8));
        }

        let nextSynthesis = previousSynthesis;
        let batchFailed = false;
        for (const evidenceEntries of evidenceBatches) {
          const evidenceText = evidenceEntries
            .map((entry) => {
              const sectionTitle = entry.source?.startsWith("section:")
                ? entry.source.slice("section:".length)
                : "";
              const metadata = [
                `timestamp=${entry.timestamp}`,
                sectionTitle ? `section=${sectionTitle}` : entry.source ? `source=${entry.source}` : "",
                entry.sessionKey ? `session=${entry.sessionKey}` : "",
                entry.principal ? `principal=${entry.principal}` : "",
              ]
                .filter(Boolean)
                .join(", ");
              return `- ${metadata}: ${entry.text}`;
            })
            .join("\n");
          const response = await this.fastChatCompletion(
            [
              {
                role: "system",
                content:
                  "Rewrite the entity synthesis as compact current truth. Preserve uncertainty when evidence conflicts. Return plain text only.",
              },
              {
                role: "user",
                content: [
                  `Entity: ${entity.name} (${entity.type})`,
                  nextSynthesis ? `Previous synthesis:\n${nextSynthesis}` : "Previous synthesis: none",
                  `New evidence:\n${evidenceText}`,
                ].join("\n\n"),
              },
            ],
            {
              temperature: 0.2,
              maxTokens: this.config.entitySynthesisMaxTokens,
              operation: "entity_summary",
              priority: "background",
            },
          );
          const synthesis = response?.content?.trim().replace(/^["']|["']$/g, "");
          const maxSynthesisChars = Math.max(2_000, this.config.entitySynthesisMaxTokens * 8);
          if (!synthesis || synthesis.length < 10 || synthesis.length > maxSynthesisChars) {
            batchFailed = true;
            break;
          }
          nextSynthesis = synthesis;
        }
        if (batchFailed || nextSynthesis.length === 0) continue;
        const latestRaw = await storage.readEntity(entityName);
        if (!latestRaw) continue;
        const latestEntity = parseEntityFile(latestRaw, this.config.entitySchemas);
        if (
          fingerprintEntitySynthesisEvidence(latestEntity)
          !== fingerprintEntitySynthesisEvidence(entity)
        ) {
          continue;
        }
        await storage.updateEntitySynthesis(entityName, nextSynthesis, {
          entityUpdatedAt: new Date().toISOString(),
          synthesisStructuredFactDigest: structuredEvidenceDigest,
          synthesisStructuredFactCount: structuredEvidenceCount,
          synthesisTimelineCount: entity.timeline.length,
          updatedAt: nextSynthesisUpdatedAt,
        });
        processed += 1;
      } catch (err) {
        log.debug(`entity synthesis refresh failed for ${entityName}: ${err}`);
      }
    }

    return processed;
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
  ): Promise<DaySummaryResult | null> {
    const gathered = await this.gatherTodayFacts(namespace);
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
  async gatherTodayFacts(namespace?: string): Promise<string> {
    const ns =
      namespace && namespace.length > 0
        ? namespace
        : this.config.defaultNamespace;
    const storage = await this.storageRouter.storageFor(ns);
    // Facts are stored under UTC dates, but a local calendar day can span
    // two UTC dates (e.g. 23:47 local in UTC-6 is 05:47 UTC the next day). To capture
    // all facts for the local day, read from both the current UTC date and
    // yesterday's UTC date (which covers the local day's morning hours).
    const now = new Date();
    const utcToday = now.toISOString().slice(0, 10);
    const yesterday = new Date(now.getTime() - 86_400_000)
      .toISOString()
      .slice(0, 10);
    const datesToScan = [yesterday, utcToday].filter(
      (v, i, a) => a.indexOf(v) === i,
    );
    const factsBaseDir = path.join(storage.dir, "facts");
    const MAX_CHARS = 100_000;

    // --- Read fact files from each date directory ---
    const facts: MemoryFile[] = [];
    for (const date of datesToScan) {
      const factsDir = path.join(factsBaseDir, date);
      try {
        const entries = await readdir(factsDir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.name.endsWith(".md")) continue;
          const fullPath = path.join(factsDir, entry.name);
          try {
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
            facts.push({
              path: fullPath,
              frontmatter: {
                id: fm.id || path.basename(entry.name, ".md"),
                category: (fm.category as any) || "fact",
                created: fm.created || "unknown",
                updated: fm.updated || fm.created || "unknown",
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
        // Directory doesn't exist — no facts for this date
      }
    }

    // Sort facts by created timestamp (most recent last) so truncation keeps newest
    facts.sort((a, b) =>
      a.frontmatter.created < b.frontmatter.created ? -1 : 1,
    );

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
            if (raw.trim().length > 0) {
              hourlySummaries.push(raw.trim());
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
      `gatherTodayFacts: collected ${facts.length} facts, ${hourlySummaries.length} hourly summaries (${formatted.length} chars)`,
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
        actionsEnabled: this.config.contextCompressionActionsEnabled,
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
    if (this.conversationIndexBackend) {
      return this.conversationIndexBackend.search(retrievalQuery, topK);
    }
    return [];
  }

  private formatConversationRecallSection(
    results: Array<{ path: string; snippet: string; score: number }>,
    maxChars: number,
  ): string | null {
    if (!Array.isArray(results) || results.length === 0) return null;
    const lines: string[] = ["## Semantic Recall (Past Conversations)", ""];
    let used = 0;
    for (const r of results) {
      if (!r?.snippet) continue;
      const chunk =
        `### ${r.path}\n` +
        `Score: ${r.score.toFixed(3)}\n\n` +
        `${r.snippet.trim()}\n`;
      if (used + chunk.length > maxChars) break;
      lines.push(chunk);
      used += chunk.length;
    }
    return used > 0 ? lines.join("\n") : null;
  }

  private async countConversationChunkDocs(dir: string): Promise<number> {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      let total = 0;
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          total += await this.countConversationChunkDocs(fullPath);
          continue;
        }
        if (entry.isFile() && entry.name.endsWith(".md")) {
          total += 1;
        }
      }
      return total;
    } catch {
      return 0;
    }
  }

  private async buildConversationIndexChunks(
    sessionKey?: string,
    hours: number = 24,
  ): Promise<ReturnType<typeof chunkTranscriptEntries>> {
    const entries = await this.transcript.readRecent(hours, sessionKey);
    const effectiveSessionKey = sessionKey ?? "all-sessions";
    return chunkTranscriptEntries(effectiveSessionKey, entries, {
      maxChars: this.config.conversationRecallMaxChars * 2,
      maxTurns: Math.max(10, this.config.hourlySummariesMaxTurnsPerRun),
    });
  }

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
    const chunkDocCount = await this.countConversationChunkDocs(
      this.conversationIndexDir,
    );
    const lastUpdateAtMs = Math.max(
      0,
      ...this.conversationIndexLastUpdateAtMs.values(),
    );
    const lastUpdateAt =
      lastUpdateAtMs > 0 ? new Date(lastUpdateAtMs).toISOString() : null;

    if (!this.config.conversationIndexEnabled) {
      return {
        enabled: false,
        backend: this.config.conversationIndexBackend,
        status: "disabled",
        chunkDocCount,
        lastUpdateAt,
      };
    }
    const backendHealth = this.conversationIndexBackend
      ? await this.conversationIndexBackend.health()
      : {
          backend: this.config.conversationIndexBackend,
          status: "degraded" as const,
        };
    return {
      enabled: true,
      chunkDocCount,
      lastUpdateAt,
      ...backendHealth,
    };
  }

  async inspectConversationIndex(): Promise<
    ConversationIndexBackendInspection & {
      enabled: boolean;
      chunkDocCount: number;
      lastUpdateAt: string | null;
    }
  > {
    const chunkDocCount = await this.countConversationChunkDocs(
      this.conversationIndexDir,
    );
    const lastUpdateAtMs = Math.max(
      0,
      ...this.conversationIndexLastUpdateAtMs.values(),
    );
    const lastUpdateAt =
      lastUpdateAtMs > 0 ? new Date(lastUpdateAtMs).toISOString() : null;

    if (!this.config.conversationIndexEnabled) {
      return {
        enabled: false,
        backend: this.config.conversationIndexBackend,
        status: "disabled",
        available: false,
        indexPath: this.conversationIndexDir,
        supportsIncrementalUpdate: true,
        message: "Conversation index disabled by config",
        metadata: {
          chunkCount: chunkDocCount,
        },
        chunkDocCount,
        lastUpdateAt,
      };
    }

    const inspection = this.conversationIndexBackend
      ? await this.conversationIndexBackend.inspect()
      : {
          backend: this.config.conversationIndexBackend,
          status: "degraded" as const,
          available: false,
          indexPath: this.conversationIndexDir,
          supportsIncrementalUpdate: true,
          message: "Conversation index backend unavailable",
          metadata: {
            chunkCount: chunkDocCount,
          },
        };

    return {
      enabled: true,
      chunkDocCount,
      lastUpdateAt,
      ...inspection,
    };
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
    if (!this.config.conversationIndexEnabled) {
      return { chunks: 0, skipped: true, reason: "disabled", embedded: false };
    }
    const enforceMinInterval = opts?.enforceMinInterval !== false;
    if (enforceMinInterval) {
      const minIntervalMs = Math.max(
        0,
        this.config.conversationIndexMinUpdateIntervalMs,
      );
      const now = Date.now();
      const last = this.conversationIndexLastUpdateAtMs.get(sessionKey) ?? 0;
      const elapsed = now - last;
      if (minIntervalMs > 0 && elapsed < minIntervalMs) {
        return {
          chunks: 0,
          skipped: true,
          reason: "min_interval",
          retryAfterMs: minIntervalMs - elapsed,
          embedded: false,
        };
      }
    }
    const chunks = await this.buildConversationIndexChunks(sessionKey, hours);
    await writeConversationChunks(this.conversationIndexDir, chunks);
    const retentionCutoffMs =
      Number.isFinite(this.config.conversationIndexRetentionDays) &&
      this.config.conversationIndexRetentionDays > 0
        ? Date.now() -
          this.config.conversationIndexRetentionDays * 24 * 60 * 60 * 1000
        : undefined;
    await cleanupConversationChunks(
      this.conversationIndexDir,
      this.config.conversationIndexRetentionDays,
    );
    const shouldEmbed =
      opts?.embed ?? this.config.conversationIndexEmbedOnUpdate;
    let embedded = false;

    if (this.conversationIndexBackend) {
      const result = await this.conversationIndexBackend.update(chunks, {
        embed: shouldEmbed,
        ...(retentionCutoffMs !== undefined ? { retentionCutoffMs } : {}),
      });
      embedded = result.embedded;
    }

    this.conversationIndexLastUpdateAtMs.set(sessionKey, Date.now());
    return { chunks: chunks.length, skipped: false, embedded };
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
    if (!this.config.conversationIndexEnabled) {
      return {
        chunks: 0,
        skipped: true,
        reason: "disabled",
        embedded: false,
        rebuilt: false,
      };
    }

    const chunks = await this.buildConversationIndexChunks(sessionKey, hours);
    await writeConversationChunks(this.conversationIndexDir, chunks);
    await cleanupConversationChunks(
      this.conversationIndexDir,
      this.config.conversationIndexRetentionDays,
    );

    const shouldEmbed =
      opts?.embed ?? this.config.conversationIndexEmbedOnUpdate;
    let embedded = false;
    let rebuilt = false;
    if (this.conversationIndexBackend) {
      const result = await this.conversationIndexBackend.rebuild(chunks, {
        embed: shouldEmbed,
      });
      embedded = result.embedded;
      rebuilt = result.rebuilt;
    }

    const stamp = Date.now();
    if (sessionKey) {
      this.conversationIndexLastUpdateAtMs.set(sessionKey, stamp);
    } else {
      this.conversationIndexLastUpdateAtMs.set("__rebuild__", stamp);
    }
    return { chunks: chunks.length, skipped: false, embedded, rebuilt };
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
    const abortController = new AbortController();
    const onAbort = () => {
      abortController.abort();
    };
    if (options.abortSignal?.aborted) {
      abortController.abort();
    } else {
      options.abortSignal?.addEventListener("abort", onAbort, { once: true });
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
    if (this.config.secureStoreEnabled && !this.storage.isSecureStoreUnlocked()) {
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
      });
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
      if (this.config.recallDirectAnswerEnabled && sessionKey) {
        try {
          this.enqueueDirectAnswerObservation(
            prompt,
            sessionKey,
            options.namespace?.trim() || undefined,
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
  ): void {
    const expectedSnapshot = this.lastRecall.get(sessionKey);
    if (expectedSnapshot === null) return;
    if (expectedSnapshot.plannerMode === "no_recall") return;

    const principal = resolvePrincipal(sessionKey, this.config);
    // Coding-agent overlay (issue #569) is applied when the session has a
    // coding context and there is no explicit namespaceOverride — mirrors
    // the main recall path above.
    const observationCodingOverlay =
      namespaceOverride && canReadNamespace(principal, namespaceOverride, this.config)
        ? null
        : this.applyCodingRecallOverlay(sessionKey);
    const observationPrincipalSelf = defaultNamespaceForPrincipal(principal, this.config);
    const observationCodingSelf = observationCodingOverlay
      ? combineNamespaces(observationPrincipalSelf, observationCodingOverlay.namespace)
      : null;
    let observationNamespaces: string[];
    if (namespaceOverride && canReadNamespace(principal, namespaceOverride, this.config)) {
      observationNamespaces = [namespaceOverride];
    } else if (observationCodingOverlay && observationCodingSelf) {
      // Rule 42 / parity with the main recall path: substitute the self
      // namespace within the principal's recall list rather than
      // replacing the full list. Preserves shared and policy-include
      // namespaces for direct-answer observation queries.
      const base = recallNamespacesForPrincipal(principal, this.config);
      const mapped = base.map((ns) =>
        ns === observationPrincipalSelf ? observationCodingSelf : ns,
      );
      const fallbackNs = observationCodingOverlay.readFallbacks.map((fallback) =>
        combineNamespaces(observationPrincipalSelf, fallback),
      );
      observationNamespaces = Array.from(new Set<string>([...mapped, ...fallbackNs]));
    } else {
      observationNamespaces = recallNamespacesForPrincipal(principal, this.config);
    }
    const observationQueryPolicy = buildRecallQueryPolicy(prompt, sessionKey, {
      cronRecallPolicyEnabled: this.config.cronRecallPolicyEnabled,
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
    if (!paths || paths.size === 0) return null;
    const scoped = new Set<string>();
    for (const memoryPath of paths) {
      if (!memoryPath || isArtifactMemoryPath(memoryPath)) continue;
      if (
        this.config.namespacesEnabled &&
        !recallNamespaces.includes(this.namespaceFromPath(memoryPath))
      ) {
        continue;
      }
      scoped.add(memoryPath);
    }
    return scoped.size > 0 ? scoped : null;
  }

  private async buildQueryAwarePrefilter(
    prompt: string,
    recallNamespaces: string[],
  ): Promise<QueryAwarePrefilter> {
    if (!this.config.queryAwareIndexingEnabled || !prompt.trim()) {
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

    if (temporalCandidates && tagCandidates) {
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
    } else if (temporalCandidates) {
      candidatePaths = temporalCandidates;
      combination = "temporal";
    } else if (tagCandidates) {
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
          const namespace = this.config.namespacesEnabled
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
              },
            )
          : await this.qmd.search(
              prompt,
              options.collection,
              fetchLimit,
              primarySearchOptions,
            )
        : await this.searchAcrossNamespaces({
            query: prompt,
            namespaces: options.namespacesEnabled
              ? options.recallNamespaces
              : undefined,
            maxResults: fetchLimit,
            mode: "search",
            searchOptions: primarySearchOptions,
            execution: { signal: options.abortSignal },
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
        } else {
          const hybridResults = options.collection
            ? await this.qmd.hybridSearch(
                prompt,
                options.collection,
                fetchLimit,
                {
                  signal: options.abortSignal,
                },
              )
            : await this.searchAcrossNamespaces({
                query: prompt,
                namespaces: options.namespacesEnabled
                  ? options.recallNamespaces
                  : undefined,
                maxResults: fetchLimit,
                mode: "hybrid",
                execution: { signal: options.abortSignal },
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

  private async expandResultsViaGraph(options: {
    memoryResults: QmdSearchResult[];
    recallNamespaces: string[];
    recallResultLimit: number;
    /** Issue #681 — when true, bypass graphTraversalConfidenceFloor. */
    includeLowConfidence?: boolean;
  }): Promise<{
    merged: QmdSearchResult[];
    seedPaths: string[];
    expandedPaths: GraphRecallExpandedEntry[];
    seedResults: QmdSearchResult[];
  }> {
    const byNamespace = new Map<string, QmdSearchResult[]>();
    for (const result of options.memoryResults) {
      const ns = this.namespaceFromPath(result.path);
      if (!options.recallNamespaces.includes(ns)) continue;
      const existing = byNamespace.get(ns);
      if (existing) {
        existing.push(result);
      } else {
        byNamespace.set(ns, [result]);
      }
    }

    const perNamespaceSeedCap = Math.max(3, options.recallResultLimit);
    const perNamespaceExpandedCap = Math.max(8, options.recallResultLimit * 2);
    const seedPaths: string[] = [];
    const seedResults: QmdSearchResult[] = [];
    const expandedPaths: GraphRecallExpandedEntry[] = [];
    const expandedResults: QmdSearchResult[] = [];

    for (const [namespace, nsResults] of byNamespace.entries()) {
      const storage = await this.storageRouter.storageFor(namespace);
      const seedCandidates = nsResults.slice(0, perNamespaceSeedCap);
      seedResults.push(...seedCandidates);
      const seedRelativePaths = seedCandidates
        .map((result) => graphPathRelativeToStorage(storage.dir, result.path))
        .filter(
          (value): value is string =>
            typeof value === "string" && value.length > 0,
        );
      if (seedRelativePaths.length === 0) continue;

      const seedRecallScore = seedCandidates.reduce(
        (max, item) => Math.max(max, item.score),
        0,
      );
      seedPaths.push(
        ...seedRelativePaths.map((rel) => path.join(storage.dir, rel)),
      );
      const seedSet = new Set(seedRelativePaths);
      const expanded = await this.graphIndexFor(storage).spreadingActivation(
        seedRelativePaths,
        this.config.maxGraphTraversalSteps,
        options.includeLowConfidence === true ? { includeLowConfidence: true } : undefined,
      );
      if (expanded.length === 0) continue;

      for (const candidate of expanded.slice(0, perNamespaceExpandedCap)) {
        if (seedSet.has(candidate.path)) continue;
        const memoryPath = path.resolve(storage.dir, candidate.path);
        const memory = await storage.readMemoryByPath(memoryPath);
        if (!memory) continue;
        if (isArtifactMemoryPath(memory.path)) continue;
        if (memory.frontmatter.status && memory.frontmatter.status !== "active")
          continue;

        const snippet = memory.content.slice(0, 400);
        const score = blendGraphExpandedRecallScore({
          graphActivationScore: candidate.score,
          seedRecallScore,
          activationWeight: this.config.graphExpansionActivationWeight,
          blendMin: this.config.graphExpansionBlendMin,
          blendMax: this.config.graphExpansionBlendMax,
        });
        expandedResults.push({
          docid: memory.frontmatter.id,
          path: memory.path,
          snippet,
          score,
        });
        expandedPaths.push({
          path: memory.path,
          score,
          namespace,
          seed: path.resolve(storage.dir, candidate.seed),
          hopDepth: candidate.hopDepth,
          decayedWeight: candidate.decayedWeight,
          graphType: candidate.graphType,
          // Issue #681 PR 3/3 — surface the per-edge confidence used for
          // PageRank weighting / floor pruning so downstream observability
          // (recall_xray, memory_graph_explain) can attribute ranking and
          // pruning decisions to specific edges.
          edgeConfidence: candidate.edgeConfidence,
        });
      }
    }

    return {
      merged: mergeGraphExpandedResults(options.memoryResults, expandedResults),
      seedPaths,
      expandedPaths,
      seedResults,
    };
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
    try {
      const snapshotPath = path.join(
        options.storage.dir,
        "state",
        "last_graph_recall.json",
      );
      await mkdir(path.dirname(snapshotPath), { recursive: true });
      const now = new Date().toISOString();
      const totalSeedCount = options.seedPaths.length;
      const totalExpandedCount = options.expandedPaths.length;
      const seeds = options.seedPaths.slice(0, 64);
      const expanded = clampGraphRecallExpandedEntries(
        options.expandedPaths,
        64,
      );
      const payload = {
        recordedAt: now,
        mode: options.recallMode,
        queryHash: createHash("sha256").update(options.prompt).digest("hex"),
        queryLength: options.prompt.length,
        namespaces: options.recallNamespaces,
        seedCount: totalSeedCount,
        expandedCount: totalExpandedCount,
        seeds,
        expanded,
        status: options.status,
        reason: options.reason,
        shadowMode: options.shadowMode === true,
        queryIntent: options.queryIntent,
        seedResults: (options.seedResults ?? []).slice(0, 64),
        finalResults: (options.finalResults ?? []).slice(0, 64),
        shadowComparison: options.shadowComparison,
      };
      await writeFile(snapshotPath, JSON.stringify(payload, null, 2), "utf-8");
    } catch (err) {
      log.debug(`last graph recall write failed: ${err}`);
    }
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
    if (!this.config.namespacesEnabled) {
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

  private getRecallSectionEntry(
    sectionId: string,
  ): RecallSectionConfig | undefined {
    const pipeline = Array.isArray(this.config.recallPipeline)
      ? this.config.recallPipeline
      : [];
    return pipeline.find((entry) => entry.id === sectionId);
  }

  private isRecallSectionEnabled(
    sectionId: string,
    defaultEnabled: boolean = true,
  ): boolean {
    const entry = this.getRecallSectionEntry(sectionId);
    if (!entry) return defaultEnabled;
    return entry.enabled !== false;
  }

  private isSpecializedRecallSectionEnabled(
    sectionId: string,
    topLevelEnabled: boolean,
  ): boolean {
    const entry = this.getRecallSectionEntry(sectionId);
    if (!entry) return topLevelEnabled;
    return entry.enabled === true || (topLevelEnabled && entry.enabled !== false);
  }

  private getRecallSectionMaxChars(
    sectionId: string,
  ): number | null | undefined {
    const entry = this.getRecallSectionEntry(sectionId);
    if (!entry) return undefined;
    if (entry.maxChars === null) return null;
    if (typeof entry.maxChars !== "number") return undefined;
    return Math.max(0, Math.floor(entry.maxChars));
  }

  private getRecallSectionNumber(
    sectionId: string,
    key: keyof RecallSectionConfig,
  ): number | undefined {
    const entry = this.getRecallSectionEntry(sectionId);
    if (!entry) return undefined;
    const value = entry[key];
    if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
    return Math.max(0, Math.floor(value));
  }

  private appendRecallSection(
    sectionBuckets: Map<string, string[]>,
    sectionId: string,
    content: string,
  ): boolean {
    // Returns true when the section was actually appended to sectionBuckets,
    // false when it was dropped (disabled, empty, or maxChars===0). Callers
    // that need to know whether injection occurred (e.g. xray annotation for
    // peer-profile) must gate on this return value rather than on whether the
    // section text was computed (Codex P2 finding, PR #764).
    if (!this.isRecallSectionEnabled(sectionId)) return false;
    const trimmed = content.trim();
    if (trimmed.length === 0) return false;

    const maxChars = this.getRecallSectionMaxChars(sectionId);
    let finalContent = trimmed;
    if (maxChars === 0) return false;
    if (typeof maxChars === "number" && finalContent.length > maxChars) {
      finalContent = `${finalContent.slice(0, maxChars)}\n\n...(trimmed)\n`;
    }

    const existing = sectionBuckets.get(sectionId) ?? [];
    existing.push(finalContent);
    sectionBuckets.set(sectionId, existing);
    return true;
  }

  private truncateRecallSectionToBudget(
    content: string,
    maxChars: number,
  ): string {
    if (maxChars <= 0) return "";
    if (content.length <= maxChars) return content;
    const suffix = "\n\n...(memory context trimmed)";
    if (maxChars <= suffix.length) {
      return content.slice(0, maxChars);
    }
    return `${content.slice(0, maxChars - suffix.length)}${suffix}`;
  }

  private protectedRecallSectionIds(
    sectionBuckets: Map<string, string[]>,
  ): Set<string> {
    const protectedIds = new Set<string>();
    if ((sectionBuckets.get("memories")?.length ?? 0) > 0) {
      protectedIds.add("memories");
    }
    return protectedIds;
  }

  private protectedRecallReservationChars(content: string): number {
    const headingBoundary = content.indexOf("\n\n");
    const headingChars =
      headingBoundary >= 0 ? headingBoundary + 2 : Math.min(content.length, 24);
    return Math.min(content.length, Math.max(headingChars, 24));
  }

  private estimateReservedRecallBudget(
    entries: Array<{ id: string; content: string }>,
    startIndex: number,
    protectedIds: Set<string>,
    alreadyIncludedCount: number,
  ): number {
    const separatorLength = "\n\n---\n\n".length;
    let reserved = 0;
    let simulatedIncluded = alreadyIncludedCount;
    for (let i = startIndex; i < entries.length; i += 1) {
      const entry = entries[i];
      if (!entry || !protectedIds.has(entry.id)) continue;
      if (simulatedIncluded > 0) {
        reserved += separatorLength;
      }
      reserved += this.protectedRecallReservationChars(entry.content);
      simulatedIncluded += 1;
    }
    return reserved;
  }

  private getRecallBudgetChars(override?: number): number {
    if (
      typeof override === "number" &&
      Number.isFinite(override) &&
      override >= 0
    ) {
      return Math.floor(override);
    }
    const configuredBudget = this.config.recallBudgetChars;
    if (
      typeof configuredBudget === "number" &&
      Number.isFinite(configuredBudget) &&
      configuredBudget >= 0
    ) {
      return Math.floor(configuredBudget);
    }
    const tokenBudget = this.config.maxMemoryTokens;
    if (
      typeof tokenBudget === "number" &&
      Number.isFinite(tokenBudget) &&
      tokenBudget >= 0
    ) {
      return Math.floor(tokenBudget * 4);
    }
    return 0;
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
    const orderedEntries: Array<{ id: string; content: string }> = [];
    const pipeline = Array.isArray(this.config.recallPipeline)
      ? this.config.recallPipeline
      : [];
    const orderedIds = pipeline
      .filter((entry) => entry.enabled !== false)
      .map((entry) => entry.id);
    const seen = new Set<string>();

    for (const id of orderedIds) {
      const chunks = sectionBuckets.get(id);
      if (!chunks || chunks.length === 0) continue;
      orderedEntries.push({ id, content: chunks.join("\n\n") });
      seen.add(id);
    }

    for (const [id, chunks] of sectionBuckets.entries()) {
      if (seen.has(id)) continue;
      if (chunks.length === 0) continue;
      orderedEntries.push({ id, content: chunks.join("\n\n") });
    }

    const budget = this.getRecallBudgetChars(budgetOverride);
    if (budget === 0) {
      return {
        sections: [],
        includedIds: [],
        omittedIds: orderedEntries.map((entry) => entry.id),
        truncated: orderedEntries.length > 0,
        finalChars: 0,
      };
    }

    const separator = "\n\n---\n\n";
    const protectedIds = this.protectedRecallSectionIds(sectionBuckets);
    const sections: string[] = [];
    const includedIds: string[] = [];
    const omittedIds: string[] = [];
    let usedChars = 0;
    let truncated = false;

    for (let index = 0; index < orderedEntries.length; index += 1) {
      const entry = orderedEntries[index]!;
      const separatorChars = sections.length > 0 ? separator.length : 0;
      const reserve = protectedIds.has(entry.id)
        ? 0
        : this.estimateReservedRecallBudget(
            orderedEntries,
            index + 1,
            protectedIds,
            sections.length + 1,
          );
      const availableForEntry = budget - usedChars - separatorChars - reserve;
      if (availableForEntry <= 0) {
        omittedIds.push(entry.id);
        truncated = true;
        continue;
      }
      const finalContent = this.truncateRecallSectionToBudget(
        entry.content,
        availableForEntry,
      );
      if (!finalContent) {
        omittedIds.push(entry.id);
        truncated = true;
        continue;
      }
      if (finalContent.length < entry.content.length) {
        truncated = true;
      }
      sections.push(finalContent);
      includedIds.push(entry.id);
      usedChars += separatorChars + finalContent.length;
    }

    return {
      sections,
      includedIds,
      omittedIds,
      truncated,
      finalChars: usedChars,
    };
  }

  private async recallInternal(
    prompt: string,
    sessionKey?: string,
    options: RecallInvocationOptions = {},
  ): Promise<string> {
    const recallStart = Date.now();
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
    const timings: Record<string, string> = {};
    const profileTraceId = this.profiler.startTrace("recall", sessionKey, {
      qmdEnabled: this.config.qmdEnabled,
      rerankEnabled: this.config.rerankEnabled,
      parallelRetrieval: this.config.parallelRetrievalEnabled,
    });
    this.profiler.startSpan("planning", profileTraceId);
    let profileTraceClosed = false;
    const closeProfileTrace = () => {
      if (profileTraceClosed) return;
      profileTraceClosed = true;
      this.profiler.endTrace(profileTraceId); // persists to JSONL file
    };
    const recallSectionDeadlineMs = this.config.recallCoreDeadlineMs ?? 75_000;
    const enrichmentSectionDeadlineMs =
      this.config.recallEnrichmentDeadlineMs ?? 25_000;
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
    const sectionBuckets = new Map<string, string[]>();
    const queryPolicy = buildRecallQueryPolicy(prompt, sessionKey, {
      cronRecallPolicyEnabled: this.config.cronRecallPolicyEnabled,
      cronRecallNormalizedQueryMaxChars:
        this.config.cronRecallNormalizedQueryMaxChars,
      cronRecallInstructionHeavyTokenCap:
        this.effectiveCronRecallInstructionHeavyTokenCap(),
      cronConversationRecallMode: this.config.cronConversationRecallMode,
    });
    const retrievalQuery = queryPolicy.retrievalQuery || prompt;
    const retrievalQueryHash = createHash("sha256")
      .update(retrievalQuery)
      .digest("hex");
    const policyVersion = this.currentPolicyVersion();
    let impressionRecorded = false;
    let recallSource:
      | "none"
      | "hot_qmd"
      | "hot_embedding"
      | "cold_fallback"
      | "recent_scan" = "none";
    let recalledMemoryCount = 0;
    let recalledMemoryIds: string[] = [];
    let recalledMemoryPaths: string[] = [];
    // Boosted QmdSearchResult array for the serving branch (issue #687 PR 3/4).
    // Populated alongside recalledMemoryPaths so the X-ray capture can read
    // per-result explain data (e.g. reinforcementBoost) from the result that
    // was actually served.
    let xrayRecalledResults: QmdSearchResult[] = [];
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
    const recallDecision = resolveRecallModeDecision({
      plannerEnabled: this.config.recallPlannerEnabled,
      graphRecallEnabled: this.config.graphRecallEnabled,
      multiGraphMemoryEnabled: this.config.multiGraphMemoryEnabled,
      graphExpandedIntentEnabled:
        this.config.graphExpandedIntentEnabled === true,
      prompt,
    });
    this.profiler.endSpan("planning", profileTraceId);
    const requestedMode = options.mode;
    const recallMode: RecallPlanMode =
      requestedMode ?? recallDecision.effectiveMode;
    const queryIntent = inferIntentFromText(retrievalQuery);
    const qmdSearchOptions =
      this.buildConfiguredQmdSearchOptions(retrievalQuery);
    timings.recallPlan = recallMode;
    const plannerRecallResultLimit =
      recallMode === "no_recall"
        ? 0
        : recallMode === "minimal"
          ? Math.max(
              0,
              Math.min(
                this.config.qmdMaxResults,
                this.config.recallPlannerMaxQmdResultsMinimal,
              ),
            )
          : this.config.qmdMaxResults;
    const policyMinimalLimit = Math.max(
      0,
      Math.min(
        this.config.qmdMaxResults,
        this.config.recallPlannerMaxQmdResultsMinimal,
      ),
    );
    const baseRecallResultLimit =
      recallMode !== "no_recall" &&
      queryPolicy.retrievalBudgetMode === "minimal"
        ? Math.min(plannerRecallResultLimit, policyMinimalLimit)
        : plannerRecallResultLimit;
    const memoriesSectionEnabled = this.isRecallSectionEnabled("memories");
    const memorySectionMaxResults = this.getRecallSectionNumber(
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
    const recallHeadroom = this.config.verbatimArtifactsEnabled
      ? Math.max(12, this.config.verbatimArtifactsMaxRecall * 4)
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
      this.config.verbatimArtifactsEnabled,
      this.config.verbatimArtifactsMaxRecall,
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
        : resolvePrincipal(sessionKey, this.config);
    const namespaceOverride = options.namespace?.trim() || undefined;
    const readableRecallNamespaces = recallNamespacesForPrincipal(
      principal,
      this.config,
    );
    if (
      namespaceOverride &&
      !canReadNamespace(principal, namespaceOverride, this.config)
    ) {
      throw new Error(
        `namespace override is not readable: ${namespaceOverride}`,
      );
    }
    // Recall path — overlay the coding-agent namespace (issue #569) when
    // the session has a codingContext and `codingMode.projectScope` is true.
    // Explicit `namespace` option still wins, preserving pre-#569 semantics.
    //
    // Rule 42: the overlay substitutes the SELF namespace within the
    // principal's recall list — it does NOT replace the full list. Shared
    // and `includeInRecallByDefault` policy namespaces stay in the recall
    // set so coding sessions continue to see team/shared memories. The
    // overlay is combined with the principal base through `combineNamespaces`
    // to preserve principal isolation (cross-tenant leakage guard).
    const codingOverlay = namespaceOverride ? null : this.applyCodingRecallOverlay(sessionKey);
    const principalSelfNamespace = defaultNamespaceForPrincipal(principal, this.config);
    const codingSelfNamespace = codingOverlay
      ? combineNamespaces(principalSelfNamespace, codingOverlay.namespace)
      : null;
    const selfNamespace =
      namespaceOverride ??
      codingSelfNamespace ??
      principalSelfNamespace;
    let recallNamespaces: string[];
    if (namespaceOverride) {
      recallNamespaces = [namespaceOverride];
    } else if (codingOverlay && codingSelfNamespace) {
      // Substitute the principal's self namespace with the coding-scoped
      // one, and append any read fallbacks (branch→project, PR 3) combined
      // with the principal base so principal isolation is preserved on
      // fallback entries as well.
      const mapped = readableRecallNamespaces.map((ns) =>
        ns === principalSelfNamespace ? codingSelfNamespace : ns,
      );
      const fallbackNs = codingOverlay.readFallbacks.map((fallback) =>
        combineNamespaces(principalSelfNamespace, fallback),
      );
      recallNamespaces = Array.from(new Set<string>([...mapped, ...fallbackNs]));
    } else {
      recallNamespaces = readableRecallNamespaces;
    }
    const qmdAvailable = this.qmd.isAvailable();
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
      plannerEnabled: this.config.recallPlannerEnabled,
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
        graphRecallEnabled: this.config.graphRecallEnabled,
        multiGraphMemoryEnabled: this.config.multiGraphMemoryEnabled,
      },
    });

    if (recallMode === "no_recall") {
      const intentSnapshot = buildIntentDebugSnapshot();
      await this.recordLastIntentSnapshotForNamespace({
        namespace: selfNamespace,
        snapshot: intentSnapshot,
      });
      // Clean up workspace selection before early return to prevent Map leaks.
      const earlySessionKey = sessionKey ?? "default";
      this._recallWorkspaceOverrides.delete(earlySessionKey);
      timings.total = `${Date.now() - recallStart}ms`;
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
          this.lastXraySnapshot = buildXraySnapshot({
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
              chars: this.getRecallBudgetChars(options.budgetCharsOverride),
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
        this.lastRecall
          .record({
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
            budgetsApplied: this.buildLastRecallBudgetSummary({
              requestedTopK,
              recallResultLimit,
              qmdFetchLimit,
              qmdHybridFetchLimit,
            }),
            latencyMs: Date.now() - recallStart,
            resultPaths: [],
            policyVersion,
            appendImpression: this.config.recordEmptyRecallImpressions,
            identityInjection: {
              mode: identityInjectionModeUsed,
              injectedChars: identityInjectedChars,
              truncated: identityInjectionTruncated,
            },
          })
          .catch((err) => log.debug(`last recall record failed: ${err}`));
      }
      if (sessionKey) {
        this.queueEvalShadowRecall({
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
      this.emitTrace({
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
        qmdEnabled: this.config.qmdEnabled,
        qmdAvailable: this.qmd.isAvailable(),
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

    const profileStorage = await this.storageRouter.storageFor(selfNamespace);

    // --- Phase 1: Launch ALL independent data fetches in parallel ---
    throwIfRecallAborted(options.abortSignal);

    // 0. Shared context (v4.0, optional)
    const sharedContextPromise = (async (): Promise<string | null> => {
      if (
        !this.isRecallSectionEnabled(
          "shared-context",
          this.config.sharedContextEnabled === true,
        )
      )
        return null;
      if (!this.sharedContext) return null;
      const t0 = Date.now();
      const [priorities, roundtable, crossSignals] = await Promise.all([
        this.sharedContext.readPriorities(),
        this.sharedContext.readLatestRoundtable(),
        this.sharedContext.readLatestCrossSignals(),
      ]);
      const max = Math.max(500, this.config.sharedContextMaxInjectChars);
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
      if (!this.isRecallSectionEnabled("profile")) return null;
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
      if (!this.config.peerProfileRecallEnabled) return null;
      if (this.config.peerProfileRecallMaxFields <= 0) return null;
      const peerId = this.getPeerIdForSession(sessionKey);
      if (!peerId) return null;
      const t0 = Date.now();
      try {
        const { readPeerProfile: _readPeerProfile } = await import("./peers/index.js");
        const peerProfile = await _readPeerProfile(this.config.memoryDir, peerId);
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
        const capped = fieldsByRecency.slice(0, this.config.peerProfileRecallMaxFields);
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
        !this.isRecallSectionEnabled(
          "identity-continuity",
          this.config.identityContinuityEnabled === true,
        )
      )
        return null;
      const t0 = Date.now();
      const section = await this.buildIdentityContinuitySection({
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
        !this.isRecallSectionEnabled(
          "entity-retrieval",
          this.config.entityRetrievalEnabled,
        )
      )
        return null;
      if (!this.config.entityRetrievalEnabled) return null;
      const maxChars =
        this.getRecallSectionMaxChars("entity-retrieval") ??
        this.config.entityRetrievalMaxChars;
      const maxHints =
        this.getRecallSectionNumber("entity-retrieval", "maxHints") ??
        this.config.entityRetrievalMaxHints;
      const maxSupportingFacts =
        this.getRecallSectionNumber("entity-retrieval", "maxSupportingFacts") ??
        this.config.entityRetrievalMaxSupportingFacts;
      const maxRelatedEntities =
        this.getRecallSectionNumber("entity-retrieval", "maxRelatedEntities") ??
        this.config.entityRetrievalMaxRelatedEntities;
      const recentTurns =
        this.getRecallSectionNumber("entity-retrieval", "recentTurns") ??
        this.config.entityRetrievalRecentTurns;
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
            this.transcript.readRecent(
              entityRecentTranscriptLookbackHours,
              sessionKey,
            ),
            recentTurns,
          )
        : [];
      const section = await buildEntityRecallSection({
        config: this.config,
        storage: profileStorage,
        namespaceStorage: (namespace) => this.getStorage(namespace),
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
        !this.isRecallSectionEnabled(
          "knowledge-index",
          this.config.knowledgeIndexEnabled,
        )
      )
        return null;
      if (!this.config.knowledgeIndexEnabled) return null;
      const t0 = Date.now();
      try {
        const ki = await this.storage.buildKnowledgeIndex(this.config, {
          maxEntities: this.getRecallSectionNumber(
            "knowledge-index",
            "maxEntities",
          ),
          maxChars: this.getRecallSectionNumber("knowledge-index", "maxChars"),
        });
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
        !this.isRecallSectionEnabled(
          "verbatim-artifacts",
          this.config.verbatimArtifactsEnabled === true,
        )
      )
        return [];
      if (!this.config.verbatimArtifactsEnabled) return [];
      const t0 = Date.now();
      const targetCount = computeArtifactRecallLimit(
        recallMode,
        recallResultLimit,
        this.config.verbatimArtifactsMaxRecall,
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
      const results = await this.recallArtifactsAcrossNamespaces(
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
        !this.config.objectiveStateMemoryEnabled ||
        !this.config.objectiveStateRecallEnabled ||
        !this.isRecallSectionEnabled(
          "objective-state",
          this.config.objectiveStateRecallEnabled === true,
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
        this.getRecallSectionNumber("objective-state", "maxResults") ?? 4;
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
          const storage = this.config.namespacesEnabled
            ? await this.getStorage(namespace)
            : null;
          return searchObjectiveStateSnapshots({
            memoryDir: this.config.namespacesEnabled
              ? storage!.dir
              : this.config.memoryDir,
            objectiveStateStoreDir: objectiveStateStoreOverrideForNamespace({
              memoryDir: this.config.memoryDir,
              configuredStoreDir: this.config.objectiveStateStoreDir,
              namespacesEnabled: this.config.namespacesEnabled,
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
        ? this.formatObjectiveStateResults(results)
        : null;
    })();

    const causalTrajectoryPromise = (async (): Promise<string | null> => {
      const t0 = Date.now();
      if (
        !this.config.causalTrajectoryMemoryEnabled ||
        !this.config.causalTrajectoryRecallEnabled ||
        !this.isRecallSectionEnabled(
          "causal-trajectories",
          this.config.causalTrajectoryRecallEnabled === true,
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
        this.getRecallSectionNumber("causal-trajectories", "maxResults") ?? 3;
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
        memoryDir: this.config.memoryDir,
        causalTrajectoryStoreDir: this.config.causalTrajectoryStoreDir,
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
        ? this.formatCausalTrajectoryResults(results)
        : null;
    })();

    const cmcRetrievalPromise = (async (): Promise<string | null> => {
      const t0 = Date.now();
      if (
        !this.config.cmcRetrievalEnabled ||
        !this.isRecallSectionEnabled(
          "cmc-causal-chains",
          this.config.cmcRetrievalEnabled === true,
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
        const { retrieveCausalChains } = await import("./causal-retrieval.js");
        const section = await retrieveCausalChains({
          memoryDir: this.config.memoryDir,
          causalTrajectoryStoreDir: this.config.causalTrajectoryStoreDir,
          query: retrievalQuery,
          sessionKey,
          config: {
            maxDepth: this.config.cmcRetrievalMaxDepth,
            maxChars: this.config.cmcRetrievalMaxChars,
            counterfactualBoost: this.config.cmcRetrievalCounterfactualBoost,
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
        !this.config.calibrationEnabled ||
        !this.isRecallSectionEnabled(
          "calibration-rules",
          this.config.calibrationEnabled === true,
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
          await import("./calibration.js");
        const rules = await getCalibrationRulesForRecall(this.config.memoryDir);
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
          rules.slice(0, this.config.calibrationMaxRulesPerRecall),
          retrievalQuery,
          this.config.calibrationMaxChars,
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
        !this.config.trustZonesEnabled ||
        !this.config.trustZoneRecallEnabled ||
        !this.isRecallSectionEnabled(
          "trust-zones",
          this.config.trustZoneRecallEnabled === true,
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
        this.getRecallSectionNumber("trust-zones", "maxResults") ?? 3;
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
        memoryDir: this.config.memoryDir,
        trustZoneStoreDir: this.config.trustZoneStoreDir,
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
      return results.length > 0 ? this.formatTrustZoneResults(results) : null;
    })();

    const harmonicRetrievalAbort = createEnrichmentAbortHandle(
      options.abortSignal,
    );
    const harmonicRetrievalPromise = observeEnrichmentPromise(
      (async (): Promise<string | null> => {
        const t0 = Date.now();
        if (
          !this.config.harmonicRetrievalEnabled ||
          !this.isRecallSectionEnabled(
            "harmonic-retrieval",
            this.config.harmonicRetrievalEnabled === true,
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
          this.getRecallSectionNumber("harmonic-retrieval", "maxResults") ?? 3;
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

        const results = await searchHarmonicRetrieval({
          memoryDir: this.config.memoryDir,
          abstractionNodeStoreDir: this.config.abstractionNodeStoreDir,
          query: retrievalQuery,
          maxResults,
          sessionKey,
          anchorsEnabled: this.config.abstractionAnchorsEnabled,
          abortSignal: harmonicRetrievalAbort.signal,
        });

        recordRecallSectionMetric({
          section: "harmonicRetrieval",
          priority: "enrichment",
          durationMs: Date.now() - t0,
          deadlineMs: enrichmentSectionDeadlineMs,
          source: "fresh",
          success: true,
        });
        return results.length > 0
          ? this.formatHarmonicRetrievalResults(results)
          : null;
      })().finally(() => harmonicRetrievalAbort.dispose()),
      () => harmonicRetrievalAbort.cancel(),
    );

    // Verified recall and semantic rules both need readAllMemories().
    // Instead of a shared preload (which has namespace/dir mismatch issues),
    // each subsystem calls readAllMemories() on its correct storage instance.
    // The process-level memory cache (keyed by baseDir + memoryStatusVersion)
    // ensures only one actual disk scan happens — subsequent calls return
    // from cache in <1ms.

    const verifiedRecallPromise = (async (): Promise<string | null> => {
      const t0 = Date.now();
      if (
        !this.config.verifiedRecallEnabled ||
        !this.isRecallSectionEnabled(
          "verified-episodes",
          this.config.verifiedRecallEnabled === true,
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
        this.getRecallSectionNumber("verified-episodes", "maxResults") ?? 3;
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
        searchVerifiedEpisodes({
          memoryDir: profileStorage.dir,
          query: retrievalQuery,
          maxResults,
          boxRecallDays: this.config.boxRecallDays,
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
        ? this.formatVerifiedEpisodeResults(results)
        : null;
    })();

    const verifiedRulesPromise = (async (): Promise<string | null> => {
      const t0 = Date.now();
      if (
        !this.config.semanticRuleVerificationEnabled ||
        !this.isRecallSectionEnabled(
          "verified-rules",
          this.config.semanticRuleVerificationEnabled === true,
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
        this.getRecallSectionNumber("verified-rules", "maxResults") ?? 3;
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
        searchVerifiedSemanticRules({
          memoryDir: this.config.memoryDir,
          query: retrievalQuery,
          maxResults,
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
        ? this.formatVerifiedSemanticRuleResults(results)
        : null;
    })();

    const workProductsPromise = (async (): Promise<string | null> => {
      const t0 = Date.now();
      if (
        !this.config.creationMemoryEnabled ||
        !this.config.workProductRecallEnabled ||
        !this.isRecallSectionEnabled(
          "work-products",
          this.config.workProductRecallEnabled === true,
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
        this.getRecallSectionNumber("work-products", "maxResults") ?? 3;
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

      const results = await searchWorkProductLedgerEntries({
        memoryDir: this.config.memoryDir,
        workProductLedgerDir: this.config.workProductLedgerDir,
        query: retrievalQuery,
        maxResults,
        sessionKey,
      });

      recordRecallSectionMetric({
        section: "workProducts",
        priority: "core",
        durationMs: Date.now() - t0,
        deadlineMs: recallSectionDeadlineMs,
        source: "fresh",
        success: true,
      });
      return results.length > 0 ? this.formatWorkProductResults(results) : null;
    })();

    const queryAwarePrefilterPromise =
      (async (): Promise<QueryAwarePrefilter> => {
        const t0 = Date.now();
        if (!this.config.queryAwareIndexingEnabled || !prompt.trim()) {
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

        const prefilter = await this.buildQueryAwarePrefilter(
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
    } | null;

    const qmdEnrichmentAbort = createEnrichmentAbortHandle(options.abortSignal);
    const qmdPromise = observeEnrichmentPromise(
      (async (): Promise<QmdPhaseResult> => {
        const t0 = Date.now();
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
          memoryDir: this.config.memoryDir,
          searchOptions: qmdSearchOptions,
        });
        const cachedQmd = getCachedQmdRecall<Exclude<QmdPhaseResult, null>>(
          qmdCacheKey,
          {
            freshTtlMs: this.config.qmdRecallCacheTtlMs ?? 60_000,
            staleTtlMs: this.config.qmdRecallCacheStaleTtlMs ?? 10 * 60_000,
          },
        );
        const staleQmdFallback =
          cachedQmd?.source === "stale" ? cachedQmd : null;
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
          return cachedQmd.value;
        }

        if (!this.qmd.isAvailable()) {
          const now = Date.now();
          const QMD_REPROBE_COOLDOWN_MS = 60_000;
          if (
            this.lastQmdReprobeAtMs &&
            now - this.lastQmdReprobeAtMs < QMD_REPROBE_COOLDOWN_MS
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
            return null;
          }
          this.lastQmdReprobeAtMs = now;
          const reprobed = await this.qmd.probe();
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
              `Search skip (re-probe failed): ${this.qmd.debugStatus()}`,
            );
            return null;
          }
          log.info(`QMD re-probe succeeded: ${this.qmd.debugStatus()}`);
        }

        const queryAwarePrefilter = await queryAwarePrefilterPromise;
        const maxPerAgent = this.config.parallelMaxResultsPerAgent;
        const specializedAgentPromise: Promise<
          [ParallelSearchResult[], ParallelSearchResult[]]
        > | null =
          this.config.parallelRetrievalEnabled && maxPerAgent > 0
            ? Promise.all([
                shouldRunAgent("direct", retrievalQuery, 0)
                  ? runDirectAgent(
                      retrievalQuery,
                      profileStorage.dir,
                      maxPerAgent,
                    ).catch((err) => {
                      log.debug(`DirectAgent pre-start failed: ${err}`);
                      return [] as ParallelSearchResult[];
                    })
                  : Promise.resolve([] as ParallelSearchResult[]),
                shouldRunAgent("temporal", retrievalQuery, 0)
                  ? runTemporalAgent(
                      retrievalQuery,
                      this.config.memoryDir,
                      maxPerAgent,
                      queryAwarePrefilter.candidatePaths,
                    ).catch((err) => {
                      log.debug(`TemporalAgent pre-start failed: ${err}`);
                      return [] as ParallelSearchResult[];
                    })
                  : Promise.resolve([] as ParallelSearchResult[]),
              ])
            : null;

        try {
          const filteredResults =
            await this.fetchQmdMemoryResultsWithArtifactTopUp(
              retrievalQuery,
              qmdFetchLimit,
              qmdHybridFetchLimit,
              {
                namespacesEnabled: this.config.namespacesEnabled,
                recallNamespaces,
                resolveNamespace: (p) => this.namespaceFromPath(p),
                queryAwarePrefilter,
                searchOptions: qmdSearchOptions,
                abortSignal: qmdEnrichmentAbort.signal,
                onDebugSnapshot: async (snapshot) => {
                  await this.recordLastQmdRecallSnapshot({
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
          if (this.config.parallelRetrievalEnabled && specializedAgentPromise) {
            try {
              const [directResults, temporalResults] =
                await specializedAgentPromise;
              if (filteredResults.length > 0) {
                const w = this.config.parallelAgentWeights;
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
                  this.config.parallelMaxResultsPerAgent * 2;
                augmentedResults = await mergeWithAgentResults(
                  filteredResults,
                  directResults,
                  temporalResults,
                  this.config.parallelAgentWeights,
                  qmdFetchLimit + lifecycleHeadroom,
                  this.config.memoryDir,
                );
              }
            } catch (err) {
              log.debug(
                `parallelRetrieval augmentation failed, using base results: ${err}`,
              );
              maxSpecializedScore = 0;
            }
          }

          const result = {
            memoryResultsLists: [augmentedResults],
            globalResults: [],
            preAugmentTopScore,
            maxSpecializedScore,
          };
          if (
            augmentedResults.length > 0 ||
            result.globalResults.length > 0
          ) {
            setCachedQmdRecall(qmdCacheKey, result, {
              maxEntries: this.config.qmdRecallCacheMaxEntries ?? 128,
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
      () => qmdEnrichmentAbort.cancel(),
    );

    const transcriptPromise = (async (): Promise<string | null> => {
      const t0 = Date.now();
      if (
        !this.config.transcriptEnabled ||
        !this.isRecallSectionEnabled("transcript", true)
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
        this.getRecallSectionNumber("transcript", "maxTokens") ??
        this.config.maxTranscriptTokens;
      const transcriptMaxTurns =
        this.getRecallSectionNumber("transcript", "maxTurns") ??
        this.config.maxTranscriptTurns;
      const transcriptLookbackHours =
        this.getRecallSectionNumber("transcript", "lookbackHours") ??
        this.config.transcriptRecallHours;
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
      if (this.config.checkpointEnabled) {
        const checkpoint = await this.transcript.loadCheckpoint(sessionKey);
        log.debug(
          `recall: checkpoint loaded, turns=${checkpoint?.turns?.length ?? 0}`,
        );
        if (checkpoint && checkpoint.turns.length > 0) {
          const formatted = this.transcript.formatForRecall(
            checkpoint.turns,
            transcriptMaxTokens,
          );
          if (formatted) {
            section = `## Working Context (Recovered)\n\n${formatted}`;
            checkpointInjected = true;
            // Clear checkpoint after injection
            await this.transcript.clearCheckpoint();
          }
        }
      }

      if (!checkpointInjected) {
        const entries = await this.transcript.readRecent(
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
          const formatted = this.transcript.formatForRecall(
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
        this._recallWorkspaceOverrides.get(effectiveSessionKey);
      this._recallWorkspaceOverrides.delete(effectiveSessionKey);

      if (!this.config.compactionResetEnabled) return null;

      const workspaceDir =
        compactionWorkspaceDir ||
        this.config.workspaceDir ||
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
        !this.config.hourlySummariesEnabled ||
        !sessionKey ||
        !this.isRecallSectionEnabled("summaries", true)
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
        this.getRecallSectionNumber("summaries", "lookbackHours") ??
        this.config.summaryRecallHours;
      const summariesMaxCount =
        this.getRecallSectionNumber("summaries", "maxCount") ??
        this.config.maxSummaryCount;
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

      const summaries = await this.summarizer.readRecent(
        sessionKey,
        summariesLookbackHours,
      );
      const cappedSummaries = summaries.slice(0, summariesMaxCount);
      const section =
        cappedSummaries.length > 0
          ? this.summarizer.formatForRecall(cappedSummaries, summariesMaxCount)
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
          !this.config.nativeKnowledge?.enabled ||
          !this.isRecallSectionEnabled(
            "native-knowledge",
            this.config.nativeKnowledge.enabled,
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
          this.config.nativeKnowledge.maxResults === 0 ||
          this.config.nativeKnowledge.maxChars === 0
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
          workspaceDir: this.config.workspaceDir,
          memoryDir: this.config.memoryDir,
          config: this.config.nativeKnowledge,
          recallNamespaces: this.config.namespacesEnabled
            ? recallNamespaces
            : undefined,
          defaultNamespace: this.config.defaultNamespace,
          abortSignal: nativeKnowledgeAbort.signal,
        }).catch(() => []);
        const results = searchNativeKnowledge({
          query: retrievalQuery,
          chunks,
          maxResults:
            this.getRecallSectionNumber("native-knowledge", "maxResults") ??
            this.config.nativeKnowledge.maxResults,
        });
        const section = formatNativeKnowledgeSection({
          results,
          maxChars:
            this.getRecallSectionNumber("native-knowledge", "maxChars") ??
            this.config.nativeKnowledge.maxChars,
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
        !this.config.conversationIndexEnabled ||
        queryPolicy.skipConversationRecall ||
        !this.isRecallSectionEnabled("conversation-recall", true)
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

      const topKOverride = this.getRecallSectionNumber(
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
        this.getRecallSectionNumber("conversation-recall", "timeoutMs") ??
          this.config.conversationRecallTimeoutMs,
      );
      const topK = Math.max(
        1,
        topKOverride ?? this.config.conversationRecallTopK,
      );
      const maxChars = Math.max(
        400,
        this.getRecallSectionNumber("conversation-recall", "maxChars") ??
          this.config.conversationRecallMaxChars,
      );

      const results = (await Promise.race([
        this.searchConversationRecallResults(retrievalQuery, topK),
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

      const section = this.formatConversationRecallSection(results, maxChars);
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
      if (this.config.procedural?.enabled !== true) return null;
      if (!this.isRecallSectionEnabled("procedure-recall", true)) return null;
      try {
        return await buildProcedureRecallSection(
          profileStorage,
          retrievalQuery,
          this.config,
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
          !this.compounding ||
          !this.config.compoundingInjectEnabled ||
          !this.isRecallSectionEnabled("compounding", true)
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
          this.getRecallSectionNumber("compounding", "maxPatterns") ?? 40;
        const maxRubrics =
          this.getRecallSectionNumber("compounding", "maxRubrics") ?? 4;
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
        const section = await this.compounding.buildRecallSection(
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
    const recentBoxesPromise: Promise<BoxFrontmatter[]> =
      this.isRecallSectionEnabled(
        "memory-boxes",
        this.config.memoryBoxesEnabled === true,
      ) &&
      this.config.memoryBoxesEnabled &&
      this.config.boxRecallDays > 0
        ? this.boxBuilderFor(profileStorage)
            .readRecentBoxes(this.config.boxRecallDays)
            .catch(() => [] as BoxFrontmatter[])
        : Promise.resolve([] as BoxFrontmatter[]);

    // --- Wait for core sections first, then bounded enrichment ---
    this.profiler.startSpan("phase-1-parallel", profileTraceId);
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

    this.profiler.endSpan("phase-1-parallel", profileTraceId);
    log.info(
      `recall phase-1: core work done at +${Date.now() - recallStart}ms ` +
        `(phase took ${Date.now() - phase1Start}ms); continuing with incremental enrichment assembly`,
    );
    throwIfRecallAborted(options.abortSignal);

    const enrichmentAssemblyDeadlineAtMs =
      enrichmentSectionDeadlineMs > 0
        ? Date.now() + enrichmentSectionDeadlineMs
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
          : Math.max(0, enrichmentAssemblyDeadlineAtMs - Date.now());
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

    // --- Phase 2: Assemble sections in correct order ---
    this.profiler.startSpan("assembly", profileTraceId);

    // 0. Shared context
    if (sharedCtx)
      this.appendRecallSection(sectionBuckets, "shared-context", sharedCtx);

    // 0a. Explicit cue evidence
    const explicitCueMaxChars =
      this.getRecallSectionMaxChars("explicit-cue") ??
      this.config.explicitCueRecallMaxChars;
    if (
      this.config.explicitCueRecallEnabled &&
      this.isRecallSectionEnabled("explicit-cue") &&
      explicitCueMaxChars !== 0 &&
      this.lcmEngine?.enabled &&
      (recallMode as RecallPlanMode) !== "no_recall"
    ) {
      try {
        const explicitCueSection = await buildExplicitCueRecallSection({
          engine: this.lcmEngine,
          sessionId: sessionKey,
          query: retrievalQuery,
          maxChars: explicitCueMaxChars,
          maxReferences:
            this.getRecallSectionNumber("explicit-cue", "maxResults") ??
            this.config.explicitCueRecallMaxReferences,
        });
        if (explicitCueSection) {
          this.appendRecallSection(
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
      this.getRecallSectionMaxChars("targeted-facts") ??
      this.config.targetedFactRecallMaxChars;
    if (
      this.isSpecializedRecallSectionEnabled(
        "targeted-facts",
        this.config.targetedFactRecallEnabled,
      ) &&
      targetedFactMaxChars !== 0 &&
      this.lcmEngine?.enabled &&
      (recallMode as RecallPlanMode) !== "no_recall" &&
      shouldRecallTargetedFactEvidence(retrievalQuery)
    ) {
      try {
        const targetedFactSection = await buildTargetedFactRecallSection({
          engine: this.lcmEngine,
          sessionId: sessionKey,
          query: retrievalQuery,
          maxChars: targetedFactMaxChars,
          maxSearchResults:
            this.getRecallSectionNumber("targeted-facts", "maxResults") ??
            this.config.targetedFactRecallMaxResults,
          maxScanWindowTurns:
            this.getRecallSectionNumber("targeted-facts", "maxTurns") ??
            this.config.targetedFactRecallScanWindowTurns,
          maxScanWindowTokens:
            this.getRecallSectionNumber("targeted-facts", "maxTokens") ??
            this.config.targetedFactRecallScanWindowTokens,
        });
        if (targetedFactSection) {
          this.appendRecallSection(
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
      this.getRecallSectionMaxChars("focused-list") ??
      this.config.focusedListRecallMaxChars;
    if (
      this.isSpecializedRecallSectionEnabled(
        "focused-list",
        this.config.focusedListRecallEnabled,
      ) &&
      focusedListMaxChars !== 0 &&
      this.lcmEngine?.enabled &&
      (recallMode as RecallPlanMode) !== "no_recall" &&
      shouldRecallFocusedListEvidence(retrievalQuery)
    ) {
      try {
        const focusedListSection = await buildFocusedListRecallSection({
          engine: this.lcmEngine,
          sessionId: sessionKey,
          query: retrievalQuery,
          maxChars: focusedListMaxChars,
          maxSearchResults:
            this.getRecallSectionNumber("focused-list", "maxResults") ??
            this.config.focusedListRecallMaxResults,
          maxScanWindowTurns:
            this.getRecallSectionNumber("focused-list", "maxTurns") ??
            this.config.focusedListRecallScanWindowTurns,
          maxScanWindowTokens:
            this.getRecallSectionNumber("focused-list", "maxTokens") ??
            this.config.focusedListRecallScanWindowTokens,
        });
        if (focusedListSection) {
          this.appendRecallSection(
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
      this.getRecallSectionMaxChars("response-guidance") ??
      this.config.responseGuidanceRecallMaxChars;
    const responseGuidanceEntry = this.getRecallSectionEntry("response-guidance");
    const responseGuidanceMatchesQuery = shouldRecallResponseGuidance(retrievalQuery);
    const responseGuidanceForcedByPipeline =
      responseGuidanceEntry?.forceGeneric === true && !responseGuidanceMatchesQuery;
    if (
      this.isSpecializedRecallSectionEnabled(
        "response-guidance",
        this.config.responseGuidanceRecallEnabled,
      ) &&
      responseGuidanceMaxChars !== 0 &&
      this.lcmEngine?.enabled &&
      (recallMode as RecallPlanMode) !== "no_recall" &&
      (responseGuidanceMatchesQuery || responseGuidanceForcedByPipeline)
    ) {
      try {
        const responseGuidanceSection = await buildResponseGuidanceRecallSection({
          engine: this.lcmEngine,
          sessionId: sessionKey,
          query: retrievalQuery,
          maxChars: responseGuidanceMaxChars,
          maxSearchResults:
            this.getRecallSectionNumber("response-guidance", "maxResults") ??
            this.config.responseGuidanceRecallMaxResults,
          maxScanWindowTurns:
            this.getRecallSectionNumber("response-guidance", "maxTurns") ??
            this.config.responseGuidanceRecallScanWindowTurns,
          maxScanWindowTokens:
            this.getRecallSectionNumber("response-guidance", "maxTokens") ??
            this.config.responseGuidanceRecallScanWindowTokens,
          forceGeneric: responseGuidanceForcedByPipeline,
        });
        if (responseGuidanceSection) {
          this.appendRecallSection(
            sectionBuckets,
            "response-guidance",
            responseGuidanceSection,
          );
        }
      } catch (err) {
        log.debug(`Response guidance recall assembly error: ${err}`);
      }
    }

    // 0e. Chronological event-order evidence. This recovers ordered user
    // turns for prompts asking how topics unfolded across a conversation.
    const eventOrderMaxChars =
      this.getRecallSectionMaxChars("event-order") ??
      this.config.eventOrderRecallMaxChars;
    if (
      this.isSpecializedRecallSectionEnabled(
        "event-order",
        this.config.eventOrderRecallEnabled,
      ) &&
      eventOrderMaxChars !== 0 &&
      this.lcmEngine?.enabled &&
      (recallMode as RecallPlanMode) !== "no_recall" &&
      shouldRecallEventOrderEvidence(retrievalQuery)
    ) {
      try {
        const eventOrderSection = await buildEventOrderRecallSection({
          engine: this.lcmEngine,
          sessionId: sessionKey,
          query: retrievalQuery,
          maxChars: eventOrderMaxChars,
          maxItems:
            this.getRecallSectionNumber("event-order", "maxResults") ??
            this.config.eventOrderRecallMaxResults,
          maxScanWindowTurns:
            this.getRecallSectionNumber("event-order", "maxTurns") ??
            this.config.eventOrderRecallScanWindowTurns,
          maxScanWindowTokens:
            this.getRecallSectionNumber("event-order", "maxTokens") ??
            this.config.eventOrderRecallScanWindowTokens,
        });
        if (eventOrderSection) {
          this.appendRecallSection(
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
      this.appendRecallSection(
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
      const peerSectionAppended = this.appendRecallSection(
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
      this.appendRecallSection(
        sectionBuckets,
        "calibration-rules",
        calibrationSection,
      );
    }

    if (procedureRecallSection) {
      this.appendRecallSection(
        sectionBuckets,
        "procedure-recall",
        procedureRecallSection,
      );
    }

    // 1a. Identity continuity
    if (identityContinuity) {
      this.appendRecallSection(
        sectionBuckets,
        "identity-continuity",
        identityContinuity.section,
      );
      identityInjectionModeUsed = identityContinuity.mode;
      identityInjectedChars = identityContinuity.injectedChars;
      identityInjectionTruncated = identityContinuity.truncated;
    }

    if (entityRetrievalSection) {
      this.appendRecallSection(
        sectionBuckets,
        "entity-retrieval",
        entityRetrievalSection,
      );
    }

    // 1b. Knowledge Index
    if (kiResult?.result) {
      this.appendRecallSection(
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
      this.appendRecallSection(
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
        return `- [${artifactType}] "${this.truncateArtifactForRecall(a.content)}" (${created})`;
      });
      this.appendRecallSection(
        sectionBuckets,
        "verbatim-artifacts",
        `## Verbatim Artifacts\n\n${lines.join("\n")}`,
      );
    }

    // 1d. Memory Boxes (topic continuity windows, v8.0 Phase 2A)
    // recentBoxesPromise was kicked off before phase-1 so it ran concurrently.
    {
      const recentBoxes = await recentBoxesPromise;
      if (recentBoxes.length > 0) {
        const boxLines = recentBoxes.slice(0, 5).map((b: BoxFrontmatter) => {
          const sealedDate = b.sealedAt
            ? b.sealedAt.slice(0, 16).replace("T", " ")
            : "?";
          const traceNote = b.traceId
            ? ` [trace: ${b.traceId.slice(0, 12)}]`
            : "";
          return `- [${sealedDate}${traceNote}] Topics: ${b.topics.join(", ")} (${b.memoryIds.length} memories)`;
        });
        this.appendRecallSection(
          sectionBuckets,
          "memory-boxes",
          `## Recent Topic Windows\n\n${boxLines.join("\n")}`,
        );
      }
    }

    // 1e. TMT node (temporal memory tree, v8.2)
    if (
      this.isRecallSectionEnabled(
        "temporal-memory-tree",
        this.config.temporalMemoryTreeEnabled === true,
      ) &&
      this.config.temporalMemoryTreeEnabled &&
      recallMode !== "minimal" &&
      (recallMode as RecallPlanMode) !== "no_recall"
    ) {
      const tmtNode = await this.tmtBuilder.getMostRelevantNode();
      if (tmtNode) {
        const levelLabel =
          tmtNode.level.charAt(0).toUpperCase() + tmtNode.level.slice(1);
        this.appendRecallSection(
          sectionBuckets,
          "temporal-memory-tree",
          `## Memory Timeline (${levelLabel})\n\n${tmtNode.summary}`,
        );
      }
    }

    // LCM compressed history section
    if (
      this.lcmEngine?.enabled &&
      recallMode !== "minimal" &&
      (recallMode as RecallPlanMode) !== "no_recall"
    ) {
      try {
        const structuredMatches = await this.lcmEngine.searchStructuredParts(
          sessionKey ?? "default",
          retrievalQuery,
        );
        const structuredSection = this.lcmEngine.formatStructuredRecall(
          structuredMatches,
          Math.ceil(this.config.recallBudgetChars * 0.08),
        );
        if (structuredSection) {
          const structuredAppended = this.appendRecallSection(
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
        const lcmSection = await this.lcmEngine.assembleRecall(
          sessionKey ?? "default",
          this.config.recallBudgetChars,
        );
        if (lcmSection) {
          this.appendRecallSection(
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
      this.appendRecallSection(
        sectionBuckets,
        "objective-state",
        objectiveStateSection,
      );
    }

    if (causalTrajectorySection) {
      this.appendRecallSection(
        sectionBuckets,
        "causal-trajectories",
        causalTrajectorySection,
      );
    }

    if (cmcCausalChainsSection) {
      this.appendRecallSection(
        sectionBuckets,
        "cmc-causal-chains",
        cmcCausalChainsSection,
      );
    }

    if (trustZoneSection) {
      this.appendRecallSection(sectionBuckets, "trust-zones", trustZoneSection);
    }

    const harmonicRetrievalSection = await awaitEnrichmentSection(
      "harmonic",
      harmonicRetrievalPromise,
    );
    if (harmonicRetrievalSection) {
      this.appendRecallSection(
        sectionBuckets,
        "harmonic-retrieval",
        harmonicRetrievalSection,
      );
    }

    if (verifiedRecallSection) {
      this.appendRecallSection(
        sectionBuckets,
        "verified-episodes",
        verifiedRecallSection,
      );
    }

    if (verifiedRulesSection) {
      this.appendRecallSection(
        sectionBuckets,
        "verified-rules",
        verifiedRulesSection,
      );
    }

    if (workProductsSection) {
      this.appendRecallSection(
        sectionBuckets,
        "work-products",
        workProductsSection,
      );
    }

    // 2. QMD results — post-process and format
    const qmdResult = await awaitEnrichmentSection("qmd", qmdPromise);
    if (qmdResult) {
      const t0 = Date.now();
      const {
        memoryResultsLists,
        globalResults,
        preAugmentTopScore,
        maxSpecializedScore,
      } = qmdResult;

      // Merge/dedupe by path; keep the best score and first non-empty snippet.
      const memoryResultsRaw = mergeGraphExpandedResults(
        memoryResultsLists.flat(),
        [],
      );

      let memoryResults = memoryResultsRaw;

      // Enforce namespace read policies by filtering paths.
      if (this.config.namespacesEnabled) {
        memoryResults = memoryResults.filter((r) =>
          recallNamespaces.includes(this.namespaceFromPath(r.path)),
        );
      }
      // Artifacts are injected through dedicated verbatim recall flow only.
      memoryResults = memoryResults.filter(
        (r) => !isArtifactMemoryPath(r.path),
      );

      const isFullModeGraphAssist =
        this.config.multiGraphMemoryEnabled &&
        this.config.graphAssistInFullModeEnabled !== false &&
        recallMode === "full" &&
        memoryResults.length >=
          Math.max(1, this.config.graphAssistMinSeedResults ?? 3);
      const shouldRunGraphExpansion =
        recallMode === "graph_mode" || isFullModeGraphAssist;
      const graphShadowEvalEnabled =
        isFullModeGraphAssist &&
        this.config.graphAssistShadowEvalEnabled === true;
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
            const {
              merged,
              seedPaths,
              expandedPaths,
              seedResults = baselineMemoryResults,
            } = await this.expandResultsViaGraph({
              memoryResults,
              recallNamespaces,
              recallResultLimit,
              ...(options.includeLowConfidence === true ? { includeLowConfidence: true } : {}),
            });
            graphSnapshotStatus = "completed";
            graphDecisionStatus = "completed";
            graphDecisionReason = graphShadowEvalEnabled
              ? "graph shadow evaluation completed without altering injected context"
              : "graph expansion merged into recall ranking";
            graphSnapshotReason = graphDecisionReason;
            graphSnapshotSeedPaths = seedPaths;
            graphSnapshotExpandedPaths = expandedPaths;
            graphSnapshotSeedResults = this.buildGraphRecallRankedResults(
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
          } catch (err) {
            graphSnapshotStatus = "aborted";
            graphDecisionStatus = "aborted";
            graphDecisionReason = `graph expansion failed: ${err instanceof Error ? err.message : String(err)}`;
            graphSnapshotReason = graphDecisionReason;
            graphSnapshotSeedPaths = baselineMemoryResults
              .slice(0, Math.max(1, recallResultLimit))
              .map((result) => result.path);
            graphSnapshotSeedResults = this.buildGraphRecallRankedResults(
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

      // Apply recency and access count boosting
      memoryResults = await this.boostSearchResults(
        memoryResults,
        recallNamespaces,
        retrievalQuery,
        undefined,
        { asOfMs },
      );

      // Optional LLM reranking (default off). Fail-open if rerank fails/slow.
      if (this.config.rerankEnabled && this.config.rerankProvider === "local") {
        const ranked = await rerankLocalOrNoop({
          query: retrievalQuery,
          candidates: memoryResults
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
          cacheEnabled: this.config.rerankCacheEnabled,
          cacheTtlMs: this.config.rerankCacheTtlMs,
        });
        if (ranked && ranked.length > 0) {
          const byPath = new Map(memoryResults.map((r) => [r.path, r]));
          const reordered: QmdSearchResult[] = [];
          for (const p of ranked) {
            const it = byPath.get(p);
            if (it) reordered.push(it);
          }
          // Append any unranked items in original order.
          const rankedSet = new Set(ranked);
          for (const r of memoryResults) {
            if (!rankedSet.has(r.path)) reordered.push(r);
          }
          memoryResults = reordered;
        }
      }
      if (this.config.rerankEnabled && this.config.rerankProvider === "cloud") {
        log.debug(
          "rerankProvider=cloud is reserved/experimental in v2.2.0; skipping rerank",
        );
      }

      // Memory Worth recall filter (issue #560 PR 4). When enabled, multiply
      // each candidate's score by its Memory Worth factor so memories with
      // a history of failed outcomes sink. Default off in this PR; PR 5
      // flips the default once bench shows tie-or-win. Fail-open: any
      // lookup error leaves the original scores untouched rather than
      // breaking recall for the whole namespace.
      if (this.config.recallMemoryWorthFilterEnabled && memoryResults.length > 0) {
        try {
          memoryResults = await this.applyMemoryWorthRerank(memoryResults, recallNamespaces);
        } catch (err) {
          log.debug("memory-worth filter failed open", { error: (err as Error).message });
        }
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
      if (this.config.recallConfidenceGateEnabled && effectiveGateScore > 0) {
        if (effectiveGateScore < this.config.recallConfidenceGateThreshold) {
          log.debug(
            `recall: confidence gate rejected ${memoryResults.length} results (effective score ${effectiveGateScore.toFixed(3)} below ${this.config.recallConfidenceGateThreshold})`,
          );
          memoryResults = [];
          confidenceGateRejected = true;
        }
      }

      // Diversify via MMR over the full candidate pool *before* truncating to
      // the final recall limit. Running MMR after the slice would be unable
      // to promote diverse candidates sitting just below the cutoff.
      memoryResults = this.diversifyAndLimitRecallResults(
        "memories",
        memoryResults,
        recallResultLimit,
        retrievalQuery,
      );

      // E-Mem-inspired memory reconstruction: fill gaps for referenced entities
      if (this.config.memoryReconstructionEnabled && memoryResults.length > 0) {
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
            const budget = this.config.memoryReconstructionMaxExpansions;
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
          graphSnapshotFinalResults = this.buildGraphRecallRankedResults(
            memoryResults,
            graphSourceLabelsForPath,
          );
        }
        recallSource = "hot_qmd";
        recalledMemoryCount = memoryResults.length;
        this.publishRecallResults({
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
        });
        recalledMemoryIds = this.extractMemoryIdsFromResults(memoryResults);
        recalledMemoryPaths = memoryResults
          .map((result) => result.path)
          .filter(Boolean);
        xrayRecalledResults = memoryResults;
        impressionRecorded = true;
      } else if (!confidenceGateRejected) {
        // Only attempt fallback paths if the confidence gate did NOT fire.
        // When the gate rejects, all recall pathways are skipped to prevent
        // low-relevance results from polluting context.
        const queryAwarePrefilter = await queryAwarePrefilterPromise;
        const embeddingResults = await this.searchEmbeddingFallback(
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
            namespacesEnabled: this.config.namespacesEnabled,
            recallNamespaces,
            resolveNamespace: (p) => this.namespaceFromPath(p),
            limit: embeddingFetchLimit,
          },
        );
        const boostedScoped = await this.boostSearchResults(
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
        const scoped = this.diversifyAndLimitRecallResults(
          "memories",
          boostedScoped,
          recallResultLimit,
          retrievalQuery,
        );
        if (scoped.length > 0) {
          if (shouldPersistGraphSnapshot) {
            graphSnapshotFinalResults = this.buildGraphRecallRankedResults(
              scoped,
              graphSourceLabelsForPath,
            );
          }
          recallSource = "hot_embedding";
          recalledMemoryCount = scoped.length;
          this.publishRecallResults({
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
          });
          recalledMemoryIds = this.extractMemoryIdsFromResults(scoped);
          recalledMemoryPaths = scoped
            .map((result) => result.path)
            .filter(Boolean);
          xrayRecalledResults = scoped;
          impressionRecorded = true;
        } else {
          const longTerm = await this.applyColdFallbackPipeline({
            prompt: retrievalQuery,
            recallNamespaces,
            recallResultLimit,
            recallMode,
            queryAwarePrefilter,
            abortSignal: options.abortSignal,
            xrayPoolSizeSink: xrayColdPoolSink,
            asOfMs,
            ...(options.includeLowConfidence === true ? { includeLowConfidence: true } : {}),
          });
          if (longTerm.length > 0) {
            if (shouldPersistGraphSnapshot) {
              graphSnapshotFinalResults = this.buildGraphRecallRankedResults(
                longTerm,
                graphSourceLabelsForPath,
              );
            }
            recallSource = "cold_fallback";
            recalledMemoryCount = longTerm.length;
            this.publishRecallResults({
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
            });
            recalledMemoryIds = this.extractMemoryIdsFromResults(longTerm);
            recalledMemoryPaths = longTerm
              .map((result) => result.path)
              .filter(Boolean);
            xrayRecalledResults = longTerm;
            impressionRecorded = true;
          }
        }
      }

      if (globalResults.length > 0) {
        this.appendRecallSection(
          sectionBuckets,
          "workspace-context",
          this.formatQmdResults("Workspace Context", globalResults),
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
        this.appendRecallSection(
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
    } else if (recallResultLimit > 0 && !this.qmd.isAvailable()) {
      // Fallback: embeddings first, then recency-only.
      const queryAwarePrefilter = await queryAwarePrefilterPromise;
      const embeddingResults = await this.searchEmbeddingFallback(
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
          namespacesEnabled: this.config.namespacesEnabled,
          recallNamespaces,
          resolveNamespace: (p) => this.namespaceFromPath(p),
          limit: embeddingFetchLimit,
        },
      );
      const boostedScoped = await this.boostSearchResults(
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
      const scoped = this.diversifyAndLimitRecallResults(
        "memories",
        boostedScoped,
        recallResultLimit,
        retrievalQuery,
      );
      if (scoped.length > 0) {
        if (shouldPersistGraphSnapshot) {
          graphSnapshotFinalResults = this.buildGraphRecallRankedResults(
            scoped,
            graphSourceLabelsForPath,
          );
        }
        recallSource = "hot_embedding";
        recalledMemoryCount = scoped.length;
        this.publishRecallResults({
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
        });
        recalledMemoryIds = this.extractMemoryIdsFromResults(scoped);
        recalledMemoryPaths = scoped
          .map((result) => result.path)
          .filter(Boolean);
        xrayRecalledResults = scoped;
        impressionRecorded = true;
      } else {
        const memories =
          await this.readAllMemoriesForNamespaces(recallNamespaces);
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
            enabled: this.config.temporalSupersessionEnabled,
            includeInRecall: this.config.temporalSupersessionIncludeInRecall,
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
              if (isArtifactMemoryPath(m.path)) return false;
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
            const longTerm = await this.applyColdFallbackPipeline({
              prompt: retrievalQuery,
              recallNamespaces,
              recallResultLimit,
              recallMode,
              queryAwarePrefilter,
              abortSignal: options.abortSignal,
              xrayPoolSizeSink: xrayColdPoolSink,
              asOfMs,
              ...(options.includeLowConfidence === true ? { includeLowConfidence: true } : {}),
            });
            if (longTerm.length > 0) {
              recallSource = "cold_fallback";
              recalledMemoryCount = longTerm.length;
              this.publishRecallResults({
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
              });
              recalledMemoryIds = this.extractMemoryIdsFromResults(longTerm);
              recalledMemoryPaths = longTerm
                .map((result) => result.path)
                .filter(Boolean);
              xrayRecalledResults = longTerm;
              impressionRecorded = true;
            }
          } else {
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
                snippet: m.content,
                score: 1.0 - i / Math.max(recentSorted.length, 1),
              }),
            );
            const boostedRecent = (
              await this.boostSearchResults(
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
            const recent = this.diversifyAndLimitRecallResults(
              "memories",
              boostedRecent,
              recallResultLimit,
              retrievalQuery,
            );

            if (recent.length > 0) {
              if (shouldPersistGraphSnapshot) {
                graphSnapshotFinalResults = this.buildGraphRecallRankedResults(
                  recent,
                  graphSourceLabelsForPath,
                );
              }
              recallSource = "recent_scan";
              recalledMemoryCount = recent.length;
              this.publishRecallResults({
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
              });
              recalledMemoryIds = this.extractMemoryIdsFromResults(recent);
              recalledMemoryPaths = recent
                .map((result) => result.path)
                .filter(Boolean);
              xrayRecalledResults = recent;
              impressionRecorded = true;
            } else {
              const longTerm = await this.applyColdFallbackPipeline({
                prompt: retrievalQuery,
                recallNamespaces,
                recallResultLimit,
                recallMode,
                queryAwarePrefilter,
                abortSignal: options.abortSignal,
                xrayPoolSizeSink: xrayColdPoolSink,
                asOfMs,
                ...(options.includeLowConfidence === true ? { includeLowConfidence: true } : {}),
              });
              if (longTerm.length > 0) {
                if (shouldPersistGraphSnapshot) {
                  graphSnapshotFinalResults =
                    this.buildGraphRecallRankedResults(
                      longTerm,
                      graphSourceLabelsForPath,
                    );
                }
                recallSource = "cold_fallback";
                recalledMemoryCount = longTerm.length;
                this.publishRecallResults({
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
                });
                recalledMemoryIds = this.extractMemoryIdsFromResults(longTerm);
                recalledMemoryPaths = longTerm
                  .map((result) => result.path)
                  .filter(Boolean);
                xrayRecalledResults = longTerm;
                impressionRecorded = true;
              }
            }
          }
        } else {
          const longTerm = await this.applyColdFallbackPipeline({
            prompt: retrievalQuery,
            recallNamespaces,
            recallResultLimit,
            recallMode,
            queryAwarePrefilter,
            abortSignal: options.abortSignal,
            xrayPoolSizeSink: xrayColdPoolSink,
            asOfMs,
            ...(options.includeLowConfidence === true ? { includeLowConfidence: true } : {}),
          });
          if (longTerm.length > 0) {
            if (shouldPersistGraphSnapshot) {
              graphSnapshotFinalResults = this.buildGraphRecallRankedResults(
                longTerm,
                graphSourceLabelsForPath,
              );
            }
            recallSource = "cold_fallback";
            recalledMemoryCount = longTerm.length;
            this.publishRecallResults({
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
            });
            recalledMemoryIds = this.extractMemoryIdsFromResults(longTerm);
            recalledMemoryPaths = longTerm
              .map((result) => result.path)
              .filter(Boolean);
            xrayRecalledResults = longTerm;
            impressionRecorded = true;
          }
        }
      }

      if (isDisagreementPrompt(prompt)) {
        this.appendRecallSection(
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
      await this.recordLastGraphRecallSnapshot({
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
    await this.recordLastIntentSnapshot({
      storage: profileStorage,
      snapshot: buildIntentDebugSnapshot(),
    });

    // 2.5. Compression guideline recall section (v8.11 Task 5)
    if (
      this.isRecallSectionEnabled(
        "compression-guidelines",
        this.config.compressionGuidelineLearningEnabled === true,
      )
    ) {
      const compressionGuidelineSection =
        await this.buildCompressionGuidelineRecallSection();
      if (compressionGuidelineSection) {
        this.appendRecallSection(
          sectionBuckets,
          "compression-guidelines",
          compressionGuidelineSection,
        );
      }
    }

    // 3. Transcript/summaries/conversation/compounding are fetched in parallel above,
    // then assembled here according to recallPipeline order.
    if (transcriptSection) {
      this.appendRecallSection(sectionBuckets, "transcript", transcriptSection);
    }
    // Compaction reset context — independent section so it works even when transcript is disabled.
    if (compactionSection) {
      this.appendRecallSection(
        sectionBuckets,
        "compaction-reset",
        compactionSection,
      );
    }
    if (summariesSection) {
      this.appendRecallSection(sectionBuckets, "summaries", summariesSection);
    }
    if (conversationRecallSection) {
      this.appendRecallSection(
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
      this.appendRecallSection(
        sectionBuckets,
        "compounding",
        compoundingSection,
      );
    }

    // 5. Inject most relevant question (if enabled) (existing)
    if (
      this.config.injectQuestions &&
      this.isRecallSectionEnabled("questions", true)
    ) {
      const questions = await profileStorage.readQuestions({
        unresolvedOnly: true,
      });
      if (questions.length > 0) {
        // Find the most relevant question to the current prompt
        // Simple approach: use the highest-priority unresolved question
        // TODO: Could use QMD search to find the most contextually relevant one
        const topQuestion = questions[0]; // Already sorted by priority desc
        this.appendRecallSection(
          sectionBuckets,
          "questions",
          `## Open Question\n\nSomething I've been curious about: ${topQuestion.question}\n\n_Context: ${topQuestion.context}_`,
        );
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
    this.profiler.endSpan("assembly", profileTraceId);
    log.info(
      `recall phase-2 checkpoints: afterQmd=${phase2AfterQmdMs}ms, afterQuestions=${phase2QuestionsDoneMs}ms, afterQap=${phase2QapDoneMs}ms`,
    );
    const timingParts = Object.entries(timings)
      .map(([k, v]) => `${k}=${v}`)
      .join(", ");
    log.info(`recall timings: ${timingParts}`);

    const assembledRecall = this.assembleRecallSections(
      sectionBuckets,
      options.budgetCharsOverride,
    );
    const context =
      assembledRecall.sections.length === 0
        ? ""
        : assembledRecall.sections.join("\n\n---\n\n");
    const sourcesUsed = this.collectLastRecallSources(
      sectionBuckets,
      recallSource,
    );
    const budgetsApplied = this.buildLastRecallBudgetSummary({
      requestedTopK,
      recallResultLimit,
      qmdFetchLimit,
      qmdHybridFetchLimit,
      finalContextChars: assembledRecall.finalChars,
      truncated: assembledRecall.truncated,
      includedSections: assembledRecall.includedIds,
      omittedSections: assembledRecall.omittedIds,
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
          const match = p.match(/([^/]+)\.md$/);
          return match ? match[1] ?? null : null;
        };
        // Build a path → QmdSearchResult index so we can pull per-result
        // explain data (e.g. reinforcementBoost) from the result that
        // boostSearchResults annotated before surfacing to xray.
        const xrayResultByPath = new Map<string, QmdSearchResult>(
          xrayRecalledResults.map((xr) => [xr.path, xr]),
        );
        const results: RecallXrayResult[] = [];
        for (const recalledPath of recalledMemoryPaths) {
          const derivedId = idFromPath(recalledPath);
          if (!derivedId) continue;
          const xrayResult = xrayResultByPath.get(recalledPath);
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
          const resultNamespace = this.namespaceFromPath(recalledPath);
          let provenance: RecallXrayResult["provenance"] | undefined;
          try {
            const resultStorage =
              await this.storageRouter.storageFor(resultNamespace);
            const memory = await resultStorage.readMemoryByPath(recalledPath);
            if (memory) {
              provenance = buildRetrievedMemoryProvenance(memory, {
                namespace: resultNamespace,
                retrievalReason: `served-by=${servedBy}`,
                currentContextScopes: options.currentContextScopes,
              });
            }
          } catch {
            // X-ray capture is best-effort; missing provenance must not
            // perturb recall or suppress the surfaced result.
          }
          results.push({
            memoryId: derivedId,
            path: recalledPath,
            servedBy,
            scoreDecomposition,
            admittedBy: [],
            ...(provenance ? { provenance } : {}),
          });
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
        this.lastXraySnapshot = buildXraySnapshot({
          query: retrievalQuery,
          tierExplain: null,
          results: [...results, ...lcmStructuredXrayResults],
          filters,
          budget: {
            chars: this.getRecallBudgetChars(options.budgetCharsOverride),
            used: assembledRecall.finalChars,
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
      this.lastRecall
        .record({
          sessionKey,
          query: retrievalQuery,
          memoryIds: recalledMemoryIds,
          namespace: selfNamespace,
          traceId,
          plannerMode: recallMode,
          requestedMode,
          source: recallSource,
          fallbackUsed: recallSource !== "none" && recallSource !== "hot_qmd",
          sourcesUsed,
          budgetsApplied,
          latencyMs: Date.now() - recallStart,
          resultPaths: recalledMemoryPaths,
          policyVersion,
          appendImpression:
            impressionRecorded ||
            recalledMemoryIds.length > 0 ||
            this.config.recordEmptyRecallImpressions,
          identityInjection: {
            mode: identityInjectionModeUsed,
            injectedChars: identityInjectedChars,
            truncated: identityInjectionTruncated,
          },
        })
        .catch((err) => log.debug(`last recall record failed: ${err}`));
    }
    if (sessionKey) {
      this.queueEvalShadowRecall({
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
    this.emitTrace({
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
      qmdEnabled: this.config.qmdEnabled,
      qmdAvailable: this.qmd.isAvailable(),
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
        this.config.traceRecallContent && context.length > 0
          ? context
          : undefined,
    });

    return context;
    } finally {
      closeProfileTrace();
    }
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
    const turn: BufferTurn = {
      role,
      content,
      timestamp: new Date().toISOString(),
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
    } = {},
  ): Promise<void> {
    if (!Array.isArray(turns) || turns.length === 0) return;

    // Per-batch unique sessionKey keeps threading honest without matching
    // typical prefix/map routing rules.  Combined with writeNamespaceOverride
    // below, the storage target is independent of principal resolution.
    // Uses crypto.randomBytes (not Math.random) so CodeQL does not flag a
    // security-context insecure-randomness use even though this value never
    // leaves the process; the bytes just need to be collision-resistant
    // across concurrent bulk-import batches.
    const sessionKey =
      `bulk-import:batch:${Date.now().toString(36)}-` +
      randomBytes(6).toString("hex");

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
      });
    }
    if (sessionTurns.length === 0) return;

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

    const importTasks = splitTurnsBySourceValidAt(sessionTurns).map(
      (sessionSlice) =>
        new Promise<void>((resolve, reject) => {
          void this.queueBufferedExtraction(sessionSlice, "trigger_mode", {
            skipDedupeCheck: true,
            clearBufferAfterExtraction: false,
            skipCharThreshold: true,
            skipUserTurnThreshold: true,
            bufferKey: sessionKey,
            extractionDeadlineMs: options.deadlineMs,
            writeNamespaceOverride: this.bulkImportWriteNamespace(),
            onTaskSettled: (err) => (err ? reject(err) : resolve()),
          }).catch(reject);
        }),
    );
    const settled = await Promise.allSettled(importTasks);
    const firstRejected = settled.find(
      (result): result is PromiseRejectedResult =>
        result.status === "rejected",
    );
    if (firstRejected) {
      throw firstRejected.reason;
    }
  }

  async observeSessionHeartbeat(
    sessionKey: string,
    options: { bufferKey?: string } = {},
  ): Promise<void> {
    if (this.config.sessionObserverEnabled !== true) return;
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
      onTaskSettled?: (error?: unknown) => void;
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
    } = {},
  ): Promise<void> {
    const bufferKey = options.bufferKey ?? turnsToExtract[0]?.sessionKey ?? "default";
    if (
      !options.skipDedupeCheck &&
      !this.shouldQueueExtraction(turnsToExtract, { bufferKey })
    ) {
      log.debug(`extraction dedupe skip: preserving buffer (${reason})`);
      options.onTaskSettled?.();
      return;
    }

    this.extractionQueue.push(async () => {
      try {
        await this.runExtraction(turnsToExtract, {
          clearBufferAfterExtraction:
            options.clearBufferAfterExtraction ?? true,
          skipCharThreshold: options.skipCharThreshold ?? false,
          skipUserTurnThreshold: options.skipUserTurnThreshold ?? false,
          deadlineMs: options.extractionDeadlineMs,
          bufferKey,
          abortSignal: options.abortSignal,
          writeNamespaceOverride: options.writeNamespaceOverride,
        });
        options.onTaskSettled?.();
      } catch (err) {
        options.onTaskSettled?.(err);
        throw err;
      }
    });

    if (!this.queueProcessing) {
      this.queueProcessing = true;
      this.processQueue().catch((err) => {
        this.logExtractionQueueFailure(err, "processor");
        this.queueProcessing = false;
      });
    }
    log.debug(`queued extraction from ${reason}`);
  }

  private normalizeExtractionFingerprintTurns(turns: BufferTurn[]): string[] {
    if (!Array.isArray(turns) || turns.length === 0) return [];
    return turns
      .filter((turn) => turn.role === "user" || turn.role === "assistant")
      .map((turn) => {
        if (
          typeof turn.turnFingerprint === "string" &&
          turn.turnFingerprint.length > 0
        ) {
          return `fp:${turn.turnFingerprint}`;
        }
        return `${turn.role}:${(turn.content ?? "").replace(/\s+/g, " ").trim().slice(0, this.config.extractionMaxTurnChars)}`;
      })
      .filter((value) => value.length > 0);
  }

  private buildExtractionFingerprint(
    turns: BufferTurn[],
    bufferKey: string,
  ): string | null {
    const normalized = this.normalizeExtractionFingerprintTurns(turns).join("\n");
    if (!normalized) return null;
    return createHash("sha256")
      .update(`${bufferKey}\n${normalized}`)
      .digest("hex");
  }

  private shouldQueueExtraction(
    turns: BufferTurn[],
    options: { commit?: boolean; bufferKey?: string } = {},
  ): boolean {
    if (!this.config.extractionDedupeEnabled) return true;
    if (!Array.isArray(turns) || turns.length === 0) return false;

    const bufferKey = options.bufferKey ?? turns[0]?.sessionKey ?? "default";
    const fingerprint = this.buildExtractionFingerprint(turns, bufferKey);
    if (!fingerprint) return false;
    const now = Date.now();
    const seenAt = this.recentExtractionFingerprints.get(fingerprint);
    if (seenAt && now - seenAt < this.config.extractionDedupeWindowMs) {
      log.debug("extraction dedupe: skipped duplicate buffered turn set");
      return false;
    }

    if (options.commit !== false) {
      this.recentExtractionFingerprints.set(fingerprint, now);
    }
    // Keep this cache bounded to avoid unbounded growth.
    if (
      options.commit !== false &&
      this.recentExtractionFingerprints.size > 200
    ) {
      const entries = Array.from(
        this.recentExtractionFingerprints.entries(),
      ).sort((a, b) => a[1] - b[1]);
      for (const [key] of entries.slice(0, entries.length - 200)) {
        this.recentExtractionFingerprints.delete(key);
      }
    }

    return true;
  }

  /**
   * Background serial queue processor.
   * Processes extractions one at a time to avoid race conditions.
   * Called automatically when items are queued.
   */
  private async processQueue(): Promise<void> {
    while (this.extractionQueue.length > 0) {
      const task = this.extractionQueue.shift();
      if (task) {
        try {
          await task();
        } catch (err) {
          this.logExtractionQueueFailure(err, "task");
        }
      }
    }

    this.queueProcessing = false;
  }

  /**
   * Classify + log a failure from either the per-task catch inside
   * `processQueue()` or the outer `processQueue().catch(...)` in
   * `queueBufferedExtraction()`.  Issue #549: `throwIfRecallAborted`
   * (used throughout `runExtraction`) raises an Error whose `name` is
   * `"AbortError"`.  That path fires when `before_reset` aborts a
   * queued task to avoid duplicate extraction — it is intentional
   * cancellation, not a failure.  Downgrading the log to debug
   * prevents spurious `error`-level lines that routinely appear
   * right next to a successful `persisted: N facts, M entities` log
   * and that confuse operators into thinking extraction is broken.
   * Genuine extraction failures (network, parse, I/O) still log at
   * `error`.
   *
   * Source differentiates the two call sites so the log message
   * names the right layer (`task` vs `processor`).
   */
  private logExtractionQueueFailure(
    err: unknown,
    source: "task" | "processor",
  ): void {
    const aborted =
      source === "task"
        ? "background extraction task aborted (session transition)"
        : "background extraction queue processor aborted (session transition)";
    const failed =
      source === "task"
        ? "background extraction task failed"
        : "background extraction queue processor failed";
    if (isAbortError(err)) {
      log.debug(aborted);
    } else {
      log.error(failed, err);
    }
  }

  private async runExtraction(
    turns: BufferTurn[],
    options: {
      clearBufferAfterExtraction?: boolean;
      skipCharThreshold?: boolean;
      skipUserTurnThreshold?: boolean;
      deadlineMs?: number;
      bufferKey?: string;
      abortSignal?: AbortSignal;
      /**
       * Explicit namespace override for the write path (#460).  When set,
       * extraction writes go to this namespace instead of the one derived
       * from `defaultNamespaceForPrincipal(resolvePrincipal(sessionKey))`.
       * The resolved `principal` is still threaded into memory metadata
       * for provenance; only the storage target is overridden.
       */
      writeNamespaceOverride?: string;
    } = {},
  ): Promise<void> {
    log.debug(`running extraction on ${turns.length} turns`);
    const clearBufferAfterExtraction =
      options.clearBufferAfterExtraction ?? true;
    const skipCharThreshold = options.skipCharThreshold ?? false;
    const skipUserTurnThreshold = options.skipUserTurnThreshold ?? false;
    const deadlineMs =
      typeof options.deadlineMs === "number" &&
      Number.isFinite(options.deadlineMs)
        ? options.deadlineMs
        : undefined;
    const bufferKey = options.bufferKey ?? turns[0]?.sessionKey ?? "default";
    const throwIfDeadlineExceeded = (stage: string): void => {
      if (typeof deadlineMs === "number" && Date.now() > deadlineMs) {
        throw new Error(`replay extraction deadline exceeded (${stage})`);
      }
    };
    const throwIfAborted = (stage: string): void => {
      throwIfRecallAborted(options.abortSignal, `extraction aborted (${stage})`);
    };
    const clearBuffer = async (options?: { ignoreAbort?: boolean }) => {
      if (options?.ignoreAbort !== true) {
        throwIfAborted("before_clear_buffer");
      }
      if (clearBufferAfterExtraction) {
        await this.buffer.clearAfterExtraction(bufferKey, turns);
      }
    };

    // Skip extraction for cron job sessions - these are system operations, not user conversations
    const sessionKey = turns[0]?.sessionKey ?? "";
    if (sessionKey.includes(":cron:")) {
      log.debug(`skipping extraction for cron session: ${sessionKey}`);
      await clearBuffer();
      return;
    }

    const normalizedTurns = turns
      .filter(
        (t) =>
          (t.role === "user" || t.role === "assistant") &&
          typeof t.content === "string",
      )
      .map((t) => ({
        ...t,
        content: t.content.trim().slice(0, this.config.extractionMaxTurnChars),
      }))
      .filter((t) => t.content.length > 0);
    const targetTurns = normalizedTurns.filter(
      (turn) => turn.extractionContextOnly !== true,
    );
    if (targetTurns.length === 0) {
      log.debug("skipping extraction: no non-context turns after normalization");
      await clearBuffer();
      return;
    }
    const sourceValidAt = latestSourceValidAtFromTurns(targetTurns);
    throwIfDeadlineExceeded("before_extract");
    throwIfAborted("before_extract");

    const userTurns = targetTurns.filter((t) => t.role === "user");
    const totalChars = targetTurns.reduce(
      (sum, t) => sum + t.content.length,
      0,
    );
    const belowCharThreshold = totalChars < this.config.extractionMinChars;
    const belowUserTurnThreshold =
      !skipUserTurnThreshold &&
      userTurns.length < this.config.extractionMinUserTurns;
    if ((!skipCharThreshold && belowCharThreshold) || belowUserTurnThreshold) {
      log.debug(
        `skipping extraction: below threshold (totalChars=${totalChars}, userTurns=${userTurns.length})`,
      );
      await clearBuffer();
      return;
    }

    const principal = resolvePrincipal(sessionKey, this.config);
    // Write path — overlay the coding-agent namespace (issue #569) when the
    // session has a codingContext and `codingMode.projectScope` is true.
    // Explicit `writeNamespaceOverride` from callers still wins, matching
    // pre-#569 semantics.
    const selfNamespace =
      typeof options.writeNamespaceOverride === "string" &&
      options.writeNamespaceOverride.length > 0
        ? options.writeNamespaceOverride
        : this.applyCodingNamespaceOverlay(
            sessionKey,
            defaultNamespaceForPrincipal(principal, this.config),
          );
    const storage = await this.storageRouter.storageFor(selfNamespace);
    const shouldPersistProcessedFingerprint = targetTurns.some(
      (turn) => turn.persistProcessedFingerprint === true,
    );
    const extractionFingerprint = this.buildExtractionFingerprint(
      targetTurns,
      bufferKey,
    );
    let meta =
      extractionFingerprint && shouldPersistProcessedFingerprint
        ? await storage.loadMeta()
        : null;
    if (
      extractionFingerprint &&
      shouldPersistProcessedFingerprint &&
      (meta?.processedExtractionFingerprints ?? []).some(
        (entry) => entry.fingerprint === extractionFingerprint,
      )
    ) {
      log.debug(
        `runExtraction: skipping already-processed extraction fingerprint for ${bufferKey}`,
      );
      await clearBuffer();
      return;
    }

    // Pass existing entity names so the LLM can reuse them instead of inventing variants
    const existingEntities = await storage.listEntityNames();
    const result = await raceRecallAbort(
      this.extraction.extract(
        normalizedTurns,
        existingEntities,
      ),
      options.abortSignal,
      "extraction aborted (during_extract)",
    );
    throwIfDeadlineExceeded("before_persist");
    throwIfAborted("before_persist");

    // Defensive: validate extraction result before processing
    if (!result) {
      log.warn("runExtraction: extraction returned null/undefined");
      await clearBuffer();
      return;
    }
    if (!Array.isArray(result.facts)) {
      log.warn(
        "runExtraction: extraction returned invalid facts (not an array)",
        { factsType: typeof result.facts, resultKeys: Object.keys(result) },
      );
      await clearBuffer();
      return;
    }
    if (
      result.facts.length === 0 &&
      result.entities.length === 0 &&
      result.questions.length === 0 &&
      result.profileUpdates.length === 0
    ) {
      log.debug(
        "runExtraction: extraction produced no durable outputs; skipping persistence",
      );
      await clearBuffer();
      return;
    }

    let threadIdForExtraction: string | null = null;
    if (this.config.threadingEnabled && turns.length > 0) {
      const lastTurn = turns[turns.length - 1];
      try {
        threadIdForExtraction = await this.threading.processTurn(lastTurn, []);
      } catch (err) {
        // Fail-open: threading errors must not block memory persistence.
        log.warn(
          "[threading] processTurn failed before persistence (non-fatal)",
          err,
        );
      }
    }

    const persistedIds = await this.persistExtraction(
      result,
      storage,
      threadIdForExtraction,
      { sessionKey, principal, validAt: sourceValidAt },
    );
    meta ??= await storage.loadMeta();
    if (extractionFingerprint && shouldPersistProcessedFingerprint) {
      try {
        await this.recordProcessedExtractionFingerprint(
          storage,
          extractionFingerprint,
          meta,
        );
      } catch (error) {
        log.warn(
          "runExtraction: failed to persist processed extraction fingerprint; continuing with buffer clear",
          error,
        );
      }
    }
    // Persist extraction counters and processed fingerprints before running
    // follow-on helpers so replay dedupe survives any later non-essential
    // failure. If this aggregate meta write fails, still clear the buffer:
    // the durable memories are already written and replaying the same turns
    // would duplicate them.
    meta.extractionCount += 1;
    meta.lastExtractionAt = new Date().toISOString();
    meta.totalMemories += Array.isArray(result?.facts)
      ? result.facts.length
      : 0;
    meta.totalEntities += Array.isArray(result?.entities)
      ? result.entities.length
      : 0;
    let postPersistMetaError: unknown;
    try {
      await storage.saveMeta(meta);
    } catch (error) {
      postPersistMetaError = error;
    }

    // Buffer retention for defer verdicts (issue #562, PR 2). When the judge
    // deferred at least one candidate, retain the tail of the current turn
    // window so the next extraction pass has the surrounding context that
    // may disambiguate the deferred fact. Non-defer runs clear the slot.
    //
    // Gated on:
    //   - `clearBufferAfterExtraction` — replay / bulk-import paths call
    //     `runExtraction` with this false and do not operate on live buffer
    //     state. Writing retention there would create synthetic buffer
    //     entries and cross-contaminate future live extractions.
    //   - NOT `extractionJudgeShadow` — in shadow mode the judge is only
    //     advisory; facts are still persisted regardless of verdict, so
    //     retaining the turn window on top of a persisted write would both
    //     waste buffer space and cause the same facts to re-enter the
    //     pipeline on the next pass.
    try {
      if (
        clearBufferAfterExtraction &&
        !this.config.extractionJudgeShadow
      ) {
        const deferredCount = this.lastPersistExtractionDeferredCount;
        if (deferredCount > 0 && normalizedTurns.length > 0) {
          await this.buffer.retainDeferredTurns(
            bufferKey,
            normalizedTurns as BufferTurn[],
            10,
          );
        } else {
          await this.buffer.retainDeferredTurns(bufferKey, [], 0);
        }
      }
    } catch (err) {
      // Fail-open: retention is a nice-to-have. If it fails the judge will
      // still cap deferrals and convert to reject on the next pass.
      log.debug(
        `extraction-judge: defer retention failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    await clearBuffer({ ignoreAbort: true });

    // Build memory box from this extraction (v8.0 Phase 2A)
    // Topics are derived from the current extraction's facts and entities only —
    // not from readAllMemories() — so box topics accurately reflect the current
    // session window and the call is free of expensive full-corpus I/O.
    if (this.config.memoryBoxesEnabled && persistedIds.length > 0) {
      const extractionTopics = deriveTopicsFromExtraction(result);
      // Derive episodic metadata from buffer turns (REMem-inspired)
      const firstUserTurn = turns.find((t) => t.role === "user");
      const boxGoal =
        firstUserTurn?.content?.slice(0, 100)?.trim() || undefined;
      await this.boxBuilderFor(storage)
        .onExtraction({
          topics: extractionTopics,
          memoryIds: persistedIds,
          timestamp: new Date().toISOString(),
          goal: boxGoal,
        })
        .catch((err) =>
          log.warn("[boxes] onExtraction failed (non-fatal)", err),
        );
    }

    // Batch-append persisted IDs so non-fact memories (entities/questions) are
    // always attached to the thread.
    if (
      this.config.threadingEnabled &&
      threadIdForExtraction &&
      persistedIds.length > 0
    ) {
      try {
        await this.threading.appendEpisodeIds(
          threadIdForExtraction,
          persistedIds,
        );
      } catch (err) {
        log.warn(
          "[threading] appendEpisodeIds failed after persistence (non-fatal)",
          err,
        );
      }
    }

    // Thread title update for the already-established thread context.
    if (this.config.threadingEnabled && threadIdForExtraction) {
      const conversationContent = turns.map((t) => t.content).join(" ");
      await this.threading.updateThreadTitle(
        threadIdForExtraction,
        conversationContent,
      );
    }

    // Check if consolidation is needed (debounced + non-zero gated).
    const nonZeroExtraction =
      result.facts.length > 0 ||
      result.entities.length > 0 ||
      result.questions.length > 0 ||
      result.profileUpdates.length > 0;
    if (nonZeroExtraction) this.nonZeroExtractionsSinceConsolidation += 1;
    this.maybeScheduleConsolidation(nonZeroExtraction);

    this.requestQmdMaintenance();
    await this.runTierMigrationCycle(storage, "extraction");

    if (postPersistMetaError) {
      throw postPersistMetaError;
    }
  }

  private async recordProcessedExtractionFingerprint(
    storage: StorageManager,
    fingerprint: string,
    preloadedMeta?: Awaited<ReturnType<StorageManager["loadMeta"]>>,
  ): Promise<void> {
    const meta = preloadedMeta ?? (await storage.loadMeta());
    const observedAt = new Date().toISOString();
    const seen = new Map(
      (meta.processedExtractionFingerprints ?? []).map((entry) => [
        entry.fingerprint,
        entry.observedAt,
      ]),
    );
    seen.set(fingerprint, observedAt);
    meta.processedExtractionFingerprints = Array.from(seen.entries())
      .map(([value, at]) => ({ fingerprint: value, observedAt: at }))
      .sort((left, right) => left.observedAt.localeCompare(right.observedAt))
      .slice(-500);
    if (!preloadedMeta) {
      await storage.saveMeta(meta);
    }
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
    const dryRun = options?.dryRun === true;
    const persistSkipped = options?.force === true || trigger === "manual";
    if (!this.config.qmdTierMigrationEnabled && options?.force !== true) {
      const skipped: TierMigrationCycleSummary = {
        trigger,
        scanned: 0,
        migrated: 0,
        promoted: 0,
        demoted: 0,
        limit: 0,
        dryRun,
        skipped: "tier_migration_disabled",
      };
      if (persistSkipped) await this.tierMigrationStatus.recordCycle(skipped);
      return skipped;
    }
    if (
      trigger === "maintenance" &&
      !this.config.qmdTierAutoBackfillEnabled &&
      options?.force !== true
    ) {
      const skipped: TierMigrationCycleSummary = {
        trigger,
        scanned: 0,
        migrated: 0,
        promoted: 0,
        demoted: 0,
        limit: 0,
        dryRun,
        skipped: "maintenance_backfill_disabled",
      };
      if (persistSkipped) await this.tierMigrationStatus.recordCycle(skipped);
      return skipped;
    }
    if (this.tierMigrationInFlight) {
      const skipped: TierMigrationCycleSummary = {
        trigger,
        scanned: 0,
        migrated: 0,
        promoted: 0,
        demoted: 0,
        limit: 0,
        dryRun,
        skipped: "migration_in_flight",
      };
      if (persistSkipped) await this.tierMigrationStatus.recordCycle(skipped);
      return skipped;
    }

    const budgetTrigger = trigger === "manual" ? "maintenance" : trigger;
    const budget =
      this.compounding?.tierMigrationCycleBudget(budgetTrigger) ??
      defaultTierMigrationCycleBudget(this.config, budgetTrigger);
    const limit =
      options?.limitOverride !== undefined
        ? Math.max(0, Math.floor(options.limitOverride))
        : budget.limit;
    const nowMs = Date.now();
    if (
      options?.force !== true &&
      nowMs - this.lastTierMigrationRunAtMs < budget.minIntervalMs
    ) {
      const skipped: TierMigrationCycleSummary = {
        trigger,
        scanned: 0,
        migrated: 0,
        promoted: 0,
        demoted: 0,
        limit,
        dryRun,
        skipped: "min_interval",
      };
      if (persistSkipped) await this.tierMigrationStatus.recordCycle(skipped);
      return skipped;
    }

    const policy = applyUtilityPromotionRuntimePolicy(
      {
        enabled: this.config.qmdTierMigrationEnabled,
        demotionMinAgeDays: this.config.qmdTierDemotionMinAgeDays,
        demotionValueThreshold: this.config.qmdTierDemotionValueThreshold,
        promotionValueThreshold: this.config.qmdTierPromotionValueThreshold,
      },
      this.utilityRuntimeValues,
    );

    this.tierMigrationInFlight = true;
    try {
      const coldStorage = new StorageManager(path.join(storage.dir, "cold"));
      const [hotMemories, coldMemories] = await Promise.all([
        storage.readAllMemories(),
        coldStorage.readAllMemories(),
      ]);
      const now = new Date();
      const scanLimit = Math.max(0, Math.floor(budget.scanLimit));
      const hotScanLimit = Math.min(
        hotMemories.length,
        Math.ceil(scanLimit * 0.75),
      );
      const coldScanLimit = Math.min(
        coldMemories.length,
        Math.max(0, scanLimit - hotScanLimit),
      );
      const toTimestamp = (memory: MemoryFile): number =>
        Date.parse(memory.frontmatter.updated ?? memory.frontmatter.created);
      const hotCandidates = hotMemories
        .map((memory) => ({ memory, tier: "hot" as MemoryTier }))
        .sort((a, b) => toTimestamp(a.memory) - toTimestamp(b.memory))
        .slice(0, hotScanLimit);
      const coldCandidates = coldMemories
        .map((memory) => ({ memory, tier: "cold" as MemoryTier }))
        .sort((a, b) => toTimestamp(b.memory) - toTimestamp(a.memory))
        .slice(0, coldScanLimit);
      const candidates = [...hotCandidates, ...coldCandidates];

      const migration = new TierMigrationExecutor({
        storage,
        qmd: this.qmd,
        hotCollection: this.config.qmdCollection,
        coldCollection:
          this.config.qmdColdCollection ?? `${this.config.qmdCollection}-cold`,
        autoEmbed: this.config.qmdAutoEmbedEnabled,
      });

      let migrated = 0;
      let promoted = 0;
      let demoted = 0;
      for (const candidate of candidates) {
        if (migrated >= limit) break;
        const decision = decideTierTransition(
          candidate.memory,
          candidate.tier,
          policy,
          now,
        );
        if (!decision.changed) continue;

        if (!dryRun) {
          const res = await migration.migrateMemory({
            memory: candidate.memory,
            fromTier: candidate.tier,
            toTier: decision.nextTier,
            reason: `${trigger}:${decision.reason}`,
          });
          if (!res.changed) continue;
        }
        migrated += 1;
        if (decision.nextTier === "cold") demoted += 1;
        if (decision.nextTier === "hot") promoted += 1;
      }

      if (!dryRun) this.lastTierMigrationRunAtMs = Date.now();
      log.debug(
        `tier migration cycle completed: trigger=${trigger} scanned=${candidates.length} migrated=${migrated} limit=${limit}${dryRun ? " dryRun=true" : ""}`,
      );
      const summary: TierMigrationCycleSummary = {
        trigger,
        scanned: candidates.length,
        migrated,
        promoted,
        demoted,
        limit,
        dryRun,
      };
      const shouldPersistCycle = trigger === "manual" || migrated > 0;
      if (shouldPersistCycle)
        await this.tierMigrationStatus.recordCycle(summary);
      return summary;
    } catch (err) {
      this.lastTierMigrationRunAtMs = Date.now();
      log.warn(`tier migration cycle failed (${trigger}, fail-open): ${err}`);
      const failed: TierMigrationCycleSummary = {
        trigger,
        scanned: 0,
        migrated: 0,
        promoted: 0,
        demoted: 0,
        limit,
        dryRun,
        errorCount: 1,
      };
      await this.tierMigrationStatus.recordCycle(failed);
      return failed;
    } finally {
      this.tierMigrationInFlight = false;
    }
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
    if (this.config.consolidationRequireNonZeroExtraction && !nonZeroExtraction)
      return;
    if (
      this.nonZeroExtractionsSinceConsolidation < this.config.consolidateEveryN
    )
      return;

    const now = Date.now();
    if (
      now - this.lastConsolidationRunAtMs <
      this.config.consolidationMinIntervalMs
    )
      return;
    if (this.consolidationInFlight) return;

    this.consolidationInFlight = true;
    this.lastConsolidationRunAtMs = now;
    this.nonZeroExtractionsSinceConsolidation = 0;
    this.runConsolidation()
      .catch((err) => log.error("background consolidation failed", err))
      .finally(() => {
        this.consolidationInFlight = false;
      });
  }

  private requestQmdMaintenance(): void {
    if (!this.qmd.isAvailable()) return;
    if (!this.config.qmdMaintenanceEnabled) return;

    this.qmdMaintenancePending = true;
    if (this.qmdMaintenanceTimer) return;

    this.qmdMaintenanceTimer = setTimeout(() => {
      this.qmdMaintenanceTimer = null;
      this.runQmdMaintenance().catch((err) =>
        log.debug(`background qmd maintenance failed: ${err}`),
      );
    }, this.config.qmdMaintenanceDebounceMs);
  }

  /**
   * Public entrypoint for tool-driven QMD maintenance requests.
   * Routes through existing debounced/singleflight maintenance controls.
   */
  requestQmdMaintenanceForTool(reason: string): void {
    try {
      this.requestQmdMaintenance();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`qmd maintenance request failed (${reason}): ${msg}`);
    }
  }

  private async runQmdMaintenance(): Promise<void> {
    if (this.qmdMaintenanceInFlight) return;
    if (!this.qmdMaintenancePending) return;
    this.qmdMaintenanceInFlight = true;
    this.qmdMaintenancePending = false;

    try {
      if (this.config.namespacesEnabled) {
        await this.namespaceSearchRouter.updateNamespaces(
          this.configuredNamespaces(),
        );
      } else {
        await this.qmd.update();
      }
      const now = Date.now();
      if (
        this.config.qmdAutoEmbedEnabled &&
        now - this.lastQmdEmbedAtMs >= this.config.qmdEmbedMinIntervalMs
      ) {
        if (this.config.namespacesEnabled) {
          await this.namespaceSearchRouter.embedNamespaces(
            this.configuredNamespaces(),
          );
        } else {
          await this.qmd.embed();
        }
        this.lastQmdEmbedAtMs = now;
      }
    } finally {
      this.qmdMaintenanceInFlight = false;
      if (this.qmdMaintenancePending) {
        this.requestQmdMaintenance();
      }
    }
  }

  private async persistExtraction(
    result: ExtractionResult,
    storage: StorageManager,
    threadIdForExtraction?: string | null,
    sourceContext?: { sessionKey?: string; principal?: string; validAt?: string },
  ): Promise<string[]> {
    // Inline source attribution (issue #369). When enabled, every extracted
    // fact is rewritten to carry a compact provenance tag inside its body so
    // the citation survives hostile memory text, copy/paste, and LLM quoting.
    // The helper is a no-op when the feature flag is off, so legacy pipelines
    // see zero behavioral change.
    const citationEnabled = this.config.inlineSourceAttributionEnabled === true;
    const citationTemplate = this.config.inlineSourceAttributionFormat;
    // The stable fields (agent, session) are computed once; `ts` is intentionally
    // omitted here and added fresh per invocation so each fact in a large batch
    // gets its own insertion timestamp rather than sharing a single batch-start time.
    const citationContextBase: Omit<CitationContext, "ts"> = citationEnabled
      ? {
          agent: sourceContext?.principal,
          session: sourceContext?.sessionKey,
        }
      : {};
    const applyInlineCitation = (content: string): string => {
      if (!citationEnabled) return content;
      if (typeof content !== "string" || content.length === 0) return content;
      // Build a fresh CitationContext per call so `ts` reflects the actual
      // insertion time of each individual fact rather than the batch-start time.
      const citationContext: CitationContext = {
        ...citationContextBase,
        ts: new Date().toISOString(),
      };
      // `attachCitation` already calls `hasCitationForTemplate` internally and
      // is a no-op when the content already carries a citation (default or
      // custom template).  The outer check was redundant and has been removed
      // to avoid a maintenance hazard where the two guard paths could diverge.
      return attachCitation(content, citationContext, citationTemplate);
    };
    const supersessionOrderingAt = (validAt?: string): string =>
      validAt && validAt.length > 0 ? validAt : new Date().toISOString();
    const persistedIds: string[] = [];
    const persistedIdsByStorage = new Map<
      string,
      { storage: StorageManager; ids: string[] }
    >();
    const trackPersistedId = (
      targetStorage: StorageManager,
      id: string,
      options: { includeReturnedIds?: boolean } = {},
    ): void => {
      if (options.includeReturnedIds !== false) {
        persistedIds.push(id);
      }
      const key = targetStorage.dir;
      const existing = persistedIdsByStorage.get(key);
      if (existing) {
        existing.ids.push(id);
        return;
      }
      persistedIdsByStorage.set(key, { storage: targetStorage, ids: [id] });
    };
    let dedupedCount = 0;
    // Counter for facts skipped by the importance write-gate (issue #372).
    // Emitted via the `importance_gated` metric below and rolled into the
    // final `persisted:` log line so operators can tune the threshold.
    let importanceGatedCount = 0;
    // UUI2: short-circuit semantic dedup after first backend-unavailable signal
    // within this batch. Once any fact in the batch gets reason="backend_unavailable"
    // (meaning the embedding backend is degraded), subsequent facts skip the
    // lookup entirely and proceed directly to write. This prevents N-fact batches
    // from paying N × timeout when the backend is down. The flag resets per-batch
    // (declared here, inside persistExtraction) so a transient hiccup in one
    // batch does not permanently disable dedup in future batches.
    let batchBackendUnavailable = false;
    const behaviorSignalsByStorage = new Map<
      string,
      { storage: StorageManager; events: BehaviorSignalEvent[] }
    >();
    const trackBehaviorSignals = (
      targetStorage: StorageManager,
      events: BehaviorSignalEvent[],
    ): void => {
      if (events.length === 0) return;
      const key = targetStorage.dir;
      const existing = behaviorSignalsByStorage.get(key);
      if (existing) {
        existing.events.push(...events);
        return;
      }
      behaviorSignalsByStorage.set(key, {
        storage: targetStorage,
        events: [...events],
      });
    };
    const confidenceTierOrder = [
      "explicit",
      "implied",
      "inferred",
      "speculative",
    ] as const;
    const shouldPromoteToShared = (
      targetStorage: StorageManager,
      category: string,
      confidence: number,
    ): boolean => {
      if (
        !this.config.namespacesEnabled ||
        !this.config.autoPromoteToSharedEnabled
      )
        return false;
      if (
        this.namespaceFromStorageDir(targetStorage.dir) ===
        this.config.sharedNamespace
      )
        return false;
      if (!this.config.autoPromoteToSharedCategories.includes(category as any))
        return false;
      const actualTier = confidenceTier(confidence);
      const actualRank = confidenceTierOrder.indexOf(actualTier);
      const minimumRank = confidenceTierOrder.indexOf(
        this.config.autoPromoteMinConfidenceTier,
      );
      if (actualRank === -1 || minimumRank === -1) return false;
      return actualRank <= minimumRank;
    };
    const promoteMemoryToShared = async (options: {
      sourceStorage: StorageManager;
      category: string;
      content: string;
      confidence: number;
      tags: string[];
      entityRef?: string;
      structuredAttributes?: Record<string, string>;
      sourceMemoryId: string;
      importance?: ReturnType<typeof scoreImportance>;
      intentGoal?: string;
      intentActionType?: string;
      intentEntityTypes?: string[];
      memoryKind?: MemoryFrontmatter["memoryKind"];
      validAt?: string;
      source: string;
    }): Promise<void> => {
      if (
        !shouldPromoteToShared(
          options.sourceStorage,
          options.category,
          options.confidence,
        )
      )
        return;
      try {
        const sharedStorage = await this.storageRouter.storageFor(
          this.config.sharedNamespace,
        );
        // Dedup gate: canonicalize content before hashing.
        //
        // Issue #369 (PR #401): When inline attribution is enabled,
        // `applyInlineCitation` appends a timestamp-bearing marker (e.g.
        // `[Source: ..., ts=2026-04-11T...]`).  Because the timestamp changes
        // on every call, hashing cited content produces a unique hash each
        // time — defeating dedup entirely and allowing the same logical fact to
        // be promoted repeatedly.  Also, both promotion call sites pass
        // `fact.content`, which can already carry an inline citation (e.g. a
        // relayed or reprocessed fact).  Strip any pre-existing citation so the
        // dedup key matches the hash stored from the original un-cited write.
        //
        // PR #402 round-6 (Fix #2 / chatgpt-codex P1 PRRT_kwDORJXyws56U74n):
        // Compute the enriched content before the hash-dedup check so the
        // lookup uses the same content that writeMemory will actually store.
        // When structuredAttributes are present, writeMemory appends an
        // "[Attributes: ...]" suffix before hashing; hasFactContentHash must
        // receive the same enriched body or the check is against a different
        // hash and dedup fails to fire (letting duplicates through) or fires
        // when it shouldn't (collapsing memories with different enrichments).
        // Fix #1 (P2 PRRT_kwDORJXyws56VHZc): use normalizeAttributePairs so
        // key order and casing are canonical — identical to the enrichment
        // applied by storage.writeMemory — preventing spurious hash misses
        // when attribute maps arrive with different insertion orders or casing.
        //
        // Fix #4 (Low PRRT_kwDORJXyws56VHth): sanitize the base content before
        // building dedupContent.  writeMemory runs sanitizeMemoryContent on the
        // enriched body before hashing; if sanitization redacts the content to
        // REDACTED_PLACEHOLDER the stored hash is for the redacted form, not
        // the raw form.  Computing dedupContent from sanitized.text here ensures
        // the hash lookup and the normalizedIncoming comparison both use the
        // same content that writeMemory will actually store.
        //
        // Combined fix: strip any pre-existing citation FIRST to obtain
        // rawContent (the canonical body), then sanitize rawContent (not
        // options.content) when building dedupContent, so that citation
        // stripping and sanitization are applied in a consistent order.
        const rawContent =
          citationEnabled &&
          hasCitationForTemplate(options.content, citationTemplate)
            ? stripCitationForTemplate(options.content, citationTemplate)
            : options.content;
        const citedContent = applyInlineCitation(rawContent);
        const sanitizedBase = sanitizeMemoryContent(rawContent);
        const dedupContent =
          options.category === "fact" &&
          options.structuredAttributes &&
          Object.keys(options.structuredAttributes).length > 0
            ? `${sanitizedBase.text}\n[Attributes: ${normalizeAttributePairs(options.structuredAttributes)}]`
            : sanitizedBase.text;
        if (
          options.category === "fact" &&
          (await sharedStorage.hasFactContentHash(dedupContent))
        ) {
          // Uj6H fix: shared-namespace temporal supersession must also run when
          // the hash-dedup short-circuit fires.  Without this, an existing shared
          // fact whose structuredAttributes are stale (or an older conflicting
          // shared fact that is still active) never gets retired — supersession
          // only ran in the post-writeMemory block which is unreachable here.
          //
          // Strategy: scan the shared namespace for the existing fact whose
          // normalized content matches the incoming content, then run
          // applyTemporalSupersession against it using the same logic that
          // would have run post-writeMemory.  This is a best-effort / fail-open
          // step — if the lookup fails we skip silently (same as the normal path).
          if (
            this.config.temporalSupersessionEnabled &&
            options.entityRef &&
            options.structuredAttributes &&
            Object.keys(options.structuredAttributes).length > 0
          ) {
            // PR #402 round-7 (Fix #2 / Codex P1 PRRT_kwDORJXyws56VALC):
            // Track whether matchingFact lookup completed before the try block
            // so the catch block can distinguish an early-lookup failure (where
            // we don't know if a duplicate exists) from a post-lookup supersession
            // failure (where we confirmed a duplicate and must skip the write).
            let hashDedupMatchingFact: MemoryFile | undefined;
            let hashDedupLookupComplete = false;
            try {
              // Fix #2 (P2 PRRT_kwDORJXyws56VHZf): dedupContent is now built
              // from sanitizedBase.text (see fix #4 above), so normalizedIncoming
              // uses the same sanitized+normalized content that writeMemory hashes
              // and that hasFactContentHash just matched.  Previously this used the
              // raw options.content, which diverged from the stored hash when
              // sanitization redacted the content, causing the candidate lookup to
              // return undefined and leaving stale facts active.
              const normalizedIncoming = ContentHashIndex.normalizeContent(dedupContent);
              const allShared = await sharedStorage.readAllMemories();
              // PR #402 round-12 (Finding Uybg): restrict hash-dedup matching to
              // the SAME entity.  Content-hash equality alone can collide across
              // entities when two entities share identical fact text.  Using an
              // unrelated entity's existing fact as `newMemoryId` would anchor
              // supersession to that entity's record and corrupt its
              // `supersededBy` links.  Only consider facts whose normalized
              // `entityRef` matches the incoming entity.
              const incomingEntityNorm = normalizeSupersessionKey(options.entityRef);
              hashDedupMatchingFact = allShared.find((m) => {
                if (m.frontmatter.category !== "fact") return false;
                if ((m.frontmatter.status ?? "active") !== "active") return false;
                // Same-entity guard: skip if entity doesn't match.
                if (!m.frontmatter.entityRef) return false;
                if (normalizeSupersessionKey(m.frontmatter.entityRef) !== incomingEntityNorm) {
                  log.debug(
                    `persistExtraction: hash-dedup skipping cross-entity match (incoming="${incomingEntityNorm}" candidate="${normalizeSupersessionKey(m.frontmatter.entityRef)}")`,
                  );
                  return false;
                }
                // PR #402 round-7 (Fix #2): compare stored fact's full body
                // (including any appended "[Attributes: ...]" suffix) against the
                // enriched normalizedIncoming so the candidate selected is the one
                // whose hash actually matched in hasFactContentHash.
                return ContentHashIndex.normalizeContent(m.content ?? "") === normalizedIncoming;
              });
              hashDedupLookupComplete = true;
              if (hashDedupMatchingFact) {
                // Finding UvU1 (PR #402 round-11): anchor supersession to the
                // incoming event's time, not the existing fact's persisted
                // `created`.  For source-dated replay/import, this is the
                // source valid_at; otherwise it is the current wall-clock. The
                // matching fact may be an old shared copy whose `created`
                // predates the incoming promotion event — using it as
                // `createdAt` would make the new memory appear older than the
                // existing one, preventing supersession from firing.
                // PR #402 round-12 (Finding Uyui): the matching fact is an
                // existing OLD memory — its persisted `frontmatter.created` is
                // stale relative to the incoming promotion event.  Pass
                // `useCallerTimestamp: true` so the function uses
                // `createdAt` as the ordering anchor instead of the old fact's
                // timestamp, ensuring supersession fires correctly even when
                // the matching fact predates conflicting candidates.
                await applyTemporalSupersession({
                  storage: sharedStorage,
                  newMemoryId: hashDedupMatchingFact.frontmatter.id,
                  entityRef: options.entityRef,
                  structuredAttributes: options.structuredAttributes,
                  createdAt: supersessionOrderingAt(options.validAt),
                  enabled: true,
                  useCallerTimestamp: true,
                });
                // Active matching fact exists — normal short-circuit is safe.
                return;
              }
              // No active same-entity shared fact found with this content hash.
              // This can happen when the previously-written shared fact has since
              // been superseded (e.g. Austin → NYC → Austin reversion): the hash
              // index still records the hash but the fact is no longer active.
              // Fall through to the write path below so a new active shared
              // memory is created, then supersession fires post-write as usual.
              log.debug(
                `persistExtraction: hash-dedup found no active same-entity shared fact for ${options.sourceMemoryId}; falling through to write`,
              );
            } catch (hashDedupSupersessionErr) {
              log.warn(
                `persistExtraction: shared-namespace supersession on hash-dedup path failed open for ${options.sourceMemoryId}: ${hashDedupSupersessionErr}`,
              );
              // PR #402 round-7 (Fix #1 / cursor Medium PRRT_kwDORJXyws56U_ig):
              // Only skip the write if we CONFIRMED a matching active shared fact
              // before the error occurred (hashDedupLookupComplete is true AND
              // hashDedupMatchingFact is set).  If the error was thrown before
              // matchingFact was resolved — e.g. readAllMemories() threw — we
              // cannot assume a duplicate exists, and unconditionally returning
              // would permanently lose the shared promotion.  Fall through to the
              // write path so the fact is not silently dropped.
              if (hashDedupLookupComplete && hashDedupMatchingFact) {
                // A matching active shared fact was confirmed — skip the write to
                // avoid duplicating content that is already present.  The existing
                // fact remains active and the supersession failure is logged above.
                return;
              }
              // Lookup did not complete or no candidate was found — we cannot
              // confirm a duplicate.  Fall through to the write + post-write
              // supersession path so the shared promotion is not lost.
              log.debug(
                `persistExtraction: hash-dedup catch: lookup incomplete or no candidate found for ${options.sourceMemoryId}; falling through to write`,
              );
            }
          } else {
            // temporalSupersessionEnabled is off or no entity/attributes — keep
            // the original short-circuit behaviour.
            return;
          }
        }
        const promotedId = await sharedStorage.writeMemory(
          options.category as any,
          citedContent,
          {
            confidence: options.confidence,
            tags: [...options.tags, "shared-promotion"],
            entityRef: options.entityRef,
            structuredAttributes: options.structuredAttributes,
            source: `${options.source}-shared-promotion`,
            importance: options.importance,
            lineage: [options.sourceMemoryId],
            sourceMemoryId: options.sourceMemoryId,
            intentGoal: options.intentGoal,
            intentActionType: options.intentActionType,
            intentEntityTypes: options.intentEntityTypes,
            memoryKind: options.memoryKind,
            validAt: options.validAt,
            // Index the RAW content hash so hasFactContentHash(rawContent)
            // returns true on subsequent extractions. Without this, the index
            // would record the hash of citedContent (which changes every call
            // due to an updated timestamp), causing duplicate promotions.
            contentHashSource: rawContent,
          },
        );
        // PR #402 Finding 3 fix: run temporal supersession against the shared
        // namespace after the promoted write lands so stale shared-namespace
        // copies of the same entity attribute are retired.  Without this,
        // source-namespace supersession leaves the shared copy active and
        // shared recall continues returning the stale state.  Reuses the same
        // applyTemporalSupersession helper — no logic duplication.
        if (
          this.config.temporalSupersessionEnabled &&
          options.entityRef &&
          options.structuredAttributes &&
          Object.keys(options.structuredAttributes).length > 0
        ) {
          try {
            await applyTemporalSupersession({
              storage: sharedStorage,
              newMemoryId: promotedId,
              entityRef: options.entityRef,
              structuredAttributes: options.structuredAttributes,
              createdAt: supersessionOrderingAt(options.validAt),
              enabled: true,
            });
          } catch (sharedSupersessionErr) {
            log.warn(
              `persistExtraction: shared-namespace temporal supersession failed open for promoted ${promotedId}: ${sharedSupersessionErr}`,
            );
          }
        }
        trackPersistedId(sharedStorage, promotedId, {
          includeReturnedIds: false,
        });
        await this.indexPersistedMemory(sharedStorage, promotedId);
        trackBehaviorSignals(
          sharedStorage,
          buildBehaviorSignalsForMemory({
            memoryId: promotedId,
            category: options.category as any,
            content: options.content,
            namespace: this.config.sharedNamespace,
            confidence: options.confidence,
            source: "extraction",
          }),
        );
      } catch (err) {
        log.warn(
          `persistExtraction: shared promotion failed open for ${options.sourceMemoryId}: ${err}`,
        );
      }
    };

    // Defensive: validate result and facts array
    if (!result || !Array.isArray(result.facts)) {
      log.warn(
        "persistExtraction: result or result.facts is invalid, skipping",
        { resultType: typeof result, factsType: typeof result?.facts },
      );
      return persistedIds;
    }

    // Chunking config from plugin settings
    const chunkingConfig: ChunkingConfig = {
      targetTokens: this.config.chunkingTargetTokens,
      minTokens: this.config.chunkingMinTokens,
      overlapSentences: this.config.chunkingOverlapSentences,
    };

    const rawEntities = Array.isArray((result as any).entities)
      ? (result as any).entities
      : [];
    const rawQuestions = Array.isArray((result as any).questions)
      ? (result as any).questions
      : [];
    const rawProfileUpdates = Array.isArray((result as any).profileUpdates)
      ? (result as any).profileUpdates
      : [];

    const facts = result.facts.slice(0, this.config.extractionMaxFactsPerRun);
    const entities = rawEntities.slice(
      0,
      this.config.extractionMaxEntitiesPerRun,
    );
    const questions = rawQuestions.slice(
      0,
      this.config.extractionMaxQuestionsPerRun,
    );
    const profileUpdates = rawProfileUpdates.slice(
      0,
      this.config.extractionMaxProfileUpdatesPerRun,
    );

    if (
      facts.length < result.facts.length ||
      entities.length < result.entities.length ||
      questions.length < result.questions.length ||
      profileUpdates.length < result.profileUpdates.length
    ) {
      log.warn(
        "persistExtraction: capped extraction payload to guardrails " +
          `(facts ${facts.length}/${result.facts.length}, entities ${entities.length}/${result.entities.length}, ` +
          `questions ${questions.length}/${result.questions.length}, profile ${profileUpdates.length}/${result.profileUpdates.length})`,
      );
    }

    // v8.2: pre-load all memories once for entity-sibling graph edges (avoids per-fact disk scan)
    type GraphStorageContext = {
      allMemsForGraph: Awaited<
        ReturnType<typeof storage.readAllMemories>
      > | null;
      memoryPathById: Map<string, string>;
      previousPersistedRelPath?: string;
    };
    const graphContextByStorageDir = new Map<string, GraphStorageContext>();
    const ensureGraphContext = async (
      targetStorage: StorageManager,
    ): Promise<GraphStorageContext> => {
      const existing = graphContextByStorageDir.get(targetStorage.dir);
      if (existing) return existing;
      const created: GraphStorageContext = {
        allMemsForGraph: null,
        memoryPathById: new Map<string, string>(),
      };
      if (this.config.multiGraphMemoryEnabled) {
        try {
          created.allMemsForGraph = await targetStorage.readAllMemories();
          for (const [id, relPath] of buildMemoryPathById(
            created.allMemsForGraph,
            targetStorage.dir,
          )) {
            created.memoryPathById.set(id, relPath);
          }
        } catch {
          /* fail-open */
        }
      }
      graphContextByStorageDir.set(targetStorage.dir, created);
      return created;
    };
    let threadEpisodeIdsForGraph: string[] | undefined;
    if (this.config.multiGraphMemoryEnabled && threadIdForExtraction) {
      try {
        const thread = await this.threading.loadThread(threadIdForExtraction);
        threadEpisodeIdsForGraph = thread?.episodeIds
          ? [...thread.episodeIds]
          : [];
      } catch {
        /* fail-open */
      }
    }
    const routeRules = await this.loadRoutingRules();
    const routeOptions = this.routeEngineOptions();

    // Pre-routing pass: compute the routed category for every fact BEFORE
    // building judge candidates.  Route rules may override f.category (e.g.
    // via taxonomy remapping), and the judge must evaluate against the
    // *final* category that will actually be persisted — not the raw
    // extraction-time category.  The per-fact write loop below reuses
    // these pre-computed results so routing is evaluated exactly once per
    // fact (no duplicated logic).
    const preRoutedCategories: Array<string | undefined> = new Array(facts.length);
    if (routeRules.length > 0) {
      for (let fi = 0; fi < facts.length; fi++) {
        const f = facts[fi];
        if (
          !f ||
          typeof f.content !== "string" ||
          !f.content.trim() ||
          typeof f.category !== "string" ||
          !f.category.trim()
        ) {
          continue;
        }
        try {
          const tags = Array.isArray(f.tags) ? f.tags : [];
          const routeText = `${f.category} ${tags.join(" ")} ${f.content}`;
          const selected = selectRouteRule(routeText, routeRules, routeOptions);
          if (selected?.target.category) {
            preRoutedCategories[fi] = selected.target.category;
          }
        } catch {
          // Fail-open: routing errors fall through to the extracted category.
        }
      }
    }

    // Extraction judge gate (issue #376). When enabled, batch-evaluate all
    // candidate facts for durability before the per-fact write loop.
    // The verdicts map is keyed by candidate index — we maintain a
    // candidateIndexToFactIndex mapping so the write loop can look up
    // verdicts by original fact index.
    //
    // Candidates are built using the *routed* category (preRoutedCategories)
    // so the judge evaluates durability against the same category that will
    // be persisted, not the raw extraction-time category.
    let judgeVerdictsByFactIndex: Map<number, import("./extraction-judge.js").JudgeVerdict> | null = null;
    let judgeGatedCount = 0;
    // Reset the side-channel defer count at the start of every
    // persistExtraction call so stale state from a prior call cannot leak
    // into the caller's buffer-retention decision.
    this.lastPersistExtractionDeferredCount = 0;
    if (this.config.extractionJudgeEnabled) {
      try {
        const judgeCandidates: JudgeCandidate[] = [];
        const candidateToFactIndex: number[] = [];
        for (let fi = 0; fi < facts.length; fi++) {
          const f = facts[fi];
          if (
            !f ||
            typeof f.content !== "string" ||
            !f.content.trim() ||
            typeof f.category !== "string" ||
            !f.category.trim()
          ) {
            continue;
          }
          // Use the routed category when available so the judge sees the
          // final persisted category, not the raw extraction-time value.
          // Cast to MemoryCategory — routing targets are always valid
          // category slugs defined in the taxonomy; the fallback is the
          // original ExtractedFact.category which is already typed.
          const judgeCategory = (preRoutedCategories[fi] ?? f.category) as import("./types.js").MemoryCategory;
          if (judgeCategory === "procedure") {
            continue;
          }
          const tags = Array.isArray(f.tags) ? f.tags : [];
          const imp = scoreImportance(
            f.content,
            judgeCategory,
            tags,
          );
          // Pre-filter: skip facts below importance threshold to avoid
          // wasting LLM calls on facts that will be filtered anyway in
          // the per-fact write loop (issue #376 review finding).
          if (
            !isAboveImportanceThreshold(
              imp.level,
              this.config.extractionMinImportanceLevel,
            )
          ) {
            continue;
          }
          judgeCandidates.push({
            text: f.content,
            category: judgeCategory,
            confidence: typeof f.confidence === "number" ? f.confidence : 0.7,
            tags,
            importanceLevel: imp.level,
          });
          candidateToFactIndex.push(fi);
        }
        // Telemetry + training-pair emit (issue #562 PR 3 + PR 4). The
        // orchestrator wires two fire-and-forget writers behind a single
        // callback so `judgeFactDurability` does not need to know about
        // either ledger. Both handlers are skipped when their flags are
        // off; the combined callback itself is undefined when both are
        // disabled so there is zero overhead in the default configuration.
        const judgeTelemetryOpts = {
          enabled: this.config.extractionJudgeTelemetryEnabled === true,
          memoryDir: this.config.memoryDir,
        };
        const judgeTrainingOpts = {
          enabled: this.config.collectJudgeTrainingPairs === true,
          ...(this.config.judgeTrainingDir
            ? { directory: this.config.judgeTrainingDir }
            : {}),
        };
        const judgeTelemetryHandler =
          judgeTelemetryOpts.enabled || judgeTrainingOpts.enabled
            ? (obs: import("./extraction-judge.js").JudgeVerdictObservation) => {
                const ts = new Date().toISOString();
                const verdictKind = getVerdictKind(obs.verdict);
                if (judgeTelemetryOpts.enabled) {
                  const event: import("./extraction-judge-telemetry.js").JudgeVerdictEvent = {
                    version: 1,
                    category: EXTRACTION_JUDGE_VERDICT_CATEGORY,
                    ts,
                    verdictKind,
                    reason: obs.verdict.reason,
                    deferrals: obs.priorDeferrals,
                    elapsedMs: obs.elapsedMs,
                    candidateCategory: obs.candidate.category,
                    confidence: obs.candidate.confidence,
                    contentHash: obs.contentHash,
                    fromCache: obs.source === "cache",
                    ...(obs.source === "llm-cap-rejected"
                      ? { deferCapTriggered: true }
                      : {}),
                  };
                  void recordJudgeVerdict(event, judgeTelemetryOpts);
                }
                if (judgeTrainingOpts.enabled) {
                  const pair: import("./extraction-judge-training.js").JudgeTrainingPair = {
                    version: 1,
                    ts,
                    candidateText: obs.candidate.text,
                    candidateCategory: obs.candidate.category,
                    ...(typeof obs.candidate.confidence === "number"
                      ? { candidateConfidence: obs.candidate.confidence }
                      : {}),
                    verdictKind,
                    reason: obs.verdict.reason,
                    priorDeferrals: obs.priorDeferrals,
                  };
                  void recordJudgeTrainingPair(pair, judgeTrainingOpts);
                }
              }
            : undefined;
        const judgeResult = await judgeFactDurability(
          judgeCandidates,
          this.config,
          this.localLlm,
          new FallbackLlmClient(
            this.config.gatewayConfig,
            fallbackLlmRuntimeContextFromConfig(this.config),
          ),
          this.judgeVerdictCache,
          this.judgeDeferCounts,
          judgeTelemetryHandler,
        );
        // Remap candidate-indexed verdicts to original fact indexes
        judgeVerdictsByFactIndex = new Map();
        for (const [candidateIdx, verdict] of judgeResult.verdicts) {
          const factIdx = candidateToFactIndex[candidateIdx];
          if (factIdx !== undefined) {
            judgeVerdictsByFactIndex.set(factIdx, verdict);
          }
        }
        log.info(
          `extraction-judge: ${judgeResult.verdicts.size}/${judgeCandidates.length} facts evaluated, ` +
            `${judgeResult.cached} cached, ${judgeResult.judged} judged, ` +
            `${judgeResult.deferred} deferred` +
            (judgeResult.deferredCappedToReject > 0
              ? ` (${judgeResult.deferredCappedToReject} cap-rejected)`
              : "") +
            `, ${judgeResult.elapsed}ms`,
        );
        // Expose defer count to the caller (issue #562 PR 2) so it can decide
        // whether to retain buffer turns for the next extraction pass.
        this.lastPersistExtractionDeferredCount = judgeResult.deferred;
      } catch (err) {
        // Fail-open: if the entire judge pipeline errors, proceed without filtering
        log.warn(
          `extraction-judge: pipeline error, proceeding without filtering (fail-open): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    let factLoopIndex = -1;
    for (const fact of facts) {
      factLoopIndex++;
      if (
        !fact ||
        typeof (fact as any).content !== "string" ||
        !(fact as any).content.trim()
      ) {
        continue;
      }
      if (
        typeof (fact as any).category !== "string" ||
        !(fact as any).category.trim()
      ) {
        continue;
      }
      (fact as any).tags = Array.isArray((fact as any).tags)
        ? (fact as any).tags.filter((t: any) => typeof t === "string")
        : [];
      (fact as any).confidence =
        typeof (fact as any).confidence === "number"
          ? (fact as any).confidence
          : 0.7;

      // Content-hash dedup check (v6.0)
      //
      // Canonicalize pre-tagged facts before hashing (Codex P2 — issue #369).
      // When a fact already carries an inline citation (e.g. relayed or
      // reprocessed), hashing `fact.content` as-is would produce a different
      // hash than the one stored from the original write (which used the raw,
      // un-cited body as contentHashSource). Strip any citation first so the
      // dedup key matches what the hash index recorded.
      //
      // stripCitationForTemplate handles both the default and custom template
      // formats. For all-placeholder templates it cannot detect citations and
      // returns the text unchanged — dedup may miss in that edge case, which
      // is acceptable (no false-positive suppression).
      //
      // Routing runs before content-hash dedup and scoring so category overrides
      // affect both the dedup fingerprint and importance (issue #519 procedure routing).
      let writeCategory = fact.category;
      let targetStorage = storage;
      let routedRuleId: string | undefined;
      let routedNamespaceExplicit = false;
      if (routeRules.length > 0) {
        try {
          const routeText = `${fact.category} ${fact.tags.join(" ")} ${fact.content}`;
          const selected = selectRouteRule(routeText, routeRules, routeOptions);
          if (selected) {
            routedRuleId = selected.rule.id;
            if (selected.target.category) {
              writeCategory = selected.target.category;
            }
            if (selected.target.namespace) {
              routedNamespaceExplicit = true;
              targetStorage = await this.storageRouter.storageFor(
                selected.target.namespace,
              );
            }
          }
        } catch (err) {
          log.warn(
            `routing evaluation failed; fail-open to extracted category/namespace: ${err}`,
          );
        }
      }

      // Scope-based namespace routing: when scope classification is enabled
      // and the LLM tagged this fact as "global", route it to the shared
      // namespace so cross-project knowledge is visible everywhere. Only
      // applies when namespaces are enabled and the fact was not already
      // routed to a specific namespace by a routing rule (routing rules
      // that set an explicit namespace take precedence; category-only rules
      // do not block scope routing). Rule 30: gated by
      // extractionScopeClassificationEnabled.
      if (
        this.config.extractionScopeClassificationEnabled &&
        this.config.namespacesEnabled &&
        fact.scope === "global" &&
        !routedNamespaceExplicit
      ) {
        const currentNs = this.namespaceFromStorageDir(targetStorage.dir);
        if (currentNs !== this.config.sharedNamespace) {
          try {
            targetStorage = await this.storageRouter.storageFor(
              this.config.sharedNamespace,
            );
            log.debug(
              `scope-routing: fact "${fact.content.slice(0, 60)}…" routed to shared namespace (scope=global)`,
            );
          } catch (scopeRouteErr) {
            log.warn(
              `scope-routing: failed to resolve shared namespace storage; writing to session namespace (fail-open): ${scopeRouteErr}`,
            );
          }
        }
      }

      // Procedures: fingerprint the full serialized body (title + steps), not
      // the title alone, so distinct step lists are not collapsed (issue #519).
      const canonicalContentForHash =
        citationEnabled &&
        hasCitationForTemplate(fact.content, citationTemplate)
          ? stripCitationForTemplate(fact.content, citationTemplate)
          : fact.content;
      const contentHashDedupKey =
        writeCategory === "procedure"
          ? buildProcedurePersistBody(fact.content, fact.procedureSteps)
          : canonicalContentForHash;
      if (this.contentHashIndex && this.contentHashIndex.has(contentHashDedupKey)) {
        log.debug(
          `dedup: skipping duplicate fact "${fact.content.slice(0, 60)}…"`,
        );
        dedupedCount++;
        continue;
      }

      // Score importance using local heuristics (Phase 1B).
      // writeCategory / targetStorage already reflect routing.
      const importance = scoreImportance(
        fact.content,
        writeCategory,
        fact.tags,
      );

      if (writeCategory === "procedure" && this.config.procedural?.enabled !== true) {
        log.debug("persistExtraction: skip procedure memory (procedural.enabled is false)");
        continue;
      }

      // Importance write-gate (issue #372). Drop facts whose locally-scored
      // level falls below the configured minimum BEFORE the semantic dedup
      // lookup so that low-importance facts never incur an embedding search.
      // scoreImportance() already applies category boosts (e.g. corrections
      // +0.15) before deriving the level, so a correction at raw ~0.35
      // still lands at "normal" and passes the default gate. Without this
      // gate, trivial turn-level chatter ("hi", "k", heartbeat pings) gets
      // persisted as a fact memory and dilutes the store.
      if (
        !isAboveImportanceThreshold(
          importance.level,
          this.config.extractionMinImportanceLevel,
        )
      ) {
        importanceGatedCount++;
        const snippet = fact.content.slice(0, 60).replace(/\s+/g, " ").trim();
        log.debug(`extraction: skip trivial "${snippet}"`);
        // Log-based counter (no dedicated metric bus in remnic-core yet).
        // Operators can grep for `metric:importance_gated` in gateway.log
        // to tune extractionMinImportanceLevel.
        log.debug(
          `metric:importance_gated level=${importance.level} threshold=${this.config.extractionMinImportanceLevel} category=${writeCategory} count=${importanceGatedCount}`,
        );
        continue;
      }

      // Extraction judge gate (issue #376 + #562 PR 2). After the local
      // importance gate passes, consult the judge verdict (computed before
      // the loop). In active mode, non-durable facts are dropped. In shadow
      // mode, verdicts are logged but all facts proceed to write.
      //
      // Defer verdicts (issue #562): do not persist now, but also do not
      // cache the outcome so the candidate is re-evaluated on a later
      // extraction pass. The judge module tracks how many times the same
      // content has been deferred and converts to reject at the configured
      // cap, so the orchestrator only needs to skip the write here.
      if (judgeVerdictsByFactIndex) {
        const verdict = judgeVerdictsByFactIndex.get(factLoopIndex);
        if (verdict && !verdict.durable) {
          const verdictKind = getVerdictKind(verdict);
          if (this.config.extractionJudgeShadow) {
            log.info(
              `extraction-judge[shadow]: would ${verdictKind} "${fact.content.slice(0, 60)}…" reason="${verdict.reason}"`,
            );
          } else if (verdictKind === "defer") {
            judgeGatedCount++;
            log.debug(
              `extraction-judge: deferred "${fact.content.slice(0, 60)}…" reason="${verdict.reason}"`,
            );
            continue;
          } else {
            judgeGatedCount++;
            log.debug(
              `extraction-judge: rejected "${fact.content.slice(0, 60)}…" reason="${verdict.reason}"`,
            );
            continue;
          }
        }
      }

      // Procedure extraction gate (issue #519): ≥2 steps + trigger phrasing.
      // Runs even when extractionJudgeEnabled is false (durability judge is unrelated).
      // Never tied to extractionJudgeShadow — that flag is only for the LLM durability judge.
      if (writeCategory === "procedure") {
        const procGate = validateProcedureExtraction({
          content: fact.content,
          procedureSteps: fact.procedureSteps,
        });
        if (!procGate.durable) {
          log.debug(
            `extraction-procedure-gate: rejected "${fact.content.slice(0, 60)}…" reason="${procGate.reason}"`,
          );
          continue;
        }
      }

      // Issue #373 — write-time semantic similarity guard. Hook runs after
      // the exact content-hash miss and the importance gate so that:
      //   (a) paraphrased near-duplicates never reach writeMemory(), and
      //   (b) low-importance facts that will be dropped never trigger an
      //       embedding lookup (avoids unnecessary API latency/cost).
      // Fails open when the embedding backend is unavailable.
      //
      // Defense in depth (PR #399 review): decideSemanticDedup already
      // catches lookup errors internally, and the embedding fetch is
      // bounded by a timeout in embedding-fallback.ts. We still wrap the
      // whole call in its own try/catch here so that any unexpected
      // rejection (future refactors, misbehaving custom backends, etc.)
      // can never block the persist loop — a failure in the dedup path
      // must always default to "not a duplicate".
      // Track a pending semantic-skip decision (populated inside the block
      // below). The actual drop happens AFTER contradiction detection so that
      // a high-similarity update/correction is linked as a superseding
      // contradiction rather than silently dropped.
      let pendingSemanticSkip: (SemanticDedupDecision & { action: "skip" }) | null = null;
      if (this.config.semanticDedupEnabled) {
        let semanticDecision: SemanticDedupDecision;
        // UUI2: skip embedding lookup for the rest of this batch once we know
        // the backend is unavailable. The flag is reset per-batch (set to false
        // at the top of persistExtraction), so a transient hiccup in one call
        // does not permanently disable dedup in subsequent calls.
        if (batchBackendUnavailable) {
          semanticDecision = { action: "keep", reason: "backend_unavailable" };
        } else {
          try {
            // Pass the resolved target storage so the lookup scopes the
            // embedding index to the target namespace (PR #399 P1 fix).
            // Without this, a high-similarity hit in a different namespace
            // would cause the fact to be dropped here — cross-namespace
            // write suppression / data loss.
            const lookupStorage = targetStorage;
            semanticDecision = await decideSemanticDedup(
              fact.content,
              (content, limit) =>
                this.semanticDedupLookup(content, limit, lookupStorage),
              {
                enabled: true,
                threshold: this.config.semanticDedupThreshold,
                candidates: this.config.semanticDedupCandidates,
              },
            );
          } catch (err) {
            log.warn(
              `semantic dedup decision failed; failing open and writing fact: ${err}`,
            );
            semanticDecision = {
              action: "keep",
              reason: "backend_unavailable",
            };
          }
          // UUI2: cache the backend-unavailable signal for the rest of this batch.
          if (semanticDecision.reason === "backend_unavailable") {
            batchBackendUnavailable = true;
          }
        }
        if (semanticDecision.action === "skip") {
          pendingSemanticSkip = semanticDecision;
        }
      }

      const inferredIntent = this.config.intentRoutingEnabled
        ? inferIntentFromText(
            `${writeCategory} ${fact.tags.join(" ")} ${fact.content}`,
          )
        : null;
      const extractionWriteSource =
        (fact as any).source === "proactive"
          ? "extraction-proactive"
          : "extraction";

      // Check for contradictions before writing (Phase 2B).
      // NOTE: This block was moved above the chunking branch so that the
      // pendingSemanticSkip guard (below) can also protect the chunking path.
      // Previously, contradiction detection only ran on the non-chunked path,
      // meaning chunked facts could be persisted even when semanticDecision was
      // "skip" (the deferred guard was bypassed by the chunking `continue`).
      let supersedes: string | undefined;
      let links: MemoryLink[] = [];
      // True when contradiction detection ran and confirmed a contradiction,
      // regardless of whether auto-resolve is enabled. Used by the
      // semantic-skip guard so that contradictory updates are never silently
      // dropped — even when `contradictionAutoResolve=false` (in which case
      // `supersedes` is intentionally left unset to avoid retiring the old
      // memory without user confirmation).
      let contradictionDetected = false;

      if (this.config.contradictionDetectionEnabled && this.qmd.isAvailable()) {
        const targetNamespace = this.namespaceFromStorageDir(targetStorage.dir);
        const contradiction = await this.checkForContradiction(
          fact.content,
          writeCategory,
          targetNamespace,
        );
        if (contradiction) {
          contradictionDetected = true;
          // When auto-resolve is enabled the existing memory has already been
          // marked superseded; set `supersedes` so the new write carries the
          // relationship. When auto-resolve is disabled we still record the
          // contradiction link (so the memory is annotated for manual review)
          // but do NOT set `supersedes` on the new write — the old memory
          // remains active until a human resolves it.
          if (this.config.contradictionAutoResolve) {
            supersedes = contradiction.supersededId;
          }
          links.push({
            targetId: contradiction.supersededId,
            linkType: "contradicts",
            strength: contradiction.confidence,
            reason: contradiction.reason,
          });
          // Deindex the superseded memory so stale paths don't remain in
          // index_time.json / index_tags.json after the incremental update.
          // Only applicable when auto-resolve is on and the old memory is
          // actually being retired; skip when manual review is required.
          if (
            this.config.contradictionAutoResolve &&
            this.config.queryAwareIndexingEnabled &&
            contradiction.supersededPath
          ) {
            deindexMemory(
              this.config.memoryDir,
              contradiction.supersededPath,
              contradiction.supersededCreated,
              contradiction.supersededTags,
            );
          }
        }
      }

      // Apply the deferred semantic-skip now that contradiction detection has
      // run. If a contradiction was found (contradictionDetected is true), the
      // candidate is a contradictory update and must be written — do not skip
      // it. Only drop it when there is no detected contradiction (true
      // near-duplicate). This check intentionally runs BEFORE the chunking
      // branch so that a fact flagged as a semantic near-duplicate cannot be
      // persisted (with its hash registered) simply because it was long enough
      // to trigger chunking.
      //
      // NOTE: We use `contradictionDetected` rather than `!!supersedes` here
      // so that facts are preserved even when `contradictionAutoResolve=false`.
      // When auto-resolve is disabled `supersedes` is intentionally unset, but
      // the write must still proceed so the user can manually reconcile the
      // two memories later.
      //
      // UUI1: correction category writes are NEVER suppressed by the semantic
      // skip fallback, regardless of whether supersedes is set. When contradiction
      // detection is disabled or QMD is unavailable, supersedes is never set —
      // without this exemption a high-similarity correction would be silently
      // dropped, leaving a stale fact active. writeCategory (not fact.category)
      // is used because routing rules may have overridden the raw category.
      const isCorrection = writeCategory === "correction";
      if (pendingSemanticSkip && !contradictionDetected && !isCorrection) {
        log.debug(
          `dedup: skipping semantic near-duplicate fact "${fact.content
            .slice(0, 60)
            .replace(/\s+/g, " ")}…" score=${pendingSemanticSkip.topScore.toFixed(
            3,
          )} neighbor=${pendingSemanticSkip.topId}`,
        );
        dedupedCount++;
        // Do NOT add fact.content to contentHashIndex here. No memory was
        // persisted for this fact, so registering a synthetic hash would
        // permanently suppress exact-copy writes once the neighbor memory is
        // archived or deleted (the hash would linger with no backing record).
        continue;
      }

      // Check if chunking is enabled and content should be chunked.
      // When semanticChunkingEnabled is true, prefer the embedding-based
      // semantic chunker which produces more coherent topic-aligned segments.
      // Falls back to the recursive sentence-boundary chunker on failure.
      if (this.config.chunkingEnabled && writeCategory !== "procedure") {
        let chunkResult: { chunked: boolean; chunks: { content: string; index: number; tokenCount: number }[] };

        if (this.config.semanticChunkingEnabled) {
          try {
            const embedFn = this.embeddingFallback.embedTexts.bind(this.embeddingFallback);
            const semanticResult: SemanticChunkResult = await semanticChunkContent(
              fact.content,
              embedFn,
              this.config.semanticChunkingConfig,
            );
            chunkResult = semanticResult;
          } catch (err) {
            // Honor the fallbackToRecursive contract: when the user explicitly
            // disables fallback, re-throw so extraction fails fast instead of
            // silently using the recursive chunker. semanticChunkContent already
            // throws when fallback is disabled, but this outer catch swallowed
            // that signal. (PR #439 post-merge Finding 1.)
            if (this.config.semanticChunkingConfig?.fallbackToRecursive === false) {
              throw err;
            }
            log.debug(
              `semantic chunking failed, falling back to recursive chunker: ${err}`,
            );
            chunkResult = chunkContent(fact.content, chunkingConfig);
          }
        } else {
          chunkResult = chunkContent(fact.content, chunkingConfig);
        }

        if (chunkResult.chunked && chunkResult.chunks.length > 1) {
          // Classify memory kind (v8.0 Phase 2B: HiMem episode/note dual store)
          const memoryKind = this.config.episodeNoteModeEnabled
            ? classifyMemoryKind(fact.content, fact.tags ?? [], writeCategory)
            : undefined;

          // Write the parent memory first (with full content for reference).
          //
          // Compute the cited content once so that writeMemory and writeArtifact
          // (when verbatim artifacts are enabled) share the same citation timestamp.
          // See the normal write path comment for the full dedup rationale.
          //
          // Propagate supersedes/links from contradiction detection (round 6
          // fix): contradiction detection now runs BEFORE this branch so the
          // parent must carry the supersession relationship — without it the
          // old memory is deindexed but the new chunked parent has no link
          // back, leaving a dangling deindex with no replacement reference.
          // Child chunks intentionally do NOT carry supersedes; only the
          // parent represents the logical memory unit.
          //
          // Canonicalize contentHashSource before writing (Thread 3 — Codex P2,
          // issue #369). If fact.content already carries an inline citation
          // (e.g. re-processed or relayed fact), strip it so contentHashSource
          // records the raw un-cited body — matching what the dedup check hashes
          // via stripCitationForTemplate before calling hasFactContentHash.
          const rawChunkedContent =
            citationEnabled &&
            hasCitationForTemplate(fact.content, citationTemplate)
              ? stripCitationForTemplate(fact.content, citationTemplate)
              : fact.content;
          const citedChunkedContent = applyInlineCitation(rawChunkedContent);
          const parentId = await targetStorage.writeMemory(
            writeCategory,
            citedChunkedContent,
            {
              confidence: fact.confidence,
              tags: [...fact.tags, "chunked"],
              entityRef: fact.entityRef,
              source: extractionWriteSource,
              importance,
              supersedes,
              links: links.length > 0 ? links : undefined,
              intentGoal: inferredIntent?.goal,
              intentActionType: inferredIntent?.actionType,
              intentEntityTypes: inferredIntent?.entityTypes,
              memoryKind,
              structuredAttributes: fact.structuredAttributes,
              validAt: sourceContext?.validAt,
              contentHashSource: rawChunkedContent,
            },
          );

          // Write individual chunks with parent reference
          for (const chunk of chunkResult.chunks) {
            // Score each chunk's importance separately
            const chunkImportance = scoreImportance(
              chunk.content,
              writeCategory,
              fact.tags,
            );
            const chunkWriteSource =
              (fact as any).source === "proactive"
                ? "chunking-proactive"
                : "chunking";

            await targetStorage.writeChunk(
              parentId,
              chunk.index,
              chunkResult.chunks.length,
              writeCategory,
              // Each chunk carries its own inline citation so provenance
              // survives when a single chunk is quoted in isolation.
              applyInlineCitation(chunk.content),
              {
                confidence: fact.confidence,
                tags: fact.tags,
                entityRef: fact.entityRef,
                source: chunkWriteSource,
                importance: chunkImportance,
                intentGoal: inferredIntent?.goal,
                intentActionType: inferredIntent?.actionType,
                intentEntityTypes: inferredIntent?.entityTypes,
                memoryKind,
                validAt: sourceContext?.validAt,
              },
            );
          }

          if (routedRuleId) {
            log.debug(
              `routing applied for chunked memory ${parentId}: rule=${routedRuleId} category=${writeCategory} storage=${targetStorage.dir}`,
            );
          }
          log.debug(
            `chunked memory ${parentId} into ${chunkResult.chunks.length} chunks`,
          );
          trackPersistedId(targetStorage, parentId);
          if (
            threadEpisodeIdsForGraph &&
            !threadEpisodeIdsForGraph.includes(parentId)
          ) {
            threadEpisodeIdsForGraph.push(parentId);
          }
          await this.indexPersistedMemory(targetStorage, parentId);
          // PR #402 Thread 1 fix: run source-namespace temporal supersession for
          // chunked writes, matching the non-chunked path.  Without this the
          // source namespace retains stale facts that should have been superseded.
          try {
            const supersessionEntityRef =
              typeof (fact as any).entityRef === "string"
                ? ((fact as any).entityRef as string)
                : undefined;
            await applyTemporalSupersession({
              storage: targetStorage,
              newMemoryId: parentId,
              entityRef: supersessionEntityRef,
              structuredAttributes: fact.structuredAttributes,
              createdAt: supersessionOrderingAt(sourceContext?.validAt),
              enabled: this.config.temporalSupersessionEnabled,
            });
          } catch (err) {
            log.warn(`temporal-supersession (chunked): unexpected error: ${err}`);
          }
          await promoteMemoryToShared({
            sourceStorage: targetStorage,
            category: writeCategory,
            content: fact.content,
            confidence: fact.confidence,
            tags: fact.tags,
            entityRef: fact.entityRef,
            structuredAttributes: fact.structuredAttributes,
            sourceMemoryId: parentId,
            importance,
            intentGoal: inferredIntent?.goal,
            intentActionType: inferredIntent?.actionType,
            intentEntityTypes: inferredIntent?.entityTypes,
            memoryKind,
            validAt: sourceContext?.validAt,
            source: extractionWriteSource,
          });
          // Register chunked content in hash index too.
          // Thread 3 fix: canonicalize by stripping any pre-existing citation
          // so the stored hash matches what the dedup check computes via
          // stripCitationForTemplate before calling contentHashIndex.has().
          if (this.contentHashIndex) {
            const canonicalChunkedContent =
              citationEnabled &&
              hasCitationForTemplate(fact.content, citationTemplate)
                ? stripCitationForTemplate(fact.content, citationTemplate)
                : fact.content;
            this.contentHashIndex.add(canonicalChunkedContent);
          }

          for (const chunk of chunkResult.chunks) {
            const chunkId = `${parentId}-chunk-${chunk.index}`;
            // Do NOT push chunkId into persistedIds — chunk IDs must not leak
            // into boxBuilder.onExtraction() or threading.processTurn(), which
            // only expect canonical parent memory IDs.  Call indexPersistedMemory
            // directly for embedding-fallback sync of each chunk document.
            await this.indexPersistedMemory(targetStorage, chunkId);
          }
          if (
            this.config.verbatimArtifactsEnabled &&
            this.config.verbatimArtifactCategories.includes(writeCategory) &&
            fact.confidence >= this.config.verbatimArtifactsMinConfidence
          ) {
            // Reuse citedChunkedContent so the artifact carries the same citation
            // timestamp as the parent memory write above (Fix #3 — duplicate-citation).
            await targetStorage.writeArtifact(citedChunkedContent, {
              confidence: fact.confidence,
              tags: [...fact.tags, "artifact", "chunked-parent"],
              artifactType: this.artifactTypeForCategory(writeCategory),
              sourceMemoryId: parentId,
              intentGoal: inferredIntent?.goal,
              intentActionType: inferredIntent?.actionType,
              intentEntityTypes: inferredIntent?.entityTypes,
            });
          }
          // v8.2: graph edge building for chunked memories
          if (this.config.multiGraphMemoryEnabled) {
            try {
              const graphContext = await ensureGraphContext(targetStorage);
              const entityRef =
                typeof (fact as any).entityRef === "string"
                  ? (fact as any).entityRef
                  : undefined;
              const parentRelPath = resolvePersistedMemoryRelativePath({
                memoryId: parentId,
                pathById: graphContext.memoryPathById,
                category: writeCategory,
              });
              graphContext.memoryPathById.set(parentId, parentRelPath);
              appendMemoryToGraphContext({
                allMemsForGraph: graphContext.allMemsForGraph,
                storageDir: targetStorage.dir,
                memoryRelPath: parentRelPath,
                memoryId: parentId,
                category: writeCategory,
                content: fact.content ?? "",
                entityRef,
              });
              await this.buildGraphEdge(
                targetStorage,
                parentRelPath,
                entityRef,
                parentId,
                fact.content ?? "",
                graphContext.allMemsForGraph,
                graphContext.memoryPathById,
                threadIdForExtraction ?? undefined,
                threadEpisodeIdsForGraph,
                graphContext.previousPersistedRelPath,
              );
              graphContext.previousPersistedRelPath = parentRelPath;
            } catch {
              /* fail-open */
            }
          }
          trackBehaviorSignals(
            targetStorage,
            buildBehaviorSignalsForMemory({
              memoryId: parentId,
              category: writeCategory,
              content: fact.content,
              namespace: this.namespaceFromStorageDir(targetStorage.dir),
              confidence: fact.confidence,
              source: "extraction",
            }),
          );
          continue; // Skip the normal write below
        }
      }

      // Suggest links for this memory (Phase 3A)
      if (this.config.memoryLinkingEnabled && this.qmd.isAvailable()) {
        const targetNamespace = this.namespaceFromStorageDir(targetStorage.dir);
        const suggestedLinks = await this.suggestLinksForMemory(
          fact.content,
          writeCategory,
          targetNamespace,
        );
        if (suggestedLinks.length > 0) {
          links.push(...suggestedLinks);
        }
      }

      // Classify memory kind (v8.0 Phase 2B: HiMem episode/note dual store)
      const memoryKind =
        writeCategory === "procedure"
          ? undefined
          : this.config.episodeNoteModeEnabled
            ? classifyMemoryKind(fact.content, fact.tags ?? [], writeCategory)
            : undefined;

      // Normal write (no chunking)
      //
      // Compute the cited content once so that writeMemory and writeArtifact
      // (when verbatim artifacts are enabled) share the same citation timestamp.
      // Calling applyInlineCitation twice on the same raw content would produce
      // two different timestamps, creating duplicate citations with divergent
      // provenance metadata on the memory and artifact copies of the same fact.
      //
      // Pass the RAW (pre-citation) fact as `contentHashSource` so the
      // fact-content hash index records the hash of the canonical fact text
      // rather than the citation-annotated variant. When inline attribution is
      // enabled, `applyInlineCitation` appends a timestamp-bearing marker, so
      // hashing the persisted body would produce a different hash on every
      // write and defeat cross-session dedup (see `findDuplicateExplicitCapture`
      // in explicit-capture.ts which calls `hasFactContentHash(candidate.content)`
      // on raw content).
      const rawPersistBody =
        writeCategory === "procedure"
          ? buildProcedurePersistBody(fact.content, fact.procedureSteps)
          : fact.content;
      const citedFactContent = applyInlineCitation(rawPersistBody);
      const memoryId = await targetStorage.writeMemory(
        writeCategory,
        citedFactContent,
        {
          confidence: fact.confidence,
          tags: fact.tags,
          entityRef:
            typeof (fact as any).entityRef === "string"
              ? (fact as any).entityRef
              : undefined,
          source: extractionWriteSource,
          importance,
          supersedes,
          links: links.length > 0 ? links : undefined,
          intentGoal: inferredIntent?.goal,
          intentActionType: inferredIntent?.actionType,
          intentEntityTypes: inferredIntent?.entityTypes,
          memoryKind,
          structuredAttributes: fact.structuredAttributes,
          validAt: sourceContext?.validAt,
          contentHashSource: writeCategory === "fact" ? fact.content : undefined,
        },
      );
      if (routedRuleId) {
        log.debug(
          `routing applied for memory ${memoryId}: rule=${routedRuleId} category=${writeCategory} storage=${targetStorage.dir}`,
        );
      }
      // Temporal supersession (issue #375): when the new fact has structured
      // attributes, retire any older fact with the same entity + attribute
      // key that has a conflicting value.
      try {
        const supersessionEntityRef =
          typeof (fact as any).entityRef === "string"
            ? ((fact as any).entityRef as string)
            : undefined;
        await applyTemporalSupersession({
          storage: targetStorage,
          newMemoryId: memoryId,
          entityRef: supersessionEntityRef,
          structuredAttributes: fact.structuredAttributes,
          createdAt: supersessionOrderingAt(sourceContext?.validAt),
          enabled: this.config.temporalSupersessionEnabled,
        });
      } catch (err) {
        log.warn(`temporal-supersession: unexpected error: ${err}`);
      }
      trackBehaviorSignals(
        targetStorage,
        buildBehaviorSignalsForMemory({
          memoryId,
          category: writeCategory,
          content: fact.content,
          namespace: this.namespaceFromStorageDir(targetStorage.dir),
          confidence: fact.confidence,
          source: "extraction",
        }),
      );
      trackPersistedId(targetStorage, memoryId);
      if (
        threadEpisodeIdsForGraph &&
        !threadEpisodeIdsForGraph.includes(memoryId)
      ) {
        threadEpisodeIdsForGraph.push(memoryId);
      }
      await this.indexPersistedMemory(targetStorage, memoryId);
      await promoteMemoryToShared({
        sourceStorage: targetStorage,
        category: writeCategory,
        content: fact.content,
        confidence: fact.confidence,
        tags: fact.tags,
        entityRef:
          typeof (fact as any).entityRef === "string"
            ? (fact as any).entityRef
            : undefined,
        structuredAttributes: fact.structuredAttributes,
        sourceMemoryId: memoryId,
        importance,
        intentGoal: inferredIntent?.goal,
        intentActionType: inferredIntent?.actionType,
        intentEntityTypes: inferredIntent?.entityTypes,
        memoryKind,
        validAt: sourceContext?.validAt,
        source: extractionWriteSource,
      });
      // v8.2: graph edge building (fail-open — errors caught inside GraphIndex)
      if (this.config.multiGraphMemoryEnabled) {
        try {
          const graphContext = await ensureGraphContext(targetStorage);
          const entityRef =
            typeof (fact as any).entityRef === "string"
              ? (fact as any).entityRef
              : undefined;
          const memoryRelPath = resolvePersistedMemoryRelativePath({
            memoryId,
            pathById: graphContext.memoryPathById,
            category: writeCategory,
          });
          graphContext.memoryPathById.set(memoryId, memoryRelPath);
          appendMemoryToGraphContext({
            allMemsForGraph: graphContext.allMemsForGraph,
            storageDir: targetStorage.dir,
            memoryRelPath: memoryRelPath,
            memoryId,
            category: writeCategory,
            content: fact.content ?? "",
            entityRef,
          });
          await this.buildGraphEdge(
            targetStorage,
            memoryRelPath,
            entityRef,
            memoryId,
            fact.content ?? "",
            graphContext.allMemsForGraph,
            graphContext.memoryPathById,
            threadIdForExtraction ?? undefined,
            threadEpisodeIdsForGraph,
            graphContext.previousPersistedRelPath,
          );
          graphContext.previousPersistedRelPath = memoryRelPath;
        } catch {
          /* fail-open */
        }
      }
      if (
        this.config.verbatimArtifactsEnabled &&
        this.config.verbatimArtifactCategories.includes(writeCategory) &&
        fact.confidence >= this.config.verbatimArtifactsMinConfidence
      ) {
        // Reuse citedFactContent so the artifact carries the same citation
        // timestamp as the memory write above (Fix #3 — duplicate-citation).
        await targetStorage.writeArtifact(citedFactContent, {
          confidence: fact.confidence,
          tags: [...fact.tags, "artifact"],
          artifactType: this.artifactTypeForCategory(writeCategory),
          sourceMemoryId: memoryId,
          intentGoal: inferredIntent?.goal,
          intentActionType: inferredIntent?.actionType,
          intentEntityTypes: inferredIntent?.entityTypes,
        });
      }
      // Register in content-hash index after successful write.
      // Thread 3 fix: canonicalize by stripping any pre-existing citation so
      // the stored hash matches what the dedup check computes via
      // stripCitationForTemplate before calling contentHashIndex.has().
      if (this.contentHashIndex) {
        const canonicalFactContent =
          citationEnabled &&
          hasCitationForTemplate(fact.content, citationTemplate)
            ? stripCitationForTemplate(fact.content, citationTemplate)
            : fact.content;
        const hashRegisterKey =
          writeCategory === "procedure"
            ? buildProcedurePersistBody(fact.content, fact.procedureSteps)
            : canonicalFactContent;
        this.contentHashIndex.add(hashRegisterKey);
      }
    }

    for (const entity of entities) {
      try {
        const name = (entity as any)?.name;
        const type = (entity as any)?.type;
        if (
          typeof name !== "string" ||
          !name.trim() ||
          typeof type !== "string" ||
          !type.trim()
        ) {
          continue;
        }
        const safeFacts = Array.isArray((entity as any)?.facts)
          ? (entity as any).facts.filter((f: any) => typeof f === "string")
          : [];
          const id = await storage.writeEntity(name, type, safeFacts, {
            source: typeof (entity as any)?.source === "string" ? (entity as any).source : "extraction",
            timestamp: sourceContext?.validAt,
            sessionKey: sourceContext?.sessionKey,
            principal: sourceContext?.principal,
            structuredSections: Array.isArray((entity as any)?.structuredSections)
            ? (entity as any).structuredSections
            : undefined,
        });
        if (id) trackPersistedId(storage, id);
      } catch (err) {
        log.warn(`persistExtraction: entity write failed: ${err}`);
      }
    }

    // Persist entity relationships (v7.0)
    if (
      this.config.entityRelationshipsEnabled &&
      Array.isArray(result.relationships)
    ) {
      for (const rel of result.relationships.slice(0, 5)) {
        if (!rel.source || !rel.target || !rel.label) continue;
        try {
          // Add bidirectional relationship
          await storage.addEntityRelationship(rel.source, {
            target: rel.target,
            label: rel.label,
          });
          await storage.addEntityRelationship(rel.target, {
            target: rel.source,
            label: `${rel.label} (reverse)`,
          });
        } catch (err) {
          log.debug(`relationship persist failed: ${err}`);
        }
      }
    }

    // Persist entity activity (v7.0)
    if (this.config.entityActivityLogEnabled) {
      const today = new Date().toISOString().slice(0, 10);
      for (const entity of entities) {
        const name = (entity as any)?.name;
        const type = (entity as any)?.type;
        if (typeof name !== "string" || typeof type !== "string") continue;
        try {
          const normalized = normalizeEntityName(name, type);
          await storage.addEntityActivity(
            normalized,
            { date: today, note: "Mentioned in conversation" },
            this.config.entityActivityLogMaxEntries,
          );
        } catch (err) {
          log.debug(`activity persist failed: ${err}`);
        }
      }
    }

    if (profileUpdates.length > 0) {
      await storage.appendToProfile(profileUpdates);
    }

    // Persist questions
    for (const q of questions) {
      const id = await storage.writeQuestion(q.question, q.context, q.priority);
      if (id) trackPersistedId(storage, id);
    }

    // Persist identity reflection
    if (this.config.identityEnabled && result.identityReflection) {
      try {
        await storage.appendIdentityReflection(result.identityReflection);
      } catch (err) {
        log.debug(`identity reflection write failed: ${err}`);
      }
    }

    // Save content-hash index after batch
    if (this.contentHashIndex) {
      await this.contentHashIndex
        .save()
        .catch((err) => log.warn(`content-hash index save failed: ${err}`));
    }

    for (const {
      storage: targetStorage,
      events,
    } of behaviorSignalsByStorage.values()) {
      const dedupedSignals = dedupeBehaviorSignalsByMemoryAndHash(events);
      if (dedupedSignals.length === 0) continue;
      await targetStorage
        .appendBehaviorSignals(dedupedSignals)
        .catch((err) =>
          log.warn(`appendBehaviorSignals failed (non-fatal): ${err}`),
        );
    }

    const dedupSuffix = dedupedCount > 0 ? ` (${dedupedCount} deduped)` : "";
    const gatedSuffix =
      importanceGatedCount > 0 ? ` (${importanceGatedCount} gated)` : "";
    const judgeSuffix =
      judgeGatedCount > 0 ? ` (${judgeGatedCount} judge-rejected)` : "";
    log.info(
      `persisted: ${facts.length - dedupedCount - importanceGatedCount - judgeGatedCount} facts${dedupSuffix}${gatedSuffix}${judgeSuffix}, ${entities.length} entities, ${questions.length} questions, ${profileUpdates.length} profile updates`,
    );

    // Update temporal + tag indexes (v8.1) — fire-and-forget, fail-open
    void (async () => {
      if (persistedIdsByStorage.size === 0) {
        await this.updateTemporalTagIndexes(storage, []);
        return;
      }
      for (const entry of persistedIdsByStorage.values()) {
        await this.updateTemporalTagIndexes(entry.storage, entry.ids);
      }
    })().catch((err) =>
      log.debug(`temporal-index update error (non-fatal): ${err}`),
    );

    // Return the persisted fact IDs for threading
    return persistedIds;
  }

  private async indexPersistedMemory(
    storage: StorageManager,
    memoryId: string,
  ): Promise<void> {
    if (!this.config.embeddingFallbackEnabled) return;
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
      this.config.graphWriteSessionAdjacencyEnabled !== false &&
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
    // Build temporal/tag indexes whenever either consumer is enabled:
    // - queryAwareIndexingEnabled: uses indexes for query-aware prefiltering in recall
    // - parallelRetrievalEnabled: temporal agent reads index_time.json for date-range lookup
    // Enabling only parallelRetrievalEnabled without queryAwareIndexingEnabled would silently
    // produce an empty temporal index, leaving the temporal agent with no data to work from.
    if (
      !this.config.queryAwareIndexingEnabled &&
      !this.config.parallelRetrievalEnabled
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
        needsFullRebuild && this.config.namespacesEnabled
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
    log.info("running consolidation pass");
    let merged = 0;
    let invalidated = 0;

    // Flush access tracking buffer first
    if (this.accessTrackingBuffer.size > 0) {
      await this.flushAccessTracking();
    }

    let allMemories = await this.storage.readAllMemories();
    if (allMemories.length < 5) {
      return { memoriesProcessed: allMemories.length, merged, invalidated };
    }

    const recent = allMemories
      .sort(
        (a, b) =>
          new Date(b.frontmatter.created).getTime() -
          new Date(a.frontmatter.created).getTime(),
      )
      .slice(0, 20);

    const older = allMemories.sort(
      (a, b) =>
        new Date(a.frontmatter.created).getTime() -
        new Date(b.frontmatter.created).getTime(),
    );

    const profile = await this.storage.readProfile();
    const result = await this.extraction.consolidate(recent, older, profile);

    // Build a lookup map from the already-loaded corpus to avoid repeated
    // readAllMemories() scans inside getMemoryById for pre-action deindex reads.
    const memoryLookup = this.config.queryAwareIndexingEnabled
      ? new Map(allMemories.map((m) => [m.frontmatter.id, m]))
      : null;

    for (const item of result.items) {
      switch (item.action) {
        case "INVALIDATE": {
          // Capture path/frontmatter before invalidation for index cleanup
          const toInvalidate = this.config.queryAwareIndexingEnabled
            ? (memoryLookup?.get(item.existingId) ?? null)
            : null;
          if (await this.storage.invalidateMemory(item.existingId)) {
            invalidated += 1;
            await this.embeddingFallback.removeFromIndex(item.existingId);
            if (toInvalidate?.path && toInvalidate.frontmatter?.created) {
              deindexMemory(
                this.config.memoryDir,
                toInvalidate.path,
                toInvalidate.frontmatter.created,
                toInvalidate.frontmatter.tags ?? [],
              );
            }
          }
          break;
        }
        case "UPDATE":
          if (item.updatedContent) {
            await this.storage.updateMemory(
              item.existingId,
              item.updatedContent,
              {
                lineage: [item.existingId],
              },
            );
            await this.indexPersistedMemory(this.storage, item.existingId);
            // updateMemory() only changes content/updated/lineage — path, created, and tags
            // are preserved, so the temporal/tag index entry is already correct; no reindex needed.
          }
          break;
        case "MERGE":
          if (item.updatedContent && item.mergeWith) {
            await this.storage.updateMemory(
              item.existingId,
              item.updatedContent,
              {
                supersedes: item.mergeWith,
                lineage: [item.existingId, item.mergeWith],
              },
            );
            await this.indexPersistedMemory(this.storage, item.existingId);
            // updateMemory() only changes content/updated/supersedes/lineage — path, created, and tags
            // are preserved, so the temporal/tag index entry for the survivor is already correct.
            // Capture before invalidation for index cleanup
            const toMergeInvalidate = this.config.queryAwareIndexingEnabled
              ? (memoryLookup?.get(item.mergeWith) ?? null)
              : null;
            if (await this.storage.invalidateMemory(item.mergeWith)) {
              invalidated += 1;
              merged += 1;
              await this.embeddingFallback.removeFromIndex(item.mergeWith);
              if (
                toMergeInvalidate?.path &&
                toMergeInvalidate.frontmatter?.created
              ) {
                deindexMemory(
                  this.config.memoryDir,
                  toMergeInvalidate.path,
                  toMergeInvalidate.frontmatter.created,
                  toMergeInvalidate.frontmatter.tags ?? [],
                );
              }
            }
          }
          break;
      }
    }

    if (result.profileUpdates.length > 0) {
      await this.storage.appendToProfile(result.profileUpdates);
    }

    for (const entity of result.entityUpdates) {
      const safeFacts = Array.isArray((entity as any)?.facts)
        ? (entity as any).facts.filter((f: any) => typeof f === "string")
        : [];
      await this.storage.writeEntity(entity.name, entity.type, safeFacts, {
        source: "consolidation",
        structuredSections: Array.isArray((entity as any)?.structuredSections)
          ? (entity as any).structuredSections
          : undefined,
      });
    }

    // Merge fragmented entity files
    const entitiesMerged = await this.storage.mergeFragmentedEntities();
    if (entitiesMerged > 0) {
      log.info(`merged ${entitiesMerged} fragmented entity files`);
    }

    if (this.config.entitySummaryEnabled) {
      try {
        const synthesized = await this.processEntitySynthesisQueue(
          this.config.defaultNamespace,
          5,
        );
        if (synthesized > 0) {
          log.info(`refreshed ${synthesized} entity syntheses`);
        }
      } catch (err) {
        log.debug(`entity synthesis pass failed: ${err}`);
      }
    }

    // Clean expired commitments
    const deletedCommitments = await this.storage.cleanExpiredCommitments(
      this.config.commitmentDecayDays,
    );
    if (deletedCommitments.length > 0) {
      log.info(`cleaned ${deletedCommitments.length} expired commitments`);
      if (this.config.queryAwareIndexingEnabled) {
        for (const m of deletedCommitments) {
          deindexMemory(
            this.config.memoryDir,
            m.path,
            m.frontmatter.created,
            m.frontmatter.tags ?? [],
          );
        }
      }
    }

    if (
      this.config.creationMemoryEnabled &&
      this.config.commitmentLedgerEnabled &&
      this.config.commitmentLifecycleEnabled
    ) {
      try {
        const lifecycle = await applyCommitmentLedgerLifecycle({
          memoryDir: this.config.memoryDir,
          commitmentLedgerDir: this.config.commitmentLedgerDir,
          enabled: true,
          decayDays: this.config.commitmentDecayDays,
        });
        if (
          lifecycle.transitionedToExpired.length > 0 ||
          lifecycle.deletedResolved.length > 0
        ) {
          log.info(
            `commitment ledger lifecycle: expired ${lifecycle.transitionedToExpired.length}, cleaned ${lifecycle.deletedResolved.length}`,
          );
        }
      } catch (err) {
        log.debug(`commitment ledger lifecycle pass failed: ${err}`);
      }
    }

    // Clean memories past their TTL (speculative memories auto-expire)
    const deletedTTL = await this.storage.cleanExpiredTTL();
    if (deletedTTL.length > 0) {
      log.info(`cleaned ${deletedTTL.length} TTL-expired memories`);
      if (this.config.queryAwareIndexingEnabled) {
        for (const m of deletedTTL) {
          deindexMemory(
            this.config.memoryDir,
            m.path,
            m.frontmatter.created,
            m.frontmatter.tags ?? [],
          );
        }
      }
    }

    // v8.3 Lifecycle policy pass — deterministic promotion/decay metadata
    if (this.config.lifecyclePolicyEnabled) {
      try {
        const lightSleepStartedAt = new Date().toISOString();
        const lifecycleCorpus = await this.storage.readAllMemories();
        await this.runLifecyclePolicyPass(lifecycleCorpus);
        await this.recordScheduledDreamsPhaseRun(
          "lightSleep",
          lifecycleCorpus.length,
          `scheduled lifecycle policy pass assessed ${lifecycleCorpus.length} memories`,
          {
            startedAt: lightSleepStartedAt,
            completedAt: new Date().toISOString(),
          },
        );
      } catch (err) {
        log.warn(`lifecycle policy pass failed (ignored): ${err}`);
      }
    }

    // v8.3 Compression guideline learning pass (default off, fail-open).
    await this.runCompressionGuidelineLearningPass();

    try {
      const deepSleepStartedAt = new Date().toISOString();
      await this.runTierMigrationCycle(this.storage, "maintenance");
      allMemories = await this.storage.readAllMemories();

      // Fact archival pass (v6.0) — move old, low-importance, rarely-accessed facts to archive/
      if (this.config.factArchivalEnabled) {
        const archived = await this.runFactArchival(allMemories);
        if (archived > 0) {
          log.info(`archived ${archived} old low-importance facts`);
        }
      }
      await this.recordScheduledDreamsPhaseRun(
        "deepSleep",
        allMemories.length,
        `scheduled deep-sleep maintenance assessed ${allMemories.length} memories`,
        {
          startedAt: deepSleepStartedAt,
          completedAt: new Date().toISOString(),
        },
      );
    } catch (err) {
      log.warn(`deep-sleep maintenance pass failed (ignored): ${err}`);
      try {
        allMemories = await this.storage.readAllMemories();
      } catch (readErr) {
        log.warn(`deep-sleep maintenance recovery read failed: ${readErr}`);
        throw err;
      }
    }

    // Semantic consolidation pass — find similar memories, synthesize canonical versions
    if (this.config.semanticConsolidationEnabled) {
      try {
        const stateFilePath = path.join(
          this.config.memoryDir,
          "state",
          "semantic-consolidation-last-run.json",
        );
        let shouldRun = true;
        try {
          const stateRaw = await readFile(stateFilePath, "utf-8");
          const stateData = JSON.parse(stateRaw) as { lastRunAt?: string };
          if (stateData.lastRunAt) {
            const lastRunMs = new Date(stateData.lastRunAt).getTime();
            const intervalMs =
              this.config.semanticConsolidationIntervalHours * 60 * 60 * 1000;
            if (Date.now() - lastRunMs < intervalMs) {
              shouldRun = false;
              log.debug(
                "[semantic-consolidation] skipping — not enough time since last run",
              );
            }
          }
        } catch {
          // No state file yet — first run
        }

        if (shouldRun) {
          const remStartedAt = new Date().toISOString();
          const semResult = await this.runSemanticConsolidation();
          let remItemsProcessed = allMemories.length;
          try {
            allMemories = await this.storage.readAllMemories();
            remItemsProcessed = allMemories.length;
          } catch (err) {
            log.warn(
              `[semantic-consolidation] post-run telemetry refresh failed (non-fatal): ${err}`,
            );
          }
          await this.recordScheduledDreamsPhaseRun(
            "rem",
            remItemsProcessed,
            `scheduled REM consolidation found ${semResult.clustersFound} clusters`,
            {
              startedAt: remStartedAt,
              completedAt: new Date().toISOString(),
            },
          );
          if (semResult.memoriesArchived > 0) {
            log.info(
              `[semantic-consolidation] archived ${semResult.memoriesArchived} memories during maintenance`,
            );
          }
          // Only persist last-run timestamp if the run succeeded (had no errors or made progress)
          if (semResult.errors === 0 || semResult.memoriesArchived > 0) {
            const stateDir = path.join(this.config.memoryDir, "state");
            await mkdir(stateDir, { recursive: true });
            await writeFile(
              stateFilePath,
              JSON.stringify({ lastRunAt: new Date().toISOString() }),
              "utf-8",
            );
          }
        }
      } catch (err) {
        log.warn(
          `[semantic-consolidation] maintenance pass failed (non-fatal): ${err}`,
        );
      }
    }

    // Auto-consolidate IDENTITY.md if it's getting large
    if (this.config.identityEnabled) {
      await this.autoConsolidateIdentity();
    }

    // Auto-consolidate profile.md if it exceeds max lines
    const profileSection = this.getRecallSectionEntry("profile");
    const profileConsolidationTriggerLines =
      typeof profileSection?.consolidateTriggerLines === "number"
        ? Math.max(0, Math.floor(profileSection.consolidateTriggerLines))
        : undefined;
    const profileConsolidationTargetLines =
      typeof profileSection?.consolidateTargetLines === "number"
        ? Math.max(0, Math.floor(profileSection.consolidateTargetLines))
        : 50;
    if (
      await this.storage.profileNeedsConsolidation(
        profileConsolidationTriggerLines,
      )
    ) {
      log.info("profile.md exceeds max lines — running smart consolidation");
      const currentProfile = await this.storage.readProfile();
      if (currentProfile) {
        const profileResult = await this.extraction.consolidateProfile(
          currentProfile,
          profileConsolidationTargetLines,
        );
        if (profileResult) {
          await this.storage.writeProfile(profileResult.consolidatedProfile);
          log.info(
            `profile.md consolidated: removed ${profileResult.removedCount} items — ${profileResult.summary}`,
          );
        }
      }
    }

    // Memory Summarization (Phase 4A)
    if (this.config.summarizationEnabled) {
      await this.runSummarization(allMemories);
    }

    // Topic Extraction (Phase 4B)
    if (this.config.topicExtractionEnabled) {
      await this.runTopicExtraction(allMemories);
    }

    const meta = await this.storage.loadMeta();
    meta.lastConsolidationAt = new Date().toISOString();
    await this.storage.saveMeta(meta);

    // Temporal Memory Tree (v8.2) — rebuild nodes from all memories, fail-open
    if (this.config.temporalMemoryTreeEnabled) {
      try {
        const tmtEntries = allMemories
          .filter(
            (m) =>
              m.frontmatter.status !== "superseded" &&
              m.frontmatter.status !== "archived" &&
              m.frontmatter.status !== "forgotten",
          )
          .map((m) => ({
            path: m.path,
            id: m.frontmatter.id,
            created: m.frontmatter.created,
            content: m.content,
          }));
        await this.tmtBuilder.maybeRebuildNodes(
          tmtEntries,
          async (texts, level) => {
            const prompt = `You are a memory archivist. Summarize the following ${level}-level memories into 3–5 sentences, preserving key facts, decisions, and preferences.\n\n${texts.map((t, i) => `[${i + 1}] ${t}`).join("\n\n")}`;
            const response = await this.fastChatCompletion(
              [
                {
                  role: "system",
                  content:
                    "Respond with a 3–5 sentence narrative summary. No JSON, just plain prose.",
                },
                { role: "user", content: prompt },
              ],
              {
                temperature: 0.3,
                maxTokens: this.config.tmtSummaryMaxTokens,
                operation: "tmt_summary",
                priority: "background",
              },
            );
            return response?.content?.trim() || texts.slice(0, 3).join(" ");
          },
        );
      } catch (err) {
        log.warn(`tmt: consolidation hook failed (ignored): ${err}`);
      }
    }

    if (this.consolidationObservers.size > 0) {
      const observation: ConsolidationObservation = {
        runAt: new Date().toISOString(),
        recentMemories: recent,
        existingMemories: older.slice(-50),
        profile,
        result,
        merged,
        invalidated,
      };
      for (const observer of this.consolidationObservers) {
        try {
          await observer(observation);
        } catch (err) {
          log.warn(`consolidation observer failed (ignored): ${err}`);
        }
      }
    }

    log.info("consolidation complete");
    return { memoriesProcessed: allMemories.length, merged, invalidated };
  }

  async optimizeCompressionGuidelines(options?: {
    dryRun?: boolean;
    eventLimit?: number;
  }): Promise<{
    enabled: boolean;
    dryRun: boolean;
    eventCount: number;
    previousGuidelineVersion: number | null;
    nextGuidelineVersion: number;
    changedRules: number;
    semanticRefinementApplied: boolean;
    persisted: boolean;
    draftContentHash: string | null;
  }> {
    const dryRun = options?.dryRun === true;
    const eventLimit =
      typeof options?.eventLimit === "number"
        ? Math.max(0, Math.floor(options.eventLimit))
        : 500;

    const [activeState, draftState] = await Promise.all([
      this.storage.readCompressionGuidelineOptimizerState(),
      this.storage.readCompressionGuidelineDraftState().catch(() => null),
    ]);
    const previousState =
      draftState &&
      ((activeState?.guidelineVersion ?? 0) < draftState.guidelineVersion ||
        (activeState?.guidelineVersion ?? 0) === draftState.guidelineVersion)
        ? draftState
        : activeState;

    if (!this.config.compressionGuidelineLearningEnabled) {
      return {
        enabled: false,
        dryRun,
        eventCount: 0,
        previousGuidelineVersion: previousState?.guidelineVersion ?? null,
        nextGuidelineVersion: previousState?.guidelineVersion ?? 0,
        changedRules: 0,
        semanticRefinementApplied: false,
        persisted: false,
        draftContentHash: null,
      };
    }

    let events = await this.storage.readMemoryActionEvents(eventLimit);
    if (eventLimit > 0) {
      let effectiveEvents = events.filter((event) => event.dryRun !== true);
      let fetchLimit = eventLimit;
      while (
        effectiveEvents.length < eventLimit &&
        events.length === fetchLimit
      ) {
        fetchLimit = Math.min(fetchLimit * 2, fetchLimit + 1000);
        if (fetchLimit <= events.length) break;
        events = await this.storage.readMemoryActionEvents(fetchLimit);
        effectiveEvents = events.filter((event) => event.dryRun !== true);
      }
      events = effectiveEvents.slice(-eventLimit);
    }
    const generatedAt = new Date().toISOString();
    const candidate = computeCompressionGuidelineCandidate(events, {
      generatedAtIso: generatedAt,
      previousState,
    });
    if (candidate.eventCounts.total === 0) {
      return {
        enabled: true,
        dryRun,
        eventCount: 0,
        previousGuidelineVersion: previousState?.guidelineVersion ?? null,
        nextGuidelineVersion: previousState?.guidelineVersion ?? 0,
        changedRules: 0,
        semanticRefinementApplied: false,
        persisted: false,
        draftContentHash: null,
      };
    }
    const refinedCandidate =
      await refineCompressionGuidelineCandidateSemantically(candidate, {
        enabled: this.config.compressionGuidelineSemanticRefinementEnabled,
        timeoutMs: this.config.compressionGuidelineSemanticTimeoutMs,
        runRefinement: async (baseline) => {
          const prompt = [
            "You refine compression policy suggestions conservatively.",
            "Return JSON only in this shape:",
            '{"updates":[{"action":"summarize_node","delta":0.02,"confidence":"medium","note":"..."}]}',
            "Constraints:",
            "- Keep updates sparse and conservative.",
            "- delta must stay between -0.15 and 0.15.",
            "- Only include actions present in the input.",
            "Input candidate:",
            JSON.stringify(baseline),
          ].join("\n");

          const response = await this.fastChatCompletion(
            [
              {
                role: "system",
                content: "Respond with strict JSON only. No markdown.",
              },
              { role: "user", content: prompt },
            ],
            {
              temperature: 0.1,
              maxTokens: 400,
              operation: "compression_guideline_semantic_refinement",
              priority: "background",
            },
          );

          return this.parseCompressionSemanticRefinement(
            response?.content ?? "",
          );
        },
      });

    const content = renderCompressionGuidelinesMarkdown(refinedCandidate);
    const contentHash = createHash("sha256").update(content).digest("hex");
    const semanticRefinementApplied =
      JSON.stringify(refinedCandidate.ruleUpdates) !==
      JSON.stringify(candidate.ruleUpdates);
    const changedRules = refinedCandidate.ruleUpdates.filter(
      (rule) => rule.delta !== 0,
    ).length;

    if (!dryRun) {
      await this.storage.writeCompressionGuidelineDraft(content);
      await this.storage.writeCompressionGuidelineDraftState({
        version: refinedCandidate.optimizerVersion,
        updatedAt: refinedCandidate.generatedAt,
        sourceWindow: refinedCandidate.sourceWindow,
        eventCounts: refinedCandidate.eventCounts,
        guidelineVersion: refinedCandidate.guidelineVersion,
        contentHash,
        activationState: "draft",
        actionSummaries: refinedCandidate.actionSummaries,
        ruleUpdates: refinedCandidate.ruleUpdates,
      });
    }

    return {
      enabled: true,
      dryRun,
      eventCount: candidate.eventCounts.total,
      previousGuidelineVersion: previousState?.guidelineVersion ?? null,
      nextGuidelineVersion: refinedCandidate.guidelineVersion,
      changedRules,
      semanticRefinementApplied,
      persisted: !dryRun,
      draftContentHash: dryRun ? null : contentHash,
    };
  }

  async activateCompressionGuidelineDraft(options?: {
    expectedContentHash?: string;
    expectedGuidelineVersion?: number;
  }): Promise<{
    enabled: boolean;
    activated: boolean;
    guidelineVersion: number | null;
    reason?:
      | "disabled"
      | "missing_draft"
      | "expected_revision_required"
      | "content_hash_mismatch"
      | "guideline_version_mismatch"
      | "draft_changed";
  }> {
    if (!this.config.compressionGuidelineLearningEnabled) {
      return {
        enabled: false,
        activated: false,
        guidelineVersion: null,
        reason: "disabled",
      };
    }

    const draftState = await this.storage.readCompressionGuidelineDraftState();
    if (!draftState) {
      return {
        enabled: true,
        activated: false,
        guidelineVersion: null,
        reason: "missing_draft",
      };
    }

    const expectedContentHash = options?.expectedContentHash?.trim();
    const expectedGuidelineVersion = options?.expectedGuidelineVersion;

    if (
      (!expectedContentHash || expectedContentHash.length === 0) &&
      typeof expectedGuidelineVersion !== "number"
    ) {
      return {
        enabled: true,
        activated: false,
        guidelineVersion: null,
        reason: "expected_revision_required",
      };
    }

    if (expectedContentHash && draftState.contentHash !== expectedContentHash) {
      return {
        enabled: true,
        activated: false,
        guidelineVersion: null,
        reason: "content_hash_mismatch",
      };
    }

    if (
      typeof expectedGuidelineVersion === "number" &&
      draftState.guidelineVersion !== expectedGuidelineVersion
    ) {
      return {
        enabled: true,
        activated: false,
        guidelineVersion: null,
        reason: "guideline_version_mismatch",
      };
    }

    const activated = await this.storage.activateCompressionGuidelineDraft({
      ...(expectedContentHash ? { expectedContentHash } : {}),
      ...(typeof expectedGuidelineVersion === "number"
        ? { expectedGuidelineVersion }
        : {}),
    });
    return {
      enabled: true,
      activated,
      guidelineVersion: activated ? draftState.guidelineVersion : null,
      ...(activated ? {} : { reason: "draft_changed" as const }),
    };
  }

  private async runCompressionGuidelineLearningPass(): Promise<void> {
    if (!this.config.compressionGuidelineLearningEnabled) return;
    try {
      const result = await this.optimizeCompressionGuidelines({
        dryRun: false,
        eventLimit: 500,
      });
      log.info(
        `compression guideline learning updated (${result.eventCount} events)`,
      );
    } catch (err) {
      log.warn(`compression guideline learning failed (ignored): ${err}`);
    }
  }

  private async buildCompressionGuidelineRecallSection(): Promise<
    string | null
  > {
    if (!this.config.contextCompressionActionsEnabled) return null;
    if (!this.config.compressionGuidelineLearningEnabled) return null;

    const state = await this.storage
      .readCompressionGuidelineOptimizerState()
      .catch(() => null);
    if (!state || state.guidelineVersion <= 0) return null;

    const raw = await this.storage
      .readCompressionGuidelines()
      .catch(() => null);
    const summary = raw ? formatCompressionGuidelinesForRecall(raw, 5) : null;
    if (!summary) return null;

    return [
      "## Active Compression Guidelines",
      "",
      `Guideline version: ${state.guidelineVersion}`,
      `Updated: ${state.updatedAt}`,
      "",
      summary,
    ].join("\n");
  }

  private parseCompressionSemanticRefinement(raw: string): {
    updates: Array<{
      action: MemoryActionType;
      delta?: number;
      confidence?: "low" | "medium" | "high";
      note?: string;
    }>;
  } | null {
    if (typeof raw !== "string" || raw.trim().length === 0) return null;
    const trimmed = raw.trim();
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) return null;

    try {
      const parsed = JSON.parse(trimmed.slice(start, end + 1)) as {
        updates?: Array<{
          action?: unknown;
          delta?: unknown;
          confidence?: unknown;
          note?: unknown;
        }>;
      };
      if (!Array.isArray(parsed?.updates)) return null;

      const validActions = new Set<MemoryActionType>([
        "store_episode",
        "store_note",
        "update_note",
        "create_artifact",
        "summarize_node",
        "discard",
        "link_graph",
      ]);

      const updates = parsed.updates
        .filter(
          (item) =>
            item &&
            typeof item.action === "string" &&
            validActions.has(item.action as MemoryActionType),
        )
        .map((item) => {
          const confidence: "low" | "medium" | "high" | undefined =
            item.confidence === "low" ||
            item.confidence === "medium" ||
            item.confidence === "high"
              ? item.confidence
              : undefined;
          return {
            action: item.action as MemoryActionType,
            delta:
              typeof item.delta === "number" && Number.isFinite(item.delta)
                ? item.delta
                : undefined,
            confidence,
            note: typeof item.note === "string" ? item.note : undefined,
          };
        });

      return { updates };
    } catch {
      return null;
    }
  }

  private actionOutcomePriorDelta(event: MemoryActionEvent): number {
    if (event.outcome === "failed") return -0.3;
    if (event.policyDecision === "deny") return -0.22;
    if (event.policyDecision === "defer") return -0.14;
    if (event.outcome === "skipped") return -0.1;

    if (event.outcome !== "applied") return 0;
    switch (event.action) {
      case "store_episode":
      case "store_note":
      case "update_note":
        return 0.08;
      case "create_artifact":
      case "summarize_node":
      case "link_graph":
        return 0.04;
      case "discard":
        return -0.03;
      default:
        return 0;
    }
  }

  private async buildLifecycleActionPriors(
    storage: StorageManager = this.storage,
  ): Promise<Map<string, number>> {
    const events = await storage.readMemoryActionEvents(1200);
    if (events.length === 0) return new Map<string, number>();

    const nowMs = Date.now();
    const windowMs = 14 * 24 * 60 * 60 * 1000;
    const byMemory = new Map<
      string,
      Array<{ weightedDelta: number; weight: number }>
    >();

    for (const event of events) {
      if (
        typeof event.memoryId !== "string" ||
        event.memoryId.trim().length === 0
      )
        continue;
      const ts = Date.parse(event.timestamp);
      if (!Number.isFinite(ts)) continue;
      const ageMs = nowMs - ts;
      if (ageMs < 0 || ageMs > windowMs) continue;

      const delta = this.actionOutcomePriorDelta(event);
      if (delta === 0) continue;

      const recencyWeight = Math.max(0.2, 1 - ageMs / windowMs);
      const list = byMemory.get(event.memoryId) ?? [];
      if (list.length >= 8) list.shift();
      list.push({
        weightedDelta: delta * recencyWeight,
        weight: recencyWeight,
      });
      byMemory.set(event.memoryId, list);
    }

    const out = new Map<string, number>();
    for (const [memoryId, deltas] of byMemory.entries()) {
      if (deltas.length === 0) continue;
      const weightedSum = deltas.reduce(
        (sum, item) => sum + item.weightedDelta,
        0,
      );
      const weightTotal = deltas.reduce((sum, item) => sum + item.weight, 0);
      if (weightTotal <= 0) continue;
      const score = weightedSum / weightTotal;
      out.set(memoryId, Math.max(-0.25, Math.min(0.15, score)));
    }
    return out;
  }

  private async recordScheduledDreamsPhaseRun(
    phase: "lightSleep" | "rem" | "deepSleep",
    itemsProcessed: number,
    notes: string,
    timing: { startedAt?: string; completedAt?: string } = {},
  ): Promise<void> {
    try {
      const { recordDreamsPhaseRun } = await import("./maintenance/dreams-ledger.js");
      await recordDreamsPhaseRun({
        memoryDir: this.storage.dir,
        phase,
        trigger: "scheduled",
        itemsProcessed,
        notes,
        startedAt: timing.startedAt,
        completedAt: timing.completedAt,
      });
    } catch (error) {
      log.debug(`dreams ledger scheduled ${phase} write failed (non-fatal): ${error}`);
    }
  }

  async runLifecyclePolicyNow(storage: StorageManager = this.storage): Promise<{ memoriesAssessed: number }> {
    const lifecycleCorpus = await storage.readAllMemories();
    await this.runLifecyclePolicyPass(lifecycleCorpus, storage);
    return { memoriesAssessed: lifecycleCorpus.length };
  }

  private async runLifecyclePolicyPass(
    allMemories: MemoryFile[],
    storage: StorageManager = this.storage,
  ): Promise<void> {
    const now = new Date();
    const nowIso = now.toISOString();
    const countsByState: Record<LifecycleState, number> = {
      candidate: 0,
      validated: 0,
      active: 0,
      stale: 0,
      archived: 0,
    };
    const transitionCounts: Record<string, number> = {};
    let updatedCount = 0;
    let disputedCount = 0;
    let evaluatedCount = 0;

    const thresholds = this.effectiveLifecycleThresholds();
    const policy = {
      promoteHeatThreshold: thresholds.promoteHeatThreshold,
      staleDecayThreshold: thresholds.staleDecayThreshold,
      archiveDecayThreshold: thresholds.archiveDecayThreshold,
      protectedCategories: this.config.lifecycleProtectedCategories,
    };
    const actionPriors = await this.buildLifecycleActionPriors(storage);

    for (const memory of allMemories) {
      if (
        memory.frontmatter.status === "superseded" ||
        memory.frontmatter.status === "forgotten"
      ) {
        continue;
      }
      evaluatedCount += 1;
      const currentState = resolveLifecycleState(memory.frontmatter);
      const actionPriorScore = actionPriors.get(memory.frontmatter.id);
      const signals: LifecycleSignals | undefined =
        typeof actionPriorScore === "number" &&
        Number.isFinite(actionPriorScore)
          ? { actionPriorScore }
          : undefined;
      const decision = decideLifecycleTransition(memory, policy, now, signals);
      const nextState: LifecycleState =
        memory.frontmatter.status === "archived"
          ? "archived"
          : decision.nextState;

      countsByState[nextState] += 1;
      if (memory.frontmatter.verificationState === "disputed") {
        disputedCount += 1;
      }
      if (nextState !== currentState) {
        const key = `${currentState}->${nextState}`;
        transitionCounts[key] = (transitionCounts[key] ?? 0) + 1;
      }

      const prevHeat = memory.frontmatter.heatScore;
      const prevDecay = memory.frontmatter.decayScore;
      const scoreDelta =
        Math.abs((prevHeat ?? -1) - decision.heatScore) +
        Math.abs((prevDecay ?? -1) - decision.decayScore);
      const shouldPersist =
        memory.frontmatter.lifecycleState !== nextState ||
        memory.frontmatter.heatScore === undefined ||
        memory.frontmatter.decayScore === undefined ||
        memory.frontmatter.lastValidatedAt === undefined ||
        scoreDelta >= 0.01;

      if (!shouldPersist) continue;

      const wrote = await storage.writeMemoryFrontmatter(memory, {
        lifecycleState: nextState,
        heatScore: decision.heatScore,
        decayScore: decision.decayScore,
        lastValidatedAt: nowIso,
      });
      if (wrote) updatedCount += 1;
    }

    if (!this.config.lifecycleMetricsEnabled) return;

    const total = evaluatedCount;
    const metrics = {
      generatedAt: nowIso,
      memoriesEvaluated: total,
      memoriesUpdated: updatedCount,
      countsByLifecycleState: countsByState,
      transitionCounts,
      staleRatio: total > 0 ? countsByState.stale / total : 0,
      disputedRatio: total > 0 ? disputedCount / total : 0,
      policy: {
        promoteHeatThreshold: thresholds.promoteHeatThreshold,
        staleDecayThreshold: thresholds.staleDecayThreshold,
        archiveDecayThreshold: thresholds.archiveDecayThreshold,
        protectedCategories: this.config.lifecycleProtectedCategories,
      },
    };
    const metricsPath = path.join(
      storage.dir,
      "state",
      "lifecycle-metrics.json",
    );
    await mkdir(path.dirname(metricsPath), { recursive: true });
    await writeFile(metricsPath, JSON.stringify(metrics, null, 2), "utf-8");
  }

  /**
   * Archive old, low-importance, rarely-accessed facts (v6.0).
   * Moves eligible facts from facts/ to archive/YYYY-MM-DD/.
   * Returns the number of archived facts.
   */
  private async runFactArchival(
    allMemories: import("./types.js").MemoryFile[],
  ): Promise<number> {
    const now = Date.now();
    const ageCutoffMs = this.config.factArchivalAgeDays * 24 * 60 * 60 * 1000;
    const protectedCategories = new Set(
      this.config.factArchivalProtectedCategories,
    );
    let archivedCount = 0;

    for (const memory of allMemories) {
      const fm = memory.frontmatter;

      // Skip already-archived or superseded
      if (fm.status && fm.status !== "active") continue;

      // Skip protected categories
      if (protectedCategories.has(fm.category)) continue;

      // Skip corrections (always keep)
      if (fm.category === "correction") continue;

      // Check age requirement
      const createdMs = new Date(fm.created).getTime();
      if (now - createdMs < ageCutoffMs) continue;

      // Check importance (only archive low-importance facts)
      const importanceScore = fm.importance?.score ?? 0.5;
      if (importanceScore >= this.config.factArchivalMaxImportance) continue;

      // Check access count
      const accessCount = fm.accessCount ?? 0;
      if (accessCount > this.config.factArchivalMaxAccessCount) continue;

      // All criteria met — archive
      const result = await this.storage.archiveMemory(memory);
      if (result) {
        // Remove from content-hash index since it's no longer in hot search.
        // Prefer the raw-content hash stored on the frontmatter at write
        // time (contentHash) — it is format-agnostic and survives any
        // citation template.
        if (this.contentHashIndex) {
          if (memory.frontmatter.contentHash) {
            // Modern memory: frontmatter.contentHash is already a SHA-256
            // hex string — use removeByHash to avoid double-hashing.
            this.contentHashIndex.removeByHash(memory.frontmatter.contentHash);
          } else {
            // Legacy memory written before contentHash was stored on the
            // frontmatter.  Pre-#369 facts were stored without inline
            // citations, so memory.content is the raw fact text and we can
            // remove the hash directly from the content.  This clears
            // stale dedup entries so the fact can be re-extracted.
            log.warn(
              `[fact-archival] removing hash for legacy memory ${memory.frontmatter.id ?? "(unknown)"} via content fallback — no contentHash in frontmatter`,
            );
            this.contentHashIndex.remove(memory.content);
          }
        }
        await this.embeddingFallback.removeFromIndex(memory.frontmatter.id);
        if (
          this.config.queryAwareIndexingEnabled &&
          memory.path &&
          memory.frontmatter?.created
        ) {
          deindexMemory(
            this.config.memoryDir,
            memory.path,
            memory.frontmatter.created,
            memory.frontmatter.tags ?? [],
          );
        }
        archivedCount++;
      }
    }

    // Save hash index if we removed any entries
    if (archivedCount > 0 && this.contentHashIndex) {
      await this.contentHashIndex
        .save()
        .catch((err) =>
          log.warn(`content-hash index save failed during archival: ${err}`),
        );
    }

    return archivedCount;
  }

  /**
   * Run memory summarization if memory count exceeds threshold (Phase 4A).
   */
  private async runSummarization(
    allMemories: import("./types.js").MemoryFile[],
  ): Promise<void> {
    // Only active memories count toward the threshold
    const activeMemories = allMemories.filter(
      (m) => isActiveMemoryStatus(m.frontmatter.status),
    );

    if (activeMemories.length < this.config.summarizationTriggerCount) {
      return;
    }

    log.info(
      `memory count (${activeMemories.length}) exceeds threshold (${this.config.summarizationTriggerCount}) — running summarization`,
    );

    // Sort by creation date, oldest first
    const sorted = activeMemories.sort(
      (a, b) =>
        new Date(a.frontmatter.created).getTime() -
        new Date(b.frontmatter.created).getTime(),
    );

    // Keep recent memories
    const toKeep = sorted.slice(-this.config.summarizationRecentToKeep);
    const toSummarize = sorted.slice(0, -this.config.summarizationRecentToKeep);

    // Filter candidates for summarization
    const candidates = toSummarize.filter((m) => {
      // Skip if protected by entity reference
      if (m.frontmatter.entityRef) return false;

      // Skip if protected by tag
      const protectedTags = this.config.summarizationProtectedTags;
      if (m.frontmatter.tags.some((t) => protectedTags.includes(t)))
        return false;

      // Skip if importance is above threshold
      const importance = m.frontmatter.importance?.score ?? 0.5;
      if (importance >= this.config.summarizationImportanceThreshold)
        return false;

      return true;
    });

    if (candidates.length < 50) {
      log.debug(
        `only ${candidates.length} candidates for summarization — skipping`,
      );
      return;
    }

    // Summarize in batches of 50
    const batchSize = 50;
    for (let i = 0; i < candidates.length; i += batchSize) {
      const batch = candidates.slice(i, i + batchSize);
      const batchData = batch.map((m) => ({
        id: m.frontmatter.id,
        content: m.content,
        category: m.frontmatter.category,
        created: m.frontmatter.created,
      }));

      const result = await this.extraction.summarizeMemories(batchData);
      if (!result) continue;

      // Create summary
      const summary: MemorySummary = {
        id: `summary-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        createdAt: new Date().toISOString(),
        timeRangeStart: batch[0].frontmatter.created,
        timeRangeEnd: batch[batch.length - 1].frontmatter.created,
        summaryText: result.summaryText,
        keyFacts: result.keyFacts,
        keyEntities: result.keyEntities,
        sourceEpisodeIds: batch.map((m) => m.frontmatter.id),
      };

      await this.storage.writeSummary(summary);

      // Archive source memories
      const archived = await this.storage.archiveMemories(
        batch.map((m) => m.frontmatter.id),
        summary.id,
      );

      log.info(
        `created summary ${summary.id} from ${batch.length} memories, archived ${archived}`,
      );
    }
  }

  /**
   * Run topic extraction on all memories (Phase 4B).
   */
  private async runTopicExtraction(
    allMemories: import("./types.js").MemoryFile[],
  ): Promise<void> {
    // Only extract from active memories
    const activeMemories = allMemories.filter(
      (m) => isActiveMemoryStatus(m.frontmatter.status),
    );

    if (activeMemories.length === 0) return;

    const topics = extractTopics(
      activeMemories,
      this.config.topicExtractionTopN,
    );
    await this.storage.saveTopics(topics);

    log.debug(
      `extracted ${topics.length} topics from ${activeMemories.length} memories`,
    );
  }

  /** Threshold (bytes) at which IDENTITY.md reflections get auto-consolidated */
  private static readonly IDENTITY_CONSOLIDATE_THRESHOLD = 8_000;

  private async autoConsolidateIdentity(): Promise<void> {
    const namespaces = this.config.namespacesEnabled
      ? this.configuredNamespaces()
      : [this.config.defaultNamespace];

    for (const namespace of namespaces) {
      const storage = await this.storageRouter.storageFor(namespace);
      const identityNamespace =
        this.config.namespacesEnabled &&
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
      log.info(
        `IDENTITY(${namespace}) consolidated: ${identityContent.length} → ${newContent.length} chars, ${result.learnedPatterns.length} patterns`,
      );
    }
  }

  private formatQmdResults(title: string, results: QmdSearchResult[]): string {
    const lines = results.map((r, i) => {
      const snippet = r.snippet
        ? r.snippet.slice(0, 500).replace(/\n/g, " ")
        : "(no preview)";
      const source = typeof r.line === "number" ? `${r.path}:${r.line}` : r.path;
      return `[${i + 1}] ${source} (score: ${r.score.toFixed(3)})\n${snippet}`;
    });
    return `## ${title}\n\n${lines.join("\n\n")}`;
  }

  private formatObjectiveStateResults(
    results: ObjectiveStateSearchResult[],
  ): string {
    const lines = results.map(({ snapshot }, index) => {
      const parts = [
        snapshot.recordedAt.replace("T", " ").slice(0, 16),
        `${snapshot.kind}/${snapshot.changeKind}`,
      ];
      if (snapshot.outcome) parts.push(snapshot.outcome);
      const header = `[${index + 1}] ${parts.join(" | ")} | ${snapshot.scope}`;
      const detailParts = [snapshot.summary];
      if (snapshot.command) detailParts.push(`command: ${snapshot.command}`);
      else if (snapshot.toolName)
        detailParts.push(`tool: ${snapshot.toolName}`);
      return `${header}\n${detailParts.join(" | ")}`;
    });
    return `## Objective State\n\n${lines.join("\n\n")}`;
  }

  private formatCausalTrajectoryResults(
    results: CausalTrajectorySearchResult[],
  ): string {
    const lines = results.map(({ record, matchedFields }, index) => {
      const header = [
        `[${index + 1}] ${record.recordedAt.replace("T", " ").slice(0, 16)}`,
        record.outcomeKind,
      ].join(" | ");
      const details = [
        `goal: ${record.goal}`,
        `action: ${record.actionSummary}`,
        `observation: ${record.observationSummary}`,
        `outcome: ${record.outcomeSummary}`,
      ];
      if (record.followUpSummary)
        details.push(`follow-up: ${record.followUpSummary}`);
      if (matchedFields.length > 0)
        details.push(`matched: ${matchedFields.join(", ")}`);
      return `${header}\n${details.join("\n")}`;
    });

    return `## Causal Trajectories\n\n${lines.join("\n\n")}`;
  }

  private formatTrustZoneResults(results: TrustZoneSearchResult[]): string {
    const lines = results.map(({ record, matchedFields }, index) => {
      const header = [
        `[${index + 1}] ${record.recordedAt.replace("T", " ").slice(0, 16)}`,
        record.zone,
        record.kind,
      ].join(" | ");
      const details = [
        record.summary,
        `provenance: ${record.provenance.sourceClass}`,
      ];
      if (record.entityRefs && record.entityRefs.length > 0) {
        details.push(`entities: ${record.entityRefs.join(", ")}`);
      }
      if (record.tags && record.tags.length > 0) {
        details.push(`tags: ${record.tags.join(", ")}`);
      }
      if (matchedFields.length > 0) {
        details.push(`matched: ${matchedFields.join(", ")}`);
      }
      return `${header}\n${details.join("\n")}`;
    });

    return `## Trust Zones\n\n${lines.join("\n\n")}`;
  }

  private formatHarmonicRetrievalResults(
    results: HarmonicRetrievalResult[],
  ): string {
    const lines = results.map(
      (
        { node, matchedAnchors, matchedFields, nodeScore, anchorScore },
        index,
      ) => {
        const header = [
          `[${index + 1}] ${node.recordedAt.replace("T", " ").slice(0, 16)}`,
          `${node.kind}/${node.abstractionLevel}`,
          node.sessionKey,
        ].join(" | ");
        const details = [
          node.title,
          node.summary,
          `scores: node=${nodeScore.toFixed(1)} anchor=${anchorScore.toFixed(1)}`,
        ];
        if (matchedAnchors.length > 0) {
          details.push(
            `anchors: ${matchedAnchors.map((anchor) => `${anchor.anchorType}:${anchor.anchorValue}`).join("; ")}`,
          );
        }
        if (matchedFields.length > 0) {
          details.push(`matched: ${matchedFields.join(", ")}`);
        }
        return `${header}\n${details.join("\n")}`;
      },
    );

    return `## Harmonic Retrieval\n\n${lines.join("\n\n")}`;
  }

  private formatWorkProductResults(
    results: WorkProductLedgerSearchResult[],
  ): string {
    const lines = results.map(({ entry, matchedFields }, index) => {
      const header = [
        `[${index + 1}] ${entry.recordedAt.replace("T", " ").slice(0, 16)}`,
        `${entry.kind}/${entry.action}`,
        entry.sessionKey,
      ].join(" | ");
      const details = [entry.summary, `scope: ${entry.scope}`];
      if (entry.artifactPath) details.push(`artifact: ${entry.artifactPath}`);
      if (entry.tags && entry.tags.length > 0)
        details.push(`tags: ${entry.tags.join(", ")}`);
      if (matchedFields.length > 0)
        details.push(`matched: ${matchedFields.join(", ")}`);
      return `${header}\n${details.join("\n")}`;
    });

    return `## Work Products\n\n${lines.join("\n\n")}`;
  }

  private formatVerifiedEpisodeResults(
    results: VerifiedEpisodeResult[],
  ): string {
    const lines = results.map(
      ({ box, verifiedEpisodeCount, matchedFields }, index) => {
        const header = [
          `[${index + 1}] ${box.sealedAt.replace("T", " ").slice(0, 16)}`,
          box.traceId ? `trace:${box.traceId.slice(0, 12)}` : "trace:none",
        ].join(" | ");
        const details = [
          box.goal ?? `topics: ${box.topics.join(", ")}`,
          `verified episodes: ${verifiedEpisodeCount}`,
        ];
        if (box.toolsUsed && box.toolsUsed.length > 0) {
          details.push(`tools: ${box.toolsUsed.join(", ")}`);
        }
        if (matchedFields.length > 0) {
          details.push(`matched: ${matchedFields.join(", ")}`);
        }
        return `${header}\n${details.join("\n")}`;
      },
    );

    return `## Verified Episodes\n\n${lines.join("\n\n")}`;
  }

  private formatVerifiedSemanticRuleResults(
    results: VerifiedSemanticRuleResult[],
  ): string {
    const lines = results.map(
      (
        {
          rule,
          sourceMemoryId,
          verificationStatus,
          effectiveConfidence,
          matchedFields,
        },
        index,
      ) => {
        const header = [
          `[${index + 1}] ${rule.frontmatter.updated.replace("T", " ").slice(0, 16)}`,
          verificationStatus,
          `confidence:${effectiveConfidence.toFixed(2)}`,
        ].join(" | ");
        const details = [rule.content, `source memory: ${sourceMemoryId}`];
        if (matchedFields.length > 0) {
          details.push(`matched: ${matchedFields.join(", ")}`);
        }
        return `${header}\n${details.join("\n")}`;
      },
    );

    return `## Verified Rules\n\n${lines.join("\n\n")}`;
  }

  private summarizeIdentityText(
    raw: string,
    maxLines: number,
    maxChars: number,
  ): string {
    const lines = raw
      .replace(/\r/g, "")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));
    const compact = lines.slice(0, Math.max(1, maxLines)).join(" ");
    if (compact.length <= maxChars) return compact;
    return `${compact.slice(0, Math.max(0, maxChars - 1))}…`;
  }

  private formatOpenIncidentLine(
    incident: ContinuityIncidentRecord,
    includeDetails: boolean,
  ): string {
    const base = `[${incident.id}] ${incident.symptom.trim()}`;
    if (!includeDetails) return `- ${base}`;
    const parts = [base];
    if (incident.suspectedCause)
      parts.push(`cause: ${incident.suspectedCause.trim()}`);
    if (incident.triggerWindow)
      parts.push(`window: ${incident.triggerWindow.trim()}`);
    return `- ${parts.join(" | ")}`;
  }

  private trimIdentitySection(
    content: string,
    maxChars: number,
  ): { text: string; truncated: boolean } {
    if (maxChars <= 0) return { text: "", truncated: false };
    if (content.length <= maxChars) return { text: content, truncated: false };
    const suffix = "\n\n...(identity continuity trimmed)";
    if (maxChars <= suffix.length) {
      return { text: content.slice(0, maxChars), truncated: true };
    }
    const headroom = Math.max(0, maxChars - suffix.length);
    return { text: `${content.slice(0, headroom)}${suffix}`, truncated: true };
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
    if (!this.config.identityContinuityEnabled) return null;
    if (this.config.identityMaxInjectChars <= 0) return null;

    const resolved = resolveEffectiveIdentityInjectionMode({
      configuredMode: this.config.identityInjectionMode,
      recallMode: options.recallMode,
      prompt: options.prompt,
    });
    if (!resolved.shouldInject) return null;

    const [anchorRaw, loopsRaw, incidents] = await Promise.all([
      options.storage.readIdentityAnchor(),
      options.storage.readIdentityImprovementLoops(),
      options.storage.readContinuityIncidents(200),
    ]);
    const openIncidents = incidents.filter(
      (incident) => incident.state === "open",
    );

    const lines: string[] = [];
    if (resolved.mode === "full") {
      lines.push("## Identity Continuity");
      if (anchorRaw && anchorRaw.trim().length > 0) {
        lines.push("", "### Anchor", "", anchorRaw.trim());
      }
      if (loopsRaw && loopsRaw.trim().length > 0) {
        lines.push("", "### Improvement Loops", "", loopsRaw.trim());
      }
      lines.push("", "### Open Incidents", "");
      if (openIncidents.length === 0) {
        lines.push("- none");
      } else {
        lines.push(
          ...openIncidents
            .slice(0, 5)
            .map((incident) => this.formatOpenIncidentLine(incident, true)),
        );
      }
    } else {
      const anchorSummary = anchorRaw
        ? this.summarizeIdentityText(anchorRaw, 3, 320)
        : "";
      const loopsSummary = loopsRaw
        ? this.summarizeIdentityText(loopsRaw, 2, 240)
        : "";
      lines.push("## Identity Continuity Signals", "");
      if (anchorSummary) lines.push(`- anchor: ${anchorSummary}`);
      if (loopsSummary) lines.push(`- loops: ${loopsSummary}`);
      if (openIncidents.length === 0) {
        lines.push("- incidents: 0 open");
      } else {
        lines.push(`- incidents: ${openIncidents.length} open`);
        lines.push(
          ...openIncidents
            .slice(0, 2)
            .map((incident) => this.formatOpenIncidentLine(incident, false)),
        );
      }
    }

    const body = lines.join("\n").trim();
    if (!body) return null;

    const { text, truncated } = this.trimIdentitySection(
      body,
      this.config.identityMaxInjectChars,
    );
    if (!text) return null;

    return {
      section: text,
      mode: resolved.mode,
      injectedChars: text.length,
      truncated,
    };
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
    if (!this.config.evalHarnessEnabled || !this.config.evalShadowModeEnabled)
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
  }): void {
    const sectionId = "memories";
    const memoryIds = this.extractMemoryIdsFromResults(options.results);
    this.trackMemoryAccess(memoryIds);

    this.appendRecallSection(
      options.sectionBuckets,
      sectionId,
      this.formatQmdResults(options.title, options.results),
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
  private async applyMemoryWorthRerank(
    results: QmdSearchResult[],
    namespaces: string[],
  ): Promise<QmdSearchResult[]> {
    // Build the counter lookup. We union frontmatter counters across every
    // namespace the recall spans — the recall path itself already
    // aggregates candidates from multiple namespaces, so we must do the
    // same when looking up counters. Per-namespace results are cached with
    // a short TTL so interactive recall doesn't trigger a full
    // `readAllMemories` scan per query (addresses codex P2 on PR 4).
    const counters = new Map<string, MemoryWorthCounters>();
    const seenNamespaces = new Set<string>();
    const nowMs = Date.now();

    // Evict all expired entries on every call so long-running processes
    // touching a high-cardinality namespace set (coding/project overlays,
    // per-branch) don't grow the cache unboundedly. Without this, an entry
    // for a namespace that's never looked up again would pin its full
    // counter map forever.
    for (const [key, entry] of this.memoryWorthCounterCache) {
      if (nowMs - entry.at >= Orchestrator.MEMORY_WORTH_CACHE_TTL_MS) {
        this.memoryWorthCounterCache.delete(key);
      }
    }

    for (const ns of namespaces) {
      if (seenNamespaces.has(ns)) continue;
      seenNamespaces.add(ns);
      try {
        const cached = this.memoryWorthCounterCache.get(ns);
        let nsMap: ReadonlyMap<string, MemoryWorthCounters> | undefined;
        if (
          cached &&
          nowMs - cached.at < Orchestrator.MEMORY_WORTH_CACHE_TTL_MS
        ) {
          nsMap = cached.counters;
        } else {
          const storage = await this.getStorage(ns);
          const memories = await storage.readAllMemories();
          nsMap = buildMemoryWorthCounterMap(memories);
          this.memoryWorthCounterCache.set(ns, { at: nowMs, counters: nsMap });
        }
        for (const [path, c] of nsMap) counters.set(path, c);
      } catch (err) {
        log.debug("memory-worth: failed to read namespace, skipping", {
          namespace: ns,
          error: (err as Error).message,
        });
      }
    }

    // For candidates whose path didn't show up in any hot-tier namespace
    // scan (typical of cold-tier / archive fallback), try a direct
    // per-path read. Without this, cold-tier candidates always stay at
    // multiplier 1.0 even when they have outcome history. Errors are
    // swallowed so a single unreadable archive entry can't break the
    // whole recall.
    const missing = results.filter((r) => !counters.has(r.path));
    if (missing.length > 0) {
      // Use the first-seen namespace's storage as the reader — all
      // StorageManagers share the same on-disk format, and
      // `readMemoryByPath` takes an absolute path so the baseDir doesn't
      // have to match.
      let reader: StorageManager | null = null;
      for (const ns of namespaces) {
        try {
          reader = await this.getStorage(ns);
          break;
        } catch {
          // try next namespace
        }
      }
      if (reader) {
        for (const r of missing) {
          try {
            const memory = await reader.readMemoryByPath(r.path);
            if (!memory) continue;
            const fm = memory.frontmatter;
            if (fm.mw_success === undefined && fm.mw_fail === undefined) continue;
            counters.set(r.path, {
              mw_success: fm.mw_success,
              mw_fail: fm.mw_fail,
              lastAccessed: fm.lastAccessed,
            });
          } catch (err) {
            log.debug("memory-worth: direct path lookup failed", {
              path: r.path,
              error: (err as Error).message,
            });
          }
        }
      }
    }

    // If no memory in the candidate set has any counter data, the filter
    // would be a no-op — skip the reorder to avoid spurious log spam.
    if (counters.size === 0) return results;

    // Preserve upstream ordering (reranker, specialized tiers, etc.) for
    // neutral candidates. The upstream stages set `memoryResults` in their
    // intended order but often leave `r.score` as the raw QMD score. If we
    // sorted by `r.score * multiplier` directly, neutral candidates
    // (multiplier 1.0) would snap back to raw-QMD order and silently undo
    // the reranker. Feed the filter a synthetic monotone-decreasing rank
    // score so it uses input position as the baseline, then applies the
    // multiplier on top. Ties fall back to the stable secondary key in
    // `applyMemoryWorthFilter`.
    const rankedInputs = results.map((r, i) => ({
      path: r.path,
      // Large positive rank score so multiplier math stays well-scaled and
      // we never hit zero; descending so earlier items rank higher.
      score: results.length - i,
    }));
    const filtered = applyMemoryWorthFilter(rankedInputs, {
      counters,
      now: new Date(),
      halfLifeMs:
        this.config.recallMemoryWorthHalfLifeMs > 0
          ? this.config.recallMemoryWorthHalfLifeMs
          : undefined,
    });

    // Reconstruct the QmdSearchResult list in the new order. `.score` is
    // preserved from the upstream pipeline (rerank, tier scoring, etc.) —
    // we only reorder. Writing the synthetic rank-weighted score back
    // would contaminate downstream logic (telemetry, confidence gates)
    // that expects the original QMD/rerank score semantics.
    const byPath = new Map(results.map((r) => [r.path, r]));
    const reordered: QmdSearchResult[] = [];
    for (const item of filtered) {
      const original = byPath.get(item.path);
      if (original) reordered.push(original);
    }
    return reordered;
  }

  private diversifyAndLimitRecallResults(
    sectionId: string,
    results: QmdSearchResult[],
    limit: number,
    retrievalQuery?: string,
  ): QmdSearchResult[] {
    const safeLimit =
      typeof limit === "number" && Number.isFinite(limit)
        ? Math.max(0, Math.floor(limit))
        : 0;
    if (!Array.isArray(results) || results.length === 0) return [];
    // `recallResultLimit === 0` is a true zero limit (e.g. when
    // `memoriesSectionEnabled` is false) and must return an empty array so
    // the memories section is genuinely skipped. This mirrors the
    // `slice(0, 0)` semantics of every call site this helper replaced.
    if (safeLimit === 0) return [];
    // Issue #564 PR 3: when the feature flag is on, boost reasoning_trace
    // memories for problem-solving asks so they bubble up ahead of ordinary
    // facts/decisions before MMR picks the final section. No-op when the
    // flag is off or the query is not a problem-solving ask.
    const boosted =
      this.config.recallReasoningTraceBoostEnabled && typeof retrievalQuery === "string"
        ? applyReasoningTraceBoost(results, {
            enabled: true,
            query: retrievalQuery,
          })
        : results;
    const diversified = this.applyMmrToQmdResults(sectionId, boosted);
    return diversified.slice(0, safeLimit);
  }

  /**
   * Apply Maximal Marginal Relevance to a section's ordered candidate list.
   *
   * Operates per-section so one redundant cluster cannot dominate a section,
   * and so one section's MMR pass cannot starve other sections. Returns the
   * input unchanged when disabled, when there are fewer than 2 candidates, or
   * when no budget information is available.
   */
  private applyMmrToQmdResults(
    sectionId: string,
    results: QmdSearchResult[],
  ): QmdSearchResult[] {
    if (this.config.recallMmrEnabled === false) return results;
    if (!Array.isArray(results) || results.length < 2) return results;

    // Config is runtime API (see AGENTS.md §4): preserve `0` as a true zero
    // limit rather than coercing it to a non-zero value. A configured topN of
    // 0 means "apply MMR over an empty window" — i.e. skip the reorder and
    // return the upstream candidates unchanged. This keeps read-time
    // behavior symmetric with the write-time semantics parseConfig exposes.
    const configuredTopN = this.config.recallMmrTopN;
    const topN =
      typeof configuredTopN === "number" && Number.isFinite(configuredTopN)
        ? Math.max(0, Math.floor(configuredTopN))
        : 40;
    if (topN === 0) return results;
    const lambda = this.config.recallMmrLambda ?? 0.7;

    // Delegate to the pure helper so candidate keying (path-first, index
    // suffixed for uniqueness) and the head-of-list diversity metric are
    // exercised by the same code path that the unit tests cover.
    const { reordered, diversity } = reorderRecallResultsWithMmr(results, {
      lambda,
      topN,
    });

    try {
      log.info(
        `recall_mmr: section=${sectionId} kept=${diversity.kept}/${diversity.considered} ` +
          `headReorderCount=${diversity.headReorderCount} ` +
          `avgSimBefore=${diversity.avgPairwiseSimBefore.toFixed(3)} ` +
          `avgSimAfter=${diversity.avgPairwiseSimAfter.toFixed(3)} ` +
          `lambda=${lambda.toFixed(2)}`,
      );
    } catch {
      // Metrics must never break recall.
    }

    return reordered;
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
    return {
      requestedTopK: options.requestedTopK,
      appliedTopK: options.recallResultLimit,
      recallBudgetChars: this.getRecallBudgetChars(),
      maxMemoryTokens: this.config.maxMemoryTokens,
      qmdFetchLimit: options.qmdFetchLimit,
      qmdHybridFetchLimit: options.qmdHybridFetchLimit,
      finalContextChars: options.finalContextChars,
      truncated: options.truncated,
      includedSections: [...(options.includedSections ?? [])],
      omittedSections: [...(options.omittedSections ?? [])],
    };
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
    const used = new Set<string>();
    if (recallSource !== "none") {
      used.add(recallSource);
    }
    for (const [sectionId, chunks] of sectionBuckets.entries()) {
      if (chunks.length > 0) {
        used.add(sectionId);
      }
    }
    return [...used];
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
    if (!this.config.embeddingFallbackEnabled) {
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
    if (!this.config.namespacesEnabled) return {};
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
    if (!this.config.embeddingFallbackEnabled) return [];
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

    const scored: QmdSearchResult[] = [];
    for (const memory of archivedMemories) {
      throwIfRecallAborted(abortSignal);
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
      if (hits === 0) continue;
      const normalized = hits / tokens.length;
      scored.push({
        docid: memory.frontmatter.id,
        path: memory.path,
        score: normalized,
        snippet: memory.content.slice(0, 400).replace(/\n/g, " "),
      });
    }

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
    queryAwarePrefilter?: QueryAwarePrefilter;
    abortSignal?: AbortSignal;
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
    /** Issue #681 — when true, bypass graphTraversalConfidenceFloor. */
    includeLowConfidence?: boolean;
  }): Promise<QmdSearchResult[]> {
    const coldQmdEnabled = this.config.qmdColdTierEnabled === true;
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
        longTerm = await this.fetchQmdMemoryResultsWithArtifactTopUp(
          options.prompt,
          coldFetchLimit,
          coldHybridLimit,
          {
            namespacesEnabled: this.config.namespacesEnabled,
            recallNamespaces: options.recallNamespaces,
            resolveNamespace: (p) => this.namespaceFromPath(p),
            collection: coldCollection,
            queryAwarePrefilter: options.queryAwarePrefilter,
            searchOptions: this.buildConfiguredQmdSearchOptions(options.prompt),
            abortSignal: options.abortSignal,
          },
        );
        if (longTerm.length > 0) {
          log.debug(
            `cold-tier recall source=cold-qmd collection=${coldCollection} hits=${longTerm.length}`,
          );
        }
      }
    }
    if (longTerm.length === 0) {
      longTerm = await this.searchLongTermArchiveFallback(
        options.prompt,
        options.recallNamespaces,
        options.recallResultLimit,
        options.queryAwarePrefilter,
        options.abortSignal,
      );
      if (longTerm.length > 0) {
        log.debug("cold-tier recall source=archive-scan");
      }
    }
    if (longTerm.length === 0) return [];

    let results = longTerm;
    if (this.config.namespacesEnabled) {
      results = results.filter((r) =>
        options.recallNamespaces.includes(this.namespaceFromPath(r.path)),
      );
    }
    // Artifact isolation contract: generic recall paths must exclude artifacts.
    results = results.filter((r) => !isArtifactMemoryPath(r.path));
    if (results.length === 0) return [];

    const isFullModeGraphAssist =
      this.config.qmdTierParityGraphEnabled &&
      this.config.multiGraphMemoryEnabled &&
      this.config.graphAssistInFullModeEnabled !== false &&
      options.recallMode === "full" &&
      results.length >= Math.max(1, this.config.graphAssistMinSeedResults ?? 3);
    const shouldRunGraphExpansion =
      this.config.qmdTierParityGraphEnabled &&
      (options.recallMode === "graph_mode" || isFullModeGraphAssist);

    if (shouldRunGraphExpansion) {
      const { merged } = await this.expandResultsViaGraph({
        memoryResults: results,
        recallNamespaces: options.recallNamespaces,
        recallResultLimit: options.recallResultLimit,
        ...(options.includeLowConfidence === true ? { includeLowConfidence: true } : {}),
      });
      results = merged;
    }

    results = await this.boostSearchResults(
      results,
      options.recallNamespaces,
      options.prompt,
      undefined,
      { allowLifecycleFiltered: true, asOfMs: options.asOfMs },
    );

    if (this.config.rerankEnabled && this.config.rerankProvider === "local") {
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
        cacheEnabled: this.config.rerankCacheEnabled,
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
    if (this.config.rerankEnabled && this.config.rerankProvider === "cloud") {
      log.debug(
        "rerankProvider=cloud is reserved/experimental in v2.2.0; skipping rerank",
      );
    }

    // Memory Worth filter — must fire on the cold fallback path too, or the
    // feature flag produces divergent behavior by retrieval path (CLAUDE.md
    // rule 39). Fail-open on lookup errors.
    if (this.config.recallMemoryWorthFilterEnabled && results.length > 0) {
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
    if (!this.config.accessTrackingEnabled) return;

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
    const namespaces = this.config.namespacesEnabled
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
    if (results.length === 0) return results;

    const now = Date.now();
    // Seed with any pre-loaded memories (e.g. from the recency fallback path)
    // to avoid redundant disk reads for files already in memory.
    const memoryByPath: Map<string, MemoryFile> = preloadedMemoryMap
      ? new Map(preloadedMemoryMap)
      : new Map();

    // Determine temporal/tag query params before I/O (pure computation).
    const resultPaths = new Set(
      results.map((r) => r.path).filter(Boolean) as string[],
    );
    let temporalFromDate: string | null = null;
    let promptTags: string[] = [];
    if (this.config.queryAwareIndexingEnabled && prompt) {
      if (isTemporalQuery(prompt)) {
        temporalFromDate = recencyWindowFromPrompt(prompt, now);
      }
      promptTags = extractTagsFromPrompt(prompt);
    }

    // Run all file I/O in parallel: memory files not yet preloaded + index files.
    const [, rawTemporal, rawTags] = await Promise.all([
      Promise.all(
        results.map(async (r) => {
          if (!r.path || memoryByPath.has(r.path)) return;
          const mem = await this.storage.readMemoryByPath(r.path);
          if (mem) memoryByPath.set(r.path, mem);
        }),
      ),
      temporalFromDate !== null
        ? queryByDateRangeAsync(this.config.memoryDir, temporalFromDate)
        : Promise.resolve<Set<string> | null>(null),
      promptTags.length > 0
        ? queryByTagsAsync(this.config.memoryDir, promptTags)
        : Promise.resolve<Set<string> | null>(null),
    ]);

    const queryIntent =
      this.config.intentRoutingEnabled && prompt
        ? inferIntentFromText(prompt)
        : null;

    // v8.1: Temporal + Tag prefilter candidate set
    // Scope to result paths first so cross-namespace paths don't consume the cap.
    let temporalCandidates: Set<string> | null = null;
    let tagCandidates: Set<string> | null = null;
    if (this.config.queryAwareIndexingEnabled && prompt) {
      const maxCandidates = this.config.queryAwareIndexingMaxCandidates;
      const capSet = (s: Set<string> | null): Set<string> | null => {
        if (!s) return null;
        // Intersect with result paths first so out-of-scope paths don't exhaust the budget
        const scoped = new Set(Array.from(s).filter((p) => resultPaths.has(p)));
        if (maxCandidates === 0 || scoped.size <= maxCandidates)
          return scoped.size > 0 ? scoped : null;
        return new Set(Array.from(scoped).slice(0, maxCandidates));
      };
      if (temporalFromDate !== null) {
        temporalCandidates = capSet(rawTemporal);
      }
      if (promptTags.length > 0) {
        tagCandidates = capSet(rawTags);
      }
    }

    let lifecycleFilteredCount = 0;
    let temporalSupersededFilteredCount = 0;
    let dedicatedSurfaceFilteredCount = 0;
    let forgottenFilteredCount = 0;
    const boosted: QmdSearchResult[] = [];
    const recencyWeight = this.effectiveRecencyWeight();
    for (const r of results) {
      const memory = memoryByPath.get(r.path);
      let score = r.score;

      if (memory) {
        if (memory.frontmatter.status === "forgotten") {
          forgottenFilteredCount += 1;
          continue;
        }

        if (
          options?.allowLifecycleFiltered !== true &&
          shouldFilterLifecycleRecallCandidate(memory.frontmatter, {
            lifecyclePolicyEnabled: this.config.lifecyclePolicyEnabled,
            lifecycleFilterStaleEnabled:
              this.config.lifecycleFilterStaleEnabled,
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
            enabled: this.config.temporalSupersessionEnabled,
            includeInRecall: this.config.temporalSupersessionIncludeInRecall,
          })
        ) {
          temporalSupersededFilteredCount += 1;
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
        if (this.config.feedbackEnabled) {
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
        if (this.config.negativeExamplesEnabled) {
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
        if (this.config.queryAwareIndexingEnabled && r.path) {
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
            lifecyclePolicyEnabled: this.config.lifecyclePolicyEnabled,
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
          this.config.reinforcementRecallBoostEnabled &&
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
    if (!this.isSearchAvailableForNamespaceRouting()) return null;

    // Search for similar memories
    const results = await this.searchAcrossNamespaces({
      query: content,
      namespaces: [namespaceScope],
      maxResults: 5,
      mode: "search",
    });

    for (const result of results) {
      // Check similarity threshold
      if (result.score < this.config.contradictionSimilarityThreshold) {
        continue;
      }

      // Get the existing memory
      const memoryId = this.extractMemoryIdsFromResults([result])[0];
      if (!memoryId) continue;

      const resultNamespace = this.namespaceFromPath(result.path);
      if (resultNamespace !== namespaceScope) continue;
      const resultStorage =
        await this.storageRouter.storageFor(resultNamespace);
      const existingMemory = await resultStorage.getMemoryById(memoryId);
      if (!existingMemory) continue;

      // Skip memories already resolved or explicitly forgotten. Other
      // non-active statuses remain valid contradiction candidates.
      if (
        existingMemory.frontmatter.status === "superseded" ||
        existingMemory.frontmatter.status === "forgotten"
      ) {
        continue;
      }

      // Verify contradiction with LLM
      const verification = await this.extraction.verifyContradiction(
        { content, category },
        {
          id: existingMemory.frontmatter.id,
          content: existingMemory.content,
          category: existingMemory.frontmatter.category,
          created: existingMemory.frontmatter.created,
        },
      );

      if (!verification) continue;

      // Check if it's a real contradiction with high confidence
      if (
        verification.isContradiction &&
        verification.confidence >= this.config.contradictionMinConfidence
      ) {
        // When the LLM says the existing memory is newer (whichIsNewer ===
        // "first") the incoming fact is the stale one in both resolve modes —
        // log and continue so the caller never marks contradictionDetected and
        // the semantic-skip gate can discard the outdated write normally.
        if (verification.whichIsNewer === "first") {
          log.info(
            `detected contradiction (confidence: ${verification.confidence}): ${existingMemory.frontmatter.id} vs new memory — existing is newer, incoming fact is stale`,
          );
          continue;
        }

        // The new fact is newer than the existing one. When auto-resolve is
        // enabled, immediately retire the old memory. When disabled, leave the
        // old memory active for manual review.
        if (this.config.contradictionAutoResolve) {
          await resultStorage.supersedeMemory(
            existingMemory.frontmatter.id,
            "pending-new", // Will be updated after the new memory is written
            verification.reasoning,
          );
        }

        // Return the contradiction info regardless of auto-resolve setting.
        // The caller uses this to set `contradictionDetected=true` which
        // prevents the semantic-skip guard from silently dropping a
        // legitimately contradictory update (the regression this fixes).
        log.info(
          `detected contradiction (confidence: ${verification.confidence}): ${existingMemory.frontmatter.id} vs new memory${this.config.contradictionAutoResolve ? " (auto-resolved)" : " (queued for manual review)"}`,
        );
        return {
          supersededId: existingMemory.frontmatter.id,
          confidence: verification.confidence,
          reason: verification.reasoning,
          supersededPath: existingMemory.path,
          supersededCreated: existingMemory.frontmatter.created,
          supersededTags: existingMemory.frontmatter.tags ?? [],
        };
      }
    }

    return null;
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
    if (!this.isSearchAvailableForNamespaceRouting()) return [];

    // Search for related memories
    const results = await this.searchAcrossNamespaces({
      query: content,
      namespaces: [namespaceScope],
      maxResults: 5,
      mode: "search",
    });
    if (results.length === 0) return [];

    // Get full memory details for candidates
    const candidates: Array<{ id: string; content: string; category: string }> =
      [];
    for (const result of results) {
      const memoryId = this.extractMemoryIdsFromResults([result])[0];
      if (!memoryId) continue;

      const resultNamespace = this.namespaceFromPath(result.path);
      if (resultNamespace !== namespaceScope) continue;
      const resultStorage =
        await this.storageRouter.storageFor(resultNamespace);
      const memory = await resultStorage.getMemoryById(memoryId);
      if (
        memory &&
        memory.frontmatter.status !== "superseded" &&
        memory.frontmatter.status !== "forgotten"
      ) {
        candidates.push({
          id: memory.frontmatter.id,
          content: memory.content,
          category: memory.frontmatter.category,
        });
      }
    }

    if (candidates.length === 0) return [];

    // Ask LLM for link suggestions
    const suggestions = await this.extraction.suggestLinks(
      { content, category },
      candidates,
    );

    if (!suggestions || suggestions.links.length === 0) return [];

    // Convert to MemoryLink format
    return suggestions.links.map((link) => ({
      targetId: link.targetId,
      linkType: link.linkType,
      strength: link.strength,
      reason: link.reason || undefined,
    }));
  }

  private namespaceFromPath(p: string): string {
    if (!this.config.namespacesEnabled) return this.config.defaultNamespace;
    const m = p.match(/[\\/]+namespaces[\\/]+([^\\/]+)(?:[\\/]|$)/);
    return m && m[1] ? m[1] : this.config.defaultNamespace;
  }

  private namespaceFromStorageDir(storageDir: string): string {
    if (!this.config.namespacesEnabled) return this.config.defaultNamespace;
    const resolvedStorageDir = path.resolve(storageDir);
    const resolvedMemoryDir = path.resolve(this.config.memoryDir);
    if (resolvedStorageDir === resolvedMemoryDir)
      return this.config.defaultNamespace;
    const m = resolvedStorageDir.match(/[\\/]namespaces[\\/]([^\\/]+)$/);
    return m && m[1] ? m[1] : this.config.defaultNamespace;
  }

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
