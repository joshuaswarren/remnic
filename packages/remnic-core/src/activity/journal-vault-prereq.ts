/**
 * Vault journal read-back prerequisites (issue #1987).
 *
 * Pure. `journal.source: "vault"` requires all three prerequisites; the
 * caller checks `source` first via the journal-source parser and calls this
 * only for vault mode. Reports EVERY unmet prerequisite at once so the user
 * gets one actionable error, not the first hit.
 */

export const VAULT_JOURNAL_PREREQUISITES = [
  "vault.enabled",
  "vault.dailyNotePath",
  "vault.readback.journalSection",
] as const;
export type VaultJournalPrerequisite = (typeof VAULT_JOURNAL_PREREQUISITES)[number];

export type VaultJournalPrereqResult =
  | { ok: true }
  | { ok: false; missing: VaultJournalPrerequisite[]; message: string };

export function checkVaultJournalPrerequisites(input: {
  vaultEnabled?: unknown;
  dailyNotePath?: unknown;
  journalSection?: unknown;
}): VaultJournalPrereqResult {
  const missing: VaultJournalPrerequisite[] = [];
  if (input.vaultEnabled !== true) missing.push("vault.enabled");
  // Exact values are validated: trim() only detects blankness, never rewrites.
  if (typeof input.dailyNotePath !== "string" || input.dailyNotePath.trim().length === 0) {
    missing.push("vault.dailyNotePath");
  }
  if (typeof input.journalSection !== "string" || input.journalSection.trim().length === 0) {
    missing.push("vault.readback.journalSection");
  }
  if (missing.length === 0) return { ok: true };
  return {
    ok: false,
    missing,
    message: `vault journal read-back prerequisites unmet: ${missing.join(", ")}`,
  };
}
