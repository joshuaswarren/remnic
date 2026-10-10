export type CarriedMemorySnippet = {
  memorySnippets: string[];
  memorySnippetOrigins?: Array<string | undefined>;
};

/**
 * Copy snippets from the previous index onto entities that already existed.
 * A canonical id with nothing to copy was created after that index, so any
 * memory that already pointed at it was skipped. The caller schedules one
 * full reconcile for that case.
 */
export function applyCarriedMemorySnippets(
  entities: Iterable<{
    canonicalId: string;
    memorySnippets: string[];
    memorySnippetOrigins?: Array<string | undefined>;
  }>,
  carried: ReadonlyMap<string, CarriedMemorySnippet>,
): boolean {
  let missing = false;
  for (const entry of entities) {
    const previous = carried.get(entry.canonicalId);
    if (!previous) {
      missing = true;
      continue;
    }
    entry.memorySnippets = previous.memorySnippets.slice();
    if (previous.memorySnippetOrigins) entry.memorySnippetOrigins = previous.memorySnippetOrigins.slice();
  }
  return missing;
}
