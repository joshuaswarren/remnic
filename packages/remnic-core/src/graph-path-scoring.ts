import type { ActivationPath } from "./graph.js";
import type { MemoryFrontmatter, MemoryStatus } from "./types.js";
import { isValidAsOf } from "./temporal-validity.js";

/** Memory state used to score an intermediate path node. */
export interface PathNodeState
  extends Pick<
    MemoryFrontmatter,
    "valid_at" | "invalid_at" | "created" | "supersededAt" | "eventTimeSource"
  > {
  id: string;
  status: MemoryStatus | null;
}

/** Configuration for graph-path evidence scoring. */
export interface PathScoringOptions {
  asOf: string;
  invalidNodePenalty: number;
}

function isInvalidIntermediate(state: PathNodeState | undefined, asOfMs: number): boolean {
  if (!state || state.status === null) return false;
  if (!isValidAsOf({ ...state, status: state.status }, asOfMs)) return true;

  const hasSupersessionEnd =
    state.status === "superseded" &&
    ((state.invalid_at?.trim().length ?? 0) > 0 ||
      (state.supersededAt?.trim().length ?? 0) > 0);
  return state.status !== "active" && !hasSupersessionEnd;
}

export interface PathScoreDetail {
  score: number;
  pathPenaltyApplied: boolean;
}

export function scoreEvidencePathDetail(
  evidencePath: ActivationPath | null,
  nodeStates: ReadonlyMap<string, PathNodeState>,
  options: PathScoringOptions,
): PathScoreDetail {
  const asOfMs = Date.parse(options.asOf);
  if (!Number.isFinite(asOfMs)) {
    throw new Error("asOf must be a finite timestamp");
  }
  if (!evidencePath) return { score: 1, pathPenaltyApplied: false };
  let multiplier = evidencePath.edgeConfidences.reduce(
    (product, confidence) => product * confidence,
    1,
  );
  let invalidIntermediateCount = 0;
  for (const nodeId of evidencePath.nodeIds.slice(1, -1)) {
    if (isInvalidIntermediate(nodeStates.get(nodeId), asOfMs)) {
      invalidIntermediateCount += 1;
      multiplier *= options.invalidNodePenalty;
    }
  }
  return {
    score: multiplier,
    pathPenaltyApplied: invalidIntermediateCount > 0 && options.invalidNodePenalty !== 1,
  };
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
  return scoreEvidencePathDetail(evidencePath, nodeStates, options).score;
}
