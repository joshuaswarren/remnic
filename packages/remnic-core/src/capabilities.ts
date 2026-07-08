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
 */

import type { PluginConfig } from "./types.js";

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
}

/**
 * Resolve the {@link AccessSetupCapabilitySet} from parsed config.
 *
 * Call this ONCE at access-service handler entry and thread the result down.
 */
export type AccessSetupConfigProjection = Pick<
  PluginConfig,
  "recallCrossNamespaceBudgetEnabled" | "recallAuditAnomalyDetectionEnabled"
>;

export function resolveAccessSetupCapabilities(
  config: AccessSetupConfigProjection,
): AccessSetupCapabilitySet {
  return Object.freeze({
    recallCrossNamespaceBudget: config.recallCrossNamespaceBudgetEnabled,
    // Optional/default-off flag: preserve `=== true` semantics.
    recallAuditAnomalyDetection: config.recallAuditAnomalyDetectionEnabled === true,
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
