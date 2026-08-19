/**
 * Deep-recall step-count parse (issue #2332 leftover).
 *
 * Pure. Surfaces wait. 0 is allowed. Negative or non-integer throws.
 */
export function parseStepCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw new Error(
      `deep recall step count must be a non-negative integer; got ${JSON.stringify(value)}`,
    );
  }
  return value;
}
