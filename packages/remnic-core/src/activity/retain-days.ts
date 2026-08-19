/**
 * Parse activity retain-days (issue #2053 leftover).
 *
 * `0` keeps forever. Finite integer ≥ 0 is returned.
 * Negative and non-integer values throw.
 */
export function parseRetainDays(value: number): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw new RangeError(
      `activity.retainDays must be a non-negative integer; got ${JSON.stringify(value)}`,
    );
  }
  return value;
}
