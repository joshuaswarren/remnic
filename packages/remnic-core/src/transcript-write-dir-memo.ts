import { createHash } from "node:crypto";

/** One entry per session, ~200 B each. */
export const DEFAULT_WRITE_DIR_MEMO_ENTRIES = 4096;

export interface WriteDirChoice {
  dir: string;
  channelDir: string;
}

export class WriteDirMemo {
  private readonly entries = new Map<string, WriteDirChoice>();
  private generation = 0;
  private readonly lanes = new Map<string, Promise<void>>();

  constructor(private readonly maxEntries: number = DEFAULT_WRITE_DIR_MEMO_ENTRIES) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new RangeError("maxEntries must be a positive integer");
    }
  }

  get pendingLanes(): number {
    return this.lanes.size;
  }

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

  /**
   * Run a session's append. A session whose directory is already remembered
   * runs at once. Any other session's first append runs after the earlier
   * first appends that share its primary directory: two sessions that map to
   * one directory (two agents in one channel) must not both find it empty and
   * both claim it, so the second check has to see the first session's row.
   */
  async run<T>(root: string, sessionKey: string, primaryDir: string, fn: () => Promise<T>): Promise<T> {
    if (this.entries.has(this.keyFor(root, sessionKey))) return fn();
    const lane = `${root}\0${primaryDir}`;
    const result = (this.lanes.get(lane) ?? Promise.resolve()).then(fn);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.lanes.set(lane, tail);
    try {
      return await result;
    } finally {
      if (this.lanes.get(lane) === tail) this.lanes.delete(lane);
    }
  }

  async removing<T>(remove: () => Promise<T>): Promise<T> {
    try {
      return await remove();
    } finally {
      this.clear();
    }
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
