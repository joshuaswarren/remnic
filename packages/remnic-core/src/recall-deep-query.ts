/**
 * Parse a deep-recall query (issue #2332 leftover).
 *
 * Pure. Surfaces wait. Trim. Empty is empty_query.
 */

export type ParseDeepQueryResult =
  | { ok: true; query: string }
  | { ok: false; error: "empty_query" };

export function parseDeepQuery(value: string): ParseDeepQueryResult {
  const query = value.trim();
  if (query.length === 0) return { ok: false, error: "empty_query" };
  return { ok: true, query };
}
