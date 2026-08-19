/**
 * Normalize activity privacy drop keys (issue #2053).
 *
 * Trim, drop empty, unique, localeCompare sort.
 * Does not mutate the input list.
 */

export function normalizeDropKeys(keys: readonly string[]): string[] {
  const unique = [...new Set(keys.map((key) => key.trim()).filter((key) => key.length > 0))];
  unique.sort((a, b) => a.localeCompare(b));
  return unique;
}
