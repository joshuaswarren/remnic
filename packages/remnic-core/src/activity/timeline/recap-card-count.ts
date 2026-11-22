
export function countRecapCards(cards: readonly string[]): number {
  const unique = new Set<string>();
  for (const id of cards) {
    if (id !== "") unique.add(id);
  }
  return unique.size;
}
