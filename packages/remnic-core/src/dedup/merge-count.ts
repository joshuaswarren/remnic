/**
 * Merge-candidate counter (issue #2330 leftover).
 *
 * Unique ids after dropping empty strings. Does not mutate input.
 */

export function countMergeCandidates(ids: readonly string[]): number {
  const unique = new Set<string>();
  for (const id of ids) {
    if (id !== "") unique.add(id);
  }
  return unique.size;
}
