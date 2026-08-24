/**
 * Cross-process helper for journal date-lock tests. Spawned as a child:
 * reread hash → optional candidate marker → commit, all under withJournalDateLock.
 */
import { appendFileSync } from "node:fs";

import {
  commitJournalHash,
  hashJournalText,
  journalUnchanged,
  readTimelineState,
  withJournalDateLock,
} from "./journal-state.js";

const memoryDir = process.env.JOURNAL_LOCK_DIR;
const date = process.env.JOURNAL_LOCK_DATE;
const text = process.env.JOURNAL_LOCK_TEXT;
const marker = process.env.JOURNAL_LOCK_MARKER;

if (!memoryDir || !date || !text || !marker) {
  throw new Error("journal lock worker missing JOURNAL_LOCK_* env");
}

await withJournalDateLock(memoryDir, date, async () => {
  const state = readTimelineState(memoryDir);
  if (journalUnchanged(state, date, text)) return;
  await new Promise((resolve) => setTimeout(resolve, 80));
  appendFileSync(marker, "1");
  await commitJournalHash(memoryDir, date, hashJournalText(text));
});
