/**
 * Cross-process-safe write lock for graph JSONL files (issue #2330 round
 * N+18 A). Sibling of graph.ts — extracted there so graph.ts stays within
 * its file-size ratchet; graph.ts re-exports {@link withGraphWriteLock}
 * because `@remnic/core/graph` is a public subpath export.
 *
 * Two layers, one per section:
 *
 * 1. An in-process promise chain keyed by JSONL file path (gotcha #40):
 *    the append path (`appendEdge`) and the rewrite path used by the decay
 *    maintenance job serialize on the same lock. Without this, an
 *    extraction can append a new edge between the decay job's
 *    read-snapshot and rewrite, silently dropping the appended edge during
 *    active traffic (issue #729 / Codex P1).
 *
 * 2. A cross-process advisory lock: the promise chain only serializes THIS
 *    process. A peer Remnic process sharing the memory directory could
 *    append an edge after this process reads its JSONL snapshot but before
 *    the rename-backed rewrite publishes, permanently discarding the
 *    peer's edge — so every section also holds the established
 *    `withHeldFileLock` advisory lock (the same primitive round N+16 gave
 *    the page-versioning manifest) as a sibling `<file>.lock`. A lock that
 *    cannot be taken within the bounded wait FAILS the write (strict,
 *    matching the manifest): proceeding unsynchronized would reintroduce
 *    the lost-write race the lock exists to prevent. Graph write callers
 *    are fail-open, so the surfaced error degrades to a logged skip.
 */

import { withHeldFileLock } from "./utils/serialize-mutations.js";

const graphWriteLocks = new Map<string, Promise<void>>();

/** Stale-lock window for the cross-process graph lock (crashed holder). */
const GRAPH_LOCK_STALE_MS = 30_000;
/** Bounded acquisition wait for the cross-process graph lock. */
const GRAPH_LOCK_MAX_WAIT_MS = 10_000;

/**
 * Run `fn` while holding the write lock for the given graph JSONL file.
 *
 * The lock is keyed by absolute file path so concurrent writes to
 * different graph types proceed independently. The chain recovers from
 * rejection (gotcha #40) so a single I/O failure does not poison all
 * future writers, but the original error is still surfaced to the
 * caller of `withGraphWriteLock`. The in-process chain runs INSIDE the
 * cross-process advisory lock, so peers serialize against every section
 * this process runs, one section at a time.
 */
export function withGraphWriteLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const run = () =>
    withHeldFileLock(
      `${filePath}.lock`,
      { staleMs: GRAPH_LOCK_STALE_MS, maxWaitMs: GRAPH_LOCK_MAX_WAIT_MS },
      (acquired) => {
        if (!acquired) {
          throw new Error(
            `graph: could not acquire the graph write lock for ${filePath} within ${GRAPH_LOCK_MAX_WAIT_MS}ms — another process holds it`,
          );
        }
        return fn();
      },
    );
  const prev = graphWriteLocks.get(filePath) ?? Promise.resolve();
  const next = prev.then(run, run);
  graphWriteLocks.set(
    filePath,
    next.then(
      () => undefined,
      () => undefined
    )
  );
  return next;
}
