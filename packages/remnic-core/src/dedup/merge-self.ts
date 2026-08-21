/**
 * Merge-self guard (issue #2330 leftover).
 *
 * Same id → self_merge. Empty id throws. Otherwise ok.
 */

export type RejectSelfMergeResult =
  | { ok: true }
  | { ok: false; error: "self_merge" };

export function rejectSelfMerge(aId: string, bId: string): RejectSelfMergeResult {
  if (aId === "" || bId === "") {
    throw new Error("empty merge id");
  }
  if (aId === bId) return { ok: false, error: "self_merge" };
  return { ok: true };
}
