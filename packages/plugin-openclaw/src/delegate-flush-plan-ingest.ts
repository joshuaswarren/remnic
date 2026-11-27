
import { constants } from "node:fs";
import { lstat, open, rename, unlink, writeFile, type FileHandle } from "node:fs/promises";
import path from "node:path";

import { log } from "@remnic/core/logger";
import { withHeldFileLock, type HeldFileLockController } from "@remnic/core/utils/serialize-mutations";

import type { DelegateDaemonTarget } from "./bridge.js";
import {
  buildSnapshotPaths,
  pinSnapshotDirectory,
  type SnapshotPaths,
} from "./delegate-flush-plan-directory.js";
import { buildMemoryFlushPlan } from "./memory-flush-plan.js";
import { postJsonWithStatus } from "./delegate-http.js";

const MAX_OBSERVE_CHUNK_BYTES = 96 * 1024;

const LOCK_MAX_WAIT_MS = 5_000;
const LOCK_STALE_MS = 60_000;
const MAX_RECLAIM_PASSES = 4;

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
  const paths = buildSnapshotPaths(planPath);
  for (const candidate of [paths.plan, paths.inflight, paths.rotating, paths.oversized]) {
    if (await isLinkFreeUnder(workspaceDir, candidate)) continue;
    log.warn(
      `[${options.serviceId}] flush-plan ingestion skipped: ${candidate}, a parent, or the workspace root is a symlink`,
    );
    return;
  }

  const lockWaitMs = Math.max(1, Math.min(LOCK_MAX_WAIT_MS, Math.floor(options.remainingTimeoutMs() / 2)));
  await withHeldFileLock(
    paths.lock,
    { staleMs: LOCK_STALE_MS, maxWaitMs: lockWaitMs },
    async (acquired, lock) => {
      if (!acquired) {
        log.warn(
          `[${options.serviceId}] flush-plan ingestion skipped: another flush holds the lock; the notes drain on the next flush`,
        );
        return;
      }
      for (const candidate of [paths.plan, paths.inflight, paths.rotating, paths.oversized]) {
        if (await isLinkFreeUnder(workspaceDir, candidate)) continue;
        log.warn(
          `[${options.serviceId}] flush-plan ingestion skipped: ${candidate}, a parent, or the workspace root became a symlink`,
        );
        return;
      }
      const pinned = await pinSnapshotDirectory(paths);
      if (pinned.kind === "unstable") {
        log.warn(
          `[${options.serviceId}] flush-plan ingestion skipped: the snapshot directory changed identity while it was being opened`,
        );
        return;
      }
      try {
        await ingestUnderLock(options, pinned.kind === "pinned" ? pinned.paths : paths, lock);
      } finally {
        if (pinned.kind === "pinned") await pinned.close();
      }
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
  let chunkBytes = MAX_OBSERVE_CHUNK_BYTES;
  for (let pass = 0; pass < MAX_RECLAIM_PASSES; pass++) {
    if (options.remainingTimeoutMs() <= 0) return;
    const claimed = await claimPendingNotes(paths, options.serviceId, lock);
    if (claimed === undefined) {
      log.warn(
        `[${options.serviceId}] flush-plan lock was lost during recovery; its new owner drains the snapshot`,
      );
      return;
    }
    if (claimed.trim().length === 0) {
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
          log.warn(
            `[${options.serviceId}] flush-plan notes were refused by the daemon (${response.status}); keeping them for the next flush`,
          );
          stop = true;
          return;
        }
        if (response.status === 413) {
          if (countLines(chunk) > 1) {
            chunkBytes = Math.max(1, Math.floor(chunkBytes / 2));
            continue;
          }
          pending = await quarantineOversizedLine(paths, pending, options.serviceId);
          chunkBytes = MAX_OBSERVE_CHUNK_BYTES;
          if (!(await lock.refresh())) {
            log.warn(
              `[${options.serviceId}] flush-plan lock was lost mid-flush; the snapshot is left to its new owner`,
            );
            lockLost = true;
            stop = true;
            return;
          }
          await atomicWrite(paths.inflight, pending);
          continue;
        }
        if (response.status < 200 || response.status > 299) {
          stop = true;
          throw new Error(`daemon /engram/v1/observe responded ${response.status}`);
        }
        pending = pending.slice(chunk.length);
        if (!(await lock.refresh())) {
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

function isRefusal(status: number): boolean {
  return status === 401 || status === 403 || status === 431;
}

async function claimPendingNotes(
  paths: SnapshotPaths,
  serviceId: string,
  lock: HeldFileLockController,
): Promise<string | undefined> {
  const recovery = await mergeRotatedIntoInflight(paths, lock);
  if (recovery === "lock-lost") return undefined;
  if (recovery === "recovered") {
    log.warn(`[${serviceId}] recovered flush-plan notes left by an interrupted ingestion`);
  }
  if (!(await lock.refresh())) return undefined;
  try {
    await rename(paths.plan, paths.rotating);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
    return (await readIfPresent(paths.inflight)) ?? "";
  }
  if ((await mergeRotatedIntoInflight(paths, lock)) === "lock-lost") return undefined;
  return (await readIfPresent(paths.inflight)) ?? "";
}

/**
 * Append `.rotating` to `.inflight` and remove it. Returns true when there was
 * something to recover. Safe to call when neither file exists.
 */
async function mergeRotatedIntoInflight(
  paths: SnapshotPaths,
  lock: HeldFileLockController,
): Promise<"recovered" | "nothing" | "lock-lost"> {
  const rotated = await readIfPresent(paths.rotating);
  if (rotated === undefined) return "nothing";
  const existing = (await readIfPresent(paths.inflight)) ?? "";
  let merged = `${existing}${rotated}`;
  if (merged.length > 0) {
    if (!(await lock.refresh())) return "lock-lost";
    await atomicWrite(paths.inflight, merged);
  }
  const late = await readIfPresent(paths.rotating);
  if (late !== undefined && late.length > rotated.length) {
    if (!(await lock.refresh())) return "lock-lost";
    merged = `${existing}${late}`;
    await atomicWrite(paths.inflight, merged);
  }
  if (!(await lock.refresh())) return "lock-lost";
  await discard(paths.rotating);
  return merged.length > 0 ? "recovered" : "nothing";
}

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
    `[${serviceId}] a flush-plan note exceeds the daemon's body limit; moved it to ${paths.oversizedLabel} so the remaining notes can drain`,
  );
  return rest;
}

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

async function atomicWrite(filePath: string, content: string): Promise<void> {
  const tempPath = `${filePath}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
  try {
    await writeFile(tempPath, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(tempPath, filePath);
  } catch (err) {
    await discard(tempPath);
    throw err;
  }
}

async function discard(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
  }
}

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

async function isLinkFreeUnder(root: string, target: string): Promise<boolean> {
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return false;
  let current = root;
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
      return true;
    }
  }
  return true;
}
