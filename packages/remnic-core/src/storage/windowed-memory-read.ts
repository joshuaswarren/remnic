import { stat } from "node:fs/promises";
import path from "node:path";
import { getCachedMemories } from "../memory-cache.js";
import type { MemoryFile } from "../types.js";
import type { MemoryReadStore } from "./memory-read-store.js";

export interface WindowedMemoryReadOptions {
  maxMemories?: number;
  batchSize?: number;
  updatedAfter?: Date;
  /** Require candidate paths so malformed files can be reported by governance. */
  includeMalformedPaths?: boolean;
}

export interface WindowedMemoryReadResult {
  memories: MemoryFile[];
  filePaths: string[];
}

type WindowedMemoryReadStore = Pick<MemoryReadStore, "readMemoriesWindow">;

type HotMemoryCache = {
  enabled: boolean;
  baseDir: string;
  corpusVersion: number;
  cacheKeyId: string;
  ttlMs?: number;
};

/**
 * Serve the briefing-only updatedAfter shape from the warm corpus cache, then
 * delegate all other window reads to MemoryReadStore.
 */
export async function readWindowedMemories(
  store: WindowedMemoryReadStore,
  options: WindowedMemoryReadOptions,
  hotCache: HotMemoryCache,
  rememberMemorySnapshots: (memories: MemoryFile[]) => MemoryFile[]
): Promise<WindowedMemoryReadResult> {
  if (
    hotCache.enabled &&
    options.updatedAfter !== undefined &&
    options.maxMemories === undefined &&
    options.batchSize === undefined &&
    options.includeMalformedPaths !== true
  ) {
    const cached = getCachedMemories(hotCache.baseDir, hotCache.corpusVersion, hotCache.cacheKeyId, hotCache.ttlMs);
    if (cached !== null) {
      const updatedAfterMs = options.updatedAfter.getTime();
      const selected = (
        await Promise.all(
          cached.map(async (memory) => {
            const timestampMs = await readWindowTimestamp(memory);
            return timestampMs === null || timestampMs >= updatedAfterMs ? memory : null;
          })
        )
      ).filter((memory): memory is MemoryFile => memory !== null);
      const memories = orderWindowMemories(selected, hotCache.baseDir);
      return { memories: rememberMemorySnapshots(memories), filePaths: memories.map((memory) => memory.path) };
    }
  }
  return store.readMemoriesWindow(options);
}

async function readWindowTimestamp(memory: MemoryFile): Promise<number | null> {
  const rawTimestamp = memory.frontmatter.updated ?? memory.frontmatter.created;
  const timestampMs = typeof rawTimestamp === "string" ? Date.parse(rawTimestamp) : Number.NaN;
  if (Number.isFinite(timestampMs)) return timestampMs;
  try {
    return (await stat(memory.path)).mtimeMs;
  } catch {
    return null;
  }
}

function orderWindowMemories(memories: MemoryFile[], baseDir: string): MemoryFile[] {
  const correctionsRoot = path.join(baseDir, "corrections");
  const corrections = memories
    .filter((memory) => memory.path === correctionsRoot || memory.path.startsWith(`${correctionsRoot}${path.sep}`))
    .sort((left, right) => right.path.localeCompare(left.path));
  const facts = memories
    .filter((memory) => memory.path !== correctionsRoot && !memory.path.startsWith(`${correctionsRoot}${path.sep}`))
    .sort((left, right) => right.path.localeCompare(left.path));
  const ordered: MemoryFile[] = [];
  for (let index = 0; index < Math.max(corrections.length, facts.length); index += 1) {
    const correction = corrections[index];
    if (correction) ordered.push(correction);
    const fact = facts[index];
    if (fact) ordered.push(fact);
  }
  return ordered;
}
