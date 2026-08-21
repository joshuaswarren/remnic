/**
 * Shared-item envelope at parse (issue #1957 leftover).
 *
 * Pure. Blank is missing_at. Anything that is not a calendar-valid ISO-8601
 * instant is invalid_at — including values permissive `Date.parse` would
 * silently reinterpret (`"2026-02-30"` -> March 2, `"1"` -> January 1 2001),
 * a whitespace-padded timestamp, and any non-string or non-finite input
 * (review round 3). `trim()` only detects blankness; validation reads the
 * exact value, so normalization can never widen what passes.
 */

import { isStrictIsoInstant } from "./iso-instant.js";

export type ParseEnvelopeAtResult =
  | { ok: true; at: string }
  | { ok: false; error: "missing_at" | "invalid_at" };

export function parseEnvelopeAt(value: string): ParseEnvelopeAtResult {
  if (typeof value !== "string") return { ok: false, error: "invalid_at" };
  if (value.trim().length === 0) return { ok: false, error: "missing_at" };
  if (!isStrictIsoInstant(value)) return { ok: false, error: "invalid_at" };
  return { ok: true, at: new Date(Date.parse(value)).toISOString() };
}
