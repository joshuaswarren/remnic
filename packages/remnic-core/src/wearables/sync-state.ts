/**
 * Wearable sync-state ledger — per-source bookkeeping for incremental
 * syncs, stored at `state/wearables/sync.json`.
 *
 * State is written only AFTER a source's transcripts (and any memories)
 * were persisted successfully, so a failed sync never advances the
 * watermark past data that didn't land.
 */

import { promises as fsPromises } from "node:fs";
import * as path from "node:path";

export interface WearableSourceSyncState {
  /** ISO timestamp of the last successful sync run. */
  lastSyncAt: string;
  /** Most recent day (YYYY-MM-DD) that was synced. */
  lastDateSynced: string;
  /** Body hashes of the last-written day files, keyed by date. */
  dayHashes: Record<string, string>;
  /**
   * Body hashes of days whose memory-extraction pass completed without
   * warnings, keyed by date. A day whose entry is missing or stale
   * re-extracts on the next sync even when its transcript is unchanged
   * — this is how a memory pass that failed mid-run (transcript stored,
   * memories incomplete) self-heals. Absent on records written before
   * this field existed.
   */
  memoryDayHashes?: Record<string, string>;
  /** Native-memory ids already imported (bounded, newest kept). */
  importedNativeMemoryIds: string[];
}

export interface WearableSyncStateFile {
  version: 1;
  sources: Record<string, WearableSourceSyncState>;
}

/** Cap on remembered native-memory ids per source. */
const MAX_TRACKED_NATIVE_IDS = 5_000;
/** Cap on remembered day hashes per source (~2 years of days). */
const MAX_TRACKED_DAY_HASHES = 800;

export function syncStateFilePath(memoryDir: string): string {
  return path.join(memoryDir, "state", "wearables", "sync.json");
}

export function emptySyncState(): WearableSyncStateFile {
  return { version: 1, sources: {} };
}

export async function loadSyncState(
  memoryDir: string,
): Promise<WearableSyncStateFile> {
  const filePath = syncStateFilePath(memoryDir);
  let raw: string;
  try {
    raw = await fsPromises.readFile(filePath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return emptySyncState();
    }
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // A corrupt state file should not brick syncing forever; treat it
    // as a cold start (the worst case is re-syncing days we already
    // have, which the day-hash skip makes cheap and idempotent).
    return emptySyncState();
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    typeof (parsed as WearableSyncStateFile).sources !== "object" ||
    (parsed as WearableSyncStateFile).sources === null
  ) {
    return emptySyncState();
  }
  return { version: 1, sources: (parsed as WearableSyncStateFile).sources };
}

export async function saveSyncState(
  memoryDir: string,
  state: WearableSyncStateFile,
): Promise<void> {
  const filePath = syncStateFilePath(memoryDir);
  await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now().toString(36)}`;
  await fsPromises.writeFile(
    tmpPath,
    `${JSON.stringify(state, null, 2)}\n`,
    "utf-8",
  );
  try {
    await fsPromises.rename(tmpPath, filePath);
  } catch (err) {
    await fsPromises.unlink(tmpPath).catch(() => undefined);
    throw err;
  }
}

/** Merge a completed source sync into the state file shape. */
export function updateSourceSyncState(
  state: WearableSyncStateFile,
  sourceId: string,
  update: {
    syncedAt: string;
    days: string[];
    dayHashes: Record<string, string>;
    /** Days whose memory pass completed cleanly this run. */
    memoryDayHashes?: Record<string, string>;
    /**
     * Days whose memory pass ran this sync but did NOT complete
     * cleanly. Their previous completion records are removed so a
     * stale hash from an earlier clean pass can never mask the
     * failure on the next sync.
     */
    clearMemoryDays?: string[];
    importedNativeMemoryIds?: string[];
  },
): WearableSyncStateFile {
  const previous = state.sources[sourceId];
  const mergedHashes: Record<string, string> = {
    ...(previous?.dayHashes ?? {}),
    ...update.dayHashes,
  };
  // Bound the hash map: keep the lexicographically-largest (most
  // recent) dates, which sort naturally for YYYY-MM-DD keys.
  const hashKeys = Object.keys(mergedHashes).sort();
  while (hashKeys.length > MAX_TRACKED_DAY_HASHES) {
    const oldest = hashKeys.shift();
    if (oldest === undefined) break;
    delete mergedHashes[oldest];
  }

  const mergedMemoryHashes: Record<string, string> = {
    ...(previous?.memoryDayHashes ?? {}),
    ...(update.memoryDayHashes ?? {}),
  };
  for (const day of update.clearMemoryDays ?? []) {
    if (!(day in (update.memoryDayHashes ?? {}))) {
      delete mergedMemoryHashes[day];
    }
  }
  const memoryHashKeys = Object.keys(mergedMemoryHashes).sort();
  while (memoryHashKeys.length > MAX_TRACKED_DAY_HASHES) {
    const oldest = memoryHashKeys.shift();
    if (oldest === undefined) break;
    delete mergedMemoryHashes[oldest];
  }

  const mergedNativeIds = [
    ...(previous?.importedNativeMemoryIds ?? []),
    ...(update.importedNativeMemoryIds ?? []),
  ];
  const dedupedNativeIds = [...new Set(mergedNativeIds)];
  const boundedNativeIds =
    dedupedNativeIds.length > MAX_TRACKED_NATIVE_IDS
      ? dedupedNativeIds.slice(dedupedNativeIds.length - MAX_TRACKED_NATIVE_IDS)
      : dedupedNativeIds;

  const sortedDays = [...update.days].sort();
  const latestDay = sortedDays[sortedDays.length - 1];
  const lastDateSynced =
    latestDay !== undefined &&
    (!previous || previous.lastDateSynced < latestDay)
      ? latestDay
      : previous?.lastDateSynced ?? latestDay ?? "";

  return {
    version: 1,
    sources: {
      ...state.sources,
      [sourceId]: {
        lastSyncAt: update.syncedAt,
        lastDateSynced,
        dayHashes: mergedHashes,
        memoryDayHashes: mergedMemoryHashes,
        importedNativeMemoryIds: boundedNativeIds,
      },
    },
  };
}
