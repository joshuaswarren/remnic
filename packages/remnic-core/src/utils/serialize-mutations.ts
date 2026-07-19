// ---------------------------------------------------------------------------
// Shared serialized-mutation utilities for TOCTOU hotspots (issue #1524).
//
// Two complementary primitives that the namespace catalog (`queueCritical` +
// `withHeldCatalogLock`), the storage router's resolve-hook serialization, and
// the summary-snapshot writer each re-implement today:
//
//   1. `serializeMutations(key, task)` — keyed IN-PROCESS async serialization
//      that recovers after a rejection (CLAUDE.md rule #40). One failed task
//      never poisons the tasks queued behind it; the failed task's error is
//      still surfaced to ITS caller.
//
//   2. `withHeldFileLock(lockPath, opts, task)` — a held CROSS-PROCESS file
//      lock with replacement-safe stale breaking (the NG7Bg invariant from
//      #1506 round 28) and ownership-checked release.
//
// This is the UTILITY module only. Per-issue PR split: one PR for the utility
// + tests (this file), then one PR per adoption hotspot (catalog, router
// provenance, summary snapshot). No adoptions live here.
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, rename, stat, unlink, utimes } from "node:fs/promises";
import path from "node:path";

// ─────────────────────────────────────────────────────────────────────────────
// 1. serializeMutations — keyed async serialization with rejection recovery
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One entry in the per-key serialization map. `tail` is the recovered promise
 * the next queued task chains off of; it never rejects (both settle handlers
 * swallow), so a prior task's failure can never break subsequent ones.
 */
interface MutationChainEntry {
  tail: Promise<void>;
}

/**
 * Instance-scoped keyed serializer. Holds the per-key chain map so that all
 * tasks queued under the same key on the SAME serializer run strictly in order.
 *
 * The map is instance-scoped (not module-level) so tests can construct a fresh
 * serializer per case and avoid cross-test contamination, and so adopters that
 * want isolation (e.g. one serializer per storage root) can have it. The free
 * {@link serializeMutations} export delegates to a single shared default
 * instance for callers that want process-wide serialization.
 */
export class MutationSerializer {
  private readonly chains = new Map<string, MutationChainEntry>();

  /**
   * Run `task` strictly after every other task already queued under `key` on
   * this serializer has settled.
   *
   * Rejection recovery (rule #40, mirroring the catalog's `queueCritical`):
   * if a prior task rejects, later tasks STILL RUN, while the rejecting task's
   * error is surfaced to ITS OWN caller. Concretely, the recovered tail is
   * `run.then(noop, noop)` — never a bare `.then(fn)`, which would let one
   * failure kill every queued task behind it.
   *
   * No unbounded growth: when a chain's last task settles and no newer task
   * chained onto it, its entry is deleted (the storage router's
   * `inFlightResolved` marker-then-clear discipline).
   */
  serialize<T>(key: string, task: () => Promise<T>): Promise<T> {
    if (typeof key !== "string" || key.length === 0) {
      throw new TypeError("MutationSerializer.serialize: key must be a non-empty string");
    }
    if (typeof task !== "function") {
      throw new TypeError("MutationSerializer.serialize: task must be a function returning a promise");
    }

    let entry = this.chains.get(key);
    if (!entry) {
      entry = { tail: Promise.resolve() };
      this.chains.set(key, entry);
    }

    // Chain this task off the prior tail. `tail.then(task)` runs task only once
    // the previous task has settled, preserving read-modify-write ordering.
    const run = entry.tail.then(task);

    // Recover the tail after a rejection so a failed task never poisons later
    // ones. Both handlers swallow; `run` still carries the original resolution
    // (or rejection) to THIS caller. This is the line a naive `.then(fn)`
    // implementation omits — see the "naive poison chain" prove-fail test.
    const recovered = run.then(settleNoop, settleNoop);
    entry.tail = recovered;

    // Self-cleaning: once our recovered tail settles, if no newer task chained
    // onto us the entry still points at `recovered` and is safe to delete. A
    // concurrent `serialize()` call enqueues synchronously and would have
    // replaced `entry.tail` BEFORE this microtask runs, so the identity check
    // is race-free (no newer task's entry can be wrongly removed).
    //
    // `recovered` cannot reject in correct operation (both handlers above
    // swallow) and the cleanup body cannot throw — but we attach a rejection
    // handler anyway so that IF the recovery invariant is ever broken, the
    // failure surfaces as a behavioral assertion (skipped tasks) rather than an
    // unhandled-rejection storm that masks which task failed. The handler is a
    // no-op: cleanup only runs on fulfillment.
    void recovered.then(
      () => {
        if (entry && entry.tail === recovered) {
          this.chains.delete(key);
        }
      },
      () => undefined,
    );

    return run;
  }

  /**
   * Test-only: the number of keys with a not-yet-cleaned chain. Used to assert
   * the no-unbounded-growth invariant. Not part of the public contract.
   */
  pendingKeysForTest(): number {
    return this.chains.size;
  }
}

/**
 * Recovery handler shared by both settle arms. Named (not inline
 * `() => undefined`) so the chain assignment stays self-documenting in stack
 * traces and the review-patterns poison-chain check can see the chain is
 * recovered, not bare `.then(fn)`.
 */
function settleNoop(): void {
  /* swallow — the original resolution/rejection is carried by `run` */
}

/**
 * Process-wide default serializer backing the free {@link serializeMutations}
 * export. Lazy so it is only created when first used (tests that construct
 * their own `MutationSerializer` pay nothing).
 */
let defaultSerializer: MutationSerializer | undefined;

/**
 * Free-function entry point (issue #1524 signature). Serializes `task` against
 * every other task queued under `key` across the whole process, via a shared
 * default {@link MutationSerializer}. For isolated/testable serialization,
 * construct a `MutationSerializer` directly.
 */
export function serializeMutations<T>(key: string, task: () => Promise<T>): Promise<T> {
  if (!defaultSerializer) defaultSerializer = new MutationSerializer();
  return defaultSerializer.serialize(key, task);
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. withHeldFileLock — cross-process held file lock with stale breaking
// ─────────────────────────────────────────────────────────────────────────────

/** Options for {@link withHeldFileLock}. */
export interface HeldFileLockOptions {
  /**
   * A lock whose mtime is older than this (in ms) is treated as a crashed
   * holder and broken. Required — there is no safe default, since the right
   * value depends on how long the guarded critical section can legitimately
   * run.
   */
  readonly staleMs: number;
  /**
   * Bounded acquisition: give up trying to acquire a busy lock after this long
   * (ms) and invoke `task(false)` best-effort WITHOUT holding the lock, rather
   * than blocking forever or crashing the primary op. Default 5000ms (matches
   * the namespace catalog's `REBUILD_LOCK_MAX_WAIT_MS`).
   */
  readonly maxWaitMs?: number;
  /**
   * Poll interval (ms) while waiting for a busy lock to clear. Default 50ms.
   */
  readonly pollMs?: number;
  /**
   * While WE hold the lock, refresh its mtime on this cadence (ms) so a
   * legitimately long task is not mistaken for a crashed holder and broken out
   * from under. Default `floor(staleMs / 3)` (at least 100ms), mirroring the
   * catalog heartbeat ratio. Must be comfortably below `staleMs`.
   */
  readonly heartbeatMs?: number;
  /**
   * Test seam (NG7Bg, #1506 round 28): fires AFTER a lock is judged stale and
   * BEFORE the re-verify + unlink, simulating a replacement lock being created
   * in the race window. No-op in production.
   */
  readonly onBeforeBreakStaleUnlinkForTest?: () => Promise<void> | void;
  /**
   * Test seam (codex P2): fires AFTER the release rename moves the lock to a
   * trash path and BEFORE the ownership re-verify/restore — simulating a third
   * contender acquiring the (now-empty) lockPath in the race window. No-op in
   * production. Used to prove the pre-check prevents the rename entirely.
   */
  readonly onAfterReleaseRenameForTest?: () => Promise<void> | void;
  /**
   * Best-effort hook for non-fatal lock warnings (heartbeat refresh failure,
   * release-time ownership check failure). Never throws into the caller. If
   * omitted, warnings are swallowed (the lock is advisory; release/heartbeat
   * failures must never crash the guarded op).
   */
  readonly onLockWarning?: (message: string, err: unknown) => void;
}

/**
 * Control surface handed to a held-lock task so a long, CPU-bound critical
 * section can re-assert ownership immediately before its destructive write.
 */
export interface HeldFileLockController {
  /**
   * Re-verify THIS acquirer still owns the lock and, when it does, refresh the
   * lock's mtime. Returns `true` only while we still hold it.
   *
   * The timer heartbeat cannot fire while a synchronous, CPU-bound section
   * (a large parse/merge/sort/serialize) blocks the event loop, so a peer can
   * judge the lock stale, break it, and start its own write within the stale
   * window. A caller about to perform a destructive rewrite MUST call this
   * first: `false` means the lock was stale-broken/replaced and the caller MUST
   * abort rather than clobber the peer that now holds it; `true` also re-stamps
   * the mtime so the bounded write that immediately follows cannot itself be
   * judged stale mid-write. On the best-effort unlocked path (`acquired` was
   * `false`) this always resolves `false` — there is no lock to hold.
   */
  refresh(): Promise<boolean>;
}

/** Default bounded acquisition wait, mirroring the catalog. */
const DEFAULT_MAX_WAIT_MS = 5_000;
/** Default busy-lock poll interval, mirroring the catalog. */
const DEFAULT_POLL_MS = 50;
/** Floor for the derived heartbeat cadence. */
const MIN_HEARTBEAT_MS = 100;
/** Node's setTimeout/setInterval 32-bit signed-int ceiling (2^31 − 1 ms ≈ 24.8
 * days). Delays above this are silently clamped to 1ms by the Node timer, so
 * timer-backed options (pollMs, heartbeatMs) must be rejected at this boundary
 * (chatgpt-codex-connector P2). */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** Internal handle for a lock we successfully acquired. */
interface HeldLock {
  readonly path: string;
  readonly ownerId: string;
}

/**
 * Run `task` under an exclusive on-disk lock at `lockPath`.
 *
 * Cross-process mutex via `open(lockPath, "wx")` (atomic exclusive create).
 * While held, a heartbeat timer refreshes the lock's mtime so a legitimately
 * long task is not mistaken for a crashed holder and broken out from under. A
 * lock older than `opts.staleMs` is treated as stale and broken — but
 * REPLACEMENT-SAFE (NG7Bg): we capture the stale lock's identity (full content
 * line: `<pid> <owner-uuid> <iso>`) when judging it stale, then RE-READ and
 * RE-STAT immediately before `unlink`, deleting only if byte-identical AND
 * still stale. A replacement lock created in the window has a different owner
 * id / timestamp, so its content differs and is left untouched.
 *
 * `task` receives `acquired: boolean` — `true` when we hold the lock, `false`
 * when acquisition timed out (best-effort). The signature takes
 * `(acquired) => Promise<T>` rather than the issue's sketched `() => Promise<T>`
 * so this can be the SINGLE lock home (issue: "do NOT leave two lock
 * implementations; pick one home"): the catalog's touch path needs to DROP on
 * timeout, which requires knowing whether the lock was acquired. A caller that
 * ignores the flag is still assignable (`() => Promise<T>` ⊆
 * `(acquired: boolean) => Promise<T>` in TypeScript).
 *
 * Release is ownership-checked: we only `unlink` a lock whose content still
 * identifies THIS acquirer (same owner id), so a replacement created after we
 * stopped heartbeating is never destroyed — mirroring the catalog's
 * `rebuildLockHeldBySelf`.
 *
 * ADOPTION NOTE: lock only the brief final read-merge-write window, never a
 * long scan — a scan-length lock makes concurrent writers time out and
 * silently drop work (catalog round 5, codex/cursor P2).
 */
export async function withHeldFileLock<T>(
  lockPath: string,
  opts: HeldFileLockOptions,
  task: (acquired: boolean, lock: HeldFileLockController) => Promise<T>,
): Promise<T> {
  if (typeof lockPath !== "string" || lockPath.length === 0) {
    throw new TypeError("withHeldFileLock: lockPath must be a non-empty string");
  }
  if (typeof opts?.staleMs !== "number" || !Number.isFinite(opts.staleMs) || opts.staleMs <= 0) {
    throw new TypeError(
      `withHeldFileLock: opts.staleMs must be a positive finite number ` +
        `(valid range: > 0 ms, finite; got ${formatInvalidNumber(opts?.staleMs)}).`,
    );
  }

  // Validate optional timings: a NaN/Infinity here is a real hazard (e.g.
  // `Date.now() + NaN` === NaN, so `Date.now() >= deadline` is always false and
  // the bounded acquire loop would wait forever instead of falling back to
  // best-effort). Reject invalid input rather than silently defaulting it
  // (codex P2 review). Omitting an option still picks its default.
  const maxWaitMs = optionalPositiveMs(opts.maxWaitMs, "maxWaitMs", DEFAULT_MAX_WAIT_MS, MAX_TIMER_DELAY_MS);
  const pollMs = optionalPositiveMs(opts.pollMs, "pollMs", DEFAULT_POLL_MS, MAX_TIMER_DELAY_MS);
  const heartbeatMs = optionalPositiveMs(
    opts.heartbeatMs,
    "heartbeatMs",
    Math.max(MIN_HEARTBEAT_MS, Math.floor(opts.staleMs / 3)),
    MAX_TIMER_DELAY_MS,
  );
  if (heartbeatMs >= opts.staleMs) {
    throw new TypeError(
      `withHeldFileLock: heartbeatMs (${heartbeatMs}) must be below staleMs (${opts.staleMs}) ` +
        `(valid range: > 0 and < staleMs ms) so at least one heartbeat lands per stale window.`,
    );
  }
  if (heartbeatMs > MAX_TIMER_DELAY_MS) {
    throw new TypeError(
      `withHeldFileLock: derived heartbeatMs (${heartbeatMs} = floor(staleMs/3)) exceeds ` +
        `Node's setTimeout ceiling (${MAX_TIMER_DELAY_MS} ms). Use an explicit opts.heartbeatMs ` +
        `at or below ${MAX_TIMER_DELAY_MS} ms.`,
    );
  }
  // Wrap the consumer's warning hook so a throwing callback never turns a
  // non-fatal advisory lock warning into an unhandled rejection (heartbeat
  // catch handler) or overrides the task's result (release path). The option
  // is documented as never throwing into the caller; enforce that here
  // (codex P2 review).
  const rawWarn = opts.onLockWarning;
  const warn = (message: string, err: unknown): void => {
    if (!rawWarn) return;
    try {
      rawWarn(message, err);
    } catch {
      /* swallow — a throwing advisory hook must not crash the guarded op */
    }
  };

  // Per-call owner identity. Two withHeldFileLock calls in the SAME process
  // get different ids, so neither mistakes the other's lock for its own
  // (stronger than the catalog's per-instance id, which is what we want for a
  // stateless utility).
  const ownerId = randomUUID();
  const lockDir = path.dirname(lockPath);

  const held = await acquireLock(lockPath, lockDir, ownerId, opts, maxWaitMs, pollMs);
  if (!held) {
    // Best-effort: run the task WITHOUT the lock. The caller decides what to
    // do (the catalog touch path will drop its append); we never crash the
    // primary op on contention.
    return task(false, { refresh: async () => false });
  }

  // Heartbeat: while WE hold the lock, refresh its mtime so age-based stale
  // detection sees an active holder and does not break us out from under
  // (catalog round 5). Failures are swallowed (advisory lock); the timer is
  // always cleared in the finally.
  //
  // OWNERSHIP CHECK (codex P2): if our event loop was paused long enough that
  // another process judged us stale, broke our lock, and created a replacement,
  // we must NOT refresh the replacement's mtime — that would keep a (possibly
  // crashed) replacement looking fresh. Verify lockHeldBySelf before each
  // utimes; if ownership is lost, stop heartbeating (our lock is gone).
  const heartbeat = setInterval(() => {
    lockHeldBySelf(held)
      .then((ours) => {
        if (!ours) return; // broken/replaced — stop refreshing
        return utimes(held.path, new Date(), new Date());
      })
      .catch((err: unknown) => {
        warn("withHeldFileLock heartbeat refresh failed", err);
      });
  }, heartbeatMs);
  // Don't keep the event loop alive solely for the heartbeat.
  heartbeat.unref?.();
  const controller: HeldFileLockController = { refresh: () => refreshHeldLock(held, warn) };
  try {
    return await task(true, controller);
  } finally {
    clearInterval(heartbeat);
    await releaseLock(held, warn, opts.onAfterReleaseRenameForTest);
  }
}

/**
 * Resolve an optional millisecond timing option, REJECTING invalid values
 * (NaN, Infinity, non-positive, or above `maxMs`) rather than silently defaulting
 * them. A NaN or Infinity maxWaitMs would make the bounded acquire loop wait
 * forever (`Date.now() + NaN` is NaN); a non-positive poll/heartbeat makes no
 * sense. Timer-backed options (pollMs, heartbeatMs) are bounded to Node's
 * setTimeout ceiling (`MAX_TIMER_DELAY_MS`): a value above 2^31−1 is silently
 * clamped to 1ms by the timer, turning a typo into tight polling (codex P2).
 * Omitting the option (`undefined`) picks `fallback`. Non-number types are also
 * rejected (defensive against config/env coercion).
 */
function optionalPositiveMs(
  value: number | undefined,
  name: "maxWaitMs" | "pollMs" | "heartbeatMs",
  fallback: number,
  maxMs: number,
): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new TypeError(
      `withHeldFileLock: opts.${name} must be a positive finite number ` +
        `(valid range: > 0 ms, finite; got ${formatInvalidNumber(value)}). ` +
        `Omit the option to use the default of ${fallback} ms.`,
    );
  }
  if (value > maxMs) {
    throw new TypeError(
      `withHeldFileLock: opts.${name} (${value} ms) exceeds the ${maxMs} ms ` +
        `ceiling (Node's setTimeout clamps larger delays to 1ms, turning a ` +
        `typo into tight polling). Omit the option to use the default of ${fallback} ms.`,
    );
  }
  return value;
}

/**
 * Human-readable label for a rejected numeric input. Makes the error message
 * immediately actionable for NaN/Infinity (which print as "NaN"/"Infinity" via
 * String() but are easier to triage with an explicit sign), and surfaces the
 * actual type for non-number values (defensive against config/env coercion).
 */
function formatInvalidNumber(value: unknown): string {
  if (typeof value === "number") {
    if (Number.isNaN(value)) return "NaN";
    if (value === Infinity) return "+Infinity";
    if (value === -Infinity) return "-Infinity";
    return String(value);
  }
  return `${typeof value} ${JSON.stringify(value)}`;
}

/**
 * Atomically create the lock file, looping until acquired/stale-broken/timeout.
 * Returns the held-lock handle on success, or `undefined` on bounded-timeout.
 * Unexpected FS errors proceed best-effort (return undefined) rather than
 * crashing the guarded op, matching the catalog.
 */
async function acquireLock(
  lockPath: string,
  lockDir: string,
  ownerId: string,
  opts: HeldFileLockOptions,
  maxWaitMs: number,
  pollMs: number,
): Promise<HeldLock | undefined> {
  try {
    await mkdir(lockDir, { recursive: true });
  } catch {
    // Lock-directory setup failure (e.g. an intermediate path is a file, or
    // permissions deny mkdir) must NOT crash the guarded op — the advisory
    // lock contract is best-effort. Return undefined so task(false) runs
    // instead of rejecting (codex P2 review).
    return undefined;
  }
  const deadline = Date.now() + maxWaitMs;
  for (;;) {
    try {
      const handle = await open(lockPath, "wx");
      let wroteMeta = true;
      try {
        await handle.writeFile(`${process.pid} ${ownerId} ${new Date().toISOString()}\n`, "utf8");
      } catch {
        // The metadata write failed; the lock file may be empty or partial.
        // Our ownership check on release would NOT find this ownerId, leaving
        // a malformed lock that lingers until stale and blocks other callers
        // out of the mutex (codex P2). Undo our exclusive create and report
        // acquisition failure so the caller runs best-effort instead.
        wroteMeta = false;
      } finally {
        try {
          await handle.close();
        } catch {
          // close() can report a deferred I/O error (e.g. write that appeared
          // to succeed but failed on flush). The lock file may be malformed —
          // treat it as a metadata-write failure so the cleanup path unlinks
          // the orphaned lock (codex P2 review).
          wroteMeta = false;
        }
      }
      if (!wroteMeta) {
        await unlink(lockPath).catch(() => undefined);
        return undefined;
      }
      return { path: lockPath, ownerId };
    } catch (err) {
      if ((err as NodeJS.ErrnoException | undefined)?.code !== "EEXIST") {
        // Unexpected FS error — proceed best-effort without the lock.
        return undefined;
      }
      // Lock exists: break it if stale, then poll. breakStaleLock is
      // replacement-safe (NG7Bg) and never throws.
      await breakStaleLock(lockPath, opts.staleMs, opts.onBeforeBreakStaleUnlinkForTest);
      if (Date.now() >= deadline) return undefined;
      // Cap the sleep to the remaining budget so a large pollMs cannot block
      // acquisition far past maxWaitMs (e.g. maxWaitMs=1000, pollMs=60000
      // would otherwise block ~60s instead of 1s — codex P2).
      await sleep(Math.min(pollMs, deadline - Date.now()));
    }
  }
}

/**
 * Replacement-safe stale-lock breaking (NG7Bg, #1506 round 28). Capture the
 * lock's identity when judging it stale, then ATOMICALLY rename it to a unique
 * trash path and verify the moved content matches. A replacement lock created
 * in the race window is either left untouched (different identity at
 * lockPath, so the rename moves the stale lock — not the replacement) or
 * restored (if the rename accidentally moves a replacement, the verify
 * detects the mismatch and renames it back).
 *
 * ATOMICITY (codex P2): `rename` is atomic on POSIX — only ONE contender can
 * successfully rename a given file. This eliminates the TOCTOU between the
 * identity/stat checks and the deletion that a bare `unlink` leaves open:
 * without rename, contender A could verify identity X, pause, then unlink
 * contender B's freshly acquired replacement Y. With rename, A moves whatever
 * is at lockPath, then checks: if it is X, A broke the stale lock; if it is
 * not X (a replacement appeared between A's last check and the rename), A
 * restores it.
 */
async function breakStaleLock(
  lockPath: string,
  staleMs: number,
  onBeforeBreakStaleUnlinkForTest: (() => Promise<void> | void) | undefined,
): Promise<void> {
  let staleIdentity: string;
  try {
    const info = await stat(lockPath);
    if (Date.now() - info.mtimeMs <= staleMs) {
      // Not stale (a live holder's heartbeat keeps it fresh) — leave it.
      return;
    }
    staleIdentity = await readFile(lockPath, "utf8");
  } catch {
    // Lock vanished (released by holder) or stat/read failed — nothing to do.
    return;
  }
  // Test seam: simulate a replacement lock being created in the race window
  // between the staleness judgment and the atomic break. No-op in production.
  if (onBeforeBreakStaleUnlinkForTest) {
    await onBeforeBreakStaleUnlinkForTest();
  }
  try {
    // Re-validate immediately before breaking: the lock must still carry the
    // SAME identity AND still be stale.
    const current = await readFile(lockPath, "utf8");
    if (current !== staleIdentity) return; // replaced — leave the fresh lock
    const recheck = await stat(lockPath);
    if (Date.now() - recheck.mtimeMs <= staleMs) return; // heartbeat refreshed it

    // ATOMIC BREAK: rename is atomic on POSIX. Only one contender succeeds;
    // others get ENOENT (the file is already gone). After the rename, verify
    // the moved content: if it matches staleIdentity we broke the right lock;
    // if it does not, a replacement appeared in the window and we restore it.
    const trashPath = `${lockPath}.breaking.${process.pid}.${Date.now()}`;
    await rename(lockPath, trashPath);
    try {
      const moved = await readFile(trashPath, "utf8");
      if (moved !== staleIdentity) {
        // We accidentally moved a replacement lock (created between our last
        // check and the rename). Restore it so the replacement holder's lock
        // survives. Use link (not rename) to AVOID overwriting a fresh lock
        // that a third contender may have acquired at lockPath while the file
        // was in trash: link fails with EEXIST if lockPath exists, leaving
        // the third contender's lock intact (codex P2 review).
        try {
          await link(trashPath, lockPath);
          // link succeeded — remove the redundant trash hard link. The lock
          // now lives only at lockPath.
          await unlink(trashPath).catch(() => undefined);
        } catch {
          // lockPath already exists (a third contender acquired it). Do NOT
          // unlink the moved file — it may be a LIVE lock whose holder is
          // still in its critical section. Destroying it would leave the
          // holder running with no visible lock, breaking mutual exclusion
          // (codex P2). Leave it in trash as a breadcrumb; it is not at
          // lockPath so it does not block other contenders.
        }
      } else {
        // Content matches — but verify the moved file is STILL stale. The
        // original holder may have resumed and heartbeated between our
        // pre-rename stat() and the rename, refreshing the mtime. If so, the
        // holder is live: restore the lock instead of deleting it (codex P2).
        const movedStat = await stat(trashPath);
        if (Date.now() - movedStat.mtimeMs <= staleMs) {
          // Mtime was refreshed — the holder resumed. Restore the lock.
          try {
            await link(trashPath, lockPath);
            await unlink(trashPath).catch(() => undefined);
          } catch {
            // lockPath already exists — another contender acquired it. Do NOT
            // unlink the moved file (it may be a live lock). Leave it in trash.
          }
        } else {
          // Still stale — we broke the right lock. Clean up the trash.
          await unlink(trashPath).catch(() => undefined);
        }
      }
    } catch {
      // Could not read the trash file — clean it up best-effort.
      await unlink(trashPath).catch(() => undefined);
    }
  } catch {
    // The lock changed/vanished between checks — another process handled it.
  }
}

/**
 * Release the lock ONLY if its content still identifies THIS acquirer (same
 * owner id). Two-stage ownership check:
 *
 *   1. PRE-CHECK (chatgpt-codex-connector P2): read lockPath BEFORE renaming.
 *      If the lock is already a replacement (a contender broke our stale lock),
 *      return WITHOUT renaming — renaming a replacement out of lockPath leaves
 *      it empty, letting a third contender acquire while the replacement holder
 *      is still active. The replacement is safe at lockPath; leave it alone.
 *
 *   2. ATOMIC CLAIM: if the pre-check saw our ownerId, rename lockPath→trash
 *      (POSIX-atomic) and re-verify on the moved file. A replacement could
 *      appear between the pre-check and the rename; if the moved file is no
 *      longer ours, restore it via link (non-overwriting). This ties the
 *      ownership check to the deletion so a bare readFile-then-unlink TOCTOU
 *      cannot delete a fresh replacement (codex P2).
 */
async function releaseLock(
  held: HeldLock,
  warn: (message: string, err: unknown) => void,
  onAfterReleaseRenameForTest: (() => Promise<void> | void) | undefined,
): Promise<void> {
  try {
    // PRE-CHECK (chatgpt-codex-connector P2): read lockPath before renaming. If
    // the lock is no longer ours, a contender broke our stale lock and created a
    // replacement. Return WITHOUT renaming — renaming the replacement out of
    // lockPath leaves it empty, so a third contender could acquire while the
    // replacement holder is still active. The replacement is safe at lockPath.
    let precheck: string;
    try {
      precheck = await readFile(held.path, "utf8");
    } catch {
      return; // lock vanished — nothing to release.
    }
    if (!precheck.includes(held.ownerId)) {
      return; // replacement lock — leave it untouched for its holder.
    }
    // It was ours when we read it. Atomically claim via rename, then re-verify
    // on the moved file: a replacement could appear between the pre-check read
    // above and this rename.
    const trashPath = `${held.path}.releasing.${process.pid}.${Date.now()}`;
    await rename(held.path, trashPath);
    // Test seam: simulate a third contender acquiring the now-empty lockPath
    // in the rename-to-restore window. No-op in production.
    if (onAfterReleaseRenameForTest) {
      await onAfterReleaseRenameForTest();
    }
    try {
      const moved = await readFile(trashPath, "utf8");
      if (moved.includes(held.ownerId)) {
        // Still our lock — safe to delete.
        await unlink(trashPath).catch(() => undefined);
      } else {
        // Not ours: a replacement appeared between the pre-check and the rename.
        // Restore it via link (non-overwriting — if lockPath already has a newer
        // lock, leave it).
        try {
          await link(trashPath, held.path);
        } catch {
          // lockPath already exists — a newer holder is active. Leave the
          // moved file in trash rather than destroying a live lock (codex P2).
          return;
        }
        await unlink(trashPath).catch(() => undefined);
      }
    } catch {
      // Could not read the moved file — clean it up best-effort.
      await unlink(trashPath).catch(() => undefined);
    }
  } catch (err) {
    // Best-effort release; a stale lock will be broken on the next acquire.
    warn("withHeldFileLock release failed", err);
  }
}

/**
 * Whether the lock file at `held.path` was written by THIS acquirer (same owner
 * id). Reads the content and matches the `<pid> <owner-uuid>` prefix; the iso
 * timestamp varies so it is not part of the identity check.
 */
async function lockHeldBySelf(held: HeldLock): Promise<boolean> {
  try {
    const body = await readFile(held.path, "utf8");
    const parts = body.trim().split(/\s+/);
    const fileOwner = parts[1];
    return typeof fileOwner === "string" && fileOwner === held.ownerId;
  } catch {
    return false;
  }
}

/**
 * Re-assert ownership and refresh the lock mtime for {@link HeldFileLockController.refresh}.
 * Returns `true` only while THIS acquirer still owns the lock. When ownership
 * was lost (a peer stale-broke and replaced the lock while a CPU-bound section
 * blocked the event loop), returns `false` WITHOUT touching the replacement's
 * mtime — mirroring the heartbeat's ownership guard. The mtime bump is
 * best-effort: a bump failure still reports held (we own it), so a caller does
 * not needlessly abort a rewrite it is entitled to perform.
 */
async function refreshHeldLock(
  held: HeldLock,
  warn: (message: string, err: unknown) => void,
): Promise<boolean> {
  if (!(await lockHeldBySelf(held))) return false;
  try {
    await utimes(held.path, new Date(), new Date());
  } catch (err) {
    warn("withHeldFileLock manual refresh failed", err);
  }
  return true;
}

function sleep(ms: number): Promise<void> {
  // Manual deferred instead of Promise.withResolvers (ES2024) — plugin-openclaw's
  // standalone tsconfig targets ES2022 lib and this module is reachable from its
  // type graph, so withResolvers would TS2550 there (same fix as
  // extraction-faithfulness.ts:467).
  return new Promise<void>((resolve) => {
    // NOT unref'd: this polls inside an awaited acquire loop, so the caller's
    // await chain keeps the loop alive; unref would let Node exit mid-poll when
    // nothing else is pending (the heartbeat interval IS unref'd separately).
    setTimeout(resolve, ms);
  });
}
