/**
 * Hand the host's flush-plan notes to the daemon, then clear the file.
 *
 * The delegate capability advertises a flush plan, so OpenClaw appends durable
 * notes to `state/plugins/<serviceId>/flush-plan.md` in the GATEWAY's
 * workspace. Embedded mode ingests that file from its own registration path;
 * delegate mode returns before any of that wiring, and the daemon cannot see a
 * gateway-local file — so without this the notes the host was told to write
 * are read by nobody.
 *
 * Durability model (issue #2303). Notes are CLAIMED by rename, not by
 * read-then-truncate, so a host append can never be overwritten by our commit.
 * Three invariants hold the claim together:
 *
 *  1. One writer. The whole ingestion runs under the cross-process flush-plan
 *     lock, so a second flush cannot mistake this run's snapshot for crash
 *     residue. A contended flush declines and leaves the notes in place.
 *  2. Content is never unlinked before it is durably somewhere else. The
 *     rotate target is merged into the snapshot with a temp-then-rename write,
 *     and only then removed, so no crash window has the notes in RAM alone.
 *  3. Recovery is part of the claim. A `.rotating` or `.inflight` file found
 *     while holding the lock is residue from a dead run and is merged ahead of
 *     the newly claimed notes, preserving write order.
 */

import { constants } from "node:fs";
import { lstat, open, rename, unlink, writeFile, type FileHandle } from "node:fs/promises";
import path from "node:path";

import { log } from "@remnic/core/logger";
import { withHeldFileLock, type HeldFileLockController } from "@remnic/core/utils/serialize-mutations";

import type { DelegateDaemonTarget } from "./bridge.js";
import { buildMemoryFlushPlan } from "./memory-flush-plan.js";
import { postJsonWithStatus } from "./delegate-http.js";

/**
 * Bytes per observe request. Comfortably under the daemon's default
 * `maxBodyBytes` (131072) so the JSON envelope around the notes still fits.
 */
const MAX_OBSERVE_CHUNK_BYTES = 96 * 1024;
/** The floor the adaptive halving stops at — below this a single note. */
const MIN_OBSERVE_CHUNK_BYTES = 4 * 1024;
/** Bounded wait for the flush-plan lock; a contended flush declines instead. */
const LOCK_MAX_WAIT_MS = 5_000;
const LOCK_STALE_MS = 60_000;

interface SnapshotPaths {
  plan: string;
  inflight: string;
  rotating: string;
  oversized: string;
  lock: string;
}

export async function ingestFlushPlanNotes(options: {
  target: DelegateDaemonTarget;
  serviceId: string;
  workspaceDir: string | undefined;
  sessionKey: string;
  namespace: string | undefined;
  /** What is LEFT of the caller's deadline, re-read for every chunk. */
  remainingTimeoutMs: () => number;
}): Promise<void> {
  if (options.workspaceDir === undefined) return;
  const workspaceDir = options.workspaceDir;
  const planPath = path.join(
    workspaceDir,
    ...buildMemoryFlushPlan({ serviceId: options.serviceId }).relativePath.split("/"),
  );
  const paths: SnapshotPaths = {
    plan: planPath,
    inflight: `${planPath}.inflight`,
    rotating: `${planPath}.rotating`,
    oversized: `${planPath}.oversized`,
    lock: `${planPath}.lock`,
  };
  // The embedded processor refuses a symlinked plan file or parent, and so must
  // this one: following a link would send another file's contents to the daemon
  // and then truncate that file. EVERY path this module reads or writes is
  // checked, not just the plan — a `flush-plan.md.inflight` symlink planted in
  // the state directory is the same attack one filename over. `lstat` on the
  // ROOT and every segment below it, never `realpath`, so a link cannot be
  // resolved away before the check.
  for (const candidate of [paths.plan, paths.inflight, paths.rotating, paths.oversized]) {
    if (await isLinkFreeUnder(workspaceDir, candidate)) continue;
    log.warn(
      `[${options.serviceId}] flush-plan ingestion skipped: ${candidate}, a parent, or the workspace root is a symlink`,
    );
    return;
  }

  // Never wait longer than the caller's own budget: the transcript flush that
  // runs after this shares the same deadline, and burning it here would leave
  // that flush with the 1 ms fallback.
  const lockWaitMs = Math.max(1, Math.min(LOCK_MAX_WAIT_MS, Math.floor(options.remainingTimeoutMs() / 2)));
  await withHeldFileLock(
    paths.lock,
    { staleMs: LOCK_STALE_MS, maxWaitMs: lockWaitMs },
    async (acquired, lock) => {
      if (!acquired) {
        // Another flush owns the snapshot. Declining is correct: the notes stay
        // in the plan file and the other run — or the next flush — sends them.
        log.warn(
          `[${options.serviceId}] flush-plan ingestion skipped: another flush holds the lock; the notes drain on the next flush`,
        );
        return;
      }
      // Re-validate INSIDE the lock: the one-time check above ran before the
      // lock wait, and a writable workspace lets an attacker swap a checked
      // path for a symlink during that window. Every read and write below
      // also opens with O_NOFOLLOW, so the final component cannot be swapped
      // after this check either.
      for (const candidate of [paths.plan, paths.inflight, paths.rotating, paths.oversized]) {
        if (await isLinkFreeUnder(workspaceDir, candidate)) continue;
        log.warn(
          `[${options.serviceId}] flush-plan ingestion skipped: ${candidate}, a parent, or the workspace root became a symlink`,
        );
        return;
      }
      await ingestUnderLock(options, paths, lock);
    },
  );
}

async function ingestUnderLock(
  options: {
    target: DelegateDaemonTarget;
    serviceId: string;
    sessionKey: string;
    namespace: string | undefined;
    remainingTimeoutMs: () => number;
  },
  paths: SnapshotPaths,
  lock: HeldFileLockController,
): Promise<void> {
  // Chunks start large and HALVE on a body-limit rejection. The daemon's
  // `maxBodyBytes` is configurable to any positive integer and is not reported
  // anywhere this client can read, so guessing a fixed ceiling would deadlock
  // every daemon configured below it — the very failure chunking was added to
  // end. Adapting needs no new daemon surface and converges in a few requests.
  let chunkBytes = MAX_OBSERVE_CHUNK_BYTES;
  // Re-claim after each drained snapshot so notes the host appended WHILE we
  // were posting still leave in this flush. Every pass needs budget and needs
  // the host to have written something new, so this terminates.
  for (;;) {
    if (options.remainingTimeoutMs() <= 0) return;
    const claimed = await claimPendingNotes(paths, options.serviceId);
    if (claimed.trim().length === 0) {
      // Even a delete needs a live claim: a replacement holder may have just
      // recovered this snapshot.
      if (await lock.refresh()) await discard(paths.inflight);
      return;
    }
    let pending = claimed;
    let stop = false;
    let lockLost = false;
    try {
      while (pending.trim().length > 0) {
        const timeoutMs = options.remainingTimeoutMs();
        if (timeoutMs <= 0) {
          log.warn(
            `[${options.serviceId}] flush-plan ingestion stopped: the caller's deadline is spent; the remainder drains on the next flush`,
          );
          stop = true;
          return;
        }
        const [chunk] = chunkOnLineBoundaries(pending, chunkBytes);
        if (chunk === undefined) {
          stop = true;
          return;
        }
        const response = await postJsonWithStatus(
          options.target,
          options.serviceId,
          "/engram/v1/observe",
          {
            sessionKey: options.sessionKey,
            messages: [{ role: "user", content: chunk }],
            ...(options.namespace === undefined ? {} : { namespace: options.namespace }),
          },
          timeoutMs,
        );
        if (isRefusal(response.status)) {
          // Halving cannot fix a refused credential, and 431 is an oversized
          // HEADER — neither shrinks by sending a smaller body. Stopping here
          // also ends the pointless retry ladder the old collapsed-to-null
          // contract ran on every auth failure.
          log.warn(
            `[${options.serviceId}] flush-plan notes were refused by the daemon (${response.status}); keeping them for the next flush`,
          );
          stop = true;
          return;
        }
        if (response.status === 413) {
          // Halve while the chunk still holds more than one line. The trigger
          // is the CHUNK's shape, not a byte floor: a daemon configured with a
          // `maxBodyBytes` under the floor still rejects a multi-line batch,
          // and quarantining then would set aside a note the daemon would have
          // accepted on its own.
          if (countLines(chunk) > 1) {
            chunkBytes = Math.max(1, Math.floor(chunkBytes / 2));
            continue;
          }
          // One line the daemon will never take. Keeping it would block every
          // note behind it on every future flush, so it is set aside in a
          // sidecar the operator can inspect and the queue keeps draining.
          // Nothing is deleted.
          if (!(await lock.refresh())) {
            log.warn(
              `[${options.serviceId}] flush-plan lock was lost mid-flush; the snapshot is left to its new owner`,
            );
            lockLost = true;
            stop = true;
            return;
          }
          pending = await quarantineOversizedLine(paths, pending, options.serviceId);
          chunkBytes = MAX_OBSERVE_CHUNK_BYTES;
          await atomicWrite(paths.inflight, pending);
          continue;
        }
        if (response.status < 200 || response.status > 299) {
          stop = true;
          throw new Error(`daemon /engram/v1/observe responded ${response.status}`);
        }
        // Committed IMMEDIATELY, so a later chunk that throws cannot resend
        // what the daemon already took. The snapshot has no other writer while
        // the lock is HELD — long synchronous chunking between heartbeats can
        // let it go stale, so ownership is re-checked before every destructive
        // write rather than assumed for the whole run.
        // Drop the accepted chunk BEFORE anything else can return: leaving it
        // in `pending` would requeue notes the daemon already took.
        pending = pending.slice(chunk.length);
        if (!(await lock.refresh())) {
          // Ownership is gone, so this run must not write the snapshot at all —
          // a replacement holder may already be working on it. The accepted
          // chunk is resent by whoever owns the snapshot next: observe is
          // at-least-once here, which is the safe direction.
          log.warn(
            `[${options.serviceId}] flush-plan lock was lost mid-flush; the snapshot is left to its new owner`,
          );
          lockLost = true;
          stop = true;
          return;
        }
        await atomicWrite(paths.inflight, pending);
      }
    } finally {
      // Never touch the snapshot after ownership is lost. `lockLost` covers the
      // paths that already checked; every OTHER exit — a refusal, a spent
      // deadline, a transport throw, a clean drain — re-checks here, because a
      // long observe await is exactly when a stale-break can hand the snapshot
      // to a replacement holder.
      if (!lockLost && (await lock.refresh())) {
        await releasePendingNotes(paths, pending, options.serviceId);
      } else if (!lockLost) {
        log.warn(
          `[${options.serviceId}] flush-plan lock was lost before the snapshot could be updated; its new owner drains the remainder`,
        );
      }
    }
    if (stop) return;
  }
}

/** Lines in one chunk. A trailing newline does not open another line. */
function countLines(chunk: string): number {
  const body = chunk.endsWith("\n") ? chunk.slice(0, -1) : chunk;
  if (body.length === 0) return chunk.length > 0 ? 1 : 0;
  return body.split("\n").length;
}

/** Statuses that mean "resend later", never "resend smaller". */
function isRefusal(status: number): boolean {
  // 431 is an oversized request HEADER, not body: `access-http` answers 413 for
  // a body over `maxBodyBytes`, so only 413 is worth halving for.
  return status === 401 || status === 403 || status === 431;
}

/**
 * Take ownership of the plan file's contents, oldest note first.
 *
 * Runs under the lock, so any `.rotating` or `.inflight` found here is residue
 * from a run that died and is merged ahead of the newly claimed notes. The
 * merge is written with temp-then-rename BEFORE the source is unlinked, so no
 * crash window leaves the notes only in memory.
 */
async function claimPendingNotes(paths: SnapshotPaths, serviceId: string): Promise<string> {
  // 1. Fold any stranded rotate target into the snapshot first. A previous run
  //    that died between its rename and its merge left the notes only there.
  if (await mergeRotatedIntoInflight(paths)) {
    log.warn(`[${serviceId}] recovered flush-plan notes left by an interrupted ingestion`);
  }
  // 2. Claim the live plan file. Rename is atomic, so a host append either
  //    lands before it (claimed) or creates a fresh plan file (untouched).
  try {
    await rename(paths.plan, paths.rotating);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
    return (await readIfPresent(paths.inflight)) ?? "";
  }
  await mergeRotatedIntoInflight(paths);
  return (await readIfPresent(paths.inflight)) ?? "";
}

/**
 * Append `.rotating` to `.inflight` and remove it. Returns true when there was
 * something to recover. Safe to call when neither file exists.
 */
async function mergeRotatedIntoInflight(paths: SnapshotPaths): Promise<boolean> {
  const rotated = await readIfPresent(paths.rotating);
  if (rotated === undefined) return false;
  const existing = (await readIfPresent(paths.inflight)) ?? "";
  let merged = `${existing}${rotated}`;
  if (merged.length > 0) {
    await atomicWrite(paths.inflight, merged);
  }
  // A host descriptor opened just before the rename still points at THIS
  // inode, so a note can land here after the read above. Re-read immediately
  // before unlinking and fold in anything that arrived; the write would
  // otherwise vanish with the inode. The window is now one syscall pair
  // rather than the whole merge.
  const late = await readIfPresent(paths.rotating);
  if (late !== undefined && late.length > rotated.length) {
    merged = `${existing}${late}`;
    await atomicWrite(paths.inflight, merged);
  }
  // Only now: the content is durable under `.inflight`.
  await discard(paths.rotating);
  return merged.length > 0;
}

/**
 * Leave unsent notes in the snapshot and drop it when there is nothing left.
 *
 * An earlier version wrote the remainder back into the plan file. That was the
 * read-modify-write this PR exists to remove: a host append landing between
 * the read and the rename was discarded. The snapshot is ours alone, so
 * keeping the remainder there loses nothing — `claimPendingNotes` merges
 * `.inflight` AHEAD of newly claimed notes, which preserves write order
 * without ever touching the file the host appends to.
 *
 * A failure here must not mask the error that ended the run, so it only warns:
 * the snapshot survives either way and the next run recovers from it.
 */
async function releasePendingNotes(
  paths: SnapshotPaths,
  pending: string,
  serviceId: string,
): Promise<void> {
  try {
    if (pending.length === 0) {
      await discard(paths.inflight);
      return;
    }
    await atomicWrite(paths.inflight, pending);
  } catch (err) {
    log.warn(
      `[${serviceId}] could not persist unsent flush-plan notes; the next ingestion recovers them: ${String(err)}`,
    );
  }
}

/**
 * Move the leading line — one the daemon refuses even at the minimum chunk
 * size — into the oversized sidecar and return what is left.
 *
 * The line is appended to the sidecar BEFORE it leaves `pending`, so a crash
 * in between duplicates a note rather than losing one.
 */
async function quarantineOversizedLine(
  paths: SnapshotPaths,
  pending: string,
  serviceId: string,
): Promise<string> {
  const breakAt = pending.indexOf("\n");
  const line = breakAt === -1 ? pending : pending.slice(0, breakAt + 1);
  const rest = breakAt === -1 ? "" : pending.slice(breakAt + 1);
  const handle = await open(
    paths.oversized,
    constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(line.endsWith("\n") ? line : `${line}\n`, "utf8");
  } finally {
    await handle.close();
  }
  log.warn(
    `[${serviceId}] a flush-plan note exceeds the daemon's body limit; moved it to ${paths.oversized} so the remaining notes can drain`,
  );
  return rest;
}

/**
 * File contents, or `undefined` when the file does not exist.
 *
 * Opened with `O_NOFOLLOW` so a symlink swapped in after the containment check
 * fails the open (ELOOP) instead of leaking another file to the daemon.
 */
async function readIfPresent(filePath: string): Promise<string | undefined> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    return await handle.readFile("utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
    throw err;
  } finally {
    await handle?.close();
  }
}

/**
 * Replace `filePath` in one step: write a fresh temp file, then rename over
 * the target. `wx` refuses an existing temp, so two writers never share one.
 */
async function atomicWrite(filePath: string, content: string): Promise<void> {
  const tempPath = `${filePath}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
  try {
    // `wx` implies O_EXCL|O_CREAT, which already refuses to follow a symlink
    // at the temp path; the rename then replaces the target by pathname.
    await writeFile(tempPath, content, { encoding: "utf8", flag: "wx" });
    await rename(tempPath, filePath);
  } catch (err) {
    await discard(tempPath);
    throw err;
  }
}

/** Remove a file, tolerating one that is already gone. */
async function discard(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
  }
}

/**
 * Split on line boundaries, each piece under `limit` BYTES.
 *
 * Line-aligned so a note is never cut mid-sentence. A single line longer than
 * the limit is emitted whole rather than mangled — the caller quarantines it
 * once the daemon proves it will never accept it.
 */
function chunkOnLineBoundaries(text: string, limit: number): string[] {
  if (Buffer.byteLength(text, "utf8") <= limit) return [text];
  const chunks: string[] = [];
  let current = "";
  for (const line of text.split(/(?<=\n)/)) {
    if (current !== "" && Buffer.byteLength(current + line, "utf8") > limit) {
      chunks.push(current);
      current = "";
    }
    current += line;
  }
  if (current !== "") chunks.push(current);
  return chunks;
}

/**
 * Whether `target` and every directory between it and `root` is link-free.
 *
 * `lstat` per segment rather than a `realpath` comparison: resolving first
 * would answer for the LINK's destination, which is the thing being guarded
 * against.
 */
async function isLinkFreeUnder(root: string, target: string): Promise<boolean> {
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return false;
  let current = root;
  // The ROOT first: a replaceable workspace symlink would otherwise be walked
  // straight through, which is the same escape the per-segment check exists to
  // stop — one level up.
  try {
    if ((await lstat(current)).isSymbolicLink()) return false;
  } catch {
    return true;
  }
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink()) return false;
    } catch {
      // A segment that does not exist yet cannot be a link.
      return true;
    }
  }
  return true;
}
