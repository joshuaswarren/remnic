/**
 * Deep-recall one-shot refine gate (issue #2332 leftover).
 *
 * Pure. Surfaces wait. Already refined or budget 0 refuse.
 * Negative budget throws.
 */
export function mayRefine(input: {
  refined: boolean;
  budgetLeft: number;
}): boolean {
  if (input.budgetLeft < 0) {
    throw new Error(
      `deep recall refine budget must not be negative; got ${JSON.stringify(input.budgetLeft)}`,
    );
  }
  if (input.refined) return false;
  if (input.budgetLeft === 0) return false;
  return true;
}
