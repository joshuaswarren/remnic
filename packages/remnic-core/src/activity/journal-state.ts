/**
 * Per-day change detection for journal extraction (issue #1987).
 *
 * `<memoryDir>/state/timeline.json` stores a content hash of the
 * POST-STRIP journal text per day. An unchanged day is never re-extracted
 * (same pattern as the wearables day-skip); a day edited weeks later
 * re-extracts exactly once per content change.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import { withHeldFileLock } from "../utils/serialize-mutations.js";

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

/** Write new before deleting old (§42): unique temp file first, then an atomic rename. */
export function writeTimelineState(memoryDir: string, state: TimelineState): void {
  const filePath = timelineStatePath(memoryDir);
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tempPath, filePath);
}

export function journalDateLockPath(memoryDir: string, date: string): string {
  return path.join(memoryDir, STATE_DIR_NAME, `journal-extract-${date}.lock`);
}

export function timelineStateLockPath(memoryDir: string): string {
  return `${timelineStatePath(memoryDir)}.lock`;
}

const DATE_LOCK_OPTS = { staleMs: 120_000, maxWaitMs: 60_000 } as const;
const STATE_LOCK_OPTS = { staleMs: 30_000, maxWaitMs: 15_000 } as const;

/** Hold the per-date extract lock for hash reread → extract → commit. Fail closed. */
export async function withJournalDateLock<T>(
  memoryDir: string,
  date: string,
  task: () => Promise<T>,
): Promise<T> {
  return withHeldFileLock(journalDateLockPath(memoryDir, date), DATE_LOCK_OPTS, async (acquired) => {
    if (!acquired) {
      throw new Error(`journal: could not acquire the extract lock for ${date}`);
    }
    return task();
  });
}

/** Reread-merge one day's hash under the state-file lock, unique tmp + rename. */
export async function commitJournalHash(memoryDir: string, date: string, hash: string): Promise<void> {
  await withHeldFileLock(timelineStateLockPath(memoryDir), STATE_LOCK_OPTS, async (acquired) => {
    if (!acquired) {
      throw new Error("journal: could not acquire the timeline state lock");
    }
    const latest = readTimelineState(memoryDir);
    writeTimelineState(memoryDir, setJournalHash(latest, date, hash));
  });
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
