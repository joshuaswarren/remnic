import type { ActivationPath } from "./graph.js";

/** Minimal memory state needed to score an activation path. */
export interface PathNodeState {
  status?: string | null;
  invalidAt?: string | null;
}

/** Configuration for graph-path evidence scoring. */
export interface PathScoringOptions {
  asOf: number;
  invalidNodePenalty: number;
}

function isInvalidIntermediate(state: PathNodeState | null | undefined, asOf: number): boolean {
  if (!state) return false;
  if (state.status !== undefined && state.status !== null && state.status !== "active") {
    return true;
  }
  if (typeof state.invalidAt !== "string" || state.invalidAt.length === 0) return false;
  const invalidAt = Date.parse(state.invalidAt);
  return Number.isFinite(invalidAt) && invalidAt <= asOf;
}

function stateForNode(
  states: ReadonlyMap<string, PathNodeState | null | undefined> | Readonly<Record<string, PathNodeState | null | undefined>>,
  nodeId: string,
): PathNodeState | null | undefined {
  if (states instanceof Map) return states.get(nodeId);
  return states[nodeId];
}

/**
 * Return the multiplicative evidence factor for one graph activation path.
 *
 * Edge confidence is multiplied for every hop. Invalid intermediate memories
 * receive the configured penalty once each. Seed and candidate states do not
 * affect the result because the caller already scored those memories.
 */
export function scoreEvidencePath(
  evidencePath: ActivationPath | null | undefined,
  nodeStates: ReadonlyMap<string, PathNodeState | null | undefined> | Readonly<Record<string, PathNodeState | null | undefined>>,
  options: PathScoringOptions,
): number {
  if (!evidencePath) return 1;
  const edgeProduct = evidencePath.edgeConfidences.reduce(
    (product, confidence) => product * (Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0),
    1,
  );
  const penalty = Number.isFinite(options.invalidNodePenalty)
    ? Math.max(0, Math.min(1, options.invalidNodePenalty))
    : 1;
  const intermediatePenalty = evidencePath.nodeIds
    .slice(1, -1)
    .reduce(
      (product, nodeId) =>
        product * (isInvalidIntermediate(stateForNode(nodeStates, nodeId), options.asOf) ? penalty : 1),
      1,
    );
  return Math.max(0, Math.min(1, edgeProduct * intermediatePenalty));
}
