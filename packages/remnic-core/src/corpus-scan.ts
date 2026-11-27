
import type { Dirent, Stats } from "node:fs";
import { createHash } from "node:crypto";
import { lstat, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { isErrnoCode } from "./utils/errno.js";
import { isMacOsReplicationJunkBasename } from "./utils/macos-replication-junk.js";

export type ErrnoFailure = NodeJS.ErrnoException;

/**
 * A backend READ failure worth propagating from a strict (census) scan: an
 * errno-coded fs error that is NOT `ENOENT`. `ENOENT` (an absent dir) and
 * code-less rejections are expected and skipped; `EACCES`/`EIO`/… mean the
 * corpus is unreadable and a divergence census must fail loud rather than
 * silently publish a partial count (issue #2156 round-5). Non-strict (recall)
 * callers ignore this and degrade to a best-effort partial scan.
 */
export function isPropagatableReadError(error: ErrnoFailure): boolean {
  return error.code !== undefined && error.code !== "ENOENT";
}

export interface CorpusScanWalkOptions {
  baseDir: string;
  startDirs: readonly string[];
  /** Strict mode: backend read failures propagate instead of being skipped. */
  propagateReadErrors?: boolean;
  /**
   * Cancellation check at every directory/entry boundary. The inline reader
   * passes the corpus-read abort check; the worker passes its cancel flag.
   */
  checkCancelled?(): void;
}

/**
 * Recursively collect `*.md` paths under `startDirs`. Paths only — no
 * frontmatter parse. Never throws for a missing root (an empty result), and
 * throws in strict mode when a backend read failure makes the corpus
 * unreadable.
 *
 * Containment is established once, not per file: the memory root is resolved
 * with a single `realpath`, every directory the walk enters is `lstat`ed (a
 * symlinked or non-directory entry is never followed), and the entry TYPE
 * comes from `readdir(withFileTypes)` — so a symlinked entry, file or
 * directory, is skipped without a per-entry `realpath`. Reads refuse
 * symlinked files at open time with `O_NOFOLLOW`, so a path swapped to a
 * symlink mid-scan is refused rather than followed.
 */
export async function collectContainedMarkdownPaths(options: CorpusScanWalkOptions): Promise<string[]> {
  const { baseDir, startDirs, propagateReadErrors = false, checkCancelled } = options;
  const filePaths: string[] = [];

  try {
    await realpath(baseDir);
  } catch (error) {
    // SAFETY: node:fs/promises rejects with an Error; the errno `code` is
    // optional on that type, so this adds no unchecked claim.
    const failure = error as ErrnoFailure;
    // ENOENT: a not-yet-created root ⇒ empty. Any other errno is a backend
    // read failure — propagate for strict census callers (never publish an
    // unreadable corpus as empty); non-strict (recall) callers degrade.
    if (propagateReadErrors && isPropagatableReadError(failure)) throw error;
    return filePaths;
  }

  const collectPaths = async (dir: string): Promise<void> => {
    checkCancelled?.();
    let dirStat: Stats;
    try {
      dirStat = await lstat(dir);
    } catch (error) {
      // SAFETY: node:fs/promises rejects with an Error; `code` is optional.
      const failure = error as ErrnoFailure;
      // ENOENT (absent category dir) is expected; a backend read error
      // (EACCES/EIO/…) propagates in strict census mode.
      if (propagateReadErrors && isPropagatableReadError(failure)) throw error;
      return;
    }
    if (dirStat.isSymbolicLink()) return; // never follow symlinks out of the store (both modes)
    if (!dirStat.isDirectory()) {
      if (propagateReadErrors) {
        throw new Error(`corpus scan: expected a directory but found a non-directory at ${dir}`);
      }
      return;
    }
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      // SAFETY: node:fs/promises rejects with an Error; `code` is optional.
      const failure = error as ErrnoFailure;
      // A backend read error (EACCES …) propagates in strict census mode so a
      // partial subtree is not silently counted. ENOENT (vanished mid-scan)
      // and other non-propagatable failures skip the directory.
      if (propagateReadErrors && isPropagatableReadError(failure)) throw error;
      return;
    }

    const subdirs: string[] = [];
    for (const entry of entries) {
      checkCancelled?.();
      // Never follow symlinked entries out of the store.
      if (entry.isSymbolicLink()) continue;
      if (isMacOsReplicationJunkBasename(entry.name)) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        subdirs.push(fullPath);
      } else if (entry.name.endsWith(".md")) {
        filePaths.push(fullPath);
      }
    }
    for (const subdir of subdirs) {
      await collectPaths(subdir);
    }
  };

  for (const dir of startDirs) {
    await collectPaths(dir);
  }
  checkCancelled?.();
  return filePaths;
}

/**
 * Fingerprint of the entity entries a migration's completion verdict depends
 * on: the sorted entry names plus each entry's identity and timestamps. Two
 * runs over the same entries produce the same string, and an in-place edit of
 * an entity file changes it.
 */
export async function fingerprintEntityEntries(entitiesDir: string): Promise<string> {
  let names: string[];
  try {
    names = (await readdir(entitiesDir))
      .filter((name) => path.extname(name) === ".md" && !isMacOsReplicationJunkBasename(name))
      .sort();
  } catch (error) {
    if (isErrnoCode(error, "ENOENT")) return "missing";
    throw error;
  }
  const hash = createHash("sha256");
  for (const name of names) {
    hash.update(`${name.length}:${name}:`);
    try {
      const entry = await lstat(path.join(entitiesDir, name), { bigint: true });
      hash.update(`${entry.dev}:${entry.ino}:${entry.size}:${entry.mtimeNs}:${entry.ctimeNs}`);
    } catch (error) {
      if (!isErrnoCode(error, "ENOENT")) throw error;
      hash.update("missing");
    }
    hash.update("\n");
  }
  return hash.digest("hex");
}

/**
 * Stat a batch of files and return their mtimes, `null` for files that
 * vanished (ENOENT). A backend read failure (EACCES/EIO/…) throws with its
 * errno code intact so the caller can omit an unreadable corpus instead of
 * publishing a stale freshness value.
 */
export async function statMtimes(paths: readonly string[]): Promise<Array<number | null>> {
  const results: Array<number | null> = new Array(paths.length).fill(null);
  const STAT_BATCH_SIZE = 256;
  for (let start = 0; start < paths.length; start += STAT_BATCH_SIZE) {
    await Promise.all(paths.slice(start, start + STAT_BATCH_SIZE).map(async (filePath, offset) => {
      try {
        const entry = await stat(filePath);
        results[start + offset] = entry.mtimeMs;
      } catch (error) {
        if (isErrnoCode(error, "ENOENT")) return;
        throw error;
      }
    }));
  }
  return results;
}
