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

/**
 * Publisher-owned daily-note heading sections that must never count as
 * journal text (issue #2872): every daily target KNOWN TO CONFIG, enabled or
 * not. A target that was enabled when it wrote "## Timeline" sections keeps
 * owning them after it is disabled — disabling must not resurrect historical
 * published output as journal text. Weekly targets never own daily-note
 * sections.
 */
export function publisherOwnedSectionNames(vault: ActivityTimelineVaultConfig): string[] {
  if (vault.sectionStrategy !== "heading") return [];
  const names: string[] = [];
  for (const target of Object.values(vault.publish)) {
    if (target.target === "daily" && target.section.trim().length > 0) {
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
 * Open the daily note through a descriptor-bound, /proc-free parent chain
 * (issue #2872): every ancestor from the vault root down is opened with
 * O_NOFOLLOW|O_DIRECTORY, pinned by fd, and checked for fd↔lstat identity at
 * each step; the note itself is opened O_NOFOLLOW with the same identity
 * check, and the deepest pinned directory fd is re-compared by path after the
 * note open so a swapped parent directory between the walk and the read
 * changes the inode and is refused. Works on Linux, macOS, and Windows — no
 * /proc/self/fd resolution (absent outside Linux). Exactly one readFile of
 * the verified fd.
 */
export interface VerifiedDailyNoteIo {
  /**
   * Injectable open seam (tests swap directory entries mid-chain to prove the
   * identity checks refuse). Defaults to node:fs openSync.
   */
  open?: (filePath: string, flags: number) => number;
}

export function readVerifiedDailyNote(
  root: string,
  filePath: string,
  io: VerifiedDailyNoteIo = {},
): string {
  const open = io.open ?? openSync;
  const nofollow = fsConstants.O_NOFOLLOW ?? 0;
  const dirFlags = fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | nofollow;
  const relative = path.relative(root, filePath);
  const parts = relative.split(path.sep).filter((part) => part.length > 0 && part !== ".");
  const held: number[] = [];
  try {
    // Root: the caller already verified it is a non-symlink directory; pin it
    // by fd so the identity checks below compare against a stable inode.
    const rootLstat = lstatSync(root);
    if (rootLstat.isSymbolicLink() || !rootLstat.isDirectory()) throw symlinkRejected();
    const rootFd = open(root, dirFlags);
    held.push(rootFd);
    if (!sameNode(fstatSync(rootFd), rootLstat)) throw symlinkRejected();

    // Intermediate directories: lstat non-symlink dir, open no-follow, pin.
    for (let depth = 0; depth < parts.length - 1; depth += 1) {
      const childPath = path.join(root, ...parts.slice(0, depth + 1));
      const childLstat = lstatSync(childPath);
      if (childLstat.isSymbolicLink() || !childLstat.isDirectory()) throw symlinkRejected();
      const childFd = open(childPath, dirFlags);
      held.push(childFd);
      if (!sameNode(fstatSync(childFd), childLstat)) throw symlinkRejected();
    }

    // The note: lstat a regular non-symlink file, open no-follow, and bind
    // the opened fd to that same inode.
    const noteLstat = lstatSync(filePath);
    if (noteLstat.isSymbolicLink() || !noteLstat.isFile()) throw symlinkRejected();
    const fd = open(filePath, fsConstants.O_RDONLY | nofollow);
    try {
      const opened = fstatSync(fd);
      if (!opened.isFile()) throw symlinkRejected();
      if (!sameNode(opened, noteLstat)) throw symlinkRejected();
      // The deepest pinned directory is the note's parent. Re-open it by
      // path and compare inodes: a directory swapped in between the walk and
      // the note open no longer matches the pinned fd and is refused. A
      // parent that vanished mid-read is tampering, not a missing day.
      const parentFd = openParentOrFail(open, path.dirname(filePath), dirFlags);
      try {
        if (!sameNode(fstatSync(parentFd), fstatSync(held[held.length - 1]!))) {
          throw symlinkRejected();
        }
      } finally {
        closeSync(parentFd);
      }
      return readFileSync(fd, "utf8");
    } finally {
      closeSync(fd);
    }
  } finally {
    for (const fd of held) closeSync(fd);
  }
}

function openParentOrFail(
  open: (filePath: string, flags: number) => number,
  parent: string,
  dirFlags: number,
): number {
  try {
    return open(parent, dirFlags);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP") throw symlinkRejected();
    throw err;
  }
}

/**
 * Inode identity between an fd's fstat and a path's lstat. On filesystems
 * without stable node ids both sides read zero and this check is vacuous —
 * containment then rests on the no-follow opens and the symlink lstat
 * refusals, the same guarantees the /proc variant had off Linux.
 */
function sameNode(a: { ino: number; dev: number }, b: { ino: number; dev: number }): boolean {
  return a.ino === b.ino && a.dev === b.dev;
}
