import { SecureStoreLockedError } from "../secure-store/secure-fs.js";
import { isErrnoCode } from "../utils/errno.js";
import { displayErrorDetail } from "../runtime/better-sqlite.js";
import { lstat, rename, stat, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { MemoryLifecycleEvent } from "../types.js";
import {
  compareMemoryLifecycleEvents,
  sortMemoryLifecycleEvents,
  memoryLifecycleLedgerLockPath,
  MEMORY_LIFECYCLE_LEDGER_LOCK_STALE_MS,
  MEMORY_LIFECYCLE_LEDGER_APPEND_LOCK_MAX_WAIT_MS,
} from "../memory-lifecycle-ledger-utils.js";
import { withHeldFileLock, type HeldFileLockOptions } from "../utils/serialize-mutations.js";
import { ensureContainedSpillDir, listContainedSpillFiles } from "../utils/path-containment.js";
import {
  readMaybeEncryptedLines,
  readMemoryLifecycleEventsFromLines,
  STATE_FILE_MAX_DECRYPT_BYTES,
} from "./secure-line-reader.js";
import { getMemoryProjectionPath } from "../memory-projection-store.js";
import {
  openProjectionLifecycleLedgerLagTracker,
  type ProjectionLifecycleLedgerLagTracker,
} from "../maintenance/projection-support.js";
import {
  type ProjectionLedgerLagTelemetry,
  warnProjectionFallback,
} from "../storage-guards.js";

/** Reads a lifecycle-ledger file through the secure whole-file/plaintext line source. */
export type LedgerSecureReader = (filePath: string) => Promise<string>;

/**
 * Lifecycle-ledger read access, extracted from storage.ts (issues #1910,
 * #1995) so the god-file line-count ratchet does not grow. Behavior is
 * unchanged: both readers stream `state/memory-lifecycle-ledger.jsonl` through
 * the same secure whole-file-or-plaintext line source, are fail-open on
 * malformed rows, return `[]` on an absent ledger (ENOENT), and rethrow when a
 * required secure store is locked.
 */

/** Reads a lifecycle-ledger file as a raw (possibly still-encrypted-on-disk)
 *  buffer, decrypting through the live secure key when present. */
export type LedgerSecureBufferReader = (filePath: string) => Promise<Buffer>;

/**
 * Parse one ledger line. Permissive validation (any `eventType` string is
 * admitted) — matches the historical `readAllMemoryLifecycleEvents` contract
 * that projection rebuild depends on. Fail-open on malformed rows.
 */
function parseLifecycleLedgerLine(line: string): MemoryLifecycleEvent | null {
  const row = line.trim();
  if (!row) return null;
  try {
    const parsed = JSON.parse(row) as Partial<MemoryLifecycleEvent>;
    if (
      typeof parsed.eventId === "string" &&
      typeof parsed.memoryId === "string" &&
      typeof parsed.eventType === "string" &&
      typeof parsed.timestamp === "string" &&
      typeof parsed.actor === "string" &&
      typeof parsed.ruleVersion === "string"
    ) {
      return parsed as MemoryLifecycleEvent;
    }
  } catch {
    // Ignore malformed rows (fail-open).
  }
  return null;
}

/**
 * Parse + canonically sort lifecycle rows from a line source.
 */
async function collectLifecycleEvents(
  lines: AsyncIterable<string>,
): Promise<MemoryLifecycleEvent[]> {
  const out: MemoryLifecycleEvent[] = [];
  for await (const line of lines) {
    const parsed = parseLifecycleLedgerLine(line);
    if (parsed) out.push(parsed);
  }
  return sortMemoryLifecycleEvents(out);
}

const LEDGER_ROW_MAX_DECODE_BYTES = 64 * 1024 * 1024;

async function* linesFromBuffer(
  readBuffer: () => Promise<Buffer>,
): AsyncGenerator<string> {
  const buf = await readBuffer();
  let start = 0;
  let nl = buf.indexOf(0x0a, start);
  while (nl !== -1) {
    if (nl - start <= LEDGER_ROW_MAX_DECODE_BYTES) yield buf.toString("utf8", start, nl);
    start = nl + 1;
    nl = buf.indexOf(0x0a, start);
  }
  if (start < buf.length && buf.length - start <= LEDGER_ROW_MAX_DECODE_BYTES) {
    yield buf.toString("utf8", start, buf.length);
  }
}

/**
 * Yield each valid ledger row in file order. Unlike
 * {@link readAllLifecycleEventsFromLedger}, this does not accumulate or sort
 * the ledger first. ENOENT yields nothing; a locked secure store rethrows.
 * Malformed rows are skipped.
 */
export async function* iterateLifecycleEventsFromLedger(
  ledgerPath: string,
  readSecureFile: LedgerSecureReader,
): AsyncGenerator<MemoryLifecycleEvent> {
  let lines: AsyncGenerator<string>;
  try {
    lines = readMaybeEncryptedLines(
      ledgerPath,
      () => readSecureFile(ledgerPath),
      STATE_FILE_MAX_DECRYPT_BYTES,
    );
  } catch (err) {
    if (err instanceof SecureStoreLockedError) throw err;
    if (!isErrnoCode(err, "ENOENT")) throw err;
    return;
  }
  try {
    for await (const line of lines) {
      const parsed = parseLifecycleLedgerLine(line);
      if (parsed) yield parsed;
    }
  } catch (err) {
    if (err instanceof SecureStoreLockedError) throw err;
    if (!isErrnoCode(err, "ENOENT")) throw err;
  }
}

export async function readAllLifecycleEventsFromLedger(
  ledgerPath: string,
  readSecureFile: LedgerSecureReader,
): Promise<MemoryLifecycleEvent[]> {
  const out: MemoryLifecycleEvent[] = [];
  for await (const event of iterateLifecycleEventsFromLedger(ledgerPath, readSecureFile)) {
    out.push(event);
  }
  return sortMemoryLifecycleEvents(out);
}

export async function readAllLifecycleEventsFromLedgerBuffer(
  ledgerPath: string,
  readSecureBuffer: LedgerSecureBufferReader,
): Promise<MemoryLifecycleEvent[]> {
  try {
    return await collectLifecycleEvents(linesFromBuffer(() => readSecureBuffer(ledgerPath)));
  } catch (err) {
    if (err instanceof SecureStoreLockedError) throw err;
    if (!isErrnoCode(err, "ENOENT")) throw err;
    return [];
  }
}

export async function readBoundedLifecycleEventsFromLedger(
  ledgerPath: string,
  readSecureFile: LedgerSecureReader,
  limit: number,
  memoryId?: string,
): Promise<MemoryLifecycleEvent[]> {
  const cappedLimit = Math.max(0, Math.floor(limit));
  if (cappedLimit === 0 || Number.isNaN(cappedLimit)) return [];
  try {
    return await readMemoryLifecycleEventsFromLines(
      readMaybeEncryptedLines(
        ledgerPath,
        () => readSecureFile(ledgerPath),
        STATE_FILE_MAX_DECRYPT_BYTES,
      ),
      cappedLimit,
      memoryId,
      compareMemoryLifecycleEvents,
    );
  } catch (err) {
    if (err instanceof SecureStoreLockedError) throw err;
    if (!isErrnoCode(err, "ENOENT")) throw err;
    return [];
  }
}

export interface LifecycleLedgerProjectionLagRead {
  events: MemoryLifecycleEvent[];
  currentEventCount: number;
  deltaEvents: number;
  telemetryAvailable: boolean;
}

export async function readBoundedLifecycleEventsWithProjectionLag(
  ledgerPath: string,
  readSecureFile: LedgerSecureReader,
  limit: number,
  memoryId: string,
  tracker: ProjectionLifecycleLedgerLagTracker,
): Promise<LifecycleLedgerProjectionLagRead> {
  let currentEventCount = 0;
  let deltaEvents = 0;
  let telemetryAvailable = true;
  try {
    const events = await readMemoryLifecycleEventsFromLines(
      readMaybeEncryptedLines(
        ledgerPath,
        () => readSecureFile(ledgerPath),
        STATE_FILE_MAX_DECRYPT_BYTES,
      ),
      Math.max(0, Math.floor(limit)),
      memoryId,
      compareMemoryLifecycleEvents,
      (event) => {
        if (!telemetryAvailable) return;
        try {
          const tracked = tracker.record(event);
          if (!tracked.unique) return;
          currentEventCount += 1;
          if (!tracked.projected) deltaEvents += 1;
        } catch {
          telemetryAvailable = false;
          currentEventCount = 0;
          deltaEvents = 0;
        }
      },
    );
    return { events, currentEventCount, deltaEvents, telemetryAvailable };
  } catch (err) {
    if (err instanceof SecureStoreLockedError) throw err;
    if (!isErrnoCode(err, "ENOENT")) throw err;
    return { events: [], currentEventCount: 0, deltaEvents: 0, telemetryAvailable: false };
  }
}
/**
 * Probe filesystem identity stamps (dev:ino:size:mtimeMs:ctimeMs) for the
 * projection database and lifecycle-ledger file. Returns `null` when either
 * file is missing or unstatable so caller can disable the lag cache without
 * throwing on transient I/O or permission errors (#2119 / review).
 */
export async function probeProjectionLedgerIdentities(
  projectionPath: string,
  ledgerPath: string,
): Promise<{ projectionIdentity: string; ledgerIdentity: string } | null> {
  try {
    const [projectionIdentity, ledgerIdentity] = await Promise.all(
      [projectionPath, ledgerPath].map(async (filePath) => {
        try {
          const file = await lstat(filePath);
          return `${file.dev}:${file.ino}:${file.size}:${file.mtimeMs}:${file.ctimeMs}`;
        } catch (err) {
          if (isErrnoCode(err, "ENOENT")) return "absent";
          return null;
        }
      }),
    );
    if (!projectionIdentity || !ledgerIdentity) return null;
    return { projectionIdentity, ledgerIdentity };
  } catch {
    return null;
  }
}

export interface ProjectionLedgerLagScan {
  telemetry: ProjectionLedgerLagTelemetry | null;
  events: MemoryLifecycleEvent[];
  memoryId: string;
  limit: number;
}

export class ProjectionLedgerLagManager {
  private lagCache: {
    generation: string;
    telemetry: ProjectionLedgerLagTelemetry;
  } | null = null;
  private lagInFlight: {
    generation: string;
    scan: Promise<ProjectionLedgerLagScan>;
  } | null = null;

  async resolveTimelineWithLag(options: {
    baseDir: string;
    ledgerPath: string;
    memoryId: string;
    cappedLimit: number;
    readSecureFile: LedgerSecureReader;
    projectionAge: () => string;
  }): Promise<MemoryLifecycleEvent[]> {
    const { baseDir, ledgerPath, memoryId, cappedLimit, readSecureFile, projectionAge } = options;
    const projectionPath = getMemoryProjectionPath(baseDir);
    const identities = await probeProjectionLedgerIdentities(projectionPath, ledgerPath);

    if (!identities) {
      warnProjectionFallback(baseDir, "getMemoryTimeline", projectionAge);
      return readBoundedLifecycleEventsFromLedger(ledgerPath, readSecureFile, cappedLimit, memoryId);
    }

    const { projectionIdentity, ledgerIdentity } = identities;
    const generation = `${projectionIdentity}\0${ledgerIdentity}`;

    const cachedLag = this.lagCache?.generation === generation
      ? this.lagCache.telemetry
      : null;
    if (cachedLag) {
      warnProjectionFallback(baseDir, "getMemoryTimeline", projectionAge, cachedLag);
      return readBoundedLifecycleEventsFromLedger(ledgerPath, readSecureFile, cappedLimit, memoryId);
    }

    const inFlight = this.lagInFlight?.generation === generation
      ? this.lagInFlight.scan
      : null;
    if (inFlight) {
      const result = await inFlight;
      if (result.telemetry) {
        this.lagCache = { generation, telemetry: result.telemetry };
      }
      warnProjectionFallback(baseDir, "getMemoryTimeline", projectionAge, result.telemetry ?? undefined);
      if (result.memoryId === memoryId && result.limit === cappedLimit) return result.events;
      return readBoundedLifecycleEventsFromLedger(ledgerPath, readSecureFile, cappedLimit, memoryId);
    }

    const tracker = openProjectionLifecycleLedgerLagTracker(baseDir);
    if (tracker) {
      const highWater = tracker.highWater;
      const scan = (async (): Promise<ProjectionLedgerLagScan> => {
        try {
          const fallback = await readBoundedLifecycleEventsWithProjectionLag(
            ledgerPath,
            readSecureFile,
            cappedLimit,
            memoryId,
            tracker,
          );
          return {
            telemetry: fallback.telemetryAvailable
              ? {
                  projectedEvents: highWater.eventCount,
                  currentLedgerEvents: fallback.currentEventCount,
                  deltaEvents: fallback.deltaEvents,
                }
              : null,
            events: fallback.events,
            memoryId,
            limit: cappedLimit,
          };
        } finally {
          try {
            tracker.close();
          } catch {
            // Lag telemetry cleanup must not replace a successful ledger fallback.
          }
        }
      })();
      this.lagInFlight = { generation, scan };
      try {
        const result = await scan;
        if (result.telemetry) {
          this.lagCache = { generation, telemetry: result.telemetry };
        }
        warnProjectionFallback(baseDir, "getMemoryTimeline", projectionAge, result.telemetry ?? undefined);
        return result.events;
      } finally {
        if (this.lagInFlight?.scan === scan) {
          this.lagInFlight = null;
        }
      }
    }

    warnProjectionFallback(baseDir, "getMemoryTimeline", projectionAge);
    return readBoundedLifecycleEventsFromLedger(ledgerPath, readSecureFile, cappedLimit, memoryId);
  }
}

export function pendingLifecycleLedgerDir(ledgerPath: string): string {
  return `${ledgerPath}.pending.d`;
}

export interface LifecyclePendingIo {
  writeSecure: (filePath: string, payload: string) => Promise<void>;
  readSecure: (filePath: string) => Promise<string>;
}

function withTrailingNewline(content: string): string {
  return content.length === 0 || content.endsWith("\n") ? content : `${content}\n`;
}

/**
 * Serialize lifecycle events into the ledger's newline-delimited JSON payload,
 * stamping a fallback timestamp on any event that lacks one. Extracted from
 * storage.ts (issue #1995 file-size ratchet); behavior unchanged.
 */
export function serializeLifecycleAppendPayload(events: MemoryLifecycleEvent[]): string {
  const nowIso = new Date().toISOString();
  return events
    .map((event) => {
      const normalized: MemoryLifecycleEvent = {
        ...event,
        timestamp: event.timestamp && event.timestamp.length > 0 ? event.timestamp : nowIso,
      };
      return `${JSON.stringify(normalized)}\n`;
    })
    .join("");
}

async function spillPendingAppend(
  ledgerPath: string,
  io: LifecyclePendingIo,
  payload: string,
): Promise<void> {
  const dir = pendingLifecycleLedgerDir(ledgerPath);
  await ensureContainedSpillDir(dir);
  const finalPath = path.join(dir, `${randomUUID()}.jsonl`);
  await io.writeSecure(finalPath, payload);
}

/** Suffix marking a spill that has been CLAIMED for commit but not yet deleted. */
const CLAIMED_SPILL_SUFFIX = ".claimed";

async function recoverOrphanedClaims(ledgerPath: string): Promise<void> {
  const claimed = await listContainedSpillFiles(
    pendingLifecycleLedgerDir(ledgerPath),
    `.jsonl${CLAIMED_SPILL_SUFFIX}`,
  );
  for (const claimedPath of claimed) {
    const original = claimedPath.slice(0, -CLAIMED_SPILL_SUFFIX.length);
    await rename(claimedPath, original).catch(() => undefined);
  }
}

const PENDING_SPILL_BATCH_MAX_BYTES = 1024 * 1024;

async function claimSpillBatch(
  files: string[],
  startIndex: number,
  io: LifecyclePendingIo,
): Promise<{
  payload: string;
  claimedPaths: string[];
  nextIndex: number;
}> {
  const parts: string[] = [];
  const claimedPaths: string[] = [];
  let payloadBytes = 0;
  let nextIndex = startIndex;
  for (; nextIndex < files.length; nextIndex++) {
    const filePath = files[nextIndex]!;
    const content = withTrailingNewline(await io.readSecure(filePath));
    const spillBytes = Buffer.byteLength(content, "utf8");
    if (parts.length > 0 && payloadBytes + spillBytes > PENDING_SPILL_BATCH_MAX_BYTES) {
      break;
    }
    const claimedPath = `${filePath}${CLAIMED_SPILL_SUFFIX}`;
    try {
      await rename(filePath, claimedPath);
    } catch {
      continue; // could not claim → do not commit; a later drain retries it.
    }
    parts.push(content);
    claimedPaths.push(claimedPath);
    payloadBytes += spillBytes;
  }
  return { payload: parts.join(""), claimedPaths, nextIndex };
}

async function finalizeClaimedSpills(claimedPaths: string[]): Promise<void> {
  for (const claimedPath of claimedPaths) {
    await unlink(claimedPath).catch(() => undefined);
  }
}

async function rollbackClaimedSpills(claimedPaths: string[]): Promise<void> {
  for (const claimedPath of claimedPaths) {
    const original = claimedPath.slice(0, -CLAIMED_SPILL_SUFFIX.length);
    await rename(claimedPath, original).catch(() => undefined);
  }
}

async function foldPendingSpillsIntoAppend(
  ledgerPath: string,
  append: (payload: string) => Promise<void>,
  extraPayload: string,
  pending: LifecyclePendingIo | undefined,
): Promise<boolean> {
  if (!pending) {
    if (extraPayload.length > 0) await append(extraPayload);
    return false;
  }
  await recoverOrphanedClaims(ledgerPath);
  const files = await listContainedSpillFiles(pendingLifecycleLedgerDir(ledgerPath));
  let nextIndex = 0;
  let drained = false;

  while (nextIndex < files.length) {
    const batch = await claimSpillBatch(files, nextIndex, pending);
    nextIndex = batch.nextIndex;
    if (batch.claimedPaths.length === 0) {
      if (nextIndex >= files.length) break;
      continue;
    }
    try {
      await append(batch.payload);
    } catch (err) {
      await rollbackClaimedSpills(batch.claimedPaths);
      throw err;
    }
    await finalizeClaimedSpills(batch.claimedPaths);
    drained = true;
  }

  if (extraPayload.length > 0) await append(extraPayload);
  return drained;
}

export async function appendLifecycleEventsSerialized(
  ledgerPath: string,
  append: (payload: string) => Promise<void>,
  payload: string,
  pending?: LifecyclePendingIo,
  lockOptions?: Pick<HeldFileLockOptions, "maxWaitMs" | "pollMs">,
): Promise<void> {
  await withHeldFileLock(
    memoryLifecycleLedgerLockPath(ledgerPath),
    {
      staleMs: MEMORY_LIFECYCLE_LEDGER_LOCK_STALE_MS,
      maxWaitMs: MEMORY_LIFECYCLE_LEDGER_APPEND_LOCK_MAX_WAIT_MS,
      ...lockOptions,
    },
    async (acquired) => {
      if (!acquired) {
        if (!pending) {
          throw new Error(
            "memory-lifecycle-ledger append aborted: could not acquire the ledger lock within "
            + "the budget and no durable pending queue is configured; refusing to append unlocked "
            + "so a concurrent compaction rewrite cannot clobber the new event (issue #1910).",
          );
        }
        await spillPendingAppend(ledgerPath, pending, payload);
        return;
      }
      await foldPendingSpillsIntoAppend(ledgerPath, append, payload, pending);
    },
  );
}

export async function drainPendingLifecycleAppendsSerialized(
  ledgerPath: string,
  append: (payload: string) => Promise<void>,
  pending: LifecyclePendingIo,
  lockOptions?: Pick<HeldFileLockOptions, "maxWaitMs" | "pollMs">,
): Promise<boolean> {
  let drained = false;
  await withHeldFileLock(
    memoryLifecycleLedgerLockPath(ledgerPath),
    {
      staleMs: MEMORY_LIFECYCLE_LEDGER_LOCK_STALE_MS,
      maxWaitMs: MEMORY_LIFECYCLE_LEDGER_APPEND_LOCK_MAX_WAIT_MS,
      ...lockOptions,
    },
    async (acquired) => {
      if (!acquired) return; // lock busy; the next maintenance pass retries.
      drained = await foldPendingSpillsIntoAppend(ledgerPath, append, "", pending);
    },
  );
  return drained;
}

/**
 * Fast-path pending drain for a store (#2033): a no-op that takes NO lock when
 * the pending directory is absent, otherwise ensures the state dir exists and
 * drains under the ledger lock. Keeps StorageManager's public drain method a
 * thin delegate so the bounded-state logic stays in this sibling (issue #1995
 * file-size ratchet). Returns true when rows were drained.
 */
export async function drainPendingLifecycleLedgerIfAny(
  ledgerPath: string,
  io: LifecyclePendingIo,
  append: (payload: string) => Promise<void>,
  ensureReady: () => Promise<void>,
): Promise<boolean> {
  try {
    await stat(pendingLifecycleLedgerDir(ledgerPath));
  } catch (err) {
    if (isErrnoCode(err, "ENOENT")) return false; // nothing pending — no lock taken.
    throw err;
  }
  await ensureReady();
  return drainPendingLifecycleAppendsSerialized(ledgerPath, append, io);
}

/** Result of a pre-snapshot lifecycle drain (#2033): `folded` is true when spill
 *  rows were committed to the active ledger; `pendingDeferred` is true when
 *  durable spill rows STILL remain in the offline-sync-EXCLUDED pending queue
 *  after the attempt (the ledger lock was held by a peer, or a spill could not
 *  be claimed). A caller MUST NOT report a clean snapshot while `pendingDeferred`
 *  is true — those append-only rows would be silently omitted. */
export interface DrainPendingLifecycleForSyncResult {
  folded: boolean;
  pendingDeferred: boolean;
}

/**
 * Offline-sync pre-snapshot drain (#2033). Like {@link drainPendingLifecycleLedgerIfAny}
 * but reports whether durable rows are STILL pending after the attempt so an
 * offline snapshot never silently drops append-only lifecycle rows (promotions,
 * imports, explicit captures) that spilled while the ledger lock was held. Fast
 * no-op — no lock, no dir creation — when nothing is pending. Otherwise drains
 * under the ledger lock, then re-enumerates the pending directory: any remaining
 * live (`*.jsonl`) or crash-orphaned (`*.jsonl.claimed`) spill marks the drain as
 * deferred. A read/append failure inside the lock (locked key, encrypted body)
 * propagates to the caller, which retries or aborts.
 */
export async function drainPendingLifecycleLedgerForSync(
  ledgerPath: string,
  io: LifecyclePendingIo,
  append: (payload: string) => Promise<void>,
  ensureReady: () => Promise<void>,
): Promise<DrainPendingLifecycleForSyncResult> {
  const dir = pendingLifecycleLedgerDir(ledgerPath);
  try {
    await stat(dir);
  } catch (err) {
    if (isErrnoCode(err, "ENOENT")) return { folded: false, pendingDeferred: false };
    throw err;
  }
  await ensureReady();
  const folded = await drainPendingLifecycleAppendsSerialized(ledgerPath, append, io);
  const remaining =
    (await listContainedSpillFiles(dir)).length +
    (await listContainedSpillFiles(dir, `.jsonl${CLAIMED_SPILL_SUFFIX}`)).length;
  return { folded, pendingDeferred: remaining > 0 };
}

/**
 * Bounded pre-snapshot drain driver (#2033): invoke `drain` up to `maxAttempts`
 * times and return once it reports no pending rows; if durable rows remain
 * deferred (ledger lock held by a peer) or every attempt throws, throw so the
 * offline-sync caller ABORTS rather than building a snapshot that silently omits
 * append-only lifecycle rows. Kept here (not in the access-service god-file, issue
 * #1995) so both snapshot entrypoints share one retry/abort contract.
 */
export async function drainPendingLifecycleForSyncOrThrow(
  drain: () => Promise<DrainPendingLifecycleForSyncResult>,
  maxAttempts = 3,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await drain();
      if (!result.pendingDeferred) return;
      lastError = undefined;
    } catch (err) {
      lastError = err;
    }
  }
  const detail = lastError
    ? `: ${displayErrorDetail(lastError) || "unknown error"}`
    : " (ledger lock held by a peer)";
  throw new Error(
    `offline-sync lifecycle drain could not fold pending memory-lifecycle events after ${maxAttempts} attempts${detail}; aborting snapshot so the pending rows are not silently excluded (#2033)`,
  );
}
