import { SecureStoreLockedError } from "../secure-store/secure-fs.js";
import { isErrnoCode } from "../utils/errno.js";
import { rename, stat, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { MemoryLifecycleEvent } from "../types.js";
import {
  compareMemoryLifecycleEvents,
  sortMemoryLifecycleEvents,
  memoryLifecycleLedgerLockPath,
  MEMORY_LIFECYCLE_LEDGER_LOCK_STALE_MS,
  MEMORY_LIFECYCLE_LEDGER_APPEND_LOCK_MAX_WAIT_MS,
} from "../memory-lifecycle-ledger-utils.js";
import { withHeldFileLock, type HeldFileLockOptions } from "../utils/serialize-mutations.js";
import { ensureContainedSpillDir, listContainedSpillFiles } from "../utils/path-containment.js";
import {
  readMaybeEncryptedLines,
  readMemoryLifecycleEventsFromLines,
  STATE_FILE_MAX_DECRYPT_BYTES,
} from "./secure-line-reader.js";

/** Reads a lifecycle-ledger file through the secure whole-file/plaintext line source. */
export type LedgerSecureReader = (filePath: string) => Promise<string>;

/**
 * Lifecycle-ledger read access, extracted from storage.ts (issues #1910,
 * #1995) so the god-file line-count ratchet does not grow. Behavior is
 * unchanged: both readers stream `state/memory-lifecycle-ledger.jsonl` through
 * the same secure whole-file-or-plaintext line source, are fail-open on
 * malformed rows, return `[]` on an absent ledger (ENOENT), and rethrow when a
 * required secure store is locked.
 */

/** Reads a lifecycle-ledger file as a raw (possibly still-encrypted-on-disk)
 *  buffer, decrypting through the live secure key when present. */
export type LedgerSecureBufferReader = (filePath: string) => Promise<Buffer>;

/**
 * Parse + canonically sort lifecycle rows from a line source. Permissive
 * validation (any `eventType` string is admitted) — matches the historical
 * `readAllMemoryLifecycleEvents` contract that projection rebuild depends on.
 * Fail-open on malformed rows.
 */
async function collectLifecycleEvents(
  lines: AsyncIterable<string>,
): Promise<MemoryLifecycleEvent[]> {
  const out: MemoryLifecycleEvent[] = [];
  for await (const line of lines) {
    const row = line.trim();
    if (!row) continue;
    try {
      const parsed = JSON.parse(row) as Partial<MemoryLifecycleEvent>;
      if (
        typeof parsed.eventId === "string" &&
        typeof parsed.memoryId === "string" &&
        typeof parsed.eventType === "string" &&
        typeof parsed.timestamp === "string" &&
        typeof parsed.actor === "string" &&
        typeof parsed.ruleVersion === "string"
      ) {
        out.push(parsed as MemoryLifecycleEvent);
      }
    } catch {
      // Ignore malformed rows (fail-open).
    }
  }
  return sortMemoryLifecycleEvents(out);
}

/**
 * Yield ledger lines from a whole-file buffer WITHOUT ever materializing the
 * entire decrypted body as one V8 string. A decrypted Buffer can hold ~4GB
 * where a string tops out near 512MB, so this is the read compaction uses to
 * shrink an oversize encrypted ledger — the exact file the string-capped
 * `readMaybeEncryptedLines` path refuses (issue #1910, #2033 Cursor High).
 * `Buffer.indexOf` scans for the 0x0A newline natively; each yielded line is
 * small, so no single `toString` approaches the string cap.
 */
async function* linesFromBuffer(
  readBuffer: () => Promise<Buffer>,
): AsyncGenerator<string> {
  const buf = await readBuffer();
  let start = 0;
  let nl = buf.indexOf(0x0a, start);
  while (nl !== -1) {
    yield buf.toString("utf8", start, nl);
    start = nl + 1;
    nl = buf.indexOf(0x0a, start);
  }
  if (start < buf.length) yield buf.toString("utf8", start, buf.length);
}

/**
 * Every valid ledger row in canonical order, read through the string-capped
 * secure line source (refuses an encrypted body over the whole-file decrypt
 * limit). General readers use this; compaction uses the uncapped buffer variant.
 */
export async function readAllLifecycleEventsFromLedger(
  ledgerPath: string,
  readSecureFile: LedgerSecureReader,
): Promise<MemoryLifecycleEvent[]> {
  try {
    return await collectLifecycleEvents(
      readMaybeEncryptedLines(
        ledgerPath,
        () => readSecureFile(ledgerPath),
        STATE_FILE_MAX_DECRYPT_BYTES,
      ),
    );
  } catch (err) {
    if (err instanceof SecureStoreLockedError) throw err;
    if (!isErrnoCode(err, "ENOENT")) throw err;
    return [];
  }
}

/**
 * Compaction-only variant of {@link readAllLifecycleEventsFromLedger} that reads
 * the ledger through a decrypted BUFFER instead of the string-capped whole-file
 * path. This is what lets background compaction shrink an oversize encrypted
 * ledger: the string cap (`STATE_FILE_MAX_DECRYPT_BYTES`) that points general
 * readers at the compaction remedy would otherwise also block the remedy itself
 * (issue #1910, #2033 Cursor High). Same permissive validation, canonical sort,
 * fail-open-on-malformed, and ENOENT→[] / locked-store-rethrow contract.
 */
export async function readAllLifecycleEventsFromLedgerBuffer(
  ledgerPath: string,
  readSecureBuffer: LedgerSecureBufferReader,
): Promise<MemoryLifecycleEvent[]> {
  try {
    return await collectLifecycleEvents(linesFromBuffer(() => readSecureBuffer(ledgerPath)));
  } catch (err) {
    if (err instanceof SecureStoreLockedError) throw err;
    if (!isErrnoCode(err, "ENOENT")) throw err;
    return [];
  }
}

/**
 * Bounded tail read: retains at most `limit` rows via a streaming min-heap so
 * the whole ledger is never materialized. Rows are always ranked by the
 * canonical comparator, so the result is the last `limit` events in canonical
 * (memoryId, timestamp, eventType) order — byte-for-byte the prior `readAll →
 * sort → slice(-limit)`, whether or not `memoryId` is supplied. Governance
 * passes `MAX_SAFE_INTEGER`, so the heap keeps every row and equals
 * `readAllMemoryLifecycleEvents` (issue #1910; CodeRabbit: keep the no-memoryId
 * read on the canonical tail). With `memoryId` only that memory's rows are
 * considered, so the per-memory timeline fallback never materializes the whole
 * ledger either.
 */
export async function readBoundedLifecycleEventsFromLedger(
  ledgerPath: string,
  readSecureFile: LedgerSecureReader,
  limit: number,
  memoryId?: string,
): Promise<MemoryLifecycleEvent[]> {
  const cappedLimit = Math.max(0, Math.floor(limit));
  if (cappedLimit === 0 || Number.isNaN(cappedLimit)) return [];
  try {
    return await readMemoryLifecycleEventsFromLines(
      readMaybeEncryptedLines(
        ledgerPath,
        () => readSecureFile(ledgerPath),
        STATE_FILE_MAX_DECRYPT_BYTES,
      ),
      cappedLimit,
      memoryId,
      compareMemoryLifecycleEvents,
    );
  } catch (err) {
    if (err instanceof SecureStoreLockedError) throw err;
    if (!isErrnoCode(err, "ENOENT")) throw err;
    return [];
  }
}

/**
 * Directory holding the durable pending-append spill for a lifecycle ledger
 * (#2033). When an append cannot acquire the ledger lock within its budget —
 * because a long compaction/rebuild rewrite legitimately holds it — the event
 * is written as its OWN immutable file here instead of being dropped fail-open,
 * then folded back into the ledger by the next lock holder (a later append or
 * the maintenance drain).
 *
 * A per-event file (not a single appended file) is deliberate: each spill is
 * encrypted at its own path so the path-bound AAD stays valid, and the drainer
 * only ever deletes files it has already read — a spill that lands mid-drain is
 * simply a new file picked up on the next pass, so nothing is clobbered or lost.
 */
export function pendingLifecycleLedgerDir(ledgerPath: string): string {
  return `${ledgerPath}.pending.d`;
}

/**
 * Secure IO the pending spill needs. `writeSecure`/`readSecure` mirror the
 * ledger's own secure write/read so each spill file is encrypted at rest exactly
 * like the ledger it backs (each at its own path-bound AAD).
 *
 * `writeSecure` MUST be ATOMIC (#2033): it writes the payload to a temp file in
 * the SAME directory and then renames it onto `filePath`, so a concurrent lock
 * holder draining the pending dir never lists or reads a half-written spill (the
 * exact partial-fold the drain's `*.jsonl`-only lister must never see). The
 * temp+rename is bound to the FINAL path because the ciphertext's AAD is the
 * final path — an outer rename at the spill layer would leave the bytes
 * undecryptable, so the atomic step lives here in `writeSecure`. The production
 * wiring (`writeMaybeEncryptedFile`) already renames its temp onto `filePath`,
 * naming that temp `<final>.tmp-…` (never `*.jsonl`), so the drain skips it.
 */
export interface LifecyclePendingIo {
  writeSecure: (filePath: string, payload: string) => Promise<void>;
  readSecure: (filePath: string) => Promise<string>;
}

function withTrailingNewline(content: string): string {
  return content.length === 0 || content.endsWith("\n") ? content : `${content}\n`;
}

/**
 * Serialize lifecycle events into the ledger's newline-delimited JSON payload,
 * stamping a fallback timestamp on any event that lacks one. Extracted from
 * storage.ts (issue #1995 file-size ratchet); behavior unchanged.
 */
export function serializeLifecycleAppendPayload(events: MemoryLifecycleEvent[]): string {
  const nowIso = new Date().toISOString();
  return events
    .map((event) => {
      const normalized: MemoryLifecycleEvent = {
        ...event,
        timestamp: event.timestamp && event.timestamp.length > 0 ? event.timestamp : nowIso,
      };
      return `${JSON.stringify(normalized)}\n`;
    })
    .join("");
}

/**
 * Write one spill file (a fresh, uniquely-named, immutable per-append file).
 * The write goes to the FINAL `<uuid>.jsonl` path through {@link LifecyclePendingIo}
 * `writeSecure`, whose atomic temp+rename (bound to that final path, since the
 * ciphertext's AAD is the final path) guarantees a concurrent lock holder's
 * drain never lists or folds a half-written spill (#2033).
 */
async function spillPendingAppend(
  ledgerPath: string,
  io: LifecyclePendingIo,
  payload: string,
): Promise<void> {
  const dir = pendingLifecycleLedgerDir(ledgerPath);
  await ensureContainedSpillDir(dir);
  const finalPath = path.join(dir, `${randomUUID()}.jsonl`);
  await io.writeSecure(finalPath, payload);
}

/**
 * Read every spill file in the pending directory (in deterministic name order)
 * and return one entry per file. MUST be called while holding the ledger lock.
 * Reads at each file's ORIGINAL path so encrypted spills (path-bound AAD) still
 * decrypt. A read failure (locked key / corruption) propagates BEFORE anything is
 * claimed, leaving every spill file intact for a later retry.
 */
async function collectPendingSpills(
  ledgerPath: string,
  io: LifecyclePendingIo,
): Promise<Array<{ file: string; content: string }>> {
  // listContainedSpillFiles rejects a symlinked pending dir and skips any
  // symlinked/escaping entry BEFORE we secure-read or later unlink it (#2033),
  // so a poisoned link cannot redirect a decrypt/delete outside the spill dir.
  const files = await listContainedSpillFiles(pendingLifecycleLedgerDir(ledgerPath));
  const out: Array<{ file: string; content: string }> = [];
  for (const filePath of files) {
    out.push({ file: filePath, content: withTrailingNewline(await io.readSecure(filePath)) });
  }
  return out;
}

/** Suffix marking a spill that has been CLAIMED for commit but not yet deleted. */
const CLAIMED_SPILL_SUFFIX = ".claimed";

/**
 * Recover claims a crashed drain left mid-flight (#2033). A crash-safe drain
 * renames `*.jsonl` → `*.jsonl.claimed` BEFORE committing (see
 * {@link claimPendingSpills}); if the process dies between that rename and the
 * ledger write, the durable `.claimed` file is the ONLY copy of those rows. This
 * renames every orphaned `*.jsonl.claimed` back to `*.jsonl` so it re-enters the
 * normal collect+claim+commit flow — nothing a crash left behind is lost. Reads
 * only ever happen at the restored `.jsonl` path, so the path-bound AAD of an
 * encrypted spill stays valid. A file that vanished or cannot be renamed is left
 * for a later pass. MUST run under the held ledger lock, before collecting.
 */
async function recoverOrphanedClaims(ledgerPath: string): Promise<void> {
  const claimed = await listContainedSpillFiles(
    pendingLifecycleLedgerDir(ledgerPath),
    `.jsonl${CLAIMED_SPILL_SUFFIX}`,
  );
  for (const claimedPath of claimed) {
    const original = claimedPath.slice(0, -CLAIMED_SPILL_SUFFIX.length);
    await rename(claimedPath, original).catch(() => undefined);
  }
}

/**
 * Claim spills for commit via a CRASH-SAFE rename (#2033): each `*.jsonl` is
 * atomically renamed to `*.jsonl.claimed` BEFORE its rows are committed. The
 * rename is durable, so a crash between the claim and the commit leaves the rows
 * on disk (recovered by {@link recoverOrphanedClaims} on the next drain) instead
 * of losing them — the failure the plain unlink-before-commit ordering could not
 * survive. Content was already read at each spill's original (AAD-bound) path by
 * {@link collectPendingSpills}, so the claimed file is never decrypted again. A
 * rename that fails (read-only dir, vanished file) skips that spill this pass; it
 * is retried later. Returns one bounded batch and its next input index. A spill
 * larger than the batch limit is committed alone so the drain always makes
 * progress.
 */
const PENDING_SPILL_BATCH_MAX_BYTES = 1024 * 1024;

async function claimPendingSpills(
  spills: Array<{ file: string; content: string }>,
  startIndex: number,
): Promise<{
  payload: string;
  claimedPaths: string[];
  nextIndex: number;
}> {
  const parts: string[] = [];
  const claimedPaths: string[] = [];
  let payloadBytes = 0;
  let nextIndex = startIndex;
  for (; nextIndex < spills.length; nextIndex++) {
    const spill = spills[nextIndex]!;
    const spillBytes = Buffer.byteLength(spill.content, "utf8");
    if (parts.length > 0 && payloadBytes + spillBytes > PENDING_SPILL_BATCH_MAX_BYTES) {
      break;
    }
    const claimedPath = `${spill.file}${CLAIMED_SPILL_SUFFIX}`;
    try {
      await rename(spill.file, claimedPath);
    } catch {
      continue; // could not claim → do not commit; a later drain retries it.
    }
    parts.push(spill.content);
    claimedPaths.push(claimedPath);
    payloadBytes += spillBytes;
  }
  return { payload: parts.join(""), claimedPaths, nextIndex };
}

/** Delete claimed spill files after their rows are durably committed. A delete
 *  that fails leaves an orphan the next drain recovers and re-commits — a
 *  duplicate the eventId-deduping rebuild collapses, never a lost row (#2033). */
async function finalizeClaimedSpills(claimedPaths: string[]): Promise<void> {
  for (const claimedPath of claimedPaths) {
    await unlink(claimedPath).catch(() => undefined);
  }
}

/** Roll a failed commit's claims back to unclaimed `*.jsonl` spills so they are
 *  retried as normal spills (#2033). Best-effort: an un-renamable claim is
 *  instead recovered by the next drain's orphan sweep. */
async function rollbackClaimedSpills(claimedPaths: string[]): Promise<void> {
  for (const claimedPath of claimedPaths) {
    const original = claimedPath.slice(0, -CLAIMED_SPILL_SUFFIX.length);
    await rename(claimedPath, original).catch(() => undefined);
  }
}

/**
 * Under the held ledger lock, fold durable pending spills into the ledger in
 * bounded batches together with `extraPayload` (a new event's rows, or "" for a
 * drain-only pass). Each batch uses the crash-safe claim/commit protocol:
 * recover orphaned claims, read each spill, CLAIM it by rename, COMMIT the
 * claimed rows, then FINALIZE by deleting the claimed files. A commit failure
 * rolls the current batch's claims back to unclaimed spills and rethrows, so a
 * failed write neither loses nor double-commits rows. Returns true when spill
 * rows were committed.
 */
async function foldPendingSpillsIntoAppend(
  ledgerPath: string,
  append: (payload: string) => Promise<void>,
  extraPayload: string,
  pending: LifecyclePendingIo | undefined,
): Promise<boolean> {
  if (!pending) {
    if (extraPayload.length > 0) await append(extraPayload);
    return false;
  }
  await recoverOrphanedClaims(ledgerPath);
  const spills = await collectPendingSpills(ledgerPath, pending);
  let nextIndex = 0;
  let drained = false;

  while (nextIndex < spills.length) {
    const batch = await claimPendingSpills(spills, nextIndex);
    nextIndex = batch.nextIndex;
    if (batch.claimedPaths.length === 0) {
      if (nextIndex >= spills.length) break;
      continue;
    }
    try {
      await append(batch.payload);
    } catch (err) {
      await rollbackClaimedSpills(batch.claimedPaths);
      throw err;
    }
    await finalizeClaimedSpills(batch.claimedPaths);
    drained = true;
  }

  if (extraPayload.length > 0) await append(extraPayload);
  return drained;
}

/**
 * Append `payload` to the lifecycle ledger under the cross-process ledger lock
 * so it is serialized against compaction's whole-file rewrite (issue #1910):
 * both hold this lock, so an append during a rewrite waits and lands on the
 * compacted ledger instead of being clobbered by the atomic rename.
 *
 * The acquisition budget defaults to MEMORY_LIFECYCLE_LEDGER_APPEND_LOCK_MAX_WAIT_MS
 * (twice the stale window), NOT withHeldFileLock's 5s default: a compaction
 * rewrite of a large ledger can legitimately hold the lock past 5s, and giving
 * up there would surface acquired=false. With this budget a normal append waits
 * out the compaction — or, if the holder crashed, past the stale-break window so
 * it still acquires.
 *
 * When the budget is nonetheless exhausted (a rewrite of a very large ledger
 * holds the lock past even this window), a configured `pending` queue makes the
 * append DURABLE instead of dropping it fail-open (#2033): the event is spilled
 * to an encrypted per-event file and folded back into the ledger by the next
 * lock holder, guaranteeing eventual append. Without a pending queue the old
 * behavior stands — REFUSE to append unlocked rather than let a rewrite clobber
 * the row. `lockOptions` lets tests shrink the budget to exercise both branches.
 */
export async function appendLifecycleEventsSerialized(
  ledgerPath: string,
  append: (payload: string) => Promise<void>,
  payload: string,
  pending?: LifecyclePendingIo,
  lockOptions?: Pick<HeldFileLockOptions, "maxWaitMs" | "pollMs">,
): Promise<void> {
  await withHeldFileLock(
    memoryLifecycleLedgerLockPath(ledgerPath),
    {
      staleMs: MEMORY_LIFECYCLE_LEDGER_LOCK_STALE_MS,
      maxWaitMs: MEMORY_LIFECYCLE_LEDGER_APPEND_LOCK_MAX_WAIT_MS,
      ...lockOptions,
    },
    async (acquired) => {
      if (!acquired) {
        if (!pending) {
          throw new Error(
            "memory-lifecycle-ledger append aborted: could not acquire the ledger lock within "
            + "the budget and no durable pending queue is configured; refusing to append unlocked "
            + "so a concurrent compaction rewrite cannot clobber the new event (issue #1910).",
          );
        }
        await spillPendingAppend(ledgerPath, pending, payload);
        return;
      }
      await foldPendingSpillsIntoAppend(ledgerPath, append, payload, pending);
    },
  );
}

/**
 * Drain the durable pending spills into the ledger under the ledger lock WITHOUT
 * appending a new event (#2033). Maintenance calls this so events that spilled
 * while a long compaction held the lock are eventually written even when no
 * further append arrives. A non-acquired lock is a no-op (retried next pass).
 * Uses the crash-safe claim/commit protocol ({@link foldPendingSpillsIntoAppend}):
 * spills are claimed by rename before the write and deleted only after it, an
 * orphaned claim from an earlier crash is recovered first, and a write failure
 * rolls the claims back — so a process crash mid-drain can never lose a row.
 * Returns true when rows were drained.
 */
export async function drainPendingLifecycleAppendsSerialized(
  ledgerPath: string,
  append: (payload: string) => Promise<void>,
  pending: LifecyclePendingIo,
  lockOptions?: Pick<HeldFileLockOptions, "maxWaitMs" | "pollMs">,
): Promise<boolean> {
  let drained = false;
  await withHeldFileLock(
    memoryLifecycleLedgerLockPath(ledgerPath),
    {
      staleMs: MEMORY_LIFECYCLE_LEDGER_LOCK_STALE_MS,
      maxWaitMs: MEMORY_LIFECYCLE_LEDGER_APPEND_LOCK_MAX_WAIT_MS,
      ...lockOptions,
    },
    async (acquired) => {
      if (!acquired) return; // lock busy; the next maintenance pass retries.
      drained = await foldPendingSpillsIntoAppend(ledgerPath, append, "", pending);
    },
  );
  return drained;
}

/**
 * Fast-path pending drain for a store (#2033): a no-op that takes NO lock when
 * the pending directory is absent, otherwise ensures the state dir exists and
 * drains under the ledger lock. Keeps StorageManager's public drain method a
 * thin delegate so the bounded-state logic stays in this sibling (issue #1995
 * file-size ratchet). Returns true when rows were drained.
 */
export async function drainPendingLifecycleLedgerIfAny(
  ledgerPath: string,
  io: LifecyclePendingIo,
  append: (payload: string) => Promise<void>,
  ensureReady: () => Promise<void>,
): Promise<boolean> {
  try {
    await stat(pendingLifecycleLedgerDir(ledgerPath));
  } catch (err) {
    if (isErrnoCode(err, "ENOENT")) return false; // nothing pending — no lock taken.
    throw err;
  }
  await ensureReady();
  return drainPendingLifecycleAppendsSerialized(ledgerPath, append, io);
}

/** Result of a pre-snapshot lifecycle drain (#2033): `folded` is true when spill
 *  rows were committed to the active ledger; `pendingDeferred` is true when
 *  durable spill rows STILL remain in the offline-sync-EXCLUDED pending queue
 *  after the attempt (the ledger lock was held by a peer, or a spill could not
 *  be claimed). A caller MUST NOT report a clean snapshot while `pendingDeferred`
 *  is true — those append-only rows would be silently omitted. */
export interface DrainPendingLifecycleForSyncResult {
  folded: boolean;
  pendingDeferred: boolean;
}

/**
 * Offline-sync pre-snapshot drain (#2033). Like {@link drainPendingLifecycleLedgerIfAny}
 * but reports whether durable rows are STILL pending after the attempt so an
 * offline snapshot never silently drops append-only lifecycle rows (promotions,
 * imports, explicit captures) that spilled while the ledger lock was held. Fast
 * no-op — no lock, no dir creation — when nothing is pending. Otherwise drains
 * under the ledger lock, then re-enumerates the pending directory: any remaining
 * live (`*.jsonl`) or crash-orphaned (`*.jsonl.claimed`) spill marks the drain as
 * deferred. A read/append failure inside the lock (locked key, encrypted body)
 * propagates to the caller, which retries or aborts.
 */
export async function drainPendingLifecycleLedgerForSync(
  ledgerPath: string,
  io: LifecyclePendingIo,
  append: (payload: string) => Promise<void>,
  ensureReady: () => Promise<void>,
): Promise<DrainPendingLifecycleForSyncResult> {
  const dir = pendingLifecycleLedgerDir(ledgerPath);
  try {
    await stat(dir);
  } catch (err) {
    if (isErrnoCode(err, "ENOENT")) return { folded: false, pendingDeferred: false };
    throw err;
  }
  await ensureReady();
  const folded = await drainPendingLifecycleAppendsSerialized(ledgerPath, append, io);
  const remaining =
    (await listContainedSpillFiles(dir)).length +
    (await listContainedSpillFiles(dir, `.jsonl${CLAIMED_SPILL_SUFFIX}`)).length;
  return { folded, pendingDeferred: remaining > 0 };
}

/**
 * Bounded pre-snapshot drain driver (#2033): invoke `drain` up to `maxAttempts`
 * times and return once it reports no pending rows; if durable rows remain
 * deferred (ledger lock held by a peer) or every attempt throws, throw so the
 * offline-sync caller ABORTS rather than building a snapshot that silently omits
 * append-only lifecycle rows. Kept here (not in the access-service god-file, issue
 * #1995) so both snapshot entrypoints share one retry/abort contract.
 */
export async function drainPendingLifecycleForSyncOrThrow(
  drain: () => Promise<DrainPendingLifecycleForSyncResult>,
  maxAttempts = 3,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await drain();
      if (!result.pendingDeferred) return;
      lastError = undefined;
    } catch (err) {
      lastError = err;
    }
  }
  const detail = lastError
    ? `: ${lastError instanceof Error ? lastError.message : String(lastError)}`
    : " (ledger lock held by a peer)";
  throw new Error(
    `offline-sync lifecycle drain could not fold pending memory-lifecycle events after ${maxAttempts} attempts${detail}; aborting snapshot so the pending rows are not silently excluded (#2033)`,
  );
}
