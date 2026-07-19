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
  memoryLifecycleLedgerLockPath,
  MEMORY_LIFECYCLE_LEDGER_LOCK_STALE_MS,
} from "../memory-lifecycle-ledger-utils.js";
import { withHeldFileLock, type HeldFileLockOptions } from "../utils/serialize-mutations.js";

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
  /**
   * Override the ledger-lock acquisition timing (issue #2033). Only
   * `maxWaitMs`/`pollMs` are honored; `staleMs` stays fixed at
   * `MEMORY_LIFECYCLE_LEDGER_LOCK_STALE_MS`. Used by tests to force the
   * lock-acquisition-failure branch (`acquired=false`) deterministically
   * without a multi-second wait.
   */
  lockOptions?: Pick<HeldFileLockOptions, "maxWaitMs" | "pollMs">;
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
   * Count of existing-ledger rows carried over beyond the frontmatter
   * reconstruction (only set when `preserveExistingEvents` is on; issue #1910):
   * append-only history with no frontmatter equivalent, plus any
   * frontmatter-derived row that raced in after the corpus scan and so was not
   * reproduced by the reconstruction (#2033).
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
  if (options.storage && path.resolve(storage.dir) !== path.resolve(options.memoryDir)) {
    throw new Error(
      `rebuildMemoryLifecycleLedger: storage.dir (${storage.dir}) must match `
      + `memoryDir (${options.memoryDir})`,
    );
  }
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
  let backupPath: string | undefined;
  // Serialize the preserve-read and the whole-file rewrite against concurrent
  // lifecycle appends (issue #1910, codex). appendMemoryLifecycleEvents holds
  // this same cross-process lock, so an event appended after the preserve-read
  // but before the atomic rename waits and lands on the compacted ledger
  // instead of being clobbered by the rename that replaces the file. The
  // corpus scan above stays outside the lock — frontmatter-derived rows are
  // reconstructed from the memory files, not the ledger.
  const runLedgerCriticalSection = async (acquired: boolean): Promise<void> => {
    // withHeldFileLock falls back to task(false) when it cannot acquire the
    // lock within the budget. A rebuild that read or rewrote the ledger without
    // the lock could race a concurrent append/rewrite and lose data, so REFUSE
    // the unlocked fallback outright (issue #2033 CodeRabbit Critical / codex).
    if (!acquired) {
      throw new Error(
        "lifecycle ledger rebuild aborted: could not acquire the ledger lock within the "
        + "acquisition budget; refusing to read or rewrite unlocked so a concurrent append "
        + "or compaction cannot be clobbered (issue #1910).",
      );
    }
    if (options.preserveExistingEvents) {
      // Merge the frontmatter reconstruction (`events`) with the CURRENT ledger
      // so compaction never deletes a lifecycle row that raced the scan (issue
      // #1910, #2033). Read the existing ledger through the uncapped BUFFER
      // path — it decrypts with the live key when `storage` carries the secure
      // context and bypasses the whole-file string decrypt cap, so an oversize
      // encrypted ledger (the exact file compaction must shrink) is still
      // readable here rather than aborting (#2033 Cursor High).
      // preserveExistingEvents means "never lose history": if the current
      // ledger genuinely cannot be read (corruption, or a locked required
      // store), ABORT rather than rewrite from frontmatter only and silently
      // drop that history. An absent ledger reads as [] (ENOENT swallowed
      // downstream), so a throw here is always a real read failure.
      let existing: MemoryLifecycleEvent[];
      try {
        existing = await storage.readAllMemoryLifecycleEventsForCompaction();
      } catch (err) {
        throw new Error(
          `lifecycle ledger rebuild aborted: cannot read existing events to preserve `
          + `(${err instanceof Error ? err.message : String(err)})`,
        );
      }
      // The corpus scan (`events`) runs OUTSIDE the lock and is therefore a
      // stale snapshot; `existing` is read here under the lock and is
      // authoritative for what the ledger holds at rewrite time. A
      // frontmatter-derived row (created/updated/superseded/archived) is safe to
      // collapse into the reconstruction ONLY when the scan actually reproduced
      // the same logical event — same (memoryId, eventType, timestamp), which is
      // exactly what the live append stamps (fm.created/updated/...) and what
      // makeRebuiltMemoryLifecycleEvent emits. A frontmatter-derived row whose
      // content key the reconstruction did NOT produce raced in after the scan
      // (a memory created/updated between the scan and this locked read); the
      // reconstruction has no equivalent, so dropping it by eventType alone
      // would delete it. Preserve it instead, deduped by content key so a
      // retried append of the same logical event still collapses to one. Rows
      // that are not frontmatter-derived are append-only history with no
      // reconstruction — always carried over, deduped by eventId in the merge.
      const contentKey = (event: MemoryLifecycleEvent): string =>
        `${event.memoryId}\u0000${event.eventType}\u0000${event.timestamp}`;
      const reconstructedKeys = new Set(events.map(contentKey));
      const racedFrontmatterByKey = new Map<string, MemoryLifecycleEvent>();
      const appendOnly: MemoryLifecycleEvent[] = [];
      for (const event of existing) {
        if (!FRONTMATTER_DERIVED_EVENT_TYPES[event.eventType]) {
          appendOnly.push(event);
          continue;
        }
        const key = contentKey(event);
        if (reconstructedKeys.has(key)) continue; // collapsed into reconstruction
        if (!racedFrontmatterByKey.has(key)) racedFrontmatterByKey.set(key, event);
      }
      const mergedById = new Map<string, MemoryLifecycleEvent>();
      for (const event of sortMemoryLifecycleEvents([
        ...events,
        ...racedFrontmatterByKey.values(),
        ...appendOnly,
      ])) {
        if (!mergedById.has(event.eventId)) mergedById.set(event.eventId, event);
      }
      finalEvents = [...mergedById.values()];
      preservedAppendOnlyRows = finalEvents.length - events.length;
    }

    if (!dryRun) {
      const desiredBackup = await backupExistingLedger(options.memoryDir, outputPath, now);
      const payload = finalEvents.map((event) => JSON.stringify(event)).join("\n");
      const content = payload.length > 0 ? `${payload}\n` : "";
      if (secureRewrite) {
        // Preserve encrypted-at-rest (issue #1910): back up the existing
        // (possibly encrypted) ledger bytes verbatim, then rewrite through the
        // secure writer so the new ledger is encrypted with the active key.
        backupPath = desiredBackup
          ? await copyExistingFileToBackup(outputPath, desiredBackup)
          : undefined;
        await storage.writeMemoryLifecycleLedgerContent(content);
      } else {
        backupPath = await writeFileAtomically(outputPath, content, desiredBackup);
      }
    }
  };
  // Only hold the lock when the ledger is actually read or rewritten. A
  // no-preserve dry run touches nothing, so it must not create the state dir or
  // a transient lock file as a side effect.
  if (options.preserveExistingEvents || !dryRun) {
    await withHeldFileLock(
      memoryLifecycleLedgerLockPath(outputPath),
      { staleMs: MEMORY_LIFECYCLE_LEDGER_LOCK_STALE_MS, ...options.lockOptions },
      runLedgerCriticalSection,
    );
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
