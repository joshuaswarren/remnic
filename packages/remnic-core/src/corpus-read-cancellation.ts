/**
 * Cancellation contract for the shared full-corpus read primitives (issue #2307).
 *
 * `readAllArtifactsCached`, `readAllEntityFiles`, `readAllMemories`, and the
 * artifact source-status snapshot each walk and parse an entire memory tree. Issue
 * #2291 bounded the recall providers that call them, so a timed-out recall returns
 * on time — but the scan underneath kept running, and for the primitives without
 * in-flight coalescing every abandoned request started another one. On a large or
 * network-mounted store those pile up into sustained I/O no live request needs.
 *
 * The mechanism is a plain optional parameter, not ambient async context: these
 * primitives have dozens of callers across extraction, maintenance, wearables, and
 * coding surfaces, and an ambient signal would silently attach a request's
 * cancellation to background work that merely shares its async context. An
 * explicit parameter is greppable, and a caller that does not opt in behaves
 * exactly as before.
 *
 * Two invariants bind every implementation:
 *
 *  1. **Checked before the cache lookup.** A caller that has already given up gets
 *     an `AbortError`, warm cache or not — the same contract the recall providers
 *     follow, so cancellation never depends on cache state.
 *  2. **A cancelled read never publishes.** Every checkpoint throws, so control
 *     leaves before the cache write. A partial corpus must never be cached, or
 *     served, as if it were complete.
 */

import { throwIfAborted } from "./abort-error.js";

export interface CorpusReadOptions {
  /**
   * Stops the read at its next directory, batch, or attempt boundary. A single
   * in-flight file read is not interrupted; the boundaries are what bound the
   * work, and on a tree large enough to matter there are thousands of them.
   */
  abortSignal?: AbortSignal;
}

/** Stop a corpus read at a scan boundary when its caller has given up. */
export function checkCorpusReadAbort(options?: CorpusReadOptions): void {
  throwIfAborted(options?.abortSignal, "corpus read aborted");
}
