/**
 * Per-day change detection for journal extraction (issue #1987).
 *
 * `<memoryDir>/state/timeline.json` stores a content hash of the
 * POST-STRIP journal text per day. An unchanged day is never re-extracted
 * (same pattern as the wearables day-skip); a day edited weeks later
 * re-extracts exactly once per content change.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface TimelineState {
  version: 1;
  journal: Record<string, string>;
}

const STATE_DIR_NAME = "state";
const STATE_FILE_NAME = "timeline.json";

export function timelineStatePath(memoryDir: string): string {
  return path.join(memoryDir, STATE_DIR_NAME, STATE_FILE_NAME);
}

/** Hash the post-strip section text — Remnic-stripped noise must not re-trigger extraction. */
export function hashJournalText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function readTimelineState(memoryDir: string): TimelineState {
  const filePath = timelineStatePath(memoryDir);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    // A corrupt state file must never block extraction: treat as empty.
    return { version: 1, journal: {} };
  }
  if (typeof parsed !== "object" || parsed === null || !("journal" in parsed)) {
    return { version: 1, journal: {} };
  }
  const journal: unknown = parsed.journal;
  if (typeof journal !== "object" || journal === null) return { version: 1, journal: {} };
  const hashes: Record<string, string> = {};
  for (const [date, value] of Object.entries(journal)) {
    if (typeof value === "string" && value.length > 0) hashes[date] = value;
  }
  return { version: 1, journal: hashes };
}

/** Write new before deleting old (§42): temp file first, then an atomic rename. */
export function writeTimelineState(memoryDir: string, state: TimelineState): void {
  const filePath = timelineStatePath(memoryDir);
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tempPath, filePath);
}

/** Pure update: set one day's hash. Returns a new state object. */
export function setJournalHash(state: TimelineState, date: string, hash: string): TimelineState {
  return { ...state, journal: { ...state.journal, [date]: hash } };
}

/** True when the day's stored hash matches — unchanged days are skipped. */
export function journalUnchanged(state: TimelineState, date: string, text: string): boolean {
  const stored = state.journal[date];
  return typeof stored === "string" && stored === hashJournalText(text);
}
