import { parseNavigateLinkType } from "./recall-navigate-link.js";

export const DEFAULT_TRAVERSE_LIMIT = 10;

export interface TraverseNeighbor {
  targetId: string;
  linkType: string;
}

export type TraverseSelectionResult =
  | { ok: true; neighbors: TraverseNeighbor[]; truncated: boolean }
  | { ok: false; error: "unknown_relation" | "invalid_limit" };

export function selectTraverseNeighbors(input: {
  links: readonly TraverseNeighbor[];
  /** Optional relation filter; omitted means every known relation. */
  relation?: string;
  limit?: number;
}): TraverseSelectionResult {
  const limit = input.limit ?? DEFAULT_TRAVERSE_LIMIT;
  if (!Number.isFinite(limit) || !Number.isInteger(limit) || limit < 1) {
    return { ok: false, error: "invalid_limit" };
  }
  if (input.relation !== undefined && !parseNavigateLinkType(input.relation).ok) {
    return { ok: false, error: "unknown_relation" };
  }

  const kept: TraverseNeighbor[] = [];
  for (const link of input.links) {
    if (!parseNavigateLinkType(link.linkType).ok) continue;
    if (input.relation !== undefined && link.linkType !== input.relation) continue;
    if (typeof link.targetId !== "string" || link.targetId.trim() === "" || link.targetId.trim() !== link.targetId) {
      continue;
    }
    kept.push({ targetId: link.targetId, linkType: link.linkType });
  }

  kept.sort((a, b) => {
    if (a.linkType !== b.linkType) return a.linkType < b.linkType ? -1 : 1;
    if (a.targetId !== b.targetId) return a.targetId < b.targetId ? -1 : 1;
    return 0;
  });

  const seen = new Set<string>();
  const deduped: TraverseNeighbor[] = [];
  for (const link of kept) {
    if (seen.has(link.targetId)) continue;
    seen.add(link.targetId);
    deduped.push(link);
  }

  const truncated = deduped.length > limit;
  return { ok: true, neighbors: truncated ? deduped.slice(0, limit) : deduped, truncated };
}
