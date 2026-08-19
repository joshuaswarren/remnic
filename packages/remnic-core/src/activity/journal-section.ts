/**
 * Extract a unique ATX heading section (issue #1987).
 *
 * Pure string helper. No filesystem. Missing heading returns null.
 * Duplicate headings refuse. Empty headings are rejected.
 */

export type ExtractJournalSectionResult =
  | string
  | null
  | { error: "duplicate_heading" }
  | { error: "empty_heading" };

export function extractJournalSection(
  markdown: string,
  heading: string,
): ExtractJournalSectionResult {
  const wanted = heading.trim();
  if (wanted.length === 0) return { error: "empty_heading" };

  const lines = splitFileLines(markdown);
  const hits: number[] = [];
  const levels: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const parsed = parseAtxHeading(lines[i]!);
    if (parsed && parsed.text === wanted) {
      hits.push(i);
      levels.push(parsed.level);
    }
  }
  if (hits.length === 0) return null;
  if (hits.length > 1) return { error: "duplicate_heading" };

  const headingIndex = hits[0]!;
  const level = levels[0]!;
  let endIndex = lines.length;
  for (let i = headingIndex + 1; i < lines.length; i++) {
    const parsed = parseAtxHeading(lines[i]!);
    if (parsed && parsed.level <= level) {
      endIndex = i;
      break;
    }
  }
  return lines.slice(headingIndex + 1, endIndex).join("\n");
}

function splitFileLines(fileText: string): string[] {
  const lines = fileText.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.endsWith("\r")) lines[i] = line.slice(0, -1);
  }
  return lines;
}

function parseAtxHeading(line: string): { level: number; text: string } | null {
  let level = 0;
  while (level < line.length && level < 6 && line[level] === "#") level++;
  if (level === 0) return null;
  const after = line[level];
  if (after !== " " && after !== "\t") return null;

  let start = level + 1;
  let end = line.length;
  while (start < end && (line[start] === " " || line[start] === "\t")) start++;
  while (end > start && (line[end - 1] === " " || line[end - 1] === "\t")) end--;

  let hashEnd = end;
  while (hashEnd > start && line[hashEnd - 1] === "#") hashEnd--;
  if (hashEnd < end && hashEnd > start && (line[hashEnd - 1] === " " || line[hashEnd - 1] === "\t")) {
    end = hashEnd;
    while (end > start && (line[end - 1] === " " || line[end - 1] === "\t")) end--;
  }
  return { level, text: line.slice(start, end) };
}
