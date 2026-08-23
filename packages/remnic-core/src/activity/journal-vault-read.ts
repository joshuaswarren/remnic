/**
 * Read-only vault daily-note journal section (issue #1987 first slice).
 *
 * Pure: caller supplies the file text (one read; the filesystem wrapper
 * lives in journal-read.ts). Extracts the unique journal section via
 * the shared ATX heading matcher, then strips every Remnic-owned region
 * (journal-strip.ts) so published output can never re-enter the journal.
 * Missing note and missing section are distinct, labeled no-journal
 * outcomes (§22); duplicate headings refuse with line numbers.
 *
 * Headings are recognized only outside code blocks (issue #2882): lines
 * are classified through the same shared `fileLines()` scanner the vault
 * publisher uses, so a `## …` example inside a fenced or indented code
 * block is sample text — it never counts as the journal heading, never
 * duplicates it, and never terminates the section. An unclosed fence
 * keeps every following line fenced, mirroring the publisher's refusal
 * direction: the section safely extends rather than mis-reading code.
 */

import { parseAtxHeading } from "./journal-section.js";
import { stripRemnicOwnedRegions } from "./journal-strip.js";
import { fileLines } from "./vault-publish.js";

export interface ReadVaultJournalInput {
  fileText: string | null | undefined;
  journalSection: string;
  publishSectionNames?: readonly string[];
}

export type ReadVaultJournalResult =
  | { ok: true; exists: false; reason: "missing_file" | "missing_heading" }
  | { ok: true; exists: true; text: string; heading: string; warnings: readonly string[] }
  | { ok: false; reason: "duplicate_heading"; lines: readonly number[] };

export function readVaultJournal(input: ReadVaultJournalInput): ReadVaultJournalResult {
  if (input.fileText === null || input.fileText === undefined) {
    return { ok: true, exists: false, reason: "missing_file" };
  }
  if (input.journalSection.length === 0) {
    return { ok: true, exists: false, reason: "missing_heading" };
  }

  const rows = fileLines(input.fileText);
  const hits: Array<{ index: number; level: number }> = [];
  for (const row of rows) {
    if (row.fenced) continue;
    const heading = parseAtxHeading(row.line);
    if (heading && heading.text === input.journalSection) {
      hits.push({ index: row.number - 1, level: heading.level });
    }
  }
  if (hits.length === 0) return { ok: true, exists: false, reason: "missing_heading" };
  if (hits.length > 1) return { ok: false, reason: "duplicate_heading", lines: hits.map((h) => h.index + 1) };

  const headingIndex = hits[0]!.index;
  const level = hits[0]!.level;
  let endIndex = rows.length;
  for (let i = headingIndex + 1; i < rows.length; i++) {
    const row = rows[i]!;
    if (row.fenced) continue;
    const heading = parseAtxHeading(row.line);
    if (heading && heading.level <= level) {
      endIndex = i;
      break;
    }
  }

  const body = rows.slice(headingIndex + 1, endIndex).map((row) => row.line).join("\n");
  const stripped = stripRemnicOwnedRegions(body, input.publishSectionNames ?? []);
  return {
    ok: true,
    exists: true,
    text: trimNewlines(stripped.text),
    heading: input.journalSection,
    warnings: stripped.warnings,
  };
}

function trimNewlines(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && (text[start] === "\n" || text[start] === "\r")) start++;
  while (end > start && (text[end - 1] === "\n" || text[end - 1] === "\r")) end--;
  return text.slice(start, end);
}

