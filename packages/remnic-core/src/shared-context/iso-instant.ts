/**
 * Strict ISO-8601 instant validation for shared-context envelopes
 * (issue #1957 review round 3).
 *
 * `Date.parse` is permissive: under the supported Node runtime it reads
 * `"2026-02-30"` as March 2 and `"1"` as January 1 2001. A caller-supplied
 * expiry would therefore be silently reinterpreted into a governance deadline
 * the caller never asked for. Validate the ISO shape AND the calendar
 * components against the exact input, and reject rather than normalize.
 *
 * Extracted from `provenance.ts` so the envelope write path and the
 * provenance stamp share one validator instead of two copies.
 */

// Linear ISO instant. No nested quantifiers.
const ISO_INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * True only for a calendar-valid ISO-8601 instant carrying an explicit zone.
 * Non-strings and non-finite parses are rejected explicitly, never coerced.
 */
export function isStrictIsoInstant(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const match = ISO_INSTANT.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const utc = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return (
    Number.isFinite(Date.parse(value)) &&
    utc.getUTCFullYear() === year &&
    utc.getUTCMonth() === month - 1 &&
    utc.getUTCDate() === day &&
    utc.getUTCHours() === hour &&
    utc.getUTCMinutes() === minute &&
    utc.getUTCSeconds() === second
  );
}
