/**
 * Stable observation-id order for timeline analysis (issue #2050 leftover).
 *
 * localeCompare sort. Empty input → []. Does not mutate input. Drops empty strings.
 */

/** Return a new localeCompare-sorted id list. Empty strings are dropped. */
export function sortObservationIds(ids: readonly string[]): string[] {
  return ids.filter((id) => id !== "").sort((a, b) => a.localeCompare(b));
}
