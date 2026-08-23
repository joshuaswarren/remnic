/**
 * Resolve journal source mode (issue #1987).
 *
 * Pure. `memoryDir` mode reads `<memoryDir>/journal/<date>.md` (#1984
 * behavior, the default); `vault` mode reads the configured section of
 * the vault daily note. The heading is NOT resolved here — vault
 * prerequisites (vault.enabled, dailyNotePath, readback.journalSection)
 * are checked by journal-vault-prereq.ts at config parse time.
 *
 * Legacy `source: "file"` is accepted as an alias of `memoryDir` and
 * flagged so config parse can emit a deprecation warning.
 */

export type JournalSource = "memoryDir" | "vault";

const JOURNAL_SOURCES: readonly JournalSource[] = ["memoryDir", "vault"];

export type JournalSourceResult =
  | { ok: true; mode: JournalSource; deprecatedAlias?: "file" }
  | { ok: false; error: "unknown_source" };

export function resolveJournalSource(input: { source: string }): JournalSourceResult {
  if (input.source === "file") {
    return { ok: true, mode: "memoryDir", deprecatedAlias: "file" };
  }
  if ((JOURNAL_SOURCES as readonly string[]).includes(input.source)) {
    return { ok: true, mode: input.source as JournalSource };
  }
  return { ok: false, error: "unknown_source" };
}
