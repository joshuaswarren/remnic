
export function isEmptyRecapCards(cards: unknown): boolean {
  if (cards == null) return true;
  if (!Array.isArray(cards)) {
    throw new TypeError("cards must be an array");
  }
  return cards.length === 0;
}
