import { createHash } from "node:crypto";
import { chmodSync, closeSync, constants, lstatSync, openSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";

import { activityDayWindow } from "@remnic/core";
import { openBetterSqlite3, displayErrorDetail, type BetterSqlite3Database } from "@remnic/core/runtime/better-sqlite";

export interface CaptureSnapshot {
  capturedAtUtc: string;
  app: string;
  windowTitle: string;
  text: string;
  textSource: "ax" | "ocr";
}

export interface CaptureScreenDaemonOptions {
  authToken: string;
  spoolPath: string;
  replay?: readonly CaptureSnapshot[];
  host?: string;
  port?: number;
}

export interface RunningCaptureScreenDaemon {
  url: string;
  close(): Promise<void>;
}

export interface CaptureScreenDaemon {
  start(): Promise<RunningCaptureScreenDaemon>;
  close(): Promise<void>;
}

type SnapshotRow = CaptureSnapshot & { id: number; contentHash: string };

function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

/** Bracket an IPv6 literal so it is a valid URL host (`::1` -> `[::1]`). */
function hostForUrl(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}

/**
 * Validate a capture instant and return its canonical `YYYY-MM-DDTHH:MM:SS.sssZ`
 * form. `Date.parse` alone rolls impossible dates over (2026-02-30 -> Mar 2), so
 * the wall-clock calendar fields are checked directly before canonicalizing,
 * independent of the zone designator. Malformed timestamps must fail here rather
 * than be persisted and mis-bucketed downstream by the activity pipeline.
 */
function canonicalTimestamp(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](?:0\d:[0-5]\d|1[0-3]:[0-5]\d|14:00))$/.exec(iso);
  const parsed = Date.parse(iso);
  if (match === null || !Number.isFinite(parsed)) throw new RangeError("capturedAtUtc must be a valid ISO-8601 UTC timestamp");
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  const daysInMonth = month >= 1 && month <= 12 ? new Date(Date.UTC(year, month, 0)).getUTCDate() : 0;
  if (day < 1 || day > daysInMonth || hour > 23 || minute > 59 || second > 59) {
    throw new RangeError("capturedAtUtc is not a real calendar instant");
  }
  return new Date(parsed).toISOString();
}

function normalizeSnapshot(snapshot: CaptureSnapshot): CaptureSnapshot {
  for (const value of [snapshot.app, snapshot.windowTitle, snapshot.text]) {
    if (typeof value !== "string") throw new TypeError("snapshot text fields must be strings");
  }
  if (snapshot.textSource !== "ax" && snapshot.textSource !== "ocr") {
    throw new TypeError('snapshot textSource must be "ax" or "ocr"');
  }
  return { ...snapshot, capturedAtUtc: canonicalTimestamp(snapshot.capturedAtUtc) };
}

function contentHash(snapshot: CaptureSnapshot): string {
  const hash = createHash("sha256");
  // Length-prefix each field so control characters (incl. NUL) in captured text
  // cannot make distinct snapshots collide — a collision would silently drop a
  // valid capture via the UNIQUE content_hash + INSERT OR IGNORE.
  for (const field of [snapshot.capturedAtUtc, snapshot.app, snapshot.windowTitle, snapshot.text, snapshot.textSource]) {
    hash.update(`${Buffer.byteLength(field)}:`).update(field);
  }
  return hash.digest("hex");
}

function applySchema(db: BetterSqlite3Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS capture_snapshots (
      id INTEGER PRIMARY KEY,
      captured_at_utc TEXT NOT NULL,
      app TEXT NOT NULL,
      window_title TEXT NOT NULL,
      text TEXT NOT NULL,
      text_source TEXT NOT NULL,
      content_hash TEXT NOT NULL UNIQUE
    );
    CREATE INDEX IF NOT EXISTS capture_snapshots_capture_at ON capture_snapshots(captured_at_utc, id);
  `);
}

function insertReplay(db: BetterSqlite3Database, replay: readonly CaptureSnapshot[]): void {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO capture_snapshots (captured_at_utc, app, window_title, text, text_source, content_hash)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const transaction = db.transaction((snapshots: readonly CaptureSnapshot[]) => {
    for (const raw of snapshots) {
      const snapshot = normalizeSnapshot(raw);
      insert.run(snapshot.capturedAtUtc, snapshot.app, snapshot.windowTitle, snapshot.text, snapshot.textSource, contentHash(snapshot));
    }
  });
  transaction(replay);
}

function parseCursor(value: string | null): number {
  if (value === null || value === "") return 0;
  const cursor = Number(value);
  if (!Number.isSafeInteger(cursor) || cursor < 0) throw new RangeError("cursor must be a non-negative integer");
  return cursor;
}

function parseLimit(value: string | null): number {
  if (value === null || value === "") return 100;
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new RangeError("limit must be an integer from 1 to 500");
  return limit;
}

function authorized(header: string | undefined, authToken: string): boolean {
  return header === `Bearer ${authToken}`;
}

function json(server: ServerResponse, status: number, body: unknown): void {
  server.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  server.end(JSON.stringify(body));
}

export async function startCaptureScreenDaemon(options: CaptureScreenDaemonOptions): Promise<CaptureScreenDaemon> {
  if (options.authToken.length === 0) throw new TypeError("authToken must be non-empty");
  const host = options.host ?? "127.0.0.1";
  if (!isLoopback(host)) throw new RangeError("capture daemon may bind only to a loopback host");
  if (options.spoolPath !== ":memory:") {
    // Screen-capture history is sensitive; keep the on-disk spool owner-only
    // (0600) rather than inheriting a world-readable umask on a shared host.
    // lstat (not stat) so a symlinked spool is rejected instead of silently
    // redirecting the private capture file to an arbitrary link target; a
    // directory or other non-file existing path is left for openBetterSqlite3
    // to reject loudly rather than us mangling its permissions.
    const existing = lstatSync(options.spoolPath, { throwIfNoEntry: false });
    if (existing !== undefined && existing.isSymbolicLink()) {
      throw new RangeError("spool path must not be a symlink");
    }
    if (existing === undefined) {
      const noFollow = constants.O_NOFOLLOW ?? 0;
      // Exclusive, no-follow create closes the lstat->open race for BOTH a
      // planted symlink (O_NOFOLLOW) and a planted regular file (O_EXCL): the
      // open fails rather than adopting an attacker-created target whose mode we
      // do not control. O_NOFOLLOW is POSIX-only and a no-op flag elsewhere.
      closeSync(openSync(options.spoolPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600));
    } else if (existing.isFile()) chmodSync(options.spoolPath, 0o600);
  }
  const db = openBetterSqlite3(options.spoolPath);
  try {
    applySchema(db);
    if (options.replay !== undefined) insertReplay(db, options.replay);
  } catch (error) {
    db.close();
    throw error;
  }

  let server: Server | undefined;
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    try {
      if (server !== undefined) {
        const closing = server;
        server = undefined;
        await new Promise<void>((resolve, reject) => closing.close((error) => (error == null ? resolve() : reject(error))));
      }
    } finally {
      db.close();
    }
  };

  return {
    async start(): Promise<RunningCaptureScreenDaemon> {
      if (closed) throw new Error("capture daemon is closed");
      if (server !== undefined) throw new Error("capture daemon is already running");
      const created = createServer((request, response) => {
        if (!authorized(request.headers.authorization, options.authToken)) {
          response.setHeader("www-authenticate", "Bearer");
          json(response, 401, { error: "unauthorized" });
          return;
        }
        const url = new URL(request.url ?? "/", `http://${hostForUrl(host)}`);
        if (request.method !== "GET") {
          json(response, 405, { error: "method_not_allowed" });
          return;
        }
        if (url.pathname === "/v1/health") {
          const row = db.prepare("SELECT COUNT(*) AS count FROM capture_snapshots").get() as { count: number };
          json(response, 200, { ok: true, snapshots: row.count });
          return;
        }
        if (url.pathname !== "/v1/snapshots") {
          json(response, 404, { error: "not_found" });
          return;
        }
        try {
          const cursor = parseCursor(url.searchParams.get("cursor"));
          const limit = parseLimit(url.searchParams.get("limit"));
          const date = url.searchParams.get("date");
          const timezone = url.searchParams.get("timezone");
          if ((date === null) !== (timezone === null)) {
            throw new RangeError("date and timezone must be provided together");
          }
          const columns = "id, captured_at_utc AS capturedAtUtc, app, window_title AS windowTitle, text, text_source AS textSource, content_hash AS contentHash";
          let rows: SnapshotRow[];
          if (date !== null && timezone !== null) {
            // Honor the ActivitySourceClient contract: one page scoped to a
            // single local day's half-open [start, end) window, cursor within it.
            const { startUtc, endUtc } = activityDayWindow(date, timezone);
            rows = db.prepare(`
              SELECT ${columns} FROM capture_snapshots
              WHERE id > ? AND captured_at_utc >= ? AND captured_at_utc < ?
              ORDER BY id ASC LIMIT ?
            `).all(cursor, startUtc, endUtc, limit) as SnapshotRow[];
          } else {
            rows = db.prepare(`
              SELECT ${columns} FROM capture_snapshots WHERE id > ? ORDER BY id ASC LIMIT ?
            `).all(cursor, limit) as SnapshotRow[];
          }
          json(response, 200, {
            snapshots: rows.map(({ id: _id, ...snapshot }) => snapshot),
            // Advance the high-water mark whenever rows were served — core only
            // persists a non-null cursor, so a final partial page must still
            // return its last id; the follow-up empty page then terminates.
            nextCursor: rows.length > 0 ? String(rows.at(-1)?.id) : null,
          });
        } catch (error) {
          json(response, 400, { error: displayErrorDetail(error) || "invalid_request" });
        }
      });
      server = created;
      try {
        await new Promise<void>((resolve, reject) => {
          created.once("error", reject);
          created.listen(options.port ?? 0, host, () => resolve());
        });
      } catch (error) {
        server = undefined;
        throw error;
      }
      const address = created.address();
      if (address === null || typeof address === "string") throw new Error("capture daemon has no TCP address");
      return { url: `http://${hostForUrl(host)}:${address.port}`, close };
    },
    close,
  };
}
