/**
 * Merge-id duplicate detector (issue #2330 leftover).
 *
 * True if any non-empty id appears twice. Empty strings are ignored.
 * Does not mutate the input list.
 */

export function hasDuplicateMergeIds(ids: readonly string[]): boolean {
  const seen = new Set<string>();
  for (const id of ids) {
    if (id === "") continue;
    if (seen.has(id)) return true;
    seen.add(id);
  }
  return false;
}
