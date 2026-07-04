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
