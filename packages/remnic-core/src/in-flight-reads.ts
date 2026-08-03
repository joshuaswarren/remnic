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
 */
type InFlightEntry = {
  read: Promise<MemoryFile[]>;
  /**
   * Detaches the starter's cancellation from the shared scan (issue #2307).
   * Called the first time another reader joins: nobody may cancel a scan someone
   * else is still waiting for, so the scan becomes uncancellable rather than
   * being refcounted. One boolean's worth of state, and it only ever moves one
   * way — the failure mode is a scan that outlives its starter, never a joiner
   * left with a cancelled read.
   */
  detachCancellation?: () => void;
};

const inFlightReadsByKey = new Map<string, InFlightEntry>();

const DIR_SEP = "\u0000";

function composeKey(baseDir: string, keyId: string): string {
  return `${baseDir}${DIR_SEP}${keyId}`;
}

export function getInFlightRead(baseDir: string, keyId = ""): Promise<MemoryFile[]> | undefined {
  const entry = inFlightReadsByKey.get(composeKey(baseDir, keyId));
  if (entry === undefined) return undefined;
  entry.detachCancellation?.();
  entry.detachCancellation = undefined;
  return entry.read;
}

export function setInFlightRead(
  baseDir: string,
  keyId: string,
  read: Promise<MemoryFile[]>,
  detachCancellation?: () => void,
): void {
  inFlightReadsByKey.set(composeKey(baseDir, keyId), { read, detachCancellation });
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
