/**
 * Deep-recall remaining-budget parse (issue #2332 leftover).
 *
 * Pure. Surfaces wait. 0 is allowed. Negative or non-integer throws.
 */
export function parseBudgetLeft(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw new Error(
      `deep recall budget left must be a non-negative integer; got ${JSON.stringify(value)}`,
    );
  }
  return value;
}
