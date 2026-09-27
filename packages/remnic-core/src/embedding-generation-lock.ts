// Cross-process embedding-generation mutation lock (issue #3148, Codex P1).
//
// Two processes legitimately mutate the SAME embedding generation: the
// daemon's EmbeddingFallback index mutations (load → modify → persist) and
// the offline-sync apply transaction (census → stage → swap) — plus the
// snapshot walkers that must capture one COMPLETE generation. All of them
// enumerate or replace `state/embeddings/` (or the legacy marker), so an
// unsynchronized writer's bytes are silently discarded by the other side's
// wholesale directory swap.
//
// Built directly on the existing utilities: `serializeMutations` (in-process
// keyed chain, rejection-recovering — gotcha #40) around `withHeldFileLock`
// (cross-process held advisory lock, replacement-safe stale breaking,
// ownership-checked release). A lock that cannot be acquired within the
// bounded wait FAILS CLOSED — proceeding unsynchronized would reintroduce
// the lost-write race this lock exists to prevent.
//
// The lock is keyed by the PHYSICAL state directory (dirname of the
// generation's shard dir / of the legacy marker), so every caller
// convention — memory-root-relative (`namespaces/<ns>/state`) or
// namespace-scoped roots (`<ns>/state`) — contends on the SAME lock file
// for the same generation. The lock file lives under that state dir's
// `.offline-sync/` (sync-internal, excluded from every offline-sync
// snapshot by the default excludes).
import path from "node:path";
import { type HeldFileLockController, serializeMutations, withHeldFileLock } from "./utils/serialize-mutations.js";

/** Stale-lock window for a crashed holder (mirrors the graph lock). */
const LOCK_STALE_MS = 30_000;
/** Bounded acquisition wait; a busy lock FAILS the operation (strict). */
const LOCK_MAX_WAIT_MS = 10_000;

/** Control surface handed to a held embedding-generation lock section. */
export type EmbeddingGenerationLockSection = HeldFileLockController;

/**
 * A fence the store calls immediately before a destructive write: reasserts
 * lock ownership so a peer that stale-broke and replaced the lock aborts
 * this write instead of clobbering the peer's.
 */
export type EmbeddingGenerationFence = () => Promise<void>;

/**
 * A held embedding-generation lock section was lost mid-critical-section —
 * a peer stale-broke and replaced it. Abort; never publish.
 */
export class EmbeddingGenerationLockLostError extends Error {
  constructor(lockPath: string) {
    super(
      `embedding generation: the mutation lock for ${lockPath} was lost mid-section — a peer stale-broke and replaced it; aborting instead of clobbering the peer's write`
    );
    this.name = "EmbeddingGenerationLockLostError";
  }
}

/**
 * The lock file path for the generation whose canonical state dir is
 * `absoluteStateDir` (physical path; e.g. `<memoryRoot>/state` or
 * `<memoryRoot>/namespaces/<ns>/state`). Keyed by the physical directory so
 * every root convention contends on one lock file per generation.
 */
export function embeddingGenerationLockPath(absoluteStateDir: string): string {
  const stateDir = path.resolve(absoluteStateDir);
  return path.join(stateDir, ".offline-sync", "locks", "embedding-generation.lock");
}

/**
 * Revalidate lock ownership immediately before a destructive publish.
 * Throws {@link EmbeddingGenerationLockLostError} when the lock was
 * broken/replaced, so the caller aborts and leaves the peer's write intact.
 */
export async function assertEmbeddingGenerationLockHeld(
  lockPath: string,
  section: EmbeddingGenerationLockSection
): Promise<void> {
  if (!(await section.refresh())) throw new EmbeddingGenerationLockLostError(lockPath);
}

/**
 * Run `fn` while holding the embedding-generation mutation lock for the
 * generation whose state dir is `absoluteStateDir`, handing it the section
 * controller. `serializeMutations` provides the in-process keyed chain
 * INSIDE the cross-process advisory lock, so peers serialize against every
 * section this process runs, one at a time. Times out fail-closed.
 */
export function withEmbeddingGenerationLock<T>(
  absoluteStateDir: string,
  fn: (lock: EmbeddingGenerationLockSection) => Promise<T>
): Promise<T> {
  const lockPath = embeddingGenerationLockPath(absoluteStateDir);
  return serializeMutations(lockPath, () =>
    withHeldFileLock(lockPath, { staleMs: LOCK_STALE_MS, maxWaitMs: LOCK_MAX_WAIT_MS }, (acquired, lock) => {
      if (!acquired) {
        throw new Error(
          `embedding generation: could not acquire the mutation lock for ${lockPath} within ${LOCK_MAX_WAIT_MS}ms — another process holds it`
        );
      }
      return fn(lock);
    })
  );
}

/**
 * Hold the generation mutation lock while STREAMING `make()`'s records, one
 * at a time — never buffering the whole generation in memory. The lock is
 * acquired before the first record is pulled and released when the consumer
 * drains, breaks, or the capture fails, so a concurrent writer either lands
 * entirely before the capture or entirely after it: a swap can never turn a
 * streamed enumeration into a valid-looking partial generation. Acquisition
 * failure is surfaced to the consumer (fail closed).
 */
export async function* withEmbeddingGenerationLockIter<T>(
  absoluteStateDir: string,
  make: () => AsyncIterable<T>
): AsyncIterable<T> {
  const lockPath = embeddingGenerationLockPath(absoluteStateDir);
  let start!: (lock: EmbeddingGenerationLockSection) => void;
  let fail!: (err: unknown) => void;
  const acquired = new Promise<EmbeddingGenerationLockSection>((resolve, reject) => {
    start = resolve;
    fail = reject;
  });
  let finishGate = () => {};
  const finished = new Promise<void>((resolve) => {
    finishGate = resolve;
  });
  const holder = serializeMutations(lockPath, () =>
    withHeldFileLock(lockPath, { staleMs: LOCK_STALE_MS, maxWaitMs: LOCK_MAX_WAIT_MS }, async (acquired, lock) => {
      if (!acquired) {
        throw new Error(
          `embedding generation: could not acquire the mutation lock for ${lockPath} within ${LOCK_MAX_WAIT_MS}ms — another process holds it`
        );
      }
      start(lock);
      await finished;
    })
  );
  holder.catch((err) => {
    fail(err);
    finishGate();
  });
  const it = make()[Symbol.asyncIterator]();
  try {
    const section = await acquired;
    while (true) {
      await assertEmbeddingGenerationLockHeld(lockPath, section);
      const next = await it.next();
      await assertEmbeddingGenerationLockHeld(lockPath, section);
      if (next.done) break;
      yield next.value;
    }
  } finally {
    finishGate();
    await it.return?.(undefined).catch(() => undefined);
    await holder.catch(() => undefined);
  }
}
