import type { ActivationPath } from "./graph.js";
import type { MemoryStatus } from "./types.js";

/** Memory state used to score an intermediate path node. */
export interface PathNodeState {
  id: string;
  status: MemoryStatus | null;
  invalidAt: string | null;
}

/** Configuration for graph-path evidence scoring. */
export interface PathScoringOptions {
  asOf: string;
  invalidNodePenalty: number;
}

function isInvalidIntermediate(state: PathNodeState | undefined, asOfMs: number): boolean {
  if (!state) return false;
  if (state.status !== null && state.status !== "active") return true;
  if (state.invalidAt === null) return false;
  const invalidAtMs = Date.parse(state.invalidAt);
  return Number.isFinite(invalidAtMs) && invalidAtMs <= asOfMs;
}

/**
 * Return the multiplicative evidence factor for one graph activation path.
 *
 * Edge confidence is multiplied for every hop. Invalid intermediate memories
 * receive the configured penalty once each. Seed and candidate states do not
 * affect the result because the caller already scored those memories.
 */
export function scoreEvidencePath(
  evidencePath: ActivationPath | null,
  nodeStates: ReadonlyMap<string, PathNodeState>,
  options: PathScoringOptions,
): number {
  if (!evidencePath) return 1;
  const asOfMs = Date.parse(options.asOf);
  let multiplier = evidencePath.edgeConfidences.reduce(
    (product, confidence) => product * confidence,
    1,
  );
  for (const nodeId of evidencePath.nodeIds.slice(1, -1)) {
    if (isInvalidIntermediate(nodeStates.get(nodeId), asOfMs)) {
      multiplier *= options.invalidNodePenalty;
    }
  }
  return multiplier;
}
