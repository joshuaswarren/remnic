import { SecureStoreLockedError } from "../secure-store/secure-fs.js";
import { isErrnoCode } from "../utils/errno.js";
import type { MemoryLifecycleEvent } from "../types.js";
import {
  compareMemoryLifecycleEvents,
  sortMemoryLifecycleEvents,
} from "../memory-lifecycle-ledger-utils.js";
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

/**
 * Every valid ledger row in canonical order. Permissive validation (any
 * `eventType` string is admitted) — matches the historical
 * `readAllMemoryLifecycleEvents` contract that projection rebuild depends on.
 */
export async function readAllLifecycleEventsFromLedger(
  ledgerPath: string,
  readSecureFile: LedgerSecureReader,
): Promise<MemoryLifecycleEvent[]> {
  try {
    const out: MemoryLifecycleEvent[] = [];
    for await (const line of readMaybeEncryptedLines(
      ledgerPath,
      () => readSecureFile(ledgerPath),
      STATE_FILE_MAX_DECRYPT_BYTES,
    )) {
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
