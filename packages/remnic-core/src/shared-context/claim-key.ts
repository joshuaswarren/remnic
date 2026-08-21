/**
 * Shared-context claim key parse (issue #1957 leftover).
 *
 * Pure. Empty is missing_key. Newline is invalid_key.
 */

export type ParseClaimKeyResult =
  | { ok: true; key: string }
  | { ok: false; error: "missing_key" | "invalid_key" };

export function parseClaimKey(value: string): ParseClaimKeyResult {
  const key = value.trim();
  if (key.length === 0) return { ok: false, error: "missing_key" };
  if (key.includes("\n")) return { ok: false, error: "invalid_key" };
  return { ok: true, key };
}
