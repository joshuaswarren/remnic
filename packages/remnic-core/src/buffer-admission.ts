/** Buffer session-entry admission: refusal errors and the live-admission probe. */

import { selectEvictedBufferKeys, type BufferEvictionHooks } from "./buffer-eviction.js";
import type { BufferEntryState } from "./types.js";

/**
 * Raised when a NEW live-capture session cannot be admitted because the
 * session-entry cap is full of non-evictable backlog. The turn was never
 * accepted; the request is retryable once extraction drains an entry.
 */
export class BufferAdmissionRefusedError extends Error {
  constructor(bufferKey: string, maxSessionEntries: number) {
    super(
      `buffer[${bufferKey}]: live capture refused at the session-entry cap (${maxSessionEntries}); ` +
        "buffered backlog is no longer evicted to admit new sessions. Retry after extraction frees an entry",
    );
    this.name = "BufferAdmissionRefusedError";
  }
}

/** Durable observe capture refused at the entry cap; the request is retryable. */
export class ReplayAdmissionRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplayAdmissionRefusedError";
  }
}

/**
 * Live-admission bound (#1908 policy, backlog-safe): a NEW session enters
 * only while under the cap or when an EMPTY entry can be reclaimed. Buffered
 * backlog is never dropped for a live capture; the caller refuses instead.
 */
export function canAdmitNewEntryUnlocked(
  entries: Readonly<Record<string, BufferEntryState>>,
  bufferKey: string,
  maxSessionEntries: number,
  hooks: BufferEvictionHooks,
): boolean {
  const count = Object.keys(entries).length;
  if (count < maxSessionEntries) return true;
  // Probe post-admission (as if this key had landed): admission is safe
  // exactly when an EMPTY entry could then be reclaimed.
  return selectEvictedBufferKeys(entries, [bufferKey], Math.max(0, count - 1), hooks).length > 0;
}
