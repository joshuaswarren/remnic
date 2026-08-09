import type { ActivationPath, GraphType } from "./graph.js";

export interface ActivationPredecessor {
  prev: string;
  edgeConfidence: number;
  graphType: GraphType;
}

export function reconstructActivationPath(
  seed: string,
  candidate: string,
  predecessors: Map<string, ActivationPredecessor>,
  maxSteps: number,
): ActivationPath | null {
  const nodeIds = [candidate];
  const edgeConfidences: number[] = [];
  const graphTypes: GraphType[] = [];
  let current = candidate;
  const stepCap = Number.isFinite(maxSteps)
    ? Math.max(0, Math.ceil(maxSteps))
    : predecessors.size + 1;
  for (let step = 0; step < stepCap && current !== seed; step += 1) {
    const predecessor = predecessors.get(`${seed}\0${current}`);
    if (!predecessor) return null;
    nodeIds.push(predecessor.prev);
    edgeConfidences.push(predecessor.edgeConfidence);
    graphTypes.push(predecessor.graphType);
    current = predecessor.prev;
  }

  if (current !== seed) return null;
  nodeIds.reverse();
  edgeConfidences.reverse();
  graphTypes.reverse();
  if (edgeConfidences.length !== nodeIds.length - 1 || graphTypes.length !== nodeIds.length - 1) {
    return null;
  }
  return { nodeIds, edgeConfidences, graphTypes };
}
