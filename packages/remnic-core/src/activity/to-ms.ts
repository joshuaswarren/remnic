/**
 * Parse activity window toMs (issue #2053 leftover).
 *
 * Finite number ≥ 0 is returned. Negative, NaN, and non-number values throw.
 */
export function parseToMs(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new RangeError(
      `activity.toMs must be a finite non-negative number; got ${JSON.stringify(value)}`,
    );
  }
  return value;
}
