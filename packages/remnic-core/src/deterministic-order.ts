export function compareDeterministicStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export function mergeSortedUniqueStrings(...collections: Array<Iterable<string> | undefined>): string[] {
  const values = new Set<string>();
  for (const collection of collections) {
    if (!collection) continue;
    for (const value of collection) values.add(value);
  }
  return [...values].sort(compareDeterministicStrings);
}
