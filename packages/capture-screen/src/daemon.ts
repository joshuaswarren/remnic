import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";

import { openBetterSqlite3, type BetterSqlite3Database } from "@remnic/core/runtime/better-sqlite";

export interface CaptureSnapshot {
  capturedAtUtc: string;
  app: string;
  windowTitle: string;
  text: string;
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

type SnapshotRow = CaptureSnapshot & { id: number };

function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

function validSnapshot(snapshot: CaptureSnapshot): void {
  if (!Number.isFinite(Date.parse(snapshot.capturedAtUtc))) throw new RangeError("capturedAtUtc must be a valid ISO timestamp");
  for (const value of [snapshot.app, snapshot.windowTitle, snapshot.text]) {
    if (typeof value !== "string" || value.length === 0) throw new TypeError("snapshot text fields must be non-empty strings");
  }
}

function contentHash(snapshot: CaptureSnapshot): string {
  return createHash("sha256")
    .update(snapshot.capturedAtUtc)
    .update("\0")
    .update(snapshot.app)
    .update("\0")
    .update(snapshot.windowTitle)
    .update("\0")
    .update(snapshot.text)
    .digest("hex");
}

function applySchema(db: BetterSqlite3Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS capture_snapshots (
      id INTEGER PRIMARY KEY,
      captured_at_utc TEXT NOT NULL,
      app TEXT NOT NULL,
      window_title TEXT NOT NULL,
      text TEXT NOT NULL,
      content_hash TEXT NOT NULL UNIQUE
    );
    CREATE INDEX IF NOT EXISTS capture_snapshots_capture_at ON capture_snapshots(captured_at_utc, id);
  `);
}

function insertReplay(db: BetterSqlite3Database, replay: readonly CaptureSnapshot[]): void {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO capture_snapshots (captured_at_utc, app, window_title, text, content_hash)
    VALUES (?, ?, ?, ?, ?)
  `);
  const transaction = db.transaction((snapshots: readonly CaptureSnapshot[]) => {
    for (const snapshot of snapshots) {
      validSnapshot(snapshot);
      insert.run(snapshot.capturedAtUtc, snapshot.app, snapshot.windowTitle, snapshot.text, contentHash(snapshot));
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

function json(server: import("node:http").ServerResponse, status: number, body: unknown): void {
  server.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  server.end(JSON.stringify(body));
}

export async function startCaptureScreenDaemon(options: CaptureScreenDaemonOptions): Promise<CaptureScreenDaemon> {
  if (options.authToken.length === 0) throw new TypeError("authToken must be non-empty");
  const host = options.host ?? "127.0.0.1";
  if (!isLoopback(host)) throw new RangeError("capture daemon may bind only to a loopback host");
  const db = openBetterSqlite3(options.spoolPath);
  applySchema(db);
  if (options.replay !== undefined) insertReplay(db, options.replay);

  let server: Server | undefined;
  const close = async (): Promise<void> => {
    if (server !== undefined) {
      const closing = server;
      server = undefined;
      await new Promise<void>((resolve, reject) => closing.close((error) => error === undefined ? resolve() : reject(error)));
    }
    db.close();
  };

  return {
    async start(): Promise<RunningCaptureScreenDaemon> {
      if (server !== undefined) throw new Error("capture daemon is already running");
      server = createServer((request, response) => {
        if (!authorized(request.headers.authorization, options.authToken)) {
          response.setHeader("www-authenticate", "Bearer");
          json(response, 401, { error: "unauthorized" });
          return;
        }
        const url = new URL(request.url ?? "/", `http://${host}`);
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
          const rows = db.prepare(`
            SELECT id, captured_at_utc AS capturedAtUtc, app, window_title AS windowTitle, text
            FROM capture_snapshots WHERE id > ? ORDER BY id ASC LIMIT ?
          `).all(cursor, limit + 1) as SnapshotRow[];
          const hasNext = rows.length > limit;
          const snapshots = hasNext ? rows.slice(0, limit) : rows;
          json(response, 200, {
            snapshots: snapshots.map(({ id: _id, ...snapshot }) => snapshot),
            nextCursor: hasNext ? String(snapshots.at(-1)?.id) : null,
          });
        } catch (error) {
          json(response, 400, { error: error instanceof Error ? error.message : "invalid_request" });
        }
      });
      await new Promise<void>((resolve, reject) => {
        server?.once("error", reject);
        server?.listen(options.port ?? 0, host, () => resolve());
      });
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("capture daemon has no TCP address");
      return { url: `http://${host}:${address.port}`, close };
    },
    close,
  };
}
