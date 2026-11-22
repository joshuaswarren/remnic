import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { entityMentionEpoch } from "./entity-mention-epoch.js";
import { deleteInFlightReadsForDir } from "./in-flight-reads.js";
import { invalidateDerivedAndGlobalForDir } from "./memory-cache.js";

export const MEMORY_CORPUS_VERSION_SENTINEL = ".memory-corpus-version.log";

/**
 * Out-of-band corpus-version bump (issue #1902) for code paths that write or
 * modify memory files WITHOUT going through a StorageManager mutation method
 * — review approval, governance restore, migration. Appends one byte to the
 * on-disk sentinel so any process's version-keyed hot-memories cache rescans
 * on its next read (StorageManager.readSharedVersion reads the file size, so
 * the growth is observed immediately). The same call moves the entity-mention
 * epoch, unless the caller passes `{ indexedText: false }` for a metadata
 * stamp that cannot change snippet text, entityRef, or origin. Fail-open: a
 * bump failure must never crash the caller — a stale-cache window self-heals
 * on the next real write.
 */
export function bumpMemoryCorpusVersionForDir(
  memoryDir: string,
  options?: { indexedText?: boolean },
): void {
  try {
    const stateDir = path.join(memoryDir, "state");
    mkdirSync(stateDir, { recursive: true });
    appendFileSync(path.join(stateDir, MEMORY_CORPUS_VERSION_SENTINEL), "x");
  } catch {
    /* fail-open: never let a cache-coherence bump crash the primary operation */
  }
  if (options?.indexedText !== false && !entityMentionEpoch.suppressed()) {
    entityMentionEpoch.bump(memoryDir);
  }
  deleteInFlightReadsForDir(memoryDir);
  invalidateDerivedAndGlobalForDir(memoryDir);
}
