import type { BufferEntryState, BufferState, BufferSurpriseEvent } from "./types.js";

/**
 * The buffer persistence surface SmartBuffer depends on.
 *
 * `saveBufferSession` / `deleteBufferSession` are the per-session incremental
 * writes (one file per session); when a storage backend does not provide
 * them, the buffer falls back to the whole-state `saveBuffer`. Both are
 * optional in the type so a storage double only has to implement what it
 * actually supports.
 */
export interface BufferStorage {
  loadBuffer(): Promise<BufferState>;
  saveBuffer(state: BufferState): Promise<void>;
  saveBufferSession?(key: string, entry: BufferEntryState): Promise<void>;
  deleteBufferSession?(key: string): Promise<void>;
  /** Optional surprise-telemetry sink; older storage and test doubles omit it. */
  appendBufferSurpriseEvents?(events: BufferSurpriseEvent[]): Promise<number>;
}

/**
 * Tracks which sessions' persisted files are stale and writes only those.
 *
 * Marks are cleared only after a durable write of that session. All calls
 * happen under SmartBuffer's serialized mutation chain: one writer.
 */
export class BufferSessionPersistence {
  private readonly dirty = new Set<string>();
  private readonly deleted = new Set<string>();

  markDirty(key: string): void {
    this.dirty.add(key);
    this.deleted.delete(key);
  }

  markDeleted(key: string): void {
    this.deleted.add(key);
    this.dirty.delete(key);
  }

  /** Eviction removed `key` from memory: its session file must go, any pending write is moot. */
  markEvicted(keys: readonly string[]): void {
    for (const key of keys) this.markDeleted(key);
  }

  hasPending(): boolean {
    return this.dirty.size > 0 || this.deleted.size > 0;
  }

  /**
   * Persist buffer state. On session-capable storage this writes ONLY the
   * sessions whose state changed since the last successful persist and
   * deletes files for evicted/reset sessions, so the observe path never
   * re-serializes other sessions' turns. On legacy storage it falls back to
   * the whole-state saveBuffer. Files are deleted before dirty writes: a
   * crash mid-persist can then only resurrect already-evicted data (the same
   * exposure as a whole-file rewrite), never drop sessions the state says
   * exist.
   */
  async persist(
    storage: BufferStorage,
    state: BufferState,
    peekEntry: (key: string) => BufferEntryState | undefined,
  ): Promise<void> {
    const saveSession = storage.saveBufferSession?.bind(storage);
    const deleteSession = storage.deleteBufferSession?.bind(storage);
    if (!saveSession || !deleteSession) {
      await storage.saveBuffer(state);
      this.dirty.clear();
      this.deleted.clear();
      return;
    }
    for (const key of [...this.deleted]) {
      await deleteSession(key);
      this.deleted.delete(key);
    }
    for (const key of [...this.dirty]) {
      const entry = peekEntry(key);
      if (!entry) {
        // A dirty key without state must not be written from a fabricated
        // empty entry: treat it as a deletion instead.
        this.markDeleted(key);
        continue;
      }
      await saveSession(key, entry);
      this.dirty.delete(key);
    }
  }
}
