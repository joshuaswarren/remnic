/**
 * Census field acceptance shared by offline-sync and the reconcile planner
 * (issue #2477). Both surfaces parse untrusted peer censuses and must accept
 * and reject exactly the same values; when these checks lived as two copies
 * they could drift silently and break convergence. Each surface keeps only a
 * thin wrapper that picks its own error type and message.
 */

/** 64-character sha256 hex, either case; the canonical stored form is lowercase. */
export const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/i;

/** Largest `mtimeMs` a census may carry: `new Date(ms)` must stay a valid Date. */
export const CENSUS_MAX_MTIME_MS = 8_640_000_000_000_000;

export function isSha256Hex(value: unknown): value is string {
  return typeof value === "string" && SHA256_HEX_PATTERN.test(value);
}

/**
 * Fractional values are valid: `fs.stat()` reports sub-millisecond mtimes on
 * common filesystems, so this deliberately does not require an integer.
 */
export function isCensusMtimeMs(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= CENSUS_MAX_MTIME_MS;
}
