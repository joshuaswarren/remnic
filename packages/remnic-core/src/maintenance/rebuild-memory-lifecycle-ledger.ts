import path from "node:path";
import { stat } from "node:fs/promises";
import { StorageManager } from "../storage.js";
import { assertInjectedStorageRooted } from "./projection-support.js";
import { log } from "../logger.js";
import { displayErrorDetail } from "../runtime/better-sqlite.js";
import type { MemoryLifecycleEvent } from "../types.js";
import { toBackupStamp } from "./backup-stamp.js";
import { copyExistingFileToBackup, writeFileAtomically } from "./atomic-file.js";
import {
  buildLifecycleEventsForMemory,
  compareMemoryLifecycleEvents,
  sortMemoryLifecycleEvents,
  isFrontmatterDerivedLifecycleEventType,
  memoryLifecycleEventProjectionIdentity,
  memoryLifecycleLedgerLockPath,
  MEMORY_LIFECYCLE_LEDGER_LOCK_STALE_MS,
} from "../memory-lifecycle-ledger-utils.js";
import { withHeldFileLock, type HeldFileLockOptions, type HeldFileLockController } from "../utils/serialize-mutations.js";
import { probeEncryptedRegularFileHeader } from "../secure-store/secure-fs.js";
import { isErrnoCode } from "../utils/errno.js";


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
  /**
   * Upper bound (bytes) on the rewritten ledger when preserving events (issue
   * #2033). A preserving compaction carries over ALL append-only history, which
   * — if the history alone is large — could leave the rewritten ledger over the
   * whole-file read/decrypt cap (STATE_FILE_MAX_DECRYPT_BYTES), the exact
   * unreadable-ledger failure compaction exists to prevent. When set and the
   * preserved payload would exceed it, the OLDEST rows are dropped from the
   * active ledger until it fits; because the full pre-compaction ledger is
   * copied verbatim to the timestamped backup first, those rows are archived,
   * not lost. Ignored when `preserveExistingEvents` is off (a frontmatter-only
   * rebuild is already bounded by the corpus). `0`/undefined disables bounding.
   */
  maxLedgerBytes?: number;
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
  /**
   * Count of oldest rows dropped from the ACTIVE ledger to keep it under
   * `maxLedgerBytes` (issue #2033). They remain in the verbatim timestamped
   * backup, so this is a bound-and-archive, not a loss. Set only when bounding
   * actually trimmed rows.
   */
  archivedOverflowRows?: number;
  /**
   * Whether the active ledger was actually backed up and rewritten (issue #2033
   * thread PRRT_kwDORJXyws6SExst). A preserving write-mode rebuild that would
   * reproduce the current ledger byte-for-byte (same decrypted content AND same
   * at-rest format) skips the backup+rewrite, so callers can distinguish a real
   * compaction from a no-op and avoid re-archiving an unchanged ledger every
   * interval. `true` for every dry run's non-write preview is never set — only
   * write-mode results carry it; defaults to `false` when no rewrite happened.
   */
  rewritten?: boolean;
}

function lifecycleRowBytes(event: MemoryLifecycleEvent): number {
  return Buffer.byteLength(`${JSON.stringify(event)}\n`, "utf8");
}

/**
 * Keep the NEWEST canonically-ordered events whose serialized payload fits
 * strictly under `cap` bytes (issue #2033). Recency is by `timestamp` (newest
 * first), tie-broken by the canonical comparator, so a large append-only
 * history is trimmed to its most recent rows rather than to a single memoryId
 * group (the ledger's on-disk order is by memoryId then time).
 *
 * A row too large to fit the remaining budget is SKIPPED, and scanning
 * continues to older rows that still fit — one oversized (or future-dated,
 * hence recency-first) row cannot truncate the entire older history. The kept
 * subset is returned in the input's canonical order; the caller relies on the
 * verbatim backup to retain the dropped rows.
 */
export function boundLifecycleEventsToByteCap(
  events: MemoryLifecycleEvent[],
  cap: number,
): { kept: MemoryLifecycleEvent[]; dropped: number } {
  if (!(cap > 0)) return { kept: events, dropped: 0 };
  const sizes = new Map<MemoryLifecycleEvent, number>();
  let total = 0;
  for (const event of events) {
    const bytes = lifecycleRowBytes(event);
    sizes.set(event, bytes);
    total += bytes;
  }
  if (total <= cap) return { kept: events, dropped: 0 };
  const byRecency = [...events].sort((a, b) => {
    if (a.timestamp !== b.timestamp) return b.timestamp.localeCompare(a.timestamp);
    return -compareMemoryLifecycleEvents(a, b);
  });
  const keep = new Set<MemoryLifecycleEvent>();
  let running = 0;
  for (const event of byRecency) {
    const bytes = sizes.get(event)!;
    if (running + bytes > cap) continue; // skip this row, keep scanning older rows that still fit
    running += bytes;
    keep.add(event);
  }
  const kept = events.filter((event) => keep.has(event));
  return { kept, dropped: events.length - kept.length };
}

export async function backupExistingLedger(
  memoryDir: string,
  outputPath: string,
  now: Date,
): Promise<string | undefined> {
  try {
    await stat(outputPath);
  } catch (err) {
    if (isErrnoCode(err, "ENOENT")) {
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
  const storage = assertInjectedStorageRooted("rebuildMemoryLifecycleLedger", options.memoryDir, options.storage) ?? new StorageManager(options.memoryDir);
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
  let archivedOverflowRows: number | undefined;
  let backupPath: string | undefined;
  let rewritten = false;
  const runLedgerCriticalSection = async (
    acquired: boolean,
    lock: HeldFileLockController | null,
  ): Promise<void> => {
    if (!dryRun && !acquired) {
      throw new Error(
        "lifecycle ledger rebuild aborted: could not acquire the ledger lock within the "
        + "acquisition budget; refusing to read or rewrite unlocked so a concurrent append "
        + "or compaction cannot be clobbered (issue #1910).",
      );
    }
    if (options.preserveExistingEvents) {
      let existing: MemoryLifecycleEvent[];
      try {
        existing = await storage.readAllMemoryLifecycleEventsForCompaction();
      } catch (err) {
        throw new Error(
          `lifecycle ledger rebuild aborted: cannot read existing events to preserve `
          + `(${displayErrorDetail(err) || "unknown error"})`,
        );
      }
      const reconstructedKeys = new Set(events.map(memoryLifecycleEventProjectionIdentity));
      const racedFrontmatterByKey = new Map<string, MemoryLifecycleEvent>();
      const appendOnly: MemoryLifecycleEvent[] = [];
      for (const event of existing) {
        if (!isFrontmatterDerivedLifecycleEventType(event.eventType)) {
          appendOnly.push(event);
          continue;
        }
        const key = memoryLifecycleEventProjectionIdentity(event);
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
      if (options.maxLedgerBytes && options.maxLedgerBytes > 0) {
        const bounded = boundLifecycleEventsToByteCap(finalEvents, options.maxLedgerBytes);
        if (bounded.dropped > 0) {
          finalEvents = bounded.kept;
          archivedOverflowRows = bounded.dropped;
          log.warn(
            `lifecycle ledger rebuild bounded to ${options.maxLedgerBytes} bytes: `
            + `dropped ${bounded.dropped} oldest row(s) from the active ledger `
            + `(preserved in the backup) to stay under the read/decrypt cap.`,
          );
        }
      }
    }

    const abortIfLockLost = async (): Promise<void> => {
      if (lock && await lock.refresh()) return;
      throw new Error(
        "lifecycle ledger rebuild aborted: lost the ledger lock during the compaction "
        + "rewrite (a peer stale-broke it while the event loop was blocked by CPU-bound "
        + "merge/serialize); refusing to clobber a concurrent append (issue #1910/#2033).",
      );
    };
    if (!dryRun) {
      const payload = finalEvents.map((event) => JSON.stringify(event)).join("\n");
      const content = payload.length > 0 ? `${payload}\n` : "";
      let currentEncrypted = false;
      let priorRawBuffer: Buffer | null = null;
      try {
        currentEncrypted = await probeEncryptedRegularFileHeader(outputPath);
        priorRawBuffer = await storage.readMemoryLifecycleLedgerRawBufferForCompaction();
      } catch (err) {
        if (!isErrnoCode(err, "ENOENT")) throw err;
      }
      const forceEncrypt =
        secureRewrite && currentEncrypted && storage.isSecureStoreUnlocked();
      const replacementEncrypted =
        secureRewrite && (storage.willEncryptStateWrites() || forceEncrypt);
      if (
        priorRawBuffer !== null &&
        currentEncrypted === replacementEncrypted &&
        priorRawBuffer.equals(Buffer.from(content, "utf8"))
      ) {
        rewritten = false;
      } else {
        const desiredBackup = await backupExistingLedger(options.memoryDir, outputPath, now);
        if (secureRewrite) {
          if (desiredBackup && currentEncrypted) {
            const rawForBackup =
              priorRawBuffer ?? (await storage.readMemoryLifecycleLedgerRawBufferForCompaction());
            await storage.writeMemoryLifecycleLedgerContent(rawForBackup, desiredBackup, forceEncrypt);
            backupPath = desiredBackup;
          } else {
            backupPath = desiredBackup
              ? await copyExistingFileToBackup(outputPath, desiredBackup)
              : undefined;
          }
          await abortIfLockLost();
          await storage.writeMemoryLifecycleLedgerContent(content, undefined, forceEncrypt);
        } else {
          await abortIfLockLost();
          backupPath = await writeFileAtomically(outputPath, content, desiredBackup);
        }
        rewritten = true;
      }
    }
  };
  if (!dryRun) {
    await withHeldFileLock(
      memoryLifecycleLedgerLockPath(outputPath),
      { staleMs: MEMORY_LIFECYCLE_LEDGER_LOCK_STALE_MS, ...options.lockOptions },
      runLedgerCriticalSection,
    );
  } else if (options.preserveExistingEvents) {
    await runLedgerCriticalSection(true, null);
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
    archivedOverflowRows,
    rewritten,
  };
}
