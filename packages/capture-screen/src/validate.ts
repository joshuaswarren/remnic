/**
 * Request-input validation for the HTTP surface. Every failure raises
 * CaptureInputError, which the daemon maps to HTTP 400 — invalid date,
 * timezone, limit, or cursor is rejected loudly, never silently defaulted. The
 * keyset cursor is an opaque base64url token over the (capturedAtUtc, id) tuple
 * the snapshots query orders by, so pagination stays stable across snapshots
 * that share a capture instant.
 */

import { Buffer } from "node:buffer";

import { DEFAULT_SNAPSHOTS_LIMIT, MAX_SNAPSHOTS_LIMIT } from "./constants.js";
import { CaptureInputError } from "./errors.js";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Validate a YYYY-MM-DD calendar date (rejects e.g. 2026-02-30). */
export function parseSnapshotDate(value: string | null | undefined): string {
  if (typeof value !== "string" || !DATE_RE.test(value)) {
    throw new CaptureInputError(`invalid date '${value ?? ""}' — expected YYYY-MM-DD`);
  }
  const [year, month, day] = value.split("-").map(Number);
  const dt = new Date(Date.UTC(year, month - 1, day));
  dt.setUTCFullYear(year);
  if (dt.getUTCFullYear() !== year || dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) {
    throw new CaptureInputError(`invalid date '${value}' — not a real calendar date`);
  }
  return value;
}

/** Validate an IANA timezone by attempting to build a formatter for it. */
export function assertValidTimezone(value: string | null | undefined): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new CaptureInputError("invalid timezone '' — expected an IANA timezone");
  }
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: value });
  } catch {
    throw new CaptureInputError(`invalid timezone '${value}' — not a known IANA timezone`);
  }
  return value;
}

/** Absent limit → default; present-but-invalid → 400. */
export function parseLimit(value: string | null | undefined): number {
  if (value === null || value === undefined) return DEFAULT_SNAPSHOTS_LIMIT;
  const n = Number(value);
  if (value === "" || !Number.isInteger(n) || n < 1 || n > MAX_SNAPSHOTS_LIMIT) {
    throw new CaptureInputError(
      `invalid limit '${value}' — expected an integer between 1 and ${MAX_SNAPSHOTS_LIMIT}`,
    );
  }
  return n;
}

export interface Cursor {
  capturedAtUtc: string;
  id: number;
}

export function encodeCursor(capturedAtUtc: string, id: number): string {
  return Buffer.from(JSON.stringify([capturedAtUtc, id]), "utf8").toString("base64url");
}

/** Absent cursor → null (first page); malformed cursor → 400. */
export function decodeCursor(value: string | null | undefined): Cursor | null {
  if (value === null || value === undefined || value === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new CaptureInputError("invalid cursor — not a recognized pagination token");
  }
  if (
    Array.isArray(parsed) &&
    parsed.length === 2 &&
    typeof parsed[0] === "string" &&
    typeof parsed[1] === "number" &&
    Number.isInteger(parsed[1]) &&
    parsed[1] >= 0 &&
    /^\d{4}-\d{2}-\d{2}T/.test(parsed[0]) &&
    Number.isFinite(Date.parse(parsed[0])) &&
    new Date(parsed[0]).toISOString() === parsed[0]
  ) {
    return { capturedAtUtc: parsed[0], id: parsed[1] };
  }
  throw new CaptureInputError("invalid cursor — not a recognized pagination token");
}
