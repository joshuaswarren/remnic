/**
 * Recall navigation traverse selection (issue #1956).
 *
 * Pure selection step for `traverseLinks(id, relation?, limit)`: given a
 * recalled memory's links, pick which neighbors a traverse would visit.
 * Internal; surfaces wire it in a later slice.
 */
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

  const seen = new Set<string>();
  const kept: TraverseNeighbor[] = [];
  // Asymmetry is intentional: a bad request (unknown relation, invalid
  // limit) is refused, but bad stored data (a link whose linkType is not a
  // known type, or a blank targetId) is skipped — stored data may predate a
  // type, and one bad row must not fail the whole traverse.
  for (const link of input.links) {
    if (!parseNavigateLinkType(link.linkType).ok) continue;
    if (input.relation !== undefined && link.linkType !== input.relation) continue;
    if (link.targetId.trim() === "") continue;
    if (seen.has(link.targetId)) continue;
    seen.add(link.targetId);
    kept.push({ targetId: link.targetId, linkType: link.linkType });
  }

  kept.sort((a, b) => {
    if (a.linkType !== b.linkType) return a.linkType < b.linkType ? -1 : 1;
    if (a.targetId !== b.targetId) return a.targetId < b.targetId ? -1 : 1;
    return 0;
  });

  const truncated = kept.length > limit;
  return { ok: true, neighbors: truncated ? kept.slice(0, limit) : kept, truncated };
}
