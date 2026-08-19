/**
 * Validate a managed-region name for vault markers (issue #1985).
 *
 * Empty, whitespace-only, newline, and `-->` names are rejected so they
 * cannot break `<!-- remnic:<name>:start -->` markers.
 */

export type ValidateRegionNameResult =
  | { ok: true; name: string }
  | { ok: false; error: "invalid_name" };

export function validateRegionName(name: string): ValidateRegionNameResult {
  if (typeof name !== "string") {
    return { ok: false, error: "invalid_name" };
  }
  if (name.includes("\n") || name.includes("\r") || name.includes("-->")) {
    return { ok: false, error: "invalid_name" };
  }
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: "invalid_name" };
  }
  return { ok: true, name: trimmed };
}
