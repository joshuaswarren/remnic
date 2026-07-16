import { appendFileSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { invalidateAllForDir } from "./memory-cache.js";
import { isErrnoCode } from "./utils/errno.js";

/**
 * Filename of the memory-corpus version sentinel (issue #1902). MUST stay in
 * sync with `StorageManager.versionFilePath("memory-corpus")` in storage.ts —
 * the byte size of this append-only file IS the corpus version, and the
 * version-keyed hot-memories result cache keys on it.
 */
export const MEMORY_CORPUS_VERSION_SENTINEL = ".memory-corpus-version.log";

export function readOrBootstrapMemoryCorpusVersion(stateDir: string): number | null {
  const filePath = path.join(stateDir, MEMORY_CORPUS_VERSION_SENTINEL);
  try {
    mkdirSync(stateDir, { recursive: true });
    try {
      writeFileSync(filePath, "x", { flag: "wx" });
    } catch (error) {
      if (!isErrnoCode(error, "EEXIST")) throw error;
      if (statSync(filePath).size === 0) appendFileSync(filePath, "x");
    }
    return statSync(filePath).size;
  } catch {
    return null;
  }
}

export function classifyMemoryTierPath(
  baseDir: string,
  filePath: string,
): "active" | "cold" | "archive" | "outside" {
  const relative = path.relative(path.resolve(baseDir), path.resolve(filePath));
  if (relative === "" || path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) {
    return "outside";
  }
  const root = relative.split(path.sep, 1)[0];
  return root === "cold" ? "cold" : root === "archive" ? "archive" : "active";
}

/**
 * Out-of-band corpus-version bump (issue #1902) for code paths that write or
 * modify memory files WITHOUT going through a StorageManager mutation method
 * — review approval, governance restore, migration. Appends one byte to the
 * on-disk sentinel so any process's version-keyed hot-memories cache rescans
 * on its next read (StorageManager.readSharedVersion reads the file size, so
 * the growth is observed immediately). Fail-open: a bump failure must never
 * crash the caller; the local cache is still dropped before the append attempt.
 */
export function bumpMemoryCorpusVersionForDir(memoryDir: string): void {
  // Out-of-band writers run in this process too. Drop the local entry before
  // advancing the cross-process sentinel so a failed append still cannot leave
  // this process serving a stale warm corpus indefinitely.
  invalidateAllForDir(memoryDir);
  try {
    const stateDir = path.join(memoryDir, "state");
    mkdirSync(stateDir, { recursive: true });
    appendFileSync(path.join(stateDir, MEMORY_CORPUS_VERSION_SENTINEL), "x");
  } catch {
    /* fail-open: never let a cache-coherence bump crash the primary operation */
  }
}
