/**
 * Recall state-view transition-has-successor guard (issue #1952 leftover).
 *
 * Pure. Surfaces wait. Transition without a successor is transition_missing_successor.
 */

export type AssertTransitionHasSuccessorInput = {
  kind: string;
  successorId?: string;
};

export type AssertTransitionHasSuccessorResult =
  | { ok: true }
  | { ok: false; error: "transition_missing_successor" };

export function assertTransitionHasSuccessor(
  input: AssertTransitionHasSuccessorInput,
): AssertTransitionHasSuccessorResult {
  const successorId = input.successorId?.trim() ?? "";
  if (input.kind === "transition" && successorId.length === 0) {
    return { ok: false, error: "transition_missing_successor" };
  }
  return { ok: true };
}
