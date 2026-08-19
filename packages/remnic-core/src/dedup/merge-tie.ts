/**
 * Merge-tie breaker (issue #2330 leftover).
 *
 * Returns the lower id by localeCompare. Same id returns aId.
 * Empty id throws.
 */

export function breakMergeTie(aId: string, bId: string): string {
  if (aId === "" || bId === "") {
    throw new Error("empty merge id");
  }
  return aId.localeCompare(bId) <= 0 ? aId : bId;
}
