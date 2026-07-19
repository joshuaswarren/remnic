/**
 * @remnic/core — Path Containment Guards
 *
 * Shared symlink/traversal containment helpers for filesystem walkers that
 * scan the memory store. Extracted from search/document-scanner.ts so every
 * walker (the search index scanner, the CLI dedupe walker, ...) enforces the
 * SAME containment semantics instead of forking the check (CLAUDE.md rule 22).
 *
 * Both helpers operate on realpath()-resolved absolute paths: callers resolve
 * symlinks first, then assert the resolved target is still inside the (also
 * realpath-resolved) memory root. This blocks a symlinked category directory
 * (e.g. decisions/ → /etc) from redirecting a scan — or a destructive dedupe
 * unlink — outside the memory store.
 */

import path from "node:path";
import { lstat, mkdir, readdir, realpath } from "node:fs/promises";
import { isErrnoCode } from "./errno.js";

/**
 * True when `child` is `parent` itself or nested underneath it. Both arguments
 * must already be resolved (realpath) absolute paths.
 */
export function pathIsInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Throw if the realpath-resolved `candidateReal` escapes `rootReal`. The
 * message references the original (pre-realpath) path so operators can locate
 * the offending symlink/entry.
 */
export function assertPathInsideRoot(
  rootReal: string,
  candidateReal: string,
  originalPath: string,
): void {
  if (!pathIsInside(rootReal, candidateReal)) {
    throw new Error(`Refusing to scan memory path outside memoryDir: ${originalPath}`);
  }
}

/**
 * List the regular-file children of `dir` whose name ends in `suffix` (default
 * `.jsonl`) in sorted name order as absolute paths, rejecting a symlinked/
 * non-directory `dir` and skipping any entry that is a symlink or whose realpath
 * escapes `dir`. Returns `[]` when the directory is absent or cannot be safely
 * enumerated. Used by the durable pending-spill drains (lifecycle ledger +
 * recall impressions, #2033) so a poisoned link planted in a spill directory
 * cannot redirect a secure read — or a later unlink — outside that directory.
 * The `suffix` override lets the lifecycle drain enumerate crash-orphaned
 * `*.jsonl.claimed` files with the SAME containment guard as live spills.
 */
export async function listContainedSpillFiles(dir: string, suffix = ".jsonl"): Promise<string[]> {
  let dirReal: string;
  try {
    const dirStat = await lstat(dir);
    if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) return [];
    dirReal = await realpath(dir);
  } catch (err) {
    if (isErrnoCode(err, "ENOENT")) return [];
    throw err;
  }
  let names: string[];
  try {
    names = (await readdir(dir)).filter((name) => name.endsWith(suffix)).sort();
  } catch (err) {
    if (isErrnoCode(err, "ENOENT")) return [];
    throw err;
  }
  const files: string[] = [];
  for (const name of names) {
    const filePath = path.join(dir, name);
    let entryStat;
    try {
      entryStat = await lstat(filePath);
    } catch (err) {
      if (isErrnoCode(err, "ENOENT")) continue; // vanished between readdir and lstat
      throw err;
    }
    // Reject a symlinked entry or one whose real target escapes the spill dir
    // BEFORE any secure read/delete: a poisoned link must never redirect a
    // decrypt or a later unlink outside the directory (#2033).
    if (entryStat.isSymbolicLink() || !entryStat.isFile()) continue;
    let entryReal: string;
    try {
      entryReal = await realpath(filePath);
    } catch (err) {
      if (isErrnoCode(err, "ENOENT")) continue;
      throw err;
    }
    if (!pathIsInside(dirReal, entryReal)) continue;
    files.push(filePath);
  }
  return files;
}

/**
 * Create `dir` (recursively, if absent) and assert it is a REAL directory —
 * never a symlink — BEFORE any spill file is written into it (#2033). This
 * mirrors the lstat guard {@link listContainedSpillFiles} applies on the read
 * side so the durable-spill WRITE and its later drain enforce the SAME
 * symlink-safe containment: a symlink planted at the spill-directory path (e.g.
 * `<ledger>.pending.d` -> /etc) cannot redirect a write/rename/unlink outside
 * the intended location. `mkdir` recursive is a no-op when the path already
 * resolves through a symlink, so the post-mkdir lstat is what actually refuses
 * the poisoned link. Throws on a symlinked or non-directory target.
 */
export async function ensureContainedSpillDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  const dirStat = await lstat(dir);
  if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
    throw new Error(`Refusing to write spill file into symlinked or non-directory path: ${dir}`);
  }
}
