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
  const startIdx = fileText.indexOf(startMarker);
  if (startIdx === -1) return { ok: false, reason: "no_marker", text: fileText };
  const endIdx = fileText.indexOf(endMarker, startIdx + startMarker.length);
  if (endIdx === -1) return { ok: false, reason: "no_marker", text: fileText };

  const { body, eol } = ownedBody(fileText, opts.content);
  return {
    ok: true,
    text: `${fileText.slice(0, startIdx + startMarker.length)}${eol}${body}${eol}${fileText.slice(endIdx)}`,
  };
}

function applyHeadingRegion(fileText: string, name: string, content: string): ApplyManagedRegionResult {
  const wanted = name.trim();
  const hits: Array<{ line: number; level: number; next: number }> = [];
  for (const row of fileLines(fileText)) {
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
  for (const row of fileLines(fileText)) {
    if (row.start < hit.next) continue;
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

function fileLines(fileText: string): Array<{ line: string; start: number; next: number; number: number }> {
  const rows: Array<{ line: string; start: number; next: number; number: number }> = [];
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
