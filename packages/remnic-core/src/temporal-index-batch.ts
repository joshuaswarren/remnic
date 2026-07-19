/**
 * Batch temporal/tag index mutations.
 *
 * Split from temporal-index.ts (issue #1911B / #1995): maintenance loops that
 * add or invalidate N memories at once collect their entries and call these once
 * instead of paying the per-memory read-parse-stringify-write amplification.
 * Both operations reuse the low-level primitives exported from temporal-index.ts;
 * per-entry semantics are byte-identical to indexMemoryAsync / deindexMemoryAsync.
 */

import {
  INDEX_VERSION,
  addPathToSet,
  addTagGraphEntry,
  ensureStateDir,
  isoDateFromTimestamp,
  removePathFromAllSets,
  removePathFromAllTagEntries,
  removePathFromSet,
  removeTagGraphEntry,
  temporalEventFromEntry,
  updateTagIndex,
  updateTemporalIndex,
  withMemoryDirMutex,
  type TemporalIndexEntry,
} from "./temporal-index.js";

/**
 * Batch-add multiple memories to both indexes in a single read-modify-write cycle.
 * More efficient than calling indexMemoryAsync() per file when adding many at once.
 */
export async function indexMemoriesBatchAsync(
  memoryDir: string,
  entries: TemporalIndexEntry[]
): Promise<void> {
  if (entries.length === 0) return;
  try {
    await ensureStateDir(memoryDir);

    await withMemoryDirMutex(memoryDir, async () => {
      const temporalOk = await updateTemporalIndex(memoryDir, (index) => {
        index.version = INDEX_VERSION;
        for (const entry of entries) {
          const dateKey = isoDateFromTimestamp(entry.createdAt);
          removePathFromAllSets(index.dates, entry.path);
          addPathToSet(index.dates, dateKey, entry.path);
          index.events[entry.path] = temporalEventFromEntry(entry);
        }
      });
      if (temporalOk) {
        await updateTagIndex(memoryDir, (index) => {
          for (const entry of entries) {
            removePathFromAllTagEntries(index, entry.path);
            for (const tag of entry.tags) {
              if (tag && typeof tag === "string") {
                addTagGraphEntry(index, tag, entry.path);
              }
            }
          }
        });
      }
    });
  } catch {
    // Fail silently
  }
}

/**
 * Batch-remove multiple memories from both indexes in a single read-modify-write
 * cycle per index. Mirrors {@link indexMemoriesBatchAsync}: maintenance loops that
 * invalidate/archive N memories collect their entries and call this once, replacing
 * the O(N) full read-parse-stringify-write amplification of per-memory
 * deindexMemoryAsync with O(1) temporal + O(1) tag write cycles.
 *
 * Per-entry semantics are byte-identical to deindexMemoryAsync: the date
 * set for each entry's `createdAt` drops the path, the temporal event is deleted,
 * and each tag graph entry is removed. The temporal half commits first; the tag
 * half only runs if it succeeds, so a partial failure never leaves tags orphaned
 * from a temporal entry that still exists.
 */
export async function deindexMemoriesBatchAsync(
  memoryDir: string,
  entries: ReadonlyArray<Pick<TemporalIndexEntry, "path" | "createdAt" | "tags">>,
): Promise<void> {
  if (entries.length === 0) return;
  try {
    await ensureStateDir(memoryDir);

    await withMemoryDirMutex(memoryDir, async () => {
      const temporalOk = await updateTemporalIndex(memoryDir, (index) => {
        for (const entry of entries) {
          const dateKey = isoDateFromTimestamp(entry.createdAt);
          removePathFromSet(index.dates, dateKey, entry.path);
          delete index.events[entry.path];
        }
      });
      if (temporalOk) {
        await updateTagIndex(memoryDir, (index) => {
          for (const entry of entries) {
            for (const tag of entry.tags) {
              if (tag && typeof tag === "string") {
                removeTagGraphEntry(index, tag, entry.path);
              }
            }
          }
        });
      }
    });
  } catch {
    // Fail silently — indexes are advisory only
  }
}
