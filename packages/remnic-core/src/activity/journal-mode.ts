/**
 * Parse journal mode (issue #1987 leftover).
 *
 * Pure. Surfaces wait. Allow file or vault. Unknown or empty is unknown_mode.
 */

const JOURNAL_MODES = ["file", "vault"] as const;

export type JournalMode = (typeof JOURNAL_MODES)[number];

export type ParseJournalModeResult =
  | { ok: true; mode: JournalMode }
  | { ok: false; error: "unknown_mode" };

export function parseJournalMode(value: string): ParseJournalModeResult {
  if ((JOURNAL_MODES as readonly string[]).includes(value)) {
    return { ok: true, mode: value as JournalMode };
  }
  return { ok: false, error: "unknown_mode" };
}
