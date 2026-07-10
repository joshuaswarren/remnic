import path from "node:path";
import { stat } from "node:fs/promises";
import { StorageManager } from "../storage.js";
import { log } from "../logger.js";
import type { MemoryLifecycleEvent } from "../types.js";
import { toBackupStamp } from "./backup-stamp.js";
import { writeFileAtomically } from "./atomic-file.js";
import {
  buildLifecycleEventsForMemory,
  sortMemoryLifecycleEvents,
} from "../memory-lifecycle-ledger-utils.js";

export interface RebuildMemoryLifecycleLedgerOptions {
  memoryDir: string;
  dryRun?: boolean;
  now?: Date;
}

export interface SkippedLifecycleBlankIdMemory {
  path: string;
}

export interface SkippedDuplicateLifecycleEvent {
  eventId: string;
  keptPath: string;
  skippedPath: string;
}

export interface RebuildMemoryLifecycleLedgerResult {
  dryRun: boolean;
  scannedMemories: number;
  rebuiltRows: number;
  outputPath: string;
  backupPath?: string;
  skippedBlankIdMemories: SkippedLifecycleBlankIdMemory[];
  skippedDuplicateEvents: SkippedDuplicateLifecycleEvent[];
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return typeof err === "object" && err !== null && "code" in err;
}

export async function backupExistingLedger(
  memoryDir: string,
  outputPath: string,
  now: Date,
): Promise<string | undefined> {
  try {
    await stat(outputPath);
  } catch (err) {
    if (isNodeError(err) && err.code === "ENOENT") {
      return undefined;
    }
    throw err;
  }

  const backupPath = path.join(
    memoryDir,
    "archive",
    "memory-lifecycle-ledger",
    toBackupStamp(now),
    "state",
    "memory-lifecycle-ledger.jsonl",
  );
  return backupPath;
}

export async function rebuildMemoryLifecycleLedger(
  options: RebuildMemoryLifecycleLedgerOptions,
): Promise<RebuildMemoryLifecycleLedgerResult> {
  const dryRun = options.dryRun !== false;
  const now = options.now ?? new Date();
  const outputPath = path.join(options.memoryDir, "state", "memory-lifecycle-ledger.jsonl");
  const storage = new StorageManager(options.memoryDir);
  const tiers = [
    await storage.readAllMemories(),
    await storage.readAllColdMemories(),
    await storage.readArchivedMemories(),
  ];
  const allMemories = tiers.flat();
  const skippedBlankIdMemories: SkippedLifecycleBlankIdMemory[] = [];
  const eventCandidates: Array<{ event: MemoryLifecycleEvent; path: string }> = [];
  for (const tier of tiers) {
    for (const memory of [...tier].sort((left, right) => left.path.localeCompare(right.path))) {
      if (!memory.frontmatter.id.trim()) {
        skippedBlankIdMemories.push({ path: memory.path });
        log.warn(`lifecycle ledger rebuild skipped blank memory id: path=${memory.path}`);
        continue;
      }
      for (const event of buildLifecycleEventsForMemory(memory)) {
        eventCandidates.push({ event, path: memory.path });
      }
    }
  }

  const orderedEvents = sortMemoryLifecycleEvents(eventCandidates.map((candidate) => candidate.event));
  const candidateByEvent = new Map(
    eventCandidates.map((candidate) => [candidate.event, candidate]),
  );
  const keptByEventId = new Map<string, { event: MemoryLifecycleEvent; path: string }>();
  const events: MemoryLifecycleEvent[] = [];
  const skippedDuplicateEvents: SkippedDuplicateLifecycleEvent[] = [];
  for (const event of orderedEvents) {
    const candidate = candidateByEvent.get(event)!;
    const kept = keptByEventId.get(event.eventId);
    if (kept) {
      skippedDuplicateEvents.push({
        eventId: event.eventId,
        keptPath: kept.path,
        skippedPath: candidate.path,
      });
      log.warn(
        `lifecycle ledger rebuild skipped duplicate event_id=${event.eventId}: `
        + `kept=${kept.path} skipped=${candidate.path}`,
      );
      continue;
    }
    keptByEventId.set(event.eventId, candidate);
    events.push(event);
  }

  let backupPath: string | undefined;
  if (!dryRun) {
    backupPath = await backupExistingLedger(options.memoryDir, outputPath, now);
    const payload = events.map((event) => JSON.stringify(event)).join("\n");
    backupPath = await writeFileAtomically(
      outputPath,
      payload.length > 0 ? `${payload}\n` : "",
      backupPath,
    );
  }

  return {
    dryRun,
    scannedMemories: allMemories.length,
    rebuiltRows: events.length,
    outputPath,
    backupPath,
    skippedBlankIdMemories,
    skippedDuplicateEvents,
  };
}
