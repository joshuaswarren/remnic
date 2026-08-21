/**
 * Recall state-view superseded-at parse (issue #1952 leftover).
 *
 * Pure. Surfaces wait. Empty is missing_date. Unparseable is invalid_date.
 */

export type ParseSupersededAtResult =
  | { ok: true; supersededAt: string }
  | { ok: false; error: "missing_date" | "invalid_date" };

export function parseSupersededAt(value: string): ParseSupersededAtResult {
  const trimmed = value.trim();
  if (trimmed.length === 0) return { ok: false, error: "missing_date" };
  const parsed = Date.parse(trimmed);
  if (!Number.isFinite(parsed)) return { ok: false, error: "invalid_date" };
  return { ok: true, supersededAt: new Date(parsed).toISOString() };
}
