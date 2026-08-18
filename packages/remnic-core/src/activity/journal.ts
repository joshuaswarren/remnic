/**
 * User-owned daily journal (issue #1984 PR1).
 *
 * Files live at `<memoryDir>/journal/<YYYY-MM-DD>.md` — inside the memory
 * directory but outside scan roots, same placement as activity digests.
 * Once written, Remnic never rewrites the file except `seed` with force.
 * All writes go through writeJournalFile, which stats first.
 */
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import { isValidActivityDate } from "./digest.js";

export const JOURNAL_DIR_NAME = "journal";

/** Minimal card shape the seed renderer needs. TimelineCard is assignable. */
export interface JournalSeedCard {
  title: string;
  startUtc: string;
  endUtc: string;
}

export interface SeedJournalInput {
  memoryDir: string;
  date: string;
  cards?: readonly JournalSeedCard[];
  force?: boolean;
}

export interface SeedJournalResult {
  path: string;
  wrote: boolean;
}

const JOURNAL_DAY_TOPLEVEL = /^journal[\\/]\d{4}-\d{2}-\d{2}\.md$/i;
const JOURNAL_DAY_ANYWHERE = /(?:^|[\\/])journal[\\/]\d{4}-\d{2}-\d{2}\.md$/i;

export function journalPath(memoryDir: string, date: string): string {
  if (!isValidActivityDate(date)) {
    throw new RangeError(`Invalid journal date "${date}"; expected YYYY-MM-DD.`);
  }
  return path.join(memoryDir, JOURNAL_DIR_NAME, `${date}.md`);
}

/**
 * Root-aware journal day-file check. With a memory root, only the top-level
 * `journal/<date>.md` matches so a nested `facts/journal/<date>.md` stays
 * recallable. Without a root, fall back to the day-file shape anywhere.
 */
export function isJournalDayPath(filePath: string, memoryRoot?: string): boolean {
  if (memoryRoot !== undefined && memoryRoot.length > 0) {
    const relative = path.relative(memoryRoot, path.resolve(memoryRoot, filePath));
    return JOURNAL_DAY_TOPLEVEL.test(relative);
  }
  return JOURNAL_DAY_ANYWHERE.test(filePath);
}

export function todayJournalDate(now: Date = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatCardDuration(card: JournalSeedCard): string {
  const start = Date.parse(card.startUtc);
  const end = Date.parse(card.endUtc);
  const minutes =
    Number.isFinite(start) && Number.isFinite(end) && end > start
      ? Math.round((end - start) / 60_000)
      : 0;
  return `${minutes}m`;
}

function renderJournalSeed(date: string, cards: readonly JournalSeedCard[]): string {
  const ordered = [...cards].sort((left, right) => {
    const byStart = left.startUtc.localeCompare(right.startUtc);
    return byStart !== 0 ? byStart : left.title.localeCompare(right.title);
  });
  const glance =
    ordered.length === 0
      ? ["_No cards._"]
      : ordered.map((card) => `- ${formatCardDuration(card)} ${card.title}`);
  return [`# Journal — ${date}`, "", "## Day at a glance", "", ...glance, "", "## Notes", "", ""].join(
    "\n",
  );
}

/** The only journal write. Stats first; existing files are a no-op unless force. */
function writeJournalFile(filePath: string, content: string, force: boolean): boolean {
  let exists = false;
  try {
    statSync(filePath);
    exists = true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw err;
  }
  if (exists && !force) return false;
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
  return true;
}

export function seedJournal(input: SeedJournalInput): SeedJournalResult {
  const filePath = journalPath(input.memoryDir, input.date);
  const wrote = writeJournalFile(
    filePath,
    renderJournalSeed(input.date, input.cards ?? []),
    input.force === true,
  );
  return { path: filePath, wrote };
}
