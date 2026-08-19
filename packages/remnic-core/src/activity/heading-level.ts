/**
 * Parse an ATX heading level (issue #1987 leftover).
 *
 * Trim, then walk leading `#` chars. 1-6 is a heading. No hashes is
 * not_heading. Seven or more is invalid_level. No regex.
 */

export type ParseAtxHeadingLevelResult =
  | { ok: true; level: number }
  | { ok: false; error: "not_heading" | "invalid_level" };

export function parseAtxHeadingLevel(line: string): ParseAtxHeadingLevelResult {
  const trimmed = line.trim();
  let level = 0;
  while (level < trimmed.length && trimmed[level] === "#") {
    level++;
  }
  if (level === 0) return { ok: false, error: "not_heading" };
  if (level > 6) return { ok: false, error: "invalid_level" };
  return { ok: true, level };
}
