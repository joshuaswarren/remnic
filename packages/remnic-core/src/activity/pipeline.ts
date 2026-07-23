import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

import { displayErrorDetail } from "../runtime/better-sqlite.js";

import {
  activityDayWindow,
  activityDigestPath,
  composeActivityDigestBody,
  composeActivityDigestMeta,
  isValidActivityDate,
  serializeActivityDigest,
} from "./digest.js";
import type { ActivityStore } from "./store.js";
import type { ActivitySnapshot, ActivitySourceClient } from "./types.js";

const MAX_SYNC_PAGES = 10_000;

/**
 * Sync cursors are scoped per (machine, local day): each date resumes its own
 * pagination independently, so a multi-day window never inherits an earlier
 * day's cursor (which could skip backfill). Encoded into the store's single
 * key column with a NUL separator that cannot occur in a machine label.
 */
export function activityCursorKey(machine: string, date: string): string {
  return `${machine}\u0000${date}`;
}

// Serializes the list -> compose -> write digest section per (memoryDir, date)
// so two sources syncing the same day cannot lose-update each other's digest:
// the last writer in the chain lists every row present and wins.
const digestLocks = new Map<string, Promise<unknown>>();

function withDigestLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prior = digestLocks.get(key) ?? Promise.resolve();
  const next = prior.then(fn, fn);
  const tail = next.then(
    () => undefined,
    () => undefined,
  );
  digestLocks.set(key, tail);
  void tail.then(() => {
    if (digestLocks.get(key) === tail) digestLocks.delete(key);
  });
  return next;
}

export interface ActivitySyncOptions {
  date: string;
  timezone: string;
  memoryDir: string;
  store: ActivityStore;
  signal?: AbortSignal;
  /** Runaway-pagination guard; defaults to MAX_SYNC_PAGES. */
  maxPages?: number;
  /**
   * Search-index refresh, run after a digest is (re)written so the durable
   * markdown becomes discoverable (AGENTS.md rule 31; the digest lives in the
   * QMD collection root but bypasses the extraction->persist->index pipeline).
   * Host-agnostic: the caller injects the core index seam (SearchBackend.update).
   * Best-effort — a failure never fails the sync (rows/digest are durable and
   * index on the next update); it surfaces as `reindexError`.
   */
  afterWrites?: (signal?: AbortSignal) => Promise<void>;
}

export interface ActivitySyncResult {
  machine: string;
  fetched: number;
  inserted: number;
  duplicates: number;
  cursor: string | null;
  digestWritten: boolean;
  /** Set when the post-write reindex threw; the sync still succeeded. */
  reindexError?: string;
}

function snapshotForMachine(snapshot: ActivitySnapshot, machine: string): ActivitySnapshot {
  return {
    machine,
    capturedAtUtc: snapshot.capturedAtUtc,
    app: snapshot.app,
    windowTitle: snapshot.windowTitle,
    ...(snapshot.browserUrl === undefined ? {} : { browserUrl: snapshot.browserUrl }),
    text: snapshot.text,
    textSource: snapshot.textSource,
    contentHash: snapshot.contentHash,
    ...(snapshot.simhash === undefined ? {} : { simhash: snapshot.simhash }),
  };
}

async function writeDigestIfChanged(memoryDir: string, date: string, serialized: string): Promise<boolean> {
  const target = activityDigestPath(memoryDir, date);
  try {
    if ((await readFile(target, "utf8")) === serialized) return false;
  } catch (error: unknown) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
  }

  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, serialized, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, target);
  return true;
}

/**
 * Pull one source's local-day snapshots and persist its cursor only after every
 * page and the derived digest are durable. Replays after a partial failure are
 * safe because ActivityStore deduplicates an exact captured snapshot.
 */
export async function syncActivitySource(
  source: ActivitySourceClient,
  options: ActivitySyncOptions,
): Promise<ActivitySyncResult> {
  if (!isValidActivityDate(options.date)) {
    throw new RangeError(`Invalid activity date "${options.date}"; expected a real YYYY-MM-DD day.`);
  }
  if (source.machineLabel.trim().length === 0) {
    throw new RangeError("activity source machine label must not be empty");
  }
  const maxPages = options.maxPages ?? MAX_SYNC_PAGES;
  if (!Number.isInteger(maxPages) || maxPages < 1) {
    throw new RangeError("activity sync maxPages must be a positive integer");
  }

  const cursorKey = activityCursorKey(source.machineLabel, options.date);
  let cursor = options.store.getCursor(cursorKey);
  let pages = 0;
  let fetched = 0;
  let inserted = 0;
  let duplicates = 0;
  const seenCursors = new Set<string>();
  let completed = false;
  // The digest and cursor that follow are for options.date only. Compute the
  // day window up front so a snapshot the daemon misplaced outside it (replay
  // file, timezone-boundary bug) is not committed under this date — it will be
  // ingested when its own day syncs. Invalid timestamps still fall through to
  // insertSnapshot, which rejects them.
  const { startUtc: windowStartUtc, endUtc: windowEndUtc } = activityDayWindow(options.date, options.timezone);
  const windowStartMs = Date.parse(windowStartUtc);
  const windowEndMs = Date.parse(windowEndUtc);

  while (pages < maxPages) {
    options.signal?.throwIfAborted();
    const page = await source.fetchSnapshots({
      date: options.date,
      timezone: options.timezone,
      cursor,
      signal: options.signal,
    });
    pages += 1;
    fetched += page.snapshots.length;

    for (const snapshot of page.snapshots) {
      const capturedMs = Date.parse(snapshot.capturedAtUtc);
      if (Number.isFinite(capturedMs) && (capturedMs < windowStartMs || capturedMs >= windowEndMs)) {
        continue;
      }
      const result = options.store.insertSnapshot(snapshotForMachine(snapshot, source.machineLabel));
      if (result.inserted) inserted += 1;
      else duplicates += 1;
    }

    if (page.nextCursor === null) {
      completed = true;
      break;
    }
    if (typeof page.nextCursor !== "string" || page.nextCursor.length === 0) {
      throw new TypeError("activity source returned an invalid cursor");
    }
    if (seenCursors.has(page.nextCursor)) {
      throw new Error("activity source returned a repeated cursor");
    }
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }

  // Only a loop that ran out of its page budget without seeing a terminal
  // null cursor is a runaway; completing on the final allowed page is normal.
  if (!completed) {
    throw new Error(`activity source exceeded ${maxPages} pages`);
  }

  // Re-check abort before the durable write section: stop() may have fired after
  // the last page returned, or while this date waited behind digestLocks. An
  // aborted tick must not compose/write a digest or advance the cursor.
  options.signal?.throwIfAborted();
  const digestWritten = await withDigestLock(`${options.memoryDir}\u0000${options.date}`, async () => {
    options.signal?.throwIfAborted();
    const { startUtc, endUtc } = activityDayWindow(options.date, options.timezone);
    const snapshots = options.store.listSnapshotsForDay(null, startUtc, endUtc);
    const body = composeActivityDigestBody(options.date, options.timezone, snapshots);
    const machines = [...new Set(snapshots.map((snapshot) => snapshot.machine))].sort((a, b) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    const serialized = serializeActivityDigest(composeActivityDigestMeta(options.date, machines, snapshots, body), body);
    return writeDigestIfChanged(options.memoryDir, options.date, serialized);
  });

  options.signal?.throwIfAborted();
  options.store.setCursor(cursorKey, cursor);

  // Rows and digest are durable and the cursor has advanced; refresh the search
  // index so the new digest is discoverable (rule 31). Best-effort: a failure
  // is reported, not thrown — the data indexes on the next update.
  let reindexError: string | undefined;
  if (digestWritten && options.afterWrites !== undefined) {
    try {
      await options.afterWrites(options.signal);
    } catch (error: unknown) {
      // reindexError is part of the exported ActivitySyncResult. Keep our
      // controlled QMD strict messages, but reduce opaque backend errors (which
      // can embed absolute paths / loader stacks) to a sanitized name+code.
      reindexError =
        error instanceof Error && error.message.startsWith("QMD ")
          ? error.message
          : displayErrorDetail(error) || "reindex failed";
    }
  }

  return {
    machine: source.machineLabel,
    fetched,
    inserted,
    duplicates,
    cursor,
    digestWritten,
    ...(reindexError === undefined ? {} : { reindexError }),
  };
}
