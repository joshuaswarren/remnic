/**
 * Graph-based retrieval integration (issue #559 PR 4 of 5).
 *
 * Pure helper that composes `extractGraphEdges` (PR 2) and `queryGraph`
 * (PR 3) into a single retrieval surface. Operators opt in via the
 * `recallGraphEnabled` config flag; until the `retrieval-graph` bench in
 * PR 5 justifies flipping the default, this tier ships disabled.
 *
 * Kept as a pure function so the orchestrator can call it with whatever
 * candidate pool it has (hot cache, recent window, QMD first-pass, etc.)
 * without forcing a specific storage contract on this module.
 */

import {
  DEFAULT_PPR_DAMPING,
  DEFAULT_PPR_ITERATIONS,
  type MemoryEdgeSource,
  type RemnicGraph,
  buildGraphFromMemories,
  queryGraph,
} from "./graph-retrieval.js";

/**
 * Subset of `PluginConfig` that governs the graph retrieval tier. Kept
 * as a local interface so this module does not pull in the full
 * `PluginConfig` import — `orchestrator.ts` can pass the fields directly.
 */
export interface GraphRecallConfig {
  /** Master enable flag. When false, `runGraphRecall` is a no-op. */
  recallGraphEnabled: boolean;
  /** PPR damping factor (default 0.85). */
  recallGraphDamping: number;
  /** PPR power-iteration cap (default 20). */
  recallGraphIterations: number;
  /**
   * Max memories the graph tier returns. `0` disables the tier's
   * contribution without touching `recallGraphEnabled`.
   */
  recallGraphTopK: number;
}

/** Per-invocation options for `runGraphRecall`. */
export interface GraphRecallOptions {
  /**
   * Candidate memories to build the graph from. Typically the caller's
   * recall candidate pool (hot cache + QMD first-pass). The extractor
   * reads only the fields declared on `MemoryEdgeSource` — callers can
   * safely pass richer memory objects.
   */
  memories: readonly MemoryEdgeSource[];
  /**
   * Seed memory / entity ids produced by the query-to-graph matcher.
   * Typically the ids of the top QMD hits plus any entity-exact matches.
   * If empty, PPR falls back to a uniform distribution over graph nodes.
   */
  seedIds: readonly string[];
  /**
   * Optional per-seed weights. When provided, PPR starts from the
   * weighted distribution instead of uniform-over-seeds.
   */
  seedWeights?: ReadonlyMap<string, number> | Readonly<Record<string, number>>;
}

/** A single result from the graph tier. */
export interface GraphRecallResult {
  /** Memory id (the `to` of the highest-scoring `memory`-typed node). */
  id: string;
  /** PPR score in [0, 1]. Higher is better. */
  score: number;
}

/** The full shape returned by `runGraphRecall`. */
export interface GraphRecallRun {
  /**
   * Whether the graph tier actually ran. `false` when `recallGraphEnabled`
   * is `false` or `recallGraphTopK <= 0` — in both cases `results` is `[]`
   * and `reason` indicates which gate short-circuited.
   */
  ran: boolean;
  /**
   * Memory-typed ranked results. Entity / agent nodes are filtered out
   * because the orchestrator merges this list with memory-typed QMD
   * results via MMR.
   */
  results: GraphRecallResult[];
  /** The graph that was built (or `null` if the tier did not run). */
  graph: RemnicGraph | null;
  /** Debugging tag for tier-explain surfaces. */
  reason: "ran" | "disabled" | "topk-zero" | "empty-input";
  /** Number of power-iteration rounds that executed. */
  iterations: number;
  /** Whether PPR's L1 delta fell below tolerance before the iter cap. */
  converged: boolean;
}

/**
 * Pure graph retrieval run.
 *
 * 1. Short-circuits to `{ ran: false }` when the feature flag is off,
 *    `topK <= 0`, or the memory pool is empty. No graph is built, no
 *    PPR runs — this preserves the zero-cost guarantee for
 *    `recallGraphEnabled: false` (the default).
 * 2. Otherwise builds the retrieval graph from the candidate pool via
 *    `buildGraphFromMemories` (PR 2 extractor).
 * 3. Runs Personalized PageRank via `queryGraph` (PR 3).
 * 4. Projects ranked nodes to memory-typed ids only — entity and agent
 *    nodes never appear in the recall result set.
 */
export function runGraphRecall(
  config: GraphRecallConfig,
  options: GraphRecallOptions,
): GraphRecallRun {
  if (!config.recallGraphEnabled) {
    return {
      ran: false,
      results: [],
      graph: null,
      reason: "disabled",
      iterations: 0,
      converged: true,
    };
  }

  // `isFinite` guard on `topK` mirrors the checks on `damping` and
  // `iterations` below. Without it a `NaN` topK would pass the typeof
  // check, then `NaN <= 0` is false (bypassing the short-circuit) and
  // the downstream `memoryResults.length >= topK` never triggers.
  const topK =
    typeof config.recallGraphTopK === "number" && Number.isFinite(config.recallGraphTopK)
      ? config.recallGraphTopK
      : 50;
  if (topK <= 0) {
    return {
      ran: false,
      results: [],
      graph: null,
      reason: "topk-zero",
      iterations: 0,
      converged: true,
    };
  }

  if (options.memories.length === 0) {
    return {
      ran: false,
      results: [],
      graph: null,
      reason: "empty-input",
      iterations: 0,
      converged: true,
    };
  }

  const graph = buildGraphFromMemories(options.memories);

  const damping =
    typeof config.recallGraphDamping === "number" && Number.isFinite(config.recallGraphDamping)
      ? config.recallGraphDamping
      : DEFAULT_PPR_DAMPING;
  const iterations =
    typeof config.recallGraphIterations === "number" && Number.isFinite(config.recallGraphIterations)
      ? config.recallGraphIterations
      : DEFAULT_PPR_ITERATIONS;

  // PPR runs without a topK so we can post-filter non-memory nodes without
  // the trim dropping memory-typed results. We apply topK after projection.
  const ppr = queryGraph(graph, options.seedIds, {
    damping,
    iterations,
    seedWeights: options.seedWeights,
  });

  const memoryResults: GraphRecallResult[] = [];
  for (const node of ppr.rankedNodes) {
    const graphNode = graph.nodes.get(node.id);
    if (!graphNode || graphNode.type !== "memory") continue;
    memoryResults.push({ id: node.id, score: node.score });
    if (memoryResults.length >= topK) break;
  }

  return {
    ran: true,
    results: memoryResults,
    graph,
    reason: "ran",
    iterations: ppr.iterations,
    converged: ppr.converged,
  };
}
