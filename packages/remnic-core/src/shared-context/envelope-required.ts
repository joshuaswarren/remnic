/**
 * Shared-item envelope required-actor parse (issue #1957 leftover).
 *
 * Pure. Empty is allowed (no requirement). Newline is invalid_required.
 */

export type ParseRequiredActorResult =
  | { ok: true; required: string }
  | { ok: false; error: "invalid_required" };

export function parseRequiredActor(value: string): ParseRequiredActorResult {
  const required = value.trim();
  if (required.includes("\n")) return { ok: false, error: "invalid_required" };
  return { ok: true, required };
}
