/**
 * Timeline analysis overlap parse (issue #2050 leftover).
 *
 * Pure. 0 is allowed. Negative or non-integer throws.
 * When maxBatch > 0, overlap must be less than maxBatch.
 */
export function parseOverlap(value: unknown, maxBatch: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw new RangeError(
      `analysis overlap must be a non-negative integer; got ${JSON.stringify(value)}`,
    );
  }
  if (maxBatch > 0 && value >= maxBatch) {
    throw new RangeError(`analysis overlap must be less than maxBatch; got ${value} >= ${maxBatch}`);
  }
  return value;
}
