/**
 * Managed-region vault publisher (issue #1985).
 *
 * Markers replace bytes between `<!-- remnic:<name>:start -->` and
 * `<!-- remnic:<name>:end -->`. Heading replaces the body after a unique
 * ATX heading until the next same-or-higher heading. The heading line stays.
 * This module does not read config.
 */
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

import { expandTildePath } from "../utils/path.js";

export type ApplyManagedRegionResult =
  | { ok: true; text: string }
  | { ok: false; reason: "no_marker" | "no_heading"; text: string }
  | { ok: false; reason: "duplicate_heading"; lines: readonly number[]; text: string };

export type PublishVaultRegionResult =
  | { ok: true; status: "updated" | "unchanged" }
  | { ok: false; reason: "no_marker" | "missing_file" | "not_directory" };

export function applyManagedRegion(
  fileText: string,
  opts: { strategy: "markers" | "heading"; name: string; content: string },
): ApplyManagedRegionResult {
  if (opts.strategy === "heading") return applyHeadingRegion(fileText, opts.name, opts.content);

  const startMarker = `<!-- remnic:${opts.name}:start -->`;
  const endMarker = `<!-- remnic:${opts.name}:end -->`;
  // Markers are owned only outside a code block — fenced or indented: a
  // complete pair inside a ``` or four-space-indented example is sample
  // text the user wrote, and replacing between it would overwrite their
  // bytes (issue #1985).
  const rows = fileLines(fileText);
  let startRow: FileLine | undefined;
  let endRow: FileLine | undefined;
  for (const row of rows) {
    if (row.fenced) continue;
    const trimmed = row.line.trim();
    if (startRow === undefined) {
      if (trimmed === startMarker) startRow = row;
    } else if (endRow === undefined && trimmed === endMarker) {
      endRow = row;
      break;
    }
  }
  if (startRow === undefined || endRow === undefined) {
    return { ok: false, reason: "no_marker", text: fileText };
  }

  const { body, eol } = ownedBody(fileText, opts.content);
  return {
    ok: true,
    text: `${fileText.slice(0, startRow.start + startRow.line.length)}${eol}${body}${eol}${fileText.slice(endRow.start)}`,
  };
}

function applyHeadingRegion(fileText: string, name: string, content: string): ApplyManagedRegionResult {
  const wanted = name.trim();
  const rows = fileLines(fileText);
  const hits: Array<{ line: number; level: number; next: number }> = [];
  for (const row of rows) {
    if (row.fenced) continue;
    const heading = parseAtxHeading(row.line);
    if (heading && heading.text === wanted) {
      hits.push({ line: row.number, level: heading.level, next: row.next });
    }
  }
  if (hits.length === 0) return { ok: false, reason: "no_heading", text: fileText };
  if (hits.length > 1) {
    return { ok: false, reason: "duplicate_heading", lines: hits.map((hit) => hit.line), text: fileText };
  }

  const hit = hits[0]!;
  let sectionEnd = fileText.length;
  for (const row of rows) {
    if (row.start < hit.next || row.fenced) continue;
    const heading = parseAtxHeading(row.line);
    if (heading && heading.level <= hit.level) {
      sectionEnd = row.start;
      break;
    }
  }

  const { body, eol } = ownedBody(fileText, content);
  const prefix =
    hit.next === fileText.length && !fileText.endsWith("\n") && !fileText.endsWith("\r")
      ? `${fileText}${eol}`
      : fileText.slice(0, hit.next);
  return { ok: true, text: `${prefix}${body}${eol}${fileText.slice(sectionEnd)}` };
}

function ownedBody(fileText: string, content: string): { body: string; eol: string } {
  const eol = fileText.includes("\r\n") ? "\r\n" : "\n";
  let body = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (eol === "\r\n") body = body.replace(/\n/g, "\r\n");
  if (body.endsWith(eol)) body = body.slice(0, -eol.length);
  return { body, eol };
}

export interface FileLine {
  line: string;
  start: number;
  next: number;
  number: number;
  /** True inside a fenced or indented code block, delimiter lines included. */
  fenced: boolean;
}

/**
 * The one shared code-aware line scanner (issue #1985): marker discovery,
 * marker replacement, mismatch scanning, and heading insertion all classify
 * lines through it, so code examples are invisible to every scan.
 *
 * A line is code when a fence is open, or when its own indentation reaches
 * four columns (CommonMark indented code block; one tab covers all four).
 * Classification reads the RAW line — no consumer trims first — so the
 * indentation cannot be erased before it is seen.
 *
 * Two deliberate simplifications, both resolving toward "code" (skip):
 *   - CommonMark lets an indented line lazily continue an open paragraph
 *     instead of opening a code block; we still call it code.
 *   - CommonMark measures indentation relative to the containing block, so
 *     a marker indented under a list item can be live content; we call it
 *     code. Distinguishing either case needs full block tracking.
 * Skipping a line refuses a publish; mis-reading one as live overwrites the
 * user's bytes. The refusal is recoverable, the overwrite is not.
 *
 * A fence delimiter run is only live at indent < 4: deeper, the run is
 * literal text inside an indented code block (and inside an open fence a
 * 4+-indented closing run is content, not a closer), so `fenceRun` never
 * sees an indented line.
 */
export function fileLines(fileText: string): FileLine[] {
  const rows: FileLine[] = [];
  let start = 0;
  let number = 1;
  let fence: { char: string; len: number } | null = null;
  while (start < fileText.length) {
    let i = start;
    while (i < fileText.length && fileText[i] !== "\n" && fileText[i] !== "\r") i++;
    let next = i;
    if (fileText[i] === "\r" && fileText[i + 1] === "\n") next = i + 2;
    else if (fileText[i] === "\n" || fileText[i] === "\r") next = i + 1;
    else next = fileText.length;
    const line = fileText.slice(start, i);

    const indentedCode = indentColumn(line) >= 4;
    const run = indentedCode ? null : fenceRun(line);
    let fenced: boolean;
    if (fence === null) {
      // A backtick fence's info string may not contain a backtick, so a
      // ``` ` ``` run with one is not an opening delimiter.
      if (run !== null && !(run.char === "`" && run.info.includes("`"))) {
        fence = { char: run.char, len: run.len };
      }
      fenced = fence !== null || indentedCode;
    } else {
      fenced = true;
      if (run !== null && run.char === fence.char && run.len >= fence.len && run.info.length === 0) {
        fence = null;
      }
    }

    rows.push({ line, start, next, number, fenced });
    number += 1;
    start = next;
  }
  return rows;
}

/**
 * The column a line's first non-whitespace character sits at: spaces count
 * one, a tab advances to the next multiple of four (CommonMark tab handling).
 */
function indentColumn(line: string): number {
  let col = 0;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === " ") col += 1;
    else if (ch === "\t") col += 4 - (col % 4);
    else break;
  }
  return col;
}

/**
 * A fence delimiter run: three or more backticks or tildes at the line's
 * start (leading whitespace allowed), plus the trailing info string. An
 * unterminated fence therefore keeps every following line fenced, which
 * makes a malformed note refuse to publish instead of overwriting bytes.
 */
function fenceRun(line: string): { char: string; len: number; info: string } | null {
  const body = line.trimStart();
  const char = body[0];
  if (char !== "`" && char !== "~") return null;
  let len = 0;
  while (len < body.length && body[len] === char) len++;
  if (len < 3) return null;
  return { char, len, info: body.slice(len).trim() };
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

export function publishVaultRegion(input: {
  vaultPath: string;
  relativeFile: string;
  name: string;
  content: string;
}): PublishVaultRegionResult {
  const vault = expandTildePath(input.vaultPath);
  try {
    if (!statSync(vault).isDirectory()) return { ok: false, reason: "not_directory" };
  } catch {
    return { ok: false, reason: "not_directory" };
  }

  if (input.relativeFile.length === 0 || path.isAbsolute(input.relativeFile)) {
    return { ok: false, reason: "missing_file" };
  }
  const root = path.resolve(vault);
  const dest = path.resolve(root, input.relativeFile);
  const rel = path.relative(root, dest);
  if (rel.length === 0 || rel.startsWith("..") || path.isAbsolute(rel)) {
    return { ok: false, reason: "missing_file" };
  }

  let existing: string;
  try {
    if (!statSync(dest).isFile()) return { ok: false, reason: "missing_file" };
    existing = readFileSync(dest, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { ok: false, reason: "missing_file" };
    throw err;
  }

  const applied = applyManagedRegion(existing, {
    strategy: "markers",
    name: input.name,
    content: input.content,
  });
  if (!applied.ok) return { ok: false, reason: "no_marker" };

  const prevHash = createHash("sha256").update(existing, "utf8").digest("hex");
  const nextHash = createHash("sha256").update(applied.text, "utf8").digest("hex");
  if (prevHash === nextHash) return { ok: true, status: "unchanged" };

  const tmpPath = path.join(path.dirname(dest), `.remnic-vault-${randomBytes(8).toString("hex")}.tmp`);
  writeFileSync(tmpPath, applied.text);
  try {
    renameSync(tmpPath, dest);
  } catch (renameErr) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // temp cleanup is best-effort
    }
    throw renameErr;
  }
  return { ok: true, status: "updated" };
}
