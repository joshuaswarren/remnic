import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

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

export interface ActivitySyncOptions {
  date: string;
  timezone: string;
  memoryDir: string;
  store: ActivityStore;
  signal?: AbortSignal;
  /** Runaway-pagination guard; defaults to MAX_SYNC_PAGES. */
  maxPages?: number;
}

export interface ActivitySyncResult {
  machine: string;
  fetched: number;
  inserted: number;
  duplicates: number;
  cursor: string | null;
  digestWritten: boolean;
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

  let cursor = options.store.getCursor(source.machineLabel);
  let pages = 0;
  let fetched = 0;
  let inserted = 0;
  let duplicates = 0;
  const seenCursors = new Set<string>();
  let completed = false;

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

  const { startUtc, endUtc } = activityDayWindow(options.date, options.timezone);
  const snapshots = options.store.listSnapshotsForDay(null, startUtc, endUtc);
  const body = composeActivityDigestBody(options.date, options.timezone, snapshots);
  const machines = [...new Set(snapshots.map((snapshot) => snapshot.machine))].sort((a, b) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  const serialized = serializeActivityDigest(composeActivityDigestMeta(options.date, machines, snapshots, body), body);
  const digestWritten = await writeDigestIfChanged(options.memoryDir, options.date, serialized);

  options.store.setCursor(source.machineLabel, cursor);
  return { machine: source.machineLabel, fetched, inserted, duplicates, cursor, digestWritten };
}
