import type { DrainedTurnSets } from "./buffer-turn-helpers.js";
import type { BufferEntryState, BufferState, BufferSurpriseEvent } from "./types.js";
import type { BufferSessionSaveOutcome } from "./storage/buffer-drain-claims.js";

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
  /** Reports "handed_over" when the session is claimed by `remnic buffer drain` and the entry moved into the claim instead of a session file. Legacy doubles may return void (treated as "saved"). */
  saveBufferSession?(key: string, entry: BufferEntryState): Promise<BufferSessionSaveOutcome | void>;
  deleteBufferSession?(key: string): Promise<void>;
  /** Sync claim check for the extraction gate; omitted when the backend has no drain-claim store. */
  isBufferSessionClaimed?(key: string): boolean;
  /** Optional surprise-telemetry sink; older storage and test doubles omit it. */
  appendBufferSurpriseEvents?(events: BufferSurpriseEvent[]): Promise<number>;
}

/** What one persist pass changed beyond plain writes. */
export interface BufferPersistOutcome {
  /** Sessions whose in-memory entry moved into a drain claim: the caller must evict them (a claimed session no longer lives in this process). */
  handedOver: string[];
  /** Per session, the turns a drain extracted, kept in their original lists. */
  drainedTurns: Map<string, DrainedTurnSets>;
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
  ): Promise<BufferPersistOutcome> {
    const saveSession = storage.saveBufferSession?.bind(storage);
    const deleteSession = storage.deleteBufferSession?.bind(storage);
    if (!saveSession || !deleteSession) {
      await storage.saveBuffer(state);
      this.dirty.clear();
      this.deleted.clear();
      return { handedOver: [], drainedTurns: new Map() };
    }
    const handedOver: string[] = [];
    const drainedTurns = new Map<string, DrainedTurnSets>();
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
      const outcome = await saveSession(key, entry);
      this.dirty.delete(key);
      // "handed_over": the entry moved into a drain claim. Content is durable
      // in the claim, so this key's pending state is settled — the caller
      // evicts the in-memory entry on its side.
      if (outcome?.status === "handed_over") handedOver.push(key);
      // A drain tombstone: the turns it extracted must leave this process's
      // copy too, or the owner would extract them a second time.
      if (
        outcome?.drainedTurns &&
        (outcome.drainedTurns.turns.length > 0 || outcome.drainedTurns.retainedTurns.length > 0)
      ) {
        drainedTurns.set(key, outcome.drainedTurns);
      }
    }
    return { handedOver, drainedTurns };
  }
}
