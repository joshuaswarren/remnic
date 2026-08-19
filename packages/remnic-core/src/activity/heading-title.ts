/**
 * Parse an ATX heading title (issue #1987 leftover).
 *
 * Trim, then walk 1-6 leading `#` plus one space. Empty title is
 * empty_title. Anything else is not_heading. Walk chars. No regex.
 */

export type ParseAtxHeadingTitleResult =
  | { ok: true; title: string }
  | { ok: false; error: "empty_title" | "not_heading" };

export function parseAtxHeadingTitle(line: string): ParseAtxHeadingTitleResult {
  const trimmed = line.trim();
  let i = 0;
  while (i < trimmed.length && trimmed[i] === "#") {
    i++;
  }
  if (i < 1 || i > 6) return { ok: false, error: "not_heading" };
  if (i < trimmed.length && trimmed[i] !== " ") {
    return { ok: false, error: "not_heading" };
  }
  if (i < trimmed.length) i++;
  const title = trimmed.slice(i);
  if (title.length === 0) return { ok: false, error: "empty_title" };
  return { ok: true, title };
}
