/**
 * Recap card counter (issue #2051 leftover).
 *
 * Unique ids after dropping empty strings. Does not mutate input.
 */

export function countRecapCards(cards: readonly string[]): number {
  const unique = new Set<string>();
  for (const id of cards) {
    if (id !== "") unique.add(id);
  }
  return unique.size;
}
