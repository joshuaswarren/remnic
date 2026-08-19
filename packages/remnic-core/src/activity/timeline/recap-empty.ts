/**
 * Empty-set guard for timeline recap cards (issue #2051 leftover).
 *
 * null, undefined, and [] are empty. A non-array throws. Any other array is not empty.
 */

/** True when the recap card list is absent or has no items. */
export function isEmptyRecapCards(cards: unknown): boolean {
  if (cards == null) return true;
  if (!Array.isArray(cards)) {
    throw new TypeError("cards must be an array");
  }
  return cards.length === 0;
}
