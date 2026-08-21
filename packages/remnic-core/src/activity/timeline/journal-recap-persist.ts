/**
 * Persist a deterministic daily journal recap (issue #2051).
 *
 * Writes journal/<YYYY-MM-DD>.md through writeJournalFile. Existing files
 * stay byte-identical unless force is set. Body is renderDeterministicJournal.
 */
import { journalPath, writeJournalFile } from "../journal.js";
import { renderDeterministicJournal } from "./journal-recap.js";
import type { TimelineCard } from "./types.js";

export interface PersistDeterministicJournalInput {
  memoryDir: string;
  date: string;
  cards: readonly TimelineCard[];
  timezone: string;
  force?: boolean;
}

export interface PersistDeterministicJournalResult {
  path: string;
  wrote: boolean;
}

export function persistDeterministicJournal(
  input: PersistDeterministicJournalInput,
): PersistDeterministicJournalResult {
  const filePath = journalPath(input.memoryDir, input.date);
  const wrote = writeJournalFile(
    filePath,
    renderDeterministicJournal(input.cards, {
      date: input.date,
      timezone: input.timezone,
    }),
    input.force === true,
  );
  return { path: filePath, wrote };
}
