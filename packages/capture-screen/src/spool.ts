/**
 * SQLite spool — the daemon's local buffer of captured screen snapshots.
 *
 * Uses the built-in `node:sqlite` driver (no native dependency), keeping
 * @remnic/capture-screen à-la-carte: installing it pulls zero extra runtime
 * packages. WAL mode + foreign keys are enabled per connection.
 *
 * Schema (names/semantics fixed by issue #1899):
 *   snapshots(id, captured_at_utc, app_name, window_title, browser_url NULL,
 *             text, text_source (ax or ocr), content_hash UNIQUE, simhash,
 *             superseded_by NULL -> snapshots(id))
 *   meta(key, value)
 *
 * `content_hash` is UNIQUE and inserts are INSERT OR IGNORE, so re-ingesting an
 * identical snapshot is a content no-op (kill-9 / replay idempotency).
 * Supersession links the previous non-superseded snapshot of the same
 * (app, window) session to its replacement, so a consumer can skip stale states.
 * The read API pages by a stable (captured_at_utc, id) keyset over a half-open
 * local-day window.
 */

import { chmodSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { SPOOL_SCHEMA_VERSION } from "./constants.js";
import { activityDayWindow } from "./daywindow.js";
import { CaptureConfigError } from "./errors.js";
import { decodeCursor, encodeCursor } from "./validate.js";

export type TextSource = "ax" | "ocr";

export interface SnapshotInput {
  capturedAtUtc: string;
  app: string;
  windowTitle: string;
  browserUrl?: string | null;
  text: string;
  textSource: TextSource;
  contentHash: string;
  simhash: string;
}

export interface InsertResult {
  id: number;
  inserted: boolean;
  /** Id of the prior snapshot this insert superseded, or null. */
  supersededId: number | null;
}

export interface DaemonSnapshot {
  id: number;
  capturedAtUtc: string;
  app: string;
  windowTitle: string;
  browserUrl: string | null;
  text: string;
  textSource: TextSource;
  contentHash: string;
  simhash: string;
  supersededBy: number | null;
}

export interface SnapshotPage {
  snapshots: DaemonSnapshot[];
  nextCursor: string | null;
}

export interface QuerySnapshotsOptions {
  date: string;
  timezone: string;
  cursor?: string | null;
  limit: number;
}

export interface WindowFingerprint {
  app: string;
  windowTitle: string;
  simhash: string;
  capturedAtUtc: string;
}

interface SnapshotRow {
  id: number;
  capturedAtUtc: string;
  app: string;
  windowTitle: string;
  browserUrl: string | null;
  text: string;
  textSource: TextSource;
  contentHash: string;
  simhash: string;
  supersededBy: number | null;
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  captured_at_utc TEXT NOT NULL,
  app_name TEXT NOT NULL,
  window_title TEXT NOT NULL,
  browser_url TEXT,
  text TEXT NOT NULL,
  text_source TEXT NOT NULL,
  content_hash TEXT NOT NULL UNIQUE,
  simhash TEXT NOT NULL,
  superseded_by INTEGER REFERENCES snapshots(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_snap_keyset ON snapshots(captured_at_utc, id);
CREATE INDEX IF NOT EXISTS idx_snap_window ON snapshots(app_name, window_title, captured_at_utc);
`;

const SELECT_COLUMNS =
  "id, captured_at_utc AS capturedAtUtc, app_name AS app, window_title AS windowTitle, " +
  "browser_url AS browserUrl, text, text_source AS textSource, content_hash AS contentHash, " +
  "simhash, superseded_by AS supersededBy";

const ISO_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Validate + canonicalize a capture instant to UTC `Z`. Date-only strings and
 * offsetless timestamps are rejected, and impossible calendar dates (Date.parse
 * silently rolls 2026-02-30 → Mar 2) are caught by re-checking the written
 * Y-M-D, so every persisted `captured_at_utc` and every keyset cursor is an
 * unambiguous, order-stable instant.
 */
function canonicalInstant(value: string): string {
  const match = typeof value === "string" ? ISO_INSTANT.exec(value) : null;
  if (!match || !Number.isFinite(Date.parse(value))) {
    throw new CaptureConfigError(`capturedAtUtc: '${value}' is not a canonical ISO instant (need date, time, and Z or offset)`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const probe = new Date(Date.UTC(year, month - 1, day));
  probe.setUTCFullYear(year);
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    throw new CaptureConfigError(`capturedAtUtc: '${value}' is not a real calendar date`);
  }
  return new Date(value).toISOString();
}

export class Spool {
  #db: DatabaseSync;
  #closed = false;

  constructor(location: string) {
    this.#db = new DatabaseSync(location);
    this.#db.exec("PRAGMA journal_mode = WAL;");
    this.#db.exec("PRAGMA foreign_keys = ON;");
    this.#db.exec("PRAGMA busy_timeout = 5000;");
    this.#db.exec(SCHEMA_SQL);
    if (location !== ":memory:") {
      // Screen-capture history is sensitive; keep the spool owner-only (best
      // effort; ignored where chmod is a no-op).
      try {
        chmodSync(location, 0o600);
        // WAL mode writes <location>-wal / <location>-shm sidecars that hold the
        // same sensitive capture text; keep them owner-only too (best effort).
        for (const suffix of ["-wal", "-shm"]) {
          try {
            chmodSync(`${location}${suffix}`, 0o600);
          } catch {
            // sidecar absent yet / no POSIX perms
          }
        }
      } catch {
        // filesystem without POSIX perms
      }
    }
    this.#db
      .prepare("INSERT OR IGNORE INTO meta(key, value) VALUES (?, ?)")
      .run("schema_version", String(SPOOL_SCHEMA_VERSION));
    this.#db
      .prepare("INSERT OR IGNORE INTO meta(key, value) VALUES (?, ?)")
      .run("instance_id", `scr_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }

  meta(key: string): string | null {
    const row = this.#db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.#db
      .prepare("INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, value);
  }

  /**
   * Insert a snapshot. Idempotent by content_hash (INSERT OR IGNORE): a repeat
   * returns the existing row's id with `inserted:false` and performs no
   * supersession. On a genuinely new row, the previous non-superseded snapshot
   * of the same (app, window) captured within `sessionGapSeconds` is marked
   * superseded_by this row.
   */
  insertSnapshot(input: SnapshotInput, sessionGapSeconds: number): InsertResult {
    if (typeof input.text !== "string") throw new CaptureConfigError("snapshot.text: expected a string");
    if (input.textSource !== "ax" && input.textSource !== "ocr") {
      throw new CaptureConfigError("snapshot.textSource: expected 'ax' or 'ocr'");
    }
    if (typeof input.contentHash !== "string" || input.contentHash === "") {
      throw new CaptureConfigError("snapshot.contentHash: expected a non-empty string");
    }
    if (typeof input.simhash !== "string" || input.simhash === "") {
      throw new CaptureConfigError("snapshot.simhash: expected a non-empty string");
    }
    const capturedAtUtc = canonicalInstant(input.capturedAtUtc);
    const browserUrl = input.browserUrl ?? null;

    const db = this.#db;
    db.exec("BEGIN");
    try {
      const result = db
        .prepare(
          "INSERT OR IGNORE INTO snapshots(captured_at_utc, app_name, window_title, browser_url, text, text_source, content_hash, simhash) " +
            "VALUES (?,?,?,?,?,?,?,?)",
        )
        .run(capturedAtUtc, input.app, input.windowTitle, browserUrl, input.text, input.textSource, input.contentHash, input.simhash);
      if (Number(result.changes) === 0) {
        const existing = db.prepare("SELECT id FROM snapshots WHERE content_hash = ?").get(input.contentHash) as
          | { id: number }
          | undefined;
        db.exec("COMMIT");
        return { id: existing?.id ?? 0, inserted: false, supersededId: null };
      }
      const id = Number(result.lastInsertRowid);
      const supersededId = this.#supersede(id, input.app, input.windowTitle, capturedAtUtc, sessionGapSeconds);
      db.exec("COMMIT");
      return { id, inserted: true, supersededId };
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  /** Link the prior in-session snapshot of the same window to `newId`. */
  #supersede(newId: number, app: string, windowTitle: string, capturedAtUtc: string, sessionGapSeconds: number): number | null {
    const prior = this.#db
      .prepare(
        "SELECT id, captured_at_utc AS capturedAtUtc FROM snapshots " +
          "WHERE app_name = ? AND window_title = ? AND superseded_by IS NULL AND id <> ? " +
          "AND captured_at_utc <= ? ORDER BY captured_at_utc DESC, id DESC LIMIT 1",
      )
      .get(app, windowTitle, newId, capturedAtUtc) as { id: number; capturedAtUtc: string } | undefined;
    if (prior === undefined) return null;
    const gapSeconds = (Date.parse(capturedAtUtc) - Date.parse(prior.capturedAtUtc)) / 1000;
    if (gapSeconds < 0 || gapSeconds > sessionGapSeconds) return null;
    this.#db.prepare("UPDATE snapshots SET superseded_by = ? WHERE id = ?").run(newId, prior.id);
    return prior.id;
  }

  getSnapshot(id: number): DaemonSnapshot | null {
    const row = this.#db.prepare(`SELECT ${SELECT_COLUMNS} FROM snapshots WHERE id = ?`).get(id) as
      | SnapshotRow
      | undefined;
    return row ? { ...row } : null;
  }

  countSnapshots(): number {
    return (this.#db.prepare("SELECT COUNT(*) AS n FROM snapshots").get() as { n: number }).n;
  }

  /**
   * Snapshots whose capture instant falls in the half-open [start, end) UTC
   * window of the requested local day, paged by the stable (captured_at_utc, id)
   * keyset. The id tiebreak keeps pagination correct across snapshots that
   * share a capture instant.
   */
  querySnapshots(opts: QuerySnapshotsOptions): SnapshotPage {
    const { startUtc, endUtc } = activityDayWindow(opts.date, opts.timezone);
    const cursor = decodeCursor(opts.cursor ?? null);
    const afterAt = cursor ? cursor.capturedAtUtc : "";
    const afterId = cursor ? cursor.id : 0;
    const rows = this.#db
      .prepare(
        `SELECT ${SELECT_COLUMNS} FROM snapshots ` +
          "WHERE superseded_by IS NULL AND captured_at_utc >= ? AND captured_at_utc < ? " +
          "AND (captured_at_utc > ? OR (captured_at_utc = ? AND id > ?)) " +
          "ORDER BY captured_at_utc ASC, id ASC LIMIT ?",
      )
      .all(startUtc, endUtc, afterAt, afterAt, afterId, opts.limit + 1) as unknown as SnapshotRow[];
    const hasMore = rows.length > opts.limit;
    const page = hasMore ? rows.slice(0, opts.limit) : rows;
    const last = page[page.length - 1];
    return {
      snapshots: page.map((row) => ({ ...row })),
      nextCursor: hasMore && last ? encodeCursor(last.capturedAtUtc, last.id) : null,
    };
  }

  /** All snapshots in a local day's window, ordered — the basis for /v1/stats. */
  daySnapshots(date: string, timezone: string): DaemonSnapshot[] {
    const { startUtc, endUtc } = activityDayWindow(date, timezone);
    const rows = this.#db
      .prepare(
        `SELECT ${SELECT_COLUMNS} FROM snapshots WHERE superseded_by IS NULL AND captured_at_utc >= ? AND captured_at_utc < ? ` +
          "ORDER BY captured_at_utc ASC, id ASC",
      )
      .all(startUtc, endUtc) as unknown as SnapshotRow[];
    return rows.map((row) => ({ ...row }));
  }

  /** Latest non-superseded fingerprint per (app, window) — primes the dedup cache. */
  latestFingerprints(): WindowFingerprint[] {
    const rows = this.#db
      .prepare(
        "SELECT app_name AS app, window_title AS windowTitle, simhash, captured_at_utc AS capturedAtUtc FROM snapshots s " +
          "WHERE superseded_by IS NULL AND id = (SELECT MAX(id) FROM snapshots t WHERE t.app_name = s.app_name AND t.window_title = s.window_title)",
      )
      .all() as unknown as WindowFingerprint[];
    return rows;
  }

  /** Retention janitor: drop snapshots older than `days` (cutoff from `nowMs`). Returns rows removed. */
  pruneOlderThan(days: number, nowMs: number = Date.now()): number {
    const cutoff = new Date(nowMs - days * 86_400_000).toISOString();
    const result = this.#db.prepare("DELETE FROM snapshots WHERE captured_at_utc < ?").run(cutoff);
    return Number(result.changes);
  }
}
