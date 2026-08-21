/**
 * Parse a YYYY-MM-DD week date (issue #2052 leftover).
 *
 * Trim first. Empty → missing_date. Real YYYY-MM-DD calendar days only
 * (no ReDoS, no impossible dates like 2026-02-30).
 */

import { isValidActivityDate } from "../digest.js";

export type IsoDateResult =
  | { ok: true; date: string }
  | { ok: false; error: "missing_date" | "invalid_date" };

/** Trim and accept a real YYYY-MM-DD calendar day, or return a typed error. */
export function parseIsoDate(value: string): IsoDateResult {
  const date = value.trim();
  if (date.length === 0) return { ok: false, error: "missing_date" };
  if (!isValidActivityDate(date)) return { ok: false, error: "invalid_date" };
  return { ok: true, date };
}
