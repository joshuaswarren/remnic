/**
 * Parse a recap card id (issue #2051 leftover).
 *
 * Pure. Empty is missing_id. Newline is invalid_id.
 */

export type ParseRecapCardIdResult =
  | { ok: true; id: string }
  | { ok: false; error: "missing_id" | "invalid_id" };

export function parseRecapCardId(value: string): ParseRecapCardIdResult {
  const id = value.trim();
  if (id.length === 0) return { ok: false, error: "missing_id" };
  if (id.includes("\n")) return { ok: false, error: "invalid_id" };
  return { ok: true, id };
}
