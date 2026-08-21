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

  const kept: TraverseNeighbor[] = [];
  // Asymmetry is intentional: a bad request (unknown relation, invalid
  // limit) is refused, but bad stored data is skipped — stored data may
  // predate a type or carry a malformed id, and one bad row must not fail
  // the whole traverse. A targetId that is not a non-blank string, including
  // undefined/null and whitespace-only, is malformed and skipped. Padded ids
  // are NOT trimmed into validity: an id is an exact identity, and guessing
  // the intended target is worse than skipping the row.
  for (const link of input.links) {
    if (!parseNavigateLinkType(link.linkType).ok) continue;
    if (input.relation !== undefined && link.linkType !== input.relation) continue;
    if (typeof link.targetId !== "string" || link.targetId.trim() === "" || link.targetId.trim() !== link.targetId) {
      continue;
    }
    kept.push({ targetId: link.targetId, linkType: link.linkType });
  }

  // Sort BEFORE deduplicating: first-occurrence dedup on an unsorted list
  // lets input order decide which relation survives for a target that is
  // linked under two types, and after the cap is applied, which target is
  // returned at all. Sorting first makes the survivor deterministic
  // (smallest linkType wins the tie).
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
