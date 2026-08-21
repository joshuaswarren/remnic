/**
 * OAI-mem-citation parser and formatter (issue #379).
 *
 * Mirrors the citation block format used by Codex's `citations.rs` so that
 * Remnic recall responses produce compatible citation blocks. The model
 * appends these blocks to its final reply, and downstream hooks parse them
 * to increment memory usage tracking.
 *
 * Block format:
 *
 *   <oai-mem-citation>
 *   <citation_entries>
 *   path/to/file.md:1-5|note=[short explanation]
 *   </citation_entries>
 *   <rollout_ids>
 *   rollout-abc123
 *   </rollout_ids>
 *   </oai-mem-citation>
 */

/** A single citation entry referencing a memory file and line range. */
export interface CitationEntry {
  path: string;
  lineStart: number;
  lineEnd: number;
  note: string;
}

/** Parsed citation block containing entries and rollout/thread IDs. */
export interface CitationBlock {
  entries: CitationEntry[];
  rolloutIds: string[];
}

/** Metadata attached to a recall result for citation guidance. */
export interface CitationMetadata {
  memoryId: string;
  path: string;
  lineStart: number;
  lineEnd: number;
  rolloutId?: string;
  noteDefault: string;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

const OPEN_TAG = "<oai-mem-citation>";
const CLOSE_TAG = "</oai-mem-citation>";
const ENTRIES_OPEN = "<citation_entries>";
const ENTRIES_CLOSE = "</citation_entries>";
const ROLLOUT_OPEN = "<rollout_ids>";
const ROLLOUT_CLOSE = "</rollout_ids>";
/** Legacy alias accepted during parsing (Codex historically used thread_ids). */
const THREAD_OPEN = "<thread_ids>";
const THREAD_CLOSE = "</thread_ids>";

/**
 * Parse an `<oai-mem-citation>` block from arbitrary text.
 *
 * Returns `null` when no valid block is found. Malformed entry lines are
 * silently skipped; only valid lines contribute to the result. Rollout IDs
 * are deduped while preserving insertion order.
 */
export function parseOaiMemCitation(text: string): CitationBlock | null {
  const openIdx = text.indexOf(OPEN_TAG);
  if (openIdx < 0) return null;
  const closeIdx = text.indexOf(CLOSE_TAG, openIdx + OPEN_TAG.length);
  if (closeIdx < 0) return null;

  const inner = text.slice(openIdx + OPEN_TAG.length, closeIdx);

  const entries = parseEntries(inner);
  const rolloutIds = parseIds(inner, ROLLOUT_OPEN, ROLLOUT_CLOSE)
    ?? parseIds(inner, THREAD_OPEN, THREAD_CLOSE)
    ?? [];

  if (entries.length === 0 && rolloutIds.length === 0) return null;

  return { entries, rolloutIds };
}

function parseEntries(block: string): CitationEntry[] {
  const start = block.indexOf(ENTRIES_OPEN);
  if (start < 0) return [];
  const end = block.indexOf(ENTRIES_CLOSE, start + ENTRIES_OPEN.length);
  if (end < 0) return [];

  const raw = block.slice(start + ENTRIES_OPEN.length, end);
  const lines = raw.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  const results: CitationEntry[] = [];
  for (const line of lines) {
    const parsed = parseEntryLine(line);
    if (parsed) results.push(parsed);
  }
  return results;
}

/**
 * Parse a single citation entry line:
 *   `<path>:<line_start>-<line_end>|note=[<note>]`
 *
 * Splits on the LAST `:` before the range pattern, not the first, because
 * file paths can contain colons on some systems (e.g., Windows drive letters
 * like `C:\` or macOS resource forks).
 */
function parseEntryLine(line: string): CitationEntry | null {
  // Match the range+note suffix anchored at the end, allowing the path prefix
  // to contain colons. The (.+) is greedy so it consumes everything up to the
  // LAST `:` before the `\d+-\d+|note=[...]` suffix.
  const match = line.match(/^(.+):(\d+)-(\d+)\|note=\[(.*)?\]$/);
  if (!match) return null;
  const [, pathRaw, startRaw, endRaw, noteRaw] = match;
  if (!pathRaw || !startRaw || !endRaw) return null;
  const lineStart = parseInt(startRaw, 10);
  const lineEnd = parseInt(endRaw, 10);
  const entryPath = pathRaw.trim();
  if (!entryPath || !isValidCitationRange(lineStart, lineEnd)) return null;
  return {
    path: entryPath,
    lineStart,
    lineEnd,
    note: noteRaw ?? "",
  };
}

function isValidCitationRange(lineStart: number, lineEnd: number): boolean {
  return (
    Number.isInteger(lineStart) &&
    Number.isInteger(lineEnd) &&
    lineStart >= 1 &&
    lineEnd >= lineStart
  );
}

function parseIds(block: string, openTag: string, closeTag: string): string[] | null {
  const start = block.indexOf(openTag);
  if (start < 0) return null;
  const end = block.indexOf(closeTag, start + openTag.length);
  if (end < 0) return null;

  const raw = block.slice(start + openTag.length, end);
  const lines = raw.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);

  // Deduplicate preserving insertion order.
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const id of lines) {
    if (!seen.has(id)) {
      seen.add(id);
      unique.push(id);
    }
  }
  return unique.length > 0 ? unique : null;
}

// ---------------------------------------------------------------------------
// Sanitizer
// ---------------------------------------------------------------------------

/**
 * Replace newline characters (\n, \r) with spaces so that note values can be
 * safely embedded in a single citation entry line without corrupting the
 * line-based parser (`parseEntryLine` splits on `\n`).
 */
export function sanitizeNoteForCitation(note: string): string {
  return note.replace(/[\r\n]+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// Formatter
// ---------------------------------------------------------------------------

/**
 * Format a `CitationBlock` into the canonical `<oai-mem-citation>` XML block.
 */
export function formatOaiMemCitation(block: CitationBlock): string {
  const entryLines = block.entries
    .map((e) => `${e.path}:${e.lineStart}-${e.lineEnd}|note=[${sanitizeNoteForCitation(e.note)}]`)
    .join("\n");
  const idLines = block.rolloutIds.join("\n");

  return [
    OPEN_TAG,
    ENTRIES_OPEN,
    entryLines,
    ENTRIES_CLOSE,
    ROLLOUT_OPEN,
    idLines,
    ROLLOUT_CLOSE,
    CLOSE_TAG,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Guidance builder
// ---------------------------------------------------------------------------

/**
 * Build the citation guidance text appended to recall responses so that the
 * model knows how to emit a citation block in its reply.
 *
 * Returns an empty string when `citations` is empty (no guidance needed).
 */
export function buildCitationGuidance(citations: CitationMetadata[]): string {
  const validCitations = citations.filter((citation) =>
    citation.path.trim().length > 0 &&
    isValidCitationRange(citation.lineStart, citation.lineEnd)
  );
  if (validCitations.length === 0) return "";

  const entryExamples = validCitations.map((c) =>
    `${c.path}:${c.lineStart}-${c.lineEnd}|note=[${sanitizeNoteForCitation(c.noteDefault)}]`,
  );
  const rolloutExamples = validCitations
    .filter((c) => c.rolloutId != null)
    .map((c) => c.rolloutId!);

  // Dedupe rollout IDs preserving order.
  const seenRollouts = new Set<string>();
  const uniqueRollouts: string[] = [];
  for (const id of rolloutExamples) {
    if (!seenRollouts.has(id)) {
      seenRollouts.add(id);
      uniqueRollouts.push(id);
    }
  }

  const lines = [
    "",
    "[Remnic citation guidance]",
    "If you used any of the memories above, append the following to the END of your final reply:",
    OPEN_TAG,
    ENTRIES_OPEN,
    ...entryExamples,
    ENTRIES_CLOSE,
    ROLLOUT_OPEN,
    ...uniqueRollouts,
    ROLLOUT_CLOSE,
    CLOSE_TAG,
  ];

  return lines.join("\n");
}
