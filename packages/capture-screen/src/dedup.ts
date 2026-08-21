/**
 * Per-window near-duplicate suppression. Keyed by (app, windowTitle): for each
 * window we remember the last STORED snapshot's SimHash and capture instant. A
 * new snapshot of the same window is stored only when it is meaningfully
 * different (Hamming distance > threshold) OR enough time has elapsed since the
 * last store (ttlSeconds), so a long unchanging window is refreshed periodically
 * while a stream of near-identical scroll states collapses to a few rows.
 * Distinct windows never dedup against each other (independent cache entries).
 *
 * The clock is the snapshot's own capturedAt (passed in as ms), never a
 * wall-clock read — so replay/fixtures are deterministic.
 */

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
    // NUL separator: app/title are arbitrary text, so a printable delimiter
    // could be forged by a title to alias a different (app,title) pair.
    return `${app}\u0000${windowTitle}`;
  }

  /** Seed the last-stored fingerprint for a window (used to prime from the spool). */
  seed(app: string, windowTitle: string, hash: bigint, atMs: number): void {
    this.#last.set(DedupCache.#key(app, windowTitle), { hash, atMs });
  }

  /**
   * Decide whether a snapshot should be stored, updating the cache when it is.
   * First snapshot of a window always stores. A negative elapsed (out-of-order
   * capture) stores defensively rather than dropping data.
   */
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
