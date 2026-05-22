import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";
import { log } from "./logger.js";
import { EngramAccessInputError, type EngramAccessService } from "./access-service.js";
import { EngramMcpServer } from "./access-mcp.js";
import { validateRequest, type SchemaName, type SchemaTypeFor } from "./access-schema.js";
import type { RecallDisclosure, RecallPlanMode } from "./types.js";
import { isRecallDisclosure } from "./types.js";
import { isTrustZoneName, type TrustZoneName, type TrustZoneRecordKind, type TrustZoneSourceClass } from "./trust-zones.js";
import { AdapterRegistry, type ResolvedIdentity } from "./adapters/index.js";
import type { CitationEntry } from "./citations.js";
import {
  subscribeGraphEvents,
  type GraphEvent,
} from "./graph-events.js";
import { expandTildePath } from "./utils/path.js";

export interface EngramAccessHttpServerOptions {
  service: EngramAccessService;
  host?: string;
  port?: number;
  authToken?: string;
  /** Additional valid tokens (for multi-connector auth). Checked alongside authToken. */
  authTokens?: string[];
  /** Dynamic token loader — called on each auth check so new/revoked tokens take effect without restart. */
  authTokensGetter?: () => string[];
  principal?: string;
  maxBodyBytes?: number;
  adminConsoleEnabled?: boolean;
  adminConsolePublicDir?: string;
  trustPrincipalHeader?: boolean;
  /** Enable adapter-based identity resolution from request headers */
  enableAdapters?: boolean;
  /** Custom adapter registry (defaults to built-in adapters) */
  adapterRegistry?: AdapterRegistry;
  /** Enable oai-mem-citation blocks in recall responses (issue #379). */
  citationsEnabled?: boolean;
  /** Auto-enable citations for Codex adapter connections (issue #379). */
  citationsAutoDetect?: boolean;
}

export interface EngramAccessHttpServerStatus {
  running: boolean;
  host: string;
  port: number;
  maxBodyBytes: number;
}

function resolveDefaultAdminConsolePublicDir(): string {
  const thisDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // Standard: admin-console sibling to src/ (development layout)
    path.resolve(thisDir, "../admin-console/public"),
    // Bundled: admin-console inside dist/ alongside the bundle
    path.resolve(thisDir, "./admin-console/public"),
    // Package root: walk up from dist/ to the package root
    path.resolve(thisDir, "../../admin-console/public"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

const defaultAdminConsolePublicDir = resolveDefaultAdminConsolePublicDir();
const correlationIdStore = new AsyncLocalStorage<string>();

const WRITE_RATE_LIMIT_WINDOW_MS = 60_000;
const WRITE_RATE_LIMIT_MAX_REQUESTS = 30;
const TRUST_ZONE_RECORD_KINDS = ["memory", "artifact", "state", "trajectory", "external"] as const;
const TRUST_ZONE_SOURCE_CLASSES = ["tool_output", "web_content", "subagent_trace", "system_memory", "user_input", "manual"] as const;

class HttpError extends Error {
  readonly code: string;
  readonly details?: unknown;
  constructor(readonly status: number, message: string, code?: string, details?: unknown) {
    super(message);
    this.code = code ?? `http_${status}`;
    this.details = details;
  }
}

function hostToUrlAuthority(host: string): string {
  if (host.includes(":") && !host.startsWith("[") && !host.endsWith("]")) {
    return `[${host}]`;
  }
  return host;
}

function parseHttpServerPort(port: number | undefined): number {
  if (port === undefined) return 0;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("access HTTP port must be an integer from 0 to 65535");
  }
  return port;
}

function parseTrustZoneKindFilter(raw: string | null): TrustZoneRecordKind | undefined {
  if (raw === null) return undefined;
  if ((TRUST_ZONE_RECORD_KINDS as readonly string[]).includes(raw)) {
    return raw as TrustZoneRecordKind;
  }
  throw new HttpError(400, `kind must be one of ${TRUST_ZONE_RECORD_KINDS.join("|")}`, "invalid_kind_filter");
}

function parseTrustZoneSourceClassFilter(raw: string | null): TrustZoneSourceClass | undefined {
  if (raw === null) return undefined;
  if ((TRUST_ZONE_SOURCE_CLASSES as readonly string[]).includes(raw)) {
    return raw as TrustZoneSourceClass;
  }
  throw new HttpError(400, `sourceClass must be one of ${TRUST_ZONE_SOURCE_CLASSES.join("|")}`, "invalid_source_class_filter");
}

function parseTrustZoneFilter(raw: string | null): TrustZoneName | undefined {
  if (raw === null) return undefined;
  if (isTrustZoneName(raw)) {
    return raw;
  }
  throw new HttpError(400, "zone must be one of quarantine|working|trusted", "invalid_zone_filter");
}

/**
 * Decode a `:peerId` URL path segment, converting malformed percent-encoded
 * input (e.g., `%E0%A4%A`) into a 400 client error rather than letting
 * `URIError` bubble up as a 500 `internal_error`.
 */
function decodePeerIdSegment(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new EngramAccessInputError("peerId path segment is not valid percent-encoded input");
  }
}

export class EngramAccessHttpServer {
  private readonly service: EngramAccessService;
  private readonly host: string;
  private readonly requestedPort: number;
  private readonly authToken?: string;
  private readonly authTokens: string[];
  private readonly authTokensGetter?: () => string[];
  private readonly authenticatedPrincipal?: string;
  private readonly maxBodyBytes: number;
  private readonly adminConsoleEnabled: boolean;
  private readonly adminConsolePublicDir: string;
  private readonly trustPrincipalHeader: boolean;
  private readonly adapterRegistry: AdapterRegistry | null;
  private readonly writeRequestTimestamps: number[] = [];
  private readonly mcpServer: EngramMcpServer;
  private server: Server | null = null;
  private boundPort = 0;
  /** Active SSE response objects for /engram/v1/graph/events. */
  private readonly sseClients = new Set<ServerResponse>();
  /** Throttle batch: pending SSE event batches per client. */
  private readonly sseBatchTimers = new Map<ServerResponse, ReturnType<typeof setTimeout>>();
  private readonly ssePendingBatches = new Map<ServerResponse, GraphEvent[]>();
  /**
   * Per-client cleanup callbacks: clear heartbeat interval, flush timer,
   * unsubscribe from bus, and end the response.  Stored here so `stop()`
   * can invoke them even when the client hasn't disconnected yet
   * (Cursor review thread `access-http.ts:232`).
   */
  private readonly sseCleanupFns = new Set<() => void>();

  constructor(options: EngramAccessHttpServerOptions) {
    this.service = options.service;
    this.host = options.host?.trim() || "127.0.0.1";
    this.requestedPort = parseHttpServerPort(options.port);
    this.authToken = options.authToken?.trim() || undefined;
    this.authTokens = (options.authTokens ?? []).map((t) => t.trim()).filter(Boolean);
    this.authTokensGetter = options.authTokensGetter;
    this.authenticatedPrincipal = options.principal?.trim() || undefined;
    this.maxBodyBytes = Number.isFinite(options.maxBodyBytes)
      ? Math.max(1, Math.floor(options.maxBodyBytes ?? 131072))
      : 131072;
    this.adminConsoleEnabled = options.adminConsoleEnabled !== false;
    this.adminConsolePublicDir = options.adminConsolePublicDir ?? defaultAdminConsolePublicDir;
    this.trustPrincipalHeader = options.trustPrincipalHeader === true;
    this.adapterRegistry = options.enableAdapters !== false
      ? (options.adapterRegistry ?? new AdapterRegistry())
      : null;
    this.mcpServer = new EngramMcpServer(this.service, {
      principal: options.principal,
      citationsEnabled: options.citationsEnabled,
      citationsAutoDetect: options.citationsAutoDetect,
    });
  }

  async start(): Promise<EngramAccessHttpServerStatus> {
    if (!this.authToken && this.authTokens.length === 0 && !this.authTokensGetter) {
      throw new Error("engram access HTTP requires authToken or authTokens");
    }
    if (this.server) return this.status();

    const server = createServer((req, res) => {
      const correlationId = randomUUID();
      correlationIdStore.run(correlationId, () => {
        void this.handle(req, res, correlationId).catch((err) => {
          log.debug(`engram access HTTP request failed [${correlationId}]: ${err}`);
          if (err instanceof HttpError) {
            const payload: Record<string, unknown> = { error: err.message, code: err.code };
            if (err.details) payload.details = err.details;
            this.respondJson(res, err.status, payload);
            return;
          }
          if (err instanceof EngramAccessInputError) {
            this.respondJson(res, 400, { error: err.message, code: "input_error" });
            return;
          }
          if (res.headersSent) {
            res.destroy(err as Error);
            return;
          }
          this.respondJson(res, 500, { error: "internal_error", code: "internal_error" });
        });
      });
    });

    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error) => {
          server.off("listening", onListening);
          reject(err);
        };
        const onListening = () => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(this.requestedPort, this.host);
      });
    } catch (err) {
      server.close();
      throw err;
    }

    this.server = server;
    const address = server.address();
    this.boundPort = typeof address === "object" && address ? address.port : this.requestedPort;
    return this.status();
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    this.boundPort = 0;
    // Invoke each SSE client's cleanup callback so heartbeat intervals,
    // batch timers, and graph-bus subscriptions are all released before the
    // HTTP server closes.  Without this, long-running SSE connections leak
    // setInterval handles and EventEmitter listeners (Cursor review thread
    // `access-http.ts:232`).
    for (const cleanup of this.sseCleanupFns) {
      try { cleanup(); } catch { /* ignore */ }
    }
    this.sseCleanupFns.clear();
    // Belt-and-suspenders: clear any state not yet reached by cleanup fns.
    for (const [res, timer] of this.sseBatchTimers.entries()) {
      clearTimeout(timer);
      this.sseBatchTimers.delete(res);
    }
    this.ssePendingBatches.clear();
    for (const res of this.sseClients) {
      try { res.end(); } catch { /* ignore */ }
    }
    this.sseClients.clear();
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }

  status(): EngramAccessHttpServerStatus {
    return {
      running: this.server !== null,
      host: this.host,
      port: this.boundPort,
      maxBodyBytes: this.maxBodyBytes,
    };
  }

  /**
   * Resolve the adapter identity for the incoming request.
   * Includes MCP clientInfo from the last initialize handshake if available.
   * Returns null if no adapter matches or adapters are disabled.
   */
  resolveAdapterIdentity(req: IncomingMessage): ResolvedIdentity | null {
    if (!this.adapterRegistry) return null;
    // Look up clientInfo for this specific MCP session to avoid cross-session leaks.
    // Non-MCP requests (no mcp-session-id header) get undefined clientInfo and
    // rely on HTTP headers for adapter matching.
    const sessionId = (() => {
      const raw = req.headers["mcp-session-id"];
      return typeof raw === "string" ? raw.trim() : undefined;
    })();
    return this.adapterRegistry.resolve({
      headers: req.headers as Record<string, string | string[] | undefined>,
      clientInfo: this.mcpServer.getClientInfo(sessionId),
    });
  }

  /** Cache for per-request identity resolution (avoids double adapter resolution) */
  private identityCache = new WeakMap<IncomingMessage, { principal?: string; namespace?: string }>();

  /** Resolve principal and namespace from request headers and adapter identity */
  private resolveRequestIdentity(req: IncomingMessage): { principal?: string; namespace?: string } {
    const cached = this.identityCache.get(req);
    if (cached) return cached;
    let principal: string | undefined;
    let namespace: string | undefined;

    // Explicit header override takes priority for principal
    if (this.trustPrincipalHeader) {
      const headerVal = req.headers["x-engram-principal"];
      const raw = Array.isArray(headerVal) ? headerVal[0] : headerVal;
      if (typeof raw === "string") {
        const trimmed = raw.trim();
        if (trimmed.length > 0) {
          principal = trimmed;
        }
      }
    }

    // Try adapter-based identity resolution for both principal and namespace
    const adapterIdentity = this.resolveAdapterIdentity(req);
    if (adapterIdentity) {
      if (!principal) {
        principal = adapterIdentity.principal;
      }
      namespace = adapterIdentity.namespace;
    }

    if (!principal) {
      principal = this.authenticatedPrincipal;
    }

    const result = { principal, namespace };
    this.identityCache.set(req, result);
    return result;
  }

  private resolveRequestPrincipal(req: IncomingMessage): string | undefined {
    return this.resolveRequestIdentity(req).principal;
  }

  /** Resolve namespace: only use the explicit body value. Adapter-inferred namespace
   *  is intentionally NOT used as a fallback for REST requests — omitting namespace
   *  should default to the server's global namespace, not silently scope to an adapter. */
  private resolveNamespace(_req: IncomingMessage, bodyNamespace?: string): string | undefined {
    return bodyNamespace || undefined;
  }

  /**
   * Resolve the recall disclosure depth from the request (issue #677 PR
   * 2/4).  Explicit body value wins; otherwise we accept a
   * `?disclosure=...` query parameter so curl/browser tooling can use the
   * three-tier surface without rewriting JSON.  Invalid query values
   * throw `EngramAccessInputError` (CLAUDE.md rule 51 — no silent
   * fallback).  An absent body field AND an absent query param yields
   * `undefined`, which the service maps to `DEFAULT_RECALL_DISCLOSURE`.
   */
  private resolveRecallDisclosure(
    bodyDisclosure: RecallDisclosure | undefined,
    parsed: URL,
  ): RecallDisclosure | undefined {
    if (bodyDisclosure !== undefined) {
      return bodyDisclosure;
    }
    const queryDisclosure = parsed.searchParams.get("disclosure");
    if (queryDisclosure === null) {
      return undefined;
    }
    if (!isRecallDisclosure(queryDisclosure)) {
      throw new EngramAccessInputError(
        `disclosure must be one of: chunk, section, raw (got: ${queryDisclosure})`,
      );
    }
    return queryDisclosure;
  }

  private async handle(req: IncomingMessage, res: ServerResponse, correlationId: string): Promise<void> {
    const parsed = new URL(req.url ?? "/", `http://${hostToUrlAuthority(this.host)}`);
    const pathname = parsed.pathname;

    if (this.adminConsoleEnabled && await this.handleAdminConsole(req, res, pathname)) {
      return;
    }

    if (!this.isAuthorized(req, pathname)) {
      const body = JSON.stringify({ error: "unauthorized", code: "unauthorized" });
      res.writeHead(401, {
        "content-type": "application/json; charset=utf-8",
        "www-authenticate": "Bearer",
        "x-request-id": correlationId,
      });
      res.end(body);
      return;
    }

    if (req.method === "POST" && pathname === "/mcp") {
      await this.handleMcpRequest(req, res);
      return;
    }

    if (req.method === "GET" && pathname === "/engram/v1/health") {
      this.respondJson(res, 200, await this.service.health());
      return;
    }

    if (req.method === "GET" && pathname === "/engram/v1/adapters") {
      const identity = this.resolveAdapterIdentity(req);
      this.respondJson(res, 200, {
        adaptersEnabled: this.adapterRegistry !== null,
        registered: this.adapterRegistry?.list() ?? [],
        resolved: identity,
      });
      return;
    }

    if (req.method === "POST" && pathname === "/engram/v1/recall") {
      const body = await this.readValidatedBody(req, "recall");
      // Preserve the distinction between `codingContext: null` (explicit
      // clear) and `codingContext` missing from the JSON payload
      // (untouched). The previous `?? undefined` collapsed both into
      // undefined, so callers lost the ability to clear the session's
      // attached context through the recall endpoint.
      const codingContext =
        "codingContext" in body ? body.codingContext : undefined;
      // Disclosure resolution (issue #677 PR 2/4): accept the value from
      // the validated body OR the `?disclosure=` query parameter, with
      // the body taking precedence so an explicit JSON payload is never
      // silently overridden by a stale URL.  CLAUDE.md rule 51: invalid
      // query-param values throw, never fall back silently.
      const disclosure = this.resolveRecallDisclosure(body.disclosure, parsed);
      // Issue #680 — historical recall pin (`asOf`). Body field wins
      // over `?as_of=` query param. Empty query is rejected only when
      // the body didn't supply a valid pin (codex P2 + cursor Medium).
      const asOfQueryRaw = parsed.searchParams.get("as_of");
      const bodyHasAsOf =
        typeof body.asOf === "string" && body.asOf.length > 0;
      if (
        !bodyHasAsOf &&
        asOfQueryRaw !== null &&
        asOfQueryRaw.length === 0
      ) {
        throw new EngramAccessInputError(
          "as_of must be a non-empty timestamp (got empty value)",
        );
      }
      const asOf =
        body.asOf ??
        (asOfQueryRaw !== null && asOfQueryRaw.length > 0
          ? asOfQueryRaw
          : undefined);
      // Tag filter (issue #689). Body presence wins over query params
      // — explicit `tags: []` in body clears the filter even with
      // stale `?tag=` URLs.
      const bodyHasTagsField =
        body !== null &&
        typeof body === "object" &&
        "tags" in (body as Record<string, unknown>);
      const bodyTagsValue = bodyHasTagsField
        ? (body as { tags?: unknown }).tags
        : undefined;
      const bodyTags = Array.isArray(bodyTagsValue)
        ? (bodyTagsValue as string[])
        : undefined;
      const queryTags = parsed.searchParams.getAll("tag");
      const tags = bodyHasTagsField
        ? bodyTags
        : queryTags.length > 0
          ? queryTags
          : undefined;
      const bodyTagMatch = (body as { tagMatch?: unknown }).tagMatch;
      let tagMatch: "any" | "all" | undefined;
      if (bodyTagMatch !== undefined) {
        if (bodyTagMatch === "any" || bodyTagMatch === "all") {
          tagMatch = bodyTagMatch;
        }
      } else {
        const queryTagMatch = parsed.searchParams.get("tag_match");
        if (queryTagMatch !== null) {
          if (queryTagMatch !== "any" && queryTagMatch !== "all") {
            throw new EngramAccessInputError(
              `tag_match must be one of: any, all (got: ${queryTagMatch})`,
            );
          }
          tagMatch = queryTagMatch;
        }
      }
      // Issue #681 — `?include_low_confidence=true|false` mirrors the CLI
      // `--include-low-confidence` flag. Body field wins so a JSON payload can
      // explicitly clear a stale query parameter.
      const bodyIncludeLowConfidence =
        (body as { includeLowConfidence?: unknown }).includeLowConfidence;
      const queryIncludeLowConfidence = parsed.searchParams.get("include_low_confidence");
      if (
        bodyIncludeLowConfidence === undefined &&
        queryIncludeLowConfidence !== null &&
        queryIncludeLowConfidence !== "true" &&
        queryIncludeLowConfidence !== "false"
      ) {
        throw new EngramAccessInputError(
          `include_low_confidence must be one of: true, false (got: ${queryIncludeLowConfidence})`,
        );
      }
      const includeLowConfidence =
        bodyIncludeLowConfidence === true ||
        (bodyIncludeLowConfidence === undefined &&
          queryIncludeLowConfidence === "true");
      const response = await this.service.recall({
        query: body.query ?? "",
        sessionKey: body.sessionKey,
        authenticatedPrincipal: this.resolveRequestPrincipal(req),
        idempotencyKey: body.idempotencyKey,
        namespace: this.resolveNamespace(req, body.namespace),
        topK: body.topK,
        mode: body.mode as RecallPlanMode | "auto" | undefined,
        includeDebug: body.includeDebug === true,
        // Forward the validated disclosure depth to the service layer
        // (issue #677).  The zod schema accepts/rejects body values;
        // `resolveRecallDisclosure()` validates the query-param fallback.
        disclosure,
        codingContext,
        // Forward cwd/projectTag for auto git-context resolution (issue #569).
        cwd: body.cwd,
        projectTag: body.projectTag,
        ...(asOf !== undefined ? { asOf } : {}),
        ...(tags !== undefined ? { tags } : {}),
        ...(tagMatch !== undefined ? { tagMatch } : {}),
        ...(includeLowConfidence ? { includeLowConfidence: true } : {}),
      });
      this.respondJson(res, 200, response);
      return;
    }

    // Attach / clear coding-agent context for a session (issue #569 PR 5).
    // Mirrors `setCodingContext` on the access service. Connectors call this
    // at session start after resolving a git context for the cwd; `remnic
    // doctor` (PR 8) surfaces the attached context.
    if (req.method === "POST" && pathname === "/engram/v1/coding-context") {
      const body = await this.readValidatedBody(req, "setCodingContext");
      this.service.setCodingContext({
        sessionKey: body.sessionKey,
        codingContext: body.codingContext,
      });
      this.respondJson(res, 200, { ok: true });
      return;
    }

    if (
      req.method === "POST" &&
      (pathname === "/engram/v1/capsules/export" || pathname === "/remnic/v1/capsules/export")
    ) {
      const body = await this.readValidatedBody(req, "capsuleExport");
      this.ensureWriteRateLimitAvailable();
      const result = await this.service.capsuleExport({
        name: body.name,
        namespace: this.resolveNamespace(req, body.namespace),
        principal: this.resolveRequestPrincipal(req),
        since: body.since,
        includeKinds: body.includeKinds,
        peerIds: body.peerIds,
        includeTranscripts: body.includeTranscripts,
        encrypt: body.encrypt,
      });
      this.recordWriteRateLimitHit();
      this.respondJson(res, 200, result);
      return;
    }

    if (
      req.method === "POST" &&
      (pathname === "/engram/v1/capsules/import" || pathname === "/remnic/v1/capsules/import")
    ) {
      const body = await this.readValidatedBody(req, "capsuleImport");
      this.ensureWriteRateLimitAvailable();
      const result = await this.service.capsuleImport({
        archivePath: expandTildePath(body.archivePath),
        namespace: this.resolveNamespace(req, body.namespace),
        principal: this.resolveRequestPrincipal(req),
        mode: body.mode,
      });
      this.recordWriteRateLimitHit();
      this.respondJson(res, 200, result);
      return;
    }

    if (
      req.method === "GET" &&
      (pathname === "/engram/v1/offline-sync/snapshot" || pathname === "/remnic/v1/offline-sync/snapshot")
    ) {
      const includeTranscriptsRaw = parsed.searchParams.get("include_transcripts");
      const includeContentRaw = parsed.searchParams.get("content");
      if (
        includeTranscriptsRaw !== null &&
        includeTranscriptsRaw !== "true" &&
        includeTranscriptsRaw !== "false"
      ) {
        throw new EngramAccessInputError(
          `include_transcripts must be one of: true, false (got: ${includeTranscriptsRaw})`,
        );
      }
      if (
        includeContentRaw !== null &&
        includeContentRaw !== "true" &&
        includeContentRaw !== "false"
      ) {
        throw new EngramAccessInputError(
          `content must be one of: true, false (got: ${includeContentRaw})`,
        );
      }
      const namespaceParam = parsed.searchParams.get("namespace");
      const result = await this.service.offlineSyncSnapshot({
        namespace: this.resolveNamespace(
          req,
          namespaceParam && namespaceParam.length > 0 ? namespaceParam : undefined,
        ),
        principal: this.resolveRequestPrincipal(req),
        includeTranscripts: includeTranscriptsRaw !== "false",
        includeContent: includeContentRaw !== "false",
      });
      this.respondJson(res, 200, result);
      return;
    }

    if (
      req.method === "POST" &&
      (pathname === "/engram/v1/offline-sync/files" || pathname === "/remnic/v1/offline-sync/files")
    ) {
      const body = await this.readValidatedBody(req, "offlineSyncFiles");
      const result = await this.service.offlineSyncFiles({
        namespace: this.resolveNamespace(req, body.namespace),
        principal: this.resolveRequestPrincipal(req),
        includeTranscripts: body.includeTranscripts,
        paths: body.paths,
      });
      this.respondJson(res, 200, result);
      return;
    }

    if (
      req.method === "POST" &&
      (
        pathname === "/engram/v1/offline-sync/file-content" ||
        pathname === "/remnic/v1/offline-sync/file-content"
      )
    ) {
      const body = await this.readValidatedBody(req, "offlineSyncFileContent");
      const result = await this.service.offlineSyncFileContent({
        namespace: this.resolveNamespace(req, body.namespace),
        principal: this.resolveRequestPrincipal(req),
        includeTranscripts: body.includeTranscripts,
        path: body.path,
        offset: body.offset,
        length: body.length,
      });
      this.respondBinary(res, 200, result.content, {
        "x-remnic-namespace": encodeURIComponent(result.namespace),
        "x-remnic-file-path": encodeURIComponent(result.path),
        "x-remnic-file-bytes": String(result.bytes),
        "x-remnic-file-mtime-ms": String(result.mtimeMs),
        "x-remnic-chunk-offset": String(result.offset),
        "x-remnic-chunk-bytes": String(result.chunkBytes),
        ...(result.sha256 ? { "x-remnic-file-sha256": result.sha256 } : {}),
      });
      return;
    }

    if (
      req.method === "POST" &&
      (pathname === "/engram/v1/offline-sync/apply" || pathname === "/remnic/v1/offline-sync/apply")
    ) {
      const body = await this.readValidatedBody(req, "offlineSyncApply");
      this.ensureWriteRateLimitAvailable();
      const result = await this.service.offlineSyncApply({
        namespace: this.resolveNamespace(req, body.namespace),
        principal: this.resolveRequestPrincipal(req),
        changeset: body.changeset,
      });
      this.recordWriteRateLimitHit();
      this.respondJson(res, 200, result);
      return;
    }

    if (req.method === "POST" && pathname === "/engram/v1/recall/explain") {
      const body = await this.readValidatedBody(req, "recallExplain");
      const response = await this.service.recallExplain({
        sessionKey: body.sessionKey,
        namespace: this.resolveNamespace(req, body.namespace),
      });
      this.respondJson(res, 200, response);
      return;
    }

    if (
      req.method === "POST" &&
      (pathname === "/engram/v1/action-confidence" || pathname === "/remnic/v1/action-confidence")
    ) {
      const body = await this.readValidatedBody(req, "actionConfidence");
      this.respondJson(res, 200, await this.service.actionConfidence(body));
      return;
    }

    // Tier-explain (issue #518): structured per-result annotation from
    // the direct-answer retrieval tier.  Orthogonal to /recall/explain
    // above, which returns a graph-path explanation document.
    if (req.method === "GET" && pathname === "/engram/v1/recall/tier-explain") {
      const sessionParam = parsed.searchParams.get("session");
      const sessionKey = sessionParam && sessionParam.length > 0 ? sessionParam : undefined;
      const namespaceParam = parsed.searchParams.get("namespace");
      const namespace = this.resolveNamespace(
        req,
        namespaceParam && namespaceParam.length > 0 ? namespaceParam : undefined,
      );
      const payload = await this.service.recallTierExplain(
        sessionKey,
        namespace,
        this.resolveRequestPrincipal(req),
      );
      this.respondJson(res, 200, payload);
      return;
    }

    // Recall X-ray (issue #570 PR 4): unified per-result attribution
    // snapshot.  Requires bearer auth (same as every other endpoint
    // here) and enforces namespace scope before the recall fires
    // (CLAUDE.md rule 42).  Query comes from the `q` search param so
    // GET stays cacheable; `namespace` / `session` / `budget` are
    // optional.
    if (req.method === "GET" && pathname === "/engram/v1/recall/xray") {
      const queryParam = parsed.searchParams.get("q");
      if (!queryParam || queryParam.trim().length === 0) {
        this.respondJson(res, 400, {
          error: "missing_query",
          code: "missing_query",
          message: "q search parameter is required and must be non-empty",
        });
        return;
      }
      const sessionParam = parsed.searchParams.get("session");
      const sessionKey = sessionParam && sessionParam.length > 0
        ? sessionParam
        : undefined;
      const namespaceParam = parsed.searchParams.get("namespace");
      const namespace = this.resolveNamespace(
        req,
        namespaceParam && namespaceParam.length > 0
          ? namespaceParam
          : undefined,
      );
      const budgetParam = parsed.searchParams.get("budget");
      // Reject invalid `budget` with 400 rather than silently
      // defaulting (CLAUDE.md rules 14 + 51).
      let budget: number | undefined;
      if (budgetParam !== null && budgetParam !== "") {
        const parsedBudget = Number(budgetParam);
        if (
          !Number.isFinite(parsedBudget)
          || parsedBudget <= 0
          || !Number.isInteger(parsedBudget)
        ) {
          this.respondJson(res, 400, {
            error: "invalid_budget",
            code: "invalid_budget",
            message:
              "budget expects a positive integer",
          });
          return;
        }
        budget = parsedBudget;
      }
      // Disclosure depth (issue #677 PR 3/4 telemetry plumbing).  When
      // present, must match the chunk|section|raw allow-list; invalid
      // values surface as a 400 (CLAUDE.md rule 51 — no silent
      // fallback) rather than silently disabling the per-disclosure
      // summary table.
      const disclosureParam = parsed.searchParams.get("disclosure");
      let disclosure: RecallDisclosure | undefined;
      if (disclosureParam !== null && disclosureParam.length > 0) {
        if (!isRecallDisclosure(disclosureParam)) {
          this.respondJson(res, 400, {
            error: "invalid_disclosure",
            code: "invalid_disclosure",
            message:
              "disclosure must be one of: chunk, section, raw",
          });
          return;
        }
        disclosure = disclosureParam;
      }
      // Only translate validation errors (empty query, bad budget)
      // into 400s.  Backend faults (timeouts, storage errors,
      // unexpected orchestrator failures) must bubble to the global
      // `handle()` error handler so they return 500 and get logged
      // properly.  `service.recallXray` prefixes its validation
      // errors with "recallXray:" so we key off that prefix rather
      // than catching everything.
      let payload: Awaited<ReturnType<typeof this.service.recallXray>>;
      try {
        payload = await this.service.recallXray({
          query: queryParam,
          sessionKey,
          namespace,
          budget,
          authenticatedPrincipal: this.resolveRequestPrincipal(req),
          ...(disclosure !== undefined ? { disclosure } : {}),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.startsWith("recallXray:")) {
          this.respondJson(res, 400, {
            error: "invalid_request",
            code: "invalid_request",
            message,
          });
          return;
        }
        // Anything else is a server-side fault; rethrow so the
        // outer `handle()` catch returns 500 + logs the error.
        throw err;
      }
      this.respondJson(res, 200, payload);
      return;
    }

    if (req.method === "POST" && pathname === "/engram/v1/observe") {
      const body = await this.readValidatedBody(req, "observe");
      this.ensureWriteRateLimitAvailable();
      const response = await this.service.observe({
        sessionKey: body.sessionKey,
        messages: body.messages.map((message) => ({
          role: message.role,
          content: message.content,
          sourceFormat: message.sourceFormat ?? undefined,
          rawContent: message.rawContent ?? undefined,
          parts: message.parts ?? undefined,
        })),
        namespace: this.resolveNamespace(req, body.namespace),
        authenticatedPrincipal: this.resolveRequestPrincipal(req),
        skipExtraction: body.skipExtraction === true,
        // Forward cwd/projectTag for auto git-context resolution (issue #569).
        cwd: body.cwd,
        projectTag: body.projectTag,
      });
      this.recordWriteRateLimitHit();
      this.respondJson(res, 202, response);
      return;
    }

    if (req.method === "POST" && pathname === "/engram/v1/lcm/search") {
      const body = await this.readValidatedBody(req, "lcmSearch");
      const response = await this.service.lcmSearch({
        query: body.query,
        sessionKey: body.sessionKey,
        namespace: this.resolveNamespace(req, body.namespace),
        authenticatedPrincipal: this.resolveRequestPrincipal(req),
        limit: body.limit,
      });
      this.respondJson(res, 200, response);
      return;
    }

    if (
      req.method === "POST" &&
      (pathname === "/engram/v1/lcm/compaction/flush" || pathname === "/remnic/v1/lcm/compaction/flush")
    ) {
      const body = await this.readValidatedBody(req, "lcmCompactionFlush");
      this.ensureWriteRateLimitAvailable();
      const response = await this.service.lcmCompactionFlush({
        sessionKey: body.sessionKey,
        namespace: this.resolveNamespace(req, body.namespace),
        authenticatedPrincipal: this.resolveRequestPrincipal(req),
      });
      this.recordWriteRateLimitHit();
      this.respondJson(res, 200, response);
      return;
    }

    if (
      req.method === "POST" &&
      (pathname === "/engram/v1/lcm/compaction/record" || pathname === "/remnic/v1/lcm/compaction/record")
    ) {
      const body = await this.readValidatedBody(req, "lcmCompactionRecord");
      this.ensureWriteRateLimitAvailable();
      const response = await this.service.lcmCompactionRecord({
        sessionKey: body.sessionKey,
        namespace: this.resolveNamespace(req, body.namespace),
        tokensBefore: body.tokensBefore,
        tokensAfter: body.tokensAfter,
        authenticatedPrincipal: this.resolveRequestPrincipal(req),
      });
      this.recordWriteRateLimitHit();
      this.respondJson(res, 200, response);
      return;
    }

    if (req.method === "GET" && pathname === "/engram/v1/lcm/status") {
      this.respondJson(res, 200, await this.service.lcmStatus());
      return;
    }

    if (req.method === "POST" && pathname === "/engram/v1/memories") {
      const body = await this.readValidatedBody(req, "memoryStore");
      const request = {
        schemaVersion: body.schemaVersion,
        idempotencyKey: body.idempotencyKey,
        dryRun: body.dryRun === true,
        sessionKey: body.sessionKey,
        authenticatedPrincipal: this.resolveRequestPrincipal(req),
        content: body.content,
        category: body.category,
        confidence: body.confidence,
        namespace: this.resolveNamespace(req, body.namespace),
        tags: body.tags,
        entityRef: body.entityRef,
        ttl: body.ttl,
        sourceReason: body.sourceReason,
      };
      const idempotencyStatus = await this.service.peekMemoryStoreIdempotency(request);
      if (idempotencyStatus === "miss" && request.dryRun !== true) {
        this.ensureWriteRateLimitAvailable();
      }
      const response = await this.service.memoryStore(request);
      if (this.shouldCountWriteRateLimit(response as { dryRun?: boolean; idempotencyReplay?: boolean })) {
        this.recordWriteRateLimitHit();
      }
      this.respondJson(res, this.writeResponseStatus(response), response);
      return;
    }

    if (req.method === "POST" && pathname === "/engram/v1/suggestions") {
      const body = await this.readValidatedBody(req, "suggestionSubmit");
      const request = {
        schemaVersion: body.schemaVersion,
        idempotencyKey: body.idempotencyKey,
        dryRun: body.dryRun === true,
        sessionKey: body.sessionKey,
        authenticatedPrincipal: this.resolveRequestPrincipal(req),
        content: body.content,
        category: body.category,
        confidence: body.confidence,
        namespace: this.resolveNamespace(req, body.namespace),
        tags: body.tags,
        entityRef: body.entityRef,
        ttl: body.ttl,
        sourceReason: body.sourceReason,
      };
      const idempotencyStatus = await this.service.peekSuggestionSubmitIdempotency(request);
      if (idempotencyStatus === "miss" && request.dryRun !== true) {
        this.ensureWriteRateLimitAvailable();
      }
      const response = await this.service.suggestionSubmit(request);
      if (this.shouldCountWriteRateLimit(response as { dryRun?: boolean; idempotencyReplay?: boolean })) {
        this.recordWriteRateLimitHit();
      }
      this.respondJson(res, this.writeResponseStatus(response), response);
      return;
    }

    if (req.method === "GET" && pathname === "/engram/v1/memories") {
      const limitRaw = parseInt(parsed.searchParams.get("limit") ?? "50", 10);
      const offsetRaw = parseInt(parsed.searchParams.get("offset") ?? "0", 10);
      const sortParam = parsed.searchParams.get("sort") ?? undefined;
      const sort = sortParam === "updated_desc"
        || sortParam === "updated_asc"
        || sortParam === "created_desc"
        || sortParam === "created_asc"
        ? sortParam
        : undefined;
      const response = await this.service.memoryBrowse({
        query: parsed.searchParams.get("q") ?? undefined,
        status: parsed.searchParams.get("status") ?? undefined,
        category: parsed.searchParams.get("category") ?? undefined,
        namespace: parsed.searchParams.get("namespace") ?? undefined,
        authenticatedPrincipal: this.resolveRequestPrincipal(req),
        sort,
        limit: Number.isFinite(limitRaw) ? limitRaw : 50,
        offset: Number.isFinite(offsetRaw) ? offsetRaw : 0,
      });
      this.respondJson(res, 200, response);
      return;
    }

    const memoryMatch = pathname.match(/^\/engram\/v1\/memories\/([^/]+)$/);
    if (req.method === "GET" && memoryMatch) {
      const memoryId = decodeURIComponent(memoryMatch[1] ?? "");
      const namespace = parsed.searchParams.get("namespace") ?? undefined;
      const response = await this.service.memoryGet(memoryId, namespace, this.resolveRequestPrincipal(req));
      this.respondJson(res, response.found ? 200 : 404, response);
      return;
    }

    const timelineMatch = pathname.match(/^\/engram\/v1\/memories\/([^/]+)\/timeline$/);
    if (req.method === "GET" && timelineMatch) {
      const memoryId = decodeURIComponent(timelineMatch[1] ?? "");
      const namespace = parsed.searchParams.get("namespace") ?? undefined;
      const limitRaw = parseInt(parsed.searchParams.get("limit") ?? "200", 10);
      const limit = Number.isFinite(limitRaw) ? limitRaw : 200;
      const response = await this.service.memoryTimeline(memoryId, namespace, limit, this.resolveRequestPrincipal(req));
      this.respondJson(res, response.found ? 200 : 404, response);
      return;
    }

    if (req.method === "GET" && pathname === "/engram/v1/entities") {
      const limitRaw = parseInt(parsed.searchParams.get("limit") ?? "50", 10);
      const offsetRaw = parseInt(parsed.searchParams.get("offset") ?? "0", 10);
      const response = await this.service.entityList({
        namespace: parsed.searchParams.get("namespace") ?? undefined,
        query: parsed.searchParams.get("q") ?? undefined,
        limit: Number.isFinite(limitRaw) ? limitRaw : 50,
        offset: Number.isFinite(offsetRaw) ? offsetRaw : 0,
      });
      this.respondJson(res, 200, response);
      return;
    }

    const entityMatch = pathname.match(/^\/engram\/v1\/entities\/([^/]+)$/);
    if (req.method === "GET" && entityMatch) {
      const entityName = decodeURIComponent(entityMatch[1] ?? "");
      const namespace = parsed.searchParams.get("namespace") ?? undefined;
      const response = await this.service.entityGet(entityName, namespace);
      this.respondJson(res, response.found ? 200 : 404, response);
      return;
    }

    if (req.method === "GET" && pathname === "/engram/v1/review-queue") {
      const response = await this.service.reviewQueue(
        parsed.searchParams.get("runId") ?? undefined,
        parsed.searchParams.get("namespace") ?? undefined,
        this.resolveRequestPrincipal(req),
      );
      this.respondJson(res, 200, response);
      return;
    }

    if (req.method === "GET" && pathname === "/engram/v1/maintenance") {
      this.respondJson(res, 200, await this.service.maintenance(parsed.searchParams.get("namespace") ?? undefined, this.resolveRequestPrincipal(req)));
      return;
    }

    if (req.method === "GET" && pathname === "/engram/v1/quality") {
      this.respondJson(res, 200, await this.service.quality(parsed.searchParams.get("namespace") ?? undefined, this.resolveRequestPrincipal(req)));
      return;
    }

    if (req.method === "GET" && pathname === "/engram/v1/trust-zones/status") {
      this.respondJson(
        res,
        200,
        await this.service.trustZoneStatus(parsed.searchParams.get("namespace") ?? undefined, this.resolveRequestPrincipal(req)),
      );
      return;
    }

    // Procedural memory stats (issue #567 PR 5/5). Read-only; namespace is
    // scoped via the same resolver used by recall/trust-zones so cross-
    // tenant reads aren't possible (CLAUDE.md rule 42).
    if (req.method === "GET" && pathname === "/engram/v1/procedural/stats") {
      const namespaceParam = parsed.searchParams.get("namespace");
      this.respondJson(
        res,
        200,
        await this.service.procedureStats(
          {
            namespace: this.resolveNamespace(
              req,
              namespaceParam && namespaceParam.length > 0
                ? namespaceParam
                : undefined,
            ),
          },
          this.resolveRequestPrincipal(req),
        ),
      );
      return;
    }

    if (req.method === "GET" && pathname === "/engram/v1/trust-zones/records") {
      const limitRaw = parseInt(parsed.searchParams.get("limit") ?? "25", 10);
      const offsetRaw = parseInt(parsed.searchParams.get("offset") ?? "0", 10);
      const response = await this.service.trustZoneBrowse({
        query: parsed.searchParams.get("q") ?? undefined,
        zone: parseTrustZoneFilter(parsed.searchParams.get("zone")),
        kind: parseTrustZoneKindFilter(parsed.searchParams.get("kind")),
        sourceClass: parseTrustZoneSourceClassFilter(parsed.searchParams.get("sourceClass")),
        namespace: parsed.searchParams.get("namespace") ?? undefined,
        limit: Number.isFinite(limitRaw) ? limitRaw : 25,
        offset: Number.isFinite(offsetRaw) ? offsetRaw : 0,
      }, this.resolveRequestPrincipal(req));
      this.respondJson(res, 200, response);
      return;
    }

    if (req.method === "POST" && pathname === "/engram/v1/review-disposition") {
      const body = await this.readValidatedBody(req, "reviewDisposition");
      this.ensureWriteRateLimitAvailable();
      const response = await this.service.reviewDisposition({
        memoryId: body.memoryId,
        status: body.status,
        reasonCode: body.reasonCode,
        namespace: this.resolveNamespace(req, body.namespace),
        authenticatedPrincipal: this.resolveRequestPrincipal(req),
      });
      if (this.shouldCountWriteRateLimit(response as unknown as { dryRun?: boolean; idempotencyReplay?: boolean })) {
        this.recordWriteRateLimitHit();
      }
      this.respondJson(res, 200, response);
      return;
    }

    if (req.method === "POST" && pathname === "/engram/v1/trust-zones/promote") {
      const body = await this.readValidatedBody(req, "trustZonePromote");
      const dryRun = body.dryRun === true;
      if (!dryRun) {
        this.ensureWriteRateLimitAvailable();
      }
      const response = await this.service.trustZonePromote({
        recordId: body.recordId,
        targetZone: body.targetZone,
        promotionReason: body.promotionReason,
        recordedAt: body.recordedAt,
        summary: body.summary,
        dryRun,
        namespace: this.resolveNamespace(req, body.namespace),
        authenticatedPrincipal: this.resolveRequestPrincipal(req),
      });
      if (this.shouldCountWriteRateLimit(response as unknown as { dryRun?: boolean; idempotencyReplay?: boolean })) {
        this.recordWriteRateLimitHit();
      }
      this.respondJson(res, response.dryRun ? 200 : 201, response);
      return;
    }

    if (req.method === "POST" && pathname === "/engram/v1/trust-zones/demo-seed") {
      const body = await this.readValidatedBody(req, "trustZoneDemoSeed");
      const dryRun = body.dryRun === true;
      if (!dryRun) {
        this.ensureWriteRateLimitAvailable();
      }
      const response = await this.service.trustZoneDemoSeed({
        scenario: body.scenario,
        recordedAt: body.recordedAt,
        dryRun,
        namespace: this.resolveNamespace(req, body.namespace),
        authenticatedPrincipal: this.resolveRequestPrincipal(req),
      });
      if (this.shouldCountWriteRateLimit(response as unknown as { dryRun?: boolean; idempotencyReplay?: boolean })) {
        this.recordWriteRateLimitHit();
      }
      this.respondJson(res, response.dryRun ? 200 : 201, response);
      return;
    }

    // Citation usage tracking (issue #379)
    if (req.method === "POST" && pathname === "/v1/citations/observed") {
      const body = await this.readJsonBody(req);
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        throw new HttpError(400, "request body must be a JSON object", "invalid_body");
      }
      const payload = body as Record<string, unknown>;
      const sessionId = typeof payload.sessionId === "string" ? payload.sessionId : undefined;
      const namespace = typeof payload.namespace === "string" ? payload.namespace : undefined;
      const citationsRaw = payload.citations;
      if (!citationsRaw || typeof citationsRaw !== "object" || Array.isArray(citationsRaw)) {
        throw new HttpError(400, "citations must be a JSON object with entries and rolloutIds", "invalid_citations");
      }
      const citObj = citationsRaw as Record<string, unknown>;
      const entries: CitationEntry[] = [];
      if (Array.isArray(citObj.entries)) {
        for (const raw of citObj.entries) {
          if (raw && typeof raw === "object" && !Array.isArray(raw)) {
            const e = raw as Record<string, unknown>;
            if (
              typeof e.path === "string" &&
              typeof e.lineStart === "number" &&
              typeof e.lineEnd === "number"
            ) {
              entries.push({
                path: e.path,
                lineStart: e.lineStart,
                lineEnd: e.lineEnd,
                note: typeof e.note === "string" ? e.note : "",
              });
            }
          }
        }
      }
      const rolloutIds: string[] = [];
      if (Array.isArray(citObj.rolloutIds)) {
        for (const id of citObj.rolloutIds) {
          if (typeof id === "string" && id.length > 0) {
            rolloutIds.push(id);
          }
        }
      }

      // Record usage: for each citation entry, try to increment usage on the
      // matching memory. The service exposes recordAccess for this purpose.
      // Pass authenticatedPrincipal so namespace ACL checks use the same
      // identity resolution as other write endpoints (Finding #1, issue #379).
      let matched = 0;
      let submitted = 0;
      if (typeof this.service.recordCitationUsage === "function") {
        const result = await this.service.recordCitationUsage({
          sessionId,
          namespace: this.resolveNamespace(req, namespace),
          authenticatedPrincipal: this.resolveRequestPrincipal(req),
          entries,
          rolloutIds,
        });
        submitted = result.submitted;
        matched = result.matched;
      }

      this.respondJson(res, 200, {
        ok: true,
        submitted,
        matched,
        entriesReceived: entries.length,
        rolloutIdsReceived: rolloutIds.length,
      });
      return;
    }

    // ── Contradiction Review (issue #520) ─────────────────────────────────────
    if (req.method === "GET" && pathname === "/engram/v1/review/contradictions") {
      const VALID_FILTERS = new Set(["all", "unresolved", "contradicts", "independent", "duplicates", "needs-user"]);
      const rawFilter = parsed.searchParams.get("filter") ?? "unresolved";
      if (!VALID_FILTERS.has(rawFilter)) {
        this.respondJson(res, 400, { error: `Invalid filter '${rawFilter}'. Valid: ${[...VALID_FILTERS].join(", ")}` });
        return;
      }
      const namespace = parsed.searchParams.get("namespace") ?? undefined;
      const limitRaw = parseInt(parsed.searchParams.get("limit") ?? "50", 10);
      const {
        isDefaultReviewNamespace,
        listPairs,
      } = await import("./contradiction/contradiction-review.js");
      const principal = this.resolveRequestPrincipal(req);
      const resolved = await this.service.getReadableStorageForNamespace(namespace, principal);
      const reviewNamespace = this.service.configRef.namespacesEnabled ? resolved.namespace : undefined;
      const includeUnscopedForNamespace = Boolean(
        reviewNamespace && isDefaultReviewNamespace(this.service.configRef.defaultNamespace, namespace, reviewNamespace),
      );
      const result = listPairs(this.service.memoryDir, {
        filter: rawFilter as "all" | "unresolved" | "contradicts" | "independent" | "duplicates" | "needs-user",
        namespace: reviewNamespace,
        includeUnscopedForNamespace,
        limit: Number.isFinite(limitRaw) ? limitRaw : 50,
      });
      this.respondJson(res, 200, result);
      return;
    }

    if (req.method === "GET" && pathname.startsWith("/engram/v1/review/contradictions/")) {
      const pairId = pathname.split("/").pop() ?? "";
      const { readPair } = await import("./contradiction/contradiction-review.js");
      const pair = readPair(this.service.memoryDir, pairId);
      if (!pair) {
        this.respondJson(res, 404, { error: "pair_not_found" });
        return;
      }
      try {
        await this.service.getReadableStorageForNamespace(pair.namespace, this.resolveRequestPrincipal(req));
      } catch {
        this.respondJson(res, 404, { error: "pair_not_found" });
        return;
      }
      this.respondJson(res, 200, pair);
      return;
    }

    if (req.method === "POST" && pathname === "/engram/v1/review/resolve") {
      const body = await this.readJsonBody(req) as Record<string, unknown>;
      const pairId = typeof body.pairId === "string" ? body.pairId : "";
      const verb = typeof body.verb === "string" ? body.verb : "";
      if (!pairId || !verb) {
        this.respondJson(res, 400, { error: "pairId and verb are required" });
        return;
      }
      const { isValidResolutionVerb, executeResolution } = await import("./contradiction/resolution.js");
      if (!isValidResolutionVerb(verb)) {
        this.respondJson(res, 400, { error: `Invalid verb: ${verb}. Must be one of: keep-a, keep-b, merge, both-valid, needs-more-context` });
        return;
      }
      const principal = this.resolveRequestPrincipal(req);
      const result = await executeResolution(this.service.memoryDir, this.service.storageRef, pairId, verb, {
        mergedMemoryId: typeof body.mergedMemoryId === "string" ? body.mergedMemoryId : undefined,
        mergedContent: typeof body.mergedContent === "string" ? body.mergedContent : undefined,
        storageForNamespace: async (namespace) => {
          const resolved = await this.service.getWritableStorageForNamespace(namespace, principal);
          return resolved.storage;
        },
      });
      this.respondJson(res, 200, result);
      return;
    }

    // Graph snapshot (issue #691 PR 2/5) — read-only adjacency view used by
    // the admin-pane scaffold shipped in PR 1/5.  All filters are query
    // params so the surface stays cacheable; invalid values yield 400 with
    // a descriptive body (CLAUDE.md rule 51 — never silently default).
    if (req.method === "GET" && pathname === "/engram/v1/graph/snapshot") {
      const limitRaw = parsed.searchParams.get("limit");
      let limit: number | undefined;
      if (limitRaw !== null && limitRaw.length > 0) {
        const parsedLimit = Number(limitRaw);
        if (
          !Number.isFinite(parsedLimit)
          || !Number.isInteger(parsedLimit)
          || parsedLimit <= 0
        ) {
          this.respondJson(res, 400, {
            error: "invalid_limit",
            code: "invalid_limit",
            message: "limit must be a positive integer",
          });
          return;
        }
        limit = parsedLimit;
      }
      const sinceRaw = parsed.searchParams.get("since");
      let since: string | undefined;
      if (sinceRaw !== null && sinceRaw.length > 0) {
        // Validate up-front so the access service can stay focused on the
        // pure snapshot logic (parser also runs there as a defense in
        // depth, but rejecting at the boundary preserves the
        // "invalid_since" error code instead of leaking a generic 500).
        if (!Number.isFinite(Date.parse(sinceRaw))) {
          this.respondJson(res, 400, {
            error: "invalid_since",
            code: "invalid_since",
            message: "since must be a parseable ISO timestamp",
          });
          return;
        }
        since = sinceRaw;
      }
      const focusNodeIdRaw = parsed.searchParams.get("focusNodeId");
      const focusNodeId = focusNodeIdRaw && focusNodeIdRaw.length > 0
        ? focusNodeIdRaw
        : undefined;
      const categoriesRaw = parsed.searchParams.get("categories");
      let categories: string[] | undefined;
      if (categoriesRaw !== null && categoriesRaw.length > 0) {
        categories = categoriesRaw
          .split(",")
          .map((value) => value.trim())
          .filter((value) => value.length > 0);
        if (categories.length === 0) {
          this.respondJson(res, 400, {
            error: "invalid_categories",
            code: "invalid_categories",
            message:
              "categories must be a comma-separated list with at least one non-empty value",
          });
          return;
        }
      }
      const namespaceParam = parsed.searchParams.get("namespace");
      const namespace = this.resolveNamespace(
        req,
        namespaceParam && namespaceParam.length > 0 ? namespaceParam : undefined,
      );
      try {
        const snapshot = await this.service.graphSnapshot(
          {
            namespace,
            ...(limit !== undefined ? { limit } : {}),
            ...(since !== undefined ? { since } : {}),
            ...(focusNodeId !== undefined ? { focusNodeId } : {}),
            ...(categories !== undefined ? { categories } : {}),
          },
          this.resolveRequestPrincipal(req),
        );
        this.respondJson(res, 200, snapshot);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.startsWith("graphSnapshot:")) {
          this.respondJson(res, 400, {
            error: "invalid_request",
            code: "invalid_request",
            message,
          });
          return;
        }
        throw err;
      }
      return;
    }

    if (req.method === "POST" && pathname === "/engram/v1/contradiction-scan") {
      const body = await this.readJsonBody(req) as Record<string, unknown>;
      const { runContradictionScan } = await import("./contradiction/contradiction-scan.js");
      const principal = this.resolveRequestPrincipal(req);
      const result = await runContradictionScan({
        storage: this.service.storageRef,
        config: this.service.configRef,
        memoryDir: this.service.memoryDir,
        embeddingLookupFactory: this.service.embeddingLookupFactoryRef,
        storageForNamespace: (namespace) =>
          this.service.getWritableStorageForNamespace(namespace, principal),
        localLlm: this.service.localLlmRef,
        fallbackLlm: this.service.fallbackLlmRef,
        namespace: typeof body.namespace === "string" ? body.namespace : undefined,
      });
      this.respondJson(res, 200, result);
      return;
    }

    // ── Graph mutation event stream (issue #691 PR 5/5) ──────────────────────
    //
    // GET /engram/v1/graph/events
    //
    // Server-Sent Events stream that emits graph mutation events in real time.
    // Event types: node-added, node-updated, edge-added, edge-updated, edge-removed.
    //
    // Auth: same Bearer token scheme as every other endpoint (checked above).
    //
    // The SSE handler subscribes to the in-process graph event bus for the
    // resolved memory dir.  Events are batched within a 200 ms window so a
    // burst of writes (e.g. extraction of a large turn) doesn't overwhelm
    // the admin UI canvas with individual re-renders.
    //
    // The client receives a `data: <json>\n\n` line per batch.  Each batch
    // payload is { events: GraphEvent[] }.
    //
    // The stream sends a heartbeat `data: {"type":"heartbeat"}\n\n` every
    // 25 s so load balancers and proxies don't time out idle connections.
    if (req.method === "GET" && pathname === "/engram/v1/graph/events") {
      await this.handleGraphEventsSSE(req, res);
      return;
    }

    // ── Peer Registry endpoints (issue #679) ─────────────────────────────────
    // GET /engram/v1/console/state — operator console engine-state snapshot (issue #688 PR 2/3).
    // Read-only; namespace-aware via resolveRequestPrincipal so cross-tenant
    // reads are not possible (CLAUDE.md rule 42).
    if (req.method === "GET" && pathname === "/engram/v1/console/state") {
      const namespace = parsed.searchParams.get("namespace") ?? undefined;
      const snapshot = await this.service.consoleState(namespace, this.resolveRequestPrincipal(req));
      this.respondJson(res, 200, snapshot);
      return;
    }

    //   GET    /engram/v1/peers              — list all peers
    //   GET    /engram/v1/peers/:id          — get one peer
    //   PUT    /engram/v1/peers/:id          — upsert (create/update)
    //   DELETE /engram/v1/peers/:id          — delete identity only (idempotent)
    //   DELETE /engram/v1/peers/:id?forget=true — destructive full purge (issue #679 completion)
    //   GET    /engram/v1/peers/:id/profile  — get peer profile
    if (req.method === "GET" && pathname === "/engram/v1/peers") {
      const result = await this.service.peerList();
      this.respondJson(res, 200, result);
      return;
    }

    const peerProfileMatch = /^\/engram\/v1\/peers\/([^/]+)\/profile$/.exec(pathname);
    if (peerProfileMatch) {
      if (req.method !== "GET") {
        this.respondJson(res, 405, { error: "method_not_allowed", code: "method_not_allowed" });
        return;
      }
      const peerId = decodePeerIdSegment(peerProfileMatch[1] ?? "");
      const result = await this.service.peerProfileGet(peerId);
      if (!result.found) {
        this.respondJson(res, 404, { error: "peer_profile_not_found", code: "peer_profile_not_found" });
        return;
      }
      this.respondJson(res, 200, result);
      return;
    }

    const peerIdMatch = /^\/engram\/v1\/peers\/([^/]+)$/.exec(pathname);
    if (peerIdMatch) {
      const peerId = decodePeerIdSegment(peerIdMatch[1] ?? "");

      if (req.method === "GET") {
        const result = await this.service.peerGet(peerId);
        if (!result.found) {
          this.respondJson(res, 404, { error: "peer_not_found", code: "peer_not_found" });
          return;
        }
        this.respondJson(res, 200, result);
        return;
      }

      if (req.method === "PUT") {
        const body = await this.readJsonBody(req) as Record<string, unknown>;
        // Reject malformed types up front rather than silently dropping them
        // to undefined and letting peerSet fall back to defaults
        // (CLAUDE.md rule 51: no silent defaults on bad input).
        if ("kind" in body && body.kind !== undefined && typeof body.kind !== "string") {
          throw new EngramAccessInputError("kind must be a string when provided");
        }
        if (
          "displayName" in body &&
          body.displayName !== undefined &&
          typeof body.displayName !== "string"
        ) {
          throw new EngramAccessInputError("displayName must be a string when provided");
        }
        if ("notes" in body && body.notes !== undefined && typeof body.notes !== "string") {
          throw new EngramAccessInputError("notes must be a string when provided");
        }
        const result = await this.service.peerSet({
          id: peerId,
          kind: typeof body.kind === "string" ? body.kind : undefined,
          displayName: typeof body.displayName === "string" ? body.displayName : undefined,
          notes: typeof body.notes === "string" ? body.notes : undefined,
        });
        this.respondJson(res, result.created ? 201 : 200, result);
        return;
      }

      if (req.method === "DELETE") {
        // `?forget=true` triggers the destructive full-purge path (issue #679
        // completion). The caller must also pass `confirm=yes` in the request
        // body; absent confirmation yields 400. Plain DELETE (no ?forget) keeps
        // the existing soft-delete behaviour (identity.md only).
        const forgetParam = parsed.searchParams.get("forget");
        if (forgetParam === "true") {
          const body = await this.readJsonBody(req) as Record<string, unknown>;
          const confirm = typeof body.confirm === "string" ? body.confirm : "";
          if (confirm !== "yes") {
            this.respondJson(res, 400, {
              error: "confirm_required",
              code: "confirm_required",
              message: "DELETE ?forget=true requires { confirm: 'yes' } in the request body",
            });
            return;
          }
          const result = await this.service.peerForget(peerId, { confirm: "yes" });
          this.respondJson(res, 200, result);
          return;
        }
        const result = await this.service.peerDelete(peerId);
        this.respondJson(res, 200, result);
        return;
      }

      this.respondJson(res, 405, { error: "method_not_allowed", code: "method_not_allowed" });
      return;
    }

    // ── Dreams telemetry (issue #678 PR 3+4) ──────────────────────────────────

    if (req.method === "GET" && pathname === "/engram/v1/dreams/status") {
      const { normalizeDreamsStatusWindowHours } = await import("./maintenance/dreams-ledger.js");
      const windowHoursRaw = parsed.searchParams.get("windowHours");
      let windowHours: number;
      try {
        windowHours = normalizeDreamsStatusWindowHours(
          windowHoursRaw !== null ? Number(windowHoursRaw) : undefined,
        );
      } catch {
        this.respondJson(res, 400, { error: "windowHours must be a positive integer" });
        return;
      }
      const namespaceParam = parsed.searchParams.get("namespace");
      const namespace = namespaceParam && namespaceParam.length > 0 ? namespaceParam : undefined;
      const result = await this.service.dreamsStatus({
        windowHours,
        namespace,
        principal: this.resolveRequestPrincipal(req),
      });
      this.respondJson(res, 200, result);
      return;
    }

    if (req.method === "POST" && pathname === "/engram/v1/dreams/run") {
      const body = await this.readJsonBody(req) as Record<string, unknown>;
      const VALID_PHASES = ["lightSleep", "rem", "deepSleep"] as const;
      const phase = typeof body.phase === "string" ? body.phase : undefined;
      if (!phase || !(VALID_PHASES as readonly string[]).includes(phase)) {
        this.respondJson(res, 400, {
          error: `phase is required and must be one of: ${VALID_PHASES.join(", ")}`,
        });
        return;
      }
      if (
        "dryRun" in body &&
        body.dryRun !== undefined &&
        typeof body.dryRun !== "boolean"
      ) {
        this.respondJson(res, 400, {
          error: "dryRun must be a boolean when provided",
        });
        return;
      }
      if (
        "namespace" in body &&
        body.namespace !== undefined &&
        typeof body.namespace !== "string"
      ) {
        this.respondJson(res, 400, {
          error: "namespace must be a string when provided",
        });
        return;
      }
      const dryRun = body.dryRun === true;
      const namespace =
        typeof body.namespace === "string" ? body.namespace : undefined;
      if (!dryRun) {
        this.ensureWriteRateLimitAvailable();
      }
      const result = await this.service.dreamsRun({
        phase: phase as import("./types.js").DreamsPhase,
        dryRun,
        namespace,
        authenticatedPrincipal: this.resolveRequestPrincipal(req),
      });
      if (this.shouldCountWriteRateLimit(result as { dryRun?: boolean; idempotencyReplay?: boolean })) {
        this.recordWriteRateLimitHit();
      }
      this.respondJson(res, 200, result);
      return;
    }

    this.respondJson(res, 404, { error: "not_found", code: "not_found" });
  }

  /**
   * SSE handler for /engram/v1/graph/events.
   *
   * Lifecycle:
   *  1. Write SSE headers (Content-Type: text/event-stream).
   *  2. Register this response in `sseClients`.
   *  3. Resolve the namespace from the request and subscribe to THAT
   *     namespace's graph event bus (Codex P1: in multi-namespace
   *     deployments each namespace has its own bus keyed by its storage
   *     dir — subscribing to the global root leaks events across tenants).
   *  4. On each event, add to a 200 ms batch; flush batch as a single SSE frame.
   *  5. Send heartbeat every 25 s.
   *  6. On client disconnect (req "close"), clean up timers and unsubscribe.
   *  7. Register the cleanup callback in `sseCleanupFns` so `stop()` can
   *     release the heartbeat interval and bus subscription even when the
   *     client never disconnects (Cursor review thread `access-http.ts:232`).
   */
  private async handleGraphEventsSSE(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Resolve namespace from the ?namespace= query parameter (same pattern
    // as graphSnapshot and other read endpoints).  Falls back to the
    // default namespace when absent.
    const parsed = new URL(req.url ?? "/", `http://${hostToUrlAuthority(this.host)}`);
    const namespaceParam = parsed.searchParams.get("namespace");
    const namespace = namespaceParam && namespaceParam.length > 0 ? namespaceParam : undefined;
    // Resolve to the per-namespace storage directory so the bus subscription
    // is scoped to the correct tenant (CLAUDE.md rule 42).
    // Pass the request principal so namespace ACL is enforced — without it,
    // resolveReadableNamespace throws when namespacesEnabled=true (Cursor
    // thread PRRT_kwDORJXyws59snoR / Codex thread PRRT_kwDORJXyws59soGJ).
    const principal = this.resolveRequestPrincipal(req);
    const memoryDir = await this.service.getMemoryDirForNamespace(namespace, principal);

    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-store, must-revalidate",
      "connection": "keep-alive",
      "x-accel-buffering": "no",     // prevent nginx buffering
      "transfer-encoding": "chunked",
    });

    // Send initial "connected" frame so the client knows the stream is live.
    const writeSSE = (payload: unknown): void => {
      try {
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      } catch {
        // client already gone — cleanup will fire via "close"
      }
    };

    writeSSE({ type: "connected" });

    this.sseClients.add(res);

    // --- 200 ms batch throttle -----------------------------------------------
    const flushBatch = (): void => {
      const batch = this.ssePendingBatches.get(res);
      if (!batch || batch.length === 0) return;
      this.ssePendingBatches.delete(res);
      this.sseBatchTimers.delete(res);
      writeSSE({ type: "batch", events: batch });
    };

    const unsubscribe = subscribeGraphEvents(memoryDir, (event: GraphEvent) => {
      let batch = this.ssePendingBatches.get(res);
      if (!batch) {
        batch = [];
        this.ssePendingBatches.set(res, batch);
      }
      batch.push(event);
      if (!this.sseBatchTimers.has(res)) {
        this.sseBatchTimers.set(res, setTimeout(flushBatch, 200));
      }
    });

    // --- 25 s heartbeat -------------------------------------------------------
    const heartbeatInterval = setInterval(() => {
      writeSSE({ type: "heartbeat" });
    }, 25_000);

    // --- Cleanup on client disconnect -----------------------------------------
    const cleanup = (): void => {
      clearInterval(heartbeatInterval);
      const timer = this.sseBatchTimers.get(res);
      if (timer !== undefined) {
        clearTimeout(timer);
        this.sseBatchTimers.delete(res);
      }
      this.ssePendingBatches.delete(res);
      unsubscribe();
      this.sseClients.delete(res);
      this.sseCleanupFns.delete(cleanup);
      try { res.end(); } catch { /* ignore */ }
    };

    // Register so stop() can invoke cleanup even when the client is still
    // connected (releases the heartbeat interval and bus subscription
    // before the HTTP server is torn down).
    this.sseCleanupFns.add(cleanup);

    req.once("close", cleanup);
    req.once("error", cleanup);
  }

  private async handleMcpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readJsonBody(req);
    const request = body as {
      jsonrpc?: string;
      id?: string | number | null;
      method?: string;
      params?: Record<string, unknown>;
    };

    // Enforce write rate limiting for MCP tool calls that mutate state,
    // matching the same protection applied to the REST write endpoints.
    // Pre-check ensures capacity; post-check skips counting dry runs and
    // idempotency replays, consistent with the REST handlers.
    const toolName = typeof request.params?.name === "string" ? request.params.name : "";
    const toolArgs = request.params?.arguments;
    const dreamsRunDryRun =
      (toolName === "engram.dreams_run" || toolName === "remnic.dreams_run") &&
      toolArgs !== null &&
      typeof toolArgs === "object" &&
      !Array.isArray(toolArgs) &&
      (toolArgs as { dryRun?: unknown }).dryRun === true;
    const memoryActionApplyDryRun =
      (toolName === "engram.memory_action_apply" || toolName === "remnic.memory_action_apply") &&
      toolArgs !== null &&
      typeof toolArgs === "object" &&
      !Array.isArray(toolArgs) &&
      (toolArgs as { dryRun?: unknown }).dryRun === true;
    const isMcpWrite =
      request.method === "tools/call" &&
      (
        toolName === "engram.memory_store" ||
        toolName === "remnic.memory_store" ||
        toolName === "engram.suggestion_submit" ||
        toolName === "remnic.suggestion_submit" ||
        toolName === "engram.observe" ||
        toolName === "remnic.observe" ||
        toolName === "engram.lcm_compaction_flush" ||
        toolName === "remnic.lcm_compaction_flush" ||
        toolName === "engram.lcm_compaction_record" ||
        toolName === "remnic.lcm_compaction_record" ||
        toolName === "engram.capsule_export" ||
        toolName === "remnic.capsule_export" ||
        toolName === "engram.capsule_import" ||
        toolName === "remnic.capsule_import" ||
        (
          !dreamsRunDryRun &&
          (toolName === "engram.dreams_run" || toolName === "remnic.dreams_run")
        ) ||
        (
          !memoryActionApplyDryRun &&
          (
            toolName === "engram.memory_action_apply" ||
            toolName === "remnic.memory_action_apply"
          )
        )
      );
    if (isMcpWrite) {
      this.ensureWriteRateLimitAvailable();
    }

    const sessionId = (() => {
      const raw = req.headers["mcp-session-id"];
      return typeof raw === "string" ? raw.trim() : undefined;
    })();
    const mcpCorrelationId = correlationIdStore.getStore() ?? randomUUID();
    const response = await this.mcpServer.handleRequest(request, {
      principalOverride: this.resolveRequestPrincipal(req),
      sessionId,
      correlationId: mcpCorrelationId,
    });

    if (isMcpWrite && response !== null) {
      const result = (response as Record<string, unknown>).result as Record<string, unknown> | undefined;
      const isError = result?.isError === true;
      const structured = result?.structuredContent as { dryRun?: boolean; idempotencyReplay?: boolean } | undefined;
      if (!isError && structured && this.shouldCountWriteRateLimit(structured)) {
        this.recordWriteRateLimitHit();
      }
    }
    if (response === null) {
      res.statusCode = 202;
      res.end();
      return;
    }
    // If this was an initialize response, pop the session ID keyed by
    // correlation ID (unique per HTTP request, not client-chosen JSON-RPC id).
    const assignedSessionId = this.mcpServer.popInitSessionId(mcpCorrelationId);
    if (assignedSessionId) {
      res.setHeader("mcp-session-id", assignedSessionId);
    }
    this.respondJson(res, 200, response);
  }

  private respondJson(res: ServerResponse, status: number, payload: unknown): void {
    const body = JSON.stringify(payload, null, 2);
    res.statusCode = status;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("content-length", String(Buffer.byteLength(body)));
    const cid = correlationIdStore.getStore();
    if (cid) {
      res.setHeader("x-request-id", cid);
    }
    res.end(body);
  }

  private respondBinary(
    res: ServerResponse,
    status: number,
    body: Buffer,
    headers: Record<string, string> = {},
  ): void {
    res.statusCode = status;
    res.setHeader("content-type", "application/octet-stream");
    res.setHeader("content-length", String(body.length));
    for (const [key, value] of Object.entries(headers)) {
      res.setHeader(key, value);
    }
    const cid = correlationIdStore.getStore();
    if (cid) {
      res.setHeader("x-request-id", cid);
    }
    res.end(body);
  }

  private async handleAdminConsole(
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string,
  ): Promise<boolean> {
    if (req.method !== "GET") return false;
    if (pathname === "/remnic/ui" || pathname === "/engram/ui") {
      res.statusCode = 301;
      res.setHeader("location", pathname + "/");
      res.end();
      return true;
    }
    if (pathname === "/remnic/ui/" || pathname === "/engram/ui/") {
      await this.respondStatic(res, path.join(this.adminConsolePublicDir, "index.html"), "text/html; charset=utf-8");
      return true;
    }
    if (pathname === "/remnic/ui/app.js" || pathname === "/engram/ui/app.js") {
      await this.respondStatic(res, path.join(this.adminConsolePublicDir, "app.js"), "application/javascript; charset=utf-8");
      return true;
    }
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
      this.respondJson(res, 404, { error: "not_found" });
    }
  }

  private async readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.length;
      if (total > this.maxBodyBytes) {
        throw new HttpError(413, "request_body_too_large", "request_body_too_large");
      }
      chunks.push(buffer);
    }
    if (chunks.length === 0) return {};
    const raw = Buffer.concat(chunks).toString("utf-8").trim();
    if (raw.length === 0) return {};
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new HttpError(400, "invalid_json", "invalid_json");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new HttpError(400, "invalid_json_object", "invalid_json_object");
    }
    return parsed as Record<string, unknown>;
  }

  private async readValidatedBody<S extends SchemaName>(req: IncomingMessage, schemaName: S): Promise<SchemaTypeFor<S>> {
    const raw = await this.readJsonBody(req);
    const result = validateRequest(schemaName, raw);
    if (!result.success) {
      throw new HttpError(400, result.error.error, "validation_error", result.error.details);
    }
    return result.data as SchemaTypeFor<S>;
  }

  private isAuthorized(req: IncomingMessage, pathname?: string): boolean {
    if (!this.authToken && this.authTokens.length === 0 && !this.authTokensGetter) return false;
    // Primary path: Authorization: Bearer <token> header.
    const raw = req.headers.authorization;
    let candidate: string | null = null;
    if (raw) {
      const separator = raw.indexOf(" ");
      if (separator > 0) {
        const scheme = raw.slice(0, separator).toLowerCase();
        if (scheme === "bearer") {
          candidate = raw.slice(separator + 1).trim();
        }
      }
    }
    // Fallback: ?token= query parameter — ONLY accepted for the SSE
    // endpoint (/engram/v1/graph/events).  EventSource cannot set request
    // headers, so SSE clients must pass the token via the query string.
    // Allowing this fallback on every endpoint would let a CSRF attacker
    // embed a credentialed URL anywhere — restricting it to SSE limits the
    // attack surface (Codex P2 review thread `access-http.ts:1406`; Cursor
    // review thread `access-http.ts:1412`).  Authorization header always
    // wins; timing-safe compare used below.
    if (!candidate && pathname === "/engram/v1/graph/events") {
      try {
        const parsed = new URL(req.url ?? "/", `http://${hostToUrlAuthority(this.host)}`);
        const queryToken = parsed.searchParams.get("token");
        if (queryToken && queryToken.length > 0) {
          candidate = queryToken;
        }
      } catch {
        // Malformed URL — don't authenticate
      }
    }
    if (!candidate) return false;
    const token = candidate;
    // Check primary token
    if (this.authToken && this.timingSafeStringEqual(token, this.authToken)) return true;
    // Check static multi-connector tokens
    for (const valid of this.authTokens) {
      if (this.timingSafeStringEqual(token, valid)) return true;
    }
    // Check dynamic tokens (reloaded per request for generate/revoke without restart)
    if (this.authTokensGetter) {
      for (const valid of this.authTokensGetter()) {
        if (this.timingSafeStringEqual(token, valid)) return true;
      }
    }
    return false;
  }

  private timingSafeStringEqual(a: string, b: string): boolean {
    const left = this.encodeSecret(a);
    const right = this.encodeSecret(b);
    if (!left || !right) return false;
    return timingSafeEqual(left, right);
  }

  private encodeSecret(value: string): Buffer | null {
    const encoded = Buffer.from(value, "utf-8");
    if (encoded.length > 1024) return null;
    const out = Buffer.alloc(2 + 1024);
    out.writeUInt16BE(encoded.length, 0);
    encoded.copy(out, 2);
    return out;
  }

  private writeResponseStatus(response: { dryRun: boolean; status: string }): number {
    if (response.dryRun === true) return 200;
    if (response.status === "stored" || response.status === "queued_for_review") return 201;
    return 200;
  }

  private ensureWriteRateLimitAvailable(): void {
    const now = Date.now();
    while (
      this.writeRequestTimestamps.length > 0 &&
      now - (this.writeRequestTimestamps[0] ?? 0) > WRITE_RATE_LIMIT_WINDOW_MS
    ) {
      this.writeRequestTimestamps.shift();
    }
    if (this.writeRequestTimestamps.length >= WRITE_RATE_LIMIT_MAX_REQUESTS) {
      throw new HttpError(429, "write_rate_limited", "write_rate_limited");
    }
  }

  private recordWriteRateLimitHit(): void {
    this.writeRequestTimestamps.push(Date.now());
  }

  private shouldCountWriteRateLimit(response: { dryRun?: boolean; idempotencyReplay?: boolean }): boolean {
    return response.dryRun !== true && response.idempotencyReplay !== true;
  }
}
