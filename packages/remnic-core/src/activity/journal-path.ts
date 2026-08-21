/**
 * Parse a journal file path (issue #1987 leftover).
 *
 * Trim. Empty is missing_path. Absolute, `..`, backslash, or newline
 * is invalid_path.
 */
import { posix, win32 } from "node:path";

export type ParseJournalFilePathResult =
  | { ok: true; path: string }
  | { ok: false; error: "missing_path" | "invalid_path" };

export function parseJournalFilePath(value: string): ParseJournalFilePathResult {
  const journalPath = value.trim();
  if (journalPath.length === 0) return { ok: false, error: "missing_path" };
  if (
    journalPath.includes("\\") ||
    journalPath.includes("\n") ||
    journalPath.includes("\r") ||
    posix.isAbsolute(journalPath) ||
    win32.isAbsolute(journalPath) ||
    journalPath.split("/").includes("..")
  ) {
    return { ok: false, error: "invalid_path" };
  }
  return { ok: true, path: journalPath };
}
