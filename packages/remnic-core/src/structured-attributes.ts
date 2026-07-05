/**
 * Shared helpers for the `\n[Attributes: …]` enrichment suffix that
 * `writeMemory` appends to a stored body when `structuredAttributes` are
 * present.
 *
 * Extracted here (out of `storage.ts`) so every reader — the storage
 * manager, the wearable service, and the coding surfaces — strips the suffix
 * with ONE definition. Previously `coding/architecture-surfaces.ts` carried a
 * weaker local copy that only checked the trailing `]`, which could truncate
 * card markdown that legitimately ends in a `[Attributes: …]` line (cursor
 * review: duplicate attribute suffix stripper).
 *
 * String operations, not regex — CodeQL `js/polynomial-redos` flags
 * suffix-anchored patterns over library-supplied content.
 */

/**
 * Remove the `[Attributes: …]` suffix `writeMemory` appends to the stored
 * body when structuredAttributes are present, yielding the raw fact/card text
 * for content comparison or client display. Inverse companion of
 * `normalizeAttributePairs` enrichment in `storage.ts`.
 *
 * Returns the stripped (trimmed) body when the marker opens the final
 * non-empty line and its inner payload contains no premature `]` or newline
 * (mirrors the exact shape `normalizeAttributePairs` emits). Otherwise
 * returns the trimmed input unchanged — never truncates legitimate content.
 */
export function stripAttributesSuffix(content: string): string {
  const trimmed = content.trimEnd();
  if (!trimmed.endsWith("]")) return content.trim();
  const marker = "\n[Attributes: ";
  const markerIndex = trimmed.lastIndexOf(marker);
  if (markerIndex === -1) return content.trim();
  // The block must be the FINAL line and contain no "]" before the
  // closing bracket (mirrors the shape normalizeAttributePairs emits).
  const inner = trimmed.slice(markerIndex + marker.length, -1);
  if (inner.includes("]") || inner.includes("\n")) return content.trim();
  return trimmed.slice(0, markerIndex).trim();
}
