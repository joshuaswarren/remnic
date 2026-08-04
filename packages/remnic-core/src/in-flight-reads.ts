import type { MemoryFile } from "./types.js";

/**
 * In-flight readAllMemories() dedup registry (issue #1902).
 *
 * NOT a cache layer — it holds transient per-(directory, secure-store key) scan
 * promises so temporally-overlapping reads collapse onto ONE disk scan; the slot
 * is deleted when the promise settles. It lives in its own module (not
 * memory-cache.ts) so it is not swept by the ALL_CACHE_LAYERS invalidation
 * contract, yet remains importable by both StorageManager and the out-of-band
 * corpus-bump helper (memory-corpus-version.ts).
 *
 * Keyed by baseDir AND secure-store key identity (Codex P1 / Cursor Medium):
 * an unlocked manager's decrypted scan must NOT be handed to a locked or
 * differently-keyed manager for the same dir — that would bypass the keyId
 * isolation getCachedMemories enforces. Locked/plaintext stores use keyId "".
 *
 * Since issue #2307 the registry also owns the scan's CANCELLATION, because
 * whether a shared scan may be cancelled is purely a question of who is still
 * attached to it — see `beginCoalescedScan`.
 */
type InFlightEntry = {
  read: Promise<MemoryFile[]>;
  /** Readers still awaiting this scan. At zero the scan has no reason to finish. */
  waiters: number;
  /** Withdraw the slot and abort the scan. Absent for an uncancellable scan. */
  cancel?: () => void;
};

const inFlightReadsByKey = new Map<string, InFlightEntry>();

const DIR_SEP = "\u0000";

function composeKey(baseDir: string, keyId: string): string {
  return `${baseDir}${DIR_SEP}${keyId}`;
}

/**
 * A reader's attachment to a shared scan. `leave()` is idempotent per reader and
 * must be called when that reader stops waiting — because its own signal fired, or
 * because the scan settled.
 */
export interface CoalescedScanWaiter {
  leave(): void;
}

/**
 * Cancellation lifecycle for a coalesced corpus scan (issue #2307).
 *
 * The rule is reference counting, not ownership: **the scan is cancelled when its
 * LAST waiter leaves, and never before.** One reader can therefore not cancel work
 * another still needs, and two readers that both give up do not leave a full disk
 * scan running for nobody — which was the abandoned I/O this whole change exists to
 * remove.
 *
 * On the last leave the slot is withdrawn from the registry BEFORE the controller
 * fires, so a reader arriving later cannot attach to a promise already doomed to
 * reject with an `AbortError` it never asked for; it starts a fresh scan instead.
 */
export interface CoalescedScan extends CoalescedScanWaiter {
  /** The signal the shared scan itself observes. */
  readonly scanSignal: AbortSignal;
  /** Publish the scan to the registry and arm cancellation. */
  arm(read: Promise<MemoryFile[]>): void;
}

/** Build the per-reader `leave` closure: decrement once, cancel at zero. */
function trackWaiter(entry: InFlightEntry, callerSignal?: AbortSignal): CoalescedScanWaiter {
  let left = false;
  const leave = () => {
    if (left) return;
    left = true;
    callerSignal?.removeEventListener("abort", onAbort);
    entry.waiters -= 1;
    if (entry.waiters <= 0) entry.cancel?.();
  };
  // Named so the listener can be removed again; `once` alone would leak the
  // reference for a reader that leaves normally.
  function onAbort() {
    leave();
  }
  callerSignal?.addEventListener("abort", onAbort, { once: true });
  return { leave };
}

/**
 * Attach to an existing scan for (baseDir, keyId), or `undefined` when none is in
 * flight. The caller MUST `leave()` once it stops awaiting the returned promise.
 */
export function attachInFlightReader(
  baseDir: string,
  keyId = "",
  callerSignal?: AbortSignal,
): { read: Promise<MemoryFile[]>; waiter: CoalescedScanWaiter } | undefined {
  const entry = inFlightReadsByKey.get(composeKey(baseDir, keyId));
  if (entry === undefined) return undefined;
  entry.waiters += 1;
  return { read: entry.read, waiter: trackWaiter(entry, callerSignal) };
}

/** Start a cancellable coalesced scan as its first waiter. */
export function beginCoalescedScan(
  baseDir: string,
  keyId: string,
  callerSignal?: AbortSignal,
): CoalescedScan {
  const controller = new AbortController();
  let waiter: CoalescedScanWaiter | undefined;
  return {
    scanSignal: controller.signal,
    arm(read: Promise<MemoryFile[]>): void {
      // `waiters: 1` IS the starter; trackWaiter only builds its leave closure
      // (attaching readers do their own increment).
      const entry: InFlightEntry = {
        read,
        waiters: 1,
        cancel: () => {
          deleteInFlightRead(baseDir, keyId, read);
          controller.abort();
        },
      };
      inFlightReadsByKey.set(composeKey(baseDir, keyId), entry);
      waiter = trackWaiter(entry, callerSignal);
    },
    leave(): void {
      waiter?.leave();
    },
  };
}

/**
 * Register a scan promise directly, with no cancellation attached.
 *
 * For callers that own a promise rather than a scan they can abort — tests that
 * seed a stale in-flight read, and any future producer outside `beginCoalescedScan`.
 * The entry has no `cancel`, so waiters leaving is a no-op: an externally-owned
 * promise is not this module's to abort.
 */
export function setInFlightRead(
  baseDir: string,
  keyId: string,
  read: Promise<MemoryFile[]>,
): void {
  inFlightReadsByKey.set(composeKey(baseDir, keyId), { read, waiters: 1 });
}

/**
 * Delete the in-flight slot for one (baseDir, keyId). When `expected` is given,
 * only deletes if the slot still holds that exact promise (owner-only clear).
 */
export function deleteInFlightRead(
  baseDir: string,
  keyId = "",
  expected?: Promise<MemoryFile[]>,
): void {
  const key = composeKey(baseDir, keyId);
  if (expected === undefined || inFlightReadsByKey.get(key)?.read === expected) {
    inFlightReadsByKey.delete(key);
  }
}

/**
 * Drop EVERY in-flight slot for `baseDir` across all secure-store identities.
 * Used by mutations / invalidation / out-of-band corpus bumps: after the corpus
 * changes, no reader of any key identity may attach to a pre-mutation scan.
 */
export function deleteInFlightReadsForDir(baseDir: string): void {
  const prefix = `${baseDir}${DIR_SEP}`;
  for (const key of inFlightReadsByKey.keys()) {
    if (key.startsWith(prefix)) inFlightReadsByKey.delete(key);
  }
}

export function clearInFlightReads(): void {
  inFlightReadsByKey.clear();
}
