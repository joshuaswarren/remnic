import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdirSync, watch, type FSWatcher } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Duplex } from "node:stream";
import { graphSnapshotFromMemoryDir, type GraphSnapshot } from "./graph-dashboard-parser.js";
import { diffGraphSnapshots } from "./graph-dashboard-diff.js";

export interface DashboardServerOptions {
  memoryDir: string;
  host?: string;
  port?: number;
  publicDir?: string;
  watchDebounceMs?: number;
  authToken?: string;
}

export interface DashboardStatus {
  running: boolean;
  host: string;
  port: number;
  watching: boolean;
  lastUpdatedAt?: string;
  graphNodeCount: number;
  graphEdgeCount: number;
}

type WsClient = {
  id: string;
  socket: Duplex;
};

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

function normalizeOriginHostname(hostname: string): string {
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    return hostname.slice(1, -1);
  }
  return hostname;
}

function isLoopbackBindHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(normalizeOriginHostname(host.trim().toLowerCase()));
}

function constantTimeEquals(a: string, b: string): boolean {
  const aBuffer = Buffer.from(a);
  const bBuffer = Buffer.from(b);
  if (aBuffer.length !== bBuffer.length) return false;
  return timingSafeEqual(aBuffer, bBuffer);
}

function parseDashboardPort(port: number | undefined): number {
  if (port === undefined) return 0;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("dashboard port must be an integer from 0 to 65535");
  }
  return port;
}

function websocketAcceptKey(clientKey: string): string {
  return createHash("sha1")
    .update(`${clientKey}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
}

function encodeTextFrame(payload: string): Buffer {
  const payloadBuffer = Buffer.from(payload, "utf-8");
  const len = payloadBuffer.length;
  const header: number[] = [0x81];
  if (len <= 125) {
    header.push(len);
  } else if (len <= 0xffff) {
    header.push(126, (len >> 8) & 0xff, len & 0xff);
  } else {
    const high = Math.floor(len / 2 ** 32);
    const low = len >>> 0;
    header.push(127, (high >> 24) & 0xff, (high >> 16) & 0xff, (high >> 8) & 0xff, high & 0xff, (low >> 24) & 0xff, (low >> 16) & 0xff, (low >> 8) & 0xff, low & 0xff);
  }
  return Buffer.concat([Buffer.from(header), payloadBuffer]);
}

export class GraphDashboardServer {
  private readonly memoryDir: string;
  private readonly host: string;
  private readonly requestedPort: number;
  private readonly publicDir: string;
  private readonly watchDebounceMs: number;
  private readonly authToken: string | null;
  private server: ReturnType<typeof createServer> | null = null;
  private watcher: FSWatcher | null = null;
  private clients = new Map<string, WsClient>();
  private graphSnapshot: GraphSnapshot = {
    generatedAt: new Date(0).toISOString(),
    nodes: [],
    edges: [],
    stats: { nodes: 0, edges: 0, malformedLines: 0, filesMissing: [] },
  };
  private debounceTimer: NodeJS.Timeout | null = null;
  private lastError: string | null = null;
  private boundPort = 0;

  constructor(options: DashboardServerOptions) {
    this.memoryDir = options.memoryDir;
    this.host = options.host?.trim() || "127.0.0.1";
    this.requestedPort = parseDashboardPort(options.port);
    this.publicDir = options.publicDir ?? path.join(process.cwd(), "dashboard", "public");
    this.watchDebounceMs = Math.max(50, Math.floor(options.watchDebounceMs ?? 300));
    const authToken = options.authToken?.trim();
    this.authToken = authToken && authToken.length > 0 ? authToken : null;
  }

  async start(): Promise<DashboardStatus> {
    if (this.server) {
      return this.status();
    }
    if (!isLoopbackBindHost(this.host) && !this.authToken) {
      throw new Error("dashboard auth token is required when binding to a non-loopback host");
    }

    await this.rebuildSnapshot();
    const candidate = createServer((req, res) => {
      void this.handleHttp(req, res);
    });
    candidate.on("upgrade", (req, socket) => {
      this.handleUpgrade(req, socket);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error) => {
          candidate.off("listening", onListening);
          reject(err);
        };
        const onListening = () => {
          candidate.off("error", onError);
          resolve();
        };
        candidate.once("error", onError);
        candidate.once("listening", onListening);
        candidate.listen(this.requestedPort, this.host);
      });
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      try {
        candidate.close();
      } catch {
        // no-op
      }
      throw err;
    }
    this.server = candidate;
    const addr = candidate.address();
    this.boundPort = typeof addr === "object" && addr ? addr.port : this.requestedPort;
    this.startWatcher();
    return this.status();
  }

  async stop(): Promise<void> {
    const closeServer = this.server;
    this.server = null;
    this.boundPort = 0;

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    for (const client of this.clients.values()) {
      try {
        client.socket.destroy();
      } catch {
        // no-op
      }
    }
    this.clients.clear();

    if (closeServer) {
      await new Promise<void>((resolve, reject) => {
        closeServer.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    }
  }

  status(): DashboardStatus {
    return {
      running: this.server !== null,
      host: this.host,
      port: this.boundPort,
      watching: this.watcher !== null,
      lastUpdatedAt: this.graphSnapshot.generatedAt,
      graphNodeCount: this.graphSnapshot.stats.nodes,
      graphEdgeCount: this.graphSnapshot.stats.edges,
    };
  }

  private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url ?? "/";
    if (req.method === "GET" && url === "/api/health") {
      if (!this.authorizeHttpApi(req, res)) return;
      this.respondJson(res, 200, {
        ok: true,
        running: this.server !== null,
        watching: this.watcher !== null,
        graph: this.graphSnapshot.stats,
        clients: this.clients.size,
        lastError: this.lastError ?? undefined,
      });
      return;
    }
    if (req.method === "GET" && url === "/api/graph") {
      if (!this.authorizeHttpApi(req, res)) return;
      this.respondJson(res, 200, this.graphSnapshot);
      return;
    }
    if (req.method === "GET" && url === "/app.js") {
      await this.respondStatic(res, path.join(this.publicDir, "app.js"), "application/javascript; charset=utf-8");
      return;
    }
    if (req.method === "GET" && (url === "/" || url === "/index.html")) {
      await this.respondStatic(res, path.join(this.publicDir, "index.html"), "text/html; charset=utf-8");
      return;
    }
    this.respondJson(res, 404, { error: "Not found" });
  }

  private respondJson(res: ServerResponse, status: number, payload: unknown): void {
    const body = JSON.stringify(payload, null, 2);
    res.statusCode = status;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("content-length", String(Buffer.byteLength(body)));
    res.end(body);
  }

  private authorizeHttpApi(req: IncomingMessage, res: ServerResponse): boolean {
    if (!this.authToken) return true;
    const header = req.headers.authorization;
    const value = Array.isArray(header) ? header[0] : header;
    const prefix = "Bearer ";
    if (typeof value === "string" && value.startsWith(prefix)) {
      const supplied = value.slice(prefix.length);
      if (constantTimeEquals(supplied, this.authToken)) {
        return true;
      }
    }
    res.setHeader("www-authenticate", "Bearer");
    this.respondJson(res, 401, { error: "Unauthorized" });
    return false;
  }

  private async respondStatic(res: ServerResponse, filePath: string, contentType: string): Promise<void> {
    try {
      const body = await readFile(filePath, "utf-8");
      res.statusCode = 200;
      res.setHeader("content-type", contentType);
      res.setHeader("content-length", String(Buffer.byteLength(body)));
      res.end(body);
    } catch {
      this.respondJson(res, 404, { error: "Not found" });
    }
  }

  private handleUpgrade(req: IncomingMessage, socket: Duplex): void {
    const upgrade = typeof req.headers.upgrade === "string" ? req.headers.upgrade.toLowerCase() : "";
    const key = req.headers["sec-websocket-key"];
    const origin = typeof req.headers.origin === "string" ? req.headers.origin : "";
    if (upgrade !== "websocket" || typeof key !== "string") {
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      socket.destroy();
      return;
    }
    if (!this.isAllowedOrigin(origin)) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    if (!this.authorizeWebSocketUpgrade(req)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Bearer\r\n\r\n");
      socket.destroy();
      return;
    }
    const accept = websocketAcceptKey(key);
    socket.write(
      [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${accept}`,
        "",
        "",
      ].join("\r\n"),
    );
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.clients.set(id, { id, socket });
    socket.on("close", () => {
      this.clients.delete(id);
    });
    socket.on("error", () => {
      this.clients.delete(id);
    });

    const hello = JSON.stringify({
      type: "hello",
      graph: this.graphSnapshot,
    });
    socket.write(encodeTextFrame(hello));
  }

  private isAllowedOrigin(origin: string): boolean {
    if (!origin) return false;
    try {
      const parsed = new URL(origin);
      const hostname = normalizeOriginHostname(parsed.hostname);
      if (!LOOPBACK_HOSTS.has(hostname)) return false;
      if (parsed.protocol !== "http:") return false;
      const originPort = parsed.port ? Number(parsed.port) : 80;
      return Number.isFinite(originPort) && originPort === this.boundPort;
    } catch {
      return false;
    }
  }

  private authorizeWebSocketUpgrade(req: IncomingMessage): boolean {
    if (!this.authToken) return true;
    const supplied = this.webSocketTokenFromUrl(req.url) ?? this.webSocketTokenFromProtocol(req);
    return typeof supplied === "string" && constantTimeEquals(supplied, this.authToken);
  }

  private webSocketTokenFromUrl(rawUrl: string | undefined): string | null {
    if (!rawUrl) return null;
    try {
      const parsed = new URL(rawUrl, `http://${this.host}:${this.boundPort}`);
      const token = parsed.searchParams.get("token");
      return token && token.length > 0 ? token : null;
    } catch {
      return null;
    }
  }

  private webSocketTokenFromProtocol(req: IncomingMessage): string | null {
    const raw = req.headers["sec-websocket-protocol"];
    const values = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",") : [];
    for (const value of values) {
      const trimmed = value.trim();
      const prefix = "remnic-token.";
      if (!trimmed.startsWith(prefix)) continue;
      try {
        return Buffer.from(trimmed.slice(prefix.length), "base64url").toString("utf8");
      } catch {
        return null;
      }
    }
    return null;
  }

  private broadcast(payload: unknown): void {
    const frame = encodeTextFrame(JSON.stringify(payload));
    for (const [id, client] of this.clients.entries()) {
      try {
        client.socket.write(frame);
      } catch {
        this.clients.delete(id);
      }
    }
  }

  private startWatcher(): void {
    const graphDir = path.join(this.memoryDir, "state", "graphs");
    try {
      mkdirSync(graphDir, { recursive: true });
      this.watcher = watch(graphDir, { persistent: false }, () => {
        this.scheduleRebuild();
      });
      this.watcher.on("error", (err) => {
        this.lastError = err instanceof Error ? err.message : String(err);
      });
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.watcher = null;
    }
  }

  private scheduleRebuild(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.rebuildAndBroadcast();
    }, this.watchDebounceMs);
  }

  private async rebuildAndBroadcast(): Promise<void> {
    const previous = this.graphSnapshot;
    await this.rebuildSnapshot();
    const patch = diffGraphSnapshots(previous, this.graphSnapshot);
    if (
      patch.addedEdges.length === 0 &&
      patch.removedEdges.length === 0 &&
      patch.updatedEdges.length === 0 &&
      patch.addedNodes.length === 0 &&
      patch.removedNodes.length === 0
    ) {
      return;
    }
    this.broadcast({
      type: "graph_patch",
      generatedAt: new Date().toISOString(),
      patch,
      graph: this.graphSnapshot,
    });
  }

  private async rebuildSnapshot(): Promise<void> {
    try {
      this.graphSnapshot = await graphSnapshotFromMemoryDir(this.memoryDir);
      this.lastError = null;
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
    }
  }
}
