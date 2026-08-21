/**
 * Normalize a recap timezone string (issue #2051 leftover).
 *
 * Trim first. Empty → missing_timezone. Bounded charset only (no ReDoS).
 */

export type RecapTimezoneResult =
  | { ok: true; timezone: string }
  | { ok: false; error: "missing_timezone" | "invalid_timezone" };

const RECAP_TIMEZONE = /^[A-Za-z0-9_+/-]{1,64}$/;

/** Trim and accept an IANA-shaped timezone, or return a typed error. */
export function normalizeRecapTimezone(value: string): RecapTimezoneResult {
  const timezone = value.trim();
  if (timezone.length === 0) return { ok: false, error: "missing_timezone" };
  if (!RECAP_TIMEZONE.test(timezone)) return { ok: false, error: "invalid_timezone" };
  return { ok: true, timezone };
}
