/**
 * Filesystem readJournal(D) for the vault daily-note journal (issue #1987).
 *
 * Reuses the #1985 template resolver (every layout #1985 can resolve works
 * here — no separate path configuration) and the #1985 containment
 * discipline: symlinked vault roots and notes that escape the vault are
 * refused before any byte is read. Exactly ONE readFile per call; a
 * missing note is a legitimate no-journal day, not an error (§22).
 */
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

import { expandTildePath } from "../utils/path.js";
import { readVaultJournal } from "./journal-vault-read.js";
import type { ActivityTimelineVaultConfig } from "./types.js";
import { resolveVaultNotePath } from "./vault-path.js";

export type ReadJournalResult =
  | { ok: true; exists: false; reason: "missing_file" | "missing_heading"; filePath: string }
  | {
      ok: true;
      exists: true;
      text: string;
      heading: string;
      warnings: readonly string[];
      filePath: string;
    }
  | { ok: false; reason: "duplicate_heading"; lines: readonly number[]; filePath: string }
  | { ok: false; reason: "not_directory" | "path_escape" | "symlink_escape"; filePath: string };

/** Publisher-owned daily-note heading sections that must never count as journal text. */
export function publisherOwnedSectionNames(vault: ActivityTimelineVaultConfig): string[] {
  if (vault.sectionStrategy !== "heading") return [];
  const names: string[] = [];
  for (const target of Object.values(vault.publish)) {
    if (target.enabled && target.target === "daily" && target.section.trim().length > 0) {
      names.push(target.section);
    }
  }
  return names;
}

export function readJournalForDate(input: {
  vault: ActivityTimelineVaultConfig;
  date: string;
  timezone?: string;
}): ReadJournalResult {
  const journalSection = input.vault.readback.journalSection;
  const relative = resolveVaultNotePath(input.vault.dailyNotePath, input.date, {
    timezone: input.timezone,
  });
  const root = path.resolve(expandTildePath(input.vault.vaultPath));
  const filePath = path.join(root, relative);

  try {
    const rootStat = lstatSync(root);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      return { ok: false, reason: "not_directory", filePath };
    }
  } catch {
    // The vault root itself is missing: no note can exist, so this is a
    // no-journal day, not a configuration error.
    return { ok: true, exists: false, reason: "missing_file", filePath };
  }

  const lexical = path.relative(root, filePath);
  if (
    lexical.length === 0 ||
    lexical === ".." ||
    lexical.startsWith(`..${path.sep}`) ||
    path.isAbsolute(lexical)
  ) {
    return { ok: false, reason: "path_escape", filePath };
  }
  if (!containedBySymlinks(root, filePath)) {
    return { ok: false, reason: "symlink_escape", filePath };
  }

  // One read. A concurrent vault-sync write lands as whichever snapshot
  // this single read returns — never a torn mix.
  let fileText: string;
  try {
    fileText = readFileSync(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: true, exists: false, reason: "missing_file", filePath };
    }
    throw err;
  }

  const result = readVaultJournal({
    fileText,
    journalSection,
    publishSectionNames: publisherOwnedSectionNames(input.vault),
  });
  return { ...result, filePath };
}

/**
 * Containment under symlinks (mirrors the #1985 publisher helper): the
 * deepest existing ancestor of the note must still resolve inside the
 * real vault root. A symlink chain that leaves the vault is refused
 * before any note byte is read.
 */
function containedBySymlinks(root: string, dest: string): boolean {
  const realRoot = realpathSync(root);
  let probe = dest;
  for (;;) {
    try {
      if (statSync(probe).isFile() || statSync(probe).isDirectory()) {
        const real = realpathSync(probe);
        return real === realRoot || real.startsWith(`${realRoot}${path.sep}`);
      }
    } catch {
      // ENOENT: walk up to the parent.
    }
    const parent = path.dirname(probe);
    if (parent === probe) return false;
    probe = parent;
  }
}
