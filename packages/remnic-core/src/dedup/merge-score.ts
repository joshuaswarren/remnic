/**
 * Merge-score comparator (issue #2330 leftover).
 *
 * Higher score wins. NaN or non-finite scores throw.
 */

export function compareMergeScore(a: number, b: number): -1 | 0 | 1 {
  if (!Number.isFinite(a) || !Number.isFinite(b)) {
    throw new Error(`invalid merge score: ${a}, ${b}`);
  }
  if (a > b) return 1;
  if (a < b) return -1;
  return 0;
}
