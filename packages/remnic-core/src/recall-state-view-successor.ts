/**
 * Recall state-view successor-id parse (issue #1952 leftover).
 *
 * Pure. Surfaces wait. Empty is missing_successor. Newline is invalid_successor.
 */

export type ParseSuccessorIdResult =
  | { ok: true; successorId: string }
  | { ok: false; error: "missing_successor" | "invalid_successor" };

export function parseSuccessorId(value: string): ParseSuccessorIdResult {
  const successorId = value.trim();
  if (successorId.length === 0) return { ok: false, error: "missing_successor" };
  if (successorId.includes("\n")) return { ok: false, error: "invalid_successor" };
  return { ok: true, successorId };
}
