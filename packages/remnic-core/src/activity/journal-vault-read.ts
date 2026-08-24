/**
 * Read-only vault daily-note journal section (issue #1987 first slice).
 *
 * Pure: caller supplies the file text (one read; the filesystem wrapper
 * lives in journal-read.ts). Extracts the unique journal section via
 * the shared ATX heading matcher, then strips every Remnic-owned region
 * (journal-strip.ts) so published output can never re-enter the journal.
 * Missing note and missing section are distinct, labeled no-journal
 * outcomes (§22); duplicate headings refuse with line numbers.
 */

import { parseAtxHeading } from "./journal-section.js";
import { stripRemnicOwnedRegions } from "./journal-strip.js";

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

function splitFileLines(fileText: string): string[] {
  const lines = fileText.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.endsWith("\r")) lines[i] = line.slice(0, -1);
  }
  return lines;
}

function trimNewlines(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && (text[start] === "\n" || text[start] === "\r")) start++;
  while (end > start && (text[end - 1] === "\n" || text[end - 1] === "\r")) end--;
  return text.slice(start, end);
}
