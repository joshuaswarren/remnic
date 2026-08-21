import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { deleteInFlightReadsForDir } from "./in-flight-reads.js";
import { invalidateDerivedAndGlobalForDir } from "./memory-cache.js";

/**
 * Filename of the memory-corpus version sentinel (issue #1902). MUST stay in
 * sync with `StorageManager.versionFilePath("memory-corpus")` in storage.ts —
 * the byte size of this append-only file IS the corpus version, and the
 * version-keyed hot-memories result cache keys on it.
 */
export const MEMORY_CORPUS_VERSION_SENTINEL = ".memory-corpus-version.log";

/**
 * Out-of-band corpus-version bump (issue #1902) for code paths that write or
 * modify memory files WITHOUT going through a StorageManager mutation method
 * — review approval, governance restore, migration. Appends one byte to the
 * on-disk sentinel so any process's version-keyed hot-memories cache rescans
 * on its next read (StorageManager.readSharedVersion reads the file size, so
 * the growth is observed immediately). Fail-open: a bump failure must never
 * crash the caller — a stale-cache window self-heals on the next real write.
 */
export function bumpMemoryCorpusVersionForDir(memoryDir: string): void {
  try {
    const stateDir = path.join(memoryDir, "state");
    mkdirSync(stateDir, { recursive: true });
    appendFileSync(path.join(stateDir, MEMORY_CORPUS_VERSION_SENTINEL), "x");
  } catch {
    /* fail-open: never let a cache-coherence bump crash the primary operation */
  }
  // Drop any in-flight readAllMemories scan for this dir (Cursor Medium, #1902):
  // after the sentinel advances, a concurrent read that missed the version-keyed
  // hot entry must not attach to a scan that began BEFORE this out-of-band write
  // and receive a pre-write corpus. Clearing forces a fresh scan of disk truth.
  deleteInFlightReadsForDir(memoryDir);
  // Also evict the TTL-keyed derived (episode/rule) and global (QMD search/recall)
  // caches for this dir (issue #1902, Codex Medium). The sentinel bump self-heals
  // the version-keyed hot cache, but the QMD caches are TTL-keyed, NOT
  // corpus-version-keyed — without this, an out-of-band writer (capsule
  // import/merge, review, spaces, governance restore, page revert, binary
  // redirect) would leave a warm process serving pre-write recall/search results
  // for the remainder of the QMD cache TTL. Route the bump through the same
  // invalidation chokepoint the in-process mutation paths use.
  invalidateDerivedAndGlobalForDir(memoryDir);
}
