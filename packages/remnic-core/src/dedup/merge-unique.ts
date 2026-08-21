/**
 * Unique merge-id list (issue #2330 leftover).
 *
 * Drops empty strings, dedupes, sorts with localeCompare. Does not mutate input.
 */

export function uniqueMergeIds(ids: readonly string[]): string[] {
  const unique = new Set<string>();
  for (const id of ids) {
    if (id !== "") unique.add(id);
  }
  return [...unique].sort((a, b) => a.localeCompare(b));
}
