/**
 * Normalize a journal section heading (issue #1987 leftover).
 *
 * Trim. Empty is empty_heading. Newline is invalid_heading.
 */

export type NormalizeJournalHeadingResult =
  | { ok: true; heading: string }
  | { ok: false; error: "empty_heading" | "invalid_heading" };

export function normalizeJournalHeading(value: string): NormalizeJournalHeadingResult {
  const heading = value.trim();
  if (heading.length === 0) return { ok: false, error: "empty_heading" };
  if (heading.includes("\n") || heading.includes("\r")) {
    return { ok: false, error: "invalid_heading" };
  }
  return { ok: true, heading };
}
