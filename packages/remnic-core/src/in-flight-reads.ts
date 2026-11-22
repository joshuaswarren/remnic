import type { MemoryFile } from "./types.js";

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

export interface CoalescedScan extends CoalescedScanWaiter {
  /** The signal the shared scan itself observes. */
  readonly scanSignal: AbortSignal;
  /** Publish the scan to the registry and arm cancellation. */
  arm(read: Promise<MemoryFile[]>): void;
}

function trackWaiter(entry: InFlightEntry, callerSignal?: AbortSignal): CoalescedScanWaiter {
  let left = false;
  const leave = () => {
    if (left) return;
    left = true;
    callerSignal?.removeEventListener("abort", onAbort);
    entry.waiters -= 1;
    if (entry.waiters <= 0) entry.cancel?.();
  };
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
