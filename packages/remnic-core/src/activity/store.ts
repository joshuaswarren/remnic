/**
 * Screen-activity SQLite store (issue #1899).
 *
 * Durable, capture-machine-agnostic store for on-screen text snapshots plus a
 * per-machine sync cursor. Mirrors the LCM store conventions
 * (packages/remnic-core/src/lcm/schema.ts): WAL, a `<name>_meta` schema-version
 * row, `CREATE TABLE IF NOT EXISTS`, and an FTS5 virtual table created
 * separately. better-sqlite3 is synchronous.
 *
 * Snapshots dedup on `(machine, content_hash)` so a re-sync is idempotent, and
 * day queries use half-open [start, end) UTC bounds (AGENTS.md §23).
 */

import { mkdirSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";

import { openBetterSqlite3, type BetterSqlite3Database } from "../runtime/better-sqlite.js";
import type { ActivitySnapshot } from "./types.js";

const ACTIVITY_SCHEMA_VERSION = 1;

export function activityDatabasePath(memoryDir: string): string {
  return path.join(memoryDir, "state", "activity.sqlite");
}

export async function ensureActivityStateDir(memoryDir: string): Promise<void> {
  await mkdir(path.join(memoryDir, "state"), { recursive: true });
}

export function openActivityDatabase(memoryDir: string): BetterSqlite3Database {
  // Create the state/ dir synchronously first: better-sqlite3 can't open a file
  // in a missing directory, and open() is the sync public entry point (callers
  // don't await ensureActivityStateDir). Idempotent.
  mkdirSync(path.join(memoryDir, "state"), { recursive: true });
  const db = openBetterSqlite3(activityDatabasePath(memoryDir));
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("synchronous = NORMAL");
  applySchema(db);
  return db;
}

/** Apply the activity schema on an already-open handle (test/in-memory use). */
export function applyActivitySchema(db: BetterSqlite3Database): void {
  applySchema(db);
}

function applySchema(db: BetterSqlite3Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS activity_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS activity_snapshots (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      machine         TEXT NOT NULL,
      captured_at_utc TEXT NOT NULL,
      app_name        TEXT NOT NULL,
      window_title    TEXT NOT NULL,
      browser_url     TEXT,
      text            TEXT NOT NULL,
      text_source     TEXT NOT NULL,
      content_hash    TEXT NOT NULL,
      simhash         TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_activity_snapshots_dedup
      ON activity_snapshots(machine, content_hash);
    CREATE INDEX IF NOT EXISTS idx_activity_snapshots_time
      ON activity_snapshots(captured_at_utc, id);

    CREATE TABLE IF NOT EXISTS activity_sync_state (
      machine        TEXT PRIMARY KEY,
      cursor         TEXT,
      updated_at_utc TEXT NOT NULL
    );
  `);

  const hasFts = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='activity_snapshots_fts'")
    .get();
  if (!hasFts) {
    // Standalone FTS5 (not external-content): populated explicitly on insert so
    // it never drifts from the base table.
    db.exec(`
      CREATE VIRTUAL TABLE activity_snapshots_fts USING fts5(
        text, app_name, window_title, browser_url
      );
    `);
  }

  db.prepare("INSERT OR REPLACE INTO activity_meta (key, value) VALUES ('schema_version', ?)").run(
    String(ACTIVITY_SCHEMA_VERSION),
  );
}

/** Narrow a sqlite row object so field reads are checked, not asserted. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function optStr(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Build a safe FTS5 MATCH expression from free text: extract alphanumeric
 * tokens and quote each as a phrase, so punctuation common in captured
 * activity (URLs like github.com/x/pull/412, quotes, bare boolean operators)
 * can never be parsed as FTS5 syntax and make SQLite throw. Tokens are AND-ed
 * (implicit). Returns null when there is nothing to match.
 */
function ftsMatchFor(query: string): string | null {
  if (typeof query !== "string") return null;
  const tokens = query.match(/[\p{L}\p{N}_]+/gu);
  if (!tokens || tokens.length === 0) return null;
  return tokens.map((token) => `"${token}"`).join(" ");
}

/**
 * True only for the FTS5 query-syntax error class. Since `ftsMatchFor` already
 * sanitizes the query into quoted phrases, a residual syntax error is a safe
 * "no matches"; any OTHER error (closed handle, missing/corrupt table, disk I/O)
 * is a real backend failure that must NOT masquerade as an empty result.
 */
function isFtsSyntaxError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return (
    message.includes("fts5") ||
    message.includes("malformed match") ||
    message.includes("unterminated")
  );
}

function rowToSnapshot(row: unknown): ActivitySnapshot {
  if (!isRecord(row)) {
    throw new Error("activity store: unexpected non-object row");
  }
  const textSource = row.text_source === "ocr" ? "ocr" : "ax";
  return {
    id: typeof row.id === "number" ? row.id : undefined,
    machine: str(row.machine),
    capturedAtUtc: str(row.captured_at_utc),
    app: str(row.app_name),
    windowTitle: str(row.window_title),
    ...(optStr(row.browser_url) !== undefined ? { browserUrl: optStr(row.browser_url) } : {}),
    text: str(row.text),
    textSource,
    contentHash: str(row.content_hash),
    ...(optStr(row.simhash) !== undefined ? { simhash: optStr(row.simhash) } : {}),
  };
}

export class ActivityStore {
  private readonly db: BetterSqlite3Database;

  constructor(db: BetterSqlite3Database) {
    this.db = db;
  }

  static open(memoryDir: string): ActivityStore {
    return new ActivityStore(openActivityDatabase(memoryDir));
  }

  /**
   * Insert a snapshot, idempotent on (machine, content_hash). Returns
   * `inserted: false` for a duplicate. The FTS row is written only on a real
   * insert, so it never drifts from the base table.
   */
  insertSnapshot(snapshot: ActivitySnapshot): { inserted: boolean; id: number } {
    // Base row + FTS row must be atomic. Without a transaction, a crash (or an
    // FTS throw) between the two statements leaves a snapshot in the base table
    // with no matching FTS row — silently unsearchable. The transaction rolls
    // back both on any throw.
    const runInsert = this.db.transaction((s: ActivitySnapshot): { inserted: boolean; id: number } => {
      const info = this.db
        .prepare(
          `INSERT OR IGNORE INTO activity_snapshots
             (machine, captured_at_utc, app_name, window_title, browser_url, text, text_source, content_hash, simhash)
           VALUES (@machine, @captured_at_utc, @app_name, @window_title, @browser_url, @text, @text_source, @content_hash, @simhash)`,
        )
        .run({
          machine: s.machine,
          captured_at_utc: s.capturedAtUtc,
          app_name: s.app,
          window_title: s.windowTitle,
          browser_url: s.browserUrl ?? null,
          text: s.text,
          text_source: s.textSource,
          content_hash: s.contentHash,
          simhash: s.simhash ?? null,
        });
      if (info.changes === 0) {
        const existing = this.db
          .prepare("SELECT id FROM activity_snapshots WHERE machine = ? AND content_hash = ?")
          .get(s.machine, s.contentHash);
        const id = isRecord(existing) && typeof existing.id === "number" ? existing.id : -1;
        return { inserted: false, id };
      }
      const id = Number(info.lastInsertRowid);
      this.db
        .prepare(
          `INSERT INTO activity_snapshots_fts (rowid, text, app_name, window_title, browser_url)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(id, s.text, s.app, s.windowTitle, s.browserUrl ?? "");
      return { inserted: true, id };
    });
    return runInsert(snapshot);
  }

  /** Snapshots whose capture instant is in the half-open [start, end) window. */
  listSnapshotsForDay(
    machine: string | null,
    startUtcInclusive: string,
    endUtcExclusive: string,
  ): ActivitySnapshot[] {
    const rows =
      machine === null
        ? this.db
            .prepare(
              `SELECT * FROM activity_snapshots
                 WHERE captured_at_utc >= ? AND captured_at_utc < ?
                 ORDER BY captured_at_utc ASC, id ASC`,
            )
            .all(startUtcInclusive, endUtcExclusive)
        : this.db
            .prepare(
              `SELECT * FROM activity_snapshots
                 WHERE machine = ? AND captured_at_utc >= ? AND captured_at_utc < ?
                 ORDER BY captured_at_utc ASC, id ASC`,
            )
            .all(machine, startUtcInclusive, endUtcExclusive);
    return rows.map(rowToSnapshot);
  }

  getCursor(machine: string): string | null {
    const row = this.db.prepare("SELECT cursor FROM activity_sync_state WHERE machine = ?").get(machine);
    return isRecord(row) && typeof row.cursor === "string" ? row.cursor : null;
  }

  setCursor(machine: string, cursor: string | null, updatedAtUtc: string = new Date().toISOString()): void {
    this.db
      .prepare(
        `INSERT INTO activity_sync_state (machine, cursor, updated_at_utc)
         VALUES (?, ?, ?)
         ON CONFLICT(machine) DO UPDATE SET cursor = excluded.cursor, updated_at_utc = excluded.updated_at_utc`,
      )
      .run(machine, cursor, updatedAtUtc);
  }

  /** Full-text search over snapshot text/app/window/url; newest first. */
  searchSnapshots(query: string, limit: number): ActivitySnapshot[] {
    const capped = Number.isInteger(limit) && limit > 0 ? limit : 20;
    const match = ftsMatchFor(query);
    if (match === null) return [];
    try {
      const rows = this.db
        .prepare(
          `SELECT s.* FROM activity_snapshots_fts f
             JOIN activity_snapshots s ON s.id = f.rowid
             WHERE activity_snapshots_fts MATCH ?
             ORDER BY s.captured_at_utc DESC, s.id DESC
             LIMIT ?`,
        )
        .all(match, capped);
      return rows.map(rowToSnapshot);
    } catch (error) {
      // Defensive belt for a residual FTS5 syntax error only (mirrors the LCM
      // archive search path). A real backend failure must surface, not read as
      // an empty result set.
      if (isFtsSyntaxError(error)) return [];
      throw error;
    }
  }

  /** Retention: drop snapshots captured strictly before `cutoffUtc`. */
  pruneOlderThan(cutoffUtc: string): number {
    const ids = this.db
      .prepare("SELECT id FROM activity_snapshots WHERE captured_at_utc < ?")
      .all(cutoffUtc)
      .map((row: unknown) => (isRecord(row) && typeof row.id === "number" ? row.id : -1))
      .filter((id: number) => id >= 0);
    const deleteFts = this.db.prepare("DELETE FROM activity_snapshots_fts WHERE rowid = ?");
    const deleteRow = this.db.prepare("DELETE FROM activity_snapshots WHERE id = ?");
    const tx = this.db.transaction((rowIds: number[]) => {
      for (const id of rowIds) {
        deleteFts.run(id);
        deleteRow.run(id);
      }
    });
    tx(ids);
    return ids.length;
  }

  close(): void {
    this.db.close();
  }
}
