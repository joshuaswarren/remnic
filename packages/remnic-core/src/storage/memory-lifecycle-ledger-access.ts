import { SecureStoreLockedError } from "../secure-store/secure-fs.js";
import { isErrnoCode } from "../utils/errno.js";
import type { MemoryLifecycleEvent } from "../types.js";
import {
  compareMemoryLifecycleEvents,
  sortMemoryLifecycleEvents,
} from "../memory-lifecycle-ledger-utils.js";
import { readMaybeEncryptedLines, readMemoryLifecycleEventsFromLines } from "./secure-line-reader.js";

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
    for await (const line of readMaybeEncryptedLines(ledgerPath, () => readSecureFile(ledgerPath))) {
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
 * Bounded tail read: retains at most `limit` rows via a streaming ring/heap so
 * the whole ledger is never materialized. Without `memoryId` the last `limit`
 * appended rows are kept then canonically sorted (identical to the prior
 * `slice(-limit)` on the full sorted list for the governance caller that passes
 * a huge limit). With `memoryId` only that memory's rows are considered and the
 * memoryId-first comparator preserves the prior "filter → canonical sort → last
 * N" ordering.
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
    const tail = await readMemoryLifecycleEventsFromLines(
      readMaybeEncryptedLines(ledgerPath, () => readSecureFile(ledgerPath)),
      cappedLimit,
      memoryId,
      memoryId === undefined ? undefined : compareMemoryLifecycleEvents,
    );
    return sortMemoryLifecycleEvents(tail);
  } catch (err) {
    if (err instanceof SecureStoreLockedError) throw err;
    if (!isErrnoCode(err, "ENOENT")) throw err;
    return [];
  }
}
