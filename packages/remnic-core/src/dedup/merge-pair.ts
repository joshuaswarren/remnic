/**
 * Merge-pair id orderer (issue #2330 leftover).
 *
 * Returns [lower, higher] by localeCompare. Same id returns [id, id].
 * Empty id throws.
 */

export function orderMergePair(aId: string, bId: string): [string, string] {
  if (aId === "" || bId === "") {
    throw new Error("empty merge id");
  }
  return aId.localeCompare(bId) <= 0 ? [aId, bId] : [bId, aId];
}
