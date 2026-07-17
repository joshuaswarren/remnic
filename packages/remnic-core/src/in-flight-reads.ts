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
const inFlightReadsByKey = new Map<string, Promise<MemoryFile[]>>();

const DIR_SEP = "\u0000";

function composeKey(baseDir: string, keyId: string): string {
  return `${baseDir}${DIR_SEP}${keyId}`;
}

export function getInFlightRead(baseDir: string, keyId = ""): Promise<MemoryFile[]> | undefined {
  return inFlightReadsByKey.get(composeKey(baseDir, keyId));
}

export function setInFlightRead(baseDir: string, keyId: string, read: Promise<MemoryFile[]>): void {
  inFlightReadsByKey.set(composeKey(baseDir, keyId), read);
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
  if (expected === undefined || inFlightReadsByKey.get(key) === expected) {
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
