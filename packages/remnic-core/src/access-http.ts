import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";
import { gunzipSync } from "node:zlib";
import { currentCorrelationId, runWithCorrelationId } from "./access-correlation.js";
import { log } from "./logger.js";
import { respondBufferAdmissionError } from "./access-http-admission.js";
import { resolveNamespaceCapabilities } from "./capabilities.js";
import { WriteRateLimiter, type WriteRateLimitReservation } from "./write-rate-limiter.js";
import { abortError, isAbortError } from "./abort-error.js";
import { BriefingTimeoutError } from "./briefing-deadline.js";
import { EngramAccessForbiddenError } from "./access-errors.js";
import {
  EngramAccessInputError,
  type EngramAccessService,
  type WearablesMeetingsScope,
  type EngramAccessMemoryResponse,
  type EngramAccessWriteResponse,
  type EngramAccessRecallResponse,
} from "./access-service.js";
import { maybeHandleLifecycleFlush, type LifecycleFlushHttpDeps } from "./access-http-lifecycle-flush.js";
import {
  respondOfflineManifestStream,
  respondOfflineSnapshotStream,
} from "./access-http-offline-stream.js";
import { peerManifestRevision } from "./reconcile/manifest.js";
import { nonEmptyQueryParam, optionalNamespaceKindQueryParam, optionalQueryString, positiveIntQueryParam } from "./access-http-query.js";
import { CorrectionContractError } from "./correction/correction-contract.js";
import { respondWearablesErrorGlue } from "./wearables/http-glue.js"; import { respondMeetingsList, respondMeetingsGet, respondMeetingsBuild } from "./meetings/http-glue.js"; import { respondLocationStatus, respondLocationCheck, respondLocationSync, respondLocationBackfill, respondLocationDay } from "./location/http-glue.js"; import { respondStandup } from "./standup/http-glue.js"; import { respondDeepRecall } from "./deep-recall-http-glue.js"; import { maybeRespondRecallNavigation } from "./recall-navigation-http-glue.js"; import { maybeRespondMemoryBrowse } from "./memory-browse-http-glue.js";
import { EngramMcpServer, MCP_SUPPORTED_PROTOCOL_VERSIONS } from "./access-mcp.js";
import { handleMcpGetSse } from "./access-mcp-sse.js";
import { validateRequest, type SchemaName, type SchemaTypeFor } from "./access-schema.js";
import {
  OFFLINE_SYNC_APPLY_MAX_BODY_BYTES,
  OFFLINE_SYNC_FILE_CONTENT_MAX_CHUNK_BYTES,
  OFFLINE_SYNC_SNAPSHOT_BASE_MAX_BODY_BYTES,
} from "./offline-sync.js";
import type { RecallDisclosure } from "./types.js";
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
import { respondBriefingHttp } from "./access-http-briefing.js";
import { handleWhoKnowsHttpQuery } from "./who-knows.js";
import {
  handleRecallWhyHttpQuery,
  handleRecallXrayHttpQuery,
} from "./access-recall-diagnostics.js";
import {
  assertOperationAllowed,
  capabilityAllowsOp,
  enforceNamespaceAllowList,
  isCapabilityRestricted,
  tokenCapabilityStore,
  type TokenCapabilities,
} from "./access-token-capabilities.js";
import "./access-operations.js";
import { handleChatMessage, handleChatEventsSSE } from "./chat/chat-http.js";
import { cleanupExpiredChatSessions, enforceChatSessionNamespace } from "./chat/chat-session.js";
import { isDefaultReviewNamespace, listPairs, readPair } from "./contradiction/contradiction-review.js";
import { isValidResolutionVerb, executeResolution } from "./contradiction/resolution.js";
import { RelayMissionStoreError } from "./relay/mission.js";
import { ReviewDeckAccessHttpBase } from "./review/review-deck-http-base.js";
import { serializeInlineScriptValue } from "./inline-script.js";
import { toDottedRemnicName } from "./access-mcp-tool-names.js";
import type { SupportPassportExternalRequestHandler } from "./support-passport/public-http.js";
import type {
  AccessHttpReadinessState,
  EngramAccessHttpServerOptions,
  EngramAccessHttpServerStatus,
  RemnicAdminHarnessStatus,
  RemnicAdminModelOption,
  RemnicAdminFeatureStatus,
  RemnicAdminConfigStatus,
  RemnicAdminDashboardStatus,
  RemnicAdminConfigPatch,
  RemnicAdminControls,
} from "./access-http-types.js";
export type {
  AccessHttpReadinessState,
  EngramAccessHttpServerOptions,
  EngramAccessHttpServerStatus,
  RemnicAdminHarnessStatus,
  RemnicAdminModelOption,
  RemnicAdminFeatureStatus,
  RemnicAdminConfigStatus,
  RemnicAdminDashboardStatus,
  RemnicAdminConfigPatch,
  RemnicAdminControls,
} from "./access-http-types.js";

export function resolveDefaultAdminConsolePublicDir(sourceUrl = import.meta.url): string {
  const thisDir = path.dirname(fileURLToPath(sourceUrl));
  const candidates = [
    path.resolve(thisDir, "../../../admin-console/public"),
    path.resolve(thisDir, "../dist/admin-console/public"),
    path.resolve(thisDir, "./admin-console/public"),
    path.resolve(thisDir, "../../admin-console/public"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

const defaultAdminConsolePublicDir = resolveDefaultAdminConsolePublicDir();
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

const PRINCIPAL_HEADER_MAX_CHARS = 128;
const INVALID_PRINCIPAL_HEADER_CHARS = /[\s\/\\]|\.{2}/;

function isValidPrincipalHeaderValue(value: string): boolean {
  if (value.length === 0 || Array.from(value).length > PRINCIPAL_HEADER_MAX_CHARS) return false;
  if (INVALID_PRINCIPAL_HEADER_CHARS.test(value)) return false;
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return false;
  }
  return true;
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

export class EngramAccessHttpServer extends ReviewDeckAccessHttpBase {
  protected readonly service: EngramAccessService;
  private readonly host: string;
  private readonly requestedPort: number;
  private readonly authToken?: string;
  private readonly authTokens: string[];
  private readonly authTokensGetter?: () => string[];
  private readonly authTokenEntriesGetter?: () => ReadonlyArray<{ token: string; connector?: string; capabilities?: TokenCapabilities }>;
  private readonly tokenPathPolicy?: (connector: string, pathname: string | undefined) => boolean;
  private readonly authenticatedPrincipal?: string;
  protected readonly maxBodyBytes: number;
  private readonly stopGraceMs: number;
  private readonly adminConsoleEnabled: boolean;
  protected readonly adminConsolePublicDir: string;
  private readonly adminConsolePrefillToken?: string;
  private readonly adminControls?: RemnicAdminControls;
  private readonly trustPrincipalHeader: boolean;
  private readonly adapterRegistry: AdapterRegistry | null;
  private readonly readiness: () => AccessHttpReadinessState;
  private readonly resourceMetadataUrl?: string;
  private readonly externalRequestHandler?: SupportPassportExternalRequestHandler;
  private readonly writeLimiter: WriteRateLimiter;
  private readonly pendingWriteQuotas = new WeakMap<IncomingMessage, WriteRateLimitReservation>();
  private readonly mcpServer: EngramMcpServer;
  private server: Server | null = null;
  private boundPort = 0;
  private readonly sseClients = new Set<ServerResponse>();
  private readonly sseBatchTimers = new Map<ServerResponse, ReturnType<typeof setTimeout>>();
  private readonly ssePendingBatches = new Map<ServerResponse, GraphEvent[]>();
  private readonly sseCleanupFns = new Set<() => void>();

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
    this.stopGraceMs = Number.isFinite(options.stopGraceMs) ? Math.max(0, Math.floor(options.stopGraceMs ?? 10_000)) : 10_000;
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
      runWithCorrelationId(correlationId, () => {
        void this.handle(req, res, correlationId, abortController.signal).catch((err) => {
          if (err instanceof BriefingTimeoutError) {
            this.respondJson(res, 504, { error: err.message, code: "briefing_timeout" });
            return;
          }
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
          if (respondBufferAdmissionError(err, res, correlationId, (status, body) => this.respondJson(res, status, body))) {
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
          this.releasePendingWriteQuota(req);
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

    this.scheduleChatSessionTtlSweep();

    return this.status();
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    if (this.chatTtlTimer) {
      clearInterval(this.chatTtlTimer);
      this.chatTtlTimer = null;
    }
    const server = this.server;
    this.server = null;
    this.boundPort = 0;
    for (const cleanup of this.sseCleanupFns) {
      try { cleanup(); } catch { /* ignore */ }
    }
    this.sseCleanupFns.clear();
    for (const [res, timer] of this.sseBatchTimers.entries()) {
      clearTimeout(timer);
      this.sseBatchTimers.delete(res);
    }
    this.ssePendingBatches.clear();
    for (const res of this.sseClients) {
      try { res.end(); } catch { /* ignore */ }
    }
    this.sseClients.clear();
    const closed = new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    const cutTimer = setTimeout(() => server.closeAllConnections(), this.stopGraceMs);
    try {
      await closed;
    } finally {
      clearTimeout(cutTimer);
    }
  }

  private scheduleChatSessionTtlSweep(): void {
    if (this.chatTtlTimer) {
      clearInterval(this.chatTtlTimer);
      this.chatTtlTimer = null;
    }
    const chat = this.service.configRef?.chat;
    if (!chat?.enabled) return;
    const ttlHours = typeof chat.sessionTtlHours === "number" && chat.sessionTtlHours > 0
      ? chat.sessionTtlHours
      : 72;
    void cleanupExpiredChatSessions(this.service.memoryDir, ttlHours).catch(() => { /* best-effort */ });
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
    const sessionId = (() => {
      const raw = req.headers["mcp-session-id"];
      return typeof raw === "string" ? raw.trim() : undefined;
    })();
    return this.adapterRegistry.resolve({
      headers: req.headers as Record<string, string | string[] | undefined>,
      clientInfo: this.mcpServer.getClientInfo(sessionId),
    });
  }

  private identityCache = new WeakMap<IncomingMessage, { principal?: string; namespace?: string; sessionKey?: string }>();

  private resolveRequestIdentity(req: IncomingMessage): { principal?: string; namespace?: string; sessionKey?: string } {
    const cached = this.identityCache.get(req);
    if (cached) return cached;
    let principal: string | undefined;
    let namespace: string | undefined;
    let sessionKey: string | undefined;

    if (this.trustPrincipalHeader) {
      const headerVal = req.headers["x-engram-principal"];
      const raw = Array.isArray(headerVal) ? headerVal[0] : headerVal;
      if (typeof raw === "string") {
        const trimmed = raw.trim();
        if (trimmed.length > 0) {
          if (!isValidPrincipalHeaderValue(trimmed)) {
            throw new EngramAccessInputError(
              `invalid x-engram-principal header value: must be 1-128 chars with no whitespace, control chars, or path separators`,
            );
          }
          principal = trimmed;
        }
      }
    }

    if (!principal) {
      principal = this.authenticatedPrincipal;
    }

    const adapterIdentity = this.resolveAdapterIdentity(req);
    if (adapterIdentity) {
      if (!principal) {
        principal = adapterIdentity.principal;
      }
      namespace = adapterIdentity.namespace;
      const config = this.service.configRef;
      if (
        adapterIdentity.namespaceExplicit === false &&
        !(config && resolveNamespaceCapabilities(config).namespaces)
      ) {
        namespace = undefined;
      }
      sessionKey = adapterIdentity.sessionKey;
    }

    const result = { principal, namespace, sessionKey };
    this.identityCache.set(req, result);
    return result;
  }

  protected resolveRequestPrincipal(req: IncomingMessage): string | undefined {
    return this.resolveRequestIdentity(req).principal;
  }

  private wearablesScope(req: IncomingMessage, namespace?: string, sessionKey?: string): WearablesMeetingsScope {
    return { authenticatedPrincipal: this.resolveRequestPrincipal(req), namespace: this.resolveNamespace(req, namespace), ...(sessionKey ? { sessionKey } : {}) };
  }

  protected resolveNamespace(_req: IncomingMessage, bodyNamespace?: string): string | undefined {
    const namespace = bodyNamespace || undefined;
    enforceNamespaceAllowList(tokenCapabilityStore.getStore(), namespace, this.service.configRef?.defaultNamespace);
    return namespace;
  }

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
    const trimmed = typeof requested === "string" ? requested.trim() : undefined;
    const namespace = this.resolveNamespace(req, trimmed || undefined);
    return { ...body, namespace };
  }

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
    if (await this.handleSupportPassportUi(req, res, pathname)) return;

    if (this.adminConsoleEnabled && await this.handleAdminConsole(req, res, pathname)) return;

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
    if (this.externalRequestHandler) {
      const tokenAuthorized = this.isAuthorized(req, pathname);
      const capabilities = this.resolveTokenCapabilities(req, pathname);
      const authorized = tokenAuthorized && !isCapabilityRestricted(capabilities);
      if (await this.externalRequestHandler(req, res, {
        authorized,
        tokenAuthorized,
      })) return;
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
    if (pathname === "/mcp" && req.method === "DELETE") { res.writeHead(204); res.end(); return; }
    if (pathname === "/mcp" && req.method === "GET") {
      if ((req.headers.accept ?? "").includes("text/event-stream"))
        return handleMcpGetSse(req, res, this.sseCleanupFns);
      const body = JSON.stringify({ error: "method_not_allowed", code: "method_not_allowed" });
      res.writeHead(405, { "content-type": "application/json; charset=utf-8", allow: "GET, POST, DELETE", "x-request-id": correlationId });
      res.end(body);
      return;
    }

    if (req.method === "POST" && pathname === "/mcp") return this.handleMcpRequest(req, res, abortSignal);

    if (await this.handleSupportPassportOwnerRequest(req, res, pathname, parsed.search.length > 0, abortSignal)) return;
    if (await this.handleReviewDeckRequest(req, res, pathname, abortSignal)) return;

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
      this.enforceTokenOp("memory_search"); // boundary dispatch (issue #1525)
      const operation = getOperation("memory_search");
      if (!operation) throw new EngramAccessInputError("access-boundary: operation not registered: memory_search");
      const body = this.gatedBodyNamespace(req, await this.readJsonBody(req));
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
      const disclosure = this.resolveRecallDisclosure(body.disclosure, parsed);
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
      const op = getOperation("recall");
      if (!op) {
        throw new EngramAccessInputError("access-boundary: operation not registered: recall");
      }
      const output = (await op.run(
        {
          ...body,
          namespace: this.resolveNamespace(req, body.namespace),
          ...(disclosure !== undefined ? { disclosure } : {}),
          ...(asOf !== undefined ? { asOf } : {}),
          ...(tags !== undefined ? { tags } : {}),
          ...(tagMatch !== undefined ? { tagMatch } : {}),
          ...(includeLowConfidence ? { includeLowConfidence: true } : {}),
        },
        {
          service: this.service,
          authenticatedPrincipal: this.resolveRequestPrincipal(req),
          sourceConnector: this.resolveConnector(req),
          ...(abortSignal ? { abortSignal } : {}),
        },
      )) as { result: EngramAccessRecallResponse };
      this.respondJson(res, 200, output.result);
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
        // remote — it was resolved on the caller's host, not this filesystem.
        authenticatedPrincipal: this.resolveRequestPrincipal(req),
        remote: true,
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
        manifestRevision: peerManifestRevision(this.service.configRef?.inlineSourceAttributionFormat),
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
      await respondOfflineSnapshotStream(res, result, currentCorrelationId());
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
      await respondOfflineManifestStream(res, result, currentCorrelationId());
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

    if (req.method === "GET" && pathname === "/engram/v1/recall/xray") {
      this.enforceTokenOp("recall_xray"); // boundary dispatch (issue #1525)
      const outcome = await handleRecallXrayHttpQuery({
        getParam: (name) => parsed.searchParams.get(name),
        resolveNamespace: (namespace) => this.resolveNamespace(req, namespace),
        principal: this.resolveRequestPrincipal(req),
        connector: this.resolveConnector(req),
        run: (request) => this.service.recallXray(request),
      });
      this.respondJson(res, outcome.status, outcome.body);
      return;
    }

    if (
      req.method === "GET"
      && (pathname === "/engram/v1/recall/why" || pathname === "/remnic/v1/recall/why")
    ) {
      this.enforceTokenOp("recall_why"); // boundary dispatch (issue #1525)
      const outcome = await handleRecallWhyHttpQuery({
        getParam: (name) => parsed.searchParams.get(name),
        resolveNamespace: (namespace) => this.resolveNamespace(req, namespace),
        principal: this.resolveRequestPrincipal(req),
        connector: this.resolveConnector(req),
        run: (request) => this.service.recallWhy(request),
      });
      this.respondJson(res, outcome.status, outcome.body);
      return;
    }

    if (req.method === "GET" && (pathname === "/engram/v1/who-knows" || pathname === "/remnic/v1/who-knows")) {
      this.enforceTokenOp("who_knows");
      const outcome = await handleWhoKnowsHttpQuery({
        getParam: (name) => parsed.searchParams.get(name),
        resolveNamespace: (namespace) => this.resolveNamespace(req, namespace),
        principal: this.resolveRequestPrincipal(req),
        run: (request) => this.service.whoKnows(request),
      });
      this.respondJson(res, outcome.status, outcome.body);
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
    const meetingGetRemnic = /^\/remnic\/v1\/meetings\/([^/]+)$/.exec(pathname); if (req.method === "GET" && meetingGetRemnic) { this.enforceTokenOp("meetings_get"); await respondMeetingsGet(res, this.respondJson.bind(this), this.service, meetingGetRemnic[1] ?? "", this.wearablesScope(req, parsed.searchParams.get("namespace") ?? undefined, parsed.searchParams.get("sessionKey") ?? undefined)); return; }
    if (req.method === "POST" && (pathname === "/engram/v1/recall/deep" || pathname === "/remnic/v1/recall/deep")) { this.enforceTokenOp("deep_recall"); await respondDeepRecall(req, res, this.respondJson.bind(this), this.readJsonBody.bind(this), this.service, (ns, sk) => this.wearablesScope(req, ns ?? parsed.searchParams.get("namespace") ?? undefined, sk ?? parsed.searchParams.get("sessionKey") ?? undefined), abortSignal); return; }
    if (await maybeRespondRecallNavigation(req, res, pathname, req.method, (op) => this.enforceTokenOp(op), this.respondJson.bind(this), this.readJsonBody.bind(this), this.service, (ns, sk) => this.wearablesScope(req, ns ?? parsed.searchParams.get("namespace") ?? undefined, sk ?? parsed.searchParams.get("sessionKey") ?? undefined))) return; if (await maybeRespondMemoryBrowse(req, res, pathname, req.method, (op) => this.enforceTokenOp(op), this.respondJson.bind(this), this.readJsonBody.bind(this), this.service, (ns) => this.wearablesScope(req, ns ?? parsed.searchParams.get("namespace") ?? undefined))) return;
    if (req.method === "GET" && (pathname === "/engram/v1/location/status" || pathname === "/remnic/v1/location/status")) {
      this.enforceTokenOp("location_status"); await respondLocationStatus(res, this.respondJson.bind(this), this.service); return; }
    if (req.method === "GET" && (pathname === "/engram/v1/location/check" || pathname === "/remnic/v1/location/check")) {
      this.enforceTokenOp("location_check"); await respondLocationCheck(res, this.respondJson.bind(this), this.service); return; }
    if (req.method === "POST" && (pathname === "/engram/v1/location/sync" || pathname === "/remnic/v1/location/sync")) {
      this.enforceTokenOp("location_sync"); await respondLocationSync((await this.readJsonBody(req)) as Record<string, unknown>, res, this.respondJson.bind(this), this.service); return; }
    if (req.method === "POST" && (pathname === "/engram/v1/location/backfill" || pathname === "/remnic/v1/location/backfill")) {
      this.enforceTokenOp("location_backfill"); await respondLocationBackfill((await this.readJsonBody(req)) as Record<string, unknown>, res, this.respondJson.bind(this), this.service); return; }
    if (req.method === "GET" && (pathname === "/engram/v1/location/day" || pathname === "/remnic/v1/location/day")) {
      this.enforceTokenOp("location_day"); await respondLocationDay(parsed.searchParams.get("date"), res, this.respondJson.bind(this), this.service); return; }
    if (req.method === "GET" && (pathname === "/engram/v1/standup" || pathname === "/remnic/v1/standup")) {
      this.enforceTokenOp("standup"); await respondStandup(parsed.searchParams.get("date"), res, this.respondJson.bind(this), this.service); return; }

    if (req.method === "POST" && pathname === "/engram/v1/observe") {
      this.enforceTokenOp("observe"); // boundary dispatch (issue #1525)
      const body = await this.readValidatedBody(req, "observe");
      const op = getOperation("observe");
      if (!op) {
        throw new EngramAccessInputError("access-boundary: operation not registered: observe");
      }
      const output = (await op.run(
        { ...body, namespace: this.resolveNamespace(req, body.namespace) },
        {
          service: this.service,
          authenticatedPrincipal: this.resolveRequestPrincipal(req),
          hooks: { enforceWriteQuota: () => this.ensureWriteRateLimitAvailable(req) },
          sourceConnector: this.resolveConnector(req),
        },
      )) as { result: { dryRun?: boolean; idempotencyReplay?: boolean } };
      if (this.shouldCountWriteRateLimit(output.result)) {
        this.recordWriteRateLimitHit(req);
      }
      this.respondJson(res, 202, output.result);
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
      const body = await this.readValidatedBody(req, "memoryStore");
      const envelope = {
        ...body,
        namespace: this.resolveNamespace(req, body.namespace),
      };
      const op = getOperation("memory_store");
      if (!op) throw new EngramAccessInputError("access-boundary: operation not registered: memory_store");
      const output = (await op.run(envelope, {
        service: this.service,
        authenticatedPrincipal: this.resolveRequestPrincipal(req),
        hooks: { enforceWriteQuota: () => this.ensureWriteRateLimitAvailable(req) },
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
      const body = await this.readJsonBody(req);
      const isWriteSubcommand =
        body.subcommand === "record" || body.subcommand === "supersede";
      if (isWriteSubcommand) {
        this.ensureWriteRateLimitAvailable(req);
      }
      const op = getOperation("coding_decision");
      if (!op) throw new EngramAccessInputError("access-boundary: operation not registered: coding_decision");
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
      const body = await this.readJsonBody(req);
      const isWriteSubcommand = body.subcommand === "refresh";
      if (isWriteSubcommand) {
        this.ensureWriteRateLimitAvailable(req);
      }
      const op = getOperation("coding_architecture");
      if (!op) throw new EngramAccessInputError("access-boundary: operation not registered: coding_architecture");
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
      const body = await this.readJsonBody(req);
      const op = getOperation("coding_delta");
      if (!op) throw new EngramAccessInputError("access-boundary: operation not registered: coding_delta");
      const output = (await op.run(this.gatedBodyNamespace(req, body), {
        service: this.service,
        authenticatedPrincipal: this.resolveRequestPrincipal(req),
      })) as { result: unknown };
      this.respondJson(res, 200, output.result);
      return;
    }

    if (req.method === "POST" && pathname === "/engram/v1/briefing") {
      await respondBriefingHttp({
        gatedBody: this.gatedBodyNamespace(req, await this.readJsonBody(req)),
        service: this.service,
        principal: this.resolveRequestPrincipal(req),
        respondJson: (status, payload) => this.respondJson(res, status, payload),
        abortSignal,
      });
      return;
    }

    if (req.method === "POST" && pathname === "/engram/v1/correction/plan") {
      this.ensureWriteRateLimitAvailable(req);
      const body = await this.readJsonBody(req);
      const op = getOperation("memory_correct_plan");
      if (!op) throw new EngramAccessInputError("access-boundary: operation not registered: memory_correct_plan");
      const output = (await op.run(this.gatedBodyNamespace(req, body), {
        service: this.service,
        authenticatedPrincipal: this.resolveRequestPrincipal(req),
        ...(abortSignal ? { abortSignal } : {}),
      })) as { result: unknown };
      this.recordWriteRateLimitHit(req);
      this.respondJson(res, 200, output.result);
      return;
    }

    if (req.method === "POST" && pathname === "/engram/v1/correction/apply") {
      this.ensureWriteRateLimitAvailable(req);
      const body = await this.readJsonBody(req);
      const op = getOperation("memory_correct_apply");
      if (!op) throw new EngramAccessInputError("access-boundary: operation not registered: memory_correct_apply");
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
        ...(body.rawCategory !== undefined ? { rawCategory: body.rawCategory } : {}),
        // Phase 1 provenance: server-resolved connector identity from the
        // bearer token (REST path, mirroring the MCP tools/call dispatch).
        sourceConnector: this.resolveConnector(req),
      };
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
      res.setHeader("cache-control", "no-store");
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
      const sessionKey =
        this.resolveRequestIdentity(req).sessionKey
        ?? parsed.searchParams.get("session")
        ?? parsed.searchParams.get("sessionKey")
        ?? undefined;
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
      }, this.resolveRequestPrincipal(req));
      this.respondJson(res, 200, response);
      return;
    }

    const entityMatch = pathname.match(/^\/engram\/v1\/entities\/([^/]+)$/);
    if (req.method === "GET" && entityMatch) {
      this.enforceTokenOp("entity_get"); // boundary dispatch (issue #1525)
      const entityName = decodeURIComponent(entityMatch[1] ?? "");
      const namespace = this.resolveNamespace(req, parsed.searchParams.get("namespace") ?? undefined);
      const response = await this.service.entityGet(entityName, namespace, this.resolveRequestPrincipal(req));
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
        onMergedMemoryWritten: (namespace, storageDir) => {
          // #1522: catalog touch handled at the storage chokepoint.
        },
      });
      this.respondJson(res, 200, result);
      return;
    }

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

    if (req.method === "POST" && pathname === "/engram/v1/chat/message") {
      this.enforceTokenOp("chat_message"); // boundary dispatch (issue #1525)
      const body = await this.readJsonBody(req) as Record<string, unknown>;
      const resumeChatSessionId = typeof body.chatSessionId === "string" ? body.chatSessionId : undefined;
      if (resumeChatSessionId) {
        await enforceChatSessionNamespace(this.service, resumeChatSessionId);
      } else {
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
      await enforceChatSessionNamespace(this.service, chatEventsMatch[1] ?? "");
      await handleChatEventsSSE(
        req, res, chatEventsMatch[1] ?? "",
        {
          service: this.service,
          config: this.service.configRef?.chat,
          memoryDir: this.service.memoryDir,
          registerSseCleanup: (cleanup) => {
            this.sseCleanupFns.add(cleanup);
            return () => { this.sseCleanupFns.delete(cleanup); };
          },
        },
        this.resolveRequestPrincipal(req),
      );
      return;
    }

    if (req.method === "GET" && pathname === "/engram/v1/console/state") {
      this.enforceTokenOp("console_state"); // boundary dispatch (issue #1525)
      const namespace = this.resolveNamespace(req, parsed.searchParams.get("namespace") ?? undefined);
      const snapshot = await this.service.consoleState(namespace, this.resolveRequestPrincipal(req));
      this.respondJson(res, 200, snapshot);
      return;
    }

    if (req.method === "GET" && pathname === "/engram/v1/peers") {
      const op = getOperation("peer_list"); // boundary dispatch (issue #1525)
      if (!op) throw new EngramAccessInputError("access-boundary: operation not registered: peer_list");
      // SAFETY: the registered peer_list handler returns { result } from the service.
      const output = (await op.run({}, {
        service: this.service,
        authenticatedPrincipal: this.resolveRequestPrincipal(req),
        sourceConnector: this.resolveConnector(req),
      })) as { result: unknown };
      this.respondJson(res, 200, output.result);
      return;
    }

    const peerProfileMatch = /^\/engram\/v1\/peers\/([^/]+)\/profile$/.exec(pathname);
    if (peerProfileMatch) {
      if (req.method !== "GET") {
        this.respondJson(res, 405, { error: "method_not_allowed", code: "method_not_allowed" });
        return;
      }
      const op = getOperation("peer_profile_get"); // boundary dispatch (issue #1525)
      if (!op) throw new EngramAccessInputError("access-boundary: operation not registered: peer_profile_get");
      const peerId = decodePeerIdSegment(peerProfileMatch[1] ?? "");
      // SAFETY: the registered peer_profile_get handler returns { result } from the service.
      const output = (await op.run({ id: peerId }, {
        service: this.service,
        authenticatedPrincipal: this.resolveRequestPrincipal(req),
        sourceConnector: this.resolveConnector(req),
      })) as { result: { found: boolean } };
      if (!output.result.found) {
        this.respondJson(res, 404, { error: "peer_profile_not_found", code: "peer_profile_not_found" });
        return;
      }
      this.respondJson(res, 200, output.result);
      return;
    }

    const peerIdMatch = /^\/engram\/v1\/peers\/([^/]+)$/.exec(pathname);
    if (peerIdMatch) {
      const peerId = decodePeerIdSegment(peerIdMatch[1] ?? "");

      if (req.method === "GET") {
        const op = getOperation("peer_get"); // boundary dispatch (issue #1525)
        if (!op) throw new EngramAccessInputError("access-boundary: operation not registered: peer_get");
        // SAFETY: the registered peer_get handler returns { result } with a found flag.
        const output = (await op.run({ id: peerId }, {
          service: this.service,
          authenticatedPrincipal: this.resolveRequestPrincipal(req),
          sourceConnector: this.resolveConnector(req),
        })) as { result: { found: boolean } };
        if (!output.result.found) {
          this.respondJson(res, 404, { error: "peer_not_found", code: "peer_not_found" });
          return;
        }
        this.respondJson(res, 200, output.result);
        return;
      }

      if (req.method === "PUT") {
        const body = await this.readJsonBody(req) as Record<string, unknown>;
        const op = getOperation("peer_set"); // boundary dispatch (issue #1525)
        if (!op) throw new EngramAccessInputError("access-boundary: operation not registered: peer_set");
        for (const field of ["kind", "displayName", "notes"]) {
          if (body[field] === null) throw new EngramAccessInputError(`${field} must be a string when provided`);
        }
        // SAFETY: the registered peer_set handler returns { result } with the upsert outcome.
        const output = (await op.run({
          id: peerId,
          kind: body.kind,
          displayName: body.displayName,
          notes: body.notes,
        }, {
          service: this.service,
          authenticatedPrincipal: this.resolveRequestPrincipal(req),
          sourceConnector: this.resolveConnector(req),
        })) as { result: { created: boolean } };
        this.respondJson(res, output.result.created ? 201 : 200, output.result);
        return;
      }

      if (req.method === "DELETE") {
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
          const op = getOperation("peer_forget"); // boundary dispatch (issue #1525)
          if (!op) throw new EngramAccessInputError("access-boundary: operation not registered: peer_forget");
          // SAFETY: the registered peer_forget handler returns { result } with the purge outcome.
          const output = (await op.run({ id: peerId, confirm: "yes" }, {
            service: this.service,
            authenticatedPrincipal: this.resolveRequestPrincipal(req),
            sourceConnector: this.resolveConnector(req),
          })) as { result: unknown };
          this.respondJson(res, 200, output.result);
          return;
        }
        const op = getOperation("peer_delete"); // boundary dispatch (issue #1525)
        if (!op) throw new EngramAccessInputError("access-boundary: operation not registered: peer_delete");
        // SAFETY: the registered peer_delete handler returns { result } with the delete outcome.
        const output = (await op.run({ id: peerId }, {
          service: this.service,
          authenticatedPrincipal: this.resolveRequestPrincipal(req),
          sourceConnector: this.resolveConnector(req),
        })) as { result: unknown };
        this.respondJson(res, 200, output.result);
        return;
      }

      this.respondJson(res, 405, { error: "method_not_allowed", code: "method_not_allowed" });
      return;
    }


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

    //
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
      const kind = optionalNamespaceKindQueryParam(parsed.searchParams.get("kind"));
      const discoveredBy = parsed.searchParams.get("discoveredBy");
      const result = await this.service.adminListNamespaces({
        ...(kind ? { kind } : {}),
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
        this.ensureWriteRateLimitAvailable(req);
        const result = await this.service.adminPromoteMemory({
          sourceMemoryId: body.sourceMemoryId,
          namespace: typeof body.namespace === "string" ? body.namespace : undefined,
          principal: this.resolveRequestPrincipal(req),
          sessionKey: typeof body.sessionKey === "string" ? body.sessionKey : undefined,
          targets,
          reason: body.reason,
        });
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
    const parsed = new URL(req.url ?? "/", `http://${hostToUrlAuthority(this.host)}`);
    const namespaceParam = parsed.searchParams.get("namespace");
    const namespace = this.resolveNamespace(req, namespaceParam && namespaceParam.length > 0 ? namespaceParam : undefined);
    const principal = this.resolveRequestPrincipal(req);
    const memoryDir = await this.service.getMemoryDirForNamespace(namespace, principal);

    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-store, must-revalidate",
      "connection": "keep-alive",
      "x-accel-buffering": "no",     // prevent nginx buffering
      "transfer-encoding": "chunked",
    });

    const writeSSE = (payload: unknown): void => {
      try {
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      } catch {
        // client already gone — cleanup will fire via "close"
      }
    };

    writeSSE({ type: "connected" });

    this.sseClients.add(res);

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

    const heartbeatInterval = setInterval(() => {
      writeSSE({ type: "heartbeat" });
    }, 25_000);

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

    this.sseCleanupFns.add(cleanup);

    req.once("close", cleanup);
    req.once("error", cleanup);
  }

  private async handleMcpRequest(
    req: IncomingMessage,
    res: ServerResponse,
    abortSignal: AbortSignal,
  ): Promise<void> {
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

    const toolName = toDottedRemnicName(typeof request.params?.name === "string" ? request.params.name : "");
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
    const mcpCorrelationId = currentCorrelationId() ?? randomUUID();
    const requestIdentity = this.resolveRequestIdentity(req);
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
      const isRejectedCodegraph = structured?.ok === false;
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
    const cid = currentCorrelationId();
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
    const cid = currentCorrelationId();
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

  protected async respondAdminConsoleShell(
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string,
    relativePath = "index.html",
    allowPrefill = true,
  ): Promise<void> {
    try {
      let body = await readFile(path.join(this.adminConsolePublicDir, relativePath), "utf-8");
      const matched = this.resolveAuthorizedEntry(req, pathname);
      const canPrefillToken =
        allowPrefill &&
        this.adminConsolePrefillToken &&
        matched !== null &&
        matched.capabilities === undefined &&
        this.timingSafeStringEqual(matched.token, this.adminConsolePrefillToken);
      if (canPrefillToken) {
        const serializedToken = serializeInlineScriptValue(this.adminConsolePrefillToken);
        const script = `<script>(function(token,script){const key="__REMNIC_ADMIN_CONSOLE_PREFILL_TOKEN__";const clear=function(){token="";try{delete window[key]}catch{window[key]=""}};window.addEventListener("pagehide",clear,{once:true});window.addEventListener("beforeunload",clear,{once:true});try{if(new URLSearchParams(location.hash.slice(1)).has("secret")){clear();return}Object.defineProperty(window,key,{configurable:true,get:function(){const value=token;clear();return value}})}finally{if(script){script.textContent="";script.remove()}}})(${serializedToken},document.currentScript);</script>`;
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

  protected async respondStatic(res: ServerResponse, filePath: string, contentType: string): Promise<void> {
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

  private matchedEntryCache = new WeakMap<
    IncomingMessage,
    { token: string; connector?: string; capabilities?: TokenCapabilities } | null
  >();

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
    if (this.authToken && this.timingSafeStringEqual(token, this.authToken)) {
      return { token };
    }
    for (const valid of this.authTokens) {
      if (this.timingSafeStringEqual(token, valid)) return { token: valid };
    }
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
    if (this.authTokensGetter) {
      for (const valid of this.authTokensGetter()) {
        if (this.timingSafeStringEqual(token, valid)) return { token: valid };
      }
    }
    return null;
  }

  private resolveAuthorizedEntry(
    req: IncomingMessage,
    pathname?: string,
  ): { token: string; connector?: string; capabilities?: TokenCapabilities } | null {
    const matched = this.resolveMatchedEntry(req, pathname);
    if (!matched) return null;
    if ("connector" in matched && this.tokenPathPolicy) {
      if (typeof matched.connector !== "string" || matched.connector.length === 0) return null;
      return this.tokenPathPolicy(matched.connector, pathname) ? matched : null;
    }
    return matched;
  }

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
  protected enforceTokenOp(op: OperationName): void {
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
 
  private requireOperatorToken(): void {
    if (isCapabilityRestricted(tokenCapabilityStore.getStore())) {
      throw new EngramAccessForbiddenError(
        "token is scoped and may not access operator/admin routes",
      );
    }
  }
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
    if (!req) {
      if (!this.writeLimiter.hasCapacity()) {
        throw new HttpError(429, "write_rate_limited", "write_rate_limited");
      }
      return;
    }
    if (this.pendingWriteQuotas.has(req)) return;
    const reservation = this.writeLimiter.reserve(this.principalForRateLimit(req));
    if (!reservation) {
      throw new HttpError(429, "write_rate_limited", "write_rate_limited");
    }
    this.pendingWriteQuotas.set(req, reservation);
  }

  protected recordWriteRateLimitHit(req?: IncomingMessage): void {
    const pending = req ? this.pendingWriteQuotas.get(req) : undefined;
    if (pending && req) {
      this.pendingWriteQuotas.delete(req);
      pending.commit();
      return;
    }
    this.writeLimiter.record(this.principalForRateLimit(req));
  }

  private releasePendingWriteQuota(req: IncomingMessage): void {
    const pending = this.pendingWriteQuotas.get(req);
    if (!pending) return;
    this.pendingWriteQuotas.delete(req);
    pending.release();
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
    return this.resolveRequestPrincipal(req) ?? this.resolveConnector(req);
  }

  private shouldCountWriteRateLimit(response: { dryRun?: boolean; idempotencyReplay?: boolean }): boolean {
    return response.dryRun !== true && response.idempotencyReplay !== true;
  }

  private respondWearablesError(res: ServerResponse, err: unknown): boolean {
    return respondWearablesErrorGlue(this.respondJson.bind(this), res, err);
  }
}
