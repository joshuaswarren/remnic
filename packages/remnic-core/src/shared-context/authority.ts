/**
 * Shared-item actor authority (issue #1957).
 *
 * Pure helper. Empty required means no gate. Missing actor always fails.
 */

export type AuthorityCheckError = "missing_actor" | "forbidden";

export type AuthorityCheck =
  | { ok: true }
  | { ok: false; error: AuthorityCheckError };

export interface CheckAuthorityInput {
  actor?: string;
  required?: string;
}

export function checkAuthority(input: CheckAuthorityInput): AuthorityCheck {
  const actor = input.actor?.trim() ?? "";
  if (actor.length === 0) return { ok: false, error: "missing_actor" };
  const required = input.required?.trim() ?? "";
  if (required.length === 0) return { ok: true };
  if (actor !== required) return { ok: false, error: "forbidden" };
  return { ok: true };
}
