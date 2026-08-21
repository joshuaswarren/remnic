/**
 * Merge-id empty-set guard (issue #2330 leftover).
 *
 * Empty list → empty_set. Any empty string → empty_id.
 * Otherwise returns the same ids in order. Does not mutate input.
 */

export type RejectEmptyMergeIdsResult =
  | { ok: true; ids: readonly string[] }
  | { ok: false; error: "empty_set" | "empty_id" };

export function rejectEmptyMergeIds(ids: readonly string[]): RejectEmptyMergeIdsResult {
  if (ids.length === 0) return { ok: false, error: "empty_set" };
  for (const id of ids) {
    if (id === "") return { ok: false, error: "empty_id" };
  }
  return { ok: true, ids };
}
