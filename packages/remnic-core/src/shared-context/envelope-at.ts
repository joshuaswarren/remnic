/**
 * Shared-item envelope at parse (issue #1957 leftover).
 *
 * Pure. Empty is missing_at. Invalid Date.parse is invalid_at.
 */

export type ParseEnvelopeAtResult =
  | { ok: true; at: string }
  | { ok: false; error: "missing_at" | "invalid_at" };

export function parseEnvelopeAt(value: string): ParseEnvelopeAtResult {
  const raw = value.trim();
  if (raw.length === 0) return { ok: false, error: "missing_at" };
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return { ok: false, error: "invalid_at" };
  return { ok: true, at: new Date(ms).toISOString() };
}
