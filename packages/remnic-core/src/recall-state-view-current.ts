/**
 * Recall state-view current-has-no-successor guard (issue #1952 leftover).
 *
 * Pure. Surfaces wait. Current plus a successor is current_has_successor.
 */

export type AssertCurrentHasNoSuccessorInput = {
  kind: string;
  successorId?: string;
};

export type AssertCurrentHasNoSuccessorResult =
  | { ok: true }
  | { ok: false; error: "current_has_successor" };

export function assertCurrentHasNoSuccessor(
  input: AssertCurrentHasNoSuccessorInput,
): AssertCurrentHasNoSuccessorResult {
  const successorId = input.successorId?.trim() ?? "";
  if (input.kind === "current" && successorId.length > 0) {
    return { ok: false, error: "current_has_successor" };
  }
  return { ok: true };
}
