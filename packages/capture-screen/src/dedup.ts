
import { hammingDistance } from "./simhash.js";

interface Entry {
  hash: bigint;
  atMs: number;
}

export class DedupCache {
  #last = new Map<string, Entry>();
  readonly #threshold: number;
  readonly #ttlSeconds: number;

  constructor(threshold: number, ttlSeconds: number) {
    this.#threshold = threshold;
    this.#ttlSeconds = ttlSeconds;
  }

  static #key(app: string, windowTitle: string): string {
    // could be forged by a title to alias a different (app,title) pair.
    return `${app}\u0000${windowTitle}`;
  }

  /** Seed the last-stored fingerprint for a window (used to prime from the spool). */
  seed(app: string, windowTitle: string, hash: bigint, atMs: number): void {
    this.#last.set(DedupCache.#key(app, windowTitle), { hash, atMs });
  }

  shouldStore(app: string, windowTitle: string, hash: bigint, atMs: number): boolean {
    const key = DedupCache.#key(app, windowTitle);
    const prev = this.#last.get(key);
    let store: boolean;
    if (prev === undefined) {
      store = true;
    } else {
      const elapsedSeconds = (atMs - prev.atMs) / 1000;
      store =
        elapsedSeconds < 0 ||
        elapsedSeconds >= this.#ttlSeconds ||
        hammingDistance(hash, prev.hash) > this.#threshold;
    }
    if (store) this.#last.set(key, { hash, atMs });
    return store;
  }
}
