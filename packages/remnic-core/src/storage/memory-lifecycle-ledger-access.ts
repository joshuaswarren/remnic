import { SecureStoreLockedError } from "../secure-store/secure-fs.js";
import { isErrnoCode } from "../utils/errno.js";
import { mkdir, readdir, stat, unlink } from "node:fs/promises";
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

/** Write one spill file (a fresh, uniquely-named, immutable per-append file). */
async function spillPendingAppend(
  ledgerPath: string,
  io: LifecyclePendingIo,
  payload: string,
): Promise<void> {
  const dir = pendingLifecycleLedgerDir(ledgerPath);
  await mkdir(dir, { recursive: true });
  await io.writeSecure(path.join(dir, `${randomUUID()}.jsonl`), payload);
}

/**
 * Read every spill file in the pending directory (in deterministic name order)
 * and return the concatenated rows plus the file paths that produced them. MUST
 * be called while holding the ledger lock. Returns null when nothing is pending.
 * The caller deletes the returned files ONLY after the rows are durably in the
 * ledger; a read failure (locked key / corruption) propagates and leaves every
 * spill file intact for a later retry.
 */
async function collectPendingSpills(
  ledgerPath: string,
  io: LifecyclePendingIo,
): Promise<{ content: string; files: string[] } | null> {
  const dir = pendingLifecycleLedgerDir(ledgerPath);
  let names: string[];
  try {
    names = (await readdir(dir)).filter((name) => name.endsWith(".jsonl")).sort();
  } catch (err) {
    if (isErrnoCode(err, "ENOENT")) return null; // no pending dir — nothing spilled.
    throw err;
  }
  if (names.length === 0) return null;
  const parts: string[] = [];
  const files: string[] = [];
  for (const name of names) {
    const filePath = path.join(dir, name);
    parts.push(withTrailingNewline(await io.readSecure(filePath)));
    files.push(filePath);
  }
  return { content: parts.join(""), files };
}

/** Delete drained spill files after their rows are durably in the ledger. */
async function removePendingSpills(files: string[]): Promise<void> {
  for (const filePath of files) {
    await unlink(filePath).catch(() => undefined);
  }
}

/**
 * Under the held ledger lock: fold any pending spills and the new payload into
 * the ledger in one write, so spilled events rejoin the canonical ledger as soon
 * as the lock is free. Spill files are deleted ONLY after the ledger write
 * succeeds; on write failure they are left in place and retried next pass —
 * never lost.
 */
async function drainThenAppend(
  ledgerPath: string,
  append: (payload: string) => Promise<void>,
  payload: string,
  pending: LifecyclePendingIo | undefined,
): Promise<void> {
  const drained = pending ? await collectPendingSpills(ledgerPath, pending) : null;
  const combined = drained ? `${withTrailingNewline(drained.content)}${payload}` : payload;
  await append(combined);
  if (drained) await removePendingSpills(drained.files);
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
      await drainThenAppend(ledgerPath, append, payload, pending);
    },
  );
}

/**
 * Drain the durable pending spills into the ledger under the ledger lock WITHOUT
 * appending a new event (#2033). Maintenance calls this so events that spilled
 * while a long compaction held the lock are eventually written even when no
 * further append arrives. A non-acquired lock is a no-op (retried next pass); a
 * ledger-write failure leaves the spill files intact for retry. Returns true
 * when rows were drained.
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
      const collected = await collectPendingSpills(ledgerPath, pending);
      if (!collected) return;
      await append(withTrailingNewline(collected.content));
      await removePendingSpills(collected.files);
      drained = true;
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
