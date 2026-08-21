/**
 * Validate a managed-region name for vault markers (issue #1985).
 *
 * Empty, whitespace-only, newline, and `-->` names are rejected so they
 * cannot break `<!-- remnic:<name>:start -->` markers. `:` is rejected
 * too: the marker grammar is colon-delimited, so a colon-bearing name
 * makes a marker line ambiguous (`remnic:A:B:start` reads as name `A:B`
 * or as name `A` with a `B:start` suffix) and a publisher that resolved
 * that ambiguity differently from the note's own markers would pair a
 * start with a later end and delete the user bytes in between.
 */

export type ValidateRegionNameResult =
  | { ok: true; name: string }
  | { ok: false; error: "invalid_name" };

export function validateRegionName(name: string): ValidateRegionNameResult {
  if (typeof name !== "string") {
    return { ok: false, error: "invalid_name" };
  }
  if (name.includes("\n") || name.includes("\r") || name.includes("-->") || name.includes(":")) {
    return { ok: false, error: "invalid_name" };
  }
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: "invalid_name" };
  }
  return { ok: true, name: trimmed };
}
