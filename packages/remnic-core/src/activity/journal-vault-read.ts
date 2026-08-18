/**
 * Read-only vault daily-note journal section (issue #1987 first slice).
 *
 * Pure: file text in, journal body out. Never writes. Strips Remnic-owned
 * marker regions and publisher-owned headings so published timeline text
 * cannot re-enter the journal. Path templates stay in vault-publish.
 */

export interface ReadVaultJournalInput {
  fileText: string | null | undefined;
  journalSection: string;
  publishSectionNames?: readonly string[];
}

export type ReadVaultJournalResult =
  | { ok: true; exists: false; reason: "missing_file" | "missing_heading" }
  | { ok: true; exists: true; text: string; heading: string; warnings: readonly string[] }
  | { ok: false; reason: "duplicate_heading"; lines: readonly number[] };

const REMNIC_OPEN = "<!-- remnic:";

export function readVaultJournal(input: ReadVaultJournalInput): ReadVaultJournalResult {
  if (input.fileText === null || input.fileText === undefined) {
    return { ok: true, exists: false, reason: "missing_file" };
  }
  if (input.journalSection.length === 0) {
    return { ok: true, exists: false, reason: "missing_heading" };
  }

  const lines = splitFileLines(input.fileText);
  const hits: number[] = [];
  const levels: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const heading = parseAtxHeading(lines[i]!);
    if (heading && heading.text === input.journalSection) {
      hits.push(i + 1);
      levels.push(heading.level);
    }
  }
  if (hits.length === 0) return { ok: true, exists: false, reason: "missing_heading" };
  if (hits.length > 1) return { ok: false, reason: "duplicate_heading", lines: hits };

  const headingIndex = hits[0]! - 1;
  const level = levels[0]!;
  let endIndex = lines.length;
  for (let i = headingIndex + 1; i < lines.length; i++) {
    const heading = parseAtxHeading(lines[i]!);
    if (heading && heading.level <= level) {
      endIndex = i;
      break;
    }
  }

  const body = lines.slice(headingIndex + 1, endIndex).join("\n");
  const stripped = stripRemnicOwnedRegions(body, input.publishSectionNames ?? []);
  return {
    ok: true,
    exists: true,
    text: trimNewlines(stripped.text),
    heading: input.journalSection,
    warnings: stripped.warnings,
  };
}

/** Remove Remnic marker pairs and publisher-owned heading sections. */
export function stripRemnicOwnedRegions(
  text: string,
  publishSectionNames: readonly string[] = [],
): { text: string; warnings: readonly string[] } {
  const marked = cutIntervals(text, remnicIntervals(text));
  return {
    text: stripPublishHeadings(marked.text, publishSectionNames),
    warnings: marked.warnings,
  };
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

function remnicIntervals(text: string): {
  intervals: Array<{ start: number; end: number }>;
  warnings: string[];
} {
  const starts: Array<{ name: string; start: number; after: number }> = [];
  const ends: Array<{ name: string; start: number; end: number }> = [];

  let from = 0;
  while (from < text.length) {
    const open = text.indexOf(REMNIC_OPEN, from);
    if (open === -1) break;
    const afterOpen = open + REMNIC_OPEN.length;
    const commentEnd = text.indexOf("-->", afterOpen);
    if (commentEnd === -1) break;
    const inner = text.slice(afterOpen, commentEnd).trim();
    if (inner.endsWith(":start")) {
      const name = inner.slice(0, -":start".length);
      if (name.length > 0) starts.push({ name, start: open, after: commentEnd + 3 });
    } else if (inner.endsWith(":end")) {
      const name = inner.slice(0, -":end".length);
      if (name.length > 0) ends.push({ name, start: open, end: commentEnd + 3 });
    }
    from = commentEnd + 3;
  }

  const usedEnds = new Set<number>();
  const intervals: Array<{ start: number; end: number }> = [];
  const warnings: string[] = [];

  for (const start of starts) {
    const match = ends.find((end) => end.name === start.name && end.start >= start.after && !usedEnds.has(end.start));
    if (match) {
      usedEnds.add(match.start);
      intervals.push({ start: start.start, end: eatTrailingNewline(text, match.end) });
    } else {
      intervals.push({ start: start.start, end: text.length });
      warnings.push(`unclosed remnic region "${start.name}"`);
    }
  }

  for (const end of ends) {
    if (usedEnds.has(end.start)) continue;
    const startBefore = starts.some((start) => start.start < end.start);
    if (!startBefore) intervals.push({ start: 0, end: eatTrailingNewline(text, end.end) });
  }

  return { intervals: mergeIntervals(intervals), warnings };
}

function eatTrailingNewline(text: string, index: number): number {
  if (text[index] === "\n") return index + 1;
  if (text[index] === "\r" && text[index + 1] === "\n") return index + 2;
  if (text[index] === "\r") return index + 1;
  return index;
}

function mergeIntervals(items: Array<{ start: number; end: number }>): Array<{ start: number; end: number }> {
  if (items.length === 0) return [];
  const sorted = items.slice().sort((a, b) => a.start - b.start || a.end - b.end);
  const out = [{ start: sorted[0]!.start, end: sorted[0]!.end }];
  for (let i = 1; i < sorted.length; i++) {
    const cur = sorted[i]!;
    const last = out[out.length - 1]!;
    if (cur.start <= last.end) last.end = Math.max(last.end, cur.end);
    else out.push({ start: cur.start, end: cur.end });
  }
  return out;
}

function cutIntervals(
  text: string,
  found: { intervals: Array<{ start: number; end: number }>; warnings: string[] },
): { text: string; warnings: string[] } {
  let out = "";
  let pos = 0;
  for (const interval of found.intervals) {
    if (interval.start > pos) out += text.slice(pos, interval.start);
    pos = Math.max(pos, interval.end);
  }
  if (pos < text.length) out += text.slice(pos);
  return { text: out, warnings: found.warnings };
}

function stripPublishHeadings(text: string, names: readonly string[]): string {
  if (names.length === 0 || text.length === 0) return text;
  const lines = text.split("\n");
  const keep = lines.map(() => true);
  for (let i = 0; i < lines.length; i++) {
    if (!keep[i]) continue;
    const heading = parseAtxHeading(lines[i]!);
    if (!heading || !names.includes(heading.text)) continue;
    keep[i] = false;
    for (let j = i + 1; j < lines.length; j++) {
      const next = parseAtxHeading(lines[j]!);
      if (next && next.level <= heading.level) break;
      keep[j] = false;
    }
  }
  return lines.filter((_, i) => keep[i]).join("\n");
}

function trimNewlines(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && (text[start] === "\n" || text[start] === "\r")) start++;
  while (end > start && (text[end - 1] === "\n" || text[end - 1] === "\r")) end--;
  return text.slice(start, end);
}
