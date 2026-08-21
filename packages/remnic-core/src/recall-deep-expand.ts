/**
 * Deep-recall one-shot expand gate (issue #2332 leftover).
 *
 * Pure. Surfaces wait. Already expanded or budget 0 refuse.
 * Negative budget throws.
 */
export function mayExpandOnce(input: {
  alreadyExpanded: boolean;
  budgetLeft: number;
}): boolean {
  if (input.budgetLeft < 0) {
    throw new Error(
      `deep recall expand budget must not be negative; got ${JSON.stringify(input.budgetLeft)}`,
    );
  }
  if (input.alreadyExpanded) return false;
  if (input.budgetLeft === 0) return false;
  return true;
}
