/**
 * Filesystem readJournal(D) for the vault daily-note journal (issue #1987).
 *
 * Reuses the #1985 template resolver (every layout #1985 can resolve works
 * here — no separate path configuration) and the #1985 containment
 * discipline: symlinked vault roots and notes that escape the vault are
 * refused before any byte is read. Exactly ONE readFile per call; a
 * missing note is a legitimate no-journal day, not an error (§22).
 */
import { closeSync, constants as fsConstants, fstatSync, lstatSync, openSync, readFileSync, realpathSync, statSync } from "node:fs";
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

  // One read of a no-follow fd. Ancestor/note symlink swaps cannot redirect
  // the bytes: the path is verified, then the same fd is read once.
  let fileText: string;
  try {
    fileText = readVerifiedDailyNote(root, filePath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { ok: true, exists: false, reason: "missing_file", filePath };
    }
    if (code === "ELOOP" || code === "EISDIR") {
      return { ok: false, reason: "symlink_escape", filePath };
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

function symlinkRejected(): NodeJS.ErrnoException {
  const err = new Error("symlink refused") as NodeJS.ErrnoException;
  err.code = "ELOOP";
  return err;
}

/**
 * Open the verified daily note with O_NOFOLLOW, fstat a regular file whose
 * identity still matches the path, then read that same fd once. Any symlink
 * in the root→note chain is refused.
 */
function readVerifiedDailyNote(root: string, filePath: string): string {
  const relative = path.relative(root, filePath);
  const parts = relative.split(path.sep).filter((part) => part.length > 0 && part !== ".");
  let cursor = root;
  for (const part of parts) {
    cursor = path.join(cursor, part);
    const st = lstatSync(cursor);
    if (st.isSymbolicLink()) throw symlinkRejected();
  }

  const parent = path.dirname(filePath);
  const parentLstat = lstatSync(parent);
  if (parentLstat.isSymbolicLink() || !parentLstat.isDirectory()) throw symlinkRejected();
  const nofollow = fsConstants.O_NOFOLLOW ?? 0;
  const parentFd = openSync(parent, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | nofollow);
  try {
    const parentFstat = fstatSync(parentFd);
    if (parentFstat.ino !== parentLstat.ino || parentFstat.dev !== parentLstat.dev) {
      throw symlinkRejected();
    }
  } finally {
    closeSync(parentFd);
  }

  const fd = openSync(filePath, fsConstants.O_RDONLY | nofollow);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile()) throw symlinkRejected();
    const pathLstat = lstatSync(filePath);
    if (pathLstat.isSymbolicLink() || pathLstat.ino !== opened.ino || pathLstat.dev !== opened.dev) {
      throw symlinkRejected();
    }
    try {
      const fdPath = realpathSync(`/proc/self/fd/${fd}`);
      const realRoot = realpathSync(root);
      if (fdPath !== realRoot && !fdPath.startsWith(`${realRoot}${path.sep}`)) {
        throw symlinkRejected();
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ELOOP") throw err;
    }
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}
