/**
 * Synchronous compatibility surface for the historical temporal-index API.
 *
 * New runtime code must use the explicit `*Async` exports from temporal-index.
 * These wrappers preserve return timing and boolean truthiness for published
 * JavaScript consumers that predate the async index implementation.
 */

import { execFileSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  applyTagIndexCompatibilityMutation,
  applyTemporalIndexCompatibilityMutation,
  hasCurrentTemporalIndexSchemaForCompatibility,
  type TemporalIndexCompatibilityMutation,
  type TemporalIndexEntry,
} from "./temporal-index.js";

const TEMPORAL_INDEX_FILE = "index_time.json";
const TAG_INDEX_FILE = "index_tags.json";
const INDEX_LOCK_STALE_MS = 60_000;
// Bounded blocking-wait cap for the sync per-file lock (issue #1911, Cursor
// Medium): the sync waiter blocks the Node event loop with sleepSync, so if a
// lock is held by an in-flight async write (awaited I/O) it can't be released
// until the loop runs again. Cap the stall at this bound and fail open rather
// than deadlock or stall for INDEX_LOCK_STALE_MS. 1.5s tolerates a slow disk
// write while bounding the worst-case event-loop freeze.
const SYNC_INDEX_LOCK_BOUND_MS = 1_500;
const INDEX_LOCK_POLL_MS = 10;
const INDEX_PROCESS_START_TOLERANCE_MS = 2_000;
const INDEX_LOCK_SLEEP = new Int32Array(new SharedArrayBuffer(4));
const INDEX_PROCESS_STARTED_AT_MS = Date.now() - process.uptime() * 1000;

interface IndexLockOwner {
  pid: number;
  createdAt?: string;
  processStartedAtMs?: number;
}

type IndexLockCleanupResult = "removed" | "wait" | "blocked";

function stateDir(memoryDir: string): string {
  return path.join(memoryDir, "state");
}

function temporalIndexPath(memoryDir: string): string {
  return path.join(stateDir(memoryDir), TEMPORAL_INDEX_FILE);
}

function tagIndexPath(memoryDir: string): string {
  return path.join(stateDir(memoryDir), TAG_INDEX_FILE);
}

function sleepSync(ms: number): void {
  Atomics.wait(INDEX_LOCK_SLEEP, 0, 0, ms);
}

function uniqueTempPath(filePath: string): string {
  const nonce = crypto.randomBytes(6).toString("hex");
  return path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${nonce}.tmp`,
  );
}

function lockOwnerPath(lockDir: string): string {
  return path.join(lockDir, "owner.json");
}

function writeIndexLockOwner(lockDir: string): void {
  try {
    fs.writeFileSync(
      lockOwnerPath(lockDir),
      JSON.stringify({
        pid: process.pid,
        createdAt: new Date().toISOString(),
        processStartedAtMs: INDEX_PROCESS_STARTED_AT_MS,
      }),
      { encoding: "utf8", flag: "wx" },
    );
  } catch {
    // The directory remains the serialization primitive.
  }
}

function readIndexLockOwner(lockDir: string): IndexLockOwner | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(lockOwnerPath(lockDir), "utf8")) as Record<string, unknown>;
    if (!(typeof parsed.pid === "number" && Number.isInteger(parsed.pid) && parsed.pid > 0)) return null;
    return {
      pid: parsed.pid,
      ...(typeof parsed.createdAt === "string" && parsed.createdAt.length > 0
        ? { createdAt: parsed.createdAt }
        : {}),
      ...(typeof parsed.processStartedAtMs === "number" &&
      Number.isFinite(parsed.processStartedAtMs) &&
      parsed.processStartedAtMs > 0
        ? { processStartedAtMs: parsed.processStartedAtMs }
        : {}),
    };
  } catch {
    return null;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

function readProcessStartedAtMs(pid: number): number | null {
  try {
    const output = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1_000,
    }).trim();
    if (!output) return null;
    const startedAtMs = Date.parse(output);
    return Number.isFinite(startedAtMs) ? startedAtMs : null;
  } catch {
    return null;
  }
}

function lockOwnerIsRunning(owner: IndexLockOwner): boolean {
  if (!processIsAlive(owner.pid)) return false;
  if (owner.processStartedAtMs === undefined) return true;
  const runningStartedAtMs = readProcessStartedAtMs(owner.pid);
  if (runningStartedAtMs === null) return true;
  return runningStartedAtMs <= owner.processStartedAtMs + INDEX_PROCESS_START_TOLERANCE_MS;
}

function lockIsFresh(lockInfo: fs.Stats, owner: IndexLockOwner | null): boolean {
  const ownerCreatedAtMs = owner?.createdAt ? Date.parse(owner.createdAt) : Number.NaN;
  const referenceMs = Number.isFinite(ownerCreatedAtMs) ? ownerCreatedAtMs : lockInfo.mtimeMs;
  return Date.now() - referenceMs < INDEX_LOCK_STALE_MS;
}

function removeAbandonedIndexLock(lockDir: string): IndexLockCleanupResult {
  try {
    const info = fs.lstatSync(lockDir);
    if (info.isSymbolicLink()) return "blocked";
    if (!info.isDirectory()) {
      fs.rmSync(lockDir, { force: true });
      return "removed";
    }
    const owner = readIndexLockOwner(lockDir);
    if (owner && lockOwnerIsRunning(owner)) return "wait";
    if (!owner && lockIsFresh(info, null)) return "wait";
    fs.rmSync(lockDir, { recursive: true, force: true });
    return "removed";
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "ENOENT" ? "removed" : "blocked";
  }
}

function withIndexFileLock(filePath: string, update: () => void): void {
  const lockDir = `${filePath}.lock.d`;
  // Bound the acquisition (issue #1911, Codex Medium). sleepSync() blocks the
  // Node event loop, so an UNBOUNDED wait here would stall the whole process if
  const maxAttempts = Math.max(1, Math.ceil(SYNC_INDEX_LOCK_BOUND_MS / INDEX_LOCK_POLL_MS));
  // (advisory indexes) rather than risk starving the loop — e.g. a lock held by
  // in-flight async work that needs the very loop this call is blocking.
  let acquired = false;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      fs.mkdirSync(lockDir);
      writeIndexLockOwner(lockDir);
      acquired = true;
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT") {
        try {
          fs.mkdirSync(path.dirname(lockDir), { recursive: true });
        } catch {
          return;
        }
        sleepSync(INDEX_LOCK_POLL_MS);
        continue;
      }
      if (code !== "EEXIST") return;
      if (removeAbandonedIndexLock(lockDir) === "blocked") return;
      sleepSync(INDEX_LOCK_POLL_MS);
    }
  }
  if (!acquired) return; // fail open — could not acquire within the bound

  try {
    update();
  } finally {
    try {
      fs.rmSync(lockDir, { recursive: true, force: true });
    } catch {
      // Advisory indexes fail open.
    }
  }
}

function readJson(filePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
  } catch {
    return null;
  }
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  const payload = JSON.stringify(value);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const tempPath = uniqueTempPath(filePath);
    try {
      fs.writeFileSync(tempPath, payload, "utf8");
      fs.renameSync(tempPath, filePath);
      return;
    } catch {
      try {
        fs.unlinkSync(tempPath);
      } catch {
        // Advisory indexes fail open.
      }
      sleepSync(INDEX_LOCK_POLL_MS);
    }
  }
}

function applyMutation(memoryDir: string, mutation: TemporalIndexCompatibilityMutation): void {
  try {
    fs.mkdirSync(stateDir(memoryDir), { recursive: true });
    // Coordinate with the ASYNC surface by acquiring the SAME per-file lockdirs
    // (issue #1911, Cursor Medium) — `<temporal>.lock.d` then `<tag>.lock.d`,
    // nested in a fixed order (no deadlock: the async surface acquires them one
    // at a time, never both). The acquisition is BOUNDED + fail-open
    // (withIndexFileLock), so an event-loop-blocking sync waiter can never stall
    // the loop waiting on a lock held across an async await — if the async write
    // doesn't release in the bound, sync gives up (advisory indexes fail open).
    // Holding both locks together makes the paired write atomic vs. both surfaces.
    const temporalPath = temporalIndexPath(memoryDir);
    const tagPath = tagIndexPath(memoryDir);
    withIndexFileLock(temporalPath, () => {
      withIndexFileLock(tagPath, () => {
        writeJsonAtomic(
          temporalPath,
          applyTemporalIndexCompatibilityMutation(readJson(temporalPath), mutation),
        );
        writeJsonAtomic(
          tagPath,
          applyTagIndexCompatibilityMutation(readJson(tagPath), mutation),
        );
      });
    });
  } catch {
    // Advisory indexes fail open.
  }
}

/** @deprecated Use `indexMemoryAsync` in new code. */
export function indexMemory(
  memoryDir: string,
  memoryPath: string,
  createdAt: string,
  tags: string[],
  temporal: Omit<Partial<TemporalIndexEntry>, "path" | "createdAt" | "tags"> = {},
): void {
  applyMutation(memoryDir, {
    kind: "index",
    entries: [{ path: memoryPath, createdAt, tags, ...temporal }],
  });
}

/** @deprecated Use `deindexMemoryAsync` in new code. */
export function deindexMemory(
  memoryDir: string,
  memoryPath: string,
  createdAt: string,
  tags: string[],
): void {
  applyMutation(memoryDir, {
    kind: "deindex",
    entries: [{ path: memoryPath, createdAt, tags }],
  });
}

/** @deprecated Use `clearIndexesAsync` in new code. */
export function clearIndexes(memoryDir: string): void {
  applyMutation(memoryDir, { kind: "clear" });
}

/** @deprecated Use `indexesExistAsync` in new code. */
export function indexesExist(memoryDir: string): boolean {
  try {
    if (!fs.existsSync(tagIndexPath(memoryDir))) return false;
    return hasCurrentTemporalIndexSchemaForCompatibility(readJson(temporalIndexPath(memoryDir)));
  } catch {
    return false;
  }
}

/** @deprecated Use `indexMemoriesBatchAsync` in new code. */
export function indexMemoriesBatch(memoryDir: string, entries: TemporalIndexEntry[]): void {
  if (entries.length === 0) return;
  applyMutation(memoryDir, { kind: "index", entries });
}
