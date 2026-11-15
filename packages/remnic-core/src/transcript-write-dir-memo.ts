import { createHash } from "node:crypto";

/** One entry per session, ~200 B each. */
export const DEFAULT_WRITE_DIR_MEMO_ENTRIES = 4096;

export interface WriteDirChoice {
  dir: string;
  channelDir: string;
}

/**
 * Remembers which storage directory a session's appends were verified to own,
 * so only a session's first append in a process pays the directory ownership
 * check (a full read of every daily file). The key holds the session key as a
 * digest so caller-chosen keys cannot inflate memory; the map is an LRU.
 *
 * The remembered choice is not re-derived from the bytes. A file edited on
 * disk behind the process is noticed on the session's first append after a
 * restart or after an append error ({@link forget}), not on every append.
 */
export class WriteDirMemo {
  private readonly entries = new Map<string, WriteDirChoice>();
  /** Bumped by every invalidation; a choice that was pending across one is not remembered. */
  private generation = 0;

  constructor(private readonly maxEntries: number = DEFAULT_WRITE_DIR_MEMO_ENTRIES) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new RangeError("maxEntries must be a positive integer");
    }
  }

  /** The remembered choice for the session, else the result of `choose` (remembered when it resolves). */
  async resolve(root: string, sessionKey: string, choose: () => Promise<WriteDirChoice>): Promise<WriteDirChoice> {
    const key = this.keyFor(root, sessionKey);
    const hit = this.entries.get(key);
    if (hit) {
      this.entries.delete(key);
      this.entries.set(key, hit);
      return hit;
    }
    const generation = this.generation;
    const chosen = await choose();
    if (generation !== this.generation) return chosen;
    this.entries.set(key, chosen);
    if (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
    return chosen;
  }

  clear(): void {
    this.generation++;
    this.entries.clear();
  }

  forget(root: string, sessionKey: string): void {
    this.generation++;
    this.entries.delete(this.keyFor(root, sessionKey));
  }

  private keyFor(root: string, sessionKey: string): string {
    return `${root}\0${createHash("sha256").update(sessionKey).digest("hex")}`;
  }
}
