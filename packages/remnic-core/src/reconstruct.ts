/**
 * Memory reconstruction (E-Mem-inspired).
 *
 * Scans recalled memories for entity references that lack context
 * in the recall set, then identifies candidates for targeted retrieval.
 */

/**
 * Find entity names mentioned in recalled snippets that are known entities
 * but not represented in the recalled entity refs.
 *
 * Uses word-boundary matching to avoid false positives from substring overlap
 * (e.g., "person-alice" inside "person-alice-chen").
 */
export function findUnresolvedEntityRefs(
  recalledSnippets: string[],
  recalledEntityRefs: string[],
  knownEntities: string[],
): string[] {
  const refSet = new Set(recalledEntityRefs.map((r) => r.toLowerCase()));
  const combinedText = recalledSnippets.join(" ").toLowerCase();

  // Sort entities longest-first so longer names are matched before shorter prefixes
  const sorted = [...knownEntities].sort((a, b) => b.length - a.length);
  const matched = new Set<string>();
  const unresolved: string[] = [];

  for (const entity of sorted) {
    const lower = entity.toLowerCase();
    if (refSet.has(lower)) continue; // already covered

    // Use word-boundary regex to avoid substring false positives
    const escaped = lower.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`(?:^|[\\s,;:'"(\\[])${escaped}(?:$|[\\s,;:'".)\\]])`, "i");
    if (pattern.test(combinedText) && !matched.has(lower)) {
      unresolved.push(entity);
      matched.add(lower);
    }
  }
  return unresolved;
}
