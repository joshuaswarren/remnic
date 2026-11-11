import type { AdapterRegistry } from "./adapters/index.js";
import type { EngramAccessService } from "./access-service.js";
import type { TokenCapabilities } from "./access-token-capabilities.js";
import type { SupportPassportExternalRequestHandler } from "./support-passport/public-http.js";

/** Public option, status and admin-control types for the access HTTP server (split out of access-http.ts for the file-size ratchet, #1995). */

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
  externalRequestHandler?: SupportPassportExternalRequestHandler;
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

// Moved unchanged from access-http.ts (public admin API, consumed by @remnic/server): the patch
// payload is validated by the host's admin controls, so the value type is intentionally open here.
// oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type
export type RemnicAdminConfigPatch = Record<string, unknown>;

export interface RemnicAdminControls {
  status: () => Promise<RemnicAdminDashboardStatus>;
  update?: (patch: RemnicAdminConfigPatch) => Promise<RemnicAdminDashboardStatus>;
}
