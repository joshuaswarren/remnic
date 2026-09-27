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

/** The generation lock could not be acquired; callers fail closed and report it. */
export class EmbeddingGenerationLockUnavailableError extends Error {
  constructor(lockPath: string, reason: "timeout" | "error") {
    super(`embedding generation: could not acquire the mutation lock for ${lockPath} (${reason})`);
    this.name = "EmbeddingGenerationLockUnavailableError";
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
        throw new EmbeddingGenerationLockUnavailableError(lockPath, lock.failure ?? "error");
      }
      return fn(lock);
    })
  );
}

/** Capture a complete bounded digest census under lock, then stream outside
 * the lock. If any member changes, throw rather than emit a complete subset. */
export async function* withEmbeddingGenerationLockIter<T extends { path: string; sha256: string; bytes: number }>(
  absoluteStateDir: string,
  make: (includeContent: boolean) => AsyncIterable<T>,
  includeContent: boolean,
  verify?: () => Promise<void>
): AsyncIterable<T> {
  const lockPath = embeddingGenerationLockPath(absoluteStateDir);
  // Capture only bounded metadata under the lock, never large content or
  // network backpressure. Every emitted record must match this complete
  // generation census; a concurrent swap/dirty write aborts the stream.
  const baseline = await withEmbeddingGenerationLock(absoluteStateDir, async (section) => {
    await verify?.();
    const records: Array<{ path: string; sha256: string; bytes: number }> = [];
    for await (const record of make(false)) {
      await assertEmbeddingGenerationLockHeld(lockPath, section);
      records.push({ path: record.path, sha256: record.sha256, bytes: record.bytes });
    }
    return records;
  });
  let count = 0;
  for await (const record of make(includeContent)) {
    const expected = baseline[count++];
    if (!expected || expected.path !== record.path || expected.sha256 !== record.sha256 || expected.bytes !== record.bytes) {
      throw new Error(`embedding generation changed while streaming ${absoluteStateDir}; retry the snapshot`);
    }
    yield record;
  }
  if (count !== baseline.length) {
    throw new Error(`embedding generation changed while streaming ${absoluteStateDir}; retry the snapshot`);
  }
}
