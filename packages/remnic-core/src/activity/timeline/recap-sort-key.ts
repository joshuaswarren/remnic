/**
 * Recap card sort key (issue #2051 leftover).
 *
 * Returns card.id. Missing or empty id throws.
 */
export function recapSortKey(card: { id?: string | null }): string {
  if (card.id == null) {
    throw new Error("missing recap card id");
  }
  if (card.id === "") {
    throw new Error("empty recap card id");
  }
  return card.id;
}
