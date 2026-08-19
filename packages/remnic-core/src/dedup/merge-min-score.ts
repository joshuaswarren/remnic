/**
 * Parse merge-on-write min score (issue #2330 leftover).
 *
 * Finite number in [0, 1] is returned. Outside range or non-finite throws.
 */
export function parseMinMergeScore(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(
      `merge minScore must be a finite number in [0, 1]; got ${JSON.stringify(value)}`,
    );
  }
  return value;
}
