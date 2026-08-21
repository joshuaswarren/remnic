/**
 * Remaining envelope TTL in milliseconds (issue #1957).
 *
 * Missing expiresAt means no expiry. Half-open: nowMs >= expiresAt is 0.
 * Invalid expiresAt throws.
 */

export interface RemainingTtlMsInput {
  expiresAt?: string | number;
  nowMs: number;
}

export function remainingTtlMs(input: RemainingTtlMsInput): number | null {
  if (input.expiresAt === undefined) return null;
  const expiresAtMs = parseExpiresAt(input.expiresAt);
  if (input.nowMs >= expiresAtMs) return 0;
  return expiresAtMs - input.nowMs;
}

function parseExpiresAt(expiresAt: string | number): number {
  if (typeof expiresAt === "number") {
    if (!Number.isFinite(expiresAt)) {
      throw new Error("remainingTtlMs: expiresAt must be a valid timestamp");
    }
    return expiresAt;
  }
  if (typeof expiresAt !== "string" || expiresAt.trim().length === 0) {
    throw new Error("remainingTtlMs: expiresAt must be a valid timestamp");
  }
  const expiresAtMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresAtMs)) {
    throw new Error("remainingTtlMs: expiresAt must be a valid timestamp");
  }
  return expiresAtMs;
}
