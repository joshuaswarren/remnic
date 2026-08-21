import { existsSync, lstatSync, readdirSync } from "node:fs";
import path from "node:path";

import { chunkStableId } from "./processor.js";
import type { ChunkEvent } from "./native.js";
import type { Spool } from "./spool.js";

const DEFAULT_CHUNK_MS = 30_000;

export interface OrphanScanInput {
  rawDirectory: string;
  spool: Spool;
}

/**
 * Rebuild chunk events from durable pending rows and leftover WAVs so a
 * restart can feed them through the live processor (issue #2379).
 */
export function scanOrphanedChunks(input: OrphanScanInput): ChunkEvent[] {
  const recovered = new Map<string, ChunkEvent>();
  const quarantined = new Set(input.spool.listPendingChunks("quarantined").map((row) => row.id));

  for (const row of input.spool.listPendingChunks("evicted")) {
    if (quarantined.has(row.id)) continue;
    if (input.spool.isChunkApplied(`${row.id}:done`)) continue;
    if (!existsSync(row.wavPath)) continue;
    recovered.set(row.id, {
      path: row.wavPath,
      channel: row.channel,
      startedAtUtc: row.startedAtUtc,
      endedAtUtc: row.endedAtUtc,
      device: row.device,
    });
  }

  let root;
  try {
    root = lstatSync(input.rawDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [...recovered.values()].sort(byStart);
    }
    throw error;
  }
  if (root.isSymbolicLink() || !root.isDirectory()) return [...recovered.values()].sort(byStart);

  for (const name of readdirSync(input.rawDirectory)) {
    if (!name.endsWith(".wav")) continue;
    const location = path.join(input.rawDirectory, name);
    let stat;
    try {
      stat = lstatSync(location);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (!stat.isFile()) continue;
    const event: ChunkEvent = {
      path: location,
      channel: "mic",
      startedAtUtc: new Date(stat.mtimeMs - DEFAULT_CHUNK_MS).toISOString(),
      endedAtUtc: new Date(stat.mtimeMs).toISOString(),
      device: null,
    };
    const id = chunkStableId(event);
    if (quarantined.has(id) || recovered.has(id)) continue;
    if (input.spool.isChunkApplied(`${id}:done`)) continue;
    recovered.set(id, event);
  }

  return [...recovered.values()].sort(byStart);
}

function byStart(left: ChunkEvent, right: ChunkEvent): number {
  if (left.startedAtUtc !== right.startedAtUtc) return left.startedAtUtc < right.startedAtUtc ? -1 : 1;
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}
