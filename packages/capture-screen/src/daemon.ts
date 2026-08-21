/**
 * Loopback-only HTTP daemon. Serves the spool over three read-only routes:
 *
 *   GET /v1/health     → liveness + capture status + AX/OCR availability
 *   GET /v1/snapshots  → snapshots for a local day (keyset paged; wire shape
 *                        consumed by @remnic/core's ActivityHttpSourceClient)
 *   GET /v1/stats      → per-app time attribution for a local day
 *
 * Security: capture-screen serves PLAIN HTTP and has no TLS contract, so it
 * refuses to bind a non-loopback host — captured screen text must never cross
 * the network in cleartext. Every request MUST carry `Authorization: Bearer
 * <token>` matching the daemon token, even on loopback, so another local user
 * cannot read snapshots off 127.0.0.1. Input errors are 400; anything
 * unexpected is 500 with no foreign text.
 */

import http from "node:http";
import { Buffer } from "node:buffer";

import { computeStats } from "./capture.js";
import { CAPTURE_SCREEN_VERSION } from "./constants.js";
import { CaptureConfigError, CaptureInputError } from "./errors.js";
import { bearerFromHeader, tokensMatch } from "./token.js";
import { formatHostForUrl, isLoopbackHost } from "./util.js";
import { assertValidTimezone, parseLimit, parseSnapshotDate } from "./validate.js";
import type { DaemonConfig } from "./config.js";
import type { DaemonSnapshot, Spool } from "./spool.js";

export interface DaemonDeps {
  spool: Spool;
  config: DaemonConfig;
  token: string;
  /** Live capture status for /v1/health; false until the capture layer runs. */
  capturing?: boolean;
  /** Native-helper capabilities (false when the helper is unavailable). */
  axAvailable?: boolean;
  ocrAvailable?: boolean;
  /** Operator-facing hint surfaced on /v1/health when the helper is missing. */
  helperHint?: string | null;
}

export interface DaemonHandle {
  server: http.Server;
  host: string;
  port: number;
  url: string;
  close(): Promise<void>;
}

/** Wire shape consumed by ActivityHttpSourceClient. browserUrl omitted when null. */
function snapshotToWire(snap: DaemonSnapshot): Record<string, unknown> {
  const wire: Record<string, unknown> = {
    capturedAtUtc: snap.capturedAtUtc,
    app: snap.app,
    windowTitle: snap.windowTitle,
    text: snap.text,
    textSource: snap.textSource,
    contentHash: snap.contentHash,
    simhash: snap.simhash,
  };
  if (snap.browserUrl !== null) wire.browserUrl = snap.browserUrl;
  return wire;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  res.end(payload);
}

function handleHealth(deps: DaemonDeps, res: http.ServerResponse): void {
  const body: Record<string, unknown> = {
    ok: true,
    version: CAPTURE_SCREEN_VERSION,
    platform: process.platform,
    capturing: deps.capturing ?? false,
    axAvailable: deps.axAvailable ?? false,
    ocrAvailable: deps.ocrAvailable ?? false,
    pendingCount: deps.spool.countSnapshots(),
    instanceId: deps.spool.meta("instance_id"),
    replayStatus: deps.spool.meta("replay_status"),
    pid: process.pid,
  };
  if (deps.helperHint) body.helperHint = deps.helperHint;
  sendJson(res, 200, body);
}

function handleSnapshots(deps: DaemonDeps, url: URL, res: http.ServerResponse): void {
  const date = parseSnapshotDate(url.searchParams.get("date"));
  const timezone = assertValidTimezone(url.searchParams.get("timezone"));
  const limit = parseLimit(url.searchParams.get("limit"));
  const cursor = url.searchParams.get("cursor");
  const page = deps.spool.querySnapshots({ date, timezone, cursor, limit });
  sendJson(res, 200, { snapshots: page.snapshots.map(snapshotToWire), nextCursor: page.nextCursor });
}

function handleStats(deps: DaemonDeps, url: URL, res: http.ServerResponse): void {
  const date = parseSnapshotDate(url.searchParams.get("date"));
  const timezone = assertValidTimezone(url.searchParams.get("timezone"));
  const stats = computeStats(deps.spool.daySnapshots(date, timezone), date, timezone, deps.config.maxDwellSeconds);
  sendJson(res, 200, stats);
}

export function createRequestHandler(deps: DaemonDeps): http.RequestListener {
  if (!isLoopbackHost(deps.config.host)) {
    throw new CaptureConfigError(
      `refusing to bind non-loopback host '${deps.config.host}': capture-screen serves plain HTTP with no TLS contract; ` +
        "bind a loopback address (127.0.0.1 or ::1) only",
    );
  }
  if (!deps.token) {
    throw new CaptureConfigError("daemon requires a bearer token");
  }
  return (req, res) => {
    try {
      const presented = bearerFromHeader(req.headers["authorization"]);
      if (!presented || !tokensMatch(deps.token, presented)) {
        res.setHeader("www-authenticate", "Bearer");
        sendJson(res, 401, { error: "unauthorized" });
        return;
      }
      if (req.method !== "GET") {
        sendJson(res, 405, { error: "method not allowed" });
        return;
      }
      const url = new URL(req.url ?? "/", "http://localhost");
      switch (url.pathname) {
        case "/v1/health":
          handleHealth(deps, res);
          return;
        case "/v1/snapshots":
          handleSnapshots(deps, url, res);
          return;
        case "/v1/stats":
          handleStats(deps, url, res);
          return;
        default:
          sendJson(res, 404, { error: "not found" });
      }
    } catch (err) {
      if (err instanceof CaptureInputError) {
        sendJson(res, 400, { error: err.message });
        return;
      }
      sendJson(res, 500, { error: "internal error" });
    }
  };
}

export function startDaemon(deps: DaemonDeps): Promise<DaemonHandle> {
  return new Promise((resolve, reject) => {
    let handler: http.RequestListener;
    try {
      handler = createRequestHandler(deps);
    } catch (err) {
      reject(err as Error);
      return;
    }
    const server = http.createServer(handler);
    const onError = (err: Error) => reject(err);
    server.once("error", onError);
    server.listen(deps.config.port, deps.config.host, () => {
      server.removeListener("error", onError);
      server.on("error", (err: NodeJS.ErrnoException) => {
        process.stderr.write(`capture-screen daemon server error: ${err.code ?? err.name}\n`);
      });
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : deps.config.port;
      const host = deps.config.host;
      resolve({
        server,
        host,
        port,
        url: `http://${formatHostForUrl(host)}:${port}`,
        close: () =>
          new Promise<void>((res2, rej2) => {
            server.close((closeErr) => (closeErr ? rej2(closeErr) : res2()));
          }),
      });
    });
  });
}
