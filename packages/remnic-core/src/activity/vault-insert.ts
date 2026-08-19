/**
 * Managed-region marker insertion (issue #1985).
 *
 * Inserts a `<!-- remnic:<name>:start/end -->` pair under a unique ATX
 * heading when the region is absent. This helper never replaces (see
 * `vault-publish.ts`), never creates files, and never invents a heading.
 * Pure string-in/string-out.
 */

export type InsertVaultRegionResult =
  | { ok: true; text: string; inserted: true }
  | { ok: true; text: string; inserted: false }
  | { ok: false; reason: "no_heading"; text: string }
  | { ok: false; reason: "duplicate_heading"; lines: readonly number[]; text: string };

export function insertMarkersUnderHeading(
  fileText: string,
  opts: { heading: string; name: string; content: string },
): InsertVaultRegionResult {
  if (typeof opts.heading !== "string" || opts.heading.length === 0) {
    throw new RangeError("Heading must be non-empty.");
  }
  if (typeof opts.name !== "string" || opts.name.length === 0) {
    throw new RangeError("Region name must be non-empty.");
  }

  const startMarker = `<!-- remnic:${opts.name}:start -->`;
  const endMarker = `<!-- remnic:${opts.name}:end -->`;
  if (fileText.includes(startMarker) && fileText.includes(endMarker)) {
    return { ok: true, text: fileText, inserted: false };
  }

  const rows = fileLines(fileText);
  const hits: Array<{ row: (typeof rows)[number]; level: number }> = [];
  for (const row of rows) {
    const heading = parseAtxHeading(row.line);
    if (heading && heading.text === opts.heading) {
      hits.push({ row, level: heading.level });
    }
  }
  if (hits.length === 0) return { ok: false, reason: "no_heading", text: fileText };
  if (hits.length > 1) {
    return { ok: false, reason: "duplicate_heading", lines: hits.map((hit) => hit.row.number), text: fileText };
  }

  const hit = hits[0]!;

  const eol = fileText.includes("\r\n") ? "\r\n" : "\n";
  const prefix =
    hit.row.next === fileText.length && !fileText.endsWith("\n") && !fileText.endsWith("\r")
      ? `${fileText}${eol}`
      : fileText.slice(0, hit.row.next);
  let content = opts.content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (eol === "\r\n") content = content.replace(/\n/g, "\r\n");
  if (content.length > 0 && !content.endsWith(eol)) content += eol;

  const text = `${prefix}${startMarker}${eol}${content}${endMarker}${eol}${fileText.slice(hit.row.next)}`;
  return { ok: true, text, inserted: true };
}

type FileLine = { line: string; start: number; next: number; number: number };

function fileLines(fileText: string): FileLine[] {
  const rows: FileLine[] = [];
  let start = 0;
  let number = 1;
  while (start < fileText.length) {
    let i = start;
    while (i < fileText.length && fileText[i] !== "\n" && fileText[i] !== "\r") i++;
    let next = i;
    if (fileText[i] === "\r" && fileText[i + 1] === "\n") next = i + 2;
    else if (fileText[i] === "\n" || fileText[i] === "\r") next = i + 1;
    else next = fileText.length;
    rows.push({ line: fileText.slice(start, i), start, next, number });
    number += 1;
    start = next;
  }
  return rows;
}

function parseAtxHeading(line: string): { level: number; text: string } | null {
  let level = 0;
  while (level < line.length && level < 6 && line[level] === "#") level++;
  if (level === 0 || line[level] !== " ") return null;
  return { level, text: line.slice(level + 1) };
}
