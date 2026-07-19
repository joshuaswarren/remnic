import { SecureStoreLockedError } from "../secure-store/secure-fs.js";
import { isErrnoCode } from "../utils/errno.js";
import type { MemoryLifecycleEvent } from "../types.js";
import {
  compareMemoryLifecycleEvents,
  sortMemoryLifecycleEvents,
  memoryLifecycleLedgerLockPath,
  MEMORY_LIFECYCLE_LEDGER_LOCK_STALE_MS,
  MEMORY_LIFECYCLE_LEDGER_APPEND_LOCK_MAX_WAIT_MS,
} from "../memory-lifecycle-ledger-utils.js";
import { withHeldFileLock, type HeldFileLockOptions } from "../utils/serialize-mutations.js";
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
 * Append `payload` to the lifecycle ledger under the cross-process ledger lock
 * so it is serialized against compaction's whole-file rewrite (issue #1910):
 * both hold this lock, so an append during a rewrite waits and lands on the
 * compacted ledger instead of being clobbered by the atomic rename.
 *
 * The acquisition budget defaults to MEMORY_LIFECYCLE_LEDGER_APPEND_LOCK_MAX_WAIT_MS
 * (twice the stale window), NOT withHeldFileLock's 5s default: a compaction
 * rewrite of a large ledger can legitimately hold the lock past 5s, and giving
 * up there would surface acquired=false and drop the event fail-open (#2033).
 * With this budget a normal append waits out the compaction — or, if the holder
 * crashed, past the stale-break window so it still acquires. Only a lock wedged
 * beyond that (a genuine filesystem fault, not routine contention) yields
 * acquired=false, where we REFUSE to append unlocked rather than let the rewrite
 * clobber the new row — the exact race this lock prevents. `lockOptions` lets
 * tests shrink the budget to exercise both branches deterministically.
 */
export async function appendLifecycleEventsSerialized(
  ledgerPath: string,
  append: (payload: string) => Promise<void>,
  payload: string,
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
        throw new Error(
          "memory-lifecycle-ledger append aborted: could not acquire the ledger lock within "
          + "the budget; refusing to append unlocked so a concurrent compaction rewrite cannot "
          + "clobber the new event (issue #1910).",
        );
      }
      await append(payload);
    },
  );
}
