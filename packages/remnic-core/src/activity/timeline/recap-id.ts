
export function sortRecapCardIds(ids: readonly string[]): string[] {
  return ids.filter((id) => id !== "").sort((a, b) => a.localeCompare(b));
}
