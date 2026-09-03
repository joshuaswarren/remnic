/**
 * CapabilitySet — recall-operation feature gates resolved once, then threaded.
 *
 * Issue #1523 (Phase 1 of epic #1520). Root cause this addresses: 161+
 * scattered `config.<flag>Enabled` reads mean each gate is re-derived at every
 * call site, and reviews keep finding parallel code paths where one branch
 * checks a gate the other forgot (CLAUDE.md rule 39 — the "gate divergence"
 * defect class). The fix is to resolve a frozen capability projection ONCE at
 * the top of the recall operation and pass it down explicitly.
 *
 * Scope of THIS module (first migration PR): only the recall-operation-scoped
 * flags below. Flags that are also read in graph construction, writes, CLI, or
 * the summarizer are deliberately deferred to a follow-up so we never leave a
 * single flag half-migrated (some sites on `caps.`, some on `config.`).
 *
 * Field naming: each field is the config flag name with the trailing `Enabled`
 * removed (`recallMmrEnabled` → `recallMmr`).
 *
 * This is plumbing, not a feature — there is deliberately NO `enabled` gate for
 * the CapabilitySet itself (rule 30 governs behavior changes; resolving and
 * threading a capability projection must stay behavior-preserving).
 *
 * Flag-retirement audit (#1780, 2026-07-08): all projected fields verified for
 * live consumers; dead projections removed.
 */

import type { PluginConfig } from "./types.js";
import type { InjectionScreenProfile } from "./security/injection-screen.js";

/**
 * Frozen projection of recall-operation feature gates.
 *
 * Every field is `readonly boolean`. The composition that maps a config flag to
 * a capability (including default-when-undefined semantics for optional flags)
 * lives ONLY in {@link resolveCapabilities} — call sites must read the
 * capability, never re-derive it from raw config.
 */
export interface CapabilitySet {
  /** `rerankCacheEnabled` — cache reranker scores across recall passes. */
  readonly rerankCache: boolean;
  /** `recallDirectAnswerEnabled` — observation-mode direct-answer tier. */
  readonly recallDirectAnswer: boolean;
  /** `recallMemoryWorthFilterEnabled` — Memory-Worth score reweighting. */
  readonly recallMemoryWorthFilter: boolean;
  /** `trustScoreEnabled` — unified TrustScore recall stage (issue #1577). */
  readonly recallTrustScore: boolean;
  /** `recallMmrEnabled` — maximal-marginal-relevance diversification. */
  readonly recallMmr: boolean;
  /** `recallReasoningTraceBoostEnabled` — boost reasoning-trace memories. */
  readonly recallReasoningTraceBoost: boolean;
  /** `recallPlannerLlmEnabled` — LLM-backed recall-mode planner. */
  readonly recallPlannerLlm: boolean;
  /** `recallPlannerEnabled` — recall-mode planner (heuristic + optional LLM). */
  readonly recallPlanner: boolean;
  /** `recallConfidenceGateEnabled` — Synapse-style confidence gate. */
  readonly recallConfidenceGate: boolean;
  /** `graphRecallEnabled` — graph-mode recall tier (gates planner graph mode). */
  readonly graphRecall: boolean;
  /** `graphAssistInFullModeEnabled` — graph-assist overlay in full mode. */
  readonly graphAssistInFullMode: boolean;
  /** `graphExpandedIntentEnabled` — promote broad-intent asks to graph mode. */
  readonly graphExpandedIntent: boolean;
  // --- Issue #1566 Cluster C: mixed-operation flags (recall + summarizer/CLI/writes) ---
  /** `rerankEnabled` — optional LLM reranking of recall candidates. */
  readonly rerank: boolean;
  /** `harmonicRetrievalEnabled` — abstraction-node harmonic retrieval tier. */
  readonly harmonicRetrieval: boolean;
  /** `parallelRetrievalEnabled` — three-agent parallel retrieval (DirectFact + Contextual + Temporal). */
  readonly parallelRetrieval: boolean;
}

/**
 * Resolve the recall-operation {@link CapabilitySet} from parsed config.
 *
 * Call this ONCE per recall operation (at the `recall()` / `recallInternal`
 * entry) and thread the result down. Composition lives here and only here.
 *
 * Session toggles are intentionally not a parameter yet: `session-toggles.ts`
 * is agent-scoped (per session/agent enable-disable of the whole plugin), not
 * flag-scoped — none of the flags projected here have a per-session override,
 * so there is nothing for a toggle argument to compose at this layer.
 */
export function resolveCapabilities(config: PluginConfig): CapabilitySet {
  return Object.freeze({
    rerankCache: config.rerankCacheEnabled,
    recallDirectAnswer: config.recallDirectAnswerEnabled,
    recallMemoryWorthFilter: config.recallMemoryWorthFilterEnabled,
    // Issue #1577: TrustScore subsumes the Memory Worth multiplier when on;
    // the orchestrator runs exactly one of the two (mutual exclusion, rule 39).
    recallTrustScore: config.trustScoreEnabled === true,
    recallMmr: config.recallMmrEnabled,
    recallReasoningTraceBoost: config.recallReasoningTraceBoostEnabled,
    recallPlannerLlm: config.recallPlannerLlmEnabled,
    recallPlanner: config.recallPlannerEnabled,
    recallConfidenceGate: config.recallConfidenceGateEnabled,
    graphRecall: config.graphRecallEnabled,
    // Optional flags: preserve the exact default-when-undefined semantics the
    // migrated call sites used (`!== false` = default-on, `=== true` = default-off).
    graphAssistInFullMode: config.graphAssistInFullModeEnabled !== false,
    graphExpandedIntent: config.graphExpandedIntentEnabled === true,
    // Issue #1566 Cluster C: mixed-operation flags resolved once per recall op.
    rerank: config.rerankEnabled,
    harmonicRetrieval: config.harmonicRetrievalEnabled,
    parallelRetrieval: config.parallelRetrievalEnabled,
  });
}

// ---------------------------------------------------------------------------
// Graph-construction capability set (issue #1566 Cluster A).
//
// The recall CapabilitySet above covers flags whose EVERY read site lives on
// the recall call chain. The five flags below are read on graph-construction,
// write/extraction, AND recall paths — so they cannot join the recall set
// without leaving some sites on `caps.` and others on `config.` (the exact
// divergence #1523 forbade). They get their own projection, resolved at graph
// build/write entry (and alongside `caps` when recall reads them).
// ---------------------------------------------------------------------------

/**
 * Frozen projection of graph-construction feature gates.
 *
 * Every field is `readonly boolean`. Composition (including default-when-
 * undefined semantics for the optional `graphWriteSessionAdjacencyEnabled`)
 * lives ONLY in {@link resolveGraphConstructionCapabilities}.
 */
export interface GraphConstructionCapabilitySet {
  /** `entityGraphEnabled` — maintain entity co-reference graph edges. */
  readonly entityGraph: boolean;
  /** `timeGraphEnabled` — maintain thread-adjacency graph edges. */
  readonly timeGraph: boolean;
  /** `causalGraphEnabled` — maintain causal-language graph edges. */
  readonly causalGraph: boolean;
  /** `multiGraphMemoryEnabled` — master switch for multi-graph writes/traversal. */
  readonly multiGraphMemory: boolean;
  /** `graphWriteSessionAdjacencyEnabled` — session-adjacency fallback for time edges (default-on). */
  readonly graphWriteSessionAdjacency: boolean;
}

/**
 * Resolve the {@link GraphConstructionCapabilitySet} from parsed config.
 *
 * Call this ONCE at graph build/write entry (extraction, recall graph
 * expansion, graph-health/repair) and thread the result down — exactly the
 * pattern {@link resolveCapabilities} established for recall.
 */
export type GraphConstructionConfigProjection = Pick<
  PluginConfig,
  | "entityGraphEnabled"
  | "timeGraphEnabled"
  | "causalGraphEnabled"
  | "multiGraphMemoryEnabled"
  | "graphWriteSessionAdjacencyEnabled"
>;

export function resolveGraphConstructionCapabilities(
  config: GraphConstructionConfigProjection,
): GraphConstructionCapabilitySet {
  return Object.freeze({
    entityGraph: config.entityGraphEnabled,
    timeGraph: config.timeGraphEnabled,
    causalGraph: config.causalGraphEnabled,
    multiGraphMemory: config.multiGraphMemoryEnabled,
    // Optional flag: preserve the exact default-when-undefined semantics the
    // migrated call site used (`!== false` = default-on).
    graphWriteSessionAdjacency: config.graphWriteSessionAdjacencyEnabled !== false,
  });
}

// ---------------------------------------------------------------------------
// Access-setup capability set (issue #1566 Cluster B).
//
// These two flags gate cross-namespace recall budgeting and anomaly-detection
// auditing. Resolved once at access-service handler entry (and the operator
// doctor check) rather than re-derived from raw config at each site.
// ---------------------------------------------------------------------------

/**
 * Frozen projection of access-setup feature gates (issue #1566 Cluster B).
 *
 * Every field is `readonly boolean`. Composition (including the default-off
 * semantics for the optional `recallAuditAnomalyDetectionEnabled`) lives ONLY
 * in {@link resolveAccessSetupCapabilities}.
 */
export interface AccessSetupCapabilitySet {
  /** `recallCrossNamespaceBudgetEnabled` — rolling cross-namespace recall budget. */
  readonly recallCrossNamespaceBudget: boolean;
  /** `recallAuditAnomalyDetectionEnabled` — access-audit anomaly detection (default-off). */
  readonly recallAuditAnomalyDetection: boolean;
  readonly recallSingleFlight: boolean;
}

/** Resolve the {@link AccessSetupCapabilitySet} from parsed config. Call ONCE at
 *  access-service handler entry and thread the result down. */
export type AccessSetupConfigProjection = Pick<
  PluginConfig,
  "recallCrossNamespaceBudgetEnabled" | "recallAuditAnomalyDetectionEnabled" | "recallSingleFlightEnabled"
>;

export function resolveAccessSetupCapabilities(
  config: AccessSetupConfigProjection,
): AccessSetupCapabilitySet {
  return Object.freeze({
    recallCrossNamespaceBudget: config.recallCrossNamespaceBudgetEnabled,
    // Optional/default-off flag: preserve `=== true` semantics.
    recallAuditAnomalyDetection: config.recallAuditAnomalyDetectionEnabled === true,
    recallSingleFlight: config.recallSingleFlightEnabled === true,
  });
}

// ---------------------------------------------------------------------------
// Memory-lifecycle capability set (issue #1523 batch 3).
//
// The flags below gate memory WRITE/EXTRACTION (extraction judge, scope
// classification, dedupe, telemetry prefilter), temporal supersession of
// stored facts, and the lifecycle policy pass (promotion / decay / stale
// filtering). They are read on the persistExtraction write path, the recall
// candidate-filter path, and the maintenance / lifecycle-pass path — so, like
// the graph-construction set above, they get their own projection resolved
// ONCE at each operation entry that reads them (never re-derived from raw
// config mid-operation — the gate-divergence defect class #1523 targets).
//
// Every field projects from an already-resolved PluginConfig boolean (defaults
// are applied at the config-parse boundary, rule 36), so the resolver is a
// pure projection — no `!== false` / `=== true` re-coercion here.
// ---------------------------------------------------------------------------

/**
 * Frozen projection of memory-lifecycle feature gates (issue #1523 batch 3).
 *
 * Resolved once per write / recall-filter / maintenance operation and threaded
 * down. Composition lives ONLY in {@link resolveMemoryLifecycleCapabilities}.
 */
export interface MemoryLifecycleCapabilitySet {
  /** `temporalSupersessionEnabled` — supersede stale structured facts on write, filter on recall. */
  readonly temporalSupersession: boolean;
  /** `temporalMemoryTreeEnabled` — temporal-memory-tree build + recall tier. */
  readonly temporalMemoryTree: boolean;
  /** `lifecyclePolicyEnabled` — lifecycle promotion / decay metadata pass. */
  readonly lifecyclePolicy: boolean;
  /** `lifecycleFilterStaleEnabled` — filter stale-lifecycle memories from recall. */
  readonly lifecycleFilterStale: boolean;
  /** `lifecycleMetricsEnabled` — emit lifecycle-pass metrics. */
  readonly lifecycleMetrics: boolean;
  /** `extractionScopeClassificationEnabled` — LLM classifies each fact's scope. */
  readonly extractionScopeClassification: boolean;
  /** `extractionJudgeEnabled` — LLM-as-judge fact-worthiness gate. */
  readonly extractionJudge: boolean;
  /** `extractionDedupeEnabled` — dedupe against recent extractions. */
  readonly extractionDedupe: boolean;
  /** `extractionTelemetryPrefilterEnabled` — skip mechanical-telemetry transcripts. */
  readonly extractionTelemetryPrefilter: boolean;
  /** `extractionJudgeTelemetryEnabled` — collect judge verdict telemetry. */
  readonly extractionJudgeTelemetry: boolean;
  /** `embeddingFallbackEnabled` — semantic-dedup / archive-search embedding fallback. */
  readonly embeddingFallback: boolean;
  /** `extractionRetryEnabled` — per-fingerprint backoff + provider circuit breaker on the extraction retry path. */
  readonly extractionRetry: boolean;  /** `projectionRebuildEnabled` — scheduled memory-projection rebuild (#2119). */
  readonly projectionRebuild: boolean;
}

/**
 * Config projection consumed by {@link resolveMemoryLifecycleCapabilities}.
 */
export type MemoryLifecycleConfigProjection = Pick<
  PluginConfig,
  | "temporalSupersessionEnabled"
  | "temporalMemoryTreeEnabled"
  | "lifecyclePolicyEnabled"
  | "lifecycleFilterStaleEnabled"
  | "lifecycleMetricsEnabled"
  | "extractionScopeClassificationEnabled"
  | "extractionJudgeEnabled"
  | "extractionDedupeEnabled"
  | "extractionTelemetryPrefilterEnabled"
  | "extractionJudgeTelemetryEnabled"
  | "embeddingFallbackEnabled"
  | "extractionRetryEnabled"
  | "projectionRebuildEnabled"
>;

/**
 * Resolve the {@link MemoryLifecycleCapabilitySet} from parsed config.
 *
 * Call this ONCE per write / recall-filter / maintenance operation entry and
 * thread the result down — exactly the pattern {@link resolveCapabilities}
 * established for recall.
 */
export function resolveMemoryLifecycleCapabilities(
  config: MemoryLifecycleConfigProjection,
): MemoryLifecycleCapabilitySet {
  return Object.freeze({
    temporalSupersession: config.temporalSupersessionEnabled,
    temporalMemoryTree: config.temporalMemoryTreeEnabled,
    lifecyclePolicy: config.lifecyclePolicyEnabled,
    lifecycleFilterStale: config.lifecycleFilterStaleEnabled,
    lifecycleMetrics: config.lifecycleMetricsEnabled,
    extractionScopeClassification: config.extractionScopeClassificationEnabled,
    extractionJudge: config.extractionJudgeEnabled,
    extractionDedupe: config.extractionDedupeEnabled,
    extractionTelemetryPrefilter: config.extractionTelemetryPrefilterEnabled,
    extractionJudgeTelemetry: config.extractionJudgeTelemetryEnabled,
    embeddingFallback: config.embeddingFallbackEnabled,
    extractionRetry: config.extractionRetryEnabled,
    projectionRebuild: config.projectionRebuildEnabled,
  });
}

// ---------------------------------------------------------------------------
// Indexing capability set (issue #1523 batch 4).
//
// The flags below gate query-aware indexing (temporal/tag index build +
// prefilter) and the conversation index (QMD/FAISS backend selection). They
// are read on the recall path, the extraction/persist path, and the
// maintenance/invalidation path — so they get their own projection resolved
// ONCE at each operation entry that reads them.
//
// Every field projects from an already-resolved PluginConfig boolean (defaults
// applied at the parse boundary), so the resolver is a pure projection.
// ---------------------------------------------------------------------------

/**
 * Frozen projection of indexing feature gates (issue #1523 batch 4).
 *
 * Resolved once per recall / extraction / maintenance operation and threaded
 * down. Composition lives ONLY in {@link resolveIndexingCapabilities}.
 */
export interface IndexingCapabilitySet {
  /** `queryAwareIndexingEnabled` — build + use temporal/tag index for recall prefilter. */
  readonly queryAwareIndexing: boolean;
  /** `conversationIndexEnabled` — conversation-index backend (QMD / FAISS). */
  readonly conversationIndex: boolean;
}

/**
 * Config projection consumed by {@link resolveIndexingCapabilities}.
 */
export type IndexingConfigProjection = Pick<
  PluginConfig,
  "queryAwareIndexingEnabled" | "conversationIndexEnabled"
>;

/**
 * Resolve the {@link IndexingCapabilitySet} from parsed config.
 *
 * Call this ONCE per recall / extraction / maintenance operation entry and
 * thread the result down — exactly the pattern {@link resolveCapabilities}
 * established for recall.
 */
export function resolveIndexingCapabilities(
  config: IndexingConfigProjection,
): IndexingCapabilitySet {
  return Object.freeze({
    queryAwareIndexing: config.queryAwareIndexingEnabled,
    conversationIndex: config.conversationIndexEnabled,
  });
}

// ---------------------------------------------------------------------------
// Creation-memory capability set (issue #1523 batch 4).
//
// The flags below gate the creation-memory subsystem: resume-bundle handoff,
// commitment ledger, commitment lifecycle, and the master creation-memory
// switch. They are read on the extraction/persist path, the recall
// enrichment path, and the CLI command surface — so they get their own
// projection resolved ONCE at each operation entry that reads them.
//
// Every field projects from an already-resolved PluginConfig boolean (defaults
// applied at the parse boundary), so the resolver is a pure projection.
// ---------------------------------------------------------------------------

/**
 * Frozen projection of creation-memory feature gates (issue #1523 batch 4).
 *
 * Resolved once per creation-memory operation (CLI command, extraction,
 * recall enrichment) and threaded down. Composition lives ONLY in
 * {@link resolveCreationMemoryCapabilities}.
 */
export interface CreationMemoryCapabilitySet {
  /** `creationMemoryEnabled` — master switch for creation-memory subsystem. */
  readonly creationMemory: boolean;
  /** `commitmentLedgerEnabled` — commitment-ledger read/write. */
  readonly commitmentLedger: boolean;
  /** `resumeBundlesEnabled` — resume-bundle handoff bundles. */
  readonly resumeBundles: boolean;
  /** `commitmentLifecycleEnabled` — commitment lifecycle (promotion / decay). */
  readonly commitmentLifecycle: boolean;
}

/**
 * Config projection consumed by {@link resolveCreationMemoryCapabilities}.
 */
export type CreationMemoryConfigProjection = Pick<
  PluginConfig,
  | "creationMemoryEnabled"
  | "commitmentLedgerEnabled"
  | "resumeBundlesEnabled"
  | "commitmentLifecycleEnabled"
>;

/**
 * Resolve the {@link CreationMemoryCapabilitySet} from parsed config.
 *
 * Call this ONCE per creation-memory operation entry and thread the result
 * down — exactly the pattern {@link resolveCapabilities} established for
 * recall.
 */
export function resolveCreationMemoryCapabilities(
  config: CreationMemoryConfigProjection,
): CreationMemoryCapabilitySet {
  return Object.freeze({
    creationMemory: config.creationMemoryEnabled,
    commitmentLedger: config.commitmentLedgerEnabled,
    resumeBundles: config.resumeBundlesEnabled,
    commitmentLifecycle: config.commitmentLifecycleEnabled,
  });
}

// ---------------------------------------------------------------------------
// Namespace capability set (issue #1523 batch 5).
//
// `namespacesEnabled` is the single most-scattered config flag in the codebase
// (101 read sites outside config.ts across 18 files — orchestrator, access-service,
// namespace modules, maintenance, CLI, admin). It gates whether the multi-namespace
// system is active at all: every namespace resolution, storage path, recall budget,
// and maintenance fanout checks it. Like the other projections above it gets its own
// resolver invoked ONCE per operation entry rather than re-derived at each site.
//
// The field is a non-optional boolean in PluginConfig, so no coercion is needed.
// ---------------------------------------------------------------------------

/**
 * Frozen projection of namespace feature gates (issue #1523 batch 5).
 *
 * Every field is `readonly boolean`. Composition lives ONLY in
 * {@link resolveNamespaceCapabilities}.
 */
export interface NamespaceCapabilitySet {
  /** `namespacesEnabled` — multi-namespace system master switch. */
  readonly namespaces: boolean;
}

/**
 * Config projection consumed by {@link resolveNamespaceCapabilities}.
 */
export type NamespaceConfigProjection = Pick<PluginConfig, "namespacesEnabled">;

/**
 * Resolve the {@link NamespaceCapabilitySet} from parsed config.
 *
 * Call this ONCE at operation entry and thread the result down. The flag is a
 * non-optional boolean so the projection is a pure pass-through.
 */
export function resolveNamespaceCapabilities(
  config: NamespaceConfigProjection,
): NamespaceCapabilitySet {
  return Object.freeze({
    namespaces: config.namespacesEnabled,
  });
}

// ---------------------------------------------------------------------------
// QMD capability set (issue #1523 batch 6).
//
// The twelve QMD (query-managed database) flags are the largest remaining
// scattered cluster after batch 5. They gate every aspect of the tiered
// memory system: master switch, tier migration, cold tier, daemon, auto-embed,
// maintenance, query rerank, intent hints, explain, auto-upgrade, and parity
// graph. Read sites span orchestrator, operator-toolkit, access-service, and
// search/factory. All flags are non-optional booleans on PluginConfig (defaults
// resolved at the parse boundary), so the projection is pure pass-through.
// ---------------------------------------------------------------------------

/**
 * Frozen projection of QMD feature gates (issue #1523 batch 6).
 *
 * Every field is `readonly boolean`. Composition lives ONLY in
 * {@link resolveQmdCapabilities}.
 */
export interface QmdCapabilitySet {
  /** `qmdEnabled` — QMD tiered-memory master switch. */
  readonly qmd: boolean;
  /** `qmdTierMigrationEnabled` — automatic tier promotion/demotion. */
  readonly qmdTierMigration: boolean;
  /** `qmdTierAutoBackfillEnabled` — backfill stale tier entries. */
  readonly qmdTierAutoBackfill: boolean;
  /** `qmdAutoEmbedEnabled` — auto-embed documents on write. */
  readonly qmdAutoEmbed: boolean;
  /** `qmdMaintenanceEnabled` — QMD maintenance pass runner. */
  readonly qmdMaintenance: boolean;
  /** `qmdColdTierEnabled` — cold-tier storage. */
  readonly qmdColdTier: boolean;
  /** `qmdDaemonEnabled` — background QMD daemon. */
  readonly qmdDaemon: boolean;
  /** `qmdTierParityGraphEnabled` — tier parity graph. */
  readonly qmdTierParityGraph: boolean;
  /** `qmdQueryRerankEnabled` — QMD query reranking. */
  readonly qmdQueryRerank: boolean;
  /** `qmdIntentHintsEnabled` — QMD intent hint extraction. */
  readonly qmdIntentHints: boolean;
  /** `qmdExplainEnabled` — QMD explain output. */
  readonly qmdExplain: boolean;
  /** `qmdAutoUpgradeEnabled` — QMD auto-upgrade tiers. */
  readonly qmdAutoUpgrade: boolean;
}

/**
 * Config projection consumed by {@link resolveQmdCapabilities}.
 */
export type QmdConfigProjection = Pick<
  PluginConfig,
  | "qmdEnabled"
  | "qmdTierMigrationEnabled"
  | "qmdTierAutoBackfillEnabled"
  | "qmdAutoEmbedEnabled"
  | "qmdMaintenanceEnabled"
  | "qmdColdTierEnabled"
  | "qmdDaemonEnabled"
  | "qmdTierParityGraphEnabled"
  | "qmdQueryRerankEnabled"
  | "qmdIntentHintsEnabled"
  | "qmdExplainEnabled"
  | "qmdAutoUpgradeEnabled"
>;

/**
 * Resolve the {@link QmdCapabilitySet} from parsed config.
 *
 * Call this ONCE at operation entry and thread the result down. Eleven flags
 * are non-optional booleans (pure pass-through); `qmdColdTierEnabled` is
 * optional and coerced with `=== true` (matching the pre-migration call sites).
 */
export function resolveQmdCapabilities(config: QmdConfigProjection): QmdCapabilitySet {
  return Object.freeze({
    qmd: config.qmdEnabled,
    qmdTierMigration: config.qmdTierMigrationEnabled,
    qmdTierAutoBackfill: config.qmdTierAutoBackfillEnabled,
    qmdAutoEmbed: config.qmdAutoEmbedEnabled,
    qmdMaintenance: config.qmdMaintenanceEnabled,
    qmdColdTier: config.qmdColdTierEnabled === true,
    qmdDaemon: config.qmdDaemonEnabled,
    qmdTierParityGraph: config.qmdTierParityGraphEnabled,
    qmdQueryRerank: config.qmdQueryRerankEnabled,
    qmdIntentHints: config.qmdIntentHintsEnabled,
    qmdExplain: config.qmdExplainEnabled,
    qmdAutoUpgrade: config.qmdAutoUpgradeEnabled,
  });
}

// ---------------------------------------------------------------------------
// Identity-continuity capability set (issue #1523 batch 6).
//
// `identityContinuityEnabled` gates the identity/continuity system (agent
// identity tracking, continuity incident logging). Its 13 read sites span
// orchestrator, access-service, and CLI. The flag is a non-optional boolean
// on PluginConfig, so the projection is a pure pass-through.
// ---------------------------------------------------------------------------

/**
 * Frozen projection of identity-continuity feature gates (issue #1523 batch 6).
 */
export interface IdentityContinuityCapabilitySet {
  /** `identityContinuityEnabled` — identity-continuity master switch. */
  readonly identityContinuity: boolean;
}

/**
 * Config projection consumed by {@link resolveIdentityContinuityCapabilities}.
 */
export type IdentityContinuityConfigProjection = Pick<PluginConfig, "identityContinuityEnabled">;

/**
 * Resolve the {@link IdentityContinuityCapabilitySet} from parsed config.
 */
export function resolveIdentityContinuityCapabilities(
  config: IdentityContinuityConfigProjection,
): IdentityContinuityCapabilitySet {
  return Object.freeze({
    identityContinuity: config.identityContinuityEnabled,
  });
}

// ---------------------------------------------------------------------------
// Local-LLM capability set (issue #1523 batch 6).
//
// `localLlmEnabled` gates whether a local (on-device) LLM is used for
// summarization, embedding fallback, extraction, and search. Its 11 read
// sites span orchestrator, extraction, embedding-fallback, local-llm,
// search/embed-helper, and summarizer. The flag is a non-optional boolean.
// ---------------------------------------------------------------------------

/**
 * Frozen projection of local-LLM feature gates (issue #1523 batch 6).
 */
export interface LocalLlmCapabilitySet {
  /** `localLlmEnabled` — local (on-device) LLM master switch. */
  readonly localLlm: boolean;
}

/**
 * Config projection consumed by {@link resolveLocalLlmCapabilities}.
 */
export type LocalLlmConfigProjection = Pick<PluginConfig, "localLlmEnabled">;

/**
 * Resolve the {@link LocalLlmCapabilitySet} from parsed config.
 */
export function resolveLocalLlmCapabilities(
  config: LocalLlmConfigProjection,
): LocalLlmCapabilitySet {
  return Object.freeze({
    localLlm: config.localLlmEnabled,
  });
}

// ---------------------------------------------------------------------------
// Security capability set (issue #1523 batch 7). The six security/trust-zone
// flags gate quarantine promotion, poisoning defense, origin authority,
// injection screening, and trust-zone recall. Read sites span orchestrator,
// access-service, CLI, and research-status commands. All flags are
// non-optional booleans on PluginConfig (defaults resolved at the parse
// boundary), so the projection is a pure pass-through.
// ---------------------------------------------------------------------------

/**
 * Frozen projection of security/trust-zone feature gates (issue #1523 batch 7).
 */
export interface SecurityCapabilitySet {
  /** `trustZonesEnabled` — master switch for trust-zone enforcement. */
  readonly trustZones: boolean;
  /** `quarantinePromotionEnabled` — promote quarantined memories after review. */
  readonly quarantinePromotion: boolean;
  /** `memoryPoisoningDefenseEnabled` — detect and defend against memory poisoning. */
  readonly memoryPoisoningDefense: boolean;
  /** `originAuthorityEnabled` — preserve origin-bound write authority. */
  readonly originAuthority: boolean;
  /** `injectionScreenEnabled` — quarantine deterministic injection findings. */
  readonly injectionScreen: boolean;
  /** Injection-screen profile weighting (#1962). */
  readonly injectionScreenProfile: InjectionScreenProfile;
  /** `trustZoneRecallEnabled` — restrict recall to trusted zones. */
  readonly trustZoneRecall: boolean;
}

/** Config projection consumed by {@link resolveSecurityCapabilities}. */
export type SecurityConfigProjection = Pick<PluginConfig,
  | "trustZonesEnabled" | "quarantinePromotionEnabled" | "memoryPoisoningDefenseEnabled"
  | "originAuthorityEnabled" | "injectionScreenEnabled" | "injectionScreenProfile" | "trustZoneRecallEnabled">;

/** Resolve the {@link SecurityCapabilitySet} from parsed config. */
export function resolveSecurityCapabilities(config: SecurityConfigProjection): SecurityCapabilitySet {
  return Object.freeze({
    trustZones: config.trustZonesEnabled,
    quarantinePromotion: config.quarantinePromotionEnabled,
    memoryPoisoningDefense: config.memoryPoisoningDefenseEnabled,
    originAuthority: config.originAuthorityEnabled,
    injectionScreen: config.injectionScreenEnabled,
    injectionScreenProfile: config.injectionScreenProfile,
    trustZoneRecall: config.trustZoneRecallEnabled,
  });
}

// ---------------------------------------------------------------------------
// Eval/benchmark capability set (issue #1523 batch 7).
//
// The five eval/benchmark flags gate the evaluation harness, shadow mode,
// baseline snapshot management, delta reporting, and red-team benchmarking.
// Read sites span orchestrator, CLI, and operator-toolkit. All flags are
// non-optional booleans on PluginConfig.
// ---------------------------------------------------------------------------

/**
 * Frozen projection of eval/benchmark feature gates (issue #1523 batch 7).
 */
export interface EvalCapabilitySet {
  /** `evalHarnessEnabled` — master switch for the eval harness. */
  readonly evalHarness: boolean;
  /** `evalShadowModeEnabled` — run evaluations in shadow mode. */
  readonly evalShadowMode: boolean;
  /** `benchmarkBaselineSnapshotsEnabled` — manage baseline snapshots. */
  readonly benchmarkBaselineSnapshots: boolean;
  /** `benchmarkDeltaReporterEnabled` — report benchmark deltas. */
  readonly benchmarkDeltaReporter: boolean;
  /** `memoryRedTeamBenchEnabled` — red-team benchmarking of memory. */
  readonly memoryRedTeamBench: boolean;
}

/**
 * Config projection consumed by {@link resolveEvalCapabilities}.
 */
export type EvalConfigProjection = Pick<
  PluginConfig,
  "evalHarnessEnabled" | "evalShadowModeEnabled" | "benchmarkBaselineSnapshotsEnabled" | "benchmarkDeltaReporterEnabled" | "memoryRedTeamBenchEnabled"
>;

/**
 * Resolve the {@link EvalCapabilitySet} from parsed config.
 */
export function resolveEvalCapabilities(config: EvalConfigProjection): EvalCapabilitySet {
  return Object.freeze({
    evalHarness: config.evalHarnessEnabled,
    evalShadowMode: config.evalShadowModeEnabled,
    benchmarkBaselineSnapshots: config.benchmarkBaselineSnapshotsEnabled,
    benchmarkDeltaReporter: config.benchmarkDeltaReporterEnabled,
    memoryRedTeamBench: config.memoryRedTeamBenchEnabled,
  });
}

// ---------------------------------------------------------------------------
// Utility-learning capability set (issue #1523 batch 7).
//
// The two utility-learning flags gate memory utility learning and
// promotion-by-outcome. Read sites span orchestrator, CLI research-status
// commands, and maintenance files. Both flags are non-optional booleans.
// ---------------------------------------------------------------------------

/**
 * Frozen projection of utility-learning feature gates (issue #1523 batch 7).
 */
export interface UtilityLearningCapabilitySet {
  /** `memoryUtilityLearningEnabled` — learn memory utility weights from outcomes. */
  readonly memoryUtilityLearning: boolean;
  /** `promotionByOutcomeEnabled` — promote memories by outcome tracking. */
  readonly promotionByOutcome: boolean;
}

/**
 * Config projection consumed by {@link resolveUtilityLearningCapabilities}.
 */
export type UtilityLearningConfigProjection = Pick<
  PluginConfig,
  "memoryUtilityLearningEnabled" | "promotionByOutcomeEnabled"
>;

/**
 * Resolve the {@link UtilityLearningCapabilitySet} from parsed config.
 */
export function resolveUtilityLearningCapabilities(config: UtilityLearningConfigProjection): UtilityLearningCapabilitySet {
  return Object.freeze({
    memoryUtilityLearning: config.memoryUtilityLearningEnabled,
    promotionByOutcome: config.promotionByOutcomeEnabled,
  });
}

// ---------------------------------------------------------------------------
// Objective-state capability set (issue #1523 batch 7).
//
// The three objective-state flags gate objective-state memory, snapshot
// writes, and recall. Read sites span orchestrator, access-service, CLI
// creation-ledger commands, and research-status commands. All flags are
// non-optional booleans.
// ---------------------------------------------------------------------------

/**
 * Frozen projection of objective-state feature gates (issue #1523 batch 7).
 */
export interface ObjectiveStateCapabilitySet {
  /** `objectiveStateMemoryEnabled` — store objective-state memories. */
  readonly objectiveStateMemory: boolean;
  /** `objectiveStateSnapshotWritesEnabled` — write objective-state snapshots. */
  readonly objectiveStateSnapshotWrites: boolean;
  /** `objectiveStateRecallEnabled` — recall objective-state memories. */
  readonly objectiveStateRecall: boolean;
}

/**
 * Config projection consumed by {@link resolveObjectiveStateCapabilities}.
 */
export type ObjectiveStateConfigProjection = Pick<
  PluginConfig,
  "objectiveStateMemoryEnabled" | "objectiveStateSnapshotWritesEnabled" | "objectiveStateRecallEnabled"
>;

/**
 * Resolve the {@link ObjectiveStateCapabilitySet} from parsed config.
 */
export function resolveObjectiveStateCapabilities(config: ObjectiveStateConfigProjection): ObjectiveStateCapabilitySet {
  return Object.freeze({
    objectiveStateMemory: config.objectiveStateMemoryEnabled,
    objectiveStateSnapshotWrites: config.objectiveStateSnapshotWritesEnabled,
    objectiveStateRecall: config.objectiveStateRecallEnabled,
  });
}

// ---------------------------------------------------------------------------
// Compression capability set (issue #1523 batch 7).
//
// The three compression flags gate guideline learning, semantic refinement,
// and context-compression actions. Read sites span orchestrator,
// access-service, and the compression-guideline coordinator. All flags are
// non-optional booleans.
// ---------------------------------------------------------------------------

/**
 * Frozen projection of compression feature gates (issue #1523 batch 7).
 */
export interface CompressionCapabilitySet {
  /** `compressionGuidelineLearningEnabled` — learn compression guidelines. */
  readonly compressionGuidelineLearning: boolean;
  /** `compressionGuidelineSemanticRefinementEnabled` — semantically refine guidelines. */
  readonly compressionGuidelineSemanticRefinement: boolean;
  /** `contextCompressionActionsEnabled` — apply context-compression actions. */
  readonly contextCompressionActions: boolean;
}

/**
 * Config projection consumed by {@link resolveCompressionCapabilities}.
 */
export type CompressionConfigProjection = Pick<
  PluginConfig,
  "compressionGuidelineLearningEnabled" | "compressionGuidelineSemanticRefinementEnabled" | "contextCompressionActionsEnabled"
>;

/**
 * Resolve the {@link CompressionCapabilitySet} from parsed config.
 */
export function resolveCompressionCapabilities(config: CompressionConfigProjection): CompressionCapabilitySet {
  return Object.freeze({
    compressionGuidelineLearning: config.compressionGuidelineLearningEnabled,
    compressionGuidelineSemanticRefinement: config.compressionGuidelineSemanticRefinementEnabled,
    contextCompressionActions: config.contextCompressionActionsEnabled,
  });
}

// ---------------------------------------------------------------------------
// Presentation capability set (issue #1523 batch 8).
//
// These flags gate output formatting and presentation across the orchestrator, extraction
// pipeline, consolidation engine, and related modules. Resolved ONCE per
// operation entry rather than re-derived from raw config at each read site.
// All flags are non-optional booleans on PluginConfig (defaults applied at
// the parse boundary), so the projection is a pure pass-through.
// ---------------------------------------------------------------------------

/**
 * Frozen projection of output formatting and presentation feature gates (issue #1523 batch 8).
 */
export interface PresentationCapabilitySet {
  /** `verbatimArtifactsEnabled` — verbatim-artifact rendering in recall output. */
  readonly verbatimArtifacts: boolean;
  /** `memoryBoxesEnabled` — memory-box rendering in recall output. */
  readonly memoryBoxes: boolean;
  /** `bufferSurpriseTriggerEnabled` — buffer surprise-detection trigger. */
  readonly bufferSurpriseTrigger: boolean;
  /** `threadingEnabled` — conversation threading in output. */
  readonly threading: boolean;
  /** `episodeNoteModeEnabled` — episode note-mode formatting. */
  readonly episodeNoteMode: boolean;
  /** `transcriptEnabled` — transcript-mode output. */
  readonly transcript: boolean;
  /** `entitySummaryEnabled` — entity summary generation. */
  readonly entitySummary: boolean;
}

/**
 * Config projection consumed by {@link resolvePresentationCapabilities}.
 */
export type PresentationConfigProjection = Pick<
  PluginConfig,
  "verbatimArtifactsEnabled" |
  "memoryBoxesEnabled" |
  "bufferSurpriseTriggerEnabled" |
  "threadingEnabled" |
  "episodeNoteModeEnabled" |
  "transcriptEnabled" |
  "entitySummaryEnabled"
>;

/**
 * Resolve the {@link PresentationCapabilitySet} from parsed config.
 */
export function resolvePresentationCapabilities(config: PresentationConfigProjection): PresentationCapabilitySet {
  return Object.freeze({
    verbatimArtifacts: config.verbatimArtifactsEnabled,
    memoryBoxes: config.memoryBoxesEnabled,
    bufferSurpriseTrigger: config.bufferSurpriseTriggerEnabled,
    threading: config.threadingEnabled,
    episodeNoteMode: config.episodeNoteModeEnabled,
    transcript: config.transcriptEnabled,
    entitySummary: config.entitySummaryEnabled,
  });
}

// ---------------------------------------------------------------------------
// Consolidation capability set (issue #1523 batch 8).
//
// These flags gate memory consolidation, compounding, and abstraction across the orchestrator, extraction
// pipeline, consolidation engine, and related modules. Resolved ONCE per
// operation entry rather than re-derived from raw config at each read site.
// All flags are non-optional booleans on PluginConfig (defaults applied at
// the parse boundary), so the projection is a pure pass-through.
// ---------------------------------------------------------------------------

/**
 * Frozen projection of memory consolidation, compounding, and abstraction feature gates (issue #1523 batch 8).
 */
export interface ConsolidationCapabilitySet {
  /** `compoundingSemanticEnabled` — semantic compounding of memories. */
  readonly compoundingSemantic: boolean;
  /** `abstractionAnchorsEnabled` — abstraction-anchor extraction. */
  readonly abstractionAnchors: boolean;
  /** `compoundingEnabled` — master compounding switch. */
  readonly compounding: boolean;
  /** `calibrationEnabled` — memory calibration pass. */
  readonly calibration: boolean;
  /** `semanticConsolidationEnabled` — semantic consolidation pass. */
  readonly semanticConsolidation: boolean;
  /** `patternReinforcementEnabled` — pattern reinforcement in consolidation. */
  readonly patternReinforcement: boolean;
  /** `continuityAuditEnabled` — continuity audit during consolidation. */
  readonly continuityAudit: boolean;
  /** `graphEdgeDecayEnabled` — graph edge decay in maintenance. */
  readonly graphEdgeDecay: boolean;
}

/**
 * Config projection consumed by {@link resolveConsolidationCapabilities}.
 */
export type ConsolidationConfigProjection = Pick<
  PluginConfig,
  "compoundingSemanticEnabled" |
  "abstractionAnchorsEnabled" |
  "compoundingEnabled" |
  "calibrationEnabled" |
  "semanticConsolidationEnabled" |
  "patternReinforcementEnabled" |
  "continuityAuditEnabled" |
  "graphEdgeDecayEnabled"
>;

/**
 * Resolve the {@link ConsolidationCapabilitySet} from parsed config.
 */
export function resolveConsolidationCapabilities(config: ConsolidationConfigProjection): ConsolidationCapabilitySet {
  return Object.freeze({
    compoundingSemantic: config.compoundingSemanticEnabled,
    abstractionAnchors: config.abstractionAnchorsEnabled,
    compounding: config.compoundingEnabled,
    calibration: config.calibrationEnabled,
    semanticConsolidation: config.semanticConsolidationEnabled,
    patternReinforcement: config.patternReinforcementEnabled,
    continuityAudit: config.continuityAuditEnabled,
    graphEdgeDecay: config.graphEdgeDecayEnabled,
  });
}

// ---------------------------------------------------------------------------
// RecallAuxiliary capability set (issue #1523 batch 8).
//
// These flags gate extraction pipeline details and auxiliary recall enrichment across the orchestrator, extraction
// pipeline, consolidation engine, and related modules. Resolved ONCE per
// operation entry rather than re-derived from raw config at each read site.
// All flags are non-optional booleans on PluginConfig (defaults applied at
// the parse boundary), so the projection is a pure pass-through.
// ---------------------------------------------------------------------------

/**
 * Frozen projection of extraction pipeline details and auxiliary recall enrichment feature gates (issue #1523 batch 8).
 */
export interface RecallAuxiliaryCapabilitySet {
  /** `causalRuleExtractionEnabled` — causal-rule extraction in pipeline. */
  readonly causalRuleExtraction: boolean;
  /** `correctionEnabled` — memory correction subsystem. */
  readonly correction: boolean;
  /** `continuityIncidentLoggingEnabled` — continuity incident logging. */
  readonly continuityIncidentLogging: boolean;
  /** `daySummaryEnabled` — day-summary generation. */
  readonly daySummary: boolean;
  /** `versioningEnabled` — memory versioning. */
  readonly versioning: boolean;
  /** `verifiedRecallEnabled` — verified-recall tier. */
  readonly verifiedRecall: boolean;
  /** `semanticRuleVerificationEnabled` — semantic-rule verification. */
  readonly semanticRuleVerification: boolean;
  /** `workProductRecallEnabled` — work-product recall tier. */
  readonly workProductRecall: boolean;
  /** `secureStoreEnabled` — secure storage mode. */
  readonly secureStore: boolean;
  /** `knowledgeIndexEnabled` — knowledge index in recall. */
  readonly knowledgeIndex: boolean;
  /** `factDeduplicationEnabled` — fact deduplication in recall. */
  readonly factDeduplication: boolean;
  /** `compactionResetEnabled` — compaction reset on re-ingest. */
  readonly compactionReset: boolean;
  /** `entityRetrievalEnabled` — entity retrieval tier. */
  readonly entityRetrieval: boolean;
  /** `cronRecallPolicyEnabled` — cron-based recall policy. */
  readonly cronRecallPolicy: boolean;
}

/**
 * Config projection consumed by {@link resolveRecallAuxiliaryCapabilities}.
 */
export type RecallAuxiliaryConfigProjection = Pick<
  PluginConfig,
  "causalRuleExtractionEnabled" |
  "correctionEnabled" |
  "continuityIncidentLoggingEnabled" |
  "daySummaryEnabled" |
  "versioningEnabled" |
  "verifiedRecallEnabled" |
  "semanticRuleVerificationEnabled" |
  "workProductRecallEnabled" |
  "secureStoreEnabled" |
  "knowledgeIndexEnabled" |
  "factDeduplicationEnabled" |
  "compactionResetEnabled" |
  "entityRetrievalEnabled" |
  "cronRecallPolicyEnabled"
>;

/**
 * Resolve the {@link RecallAuxiliaryCapabilitySet} from parsed config.
 */
export function resolveRecallAuxiliaryCapabilities(config: RecallAuxiliaryConfigProjection): RecallAuxiliaryCapabilitySet {
  return Object.freeze({
    causalRuleExtraction: config.causalRuleExtractionEnabled,
    correction: config.correctionEnabled,
    continuityIncidentLogging: config.continuityIncidentLoggingEnabled,
    daySummary: config.daySummaryEnabled,
    versioning: config.versioningEnabled,
    verifiedRecall: config.verifiedRecallEnabled,
    semanticRuleVerification: config.semanticRuleVerificationEnabled,
    workProductRecall: config.workProductRecallEnabled,
    secureStore: config.secureStoreEnabled,
    knowledgeIndex: config.knowledgeIndexEnabled,
    factDeduplication: config.factDeduplicationEnabled,
    compactionReset: config.compactionResetEnabled,
    entityRetrieval: config.entityRetrievalEnabled,
    cronRecallPolicy: config.cronRecallPolicyEnabled,
  });
}

// ---------------------------------------------------------------------------
// RecallEnhancement capability set (issue #1523 batch 9).
//
// These 24 flags gate recall enrichment, memory reconstruction, entity
// relationships, causal trajectory recall, CMC retrieval, and related
// enhancement paths. Read sites span orchestrator, access-service, graph-recall,
// and CLI research-status commands. All flags are non-optional booleans on
// PluginConfig (defaults resolved at the parse boundary), so the projection
// is a pure pass-through.
// ---------------------------------------------------------------------------

/**
 * Frozen projection of recall-enhancement feature gates (issue #1523 batch 9).
 */
export interface RecallEnhancementCapabilitySet {
  readonly explicitCueRecall: boolean;
  readonly targetedFactRecall: boolean;
  readonly focusedListRecall: boolean;
  readonly responseGuidanceRecall: boolean;
  readonly eventOrderRecall: boolean;
  readonly reinforcementRecallBoost: boolean;
  readonly recallPlannerTelemetry: boolean;
  readonly peerProfileRecall: boolean;
  readonly graphAssistShadowEval: boolean;
  readonly memoryReconstruction: boolean;
  readonly memoryLinking: boolean;
  readonly causalTrajectoryRecall: boolean;
  readonly causalTrajectoryMemory: boolean;
  readonly cmcRetrieval: boolean;
  readonly contradictionDetection: boolean;
  readonly factArchival: boolean;
  readonly entityRelationships: boolean;
  readonly entityActivityLog: boolean;
  readonly compoundingInject: boolean;
  readonly accessTracking: boolean;
  readonly autoPromoteToShared: boolean;
  readonly feedback: boolean;
  readonly identity: boolean;
}

/**
 * Config projection consumed by {@link resolveRecallEnhancementCapabilities}.
 */
export type RecallEnhancementConfigProjection = Pick<
  PluginConfig,
  | "explicitCueRecallEnabled"
  | "targetedFactRecallEnabled"
  | "focusedListRecallEnabled"
  | "responseGuidanceRecallEnabled"
  | "eventOrderRecallEnabled"
  | "reinforcementRecallBoostEnabled"
  | "recallPlannerTelemetryEnabled"
  | "peerProfileRecallEnabled"
  | "graphAssistShadowEvalEnabled"
  | "memoryReconstructionEnabled"
  | "memoryLinkingEnabled"
  | "causalTrajectoryRecallEnabled"
  | "causalTrajectoryMemoryEnabled"
  | "cmcRetrievalEnabled"
  | "contradictionDetectionEnabled"
  | "factArchivalEnabled"
  | "entityRelationshipsEnabled"
  | "entityActivityLogEnabled"
  | "compoundingInjectEnabled"
  | "accessTrackingEnabled"
  | "autoPromoteToSharedEnabled"
  | "feedbackEnabled"
  | "identityEnabled"
>;

/**
 * Resolve the {@link RecallEnhancementCapabilitySet} from parsed config.
 */
export function resolveRecallEnhancementCapabilities(config: RecallEnhancementConfigProjection): RecallEnhancementCapabilitySet {
  return Object.freeze({
    explicitCueRecall: config.explicitCueRecallEnabled,
    targetedFactRecall: config.targetedFactRecallEnabled,
    focusedListRecall: config.focusedListRecallEnabled,
    responseGuidanceRecall: config.responseGuidanceRecallEnabled,
    eventOrderRecall: config.eventOrderRecallEnabled,
    reinforcementRecallBoost: config.reinforcementRecallBoostEnabled,
    recallPlannerTelemetry: config.recallPlannerTelemetryEnabled,
    peerProfileRecall: config.peerProfileRecallEnabled,
    graphAssistShadowEval: config.graphAssistShadowEvalEnabled === true,
    memoryReconstruction: config.memoryReconstructionEnabled,
    memoryLinking: config.memoryLinkingEnabled,
    causalTrajectoryRecall: config.causalTrajectoryRecallEnabled,
    causalTrajectoryMemory: config.causalTrajectoryMemoryEnabled,
    cmcRetrieval: config.cmcRetrievalEnabled,
    contradictionDetection: config.contradictionDetectionEnabled,
    factArchival: config.factArchivalEnabled,
    entityRelationships: config.entityRelationshipsEnabled,
    entityActivityLog: config.entityActivityLogEnabled,
    compoundingInject: config.compoundingInjectEnabled,
    accessTracking: config.accessTrackingEnabled,
    autoPromoteToShared: config.autoPromoteToSharedEnabled,
    feedback: config.feedbackEnabled,
    identity: config.identityEnabled,
  });
}

// ---------------------------------------------------------------------------
// PipelineProcessing capability set (issue #1523 batch 9). These 23 flags gate
// extraction/chunking/summarization and LLM infrastructure across orchestrator,
// extraction, summarizer, embedding-fallback, local-llm, search, day-summary, and
// semantic-consolidation. Defaults resolve at parse boundary, so pure pass-through.
// ---------------------------------------------------------------------------

/**
 * Frozen projection of pipeline-processing feature gates (issue #1523 batch 9).
 */
export interface PipelineProcessingCapabilitySet {
  readonly chunking: boolean;
  readonly semanticChunking: boolean;
  readonly semanticDedup: boolean;
  readonly summarization: boolean;
  readonly topicExtraction: boolean;
  readonly sessionObserver: boolean;
  readonly profiling: boolean;
  readonly checkpoint: boolean;
  readonly traceWeaver: boolean;
  readonly routingRules: boolean;
  readonly inlineSourceAttribution: boolean;
  readonly negativeExamples: boolean;
  readonly hourlySummaries: boolean;
  readonly lcm: boolean;
  readonly localLlmFast: boolean;
  readonly proactiveExtraction: boolean;
  readonly sourceGrounding: boolean;
  readonly delinearize: boolean;
  readonly slowLog: boolean;
  readonly hostEmbeddingProvider: boolean;
  readonly memoryExtensions: boolean;
  readonly hourlySummariesExtended: boolean;
}

/**
 * Config projection consumed by {@link resolvePipelineProcessingCapabilities}.
 */
export type PipelineProcessingConfigProjection = Pick<
  PluginConfig,
  | "chunkingEnabled"
  | "semanticChunkingEnabled"
  | "semanticDedupEnabled"
  | "summarizationEnabled"
  | "topicExtractionEnabled"
  | "sessionObserverEnabled"
  | "profilingEnabled"
  | "checkpointEnabled"
  | "traceWeaverEnabled"
  | "routingRulesEnabled"
  | "inlineSourceAttributionEnabled"
  | "negativeExamplesEnabled"
  | "hourlySummariesEnabled"
  | "lcmEnabled"
  | "localLlmFastEnabled"
  | "proactiveExtractionEnabled"
  | "extractionSourceGroundingEnabled"
  | "delinearizeEnabled"
  | "slowLogEnabled"
  | "hostEmbeddingProviderEnabled"
  | "memoryExtensionsEnabled"
  | "hourlySummariesExtendedEnabled"
>;

/**
 * Resolve the {@link PipelineProcessingCapabilitySet} from parsed config.
 */
export function resolvePipelineProcessingCapabilities(config: PipelineProcessingConfigProjection): PipelineProcessingCapabilitySet {
  return Object.freeze({
    chunking: config.chunkingEnabled,
    semanticChunking: config.semanticChunkingEnabled,
    semanticDedup: config.semanticDedupEnabled,
    summarization: config.summarizationEnabled,
    topicExtraction: config.topicExtractionEnabled,
    sessionObserver: config.sessionObserverEnabled === true,
    profiling: config.profilingEnabled,
    checkpoint: config.checkpointEnabled,
    traceWeaver: config.traceWeaverEnabled,
    routingRules: config.routingRulesEnabled,
    inlineSourceAttribution: config.inlineSourceAttributionEnabled,
    negativeExamples: config.negativeExamplesEnabled,
    hourlySummaries: config.hourlySummariesEnabled,
    lcm: config.lcmEnabled,
    localLlmFast: config.localLlmFastEnabled,
    proactiveExtraction: config.proactiveExtractionEnabled,
    sourceGrounding: config.extractionSourceGroundingEnabled,
    delinearize: config.delinearizeEnabled,
    slowLog: config.slowLogEnabled,
    hostEmbeddingProvider: config.hostEmbeddingProviderEnabled,
    memoryExtensions: config.memoryExtensionsEnabled,
    hourlySummariesExtended: config.hourlySummariesExtendedEnabled,
  });
}

// ---------------------------------------------------------------------------
// ConversationContext capability set (issue #1523 batch 9).
//
// These 12 flags gate conversation context, shared signals, intent routing,
// operator-aware consolidation, CMC consolidation, maintenance fanout, CLI
// presentation, and code connectors. Read sites span orchestrator, CLI,
// shared-context/manager, semantic-consolidation-coordinator, compounding/engine,
// maintenance modules, procedural stats, connectors, and wearables. All flags
// are non-optional booleans on PluginConfig (defaults resolved at the parse
// boundary), so the projection is a pure pass-through.
// ---------------------------------------------------------------------------

/**
 * Frozen projection of conversation/context feature gates (issue #1523 batch 9).
 */
export interface ConversationContextCapabilitySet {
  readonly sharedContext: boolean;
  readonly intentRouting: boolean;
  readonly crossSignalsSemantic: boolean;
  readonly sharedCrossSignalSemantic: boolean;
  readonly operatorAwareConsolidation: boolean;
  readonly peerProfileReasoner: boolean;
  readonly cmcConsolidation: boolean;
  readonly maintenanceNamespaceFanout: boolean;
  readonly citations: boolean;
  readonly semanticRulePromotion: boolean;
  readonly codexMarketplace: boolean;
}

/**
 * Config projection consumed by {@link resolveConversationContextCapabilities}.
 */
export type ConversationContextConfigProjection = Pick<
  PluginConfig,
  | "sharedContextEnabled"
  | "intentRoutingEnabled"
  | "crossSignalsSemanticEnabled"
  | "sharedCrossSignalSemanticEnabled"
  | "operatorAwareConsolidationEnabled"
  | "peerProfileReasonerEnabled"
  | "cmcConsolidationEnabled"
  | "maintenanceNamespaceFanoutEnabled"
  | "citationsEnabled"
  | "semanticRulePromotionEnabled"
  | "codexMarketplaceEnabled"
>;

/**
 * Resolve the {@link ConversationContextCapabilitySet} from parsed config.
 */
export function resolveConversationContextCapabilities(config: ConversationContextConfigProjection): ConversationContextCapabilitySet {
  return Object.freeze({
    sharedContext: config.sharedContextEnabled,
    intentRouting: config.intentRoutingEnabled,
    crossSignalsSemantic: config.crossSignalsSemanticEnabled,
    sharedCrossSignalSemantic: config.sharedCrossSignalSemanticEnabled === true,
    operatorAwareConsolidation: config.operatorAwareConsolidationEnabled,
    peerProfileReasoner: config.peerProfileReasonerEnabled,
    cmcConsolidation: config.cmcConsolidationEnabled,
    maintenanceNamespaceFanout: config.maintenanceNamespaceFanoutEnabled,
    citations: config.citationsEnabled,
    semanticRulePromotion: config.semanticRulePromotionEnabled,
    codexMarketplace: config.codexMarketplaceEnabled,
  });
}
