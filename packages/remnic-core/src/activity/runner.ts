/**
 * Host-agnostic activity sync runner (issue #1900).
 *
 * Bridges parsed `config.activity` to the durable sync pipeline: the parser
 * (config.ts) validates settings but never contacts a daemon, and
 * `syncActivitySource` (pipeline.ts) syncs one source for one day. This runner
 * is the missing middle — it instantiates one `ActivityHttpSourceClient` per
 * configured source from the parsed config and drives a sync across the
 * `syncDays` local-day window, but ONLY when the feature is enabled.
 *
 * The feature is master default-off: source config alone never starts a sync.
 * When `config.enabled` is false the runner opens no store, builds no client,
 * and makes no HTTP call or write — it returns a disabled summary. This mirrors
 * `runLiveConnectorsOnce`'s disabled-vs-result reporting so a host scheduler
 * (CLI, cron) can trigger it through the runtime with no OpenClaw imports.
 *
 * Cursor semantics are delegated wholesale to `syncActivitySource`: the
 * per-machine cursor advances only after every page and the digest are durable,
 * so a runtime failure (or an aborted stop) leaves the cursor unadvanced and a
 * restart resumes from the persisted position. A per-source failure is captured
 * as an error item and never aborts the other sources or the host flow.
 */

import { ActivityStore } from "./store.js";
import { syncActivitySource } from "./pipeline.js";
import { ActivityHttpSourceClient } from "./source-client.js";
import { displayErrorDetail } from "../runtime/better-sqlite.js";
import type { ActivityConfig, ActivitySourceClient, ActivitySourceConfig } from "./types.js";

type ActivityNow = Date | (() => Date);

/** One configured source's aggregate result across the synced day window. */
export interface ActivitySourceRunItem {
  machineLabel: string;
  /** True when at least one day synced durably (no error). */
  ran: boolean;
  fetched: number;
  inserted: number;
  duplicates: number;
  digestsWritten: number;
  /** Persisted cursor after the run; unadvanced from prior on failure. */
  cursor: string | null;
  /** Set when the source failed; distinguishes a fault from an empty page. */
  error?: string;
  /**
   * Set when a durable day synced but its post-digest search reindex failed.
   * The rows/digest/cursor are committed; the index is stale until the next
   * refresh, so this is a signal (not a sync failure) for the scheduler.
   */
  reindexError?: string;
}

export interface ActivitySyncRunSummary {
  ranAt: string;
  /** False means the feature is off: no client built, no HTTP, no write. */
  enabled: boolean;
  ranCount: number;
  errorCount: number;
  /** Sources whose durable sync succeeded but whose search reindex failed. */
  reindexErrorCount: number;
  totalInserted: number;
  results: ActivitySourceRunItem[];
}

export interface ActivitySyncRunOptions {
  config: ActivityConfig;
  memoryDir: string;
  /** Injectable store; opened from memoryDir when omitted (and closed here). */
  store?: ActivityStore;
  /** Clock injection for deterministic day-window resolution in tests. */
  now?: ActivityNow;
  /** Abort a run in flight (stop); an aborted source leaves its cursor intact. */
  signal?: AbortSignal;
  /** Injectable client factory; builds an ActivityHttpSourceClient by default. */
  createSourceClient?: (source: ActivitySourceConfig) => ActivitySourceClient;
  /**
   * Search-index refresh forwarded to each source sync as `afterWrites`, run
   * after a digest is (re)written so it becomes discoverable (rule 31).
   * Host wires the core index seam (SearchBackend.update); best-effort.
   */
  reindexSearch?: () => Promise<void>;
}

/** Format a Date as YYYY-MM-DD in an IANA timezone (local calendar day). */
function localDateInTimezone(instant: Date, timezone: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(instant);
    const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? "";
    return `${get("year")}-${get("month")}-${get("day")}`;
  } catch {
    return instant.toISOString().slice(0, 10);
  }
}

/** Previous calendar date via pure date arithmetic (no DST wall-clock drift). */
function previousIsoDate(date: string): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() - 1);
  return parsed.toISOString().slice(0, 10);
}

/**
 * The local-day window to sync, oldest first: today back `syncDays` calendar
 * days in the configured timezone. Walking by calendar days (not fixed 24h
 * intervals) keeps the window correct across DST transitions.
 */
export function resolveActivitySyncDates(syncDays: number, timezone: string, now: Date): string[] {
  const dates: string[] = [];
  let cursor = localDateInTimezone(now, timezone);
  for (let count = 0; count < syncDays; count++) {
    dates.unshift(cursor);
    cursor = previousIsoDate(cursor);
  }
  return dates;
}

/**
 * Operator-facing detail for a per-source/per-day sync fault. Our own
 * controlled messages (activity.../Invalid activity...) are informative and
 * safe to surface; opaque network/runtime errors can embed hostnames or paths,
 * so they are reduced to a sanitized name+code (matches ActivityHttpSourceClient.verify).
 */
function sanitizedSyncError(error: unknown): string {
  return error instanceof Error && /^(activity|Invalid activity)/.test(error.message)
    ? error.message
    : displayErrorDetail(error) || "activity sync failed";
}

/**
 * Run one activity sync pass across every configured source. Disabled config
 * short-circuits before any store/client/HTTP work; an enabled config syncs
 * each source across the `syncDays` window and isolates per-source faults.
 */
export async function runActivitySyncOnce(options: ActivitySyncRunOptions): Promise<ActivitySyncRunSummary> {
  const ranAt = typeof options.now === "function" ? options.now() : options.now ?? new Date();

  if (!options.config.enabled) {
    return {
      ranAt: ranAt.toISOString(),
      enabled: false,
      ranCount: 0,
      errorCount: 0,
      reindexErrorCount: 0,
      totalInserted: 0,
      results: [],
    };
  }

  const dates = resolveActivitySyncDates(options.config.syncDays, options.config.timezone, ranAt);
  const createSourceClient =
    options.createSourceClient ??
    ((source: ActivitySourceConfig): ActivitySourceClient =>
      new ActivityHttpSourceClient({
        machineLabel: source.machineLabel,
        baseUrl: source.baseUrl,
        ...(source.token === undefined ? {} : { token: source.token }),
      }));
  const ownStore = options.store === undefined;
  const store = options.store ?? ActivityStore.open(options.memoryDir);
  const results: ActivitySourceRunItem[] = [];

  try {
    for (const sourceConfig of options.config.sources) {
      const item: ActivitySourceRunItem = {
        machineLabel: sourceConfig.machineLabel,
        ran: false,
        fetched: 0,
        inserted: 0,
        duplicates: 0,
        digestsWritten: 0,
        // Cursors are now per (machine, date); report the last synced day's
        // cursor. Null until a day advances it.
        cursor: null,
      };
      try {
        const client = createSourceClient(sourceConfig);
        for (const date of dates) {
          try {
            const result = await syncActivitySource(client, {
              date,
              timezone: options.config.timezone,
              memoryDir: options.memoryDir,
              store,
              signal: options.signal,
              ...(options.reindexSearch === undefined ? {} : { afterWrites: options.reindexSearch }),
            });
            item.fetched += result.fetched;
            item.inserted += result.inserted;
            item.duplicates += result.duplicates;
            if (result.digestWritten) item.digestsWritten += 1;
            item.cursor = result.cursor;
            // A day that synced durably counts as ran, even if a later day in
            // the window fails (ran = at least one durable day).
            item.ran = true;
            // The day's rows/digest/cursor are durable; a failed post-digest
            // reindex is a separate, already-sanitized signal (not a sync
            // failure) so the scheduler can observe a stale index.
            if (result.reindexError !== undefined) item.reindexError = result.reindexError;
          } catch (dateError) {
            // One bad day (a malformed historical snapshot, a per-day daemon
            // error) must not starve the remaining dates — record it and move
            // on. Dates are processed oldest-first, so continuing keeps today's
            // sync alive when an old backfill day is broken. An abort, though,
            // halts the whole run.
            item.error = sanitizedSyncError(dateError);
            if (options.signal?.aborted) break;
          }
        }
      } catch (error) {
        // Client construction failed: no date could run for this source.
        item.error = sanitizedSyncError(error);
      }
      results.push(item);
    }
  } finally {
    if (ownStore) store.close();
  }

  return {
    ranAt: ranAt.toISOString(),
    enabled: true,
    ranCount: results.filter((item) => item.ran).length,
    errorCount: results.filter((item) => item.error !== undefined).length,
    reindexErrorCount: results.filter((item) => item.reindexError !== undefined).length,
    totalInserted: results.reduce((sum, item) => sum + item.inserted, 0),
    results,
  };
}
