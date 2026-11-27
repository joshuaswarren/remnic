//
//
//
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, rename, stat, unlink, utimes } from "node:fs/promises";
import path from "node:path";
import { sleep } from "./sleep.js";

// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

interface MutationChainEntry {
  tail: Promise<void>;
}

export class MutationSerializer {
  private readonly chains = new Map<string, MutationChainEntry>();

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

    const run = entry.tail.then(task);

    const recovered = run.then(settleNoop, settleNoop);
    entry.tail = recovered;

    //
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

function settleNoop(): void {
  /* swallow — the original resolution/rejection is carried by `run` */
}

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
// ─────────────────────────────────────────────────────────────────────────────

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
   * Test seam (#2033): fires inside {@link HeldFileLockController.refresh} AFTER
   * the ownership pre-check passes and BEFORE the `utimes` mtime bump —
   * simulating a peer that deletes the lock (making the bump throw) or replaces
   * it (a different owner the post-bump re-check must catch). No-op in
   * production; proves refresh reports LOST rather than clobbering a peer.
   */
  readonly onBeforeRefreshUtimesForTest?: () => Promise<void> | void;
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
  /**
   * Why the lock was not acquired. `timeout` means a busy peer consumed the
   * bounded wait; `error` means acquisition failed due to filesystem setup or
   * I/O and must not be retried as contention.
   */
  readonly failure?: "timeout" | "error";
}

const DEFAULT_MAX_WAIT_MS = 5_000;
const DEFAULT_POLL_MS = 50;
const MIN_HEARTBEAT_MS = 100;
/** Node's setTimeout/setInterval 32-bit signed-int ceiling (2^31 − 1 ms ≈ 24.8
 * days). Delays above this are silently clamped to 1ms by the Node timer, so
 * timer-backed options (pollMs, heartbeatMs) must be rejected at this boundary
 * (chatgpt-codex-connector P2). */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

interface HeldLock {
  readonly path: string;
  readonly ownerId: string;
}
type LockAcquisitionFailure = { readonly failure: "timeout" | "error" };

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
 * when acquisition is unavailable. The controller's `failure` field
 * distinguishes a bounded busy-lock timeout from a permanent filesystem
 * acquisition error.
 * This explicit callback keeps the lock utility as the single lock home while
 * allowing callers to choose their timeout and failure policy.
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
  const rawWarn = opts.onLockWarning;
  const warn = (message: string, err: unknown): void => {
    if (!rawWarn) return;
    try {
      rawWarn(message, err);
    } catch {
      /* swallow — a throwing advisory hook must not crash the guarded op */
    }
  };

  const ownerId = randomUUID();
  const lockDir = path.dirname(lockPath);

  const acquisition = await acquireLock(lockPath, lockDir, ownerId, opts, maxWaitMs, pollMs);
  if ("failure" in acquisition) {
    return task(false, { refresh: async () => false, failure: acquisition.failure });
  }
  const held = acquisition;

  //
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
  heartbeat.unref?.();
  const controller: HeldFileLockController = {
    refresh: () => refreshHeldLock(held, warn, opts.onBeforeRefreshUtimesForTest),
  };
  try {
    return await task(true, controller);
  } finally {
    clearInterval(heartbeat);
    await releaseLock(held, warn, opts.onAfterReleaseRenameForTest);
  }
}

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

function formatInvalidNumber(value: unknown): string {
  if (typeof value === "number") {
    if (Number.isNaN(value)) return "NaN";
    if (value === Infinity) return "+Infinity";
    if (value === -Infinity) return "-Infinity";
    return String(value);
  }
  return `${typeof value} ${JSON.stringify(value)}`;
}

async function acquireLock(
  lockPath: string,
  lockDir: string,
  ownerId: string,
  opts: HeldFileLockOptions,
  maxWaitMs: number,
  pollMs: number,
): Promise<HeldLock | LockAcquisitionFailure> {
  try {
    await mkdir(lockDir, { recursive: true });
  } catch {
    return { failure: "error" };
  }
  const deadline = Date.now() + maxWaitMs;
  for (;;) {
    try {
      const handle = await open(lockPath, "wx");
      let wroteMeta = true;
      try {
        await handle.writeFile(`${process.pid} ${ownerId} ${new Date().toISOString()}\n`, "utf8");
      } catch {
        wroteMeta = false;
      } finally {
        try {
          await handle.close();
        } catch {
          wroteMeta = false;
        }
      }
      if (!wroteMeta) {
        await unlink(lockPath).catch(() => undefined);
        return { failure: "error" };
      }
      return { path: lockPath, ownerId };
    } catch (err) {
      if ((err as NodeJS.ErrnoException | undefined)?.code !== "EEXIST") {
        return { failure: "error" };
      }
      // Lock exists: break it if stale, then poll. breakStaleLock is
      // replacement-safe (NG7Bg) and never throws.
      await breakStaleLock(lockPath, opts.staleMs, opts.onBeforeBreakStaleUnlinkForTest);
      if (Date.now() >= deadline) return { failure: "timeout" };
      await sleep(Math.min(pollMs, deadline - Date.now()));
    }
  }
}

async function breakStaleLock(
  lockPath: string,
  staleMs: number,
  onBeforeBreakStaleUnlinkForTest: (() => Promise<void> | void) | undefined,
): Promise<void> {
  let staleIdentity: string;
  try {
    const info = await stat(lockPath);
    if (Date.now() - info.mtimeMs <= staleMs) {
      return;
    }
    staleIdentity = await readFile(lockPath, "utf8");
  } catch {
    return;
  }
  if (onBeforeBreakStaleUnlinkForTest) {
    await onBeforeBreakStaleUnlinkForTest();
  }
  try {
    const current = await readFile(lockPath, "utf8");
    if (current !== staleIdentity) return; // replaced — leave the fresh lock
    const recheck = await stat(lockPath);
    if (Date.now() - recheck.mtimeMs <= staleMs) return; // heartbeat refreshed it

    const trashPath = `${lockPath}.breaking.${process.pid}.${Date.now()}`;
    await rename(lockPath, trashPath);
    try {
      const moved = await readFile(trashPath, "utf8");
      if (moved !== staleIdentity) {
        try {
          await link(trashPath, lockPath);
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
        const movedStat = await stat(trashPath);
        if (Date.now() - movedStat.mtimeMs <= staleMs) {
          try {
            await link(trashPath, lockPath);
            await unlink(trashPath).catch(() => undefined);
          } catch {
            // lockPath already exists — another contender acquired it. Do NOT
            // unlink the moved file (it may be a live lock). Leave it in trash.
          }
        } else {
          await unlink(trashPath).catch(() => undefined);
        }
      }
    } catch {
      await unlink(trashPath).catch(() => undefined);
    }
  } catch {
    // The lock changed/vanished between checks — another process handled it.
  }
}

async function releaseLock(
  held: HeldLock,
  warn: (message: string, err: unknown) => void,
  onAfterReleaseRenameForTest: (() => Promise<void> | void) | undefined,
): Promise<void> {
  try {
    let precheck: string;
    try {
      precheck = await readFile(held.path, "utf8");
    } catch {
      return; // lock vanished — nothing to release.
    }
    if (!precheck.includes(held.ownerId)) {
      return; // replacement lock — leave it untouched for its holder.
    }
    const trashPath = `${held.path}.releasing.${process.pid}.${Date.now()}`;
    await rename(held.path, trashPath);
    if (onAfterReleaseRenameForTest) {
      await onAfterReleaseRenameForTest();
    }
    try {
      const moved = await readFile(trashPath, "utf8");
      if (moved.includes(held.ownerId)) {
        await unlink(trashPath).catch(() => undefined);
      } else {
        try {
          await link(trashPath, held.path);
        } catch {
          return;
        }
        await unlink(trashPath).catch(() => undefined);
      }
    } catch {
      await unlink(trashPath).catch(() => undefined);
    }
  } catch (err) {
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

async function refreshHeldLock(
  held: HeldLock,
  warn: (message: string, err: unknown) => void,
  onBeforeRefreshUtimesForTest?: () => Promise<void> | void,
): Promise<boolean> {
  if (!(await lockHeldBySelf(held))) return false;
  if (onBeforeRefreshUtimesForTest) await onBeforeRefreshUtimesForTest();
  try {
    await utimes(held.path, new Date(), new Date());
  } catch (err) {
    warn("withHeldFileLock manual refresh failed", err);
    return false;
  }
  return lockHeldBySelf(held);
}

const metaUpdateChains = new Map<string, Promise<unknown>>();

export async function updateMetaSerialized<M>(
  dir: string,
  loadMeta: () => Promise<M>,
  saveMeta: (meta: M) => Promise<void>,
  mutate: (meta: M) => boolean | void | Promise<boolean | void>,
): Promise<void> {
  const previous = metaUpdateChains.get(dir) ?? Promise.resolve();
  const run = previous.then(() =>
    withHeldFileLock(
      path.join(dir, "meta.json.lock"),
      { staleMs: 5_000, maxWaitMs: 2_000, pollMs: 50 },
      async (acquired) => {
        if (!acquired) {
          throw new Error(`meta update skipped: meta.json.lock not acquired (${dir})`);
        }
        const meta = await loadMeta();
        if ((await mutate(meta)) === false) return;
        await saveMeta(meta);
      },
    ),
  );
  metaUpdateChains.set(dir, run.then(() => undefined, () => undefined));
  await run;
}
