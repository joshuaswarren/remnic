
export const DEEP_RECALL_FRONTIER_CAP = 20;

export interface DeepRecallFrontierCandidate {
  nodeId: string;
  sharedAnchorCount: number;
}

export function rankDeepRecallFrontier(
  candidates: readonly DeepRecallFrontierCandidate[],
): DeepRecallFrontierCandidate[] {
  const byNodeId = new Map<string, DeepRecallFrontierCandidate>();
  for (const candidate of candidates) {
    const nodeId = typeof candidate.nodeId === "string" ? candidate.nodeId.trim() : "";
    if (nodeId === "") continue;
    const count = candidate.sharedAnchorCount;
    if (typeof count !== "number" || !Number.isFinite(count) || count < 1) continue;
    const kept = byNodeId.get(nodeId);
    if (kept === undefined || count > kept.sharedAnchorCount) {
      byNodeId.set(nodeId, { nodeId, sharedAnchorCount: count });
    }
  }
  return [...byNodeId.values()]
    .sort((a, b) => {
      if (a.sharedAnchorCount !== b.sharedAnchorCount) {
        return b.sharedAnchorCount - a.sharedAnchorCount;
      }
      if (a.nodeId !== b.nodeId) return a.nodeId < b.nodeId ? -1 : 1;
      return 0;
    })
    .slice(0, DEEP_RECALL_FRONTIER_CAP);
}
