import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";
import { gunzipSync } from "node:zlib";
import { log } from "./logger.js";
import { WriteRateLimiter, type WriteRateLimitReservation } from "./write-rate-limiter.js";
import { abortError, isAbortError } from "./abort-error.js";
import { EngramAccessForbiddenError } from "./access-errors.js";
import {
  EngramAccessInputError,
  type EngramAccessService,
  type WearablesMeetingsScope,
  type EngramAccessMemoryResponse,
  type EngramAccessWriteResponse,
} from "./access-service.js";
import { maybeHandleLifecycleFlush, type LifecycleFlushHttpDeps } from "./access-http-lifecycle-flush.js";
import {
  respondOfflineManifestStream,
  respondOfflineSnapshotStream,
} from "./access-http-offline-stream.js";
import { nonEmptyQueryParam, optionalQueryString, positiveIntQueryParam } from "./access-http-query.js";
import { CorrectionContractError } from "./correction/correction-contract.js";
import { WearablesInputError } from "./wearables/errors.js"; import { respondMeetingsList, respondMeetingsGet, respondMeetingsBuild } from "./meetings/http-glue.js";
import { EngramMcpServer, MCP_SUPPORTED_PROTOCOL_VERSIONS } from "./access-mcp.js";
import { validateRequest, type SchemaName, type SchemaTypeFor } from "./access-schema.js";
import {
  OFFLINE_SYNC_APPLY_MAX_BODY_BYTES,
  OFFLINE_SYNC_FILE_CONTENT_MAX_CHUNK_BYTES,
  OFFLINE_SYNC_SNAPSHOT_BASE_MAX_BODY_BYTES,
} from "./offline-sync.js";
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
import { projectTagProjectId } from "./coding/coding-namespace.js";
import { getOperation, type OperationName } from "./access-boundary.js";
import { authorizationProbeNamespaces, authorizationProbeRequiresPrincipalNamespace, probeOperationAuthorization } from "./access-authorization-probe.js";
import { resolveQueryNamespaceWritablePreflight } from "./access-namespace-preflight.js";
import { respondAccessCapabilitiesHttp } from "./access-http-lcm-compaction.js";
import {
  assertOperationAllowed,
  capabilityAllowsOp,
  enforceNamespaceAllowList,
  isCapabilityRestricted,
  tokenCapabilityStore,
  type TokenCapabilities,
} from "./access-token-capabilities.js";
// Importing access-operations registers the pilot boundary operations
// (memory_get / memory_store) as a side effect; the HTTP handlers below
// dispatch the migrated routes through the registry (issue #1525).
import "./access-operations.js";
import { handleChatMessage, handleChatEventsSSE } from "./chat/chat-http.js";
// cleanupExpiredChatSessions wires the chat session TTL sweep into the
// server lifecycle (issue #1685 item 1 / #1687 Thread 21).
import { cleanupExpiredChatSessions, enforceChatSessionNamespace } from "./chat/chat-session.js";
import { isDefaultReviewNamespace, listPairs, readPair } from "./contradiction/contradiction-review.js";
import { isValidResolutionVerb, executeResolution } from "./contradiction/resolution.js";
import { RelayMissionStoreError } from "./relay/mission.js";
import { SupportPassportAccessHttpBase } from "./support-passport/access-http-base.js";

export interface AccessHttpReadinessState {
  ready: boolean;
  warmupAttempts: number;
  lastError?: string | null;
  /**
   * True when the standalone init gate opened before search warm-up completed
   * (issue #2215): the service is functional (recall serves via fallback
   * retrieval), so health answers 200 with degraded info instead of 503.
   */
  degraded?: boolean;
}

export interface EngramAccessHttpServerOptions {
  service: EngramAccessService;
  host?: string;
  port?: number;
  authToken?: string;
  /** Additional valid tokens (for multi-connector auth). Checked alongside authToken. */
  authTokens?: string[];
  /** Dynamic token loader — called on each auth check so new/revoked tokens take effect without restart. */
  authTokensGetter?: () => string[];
  /**
   * Dynamic token-ENTRY loader ({token, connector} pairs from one coherent
   * snapshot). Preferred over `authTokensGetter` when a `tokenPathPolicy`
   * is set: the connector used for the policy decision comes from the SAME
   * entry that validated, so identity can never lag validation.
   */
  authTokenEntriesGetter?: () => ReadonlyArray<{ token: string; connector?: string; capabilities?: TokenCapabilities }>;
  /**
   * Optional per-request scope policy for tokens sourced from
   * `authTokenEntriesGetter`. Return false to deny the (validated) token
   * for this pathname. Static `authToken`/`authTokens` (operator-supplied)
   * bypass the policy. Entries whose connector is missing FAIL CLOSED when
   * a policy is configured.
   */
  tokenPathPolicy?: (connector: string, pathname: string | undefined) => boolean;
  principal?: string;
  maxBodyBytes?: number;
  /**
   * Max non-replayed write requests per rolling window before 429
   * `write_rate_limited` (issue #1937). Positive integer; defaults to 30.
   */
  writeRateLimitMaxRequests?: number;
  /** Rolling window for the write rate limit, in ms. Positive integer; defaults to 60000. */
  writeRateLimitWindowMs?: number;
  adminConsoleEnabled?: boolean;
  adminConsolePublicDir?: string;
  /** Inject the primary auth token into the admin console shell for trusted launch surfaces. */
  adminConsolePrefillToken?: boolean;
  trustPrincipalHeader?: boolean;
  /** Enable adapter-based identity resolution from request headers */
  enableAdapters?: boolean;
  /** Custom adapter registry (defaults to built-in adapters) */
  adapterRegistry?: AdapterRegistry;
  /** Enable oai-mem-citation blocks in recall responses (issue #379). */
  citationsEnabled?: boolean;
  /** Auto-enable citations for Codex adapter connections (issue #379). */
  citationsAutoDetect?: boolean;
  /** Advertise legacy engram.* tool aliases on tools/list (issue #1427). Default true. */
  emitLegacyTools?: boolean;
  /** Optional authenticated admin dashboard/config controls supplied by the host server. */
  adminControls?: RemnicAdminControls;
  /**
   * Standalone readiness state. Defaults to ready so embedded hosts keep their
   * existing health behavior.
   */
  readiness?: () => AccessHttpReadinessState;
  /**
   * When set, every 401 response includes
   * `WWW-Authenticate: Bearer resource_metadata="<value>"` so MCP clients
   * can discover the OAuth 2.0 protected-resource metadata document
   * (RFC 9728). Must be an absolute http(s) URL; constructor throws on
   * anything else. Unset → bare `Bearer`.
   */
  resourceMetadataUrl?: string;
  /**
   * Optional pre-auth request handler (e.g. OAuth facade mounted by
   * `@remnic/server`). Runs after the admin-console handler and BEFORE
   * bearer authorization. Return true if the request was fully handled
   * (response ended). `ctx.authorized` reports whether the request
   * carries a valid operator bearer token, so the handler can gate
   * operator-only endpoints without owning token validation.
   * Errors thrown by the handler flow into the existing error handling.
   */
  externalRequestHandler?: (
    req: IncomingMessage,
    res: ServerResponse,
    ctx: { authorized: boolean },
  ) => Promise<boolean>;
}

export interface EngramAccessHttpServerStatus {
  running: boolean;
  host: string;
  port: number;
  maxBodyBytes: number;
}

export interface RemnicAdminHarnessStatus {
  id: string;
  label: string;
  detected: boolean;
  enabled: boolean;
  source?: string;
  detail?: string;
}

export interface RemnicAdminModelOption {
  id: string;
  label: string;
  provider: string;
  detected: boolean;
  enabled: boolean;
  default?: boolean;
  source?: string;
  endpoint?: string;
}

export interface RemnicAdminFeatureStatus {
  key: string;
  label: string;
  enabled: boolean;
  writable: boolean;
  restartRequired?: boolean;
}

export interface RemnicAdminConfigStatus {
  path: string;
  exists: boolean;
  writable: boolean;
  restartRequired: boolean;
  values: Record<string, string | number | boolean | null>;
}

export interface RemnicAdminDashboardStatus {
  config: RemnicAdminConfigStatus;
  harnesses: RemnicAdminHarnessStatus[];
  providers?: RemnicAdminHarnessStatus[];
  models: RemnicAdminModelOption[];
  features: RemnicAdminFeatureStatus[];
}

export type RemnicAdminConfigPatch = Record<string, unknown>;

export interface RemnicAdminControls {
  status: () => Promise<RemnicAdminDashboardStatus>;
  update?: (patch: RemnicAdminConfigPatch) => Promise<RemnicAdminDashboardStatus>;
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

function serializeInlineScriptValue(value: string): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

const defaultAdminConsolePublicDir = resolveDefaultAdminConsolePublicDir();
const correlationIdStore = new AsyncLocalStorage<string>();
const RELAY_ADMIN_CONSOLE_ASSETS = new Map<string, string>([
  ["relay.css", "text/css; charset=utf-8"],
  ["relay-model.js", "application/javascript; charset=utf-8"],
  ["relay.js", "application/javascript; charset=utf-8"],
  ["replay.json", "application/json; charset=utf-8"],
]);

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
function assertResourceMetadataUrl(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(
      `access HTTP resourceMetadataUrl must be an absolute http(s) URL, got: ${value}`,
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `access HTTP resourceMetadataUrl must use http or https, got: ${parsed.protocol}`,
    );
  }
  return value;
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

function summarizeHttpRequest(req: IncomingMessage): string {
  const method = req.method ?? "UNKNOWN";
  try {
    const parsed = new URL(req.url ?? "/", "http://localhost");
    return `${method} ${parsed.pathname}`;
  } catch {
    return `${method} ${(req.url ?? "/").split("?")[0]}`;
  }
}

function parseStrictIntegerQuery(
  raw: string | null,
  field: string,
  defaultValue: number,
  minValue: number,
): number {
  if (raw === null) return defaultValue;
  if (!/^(?:0|[1-9]\d*)$/.test(raw)) {
    throw new HttpError(400, `${field} must be an integer`, `invalid_${field}`);
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minValue) {
    throw new HttpError(400, `${field} must be an integer >= ${minValue}`, `invalid_${field}`);
  }
  return value;
}

function parseMemorySort(raw: string | null): "updated_desc" | "updated_asc" | "created_desc" | "created_asc" | undefined {
  if (raw === null) return undefined;
  if (
    raw === "updated_desc" ||
    raw === "updated_asc" ||
    raw === "created_desc" ||
    raw === "created_asc"
  ) {
    return raw;
  }
  throw new HttpError(400, "sort must be one of updated_desc|updated_asc|created_desc|created_asc", "invalid_sort");
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

function decodeRelayMissionIdSegment(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new EngramAccessInputError("missionId path segment is not valid percent-encoded input");
  }
}

function rejectBlankRelayNamespace(value: string | null | undefined): void {
  if (value !== undefined && value !== null && value.trim().length === 0) {
    throw new EngramAccessInputError("Relay namespace must not be blank when provided");
  }
}

function codingContextFromProjectTag(projectTag: string): {
  projectId: string;
  branch: string | null;
  rootPath: string;
  defaultBranch: string | null;
} {
  const projectId = projectTagProjectId(projectTag);
  return {
    projectId,
    branch: null,
    rootPath: projectId,
    defaultBranch: null,
  };
}

export class EngramAccessHttpServer extends SupportPassportAccessHttpBase {
  protected readonly service: EngramAccessService;
  private readonly host: string;
  private readonly requestedPort: number;
  private readonly authToken?: string;
  private readonly authTokens: string[];
  private readonly authTokensGetter?: () => string[];
  private readonly authTokenEntriesGetter?: () => ReadonlyArray<{ token: string; connector?: string; capabilities?: TokenCapabilities }>;
  private readonly tokenPathPolicy?: (connector: string, pathname: string | undefined) => boolean;
  private readonly authenticatedPrincipal?: string;
  private readonly maxBodyBytes: number;
  private readonly adminConsoleEnabled: boolean;
  private readonly adminConsolePublicDir: string;
  private readonly adminConsolePrefillToken?: string;
  private readonly adminControls?: RemnicAdminControls;
  private readonly trustPrincipalHeader: boolean;
  private readonly adapterRegistry: AdapterRegistry | null;
  private readonly readiness: () => AccessHttpReadinessState;
  private readonly resourceMetadataUrl?: string;
  private readonly externalRequestHandler?: (
    req: IncomingMessage,
    res: ServerResponse,
    ctx: { authorized: boolean },
  ) => Promise<boolean>;
  private readonly writeLimiter: WriteRateLimiter;
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

  /**
   * Periodic chat-session TTL sweep handle (issue #1685 item 1 /
   * #1687 Thread 21).  unref'd so it never blocks process exit
   * (rule 47); cleared in `stop()`.
   */
  private chatTtlTimer: NodeJS.Timeout | null = null;

  constructor(options: EngramAccessHttpServerOptions) {
    super();
    this.service = options.service;
    this.host = options.host?.trim() || "127.0.0.1";
    this.requestedPort = parseHttpServerPort(options.port);
    this.authToken = options.authToken?.trim() || undefined;
    this.authTokens = (options.authTokens ?? []).map((t) => t.trim()).filter(Boolean);
    this.authTokensGetter = options.authTokensGetter;
    this.authTokenEntriesGetter = options.authTokenEntriesGetter;
    this.tokenPathPolicy = options.tokenPathPolicy;
    this.authenticatedPrincipal = options.principal?.trim() || undefined;
    this.maxBodyBytes = Number.isFinite(options.maxBodyBytes)
      ? Math.max(1, Math.floor(options.maxBodyBytes ?? 131072))
      : 131072;
    this.writeLimiter = new WriteRateLimiter(
      options.writeRateLimitMaxRequests,
      options.writeRateLimitWindowMs,
    );
    this.adminConsoleEnabled = options.adminConsoleEnabled !== false;
    this.adminConsolePublicDir = options.adminConsolePublicDir ?? defaultAdminConsolePublicDir;
    this.adminConsolePrefillToken = options.adminConsolePrefillToken === true ? this.authToken : undefined;
    this.adminControls = options.adminControls;
    this.trustPrincipalHeader = options.trustPrincipalHeader === true;
    this.readiness = options.readiness ?? (() => ({ ready: true, warmupAttempts: 0 }));
    this.resourceMetadataUrl = assertResourceMetadataUrl(options.resourceMetadataUrl);
    this.externalRequestHandler = options.externalRequestHandler;
    this.adapterRegistry = options.enableAdapters !== false
      ? (options.adapterRegistry ?? new AdapterRegistry())
      : null;
    this.mcpServer = new EngramMcpServer(this.service, {
      principal: options.principal,
      citationsEnabled: options.citationsEnabled,
      citationsAutoDetect: options.citationsAutoDetect,
      emitLegacyTools: options.emitLegacyTools,
      codingDecisionVisible: this.service.decisionRecordSurfaceVisible,
      architectureCardVisible: this.service.architectureCardSurfaceVisible,
      codegraphVisible: this.service.codegraphSurfaceVisible,
      sessionDeltaVisible: this.service.sessionDeltaSurfaceVisible,
      chatVisible: this.service.configRef?.chat?.enabled === true,
      correctionVisible: this.service.correctionSurfaceVisible,
    });
  }

  async start(): Promise<EngramAccessHttpServerStatus> {
    if (!this.authToken && this.authTokens.length === 0 && !this.authTokensGetter && !this.authTokenEntriesGetter) {
      throw new Error("engram access HTTP requires authToken or authTokens");
    }
    if (this.server) return this.status();

    const server = createServer((req, res) => {
      const correlationId = randomUUID();
      const abortController = new AbortController();
      const abortDisconnectedRequest = () => {
        if (!res.writableFinished && !abortController.signal.aborted) {
          abortController.abort(abortError("HTTP client disconnected"));
        }
      };
      req.once("aborted", abortDisconnectedRequest);
      res.once("close", abortDisconnectedRequest);
      correlationIdStore.run(correlationId, () => {
        void this.handle(req, res, correlationId, abortController.signal).catch((err) => {
          if (isAbortError(err)) {
            if (!res.destroyed && !res.writableEnded) {
              res.end();
            }
            return;
          }
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
          if (err instanceof EngramAccessForbiddenError) {
            this.respondJson(res, 403, { error: err.message, code: "forbidden" });
            return;
          }
          if (err instanceof CorrectionContractError) {
            this.respondJson(res, 400, { error: err.message, code: "correction_contract_error" });
            return;
          }
          if (err instanceof RelayMissionStoreError) {
            const status = err.code === "idempotency_conflict"
              ? 409
              : err.code === "limit_exceeded"
                ? 413
                : err.code === "lock_unavailable"
                  ? 503
                  : 500;
            this.respondJson(res, status, {
              error: status >= 500 ? "relay_backend_unavailable" : err.message,
              code: `relay_${err.code}`,
            });
            return;
          }
          if (res.headersSent) {
            res.destroy(err as Error);
            return;
          }
          log.error(
            `engram access HTTP internal error [${correlationId}] ${summarizeHttpRequest(req)}`,
            err,
          );
          this.respondJson(res, 500, { error: "internal_error", code: "internal_error" });
        }).finally(() => {
          req.off("aborted", abortDisconnectedRequest);
          res.off("close", abortDisconnectedRequest);
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

    // ── Chat session TTL sweep (issue #1685 item 1 / #1687 Thread 21) ──
    // Expire idle chat sessions so the JSONL store cannot grow unbounded.
    // A one-shot sweep runs on startup; a periodic re-sweep follows on an
    // unref'd 1-hour cadence (rule 47 — never blocks process exit).  Both
    // are no-ops when chat is disabled (no TTL configured).
    this.scheduleChatSessionTtlSweep();

    return this.status();
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    // Release the chat-session TTL sweep timer (issue #1685) alongside
    // the SSE cleanups below.
    if (this.chatTtlTimer) {
      clearInterval(this.chatTtlTimer);
      this.chatTtlTimer = null;
    }
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

  /**
   * Schedule the chat-session TTL sweep: one immediate pass plus a
   * recurring hourly pass (issue #1685 item 1 / #1687 Thread 21).  Both
   * are skipped when chat is disabled.  The recurring timer is unref'd
   * so it never keeps the event loop alive on its own (rule 47).  The
   * sweep itself is best-effort — cleanup failures are swallowed inside
   * `cleanupExpiredChatSessions`.
   */
  private scheduleChatSessionTtlSweep(): void {
    // Clear any prior handle so a second start() without an intervening
    // stop() cannot leak a dangling setInterval (Kilo review thread).
    if (this.chatTtlTimer) {
      clearInterval(this.chatTtlTimer);
      this.chatTtlTimer = null;
    }
    const chat = this.service.configRef?.chat;
    if (!chat?.enabled) return;
    const ttlHours = typeof chat.sessionTtlHours === "number" && chat.sessionTtlHours > 0
      ? chat.sessionTtlHours
      : 72;
    // Startup sweep — fire and forget; failures never block the server.
    void cleanupExpiredChatSessions(this.service.memoryDir, ttlHours).catch(() => { /* best-effort */ });
    // Hourly re-sweep (unref'd — rule 47).
    const SWEEP_INTERVAL_MS = 60 * 60 * 1000;
    this.chatTtlTimer = setInterval(() => {
      void cleanupExpiredChatSessions(this.service.memoryDir, ttlHours).catch(() => { /* best-effort */ });
    }, SWEEP_INTERVAL_MS);
    this.chatTtlTimer.unref?.();
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
  private identityCache = new WeakMap<IncomingMessage, { principal?: string; namespace?: string; sessionKey?: string }>();

  /** Resolve principal, namespace, and session key from request headers and adapter identity */
  private resolveRequestIdentity(req: IncomingMessage): { principal?: string; namespace?: string; sessionKey?: string } {
    const cached = this.identityCache.get(req);
    if (cached) return cached;
    let principal: string | undefined;
    let namespace: string | undefined;
    let sessionKey: string | undefined;

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

    if (!principal) {
      principal = this.authenticatedPrincipal;
    }

    // Try adapter-based identity resolution for namespace and, only when no
    // server principal is configured, an adapter-owned default principal.
    const adapterIdentity = this.resolveAdapterIdentity(req);
    if (adapterIdentity) {
      if (!principal) {
        principal = adapterIdentity.principal;
      }
      namespace = adapterIdentity.namespace;
      sessionKey = adapterIdentity.sessionKey;
    }

    const result = { principal, namespace, sessionKey };
    this.identityCache.set(req, result);
    return result;
  }

  protected resolveRequestPrincipal(req: IncomingMessage): string | undefined {
    return this.resolveRequestIdentity(req).principal;
  }

  /** Caller scope for wearables/meetings ops (issue #2123): request principal +
   *  gated namespace + optional sessionKey, so reads/writes resolve to the caller
   *  namespace instead of the machine default. */
  private wearablesScope(req: IncomingMessage, namespace?: string, sessionKey?: string): WearablesMeetingsScope {
    return { authenticatedPrincipal: this.resolveRequestPrincipal(req), namespace: this.resolveNamespace(req, namespace), ...(sessionKey ? { sessionKey } : {}) };
  }

  /** Resolve namespace: only use the explicit body value. Adapter-inferred namespace
   *  is intentionally NOT used as a fallback for REST requests — omitting namespace
   *  should default to the server's global namespace, not silently scope to an adapter. */
  private resolveNamespace(_req: IncomingMessage, bodyNamespace?: string): string | undefined {
    const namespace = bodyNamespace || undefined;
    // Per-token namespace enforcement (issues #1837/#1850): every HTTP
    // namespace-scoped route routes through this helper so none can dodge the
    // allow-list by dropping the param. The check is delegated to the SINGLE
    // chokepoint (`enforceNamespaceAllowList`) shared with the MCP dispatch
    // and the id-loaded contradiction routes — one rule, every surface. The
    // effective namespace (explicit OR server default) must be a member; fail
    // closed. No-op for unrestricted tokens (no namespaces allow-list).
    enforceNamespaceAllowList(tokenCapabilityStore.getStore(), namespace, this.service.configRef?.defaultNamespace);
    return namespace;
  }

  /**
   * Resolve + enforce the `namespace` field carried in a POST request body,
   * returning a shallow-copied envelope with the gated namespace stamped on.
   * Used by the coding/correction POST routes that pass `body` straight to
   * `op.run`: the body `namespace` is a user-controlled field that MUST flow
   * through the same effective-namespace allow-list gate as the query-param
   * routes, otherwise a scoped bearer can scope its call to another tenant
   * by setting `body.namespace` (issue #1850 finding 2). Throws 403 for a
   * scoped token whose allow-list does not cover the effective namespace.
   *
   * A `namespace` that is neither a string nor `null` is REJECTED here rather
   * than coerced to `undefined`: silently reinterpreting it would default the
   * request to the principal's namespace set and answer 200, hiding the
   * caller's mistake behind a plausible result (AGENTS.md pattern 39). `null`
   * and an absent field keep their documented "no explicit namespace" meaning.
   */
  private gatedBodyNamespace(
    req: IncomingMessage,
    body: Record<string, unknown>,
  ): Record<string, unknown> {
    const requested = body.namespace;
    if (requested !== undefined && requested !== null && typeof requested !== "string") {
      throw new EngramAccessInputError(
        `namespace must be a string or null (got: ${typeof requested})`,
      );
    }
    // Trim BEFORE the allow-list gate: the operation schemas normalize
    // `namespace` with `.trim()`, so checking the raw value would 403 a
    // `" team "` that the MCP path accepts as `team` — the same envelope
    // succeeding or failing on harmless whitespace. The trimmed value is what
    // gets stamped, so the gate and the operation see one namespace.
    const trimmed = typeof requested === "string" ? requested.trim() : undefined;
    const namespace = this.resolveNamespace(req, trimmed || undefined);
    return { ...body, namespace };
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

  private async handle(
    req: IncomingMessage,
    res: ServerResponse,
    correlationId: string,
    abortSignal: AbortSignal,
  ): Promise<void> {
    const parsed = new URL(req.url ?? "/", `http://${hostToUrlAuthority(this.host)}`);
    const pathname = parsed.pathname;

    if (this.adminConsoleEnabled && await this.handleAdminConsole(req, res, pathname)) {
      return;
    }

    if (req.method === "GET" && (pathname === "/engram/v1/live" || pathname === "/engram/v1/health")) {
      const { ready, warmupAttempts, lastError } = this.readiness();
      if (!ready) {
        this.respondJson(res, 503, {
          ok: false, ready: false, warmupAttempts, lastError: lastError ?? null, code: "not_ready",
        });
        return;
      }
    }

    if (await this.handleSupportPassportPublicRequest(req, res)) return;

    // Run any host-supplied pre-auth request handler. It runs AFTER the
    // admin-console branch (admin assets are public) and BEFORE the
    // operator bearer gate. The handler decides whether it has fully
    // owned the response (return true) or wants the request to fall
    // through to the normal pipeline. `ctx.authorized` is computed
    // here so the handler can implement operator-only endpoints
    // (e.g. /oauth/pending) without owning token validation.
    if (this.externalRequestHandler) {
      // Operator-only endpoints (OAuth pending/approve/deny) must only pass
      // for unrestricted tokens — a scoped (least-privileged) token must NOT
      // reach operator surfaces (issue #1837).
      const authorized = this.isAuthorized(req, pathname) &&
        !isCapabilityRestricted(this.resolveTokenCapabilities(req, pathname));
      if (await this.externalRequestHandler(req, res, { authorized })) return;
    }

    if (!this.isAuthorized(req, pathname)) {
      const body = JSON.stringify({ error: "unauthorized", code: "unauthorized" });
      res.writeHead(401, {
        "content-type": "application/json; charset=utf-8",
        "www-authenticate": this.bearerChallenge(),
        "x-request-id": correlationId,
      });
      res.end(body);
      return;
    }

    // Bind the presenting token's capabilities to this request's async
    // context via run() (NOT enterWith). enterWith mutates the CURRENT async
    // resource and does NOT reliably isolate the store across the awaits and
    // concurrent requests that fill this handler — the store could read
    // undefined mid-handler, and undefined caps == unrestricted/legacy,
    // which would SILENTLY FAIL OPEN, bypassing the op + namespace gates.
    // run() establishes a fresh, request-private async scope for the WHOLE
    // dispatch so concurrent requests never bleed capabilities and the store
    // stays bound across every await (issue #1850 round 7).
    const caps = this.resolveTokenCapabilities(req, pathname);
    await tokenCapabilityStore.run(caps, async () => {
      await this.dispatchAuthorizedRequest(req, res, parsed, pathname, correlationId, abortSignal);
    });
  }

  private async dispatchAuthorizedRequest(
    req: IncomingMessage,
    res: ServerResponse,
    parsed: URL,
    pathname: string,
    correlationId: string,
    abortSignal: AbortSignal,
  ): Promise<void> {
    // Method-conformance for the streamable-HTTP MCP endpoint:
    // GET/DELETE on /mcp must return 405 + Allow: POST instead of
    // silently falling through to the generic 404. POST continues
    // to the normal handler below.
    if (pathname === "/mcp" && (req.method === "GET" || req.method === "DELETE")) {
      const body = JSON.stringify({ error: "method_not_allowed", code: "method_not_allowed" });
      res.writeHead(405, {
        "content-type": "application/json; charset=utf-8",
        allow: "POST",
        "x-request-id": correlationId,
      });
      res.end(body);
      return;
    }

    if (req.method === "POST" && pathname === "/mcp") return this.handleMcpRequest(req, res, abortSignal);

    if (await this.handleSupportPassportOwnerRequest(req, res, pathname, parsed.search.length > 0, abortSignal)) return;

    if (req.method === "GET" && pathname === "/engram/v1/live") return this.respondJson(res, 200, { ok: true, ready: true });
    if (req.method === "GET" && pathname === "/engram/v1/health") {
      const { degraded, warmupAttempts, lastError } = this.readiness();
      const health = await this.service.health();
      this.respondJson(res, 200, degraded !== true ? health : {
        ...health, degraded: true, warmupAttempts, lastError: lastError ?? null,
      });
      return;
    }
    if (req.method === "GET" && pathname === "/engram/v1/capabilities") return respondAccessCapabilitiesHttp(res);
    if (req.method === "GET" && pathname === "/engram/v1/authorization") {
      res.setHeader("cache-control", "no-store");
      const probe = probeOperationAuthorization(tokenCapabilityStore.getStore(), parsed.searchParams.getAll("op"));
      for (const namespace of authorizationProbeNamespaces(probe.operations, parsed.searchParams.get("namespace") ?? undefined))
        this.resolveNamespace(req, namespace);
      if (authorizationProbeRequiresPrincipalNamespace(probe.operations))
        await this.enforceSupportPassportAuthorizationProbe(req);
      this.respondJson(res, 200, probe);
      return;
    }

    if (req.method === "GET" && pathname === "/engram/v1/adapters") {
      this.enforceTokenOp("adapters_status"); // boundary dispatch (issue #1850)
      const identity = this.resolveAdapterIdentity(req);
      this.respondJson(res, 200, {
        adaptersEnabled: this.adapterRegistry !== null,
        registered: this.adapterRegistry?.list() ?? [],
        resolved: identity,
      });
      return;
    }

    if (
      req.method === "GET" &&
      (pathname === "/engram/v1/admin/dashboard" || pathname === "/remnic/v1/admin/dashboard")
    ) {
      this.requireOperatorToken();
      if (!this.adminControls) {
        this.respondJson(res, 404, { error: "admin_controls_unavailable", code: "admin_controls_unavailable" });
        return;
      }
      this.respondJson(res, 200, await this.adminControls.status());
      return;
    }

    if (
      req.method === "PATCH" &&
      (pathname === "/engram/v1/admin/config" || pathname === "/remnic/v1/admin/config")
    ) {
      this.requireOperatorToken();
      if (!this.adminControls?.update) {
        this.respondJson(res, 404, { error: "admin_controls_unavailable", code: "admin_controls_unavailable" });
        return;
      }
      try {
        this.respondJson(res, 200, await this.adminControls.update(await this.readJsonBody(req)));
      } catch (error) {
        throw new HttpError(
          400,
          error instanceof Error ? error.message : "invalid_admin_config_patch",
          "invalid_admin_config_patch",
        );
      }
      return;
    }
    if (
      req.method === "POST" &&
      (pathname === "/engram/v1/external-wikis/search" ||
        pathname === "/remnic/v1/external-wikis/search")
    ) {
      this.enforceTokenOp("external_wiki_search");
      const operation = getOperation("external_wiki_search");
      if (!operation) throw new EngramAccessInputError("external_wiki_search operation is not registered");
      const output = await operation.run(await this.readJsonBody(req), { service: this.service });
      if (!output || typeof output !== "object" || !("result" in output)) {
        throw new Error("external_wiki_search returned an invalid operation result");
      }
      this.respondJson(res, 200, output.result);
      return;
    }
    if (
      req.method === "POST" &&
      (pathname === "/engram/v1/memories/search" ||
        pathname === "/remnic/v1/memories/search")
    ) {
      // Semantic memory search over HTTP. `GET /engram/v1/memories` is a
      // substring browse; this is the QMD-backed ranked search the MCP
      // `memory_search` tool already exposes, reachable by HTTP-only clients.
      this.enforceTokenOp("memory_search"); // boundary dispatch (issue #1525)
      const operation = getOperation("memory_search");
      if (!operation) {
        throw new EngramAccessInputError(
          "access-boundary: operation not registered: memory_search",
        );
      }
      // The body `namespace` is user-controlled, so it must pass the same
      // effective-namespace allow-list gate as every other namespace-scoped
      // route (issue #1850 finding 2); the authenticated principal — never a
      // client-supplied value — then scopes the readable namespace fan-out.
      const body = this.gatedBodyNamespace(req, await this.readJsonBody(req));
      // memory_search is a FAN-OUT: an absent namespace searches everything
      // the principal can read. A namespace-scoped bearer may read fewer
      // namespaces than its principal, so leaving it absent would return
      // results the token was never authorized for. The allow-list gate above
      // already proved the server default is permitted for such a token, so
      // binding the effective namespace explicitly is both safe and closed.
      if (body.namespace === undefined && tokenCapabilityStore.getStore()?.namespaces !== undefined) {
        body.namespace = this.service.configRef?.defaultNamespace ?? "";
      }
      const output = (await operation.run(body, {
        service: this.service,
        authenticatedPrincipal: this.resolveRequestPrincipal(req),
      })) as { result: unknown };
      this.respondJson(res, 200, output.result);
      return;
    }

    if (req.method === "POST" && pathname === "/engram/v1/recall") {
      this.enforceTokenOp("recall"); // boundary dispatch (issue #1525)
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
        sourceConnector: this.resolveConnector(req),
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
        abortSignal,
      });
      this.respondJson(res, 200, response);
      return;
    }

    if (req.method === "POST" && pathname === "/engram/v1/coding-context") {
      this.enforceTokenOp("set_coding_context"); // boundary dispatch (issue #1525)
      const body = await this.readValidatedBody(req, "setCodingContext");
      const codingContext =
        body.codingContext !== undefined
          ? body.codingContext
          : typeof body.projectTag === "string"
            ? codingContextFromProjectTag(body.projectTag)
            : (() => {
                throw new EngramAccessInputError("codingContext or projectTag is required");
              })();
      this.service.setCodingContext({
        sessionKey: body.sessionKey,
        codingContext,
      });
      this.respondJson(res, 200, { ok: true });
      return;
    }

    if (
      req.method === "POST" &&
      (pathname === "/engram/v1/capsules/export" || pathname === "/remnic/v1/capsules/export")
    ) {
      this.enforceTokenOp("capsule_export"); // boundary dispatch (issue #1525)
      const body = await this.readValidatedBody(req, "capsuleExport");
      this.ensureWriteRateLimitAvailable(req);
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
      this.recordWriteRateLimitHit(req);
      this.respondJson(res, 200, result);
      return;
    }

    if (
      req.method === "POST" &&
      (pathname === "/engram/v1/capsules/import" || pathname === "/remnic/v1/capsules/import")
    ) {
      this.enforceTokenOp("capsule_import"); // boundary dispatch (issue #1525)
      const body = await this.readValidatedBody(req, "capsuleImport");
      this.ensureWriteRateLimitAvailable(req);
      const result = await this.service.capsuleImport({
        archivePath: expandTildePath(body.archivePath),
        namespace: this.resolveNamespace(req, body.namespace),
        principal: this.resolveRequestPrincipal(req),
        mode: body.mode,
        passphrase: body.passphrase,
      });
      this.recordWriteRateLimitHit(req);
      this.respondJson(res, 200, result);
      return;
    }

    if (
      req.method === "GET" &&
      (pathname === "/engram/v1/offline-sync/capabilities" ||
        pathname === "/remnic/v1/offline-sync/capabilities")
    ) {
      this.enforceTokenOp("offline_sync_snapshot");
      this.respondJson(res, 200, {
        version: 1,
        convergenceFinalization: true,
        manifestStream: true,
      });
      return;
    }

    if (
      req.method === "GET" &&
      (pathname === "/engram/v1/offline-sync/snapshot" || pathname === "/remnic/v1/offline-sync/snapshot")
    ) {
      this.enforceTokenOp("offline_sync_snapshot"); // boundary dispatch (issue #1525)
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
      req.method === "GET" &&
      (pathname === "/engram/v1/offline-sync/snapshot-stream" ||
        pathname === "/remnic/v1/offline-sync/snapshot-stream")
    ) {
      this.enforceTokenOp("offline_sync_snapshot_stream"); // boundary dispatch (issue #1525)
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
        includeContentRaw !== "false"
      ) {
        throw new EngramAccessInputError("snapshot-stream content must be false");
      }
      const namespaceParam = parsed.searchParams.get("namespace");
      const result = await this.service.offlineSyncSnapshotStream({
        namespace: this.resolveNamespace(
          req,
          namespaceParam && namespaceParam.length > 0 ? namespaceParam : undefined,
        ),
        principal: this.resolveRequestPrincipal(req),
        includeTranscripts: includeTranscriptsRaw !== "false",
        includeContent: false,
        signal: this.createRequestAbortSignal(req, res),
      });
      await respondOfflineSnapshotStream(res, result, correlationIdStore.getStore());
      return;
    }
    if (
      req.method === "GET" &&
      (pathname === "/engram/v1/offline-sync/manifest-stream" ||
        pathname === "/remnic/v1/offline-sync/manifest-stream")
    ) {
      this.enforceTokenOp("offline_sync_snapshot_stream");
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
      if (includeContentRaw !== null && includeContentRaw !== "false") {
        throw new EngramAccessInputError("manifest-stream content must be false");
      }
      const namespaceParam = parsed.searchParams.get("namespace");
      const result = await this.service.offlineSyncManifestStream({
        namespace: this.resolveNamespace(
          req,
          namespaceParam && namespaceParam.length > 0 ? namespaceParam : undefined,
        ),
        principal: this.resolveRequestPrincipal(req),
        includeTranscripts: includeTranscriptsRaw !== "false",
        signal: this.createRequestAbortSignal(req, res),
      });
      await respondOfflineManifestStream(res, result, correlationIdStore.getStore());
      return;
    }


    if (
      req.method === "POST" &&
      (pathname === "/engram/v1/offline-sync/snapshot" || pathname === "/remnic/v1/offline-sync/snapshot")
    ) {
      this.enforceTokenOp("offline_sync_snapshot"); // boundary dispatch (issue #1525)
      const body = await this.readValidatedBody(
        req,
        "offlineSyncSnapshot",
        OFFLINE_SYNC_SNAPSHOT_BASE_MAX_BODY_BYTES,
      );
      const result = await this.service.offlineSyncSnapshot({
        namespace: this.resolveNamespace(req, body.namespace),
        principal: this.resolveRequestPrincipal(req),
        includeTranscripts: body.includeTranscripts,
        includeContent: body.includeContent,
        baseFiles: body.baseFiles,
        ...(body.baseCapturedAt ? { baseCapturedAt: new Date(body.baseCapturedAt) } : {}),
        signal: this.createRequestAbortSignal(req, res),
      });
      this.respondJson(res, 200, result);
      return;
    }

    if (
      req.method === "POST" &&
      (pathname === "/engram/v1/offline-sync/files" || pathname === "/remnic/v1/offline-sync/files")
    ) {
      this.enforceTokenOp("offline_sync_files"); // boundary dispatch (issue #1525)
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
      this.enforceTokenOp("offline_sync_file_content"); // boundary dispatch (issue #1525)
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
      (
        pathname === "/engram/v1/offline-sync/apply-file-content" ||
        pathname === "/remnic/v1/offline-sync/apply-file-content"
      )
    ) {
      this.enforceTokenOp("offline_sync_apply_file_content"); // boundary dispatch (issue #1525)
      const namespaceParam = parsed.searchParams.get("namespace");
      const bytes = this.readRequiredIntegerHeader(req, "x-remnic-file-bytes");
      const offset = this.readOptionalIntegerHeader(req, "x-remnic-chunk-offset") ?? 0;
      const content = await this.readBinaryBody(req, OFFLINE_SYNC_FILE_CONTENT_MAX_CHUNK_BYTES);
      const result = await this.service.offlineSyncApplyFileContent({
        namespace: this.resolveNamespace(
          req,
          namespaceParam && namespaceParam.length > 0 ? namespaceParam : undefined,
        ),
        principal: this.resolveRequestPrincipal(req),
        includeTranscripts: this.parseOptionalBooleanHeader(
          req,
          "x-remnic-include-transcripts",
          true,
        ),
        sourceId: this.readRequiredDecodedHeader(req, "x-remnic-source-id"),
        path: this.readRequiredDecodedHeader(req, "x-remnic-file-path"),
        sha256: this.readRequiredHeader(req, "x-remnic-file-sha256"),
        bytes,
        mtimeMs: this.readRequiredNumberHeader(req, "x-remnic-file-mtime-ms"),
        offset,
        baseSha256: this.readOptionalHeader(req, "x-remnic-base-sha256"),
        content,
      });
      this.respondJson(res, 200, result);
      return;
    }


    if (
      req.method === "POST" &&
      (
        pathname === "/engram/v1/offline-sync/convergence-complete" ||
        pathname === "/remnic/v1/offline-sync/convergence-complete"
      )
    ) {
      void getOperation("offline_sync_apply_file_content");
      this.enforceTokenAnyOf(["offline_sync_apply_file_content", "offline_sync_apply"]);
      const namespaceParams = parsed.searchParams.getAll("namespace").filter(Boolean);
      const requestedNamespaces: Array<string | undefined> =
        namespaceParams.length > 0 ? namespaceParams : [undefined];
      const namespaces = requestedNamespaces
        .map((namespace) => this.resolveNamespace(req, namespace))
        .filter((namespace): namespace is string => namespace !== undefined);
      this.ensureWriteRateLimitAvailable(req);
      const result = await this.service.offlineSyncFinalizeConvergence({
        ...(namespaces.length > 0 ? { namespaces } : {}),
        principal: this.resolveRequestPrincipal(req),
        sourceId: this.readRequiredDecodedHeader(req, "x-remnic-source-id"),
      });
      this.recordWriteRateLimitHit(req);
      this.respondJson(res, 200, result);
      return;
    }

    if (
      req.method === "POST" &&
      (pathname === "/engram/v1/offline-sync/apply" || pathname === "/remnic/v1/offline-sync/apply")
    ) {
      this.enforceTokenOp("offline_sync_apply"); // boundary dispatch (issue #1525)
      const body = await this.readValidatedBody(req, "offlineSyncApply", OFFLINE_SYNC_APPLY_MAX_BODY_BYTES);
      const result = await this.service.offlineSyncApply({
        namespace: this.resolveNamespace(req, body.namespace),
        principal: this.resolveRequestPrincipal(req),
        changeset: body.changeset,
        returnCurrentFiles: body.returnCurrentFiles,
      });
      this.respondJson(res, 200, result);
      return;
    }

    if (req.method === "POST" && pathname === "/engram/v1/recall/explain") {
      this.enforceTokenOp("recall_explain"); // boundary dispatch (issue #1525)
      const body = await this.readValidatedBody(req, "recallExplain");
      const response = await this.service.recallExplain({
        sessionKey: body.sessionKey,
        namespace: this.resolveNamespace(req, body.namespace),
        authenticatedPrincipal: this.resolveRequestPrincipal(req),
      });
      this.respondJson(res, 200, response);
      return;
    }

    if (
      req.method === "POST" &&
      (pathname === "/engram/v1/action-confidence" || pathname === "/remnic/v1/action-confidence")
    ) {
      this.enforceTokenOp("action_confidence"); // boundary dispatch (issue #1525)
      const body = await this.readValidatedBody(req, "actionConfidence");
      this.respondJson(res, 200, await this.service.actionConfidence(body));
      return;
    }

    if (req.method === "GET" && pathname === "/engram/v1/recall/tier-explain") {
      this.enforceTokenOp("recall_tier_explain"); // boundary dispatch (issue #1525)
      const sessionParam = parsed.searchParams.get("session");
      const sessionKey = sessionParam && sessionParam.length > 0 ? sessionParam : undefined;
      const namespaceParam = parsed.searchParams.get("namespace");
      const namespace = this.resolveNamespace(
        req,
        namespaceParam && namespaceParam.length > 0 ? namespaceParam : undefined,
      );
      const payload = await this.service.recallTierExplain(sessionKey, namespace, this.resolveRequestPrincipal(req));
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
      this.enforceTokenOp("recall_xray"); // boundary dispatch (issue #1525)
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
          sourceConnector: this.resolveConnector(req),
          ...(disclosure !== undefined ? { disclosure } : {}),
        });
      } catch (err) {
        // Only surface the message for the deliberately-prefixed recallXray
        // input-validation errors, and only when it is a real Error.message —
        // never String(err) of an arbitrary throw, which CodeQL flags as
        // stack-trace exposure (js/stack-trace-exposure). Validation errors are
        // always thrown as Error instances (see access-service.ts), so this is
        // behavior-preserving; anything else is a server-side fault and is
        // rethrown so the outer `handle()` catch returns 500 + logs it.
        if (err instanceof Error && err.message.startsWith("recallXray:")) {
          this.respondJson(res, 400, {
            error: "invalid_request",
            code: "invalid_request",
            message: err.message,
          });
          return;
        }
        throw err;
      }
      this.respondJson(res, 200, payload);
      return;
    }

    if (req.method === "GET" && pathname === "/engram/v1/namespace/writable") {
      if (!getOperation("namespace_writable")) throw new Error("namespace_writable operation is not registered");
      this.respondJson(
        res,
        200,
        await resolveQueryNamespaceWritablePreflight(
          tokenCapabilityStore.getStore(),
          parsed.searchParams,
          this.resolveRequestPrincipal(req),
          this.service.configRef.defaultNamespace,
          (request) => this.service.namespaceWritablePreflight(request),
        ),
      );
      return;
    }

    if (
      req.method === "GET" &&
      (pathname === "/engram/v1/wearables/status" || pathname === "/remnic/v1/wearables/status")
    ) {
      this.enforceTokenOp("wearables_status"); // boundary dispatch (issue #1525)
      this.respondJson(res, 200, await this.service.wearablesStatus(this.wearablesScope(req, parsed.searchParams.get("namespace") ?? undefined, parsed.searchParams.get("sessionKey") ?? undefined)));
      return;
    }

    if (
      req.method === "POST" &&
      (pathname === "/engram/v1/wearables/sync" || pathname === "/remnic/v1/wearables/sync")
    ) {
      this.enforceTokenOp("wearables_sync"); // boundary dispatch (issue #1525)
      const body = (await this.readJsonBody(req)) as Record<string, unknown>;
      const source = optionalQueryString(body.source, "source");
      const date = optionalQueryString(body.date, "date");
      let days: number | undefined;
      if (body.days !== undefined && body.days !== null) {
        if (
          typeof body.days !== "number" ||
          !Number.isInteger(body.days) ||
          body.days < 1
        ) {
          throw new EngramAccessInputError(
            `days must be a positive integer (got ${JSON.stringify(body.days)})`,
          );
        }
        days = body.days;
      }
      if (body.forceMemories !== undefined && typeof body.forceMemories !== "boolean") {
        throw new EngramAccessInputError(
          `forceMemories must be a boolean (got ${JSON.stringify(body.forceMemories)})`,
        );
      }
      try {
        const summaries = await this.service.wearablesSync({ source, date, days, forceMemories: body.forceMemories === true, ...this.wearablesScope(req, optionalQueryString(body.namespace, "namespace"), optionalQueryString(body.sessionKey, "sessionKey")) });
        this.respondJson(res, 200, { summaries });
      } catch (err) {
        if (this.respondWearablesError(res, err)) return;
        throw err;
      }
      return;
    }

    if (
      req.method === "GET" &&
      (pathname === "/engram/v1/wearables/transcript" || pathname === "/remnic/v1/wearables/transcript")
    ) {
      this.enforceTokenOp("transcript_day"); // boundary dispatch (issue #1525)
      const date = parsed.searchParams.get("date");
      if (!date || date.trim().length === 0) {
        throw new EngramAccessInputError(
          "date query parameter is required (YYYY-MM-DD)",
        );
      }
      const sourceParam = parsed.searchParams.get("source");
      try {
        const transcripts = await this.service.wearablesTranscriptDay({ date, source: sourceParam && sourceParam.length > 0 ? sourceParam : undefined, ...this.wearablesScope(req, parsed.searchParams.get("namespace") ?? undefined, parsed.searchParams.get("sessionKey") ?? undefined) });
        this.respondJson(res, 200, { transcripts });
      } catch (err) {
        if (this.respondWearablesError(res, err)) return;
        throw err;
      }
      return;
    }

    if (
      req.method === "GET" &&
      (pathname === "/engram/v1/wearables/transcripts/search" ||
        pathname === "/remnic/v1/wearables/transcripts/search")
    ) {
      this.enforceTokenOp("transcript_search"); // boundary dispatch (issue #1525)
      const queryParam = parsed.searchParams.get("q");
      if (!queryParam || queryParam.trim().length === 0) {
        throw new EngramAccessInputError(
          "q query parameter is required and must be non-empty",
        );
      }
      try {
        const results = await this.service.wearablesTranscriptSearch({ query: queryParam, source: nonEmptyQueryParam(parsed.searchParams.get("source")), from: nonEmptyQueryParam(parsed.searchParams.get("from")), to: nonEmptyQueryParam(parsed.searchParams.get("to")), limit: positiveIntQueryParam(parsed.searchParams.get("limit"), "limit"), ...this.wearablesScope(req, parsed.searchParams.get("namespace") ?? undefined, parsed.searchParams.get("sessionKey") ?? undefined) });
        this.respondJson(res, 200, { results });
      } catch (err) {
        if (this.respondWearablesError(res, err)) return;
        throw err;
      }
      return;
    }

    if (
      req.method === "GET" &&
      (pathname === "/engram/v1/wearables/memories" || pathname === "/remnic/v1/wearables/memories")
    ) {
      this.enforceTokenOp("transcript_memories"); // boundary dispatch (issue #1525)
      try {
        const memories = await this.service.wearablesTranscriptMemories({ source: nonEmptyQueryParam(parsed.searchParams.get("source")), date: nonEmptyQueryParam(parsed.searchParams.get("date")), limit: positiveIntQueryParam(parsed.searchParams.get("limit"), "limit"), ...this.wearablesScope(req, parsed.searchParams.get("namespace") ?? undefined, parsed.searchParams.get("sessionKey") ?? undefined) });
        this.respondJson(res, 200, { memories });
      } catch (err) {
        if (this.respondWearablesError(res, err)) return;
        throw err;
      }
      return;
    }

    if (req.method === "GET" && (pathname === "/engram/v1/meetings" || pathname === "/remnic/v1/meetings")) {
      this.enforceTokenOp("meetings_list"); await respondMeetingsList(res, this.respondJson.bind(this), this.service, nonEmptyQueryParam(parsed.searchParams.get("date")), this.wearablesScope(req, parsed.searchParams.get("namespace") ?? undefined, parsed.searchParams.get("sessionKey") ?? undefined)); return; }
    if (req.method === "POST" && (pathname === "/engram/v1/meetings/build" || pathname === "/remnic/v1/meetings/build")) {
      this.enforceTokenOp("meetings_build"); await respondMeetingsBuild(req, res, this.respondJson.bind(this), this.readJsonBody.bind(this), this.service, { enforceQuota: () => this.ensureWriteRateLimitAvailable(req), recordHit: () => this.recordWriteRateLimitHit(req) }, (ns, sk) => this.wearablesScope(req, ns, sk)); return; }
    const meetingGetEngram = /^\/engram\/v1\/meetings\/([^/]+)$/.exec(pathname);
    if (req.method === "GET" && meetingGetEngram) { this.enforceTokenOp("meetings_get"); await respondMeetingsGet(res, this.respondJson.bind(this), this.service, meetingGetEngram[1] ?? "", this.wearablesScope(req, parsed.searchParams.get("namespace") ?? undefined, parsed.searchParams.get("sessionKey") ?? undefined)); return; }
    const meetingGetRemnic = /^\/remnic\/v1\/meetings\/([^/]+)$/.exec(pathname);
    if (req.method === "GET" && meetingGetRemnic) { this.enforceTokenOp("meetings_get"); await respondMeetingsGet(res, this.respondJson.bind(this), this.service, meetingGetRemnic[1] ?? "", this.wearablesScope(req, parsed.searchParams.get("namespace") ?? undefined, parsed.searchParams.get("sessionKey") ?? undefined)); return; }

    if (req.method === "POST" && pathname === "/engram/v1/observe") {
      this.enforceTokenOp("observe"); // boundary dispatch (issue #1525)
      const body = await this.readValidatedBody(req, "observe");
      const response = await this.service.observe(
        {
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
          // Issue #1649: optional server-side dedup key for retried POSTs.
          idempotencyKey: body.idempotencyKey,
          // Forward cwd/projectTag for auto git-context resolution (issue #569).
          cwd: body.cwd,
          projectTag: body.projectTag,
          // Phase 1 provenance: server-resolved connector identity from the
          // bearer token (REST path, mirroring the MCP tools/call dispatch).
          sourceConnector: this.resolveConnector(req),
        },
        // Enforce the write-quota INSIDE the service's idempotency lock
        // (beforeExecute, only on a real miss). A retried observe that hits the
        // replay path must NOT be rejected with 429 — that is exactly the
        // response-lost-after-process case the dedup exists for. The original
        // attempt may have consumed the last quota slot; the retry returns the
        // cached response without requiring another. Matches memory_store's
        // hook-in-the-lock pattern (#1434 invariant).
        { enforceWriteQuota: () => this.ensureWriteRateLimitAvailable(req) },
      );
      // A replayed (deduplicated) observe must not consume a second write-quota
      // slot — same invariant as memory_store/suggestion_submit (#1434).
      if (this.shouldCountWriteRateLimit(response as { dryRun?: boolean; idempotencyReplay?: boolean })) {
        this.recordWriteRateLimitHit(req);
      }
      this.respondJson(res, 202, response);
      return;
    }

    if (req.method === "POST" && pathname === "/engram/v1/lcm/search") {
      this.enforceTokenOp("lcm_search"); // boundary dispatch (issue #1525)
      const body = await this.readValidatedBody(req, "lcmSearch");
      const response = await this.service.lcmSearch({
        query: body.query,
        sessionKey: body.sessionKey,
        sessionPrefix: body.sessionPrefix,
        namespace: this.resolveNamespace(req, body.namespace),
        authenticatedPrincipal: this.resolveRequestPrincipal(req),
        limit: body.limit,
      });
      this.respondJson(res, 200, response);
      return;
    }
    if (await maybeHandleLifecycleFlush(
      this.lifecycleFlushDeps(req, res), req.method, pathname, abortSignal,
    )) return;

    if (req.method === "GET" && pathname === "/engram/v1/lcm/status") {
      this.enforceTokenOp("lcm_status"); // boundary dispatch (issue #1525)
      this.respondJson(res, 200, await this.service.lcmStatus());
      return;
    }

    // Remnic Relay mission receipts (issue #1966). These two routes share the
    // access-boundary schemas and namespace-resolved storage contract. The
    // browser receives an already-reduced snapshot; it never scans general
    // memories, recall logs, or production state.
    const relayEventMatch = /^\/engram\/v1\/relay\/missions\/([^/]+)\/events$/.exec(pathname);
    if (req.method === "POST" && relayEventMatch) {
      const missionId = decodeRelayMissionIdSegment(relayEventMatch[1] ?? "");
      const body = await this.readJsonBody(req);
      const unexpectedFields = Object.keys(body).filter(
        (key) => key !== "namespace" && key !== "event",
      );
      if (unexpectedFields.length > 0) {
        throw new EngramAccessInputError(
          `Relay append body contains unexpected field(s): ${unexpectedFields.sort().join(", ")}`,
        );
      }
      if (!Object.prototype.hasOwnProperty.call(body, "event")) {
        throw new EngramAccessInputError("Relay append body must contain an event object");
      }
      if (
        Object.prototype.hasOwnProperty.call(body, "namespace") &&
        body.namespace !== undefined &&
        body.namespace !== null &&
        typeof body.namespace !== "string"
      ) {
        throw new EngramAccessInputError("namespace must be a string when provided");
      }
      rejectBlankRelayNamespace(
        typeof body.namespace === "string" ? body.namespace : undefined,
      );
      const namespace = this.resolveNamespace(
        req,
        typeof body.namespace === "string" ? body.namespace : undefined,
      );
      const op = getOperation("relay_mission_append");
      if (!op) {
        throw new Error("access-boundary: operation not registered: relay_mission_append");
      }
      let writeQuota: WriteRateLimitReservation | undefined;
      try {
        const output = (await op.run(
          { missionId, namespace, event: body.event },
          {
            service: this.service,
            authenticatedPrincipal: this.resolveRequestPrincipal(req),
            hooks: {
              enforceWriteQuota: () => {
                writeQuota ??= this.reserveWriteRateLimitSlot(req);
              },
            },
          },
        )) as { result: { appended: boolean; replayed: boolean; event: unknown } };
        if (output.result.appended) {
          writeQuota?.commit();
          writeQuota = undefined;
        }
        this.respondJson(res, output.result.appended ? 201 : 200, output.result);
      } finally {
        writeQuota?.release();
      }
      return;
    }

    const relayMissionMatch = /^\/engram\/v1\/relay\/missions\/([^/]+)$/.exec(pathname);
    if (req.method === "GET" && relayMissionMatch) {
      const missionId = decodeRelayMissionIdSegment(relayMissionMatch[1] ?? "");
      rejectBlankRelayNamespace(parsed.searchParams.get("namespace"));
      const namespace = this.resolveNamespace(
        req,
        parsed.searchParams.get("namespace") ?? undefined,
      );
      const op = getOperation("relay_mission_read");
      if (!op) {
        throw new Error("access-boundary: operation not registered: relay_mission_read");
      }
      const authenticatedPrincipal = this.resolveRequestPrincipal(req)?.trim() || undefined;
      const output = (await op.run(
        {
          missionId,
          namespace,
          since: parsed.searchParams.get("since") ?? undefined,
          until: parsed.searchParams.get("until") ?? undefined,
          limit: parsed.searchParams.get("limit") ?? undefined,
        },
        {
          service: this.service,
          authenticatedPrincipal,
        },
      )) as { result: unknown };
      res.setHeader("cache-control", "no-store");
      if (authenticatedPrincipal !== undefined) {
        try {
          // Percent-encode so every configured principal remains a valid HTTP
          // header value. Mission Control decodes this before constructing the
          // server-validated human approval envelope.
          res.setHeader("x-remnic-authenticated-principal", encodeURIComponent(authenticatedPrincipal));
        } catch {
          // An invalid Unicode principal cannot be represented as a Relay actor
          // identifier. Omit it so Mission Control fails closed at the gate.
        }
      }
      this.respondJson(res, 200, output.result);
      return;
    }

    if (req.method === "POST" && pathname === "/engram/v1/memories") {
      // Migrated through the access boundary (issue #1525): the registry
      // entry owns schema validation, normalization, and service dispatch.
      // The HTTP transport resolves the request-scoped namespace and principal
      // BEFORE the boundary re-validates the cleaned envelope. The write-quota
      // hook is forwarded via ctx.hooks so it still fires atomically inside
      // the service's idempotent-write lock — never before, never on a replay
      // (#1434 invariant preserved by the boundary migration).
      const body = await this.readValidatedBody(req, "memoryStore");
      const envelope = {
        ...body,
        namespace: this.resolveNamespace(req, body.namespace),
      };
      const op = getOperation("memory_store");
      if (!op) {
        throw new EngramAccessInputError("access-boundary: operation not registered: memory_store");
      }
      const output = (await op.run(envelope, {
        service: this.service,
        authenticatedPrincipal: this.resolveRequestPrincipal(req),
        hooks: { enforceWriteQuota: () => this.ensureWriteRateLimitAvailable(req) },
        // Phase 1 provenance: server-resolved connector identity from the
        // bearer token (REST path, mirroring the MCP tools/call dispatch).
        sourceConnector: this.resolveConnector(req),
      })) as { result: EngramAccessWriteResponse };
      const response = output.result;
      if (this.shouldCountWriteRateLimit(response as { dryRun?: boolean; idempotencyReplay?: boolean })) {
        this.recordWriteRateLimitHit(req);
      }
      this.respondJson(res, this.writeResponseStatus(response), response);
      return;
    }

    if (req.method === "POST" && pathname === "/engram/v1/coding/decisions") {
      // Migrated through the access boundary (issue #1525/#1548): the
      // registry entry owns schema validation and service dispatch. HTTP
      // resolves the request principal; the boundary re-validates the
      // cleaned envelope. record/supersede persist decision memories, so they
      // are gated by the same 30/min write quota as /engram/v1/memories,
      // suggestions, and observe; list/get are pure reads and stay uncounted
      // (review P2: apply write quotas to decision writes).
      const body = await this.readJsonBody(req);
      const isWriteSubcommand =
        body.subcommand === "record" || body.subcommand === "supersede";
      if (isWriteSubcommand) {
        this.ensureWriteRateLimitAvailable(req);
      }
      const op = getOperation("coding_decision");
      if (!op) {
        throw new EngramAccessInputError("access-boundary: operation not registered: coding_decision");
      }
      const output = (await op.run(this.gatedBodyNamespace(req, body), {
        service: this.service,
        authenticatedPrincipal: this.resolveRequestPrincipal(req),
        sourceConnector: this.resolveConnector(req),
      })) as { result: unknown };
      if (isWriteSubcommand) {
        this.recordWriteRateLimitHit(req);
      }
      this.respondJson(res, 200, output.result);
      return;
    }

    if (req.method === "POST" && pathname === "/engram/v1/coding/architecture") {
      // Migrated through the access boundary (issue #1525/#1548 PR3):
      // refresh persists the card, so it is gated by the 30/min write quota;
      // get is a pure read and stays uncounted.
      const body = await this.readJsonBody(req);
      const isWriteSubcommand = body.subcommand === "refresh";
      if (isWriteSubcommand) {
        this.ensureWriteRateLimitAvailable(req);
      }
      const op = getOperation("coding_architecture");
      if (!op) {
        throw new EngramAccessInputError("access-boundary: operation not registered: coding_architecture");
      }
      const output = (await op.run(this.gatedBodyNamespace(req, body), {
        service: this.service,
        authenticatedPrincipal: this.resolveRequestPrincipal(req),
        sourceConnector: this.resolveConnector(req),
      })) as { result: unknown };
      if (isWriteSubcommand) {
        this.recordWriteRateLimitHit(req);
      }
      this.respondJson(res, 200, output.result);
      return;
    }

    if (req.method === "POST" && pathname === "/engram/v1/coding/delta") {
      // Migrated through the access boundary (issue #1525/#1548 PR4):
      // get is read-only with respect to user memory content. It DOES write
      // the operator-side state file (last-seen-head marker), but that is
      // bookkeeping — the same way calibration.ts writes are uncounted. No
      // write-quota enforcement.
      const body = await this.readJsonBody(req);
      const op = getOperation("coding_delta");
      if (!op) {
        throw new EngramAccessInputError("access-boundary: operation not registered: coding_delta");
      }
      const output = (await op.run(this.gatedBodyNamespace(req, body), {
        service: this.service,
        authenticatedPrincipal: this.resolveRequestPrincipal(req),
      })) as { result: unknown };
      this.respondJson(res, 200, output.result);
      return;
    }

    // ── Correction Contract (issue #1580) — plan / apply / pending ─────────
    // All three routes dispatch through the boundary operations so schema
    // validation + namespace policy reach every correction path (rule 22/39).
    if (req.method === "POST" && pathname === "/engram/v1/correction/plan") {
      // Planning persists a pending plan JSON file on every successful call
      // (review thread UhA), so it is a state write for rate-limit purposes —
      // mirror the apply route's precheck + accounting to bound files under
      // state/corrections/pending instead of letting an HTTP client create
      // unbounded plan files without consuming write quota.
      this.ensureWriteRateLimitAvailable(req);
      const body = await this.readJsonBody(req);
      const op = getOperation("memory_correct_plan");
      if (!op) {
        throw new EngramAccessInputError("access-boundary: operation not registered: memory_correct_plan");
      }
      const output = (await op.run(this.gatedBodyNamespace(req, body), {
        service: this.service,
        authenticatedPrincipal: this.resolveRequestPrincipal(req),
      })) as { result: unknown };
      this.recordWriteRateLimitHit(req);
      this.respondJson(res, 200, output.result);
      return;
    }

    if (req.method === "POST" && pathname === "/engram/v1/correction/apply") {
      this.ensureWriteRateLimitAvailable(req);
      const body = await this.readJsonBody(req);
      const op = getOperation("memory_correct_apply");
      if (!op) {
        throw new EngramAccessInputError("access-boundary: operation not registered: memory_correct_apply");
      }
      const output = (await op.run(this.gatedBodyNamespace(req, body), {
        service: this.service,
        authenticatedPrincipal: this.resolveRequestPrincipal(req),
      })) as { result: unknown };
      this.recordWriteRateLimitHit(req);
      this.respondJson(res, 200, output.result);
      return;
    }

    if (req.method === "GET" && pathname === "/engram/v1/correction/pending") {
      const op = getOperation("correction_pending");
      if (op) {
        const output = (await op.run(
          { namespace: this.resolveNamespace(req, parsed.searchParams.get("namespace") ?? undefined), sessionKey: parsed.searchParams.get("sessionKey") ?? undefined },
          { service: this.service, authenticatedPrincipal: this.resolveRequestPrincipal(req) },
        )) as { result: unknown };
        this.respondJson(res, 200, output.result);
      } else {
        const namespace = this.resolveNamespace(req, parsed.searchParams.get("namespace") ?? undefined);
        const sessionKey = parsed.searchParams.get("sessionKey") ?? undefined;
        const plans = await this.service.correctionListPending({
          ...(namespace ? { namespace } : {}),
          ...(sessionKey ? { sessionKey } : {}),
          principal: this.resolveRequestPrincipal(req),
        });
        this.respondJson(res, 200, plans);
      }
      return;
    }

    if (req.method === "POST" && pathname === "/engram/v1/suggestions") {
      this.enforceTokenOp("suggestion_submit"); // boundary dispatch (issue #1525)
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
        cwd: body.cwd,
        projectTag: body.projectTag,
        // Phase 1 provenance: server-resolved connector identity from the
        // bearer token (REST path, mirroring the MCP tools/call dispatch).
        sourceConnector: this.resolveConnector(req),
      };
      // Quota enforcement is solely authoritative inside suggestionSubmit
      // (enforceWriteQuota), atomic with the real miss and never on a replay; no
      // HTTP pre-check, so a stale peek can't 429 a safe replay (#1434 Codex review).
      const response = await this.service.suggestionSubmit(request, {
        enforceWriteQuota: () => this.ensureWriteRateLimitAvailable(req),
      });
      if (this.shouldCountWriteRateLimit(response as { dryRun?: boolean; idempotencyReplay?: boolean })) {
        this.recordWriteRateLimitHit(req);
      }
      this.respondJson(res, this.writeResponseStatus(response), response);
      return;
    }

    if (req.method === "GET" && pathname === "/engram/v1/memories") {
      this.enforceTokenOp("memory_list"); // boundary dispatch (issue #1525)
      const limit = parseStrictIntegerQuery(parsed.searchParams.get("limit"), "limit", 50, 1);
      const offset = parseStrictIntegerQuery(parsed.searchParams.get("offset"), "offset", 0, 0);
      const sort = parseMemorySort(parsed.searchParams.get("sort"));
      const response = await this.service.memoryBrowse({
        query: parsed.searchParams.get("q") ?? undefined,
        status: parsed.searchParams.get("status") ?? undefined,
        category: parsed.searchParams.get("category") ?? undefined,
        namespace: this.resolveNamespace(req, parsed.searchParams.get("namespace") ?? undefined),
        authenticatedPrincipal: this.resolveRequestPrincipal(req),
        sort,
        limit,
        offset,
      });
      this.respondJson(res, 200, response);
      return;
    }

    if (req.method === "GET" && pathname === "/engram/v1/recall/timings") {
      const op = getOperation("recall_timings"); // boundary dispatch (issue #1830)
      if (!op) {
        throw new Error("access-boundary: operation not registered: recall_timings");
      }
      // Live diagnostic route; no response (success or denial) is cacheable.
      // Set before dispatch so the 403 path carries the header too.
      res.setHeader("cache-control", "no-store");
      // Dispatch through the registered operation so the HTTP route and the
      // boundary registration share one gate. The server's own principal is
      // the transport-level operator fallback; a configured
      // agentAccessHttp.principal outranks it.
      const output = (await op.run({}, {
        service: this.service,
        authenticatedPrincipal: this.resolveRequestPrincipal(req),
        operatorPrincipal: this.authenticatedPrincipal,
      })) as { result: unknown };
      this.respondJson(res, 200, output.result);
      return;
    }

    const memoryMatch = pathname.match(/^\/engram\/v1\/memories\/([^/]+)$/);
    if (req.method === "GET" && memoryMatch) {
      const memoryId = decodeURIComponent(memoryMatch[1] ?? "");
      const namespace = this.resolveNamespace(req, parsed.searchParams.get("namespace") ?? undefined);
      // Issue #1582 — thread the transport session key so a `[m:xxxx]` handle in
      // the path resolves against this session's recall history (codex review).
      // resolveRequestIdentity reads it from adapter identity / request headers.
      const sessionKey =
        this.resolveRequestIdentity(req).sessionKey
        ?? parsed.searchParams.get("session")
        ?? parsed.searchParams.get("sessionKey")
        ?? undefined;
      // Migrated through the access boundary (issue #1525): the registry
      // entry owns memoryId presence/shape validation (rule 51: reject empty
      // ids loudly instead of silently passing "" into the service) and the
      // service dispatch.
      const op = getOperation("memory_get");
      if (!op) {
        throw new EngramAccessInputError("access-boundary: operation not registered: memory_get");
      }
      const output = (await op.run(
        { memoryId, namespace: namespace ?? null, sessionKey: sessionKey ?? null },
        { service: this.service, authenticatedPrincipal: this.resolveRequestPrincipal(req) },
      )) as { result: EngramAccessMemoryResponse };
      const response = output.result;
      this.respondJson(res, response.found ? 200 : 404, response);
      return;
    }

    const timelineMatch = pathname.match(/^\/engram\/v1\/memories\/([^/]+)\/timeline$/);
    if (req.method === "GET" && timelineMatch) {
      this.enforceTokenOp("memory_timeline"); // boundary dispatch (issue #1525)
      const memoryId = decodeURIComponent(timelineMatch[1] ?? "");
      const namespace = this.resolveNamespace(req, parsed.searchParams.get("namespace") ?? undefined);
      const limit = parseStrictIntegerQuery(parsed.searchParams.get("limit"), "limit", 200, 1);
      const response = await this.service.memoryTimeline(memoryId, namespace, limit, this.resolveRequestPrincipal(req));
      this.respondJson(res, response.found ? 200 : 404, response);
      return;
    }

    if (req.method === "GET" && pathname === "/engram/v1/entities") {
      this.enforceTokenOp("entity_list"); // boundary dispatch (issue #1525)
      const limit = parseStrictIntegerQuery(parsed.searchParams.get("limit"), "limit", 50, 1);
      const offset = parseStrictIntegerQuery(parsed.searchParams.get("offset"), "offset", 0, 0);
      const response = await this.service.entityList({
        namespace: this.resolveNamespace(req, parsed.searchParams.get("namespace") ?? undefined),
        query: parsed.searchParams.get("q") ?? undefined,
        limit,
        offset,
      });
      this.respondJson(res, 200, response);
      return;
    }

    const entityMatch = pathname.match(/^\/engram\/v1\/entities\/([^/]+)$/);
    if (req.method === "GET" && entityMatch) {
      this.enforceTokenOp("entity_get"); // boundary dispatch (issue #1525)
      const entityName = decodeURIComponent(entityMatch[1] ?? "");
      const namespace = this.resolveNamespace(req, parsed.searchParams.get("namespace") ?? undefined);
      const response = await this.service.entityGet(entityName, namespace);
      this.respondJson(res, response.found ? 200 : 404, response);
      return;
    }

    if (req.method === "GET" && pathname === "/engram/v1/review-queue") {
      this.enforceTokenOp("review_queue_list"); // boundary dispatch (issue #1525)
      const response = await this.service.reviewQueue(
        parsed.searchParams.get("runId") ?? undefined,
        this.resolveNamespace(req, parsed.searchParams.get("namespace") ?? undefined),
        this.resolveRequestPrincipal(req),
      );
      this.respondJson(res, 200, response);
      return;
    }

    if (req.method === "GET" && pathname === "/engram/v1/maintenance") {
      this.enforceTokenOp("maintenance_status"); // boundary dispatch (issue #1525)
      const namespace = this.resolveNamespace(req, parsed.searchParams.get("namespace") ?? undefined);
      this.respondJson(res, 200, await this.service.maintenance(namespace, this.resolveRequestPrincipal(req)));
      return;
    }

    if (req.method === "GET" && pathname === "/engram/v1/quality") {
      this.enforceTokenOp("quality_status"); // boundary dispatch (issue #1525)
      const namespace = this.resolveNamespace(req, parsed.searchParams.get("namespace") ?? undefined);
      this.respondJson(res, 200, await this.service.quality(namespace, this.resolveRequestPrincipal(req)));
      return;
    }

    if (req.method === "GET" && pathname === "/engram/v1/trust-zones/status") {
      this.enforceTokenOp("trust_zones_status"); // boundary dispatch (issue #1525)
      this.respondJson(
        res,
        200,
        await this.service.trustZoneStatus(this.resolveNamespace(req, parsed.searchParams.get("namespace") ?? undefined), this.resolveRequestPrincipal(req)),
      );
      return;
    }

    // Procedural memory stats (issue #567 PR 5/5). Read-only; namespace is
    // scoped via the same resolver used by recall/trust-zones so cross-
    // tenant reads aren't possible (CLAUDE.md rule 42).
    if (req.method === "GET" && pathname === "/engram/v1/procedural/stats") {
      this.enforceTokenOp("procedural_stats"); // boundary dispatch (issue #1525)
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
      this.enforceTokenOp("trust_zones_records"); // boundary dispatch (issue #1525)
      const limit = parseStrictIntegerQuery(parsed.searchParams.get("limit"), "limit", 25, 1);
      const offset = parseStrictIntegerQuery(parsed.searchParams.get("offset"), "offset", 0, 0);
      const response = await this.service.trustZoneBrowse({
        query: parsed.searchParams.get("q") ?? undefined,
        zone: parseTrustZoneFilter(parsed.searchParams.get("zone")),
        kind: parseTrustZoneKindFilter(parsed.searchParams.get("kind")),
        sourceClass: parseTrustZoneSourceClassFilter(parsed.searchParams.get("sourceClass")),
        namespace: this.resolveNamespace(req, parsed.searchParams.get("namespace") ?? undefined),
        limit,
        offset,
      }, this.resolveRequestPrincipal(req));
      this.respondJson(res, 200, response);
      return;
    }

    if (req.method === "POST" && pathname === "/engram/v1/review-disposition") {
      this.enforceTokenOp("review_disposition"); // boundary dispatch (issue #1525)
      const body = await this.readValidatedBody(req, "reviewDisposition");
      this.ensureWriteRateLimitAvailable(req);
      const response = await this.service.reviewDisposition({
        memoryId: body.memoryId,
        status: body.status,
        reasonCode: body.reasonCode,
        namespace: this.resolveNamespace(req, body.namespace),
        authenticatedPrincipal: this.resolveRequestPrincipal(req),
      });
      if (this.shouldCountWriteRateLimit(response as unknown as { dryRun?: boolean; idempotencyReplay?: boolean })) {
        this.recordWriteRateLimitHit(req);
      }
      this.respondJson(res, 200, response);
      return;
    }

    if (req.method === "POST" && pathname === "/engram/v1/trust-zones/promote") {
      this.enforceTokenOp("trust_zones_promote"); // boundary dispatch (issue #1525)
      const body = await this.readValidatedBody(req, "trustZonePromote");
      const dryRun = body.dryRun === true;
      if (!dryRun) {
        this.ensureWriteRateLimitAvailable(req);
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
        this.recordWriteRateLimitHit(req);
      }
      this.respondJson(res, response.dryRun ? 200 : 201, response);
      return;
    }

    if (req.method === "POST" && pathname === "/engram/v1/trust-zones/demo-seed") {
      this.enforceTokenOp("trust_zones_demo_seed"); // boundary dispatch (issue #1525)
      const body = await this.readValidatedBody(req, "trustZoneDemoSeed");
      const dryRun = body.dryRun === true;
      if (!dryRun) {
        this.ensureWriteRateLimitAvailable(req);
      }
      const response = await this.service.trustZoneDemoSeed({
        scenario: body.scenario,
        recordedAt: body.recordedAt,
        dryRun,
        namespace: this.resolveNamespace(req, body.namespace),
        authenticatedPrincipal: this.resolveRequestPrincipal(req),
      });
      if (this.shouldCountWriteRateLimit(response as unknown as { dryRun?: boolean; idempotencyReplay?: boolean })) {
        this.recordWriteRateLimitHit(req);
      }
      this.respondJson(res, response.dryRun ? 200 : 201, response);
      return;
    }

    // Citation usage tracking (issue #379)
    if (req.method === "POST" && pathname === "/v1/citations/observed") {
      this.enforceTokenOp("citations_observed"); // boundary dispatch (issue #1525)
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
      this.enforceTokenOp("review_list"); // boundary dispatch (issue #1525)
      const VALID_FILTERS = new Set(["all", "unresolved", "contradicts", "independent", "duplicates", "needs-user"]);
      const rawFilter = parsed.searchParams.get("filter") ?? "unresolved";
      if (!VALID_FILTERS.has(rawFilter)) {
        this.respondJson(res, 400, { error: `Invalid filter '${rawFilter}'. Valid: ${[...VALID_FILTERS].join(", ")}` });
        return;
      }
      const namespace = this.resolveNamespace(req, parsed.searchParams.get("namespace") ?? undefined);
      const limit = parseStrictIntegerQuery(parsed.searchParams.get("limit"), "limit", 50, 1);
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
        limit,
      });
      this.respondJson(res, 200, result);
      return;
    }

    if (req.method === "GET" && pathname.startsWith("/engram/v1/review/contradictions/")) {
      this.enforceTokenOp("contradiction_detail"); // boundary dispatch (issue #1525)
      const pairId = pathname.split("/").pop() ?? "";
      const pair = readPair(this.service.memoryDir, pairId);
      if (!pair) {
        this.respondJson(res, 404, { error: "pair_not_found" });
        return;
      }
      // Per-token namespace enforcement (issues #1850 round 2 / round 4): the
      // pair is fetched BY ID, so its namespace comes from the record — NOT a
      // query param that resolveNamespace() already gates. A namespace-scoped
      // bearer that knows a pair id must not read contradiction data in a
      // namespace outside its allow-list. Fail closed (403) before the
      // principal-storage check so the token's declared scope is the
      // outermost gate. Legacy pairs carry no namespace (undefined), which
      // downstream storage maps to the server DEFAULT — route the record
      // namespace through the SAME effective-namespace chokepoint
      // (enforceNamespaceAllowList maps undefined → default) so a scoped token
      // whose allow-list INCLUDES the default can read/resolve a legacy pair,
      // while one that does NOT is still denied. No-op for unrestricted tokens.
      enforceNamespaceAllowList(
        tokenCapabilityStore.getStore(),
        pair.namespace,
        this.service.configRef?.defaultNamespace,
      );
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
      this.enforceTokenOp("review_resolve"); // boundary dispatch (issue #1525)
      const body = await this.readJsonBody(req) as Record<string, unknown>;
      const pairId = typeof body.pairId === "string" ? body.pairId : "";
      const verb = typeof body.verb === "string" ? body.verb : "";
      if (!pairId || !verb) {
        this.respondJson(res, 400, { error: "pairId and verb are required" });
        return;
      }
      if (!isValidResolutionVerb(verb)) {
        this.respondJson(res, 400, { error: `Invalid verb: ${verb}. Must be one of: keep-a, keep-b, merge, both-valid, needs-more-context` });
        return;
      }
      // Per-token namespace enforcement (issues #1850 round 2 / round 4): the
      // resolution target is selected BY pairId, so the affected namespace
      // comes from the record — NOT a request param that resolveNamespace()
      // already gates. A namespace-scoped bearer must not mutate a
      // contradiction pair in a namespace outside its allow-list. Load the
      // pair to learn its namespace, enforce the token's scope, and fail
      // closed (403) BEFORE dispatching the (mutating) resolution. Legacy
      // pairs carry no namespace (undefined), which downstream storage maps to
      // the server DEFAULT — use the SAME effective-namespace chokepoint
      // (enforceNamespaceAllowList maps undefined → default) as the detail
      // route so a scoped token whose allow-list INCLUDES the default can
      // resolve a legacy pair. A missing pair falls through to
      // executeResolution's existing not-found result. No-op for unrestricted
      // tokens.
      const targetPair = readPair(this.service.memoryDir, pairId);
      if (targetPair) {
        enforceNamespaceAllowList(
          tokenCapabilityStore.getStore(),
          targetPair.namespace,
          this.service.configRef?.defaultNamespace,
        );
      }
      const principal = this.resolveRequestPrincipal(req);
      const result = await executeResolution(this.service.memoryDir, this.service.storageRef, pairId, verb, {
        mergedMemoryId: typeof body.mergedMemoryId === "string" ? body.mergedMemoryId : undefined,
        mergedContent: typeof body.mergedContent === "string" ? body.mergedContent : undefined,
        storageForNamespace: async (namespace) => {
          const resolved = await this.service.getWritableStorageForNamespace(namespace, principal);
          return resolved.storage;
        },
        // Catalog write touch (issue #1499 sweep): a contradiction merge writes a
        // new memory directly to the resolved namespace storage, bypassing the
        // extraction write path. Record it so QMD maintenance / writtenSince
        // don't miss the write. Best-effort and failure-tolerant.
        onMergedMemoryWritten: (namespace, storageDir) => {
          // #1522: catalog touch handled at the storage chokepoint.
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
      this.enforceTokenOp("graph_snapshot"); // boundary dispatch (issue #1525)
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
        // As with recallXray above: surface only the deliberately-prefixed
        // graphSnapshot validation Error.message, never String(err) of an
        // arbitrary throw (CodeQL js/stack-trace-exposure). Validation errors are
        // always Error instances; anything else is rethrown as a 500.
        if (err instanceof Error && err.message.startsWith("graphSnapshot:")) {
          this.respondJson(res, 400, {
            error: "invalid_request",
            code: "invalid_request",
            message: err.message,
          });
          return;
        }
        throw err;
      }
      return;
    }

    if (req.method === "POST" && pathname === "/engram/v1/contradiction-scan") {
      this.enforceTokenOp("contradiction_scan_run"); // boundary dispatch (issue #1525)
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
        namespace: this.resolveNamespace(req, typeof body.namespace === "string" ? body.namespace : undefined),
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
      this.enforceTokenOp("graph_events"); // boundary dispatch (issue #1525)
      await this.handleGraphEventsSSE(req, res);
      return;
    }

    // ── Chat endpoints (issue #1583) ────────────────────────────────────────
    if (req.method === "POST" && pathname === "/engram/v1/chat/message") {
      this.enforceTokenOp("chat_message"); // boundary dispatch (issue #1525)
      const body = await this.readJsonBody(req) as Record<string, unknown>;
      // Issue #1850 round 5 (finding 2): a resumed chat session is an
      // id-loaded record whose namespace bypassed the token allow-list. Gate
      // its stored namespace before posting (fail closed; no-op unrestricted).
      const resumeChatSessionId = typeof body.chatSessionId === "string" ? body.chatSessionId : undefined;
      if (resumeChatSessionId) {
        await enforceChatSessionNamespace(this.service, resumeChatSessionId);
      } else {
        // NEW chat session (no chatSessionId): processChatMessage will mint a
        // fresh session under the effective namespace. The HTTP chat handler
        // does not forward a request namespace, so the new session inherits
        // the server DEFAULT — route that effective namespace through the
        // SAME chokepoint as the resume path (enforceNamespaceAllowList maps
        // undefined → default) so a namespace-scoped token CANNOT start a
        // chat in a namespace outside its allow-list (its server default may
        // be unlisted, or the server may carry no configured default). Fail
        // closed; no-op for unrestricted/legacy tokens (issue #1850 round 7).
        enforceNamespaceAllowList(
          tokenCapabilityStore.getStore(),
          undefined,
          this.service.configRef?.defaultNamespace,
        );
      }
      await handleChatMessage(
        req, res, body,
        { service: this.service, config: this.service.configRef?.chat, memoryDir: this.service.memoryDir },
        this.resolveRequestPrincipal(req),
      );
      return;
    }
    const chatEventsMatch = /^\/engram\/v1\/chat\/events\/([^/]+)$/.exec(pathname);
    if (req.method === "GET" && chatEventsMatch) {
      this.enforceTokenOp("chat_events"); // boundary dispatch (issue #1525)
      // Issue #1850 round 5 (finding 2): the SSE target is an id-loaded chat
      // session whose namespace bypassed the token allow-list. Gate its stored
      // namespace before streaming (fail closed; no-op unrestricted).
      await enforceChatSessionNamespace(this.service, chatEventsMatch[1] ?? "");
      await handleChatEventsSSE(
        req, res, chatEventsMatch[1] ?? "",
        {
          service: this.service,
          config: this.service.configRef?.chat,
          memoryDir: this.service.memoryDir,
          // Register the chat-SSE disconnect cleanup with this server's
          // stop() set so an HTTP shutdown forcibly releases the heartbeat
          // and transcript subscription even when a lingering client never
          // emits 'close' (cursor Medium review; mirrors handleGraphEventsSSE
          // which registers in sseCleanupFns at access-http.ts:2604).
          registerSseCleanup: (cleanup) => {
            this.sseCleanupFns.add(cleanup);
            return () => { this.sseCleanupFns.delete(cleanup); };
          },
        },
        this.resolveRequestPrincipal(req),
      );
      return;
    }

    // ── Peer Registry endpoints (issue #679) ─────────────────────────────────
    // GET /engram/v1/console/state — operator console engine-state snapshot (issue #688 PR 2/3).
    // Read-only; namespace-aware via resolveRequestPrincipal so cross-tenant
    // reads are not possible (CLAUDE.md rule 42).
    if (req.method === "GET" && pathname === "/engram/v1/console/state") {
      this.enforceTokenOp("console_state"); // boundary dispatch (issue #1525)
      const namespace = this.resolveNamespace(req, parsed.searchParams.get("namespace") ?? undefined);
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
      this.enforceTokenOp("peer_list"); // boundary dispatch (issue #1525)
      const result = await this.service.peerList();
      this.respondJson(res, 200, result);
      return;
    }

    const peerProfileMatch = /^\/engram\/v1\/peers\/([^/]+)\/profile$/.exec(pathname);
    if (peerProfileMatch) {
      this.enforceTokenOp("peer_profile_get"); // boundary dispatch (issue #1525)
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
        this.enforceTokenOp("peer_get"); // boundary dispatch (issue #1525)
        const result = await this.service.peerGet(peerId);
        if (!result.found) {
          this.respondJson(res, 404, { error: "peer_not_found", code: "peer_not_found" });
          return;
        }
        this.respondJson(res, 200, result);
        return;
      }

      if (req.method === "PUT") {
        this.enforceTokenOp("peer_set"); // boundary dispatch (issue #1525)
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
        this.enforceTokenOp("peer_delete"); // boundary dispatch (issue #1525)
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
      this.enforceTokenOp("dreams_status"); // boundary dispatch (issue #1525)
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
      const namespace = this.resolveNamespace(req, namespaceParam && namespaceParam.length > 0 ? namespaceParam : undefined);
      const result = await this.service.dreamsStatus({
        windowHours,
        namespace,
        principal: this.resolveRequestPrincipal(req),
      });
      this.respondJson(res, 200, result);
      return;
    }

    if (req.method === "POST" && pathname === "/engram/v1/dreams/run") {
      this.enforceTokenOp("dreams_run"); // boundary dispatch (issue #1525)
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
      const namespace = this.resolveNamespace(req, typeof body.namespace === "string" ? body.namespace : undefined);
      if (!dryRun) {
        this.ensureWriteRateLimitAvailable(req);
      }
      const result = await this.service.dreamsRun({
        phase: phase as import("./types.js").DreamsPhase,
        dryRun,
        namespace,
        authenticatedPrincipal: this.resolveRequestPrincipal(req),
      });
      if (this.shouldCountWriteRateLimit(result as { dryRun?: boolean; idempotencyReplay?: boolean })) {
        this.recordWriteRateLimitHit(req);
      }
      this.respondJson(res, 200, result);
      return;
    }

    // ── Admin console surfaces (issue #1502) ──────────────────────────────
    //
    // All five routes live under /engram/v1/admin/* which the access-surface
    // catalog treats as infrastructure (no boundary migration required; the
    // static-completeness fitness test excludes this prefix). They still
    // require bearer auth (enforced above) and delegate to core APIs via the
    // pure admin-surfaces module — the dashboard never re-resolves scope or
    // re-lists namespaces.
    if (pathname.startsWith("/engram/v1/admin/scope/inspect")) {
      if (req.method !== "GET" && req.method !== "POST") {
        this.respondJson(res, 405, { error: "method_not_allowed", code: "method_not_allowed" });
        return;
      }
      this.requireOperatorToken();
      const principal = this.resolveRequestPrincipal(req);
      let sessionKey: string | undefined;
      let namespaceOverride: string | undefined;
      let operation: string | undefined;
      if (req.method === "GET") {
        sessionKey = parsed.searchParams.get("session") ?? undefined;
        namespaceOverride = parsed.searchParams.get("namespace") ?? undefined;
        operation = parsed.searchParams.get("operation") ?? undefined;
      } else {
        const body = await this.readJsonBody(req) as Record<string, unknown>;
        sessionKey = typeof body.sessionKey === "string" ? body.sessionKey : undefined;
        namespaceOverride = typeof body.namespace === "string" ? body.namespace : undefined;
        operation = typeof body.operation === "string" ? body.operation : undefined;
      }
      const inspection = await this.service.adminInspectScope({
        sessionKey: sessionKey && sessionKey.length > 0 ? sessionKey : undefined,
        namespace: namespaceOverride && namespaceOverride.length > 0 ? namespaceOverride : undefined,
        principalOverride: principal,
        operation: operation as "recall" | "observe" | "memory_store" | "maintenance" | "dashboard" | undefined,
      });
      this.respondJson(res, 200, inspection);
      return;
    }
    if (pathname === "/engram/v1/admin/namespaces") {
      if (req.method !== "GET") {
        this.respondJson(res, 405, { error: "method_not_allowed", code: "method_not_allowed" });
        return;
      }
      this.requireOperatorToken();
      const kind = parsed.searchParams.get("kind");
      const principal = parsed.searchParams.get("principal");
      const projectId = parsed.searchParams.get("projectId");
      const discoveredBy = parsed.searchParams.get("discoveredBy");
      const result = await this.service.adminListNamespaces({
        ...(kind ? { kind: kind as "default" | "self" | "shared" | "project" | "branch" | "team-project" | "explicit" | "legacy" } : {}),
        ...(principal && principal.length > 0 ? { principal } : {}),
        ...(projectId && projectId.length > 0 ? { projectId } : {}),
        ...(discoveredBy
          ? { discoveredBy: discoveredBy as "config" | "write" | "read" | "scan" | "migration" }
          : {}),
      });
      this.respondJson(res, 200, result);
      return;
    }
    if (pathname === "/engram/v1/admin/maintenance-health") {
      if (req.method !== "GET") {
        this.respondJson(res, 405, { error: "method_not_allowed", code: "method_not_allowed" });
        return;
      }
      this.requireOperatorToken();
      const report = await this.service.adminMaintenanceHealth();
      this.respondJson(res, 200, report);
      return;
    }
    if (pathname === "/engram/v1/admin/transcript-audit") {
      if (req.method !== "GET") {
        this.respondJson(res, 405, { error: "method_not_allowed", code: "method_not_allowed" });
        return;
      }
      this.requireOperatorToken();
      const report = await this.service.adminTranscriptAudit();
      this.respondJson(res, 200, report);
      return;
    }
    if (pathname === "/engram/v1/admin/promote") {
      if (req.method !== "POST") {
        this.respondJson(res, 405, { error: "method_not_allowed", code: "method_not_allowed" });
        return;
      }
      this.requireOperatorToken();
      const body = await this.readJsonBody(req) as Record<string, unknown>;
      if (typeof body.sourceMemoryId !== "string" || body.sourceMemoryId.trim().length === 0) {
        this.respondJson(res, 400, {
          error: "invalid_request",
          code: "invalid_request",
          message: "sourceMemoryId is required",
        });
        return;
      }
      if (typeof body.reason !== "string" || body.reason.trim().length === 0) {
        this.respondJson(res, 400, {
          error: "invalid_request",
          code: "invalid_request",
          message: "reason is required for promotion",
        });
        return;
      }
      if (!Array.isArray(body.targets) || body.targets.length === 0) {
        this.respondJson(res, 400, {
          error: "invalid_request",
          code: "invalid_request",
          message: "targets must be a non-empty array",
        });
        return;
      }
      const VALID_TARGETS = ["teamProject", "serverShared", "userProject", "userGlobal", "explicit"];
      const targets = [];
      for (const entry of body.targets) {
        if (typeof entry !== "object" || entry === null || typeof entry.kind !== "string") {
          this.respondJson(res, 400, {
            error: "invalid_request",
            code: "invalid_request",
            message: "each target must be an object with a 'kind' string",
          });
          return;
        }
        if (!VALID_TARGETS.includes(entry.kind)) {
          this.respondJson(res, 400, {
            error: "invalid_request",
            code: "invalid_request",
            message: `target.kind must be one of: ${VALID_TARGETS.join(", ")}`,
          });
          return;
        }
        targets.push({
          kind: entry.kind as "teamProject" | "serverShared" | "userProject" | "userGlobal" | "explicit",
          namespace: typeof entry.namespace === "string" ? entry.namespace : undefined,
        });
      }
      try {
        // Rate-limit the promotion write, matching every other write route
        // (observe, trust-zone promotion, etc.). The check throws on limit
        // exceeded; the hit is recorded after the write succeeds.
        this.ensureWriteRateLimitAvailable(req);
        const result = await this.service.adminPromoteMemory({
          sourceMemoryId: body.sourceMemoryId,
          namespace: typeof body.namespace === "string" ? body.namespace : undefined,
          principal: this.resolveRequestPrincipal(req),
          sessionKey: typeof body.sessionKey === "string" ? body.sessionKey : undefined,
          targets,
          reason: body.reason,
        });
        // actor is derived from the authenticated principal inside adminPromoteMemory;
        this.recordWriteRateLimitHit(req);
        this.respondJson(res, 200, result);
      } catch (err) {
        if (err instanceof EngramAccessInputError) {
          this.respondJson(res, 400, {
            error: "invalid_request",
            code: "invalid_request",
            message: err.message,
          });
          return;
        }
        throw err;
      }
      return;
    }

    this.respondJson(res, 404, { error: "not_found", code: "not_found" });
  }

  private createRequestAbortSignal(req: IncomingMessage, res: ServerResponse): AbortSignal {
    const controller = new AbortController();
    const abort = () => {
      if (!controller.signal.aborted) controller.abort();
    };
    req.once("aborted", abort);
    res.once("close", () => {
      if (!res.writableEnded) abort();
    });
    return controller.signal;
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
    const namespace = this.resolveNamespace(req, namespaceParam && namespaceParam.length > 0 ? namespaceParam : undefined);
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

  private async handleMcpRequest(
    req: IncomingMessage,
    res: ServerResponse,
    abortSignal: AbortSignal,
  ): Promise<void> {
    // Reject requests that advertise an unknown MCP protocol version in
    // the streamable-HTTP `MCP-Protocol-Version` header. Absent or
    // valid → proceed. Unknown → 400 with a JSON-RPC-shaped error so
    // the client surfaces a clear message. The supported set is
    // exported by @remnic/core's access-mcp module to keep the
    // version policy in a single place.
    const headerVersion = req.headers["mcp-protocol-version"];
    if (typeof headerVersion === "string" && headerVersion.length > 0) {
      if (!(MCP_SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(headerVersion)) {
        this.respondJson(res, 400, {
          jsonrpc: "2.0",
          id: null,
          error: {
            code: -32000,
            message: `unsupported MCP-Protocol-Version: ${headerVersion}; supported: ${MCP_SUPPORTED_PROTOCOL_VERSIONS.join(", ")}`,
          },
        });
        return;
      }
    }
    const body = await this.readJsonBody(req);

    const request = body as {
      jsonrpc?: string;
      id?: string | number | null;
      method?: string;
      params?: Record<string, unknown>;
    };

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
    const toolArgsSubcommand =
      toolArgs !== null && typeof toolArgs === "object" && !Array.isArray(toolArgs) && "subcommand" in toolArgs
        ? toolArgs.subcommand
        : undefined;
    const codingDecisionWrite =
      (toolName === "engram.coding_decision" || toolName === "remnic.coding_decision") &&
      (toolArgsSubcommand === "record" || toolArgsSubcommand === "supersede");
    const codingArchitectureWrite =
      (toolName === "engram.coding_architecture" || toolName === "remnic.coding_architecture") &&
      toolArgsSubcommand === "refresh";
    // codegraph parity tools (issue #1554): only mutating tools count as
    // writes — index, delete_project, ingest_traces, and manage_adr
    // (record|supersede). Read-only tools (search_graph, get_schema,
    // list_projects, etc.) must NOT hit the write quota.
    const CODEGRAPH_WRITE_TOOLS = new Set([
      "engram.codegraph_index", "remnic.codegraph_index",
      "engram.codegraph_delete_project", "remnic.codegraph_delete_project",
      "engram.codegraph_ingest_traces", "remnic.codegraph_ingest_traces",
    ]);
    const isCodegraphManageAdr =
      toolName === "engram.codegraph_manage_adr" || toolName === "remnic.codegraph_manage_adr";
    const codegraphWrite =
      CODEGRAPH_WRITE_TOOLS.has(toolName) ||
      (isCodegraphManageAdr && (toolArgsSubcommand === "record" || toolArgsSubcommand === "supersede"));
    const supportPassportQuotaLimitedWrite = this.isSupportPassportQuotaLimitedWriteTool(toolName);
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
        toolName === "engram.extraction_force_flush" ||
        toolName === "remnic.extraction_force_flush" ||
        toolName === "engram.lcm_compaction_record" ||
        toolName === "remnic.lcm_compaction_record" ||
        toolName === "engram.capsule_export" ||
        toolName === "remnic.capsule_export" ||
        toolName === "engram.capsule_import" ||
        toolName === "remnic.capsule_import" ||
        toolName === "engram.entity_synthesis_run" || toolName === "remnic.entity_synthesis_run" ||
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
        ) ||
        (
          toolName === "engram.memory_correct_apply" ||
          toolName === "remnic.memory_correct_apply" ||
          toolName === "engram.memory_correct_plan" ||
          toolName === "remnic.memory_correct_plan"
        ) ||
        codingDecisionWrite ||
        codingArchitectureWrite ||
        codegraphWrite ||
        supportPassportQuotaLimitedWrite
      );
    const observeSelfEnforcesQuota =
      toolName === "engram.observe" || toolName === "remnic.observe";
    const extractionForceFlushWrite =
      toolName === "engram.extraction_force_flush" || toolName === "remnic.extraction_force_flush";
    let writeRateLimitRecorded = false;
    let supportPassportQuota: WriteRateLimitReservation | undefined;
    const recordCommittedMcpWrite = extractionForceFlushWrite
      ? () => {
          if (writeRateLimitRecorded) return;
          writeRateLimitRecorded = true;
          this.recordWriteRateLimitHit(req);
        }
      : supportPassportQuotaLimitedWrite
        ? () => {
            if (writeRateLimitRecorded) return;
            writeRateLimitRecorded = true;
            supportPassportQuota?.commit();
            supportPassportQuota = undefined;
          }
      : undefined;
    if (isMcpWrite && !observeSelfEnforcesQuota) {
      if (supportPassportQuotaLimitedWrite) supportPassportQuota = this.reserveWriteRateLimitSlot(req);
      else this.ensureWriteRateLimitAvailable(req);
    }

    const sessionId = (() => {
      const raw = req.headers["mcp-session-id"];
      return typeof raw === "string" ? raw.trim() : undefined;
    })();
    const mcpCorrelationId = correlationIdStore.getStore() ?? randomUUID();
    const requestIdentity = this.resolveRequestIdentity(req);
    // Per-token namespace enforcement on the MCP dispatch path (issue #1850
    // finding 1): MCP `tools/call` previously never applied the namespace
    // allow-list, so a namespace-scoped bearer could reach another tenant via
    // tool args or the adapter `namespaceOverride`. Run the SAME effective-
    // namespace chokepoint the REST surface runs. The effective namespace is
    // the explicit tool arg, else the adapter override, else the server
    // default (op.run with no namespace reaches the default tenant). Only
    // namespace-scoped tools are gated — namespace-agnostic tools (peer/
    // wearables) stay ungated, matching the REST surface. Fail closed (403)
    // BEFORE op.run; no-op for unrestricted tokens.
    if (request.method === "tools/call" && this.mcpServer.toolAcceptsNamespace(toolName)) {
      const mcpExplicitNamespace =
        toolArgs !== null && typeof toolArgs === "object" && !Array.isArray(toolArgs)
          && typeof (toolArgs as Record<string, unknown>).namespace === "string"
          && ((toolArgs as Record<string, unknown>).namespace as string).length > 0
          ? ((toolArgs as Record<string, unknown>).namespace as string)
          : undefined;
      enforceNamespaceAllowList(
        tokenCapabilityStore.getStore(),
        mcpExplicitNamespace ?? requestIdentity.namespace,
        this.service.configRef?.defaultNamespace,
      );
    }
    const response = await this.mcpServer.handleRequest(request, {
      principalOverride: requestIdentity.principal,
      namespaceOverride: requestIdentity.namespace,
      sessionKeyOverride: requestIdentity.sessionKey,
      sessionId,
      correlationId: mcpCorrelationId,
      enforceWriteQuota: observeSelfEnforcesQuota
        ? () => this.ensureWriteRateLimitAvailable(req)
        : undefined,
      recordWriteCommit: recordCommittedMcpWrite,
      sourceConnector: this.resolveConnector(req),
      abortSignal,
    }).catch((error) => {
      supportPassportQuota?.release();
      throw error;
    });

    if (isMcpWrite && response !== null) {
      const result = (response as Record<string, unknown>).result as Record<string, unknown> | undefined;
      const isError = result?.isError === true;
      const structured = result?.structuredContent as
        | { dryRun?: boolean; idempotencyReplay?: boolean; ok?: boolean }
        | undefined;
      // Rejected codegraph calls carry { ok: false } in structuredContent
      // (confirm_required, package_missing, runtime_unavailable, ...). The
      // MCP layer sets isError:false for these, so without this guard they
      // would consume the write quota despite no mutation occurring
      // (issue #1554 review thread: don't bill rejected calls as writes).
      const isRejectedCodegraph = structured?.ok === false;
      // A write tool that succeeded without structuredContent (e.g.
      // memory_correct_apply, which returns a CorrectionOutcome) still
      // consumed a write — count it. Tools WITH structuredContent use the
      // dryRun/idempotencyReplay guards.
      const counts = structured ? this.shouldCountWriteRateLimit(structured) : true;
      if (!writeRateLimitRecorded && !isError && !isRejectedCodegraph && counts) {
        if (supportPassportQuota) {
          supportPassportQuota.commit();
          supportPassportQuota = undefined;
        } else {
          this.recordWriteRateLimitHit(req);
        }
        writeRateLimitRecorded = true;
      }
    }
    supportPassportQuota?.release();
    // A mutating tool may have committed just before the client disconnected.
    // Record that side effect above, then honor cancellation before emitting
    // any response. Read-only calls reach this guard without accounting.
    if (abortSignal.aborted) {
      throw isAbortError(abortSignal.reason)
        ? abortSignal.reason
        : abortError("HTTP client disconnected");
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

  protected respondJson(res: ServerResponse, status: number, payload: unknown): void {
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
    if (pathname === "/remnic/ui/relay" || pathname === "/engram/ui/relay") {
      res.statusCode = 301;
      res.setHeader("location", pathname + "/");
      res.end();
      return true;
    }
    if (pathname === "/remnic/ui/" || pathname === "/engram/ui/") {
      await this.respondAdminConsoleShell(req, res, pathname);
      return true;
    }
    if (pathname === "/remnic/ui/relay/" || pathname === "/engram/ui/relay/") {
      await this.respondAdminConsoleShell(req, res, pathname, "relay/index.html");
      return true;
    }
    if (pathname === "/remnic/ui/app.js" || pathname === "/engram/ui/app.js") {
      await this.respondStatic(res, path.join(this.adminConsolePublicDir, "app.js"), "application/javascript; charset=utf-8");
      return true;
    }
    const relayAsset = RELAY_ADMIN_CONSOLE_ASSETS.get(pathname.split("/").at(-1) ?? "");
    const isRelayAsset = pathname.startsWith("/remnic/ui/relay/") || pathname.startsWith("/engram/ui/relay/");
    if (isRelayAsset && relayAsset && pathname.split("/").length === 5) {
      const fileName = pathname.split("/").at(-1);
      if (fileName) {
        await this.respondStatic(res, path.join(this.adminConsolePublicDir, "relay", fileName), relayAsset);
        return true;
      }
    }
    return false;
  }

  private async respondAdminConsoleShell(
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string,
    relativePath = "index.html",
  ): Promise<void> {
    try {
      let body = await readFile(path.join(this.adminConsolePublicDir, relativePath), "utf-8");
      const canPrefillToken = this.adminConsolePrefillToken && this.isAuthorized(req, pathname);
      if (canPrefillToken) {
        const serializedToken = serializeInlineScriptValue(this.adminConsolePrefillToken);
        const script = `<script>(function(token,script){const key="__REMNIC_ADMIN_CONSOLE_PREFILL_TOKEN__";const clear=function(){token="";try{delete window[key]}catch{window[key]=""}};window.addEventListener("pagehide",clear,{once:true});window.addEventListener("beforeunload",clear,{once:true});try{Object.defineProperty(window,key,{configurable:true,get:function(){const value=token;clear();return value}})}finally{if(script){script.textContent="";script.remove()}}})(${serializedToken},document.currentScript);</script>`;
        body = body.includes("</head>")
          ? body.replace("</head>", `${script}</head>`)
          : `${script}${body}`;
        res.setHeader("cache-control", "private, no-store");
      }
      res.setHeader("vary", "authorization");
      res.statusCode = 200;
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.setHeader("content-length", String(Buffer.byteLength(body)));
      res.end(body);
    } catch {
      this.respondJson(res, 404, { error: "not_found" });
    }
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

  protected async readJsonBody(
    req: IncomingMessage,
    maxBodyBytes = this.maxBodyBytes,
  ): Promise<Record<string, unknown>> {
    const encoding = (this.readOptionalHeader(req, "content-encoding") ?? "identity").toLowerCase();
    if (encoding !== "identity" && encoding !== "gzip") {
      throw new HttpError(415, "unsupported_content_encoding", "unsupported_content_encoding");
    }
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.length;
      if (total > maxBodyBytes) {
        throw new HttpError(413, "request_body_too_large", "request_body_too_large");
      }
      chunks.push(buffer);
    }
    if (chunks.length === 0) return {};
    let body = Buffer.concat(chunks, total);
    if (encoding === "gzip") {
      try {
        body = gunzipSync(body, { maxOutputLength: maxBodyBytes });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE") {
          throw new HttpError(413, "request_body_too_large", "request_body_too_large");
        }
        throw new HttpError(400, "invalid_gzip_body", "invalid_gzip_body");
      }
      if (body.byteLength > maxBodyBytes) {
        throw new HttpError(413, "request_body_too_large", "request_body_too_large");
      }
    }
    const raw = body.toString("utf-8").trim();
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

  private async readBinaryBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.length;
      if (total > maxBytes) {
        throw new HttpError(413, "request_body_too_large", "request_body_too_large");
      }
      chunks.push(buffer);
    }
    return Buffer.concat(chunks, total);
  }

  private readRequiredHeader(req: IncomingMessage, name: string): string {
    const value = this.readOptionalHeader(req, name);
    if (value === undefined || value.length === 0) {
      throw new EngramAccessInputError(`${name} header is required`);
    }
    return value;
  }

  private readOptionalHeader(req: IncomingMessage, name: string): string | undefined {
    const raw = req.headers[name.toLowerCase()];
    if (Array.isArray(raw)) return raw[0]?.trim() || undefined;
    return raw?.trim() || undefined;
  }

  private readRequiredDecodedHeader(req: IncomingMessage, name: string): string {
    const raw = this.readRequiredHeader(req, name);
    try {
      return decodeURIComponent(raw);
    } catch {
      throw new EngramAccessInputError(`${name} header is not valid percent-encoded input`);
    }
  }

  private readRequiredIntegerHeader(req: IncomingMessage, name: string): number {
    const raw = this.readRequiredHeader(req, name);
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < 0) {
      throw new EngramAccessInputError(`${name} header must be a non-negative integer`);
    }
    return parsed;
  }

  private readOptionalIntegerHeader(req: IncomingMessage, name: string): number | undefined {
    const raw = this.readOptionalHeader(req, name);
    if (raw === undefined) return undefined;
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < 0) {
      throw new EngramAccessInputError(`${name} header must be a non-negative integer`);
    }
    return parsed;
  }

  private readRequiredNumberHeader(req: IncomingMessage, name: string): number {
    const raw = this.readRequiredHeader(req, name);
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 0) {
      throw new EngramAccessInputError(`${name} header must be a non-negative finite number`);
    }
    return parsed;
  }
  private parseOptionalBooleanHeader(
    req: IncomingMessage,
    name: string,
    defaultValue: boolean,
  ): boolean {
    const raw = this.readOptionalHeader(req, name);
    if (raw === undefined) return defaultValue;
    if (raw === "true") return true;
    if (raw === "false") return false;
    throw new EngramAccessInputError(`${name} header must be one of: true, false`);
  }
  private lifecycleFlushDeps(req: IncomingMessage, res: ServerResponse): LifecycleFlushHttpDeps {
    const readValidatedBody = ((schemaName: SchemaName) => this.readValidatedBody(req, schemaName)) as LifecycleFlushHttpDeps["readValidatedBody"];
    return { service: this.service, defaultNamespace: this.service.configRef?.defaultNamespace,
      enforceTokenOp: (op) => this.enforceTokenOp(op),
      readValidatedBody,
      ensureWriteRateLimitAvailable: () => this.ensureWriteRateLimitAvailable(req),
      resolveNamespace: (namespace) => this.resolveNamespace(req, namespace),
      resolveRequestPrincipal: () => this.resolveRequestPrincipal(req),
      recordWriteRateLimitHit: () => this.recordWriteRateLimitHit(req),
      respondJson: (payload) => this.respondJson(res, 200, payload),
    };
  }
  private async readValidatedBody<S extends SchemaName>(
    req: IncomingMessage,
    schemaName: S,
    maxBodyBytes?: number,
  ): Promise<SchemaTypeFor<S>> {
    const raw = await this.readJsonBody(req, maxBodyBytes);
    const result = validateRequest(schemaName, raw);
    if (!result.success) {
      throw new HttpError(400, result.error.error, "validation_error", result.error.details);
    }
    return result.data as SchemaTypeFor<S>;
  }

  /**
   * Build the WWW-Authenticate challenge string for 401 responses.
   * When `resourceMetadataUrl` is configured, includes the RFC 9728
   * `resource_metadata` parameter so MCP clients (e.g. ChatGPT) can
   * discover the OAuth 2.0 protected-resource metadata document.
   * Otherwise the bare `Bearer` challenge is returned (unchanged).
   */
  private bearerChallenge(): string {
    if (this.resourceMetadataUrl) {
      return `Bearer resource_metadata="${this.resourceMetadataUrl}"`;
    }
    return "Bearer";
  }

   private isAuthorized(req: IncomingMessage, pathname?: string): boolean {
    return this.resolveAuthorizedEntry(req, pathname) !== null;
  }

  /**
   * Per-request cache of the matched token entry (the entry whose token
   * matched the bearer credential, BEFORE any path-policy check). Pinning
   * the entry to the first read means authorization, capability
   * enforcement, and connector provenance all observe the SAME token-store
   * snapshot — a rotation between the auth check and the write handler can
   * no longer stamp the wrong connector (PR #1852 race).
   */
  private matchedEntryCache = new WeakMap<
    IncomingMessage,
    { token: string; connector?: string; capabilities?: TokenCapabilities } | null
  >();

  /**
   * Resolve the matched token entry for this request, caching the result so
   * every downstream consumer (authorization, capability enforcement,
   * connector provenance) sees the same snapshot entry (PR #1852).
   */
  private resolveMatchedEntry(
    req: IncomingMessage,
    pathname?: string,
  ): { token: string; connector?: string; capabilities?: TokenCapabilities } | null {
    if (this.matchedEntryCache.has(req)) {
      return this.matchedEntryCache.get(req) ?? null;
    }
    const entry = this.computeMatchedEntry(req, pathname);
    this.matchedEntryCache.set(req, entry);
    return entry;
  }

  /**
   * Find the entry whose token matches the request's bearer credential.
   * Static operator tokens (`authToken`/`authTokens`) and the string-token
   * getter carry no capabilities ⇒ unrestricted. Dynamic entry-based tokens
   * capture connector identity and capabilities. A corrupt or unreadable
   * token store returns null rather than propagating an error — provenance
   * must never block an already-authenticated request.
   */
  private computeMatchedEntry(
    req: IncomingMessage,
    pathname?: string,
  ): { token: string; connector?: string; capabilities?: TokenCapabilities } | null {
    if (
      !this.authToken &&
      this.authTokens.length === 0 &&
      !this.authTokensGetter &&
      !this.authTokenEntriesGetter
    ) {
      return null;
    }
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
    if (!candidate) return null;
    const token = candidate;
    // Check primary token (static operator token — no capabilities ⇒ unrestricted)
    if (this.authToken && this.timingSafeStringEqual(token, this.authToken)) {
      return { token };
    }
    // Check static multi-connector tokens
    for (const valid of this.authTokens) {
      if (this.timingSafeStringEqual(token, valid)) return { token: valid };
    }
    // Entry-based dynamic tokens are AUTHORITATIVE when configured: the
    // dynamic-token decision ends here (no fall-through to the string
    // getter, which carries no identity and would bypass the policy).
    // Validation and connector identity come from the same snapshot entry,
    // so a scope policy can never observe a token fresher than the
    // identity it scopes (mint/revoke coherence). Capabilities ride on the
    // same entry so enforcement can never lag the token that validated.
    if (this.authTokenEntriesGetter) {
      try {
        for (const entry of this.authTokenEntriesGetter()) {
          if (!this.timingSafeStringEqual(token, entry.token)) continue;
          return { token: entry.token, connector: entry.connector, capabilities: entry.capabilities };
        }
      } catch {
        // Corrupt or unreadable tokens.json — no match.
      }
      return null;
    }
    // String-token getter (no identity, no policy) — only consulted when
    // no entry getter is configured.
    if (this.authTokensGetter) {
      for (const valid of this.authTokensGetter()) {
        if (this.timingSafeStringEqual(token, valid)) return { token: valid };
      }
    }
    return null;
  }

  /**
   * Resolve the presenting token's entry for an authorized request, or null.
   * Applies the path-policy gate (if configured) on top of the per-request
   * cached matched entry so the identity that is authorized is the same one
   * whose connector later stamps frontmatter. Static operator tokens and the
   * string-token getter carry no capabilities ⇒ unrestricted.
   */
  private resolveAuthorizedEntry(
    req: IncomingMessage,
    pathname?: string,
  ): { token: string; connector?: string; capabilities?: TokenCapabilities } | null {
    const matched = this.resolveMatchedEntry(req, pathname);
    if (!matched) return null;
    // Apply the path-policy gate for dynamic entry-based tokens.
    if ("connector" in matched && this.tokenPathPolicy) {
      // Fail closed: a policy without a connector identity denies.
      if (typeof matched.connector !== "string" || matched.connector.length === 0) return null;
      return this.tokenPathPolicy(matched.connector, pathname) ? matched : null;
    }
    return matched;
  }

  /**
   * Resolve the presenting token's capabilities for this request, or
   * undefined when the token is unrestricted (legacy / static operator /
   * explicit-unrestricted record). Reads from the per-request cached matched
   * entry so capabilities come from the same snapshot as authorization and
   * connector provenance (PR #1852).
   */
  private resolveTokenCapabilities(
    req: IncomingMessage,
    pathname?: string,
  ): TokenCapabilities | undefined {
    return this.resolveMatchedEntry(req, pathname)?.capabilities;
  }

  /**
   * Enforce the presenting token's ops allow-list for an HTTP route that
   * dispatches directly to the service (not through the boundary). Reads the
   * per-request capability context set in `handle`; unrestricted tokens
   * pass. Throws {@link EngramAccessForbiddenError} (→ 403) when a scoped
   * token calls a non-permitted op (issue #1837).
   */
  private enforceTokenOp(op: OperationName): void {
    void getOperation(op); // preserve the registration side-effect assertion
    assertOperationAllowed(tokenCapabilityStore.getStore(), op);
  }

  private enforceTokenAnyOf(ops: readonly OperationName[]): void {
    for (const op of ops) void getOperation(op);
    const capabilities = tokenCapabilityStore.getStore();
    if (ops.some((op) => capabilityAllowsOp(capabilities, op))) return;
    throw new EngramAccessForbiddenError(
      `token is not permitted to call any required operation: ${ops.join(", ")}`,
    );
  }
 
  /**
   * Operator/admin routes are unrestricted-only surfaces: a scoped
   * (least-privileged) token must NOT reach them (issue #1837). Legacy and
   * explicit-unrestricted tokens pass. Throws EngramAccessForbiddenError (→403).
   */
  private requireOperatorToken(): void {
    if (isCapabilityRestricted(tokenCapabilityStore.getStore())) {
      throw new EngramAccessForbiddenError(
        "token is scoped and may not access operator/admin routes",
      );
    }
  }
  /**
   * Resolve the connector identity for the request's bearer token (Phase 1
   * provenance). Reuses the per-request cached matched entry so a token
   * rotation between the auth check and the write handler cannot stamp the
   * wrong connector (PR #1852 race). Returns `undefined` for operator-
   * supplied static tokens or when no entry getter is configured — those
   * writes are operator-initiated.
   */
  private resolveConnector(req: IncomingMessage): string | undefined {
    return this.resolveMatchedEntry(req)?.connector;
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

  protected ensureWriteRateLimitAvailable(req?: IncomingMessage): void {
    if (!this.writeLimiter.hasCapacity(this.principalForRateLimit(req))) {
      throw new HttpError(429, "write_rate_limited", "write_rate_limited");
    }
  }

  protected recordWriteRateLimitHit(req?: IncomingMessage): void {
    this.writeLimiter.record(this.principalForRateLimit(req));
  }

  protected reserveWriteRateLimitSlot(req?: IncomingMessage): WriteRateLimitReservation {
    const reservation = this.writeLimiter.reserve(this.principalForRateLimit(req));
    if (!reservation) {
      throw new HttpError(429, "write_rate_limited", "write_rate_limited");
    }
    return reservation;
  }

  private principalForRateLimit(req?: IncomingMessage): string | undefined {
    if (!req) return undefined;
    // Fall back to the authenticated connector identity when no principal is
    // resolved, so per-connector bearer tokens are isolated from each other
    // even without a principal header/server principal (issue #2029 review).
    return this.resolveRequestPrincipal(req) ?? this.resolveConnector(req);
  }

  private shouldCountWriteRateLimit(response: { dryRun?: boolean; idempotencyReplay?: boolean }): boolean {
    return response.dryRun !== true && response.idempotencyReplay !== true;
  }

  /**
   * Map wearables validation errors (WearablesInputError — invalid
   * params, unknown/disabled sources, missing connector packages) to a
   * 400 response. Returns false for everything else so backend faults
   * keep flowing to the global 500 handler.
   */
  private respondWearablesError(res: ServerResponse, err: unknown): boolean {
    if (err instanceof WearablesInputError) {
      this.respondJson(res, 400, {
        error: "invalid_request",
        code: "invalid_request",
        message: err.message,
      });
      return true;
    }
    return false;
  }
}
