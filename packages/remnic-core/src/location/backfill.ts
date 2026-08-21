/**
 * Location tag backfill (issue #2046) — idempotent, bounded, LLM-free.
 *
 * For each local day in an explicit [from, to] range, find the memories whose
 * own bi-temporal window touches that day and re-run the shared tagging core
 * over the stored location segments. Provider-owned fields update or remove
 * as the (corrected) observations dictate; manual metadata, unrelated tags,
 * supersession, corrections, and content hashes are untouched by the plan
 * core in `matching.ts`.
 *
 * Failure isolation: one bad day is reported as `failed` and the run
 * continues; one bad memory inside a day counts into `failed` without
 * blocking its neighbors. A day with no stored segments is `emptyDay`, never
 * an error (distinct from a failed day). Re-running the same range yields
 * `unchanged` everywhere and writes nothing.
 */

import type { StorageManager } from "../index.js";
import type { MemoryFile, PluginConfig } from "../types.js";
import { resolveNamespaceCapabilities } from "../capabilities.js";
import { resolveDefaultNamespaceRoot } from "../namespaces/storage.js";
import { StorageManager as StorageManagerClass } from "../storage.js";
import { localDayKey } from "./intervals.js";
import { memoryLocationWindow } from "./matching.js";
import {
  emptyEnrichmentCounts,
  enrichMemoriesWithLocation,
  loadDaySegmentIndex,
  locationTaggingEnabled,
  type DaySegmentIndex,
  type LocationEnrichmentCounts,
} from "./tagging.js";
import type { LocationConfig } from "./types.js";

export interface LocationBackfillDayReport {
  date: string;
  /** No stored segments for any source on this day. */
  emptyDay: boolean;
  failed?: string;
  counts: LocationEnrichmentCounts;
  /** Memories whose window touched the day (empty days report 0). */
  considered: number;
}

export interface LocationBackfillReport {
  from: string;
  to: string;
  dryRun: boolean;
  days: LocationBackfillDayReport[];
}

export interface BackfillLocationTagsOptions {
  storage: Pick<StorageManager, "readAllMemories" | "getMemoryById" | "writeMemoryFrontmatter">;
  memoryDir: string;
  config: LocationConfig;
  from: string;
  to: string;
  dryRun?: boolean;
}

export type BackfillMemoryStorage = Pick<StorageManager, "readAllMemories" | "getMemoryById" | "writeMemoryFrontmatter">;

/**
 * The memory store tag backfill patches: the default-namespace store — the
 * root memory dir when namespaces are off, the resolved default-namespace
 * root when they are on.
 */
export async function backfillMemoryStorage(config: PluginConfig): Promise<StorageManager> {
  const root = resolveNamespaceCapabilities(config).namespaces
    ? await resolveDefaultNamespaceRoot(config)
    : config.memoryDir;
  return new StorageManagerClass(root);
}


/** Memories whose own window touches `day`, in deterministic id order. */
function memoriesTouchingDay(memories: readonly MemoryFile[], day: string, config: LocationConfig): MemoryFile[] {
  const touched: MemoryFile[] = [];
  for (const memory of memories) {
    const result = memoryLocationWindow(memory.frontmatter, (instant) => localDayKey(instant, config.timezone));
    if (result.days !== undefined && result.days.includes(day)) touched.push(memory);
  }
  touched.sort((a, b) => (a.frontmatter.id < b.frontmatter.id ? -1 : a.frontmatter.id > b.frontmatter.id ? 1 : 0));
  return touched;
}

/**
 * Run the bounded backfill. Requires both tagging gates (`location.enabled`
 * and `location.tagging.enabled`); the caller surfaces a clear error for a
 * gated-off run so no surface silently no-ops.
 */
export async function backfillLocationTags(
  options: BackfillLocationTagsOptions,
): Promise<LocationBackfillReport> {
  if (!locationTaggingEnabled(options.config)) {
    throw new Error(
      "location backfill requires location.enabled and location.tagging.enabled (and location.tagging.backfillEnabled for the command surface)",
    );
  }
  const index: DaySegmentIndex = await loadDaySegmentIndex(options.memoryDir);
  const memories = await options.storage.readAllMemories();

  const days: LocationBackfillDayReport[] = [];
  const cursor = new Date(`${options.from}T00:00:00Z`);
  const end = new Date(`${options.to}T00:00:00Z`);
  while (cursor <= end) {
    const date = cursor.toISOString().slice(0, 10);
    try {
      const daySegments = index.get(date);
      if (daySegments === undefined || daySegments.every((entry) => entry.segments.length === 0)) {
        days.push({ date, emptyDay: true, counts: emptyEnrichmentCounts(), considered: 0 });
      } else {
        const touching = memoriesTouchingDay(memories, date, options.config);
        const counts = await enrichMemoriesWithLocation({
          storage: options.storage,
          memoryDir: options.memoryDir,
          config: options.config,
          memories: touching,
          index,
          dryRun: options.dryRun === true,
        });
        days.push({ date, emptyDay: false, counts, considered: touching.length });
      }
    } catch (error) {
      // One failed day never blocks the rest of the range.
      days.push({
        date,
        emptyDay: false,
        failed: error instanceof Error ? error.message : String(error),
        counts: emptyEnrichmentCounts(),
        considered: 0,
      });
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return { from: options.from, to: options.to, dryRun: options.dryRun === true, days };
}
