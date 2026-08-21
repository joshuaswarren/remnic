/**
 * Stable recap card-id order (issue #2051 leftover).
 *
 * localeCompare sort. Empty input → []. Does not mutate input. Drops empty strings.
 */

/** Return a new localeCompare-sorted id list. Empty strings are dropped. */
export function sortRecapCardIds(ids: readonly string[]): string[] {
  return ids.filter((id) => id !== "").sort((a, b) => a.localeCompare(b));
}
