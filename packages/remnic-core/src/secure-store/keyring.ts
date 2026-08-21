/**
 * In-memory keyring for the secure-store module (issue #690 PR 2/4).
 *
 * Holds derived AES-256-GCM master keys for unlocked stores. The
 * keyring is process-local: keys are NEVER persisted to disk, never
 * logged, and never serialized. A daemon restart re-locks every
 * registered store.
 *
 * Scoping
 * -------
 * Entries are keyed by a stable string id (typically the absolute
 * path to the secure-store directory, after `~` expansion). This
 * lets multiple memory roots share a single daemon process without
 * one store's key bleeding into another (matches the per-`serviceId`
 * scoping discipline called out in CLAUDE.md gotcha #11).
 *
 * Lifecycle
 * ---------
 *   - `unlock(id, key)` — register a derived key.
 *   - `getKey(id)` — read a registered key (or `null`).
 *   - `lock(id)` — clear a single entry, zeroing the key bytes.
 *   - `lockAll()` — clear every entry, zeroing every key.
 *   - `status(id)` — non-secret status snapshot for `secure-store
 *     status`.
 *
 * Zeroization
 * -----------
 * `lock` and `lockAll` overwrite the key buffer with zeros before
 * dropping the reference. The JS engine may keep additional copies
 * outside our control; this is best-effort hygiene, not a defense
 * against memory-dump attacks.
 */

const ENTRIES = new Map<string, KeyringEntry>();

/** A single unlocked store. The key buffer is never copied out. */
interface KeyringEntry {
  key: Buffer;
  unlockedAt: string;
}

/** Status snapshot — no secret material. */
export interface KeyringStatus {
  /** True iff a key is currently registered for this id. */
  unlocked: boolean;
  /** ISO-8601 timestamp the key was registered, or null when locked. */
  unlockedAt: string | null;
}

/**
 * Register a derived key for the given id. If an entry already
 * exists, its old key is zeroed before being replaced.
 *
 * The caller MUST pass an exclusive 32-byte buffer; the keyring
 * takes ownership and will zero it on lock.
 */
export function unlock(id: string, key: Buffer, now: () => Date = () => new Date()): void {
  if (typeof id !== "string" || id.length === 0) {
    throw new Error("keyring id must be a non-empty string");
  }
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw new Error(`keyring key must be a 32-byte Buffer, got length=${key?.length ?? "non-buffer"}`);
  }
  const existing = ENTRIES.get(id);
  if (existing) {
    existing.key.fill(0);
  }
  ENTRIES.set(id, { key, unlockedAt: now().toISOString() });
}

/** Read the registered key for `id`, or `null` if locked. */
export function getKey(id: string): Buffer | null {
  const entry = ENTRIES.get(id);
  return entry ? entry.key : null;
}

/** Clear a single entry. Zeros the underlying buffer. Returns true if cleared. */
export function lock(id: string): boolean {
  const entry = ENTRIES.get(id);
  if (!entry) return false;
  entry.key.fill(0);
  ENTRIES.delete(id);
  return true;
}

/** Clear every registered key. Used on shutdown or for tests. */
export function lockAll(): void {
  for (const entry of ENTRIES.values()) {
    entry.key.fill(0);
  }
  ENTRIES.clear();
}

/** Non-secret status snapshot. */
export function status(id: string): KeyringStatus {
  const entry = ENTRIES.get(id);
  if (!entry) {
    return { unlocked: false, unlockedAt: null };
  }
  return { unlocked: true, unlockedAt: entry.unlockedAt };
}

/** Test-only helper: how many entries are currently registered. */
export function size(): number {
  return ENTRIES.size;
}
