/**
 * Loopback-only HTTP daemon. Serves the spool over three read-only routes:
 *
 *   GET /v1/health         → liveness + capture status + instanceId
 *   GET /v1/conversations  → final conversations for a local day (keyset paged)
 *   GET /v1/speakers        → speaker clusters (curation aid)
 *
 * Security: capture-audio serves PLAIN HTTP and has no TLS contract, so it
 * refuses to bind a non-loopback host — transcript data must never cross
 * the network in cleartext (a remote reader must front it with their own
 * TLS/tunnel, out of scope here). Every request MUST carry
 * `Authorization: Bearer <token>` matching the daemon token, even on
 * loopback, so another local user cannot read transcripts off 127.0.0.1.
 * Input errors are 400; anything unexpected is 500 with no foreign text.
 */

import http from "node:http";
import { Buffer } from "node:buffer";

import { CAPTURE_AUDIO_VERSION } from "./constants.js";
import { CaptureConfigError, CaptureInputError } from "./errors.js";
import { bearerFromHeader, tokensMatch } from "./token.js";
import { formatHostForUrl, isLoopbackHost } from "./util.js";
import { assertValidTimezone, parseLimit, parseTranscriptDate } from "./validate.js";
import type { DaemonConfig } from "./config.js";
import type { Spool } from "./spool.js";

export interface DaemonDeps {
  spool: Spool;
  config: DaemonConfig;
  token: string;
  /** Live capture status for /v1/health; false until the capture layer lands. */
  capturing?: boolean;
}

export interface DaemonHandle {
  server: http.Server;
  host: string;
  port: number;
  url: string;
  close(): Promise<void>;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function handleHealth(deps: DaemonDeps, res: http.ServerResponse): void {
  sendJson(res, 200, {
    ok: true,
    version: CAPTURE_AUDIO_VERSION,
    platform: process.platform,
    capturing: deps.capturing ?? false,
    sttModel: deps.config.stt.modelPath,
    pendingChunks: deps.spool.pendingChunkCount(),
    instanceId: deps.spool.meta("instance_id"),
  });
}

function handleConversations(deps: DaemonDeps, url: URL, res: http.ServerResponse): void {
  const date = parseTranscriptDate(url.searchParams.get("date"));
  const timezone = assertValidTimezone(url.searchParams.get("timezone"));
  const limit = parseLimit(url.searchParams.get("limit"));
  const cursor = url.searchParams.get("cursor");
  const page = deps.spool.queryFinalConversations({ date, timezone, cursor, limit });
  sendJson(res, 200, page);
}

function handleSpeakers(deps: DaemonDeps, res: http.ServerResponse): void {
  const speakers = deps.spool.listSpeakers().map((s) => ({ id: s.id, label: s.label, isSelf: s.isSelf }));
  sendJson(res, 200, { speakers });
}

export function createRequestHandler(deps: DaemonDeps): http.RequestListener {
  if (!isLoopbackHost(deps.config.host)) {
    throw new CaptureConfigError(
      `refusing to bind non-loopback host '${deps.config.host}': capture-audio serves plain HTTP with no TLS contract; ` +
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
        case "/v1/conversations":
          handleConversations(deps, url, res);
          return;
        case "/v1/speakers":
          handleSpeakers(deps, res);
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
