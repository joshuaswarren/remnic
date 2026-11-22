
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

/**
 * Raised when live capture targets an EXISTING session whose retained turns
 * already reach the per-session cap. The turn was never accepted and no
 * buffered turn is dropped; the request is retryable once extraction drains
 * the session. Companion to the session-entry cap above (#3415 bound).
 */
export class BufferSessionTurnRefusedError extends Error {
  constructor(bufferKey: string, maxTurnsPerSession: number) {
    super(
      `buffer[${bufferKey}]: live capture refused at the per-session turn cap (${maxTurnsPerSession}); ` +
        "retained backlog is not evicted to admit new turns. Retry after extraction drains the session",
    );
    this.name = "BufferSessionTurnRefusedError";
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
 * Durable observe capture rejected because the request resolves to no storage
 * target (namespaces ON with neither writeNamespaceOverride nor a plan's
 * writeNamespace). A property of the request — retrying cannot fix it — so it
 * must never be classified as retryable backpressure.
 */
export class StorageTargetRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageTargetRequiredError";
  }
}

export function canAdmitNewEntryUnlocked(
  entries: Readonly<Record<string, BufferEntryState>>,
  bufferKey: string,
  maxSessionEntries: number,
  hooks: BufferEvictionHooks,
): boolean {
  const count = Object.keys(entries).length;
  if (count < maxSessionEntries) return true;
  return selectEvictedBufferKeys(entries, [bufferKey], Math.max(0, count - 1), hooks).length > 0;
}
