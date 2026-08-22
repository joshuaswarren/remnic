/**
 * Cross-process-safe write lock for graph JSONL files (issue #2330 round
 * N+18 A). Sibling of graph.ts — extracted there so graph.ts stays within
 * its file-size ratchet; graph.ts re-exports {@link withGraphWriteLock}
 * because `@remnic/core/graph` is a public subpath export.
 *
 * Three layers, one per section:
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
 *
 * 3. Ownership revalidation before destructive writes (round N+19 A): the
 *    lock's mtime heartbeat is a TIMER — it cannot fire while a
 *    synchronous parse/serialize of a large graph blocks the event loop.
 *    A peer can then judge the lock stale past the 30s window, break it,
 *    and publish its own write. Every section therefore receives the
 *    lock's {@link GraphWriteLockSection} controller and MUST pass it to
 *    {@link assertGraphLockHeld} immediately before publishing a
 *    replacement (or appending): a lost lock aborts THIS write with
 *    {@link GraphLockLostError} instead of clobbering the peer's. Long
 *    CPU passes inside a section should await {@link
 *    yieldForLockHeartbeat} every few thousand rows so the heartbeat
 *    timer gets a turn and the section is less likely to be broken in
 *    the first place.
 */

import { withHeldFileLock, type HeldFileLockController } from "./utils/serialize-mutations.js";

const graphWriteLocks = new Map<string, Promise<void>>();

/** Stale-lock window for the cross-process graph lock (crashed holder). */
const GRAPH_LOCK_STALE_MS = 30_000;
/** Bounded acquisition wait for the cross-process graph lock. */
const GRAPH_LOCK_MAX_WAIT_MS = 10_000;

/** Control surface handed to a graph write-lock section (round N+19 A). */
export type GraphWriteLockSection = HeldFileLockController;

/**
 * A graph write section lost its advisory lock mid-critical-section — a peer
 * stale-broke and replaced it while this process's event loop was blocked.
 * The thrower has NOT published its write; callers treat it like any other
 * write failure (graph callers are fail-open).
 */
export class GraphLockLostError extends Error {
  constructor(filePath: string) {
    super(
      `graph: the write lock for ${filePath} was lost mid-section — a peer stale-broke and replaced it; aborting this write instead of clobbering the peer's`,
    );
    this.name = "GraphLockLostError";
  }
}

/**
 * Revalidate lock ownership immediately before a destructive graph write.
 * Throws {@link GraphLockLostError} when the lock was broken/replaced, so the
 * caller aborts and leaves the peer's write intact.
 */
export async function assertGraphLockHeld(
  filePath: string,
  lock: GraphWriteLockSection,
): Promise<void> {
  if (!(await lock.refresh())) throw new GraphLockLostError(filePath);
}

/**
 * Yield one event-loop turn so the lock's heartbeat timer can fire during a
 * long, CPU-bound parse/serialize/decay pass inside a held graph lock
 * section (round N+19 A). `setImmediate` runs in the check phase, after any
 * due timers, so each yield lets an overdue heartbeat stamp the lock's mtime
 * before a peer judges it stale.
 */
export function yieldForLockHeartbeat(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

/**
 * Run `fn` while holding the write lock for the given graph JSONL file,
 * handing it the section's {@link GraphWriteLockSection} controller.
 *
 * The lock is keyed by absolute file path so concurrent writes to
 * different graph types proceed independently. The chain recovers from
 * rejection (gotcha #40) so a single I/O failure does not poison all
 * future writers, but the original error is still surfaced to the
 * caller of `withGraphWriteLock`. The in-process chain runs INSIDE the
 * cross-process advisory lock, so peers serialize against every section
 * this process runs, one section at a time.
 */
export function withGraphWriteLock<T>(
  filePath: string,
  fn: (lock: GraphWriteLockSection) => Promise<T>,
): Promise<T> {
  const run = () =>
    withHeldFileLock(
      `${filePath}.lock`,
      { staleMs: GRAPH_LOCK_STALE_MS, maxWaitMs: GRAPH_LOCK_MAX_WAIT_MS },
      (acquired, lock) => {
        if (!acquired) {
          throw new Error(
            `graph: could not acquire the graph write lock for ${filePath} within ${GRAPH_LOCK_MAX_WAIT_MS}ms — another process holds it`,
          );
        }
        return fn(lock);
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
