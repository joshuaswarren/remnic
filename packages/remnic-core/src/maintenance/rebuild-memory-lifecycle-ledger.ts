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

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return typeof err === "object" && err !== null && "code" in err;
}

/** Serialized on-disk size (bytes, incl. trailing newline) of one ledger row. */
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
  // The preserve-read + whole-file rewrite are serialized against concurrent
  // lifecycle appends ONLY in write mode (issue #1910, codex):
  // appendMemoryLifecycleEvents holds this same cross-process lock, so an event
  // appended after the preserve-read but before the atomic rename waits and
  // lands on the compacted ledger instead of being clobbered by the rename. A
  // DRY RUN takes no lock — it reads the ledger read-only to compute the
  // preserve/merge/byte-cap PREVIEW and never rewrites, so it must not block
  // appends (#2033 Cursor). The corpus scan above stays outside the lock in
  // both modes — frontmatter-derived rows come from the memory files.
  const runLedgerCriticalSection = async (
    acquired: boolean,
    lock: HeldFileLockController | null,
  ): Promise<void> => {
    // A WRITE that read or rewrote the ledger without the lock could race a
    // concurrent append/rewrite and lose data, so REFUSE the unlocked fallback
    // withHeldFileLock takes on acquisition timeout (issue #2033 CodeRabbit
    // Critical / codex). A dry run passes lock=null and acquired=true: it never
    // reaches the rewrite, so the unlocked preview read is safe.
    if (!dryRun && !acquired) {
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
          + `(${displayErrorDetail(err) || "unknown error"})`,
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
      // Bound the rewritten ledger so a preserving compaction can never leave it
      // over the whole-file read/decrypt cap (#2033). This must run whenever a
      // cap is set — NOT only when `existing.length > 0`: an oversized on-disk
      // ledger whose every row fails validation reads as `existing === []`, yet
      // `finalEvents` (the frontmatter reconstruction) can itself exceed the cap.
      // Overflow (oldest) rows are dropped from the active ledger but survive
      // both in the timestamped backup (a verbatim copy when the ledger is
      // plaintext, re-encrypted under the backup path's own AAD when it is
      // encrypted so it still decrypts there, #2033) and, for frontmatter-derived
      // rows, in the memory files they were reconstructed from — so a later full
      // rebuild regenerates them.
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

    // Re-assert the lock immediately before the destructive active-ledger
    // rewrite. Everything above (the preserve read, merge, sort, byte-cap
    // bound, and JSON serialize) is CPU-bound and blocks the event loop, so the
    // timer heartbeat inside withHeldFileLock cannot refresh the lock's mtime;
    // a peer that judged the lock stale within the 30s window could have broken
    // it and appended to the current ledger. `lock.refresh()` (a) reports the
    // lock LOST so we ABORT rather than rename our compacted file over that
    // peer's append, and (b) when still held, re-stamps the mtime so the bounded
    // write below cannot itself be judged stale mid-rename (issue #1910/#2033).
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
      // No-op skip (#2033 thread PRRT_kwDORJXyws6SExst): a preserving rebuild
      // bounds the ACTIVE ledger to the read/decrypt cap, so a VALID ledger that
      // sits above the configured compaction trigger but below the cap would
      // otherwise be rewritten to identical content and re-archived on every
      // maintenance interval — unbounded growth of archive/memory-lifecycle-ledger
      // plus pointless disk/CPU churn. Skip the backup+rewrite when it would
      // change neither the logical (decrypted) content NOR the at-rest format.
      // The raw read here doubles as the source for the encrypted verbatim backup
      // below, so the current ledger is read at most once. An absent ledger reads
      // as ENOENT (a create is always a real change) and any other read/probe
      // error propagates rather than masking a needed rewrite.
      let currentEncrypted = false;
      let priorRawBuffer: Buffer | null = null;
      try {
        currentEncrypted = await probeEncryptedRegularFileHeader(outputPath);
        priorRawBuffer = await storage.readMemoryLifecycleLedgerRawBufferForCompaction();
      } catch (err) {
        if (!isNodeError(err) || err.code !== "ENOENT") throw err;
      }
      // Preserve encryption at rest (#2033). An already-encrypted ledger (or its
      // encrypted backup) MUST be rewritten encrypted even when the
      // `secureStoreEncryptOnWrite` policy is paused — otherwise the compaction
      // silently DOWNGRADES encrypted state to plaintext. Force encryption
      // whenever the current ledger is encrypted and the store is unlocked (a
      // key is available); reaching this point with an encrypted ledger already
      // implies an unlocked store, since the raw read above decrypts and would
      // have thrown under a locked key. A plaintext ledger keeps the ordinary
      // policy (`willEncryptStateWrites`), so existing plaintext behavior holds.
      const forceEncrypt =
        secureRewrite && currentEncrypted && storage.isSecureStoreUnlocked();
      const replacementEncrypted =
        secureRewrite && (storage.willEncryptStateWrites() || forceEncrypt);
      // Compare as buffers, never decoding the raw ledger to one giant string:
      // a multi-hundred-MB decrypted ledger can exceed V8's max string length,
      // so `priorRawBuffer.equals(...)` (byte compare) must be used, NOT
      // `.toString()` (#2033 giant-string invariant). `content` is the freshly
      // serialized replacement, already a string; Buffer.from() reuses it.
      if (
        priorRawBuffer !== null &&
        currentEncrypted === replacementEncrypted &&
        priorRawBuffer.equals(Buffer.from(content, "utf8"))
      ) {
        // Nothing to change: leave the active ledger and archive untouched.
        rewritten = false;
      } else {
        const desiredBackup = await backupExistingLedger(options.memoryDir, outputPath, now);
        if (secureRewrite) {
          // Preserve encrypted-at-rest (issue #1910). The BACKUP needs care under
          // secure-store (#2033): when the existing ledger is encrypted, its bytes
          // are path-bound via AAD, so a byte-for-byte copy to the archive path
          // cannot be decrypted there — it would silently orphan the overflow rows
          // a bounded rewrite claims to preserve. Reuse the RAW decrypted ledger
          // content read above (no event parsing, so malformed/truncated/future
          // rows survive exactly as the plaintext verbatim copy keeps them) and
          // re-encrypt it under the backup path's own AAD, yielding a directly
          // decryptable backup that retains every original byte. A PLAINTEXT
          // existing ledger is already readable, so a verbatim copy is correct.
          // Then rewrite the active ledger through the secure writer.
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
  // Write mode holds the ledger lock across the preserve-read and atomic
  // rewrite so a concurrent append lands on the compacted ledger instead of
  // being clobbered. A dry run computes the SAME preserve/merge/byte-cap
  // preview but WITHOUT the lock (read-only, no rewrite), so `rebuiltRows`,
  // `preservedAppendOnlyRows`, and `archivedOverflowRows` report what a --write
  // would apply while never blocking concurrent appends (#2033 Cursor). A dry
  // run with nothing to preserve touches nothing at all.
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
