import type { ActivationPath, GraphType } from "./graph.js";

export interface ActivationPredecessor {
  prev: string;
  edgeConfidence: number;
  graphType: GraphType;
}

export interface ActivationPathCandidate {
  hopDepth: number;
  landingStrength: number;
  pathKey: string;
}

/** Compare path winners: fewer hops, stronger landing, then lexical path order. */
export function compareActivationPathCandidates(
  left: ActivationPathCandidate,
  right: ActivationPathCandidate,
): number {
  if (left.hopDepth !== right.hopDepth) return right.hopDepth - left.hopDepth;
  if (left.landingStrength !== right.landingStrength) return left.landingStrength - right.landingStrength;
  if (left.pathKey === right.pathKey) return 0;
  return left.pathKey < right.pathKey ? 1 : -1;
}

export class ActivationPathTracker {
  readonly predecessors = new Map<string, ActivationPredecessor>();
  private readonly winners = new Map<string, ActivationPathCandidate>();
  private readonly pathKeys = new Map<string, string>();

  constructor(seeds: Iterable<string>) {
    for (const seed of seeds) {
      this.pathKeys.set(`${seed}\0${seed}`, seed);
    }
  }

  consider(
    seed: string,
    node: string,
    neighbor: string,
    hopDepth: number,
    landingStrength: number,
    edgeConfidence: number,
    graphType: GraphType,
  ): string {
    const sourcePathKey = this.pathKeys.get(`${seed}\0${node}`);
    if (!sourcePathKey) return "";

    const key = `${seed}\0${neighbor}`;
    const pathKey = `${sourcePathKey}\0${neighbor}`;
    const candidate: ActivationPathCandidate = { hopDepth, landingStrength, pathKey };
    const previous = this.winners.get(key);
    if (!previous || compareActivationPathCandidates(candidate, previous) > 0) {
      this.winners.set(key, candidate);
      this.pathKeys.set(key, pathKey);
      this.predecessors.set(key, { prev: node, edgeConfidence, graphType });
    }
    return pathKey;
  }
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
