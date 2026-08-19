/**
 * Parse a recap local-day string (issue #2051 leftover).
 *
 * Trim first. Empty → missing_date. Bounded YYYY-MM-DD only (no ReDoS).
 */

export type RecapDateResult =
  | { ok: true; date: string }
  | { ok: false; error: "missing_date" | "invalid_date" };

const RECAP_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Trim and accept YYYY-MM-DD, or return a typed error. */
export function parseRecapDate(value: string): RecapDateResult {
  const date = value.trim();
  if (date.length === 0) return { ok: false, error: "missing_date" };
  if (!RECAP_DATE.test(date)) return { ok: false, error: "invalid_date" };
  return { ok: true, date };
}
