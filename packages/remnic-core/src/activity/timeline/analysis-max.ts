/**
 * Timeline analysis max-batch parse (issue #2050 leftover).
 *
 * Pure. 0 is allowed (empty batches). Negative or non-integer throws.
 * Finite integer ≥ 0 is returned.
 */
export function parseMaxBatch(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw new Error(
      `analysis maxBatch must be a non-negative integer; got ${JSON.stringify(value)}`,
    );
  }
  return value;
}
