/**
 * Parse a YYYY-MM-DD week date (issue #2052 leftover).
 *
 * Trim first. Empty → missing_date. Bounded YYYY-MM-DD only (no ReDoS).
 */

export type IsoDateResult =
  | { ok: true; date: string }
  | { ok: false; error: "missing_date" | "invalid_date" };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Trim and accept YYYY-MM-DD, or return a typed error. */
export function parseIsoDate(value: string): IsoDateResult {
  const date = value.trim();
  if (date.length === 0) return { ok: false, error: "missing_date" };
  if (!ISO_DATE.test(date)) return { ok: false, error: "invalid_date" };
  return { ok: true, date };
}
