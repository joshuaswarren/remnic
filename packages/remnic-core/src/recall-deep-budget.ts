/**
 * Deep-recall budget clamp (issue #2332 leftover).
 *
 * Pure. Surfaces wait. 0 stays 0. Positive integers pass through.
 * Negative, non-finite, and non-integer values throw.
 */
export function clampDeepRecallBudget(n: number): number {
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    throw new Error(
      `deep recall budget must be a non-negative integer; got ${JSON.stringify(n)}`,
    );
  }
  return n;
}
