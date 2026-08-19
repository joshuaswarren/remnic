/**
 * Stable observation-id order for timeline analysis (issue #2050 leftover).
 *
 * Code-unit sort (locale-independent, deterministic across hosts).
 * Empty input → []. Does not mutate input. Drops empty strings.
 */

/** Return a new code-unit-sorted id list. Empty strings are dropped. */
export function sortObservationIds(ids: readonly string[]): string[] {
  return ids.filter((id) => id !== "").sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
