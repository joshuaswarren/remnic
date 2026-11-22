/**
 * First-seen observation-id dedupe for timeline analysis (issue #2050 leftover).
 *
 * Insertion order. Empty input → []. Does not mutate input. Drops empty strings.
 */

export function dedupeObservationIds(ids: readonly string[]): string[] {
  return [...new Set(ids.filter((id) => id !== ""))];
}
