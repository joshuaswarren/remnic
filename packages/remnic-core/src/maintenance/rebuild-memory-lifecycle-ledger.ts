import path from "node:path";
import { stat } from "node:fs/promises";
import { StorageManager } from "../storage.js";
import { log } from "../logger.js";
import type { MemoryLifecycleEvent } from "../types.js";
import { toBackupStamp } from "./backup-stamp.js";
import { copyExistingFileToBackup, writeFileAtomically } from "./atomic-file.js";
import {
  buildLifecycleEventsForMemory,
  sortMemoryLifecycleEvents,
} from "../memory-lifecycle-ledger-utils.js";

/**
 * Event types `buildLifecycleEventsForMemory` reconstructs from frontmatter.
 * Everything else in the ledger is append-only history with no frontmatter
 * equivalent and must be carried over by a preserving rebuild (issue #1910).
 */
const FRONTMATTER_DERIVED_EVENT_TYPES: Record<string, true> = {
  created: true,
  updated: true,
  superseded: true,
  archived: true,
};

export interface RebuildMemoryLifecycleLedgerOptions {
  memoryDir: string;
  dryRun?: boolean;
  now?: Date;
  /**
   * Active storage context (issue #1910). When provided, memories are read
   * through it (so encrypted-at-rest memories in a secure-store deployment are
   * decrypted with the live key) and the rebuilt ledger is rewritten through
   * its secure writer (so it stays encrypted at rest). Its `dir` MUST equal
   * `memoryDir`. When omitted, a fresh plaintext `StorageManager` is used and
   * the ledger is written as plaintext — the CLI default.
   */
  storage?: StorageManager;
  /**
   * Preserve append-only lifecycle events that have no frontmatter equivalent
   * (issue #1910). `buildLifecycleEventsForMemory` only reconstructs
   * `created`/`updated`/`superseded`/`archived` from frontmatter, so a bare
   * rebuild silently drops history like `explicit_capture_accepted`,
   * `explicit_capture_queued`, `imported`, `promoted`, `merged`, `restored`,
   * and `rejected`. When true, the existing ledger's non-reconstructable rows
   * are read (via the same secure/permissive `readAllMemoryLifecycleEvents`
   * path), merged with the rebuilt rows, deduplicated by `eventId`, and sorted
   * canonically. Background auto-compaction sets this so it never loses events;
   * the manual/CLI repair rebuild leaves it off (reconstruct purely from
   * frontmatter).
   */
  preserveExistingEvents?: boolean;
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
  /**
   * Count of append-only rows carried over from the existing ledger because
   * they have no frontmatter equivalent (only set when
   * `preserveExistingEvents` is on; issue #1910).
   */
  preservedAppendOnlyRows?: number;
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
  const storage = options.storage ?? new StorageManager(options.memoryDir);
  const secureRewrite = options.storage !== undefined;
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

  let finalEvents = events;
  let preservedAppendOnlyRows: number | undefined;
  if (options.preserveExistingEvents) {
    // Carry over append-only history frontmatter cannot reconstruct (issue
    // #1910). Read the existing ledger through the permissive readAll path,
    // keep only rows whose eventType is NOT frontmatter-derived, then merge →
    // canonical sort → dedup by eventId (collapsing duplicate appended rows,
    // the point of compaction). Reused verbatim so encrypted-at-rest decrypts
    // with the live key when `storage` carries the secure context.
    let existing: MemoryLifecycleEvent[] = [];
    try {
      existing = await storage.readAllMemoryLifecycleEvents();
    } catch (err) {
      log.warn(`lifecycle ledger rebuild could not read existing events to preserve: ${err}`);
    }
    const preserved = existing.filter(
      (event) => !FRONTMATTER_DERIVED_EVENT_TYPES[event.eventType],
    );
    const mergedById = new Map<string, MemoryLifecycleEvent>();
    for (const event of sortMemoryLifecycleEvents([...events, ...preserved])) {
      if (!mergedById.has(event.eventId)) mergedById.set(event.eventId, event);
    }
    finalEvents = [...mergedById.values()];
    preservedAppendOnlyRows = finalEvents.length - events.length;
  }

  let backupPath: string | undefined;
  if (!dryRun) {
    const desiredBackup = await backupExistingLedger(options.memoryDir, outputPath, now);
    const payload = finalEvents.map((event) => JSON.stringify(event)).join("\n");
    const content = payload.length > 0 ? `${payload}\n` : "";
    if (secureRewrite) {
      // Preserve encrypted-at-rest (issue #1910): back up the existing (possibly
      // encrypted) ledger bytes verbatim, then rewrite through the secure writer
      // so the new ledger is encrypted with the active key.
      backupPath = desiredBackup
        ? await copyExistingFileToBackup(outputPath, desiredBackup)
        : undefined;
      await storage.writeMemoryLifecycleLedgerContent(content);
    } else {
      backupPath = await writeFileAtomically(outputPath, content, desiredBackup);
    }
  }

  return {
    dryRun,
    scannedMemories: allMemories.length,
    rebuiltRows: finalEvents.length,
    outputPath,
    backupPath,
    skippedBlankIdMemories,
    skippedDuplicateEvents,
    preservedAppendOnlyRows,
  };
}
