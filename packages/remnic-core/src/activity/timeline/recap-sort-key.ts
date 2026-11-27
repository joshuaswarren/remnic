export function recapSortKey(card: { id?: string | null }): string {
  if (card.id == null) {
    throw new Error("missing recap card id");
  }
  if (card.id === "") {
    throw new Error("empty recap card id");
  }
  return card.id;
}
