
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import express, { type Express, type Request, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import { authorizationHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/authorize.js";
import { isLoopbackHost } from "@remnic/core/runtime/http-transport.js";
import { tokenHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/token.js";
import { createOAuthMetadata, mcpAuthMetadataRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import {
  InvalidGrantError,
  InvalidTokenError,
  ServerError,
  UnsupportedGrantTypeError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthServerProvider, AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthClientInformationFull, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  buildTokenEntry,
  commitTokenEntry,
  getAllValidTokensCached,
  log,
  OAUTH_APP_CONNECTOR_PREFIX,
} from "@remnic/core";


const ALLOWED_TOKEN_AUTH_METHODS = ["client_secret_post", "none"] as const;
export type OAuthTokenEndpointAuthMethod = (typeof ALLOWED_TOKEN_AUTH_METHODS)[number];

/** Default TTL for pending authorizations (10 minutes). */
const DEFAULT_APPROVAL_TTL_SECONDS = 600;

const AUTHORIZATION_CODE_TTL_MS = 120_000;

const HIGH_ENTROPY_HEX_BYTES = 16;

export function oauthConnectorIdForRedirect(redirectUri: string): string {
  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    return `${OAUTH_APP_CONNECTOR_PREFIX}unknown`;
  }
  const host = url.hostname.toLowerCase();
  const isHost = (domain: string) => host === domain || host.endsWith(`.${domain}`);
  if (isHost("chatgpt.com") || isHost("openai.com")) return "chatgpt";
  if (isHost("claude.ai") || isHost("claude.com")) return "claude-ai";
  const key = `${url.protocol}//${host}${url.port ? `:${url.port}` : ""}`;
  const slug = encodeURIComponent(key) || "unknown";
  return `${OAUTH_APP_CONNECTOR_PREFIX}${slug}`;
}


export interface OAuthConfigInput {
  enabled?: unknown;
  issuerUrl?: unknown;
  clientId?: unknown;
  clientSecret?: unknown;
  tokenEndpointAuthMethod?: unknown;
  redirectUris?: unknown;
  approvalTtlSeconds?: unknown;
}

export interface ParsedOAuthConfig {
  enabled: boolean;
  issuerUrl: string;
  clientId: string;
  clientSecret: string;
  tokenEndpointAuthMethod: OAuthTokenEndpointAuthMethod;
  redirectUris: string[];
  approvalTtlSeconds: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function coerceBoolean(value: unknown, source: string): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(normalized)) return true;
    if (["false", "0", "no", "off"].includes(normalized)) return false;
  }
  throw new Error(`Invalid ${source}: expected a boolean (got: ${JSON.stringify(value)})`);
}

function coerceNonEmptyString(value: unknown, source: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Invalid ${source}: expected a non-empty string`);
  }
  return value.trim();
}

function coercePositiveInteger(value: unknown, source: string): number {
  const num = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof num !== "number" || !Number.isInteger(num) || num <= 0) {
    throw new Error(`Invalid ${source}: expected a positive integer (got: ${JSON.stringify(value)})`);
  }
  return num;
}

function coerceAbsoluteHttpsUrl(
  value: unknown,
  source: string,
  opts: { allowHttpForLocalhost: boolean },
): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Invalid ${source}: expected a non-empty URL string`);
  }
  const trimmed = value.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`Invalid ${source}: "${trimmed}" is not a valid URL`);
  }
  if (parsed.hash || parsed.search) {
    throw new Error(`Invalid ${source}: URL must not include a query string or fragment`);
  }
  const isHttps = parsed.protocol === "https:";
  const isLoopbackHttp =
    opts.allowHttpForLocalhost &&
    parsed.protocol === "http:" &&
    isLoopbackHost(parsed.hostname);
  if (!isHttps && !isLoopbackHttp) {
    throw new Error(
      `Invalid ${source}: must be an absolute https:// URL (http:// allowed only for loopback hosts)`,
    );
  }
  return trimmed;
}

function coerceTokenAuthMethod(value: unknown, source: string): OAuthTokenEndpointAuthMethod {
  if (typeof value !== "string") {
    throw new Error(`Invalid ${source}: expected one of ${ALLOWED_TOKEN_AUTH_METHODS.join(", ")}`);
  }
  const trimmed = value.trim();
  const match = ALLOWED_TOKEN_AUTH_METHODS.find((method) => method === trimmed);
  if (!match) {
    throw new Error(
      `Invalid ${source}: "${trimmed}" is not allowed. Use one of ${ALLOWED_TOKEN_AUTH_METHODS.join(", ")}.`,
    );
  }
  return match;
}

function coerceRedirectUris(value: unknown, source: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`Invalid ${source}: expected an array of exact redirect URI strings`);
  }
  return value.map((entry, index) =>
    coerceAbsoluteHttpsUrl(entry, `${source}[${index}]`, { allowHttpForLocalhost: true }),
  );
}

const DISABLED_OAUTH_CONFIG: ParsedOAuthConfig = {
  enabled: false,
  issuerUrl: "",
  clientId: "",
  clientSecret: "",
  tokenEndpointAuthMethod: "client_secret_post",
  redirectUris: [],
  approvalTtlSeconds: DEFAULT_APPROVAL_TTL_SECONDS,
};

/**
 * Parse the `server.oauth` config block. Throws on invalid input.
 *
 * When disabled (or absent), only `enabled` is consulted — a
 * partially-filled disabled block is legal. When enabled, `issuerUrl`,
 * `clientId`, and (unless auth method is `none`) `clientSecret` are
 * required. `redirectUris` MAY be empty: that is "setup mode" — the
 * discovery documents are served so ChatGPT can create the app, but every
 * authorization attempt is refused until the exact per-app callback URL
 * (shown in ChatGPT's app management page) is added to the allowlist.
 */
export function parseOAuthConfig(raw: unknown): ParsedOAuthConfig {
  if (raw === undefined) return { ...DISABLED_OAUTH_CONFIG };
  if (!isPlainObject(raw)) {
    throw new Error("Invalid server.oauth: expected a JSON object");
  }
  const input = raw as OAuthConfigInput;
  const enabled = input.enabled === undefined ? false : coerceBoolean(input.enabled, "server.oauth.enabled");
  if (!enabled) return { ...DISABLED_OAUTH_CONFIG };

  const issuerUrl =
    input.issuerUrl === undefined
      ? ""
      : coerceAbsoluteHttpsUrl(input.issuerUrl, "server.oauth.issuerUrl", { allowHttpForLocalhost: true });
  const clientId =
    input.clientId === undefined ? "" : coerceNonEmptyString(input.clientId, "server.oauth.clientId");
  const clientSecret =
    input.clientSecret === undefined ? "" : coerceNonEmptyString(input.clientSecret, "server.oauth.clientSecret");
  const tokenEndpointAuthMethod =
    input.tokenEndpointAuthMethod === undefined
      ? "client_secret_post"
      : coerceTokenAuthMethod(input.tokenEndpointAuthMethod, "server.oauth.tokenEndpointAuthMethod");
  const redirectUris =
    input.redirectUris === undefined ? [] : coerceRedirectUris(input.redirectUris, "server.oauth.redirectUris");
  const approvalTtlSeconds =
    input.approvalTtlSeconds === undefined
      ? DEFAULT_APPROVAL_TTL_SECONDS
      : coercePositiveInteger(input.approvalTtlSeconds, "server.oauth.approvalTtlSeconds");

  if (issuerUrl === "") {
    throw new Error("Invalid server.oauth.issuerUrl: required when enabled (absolute https URL)");
  }
  if (clientId === "") {
    throw new Error("Invalid server.oauth.clientId: required when enabled (non-empty string)");
  }
  if (tokenEndpointAuthMethod !== "none" && clientSecret === "") {
    throw new Error(
      `Invalid server.oauth.clientSecret: required when enabled and tokenEndpointAuthMethod is "${tokenEndpointAuthMethod}"`,
    );
  }

  return {
    enabled: true,
    issuerUrl,
    clientId,
    clientSecret,
    tokenEndpointAuthMethod,
    redirectUris,
    approvalTtlSeconds,
  };
}


/**
 * Build the OAuth config overrides from env vars (REMNIC_OAUTH_*). The
 * merged result goes back through `parseOAuthConfig`, so invalid values
 * throw the same precise messages.
 */
export function readOAuthEnvOverrides(): Record<string, unknown> {
  const overrides: Record<string, unknown> = {};
  if (process.env.REMNIC_OAUTH_ENABLED !== undefined) overrides.enabled = process.env.REMNIC_OAUTH_ENABLED;
  if (process.env.REMNIC_OAUTH_ISSUER_URL !== undefined) overrides.issuerUrl = process.env.REMNIC_OAUTH_ISSUER_URL;
  if (process.env.REMNIC_OAUTH_CLIENT_ID !== undefined) overrides.clientId = process.env.REMNIC_OAUTH_CLIENT_ID;
  if (process.env.REMNIC_OAUTH_CLIENT_SECRET !== undefined) {
    overrides.clientSecret = process.env.REMNIC_OAUTH_CLIENT_SECRET;
  }
  if (process.env.REMNIC_OAUTH_TOKEN_AUTH_METHOD !== undefined) {
    overrides.tokenEndpointAuthMethod = process.env.REMNIC_OAUTH_TOKEN_AUTH_METHOD;
  }
  if (process.env.REMNIC_OAUTH_REDIRECT_URIS !== undefined) {
    overrides.redirectUris = process.env.REMNIC_OAUTH_REDIRECT_URIS.split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }
  if (process.env.REMNIC_OAUTH_APPROVAL_TTL_SECONDS !== undefined) {
    overrides.approvalTtlSeconds = process.env.REMNIC_OAUTH_APPROVAL_TTL_SECONDS;
  }
  return overrides;
}

export function applyOAuthEnvOverrides(fileBlock: unknown): ParsedOAuthConfig {
  if (fileBlock !== undefined && !isPlainObject(fileBlock)) {
    return parseOAuthConfig(fileBlock);
  }
  const overrides = readOAuthEnvOverrides();
  const merged: Record<string, unknown> = isPlainObject(fileBlock) ? { ...fileBlock } : {};
  for (const [key, value] of Object.entries(overrides)) {
    merged[key] = value;
  }
  return parseOAuthConfig(merged);
}


function timingSafeStringEqual(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const digestA = createHash("sha256").update(a, "utf8").digest();
  const digestB = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(digestA, digestB);
}

function randomHex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

function newApprovalRef(): string {
  return BigInt(`0x${randomHex(8)}`).toString(36);
}


export interface PendingTransaction {
  /** High-entropy public id; key for the poll endpoint. */
  txn: string;
  /** Separate high-entropy secret required alongside `txn` to poll. */
  pollSecret: string;
  /** Human-visible approval ref for the CLI. */
  ref: string;
  clientId: string;
  redirectUri: string;
  scopes: string[];
  resource: string | undefined;
  state: string | undefined;
  codeChallenge: string;
  createdAt: number;
  expiresAt: number;
  outcome?: { kind: "approved"; code: string } | { kind: "denied" };
}

interface AuthorizationCodeEntry {
  code: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  resource: string | undefined;
  expiresAt: number;
  consumed: boolean;
}

export class OAuthState {
  private readonly pending = new Map<string, PendingTransaction>();
  private readonly codes = new Map<string, AuthorizationCodeEntry>();
  private readonly config: ParsedOAuthConfig;

  constructor(config: ParsedOAuthConfig) {
    this.config = config;
  }

  get approvalTtlMs(): number {
    return this.config.approvalTtlSeconds * 1000;
  }

  /** Delete expired entries. Run before each lookup. */
  private gc(now: number): void {
    for (const [key, code] of this.codes) {
      if (code.expiresAt < now) this.codes.delete(key);
    }
    for (const [key, txn] of this.pending) {
      if (txn.expiresAt >= now) continue;
      if (txn.outcome?.kind === "approved" && this.codes.has(txn.outcome.code)) continue;
      this.pending.delete(key);
    }
  }

  createPending(args: {
    clientId: string;
    redirectUri: string;
    scopes: string[];
    resource: string | undefined;
    state: string | undefined;
    codeChallenge: string;
  }): PendingTransaction {
    const now = Date.now();
    this.gc(now);
    const txn: PendingTransaction = {
      txn: randomHex(HIGH_ENTROPY_HEX_BYTES),
      pollSecret: randomHex(HIGH_ENTROPY_HEX_BYTES),
      ref: newApprovalRef(),
      clientId: args.clientId,
      redirectUri: args.redirectUri,
      scopes: args.scopes,
      resource: args.resource,
      state: args.state,
      codeChallenge: args.codeChallenge,
      createdAt: now,
      expiresAt: now + this.approvalTtlMs,
    };
    this.pending.set(txn.txn, txn);
    return txn;
  }

  listPending(): PendingTransaction[] {
    const now = Date.now();
    this.gc(now);
    return Array.from(this.pending.values())
      .filter((txn) => !txn.outcome)
      .sort((a, b) => (a.createdAt === b.createdAt ? a.txn.localeCompare(b.txn) : a.createdAt - b.createdAt));
  }

  findByRef(ref: string): PendingTransaction | undefined {
    const now = Date.now();
    this.gc(now);
    for (const txn of this.pending.values()) {
      if (txn.ref === ref) return txn;
    }
    return undefined;
  }

  /**
   * Approve a pending transaction by ref. Returns the authorization code.
   * Re-approval of an already-approved txn returns the same code so the
   * operator can recover from a client-side miss. Throws on
   * missing/expired/denied.
   */
  approveByRef(ref: string): { code: string; txn: PendingTransaction } {
    const now = Date.now();
    this.gc(now);
    const txn = this.findByRef(ref);
    if (!txn) throw new Error("unknown or expired ref");
    if (txn.outcome) {
      if (txn.outcome.kind === "approved") return { code: txn.outcome.code, txn };
      throw new Error("denied");
    }
    const code = randomHex(HIGH_ENTROPY_HEX_BYTES);
    this.codes.set(code, {
      code,
      clientId: txn.clientId,
      redirectUri: txn.redirectUri,
      codeChallenge: txn.codeChallenge,
      resource: txn.resource,
      expiresAt: now + AUTHORIZATION_CODE_TTL_MS,
      consumed: false,
    });
    txn.outcome = { kind: "approved", code };
    return { code, txn };
  }

  denyByRef(ref: string): void {
    const now = Date.now();
    this.gc(now);
    const txn = this.findByRef(ref);
    if (!txn) throw new Error("unknown or expired ref");
    if (txn.outcome) {
      if (txn.outcome.kind === "denied") return; // idempotent
      throw new Error("already approved");
    }
    txn.outcome = { kind: "denied" };
  }

  buildRedirect(txn: PendingTransaction, code: string): string {
    const url = new URL(txn.redirectUri);
    url.searchParams.set("code", code);
    if (txn.state) url.searchParams.set("state", txn.state);
    return url.toString();
  }

  /** Poll status; `undefined` on wrong pollSecret. */
  poll(
    txnId: string,
    pollSecret: string,
  ):
    | { status: "pending" }
    | { status: "approved"; redirect: string }
    | { status: "denied" }
    | { status: "expired" }
    | undefined {
    const now = Date.now();
    this.gc(now);
    const txn = this.pending.get(txnId);
    if (!txn) return { status: "expired" };
    if (!timingSafeStringEqual(txn.pollSecret, pollSecret)) return undefined;
    if (!txn.outcome) {
      if (txn.expiresAt < now) return { status: "expired" };
      return { status: "pending" };
    }
    if (txn.outcome.kind === "denied") return { status: "denied" };
    if (!this.peekCode(txn.outcome.code)) return { status: "expired" };
    return { status: "approved", redirect: this.buildRedirect(txn, txn.outcome.code) };
  }

  /**
   * Read a code entry without consuming it (SDK PKCE verification path).
   * Returns undefined on unknown/expired/consumed.
   */
  peekCode(code: string): AuthorizationCodeEntry | undefined {
    const now = Date.now();
    this.gc(now);
    const entry = this.codes.get(code);
    if (!entry || entry.consumed || entry.expiresAt < now) return undefined;
    return entry;
  }

  /**
   * Consume a code after the SDK verified PKCE. Enforces single use and
   * the client/redirect/resource bindings. Returns the entry on success,
   * undefined on any mismatch.
   */
  takeCode(args: {
    code: string;
    clientId: string;
    redirectUri: string | undefined;
    resource: string | undefined;
  }): AuthorizationCodeEntry | undefined {
    const entry = this.peekCode(args.code);
    if (!entry) return undefined;
    entry.consumed = true;
    if (!timingSafeStringEqual(entry.clientId, args.clientId)) return undefined;
    // The token request MAY omit redirect_uri only when the authorization
    // request used the client's single registered URI; when provided it
    // must match the bound value exactly.
    if (args.redirectUri !== undefined && entry.redirectUri !== args.redirectUri) return undefined;
    if (entry.resource !== undefined) {
      if (args.resource === undefined) return undefined;
      if (entry.resource !== args.resource) return undefined;
    }
    return entry;
  }

  reviveCode(code: string): void {
    const entry = this.codes.get(code);
    if (entry && entry.expiresAt >= Date.now()) {
      entry.consumed = false;
    }
  }
}


function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderApprovalPage(args: { txn: PendingTransaction; issuerUrl: string; command: string }): string {
  const { txn, issuerUrl, command } = args;
  const safeRef = escapeHtml(txn.ref);
  const safeClientId = escapeHtml(txn.clientId);
  const safeRedirect = escapeHtml(txn.redirectUri);
  const safeResource = txn.resource ? escapeHtml(txn.resource) : "";
  const safeCommand = escapeHtml(command);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Remnic MCP authorization</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; max-width: 640px; margin: 2rem auto; padding: 0 1rem; line-height: 1.5; color: #1a1a1a; }
  h1 { font-size: 1.4rem; }
  .ref { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 1.1rem; background: #f4f4f5; padding: 0.25rem 0.5rem; border-radius: 4px; }
  details { margin: 1rem 0; padding: 0.75rem 1rem; background: #fafafa; border: 1px solid #e4e4e7; border-radius: 6px; }
  summary { cursor: pointer; font-weight: 600; }
  code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.9rem; }
  pre { background: #f4f4f5; padding: 0.75rem; border-radius: 4px; overflow-x: auto; }
  #status { margin-top: 1.5rem; padding: 0.75rem 1rem; border-radius: 6px; font-weight: 600; }
  .pending { background: #fef9c3; color: #713f12; }
  .approved { background: #dcfce7; color: #14532d; }
  .denied { background: #fee2e2; color: #7f1d1d; }
  .expired { background: #f3f4f6; color: #374151; }
</style>
</head>
<body>
<h1>Remnic MCP authorization pending</h1>
<p>An external application has requested access to your Remnic MCP server.
Open a terminal on the Remnic host and run:</p>
<pre>${safeCommand}</pre>
<p>Approval ref: <span class="ref">${safeRef}</span></p>
<details>
  <summary>Request details</summary>
  <ul>
    <li>Client ID: <code>${safeClientId}</code></li>
    <li>Redirect URI: <code>${safeRedirect}</code></li>
    ${safeResource ? `<li>Resource: <code>${safeResource}</code></li>` : ""}
    <li>Scopes: <code>${escapeHtml(txn.scopes.join(" ")) || "(none requested)"}</code></li>
  </ul>
</details>
<div id="status" class="pending">Waiting for operator approval&hellip;</div>
<script>
(function () {
  var statusEl = document.getElementById("status");
  var txn = ${JSON.stringify(txn.txn)};
  var secret = ${JSON.stringify(txn.pollSecret)};
  var issuer = ${JSON.stringify(issuerUrl)};
  var done = false;
  function render(result) {
    if (result.status === "pending") return;
    done = true;
    if (result.status === "approved") {
      statusEl.className = "approved";
      statusEl.textContent = "Approved — redirecting\\u2026";
      window.location.replace(result.redirect);
    } else if (result.status === "denied") {
      statusEl.className = "denied";
      statusEl.textContent = "Denied by operator. Return to the calling app to retry or cancel.";
    } else {
      statusEl.className = "expired";
      statusEl.textContent = "This request expired. Return to the calling app to retry.";
    }
  }
  function poll() {
    if (done) return;
    fetch(issuer + "/oauth/authorize/poll", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ txn: txn, pollSecret: secret }),
    })
      .then(function (res) {
        if (!res.ok) throw new Error("poll failed");
        return res.json();
      })
      .then(render)
      .catch(function () { /* transient; next interval retries */ });
  }
  poll();
  setInterval(poll, 3000);
})();
</script>
</body>
</html>`;
}


class RemnicOAuthProvider implements OAuthServerProvider {
  private readonly config: ParsedOAuthConfig;
  private readonly state: OAuthState;
  private readonly staticClient: OAuthClientInformationFull;
  /** Token-store override for tests; production uses the default path. */
  private readonly tokensPath?: string;

  constructor(config: ParsedOAuthConfig, state: OAuthState, tokensPath?: string) {
    this.config = config;
    this.state = state;
    this.tokensPath = tokensPath;
    this.staticClient = {
      client_id: config.clientId,
      ...(config.tokenEndpointAuthMethod === "none" ? {} : { client_secret: config.clientSecret }),
      redirect_uris: config.redirectUris,
      token_endpoint_auth_method: config.tokenEndpointAuthMethod,
      grant_types: ["authorization_code"],
      response_types: ["code"],
    };
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    const client = this.staticClient;
    return {
      getClient: (clientId: string) => (clientId === client.client_id ? client : undefined),
      // No registerClient: dynamic client registration is deliberately
      // NOT supported — the single client is pre-registered via config.
    };
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    const txn = this.state.createPending({
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      scopes: params.scopes ?? [],
      resource: params.resource?.href,
      state: params.state,
      codeChallenge: params.codeChallenge,
    });
    log.info(
      `OAuth authorization pending: ref=${txn.ref} client=${txn.clientId} redirect=${txn.redirectUri} — ` +
        `run \`remnic oauth approve ${txn.ref}\` to approve`,
    );
    res
      .status(200)
      .type("html")
      .send(
        renderApprovalPage({
          txn,
          issuerUrl: this.config.issuerUrl.replace(/\/+$/, ""),
          command: `remnic oauth approve ${txn.ref}`,
        }),
      );
  }

  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const entry = this.state.peekCode(authorizationCode);
    if (!entry || !timingSafeStringEqual(entry.clientId, client.client_id)) {
      throw new InvalidGrantError("authorization code is invalid, expired, or already used");
    }
    return entry.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const entry = this.state.takeCode({
      code: authorizationCode,
      clientId: client.client_id,
      redirectUri,
      resource: resource?.href,
    });
    if (!entry) {
      throw new InvalidGrantError("authorization code is invalid, expired, or already used");
    }
    const connectorId = oauthConnectorIdForRedirect(entry.redirectUri);
    const tokenEntry = buildTokenEntry(connectorId);
    try {
      commitTokenEntry(tokenEntry, this.tokensPath);
    } catch (err) {
      this.state.reviveCode(authorizationCode);
      log.warn(
        `OAuth token persist failed; authorization code revived for retry: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      throw new ServerError("failed to persist the issued token; retry the exchange");
    }
    log.info(`OAuth token issued for connector "${connectorId}" (client=${client.client_id})`);
    return {
      access_token: tokenEntry.token,
      token_type: "Bearer",
    };
  }

  async exchangeRefreshToken(): Promise<OAuthTokens> {
    throw new UnsupportedGrantTypeError(
      "refresh_token grant is not supported; re-link the app to rotate the token",
    );
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const valid = getAllValidTokensCached(this.tokensPath).some((candidate) =>
      timingSafeStringEqual(candidate, token),
    );
    if (!valid) {
      throw new InvalidTokenError("unknown or revoked token");
    }
    return {
      token,
      clientId: this.config.clientId,
      scopes: [],
    };
  }
}


export interface OAuthAppBundle {
  app: Express;
  state: OAuthState;
  /** Paths owned by the OAuth facade (exact matches). */
  ownedExactPaths: string[];
  /** Path prefixes owned by the OAuth facade. */
  ownedPathPrefixes: string[];
}

/**
 * Build the express app hosting all OAuth endpoints.
 *
 * SDK-owned: `/authorize`, `/token`,
 * `/.well-known/oauth-authorization-server`,
 * `/.well-known/oauth-protected-resource/mcp`.
 * Remnic-owned: `/oauth/authorize/poll` (public, secret-gated),
 * `/oauth/pending[...]` (operator-only), plus a bare
 * `/.well-known/oauth-protected-resource` alias for clients that do not
 * implement RFC 9728 path insertion.
 *
 * @param authCtxLookup returns the operator-authorization context the core
 * access server computed for this request; the facade never validates
 * bearer tokens itself.
 */
export function buildOAuthApp(
  config: ParsedOAuthConfig,
  authCtxLookup: (req: IncomingMessage) => { authorized: boolean },
  deps?: { tokensPath?: string },
): OAuthAppBundle {
  const state = new OAuthState(config);
  const provider = new RemnicOAuthProvider(config, state, deps?.tokensPath);
  const issuer = new URL(config.issuerUrl);
  const resourceServerUrl = new URL("/mcp", issuer);

  if (config.redirectUris.length === 0) {
    log.warn(
      "server.oauth.redirectUris is empty — OAuth discovery is live but every authorization will be refused " +
        "until the exact callback URL from ChatGPT's app management page is added (setup mode).",
    );
  }

  const app = express();
  app.disable("x-powered-by");

  const oauthMetadata = createOAuthMetadata({ provider, issuerUrl: issuer });
  oauthMetadata.token_endpoint_auth_methods_supported = [config.tokenEndpointAuthMethod];
  oauthMetadata.grant_types_supported = ["authorization_code"];

  app.use("/authorize", authorizationHandler({ provider }));
  app.use("/token", tokenHandler({ provider }));
  app.use(mcpAuthMetadataRouter({ oauthMetadata, resourceServerUrl, resourceName: "Remnic" }));

  // Alias: serve the protected-resource document at the bare well-known
  // path too (the SDK mounts only the RFC 9728 path-inserted variant).
  app.get("/.well-known/oauth-protected-resource", (_req: Request, res: Response) => {
    res.status(200).json({
      resource: resourceServerUrl.href,
      authorization_servers: [oauthMetadata.issuer],
      resource_name: "Remnic",
    });
  });

  app.use(express.json({ limit: "32kb" }));
  const makeLimiter = (max: number) =>
    rateLimit({
      windowMs: 60_000,
      max,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: "rate_limited", error_description: "too many requests; retry later" },
    });
  const pollLimiter = makeLimiter(120);
  const operatorReadLimiter = makeLimiter(60);
  const operatorDecisionLimiter = makeLimiter(30);

  app.post("/oauth/authorize/poll", pollLimiter, (req: Request, res: Response) => {
    const body: unknown = req.body;
    if (
      !isPlainObject(body) ||
      typeof body.txn !== "string" ||
      typeof body.pollSecret !== "string" ||
      body.txn.length === 0 ||
      body.pollSecret.length === 0
    ) {
      res.status(400).json({ error: "invalid_request", error_description: "txn and pollSecret are required" });
      return;
    }
    const result = state.poll(body.txn, body.pollSecret);
    if (result === undefined) {
      res.status(401).json({ error: "invalid_request", error_description: "unknown txn or wrong pollSecret" });
      return;
    }
    res.status(200).json(result);
  });

  function operatorGuard(req: Request, res: Response): boolean {
    if (authCtxLookup(req).authorized === true) return true;
    res.status(401).json({ error: "unauthorized", error_description: "operator authentication required" });
    return false;
  }

  app.get("/oauth/pending", operatorReadLimiter, (req: Request, res: Response) => {
    if (!operatorGuard(req, res)) return;
    const pending = state.listPending().map((txn) => ({
      ref: txn.ref,
      clientId: txn.clientId,
      redirectUri: txn.redirectUri,
      scopes: txn.scopes,
      resource: txn.resource ?? null,
      createdAt: new Date(txn.createdAt).toISOString(),
      expiresAt: new Date(txn.expiresAt).toISOString(),
    }));
    res.status(200).json({ pending });
  });

  function decisionHandler(action: "approve" | "deny") {
    return (req: Request, res: Response) => {
      if (!operatorGuard(req, res)) return;
      const ref = req.params.ref;
      if (!ref) {
        res.status(400).json({ error: "invalid_request", error_description: "ref is required" });
        return;
      }
      try {
        if (action === "approve") {
          const { txn, code } = state.approveByRef(ref);
          res.status(200).json({ ref, status: "approved", redirect: state.buildRedirect(txn, code) });
        } else {
          state.denyByRef(ref);
          res.status(200).json({ ref, status: "denied" });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message === "unknown or expired ref") {
          res.status(404).json({ error: "invalid_request", error_description: message });
          return;
        }
        if (message === "denied" || message === "already approved") {
          res.status(409).json({ error: "invalid_request", error_description: message });
          return;
        }
        log.warn(`OAuth ${action} endpoint unexpected error: ${message}`);
        res.status(500).json({ error: "server_error", error_description: "internal error" });
      }
    };
  }

  app.post("/oauth/pending/:ref/approve", operatorDecisionLimiter, decisionHandler("approve"));
  app.post("/oauth/pending/:ref/deny", operatorDecisionLimiter, decisionHandler("deny"));

  return {
    app,
    state,
    ownedExactPaths: [
      "/authorize",
      "/token",
      "/.well-known/oauth-authorization-server",
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/mcp",
    ],
    ownedPathPrefixes: ["/oauth/"],
  };
}


/**
 * Adapt the OAuth express app to the core access server's
 * `externalRequestHandler` hook. Ownership is decided by pathname BEFORE
 * delegating to express (deterministic — never inferred from express
 * fallthrough), so non-OAuth requests always continue down the normal
 * core pipeline.
 */
export function buildOAuthRequestHandler(
  config: ParsedOAuthConfig,
  deps?: { tokensPath?: string },
): (req: IncomingMessage, res: ServerResponse, ctx: { authorized: boolean }) => Promise<boolean> {
  if (!config.enabled) {
    return async () => false;
  }
  // Core computes the operator-authorization ctx per request and hands it
  // to the hook; stash it per-request so express handlers can read it
  // without ever re-validating headers themselves.
  const ctxByRequest = new WeakMap<IncomingMessage, { authorized: boolean }>();
  const bundle = buildOAuthApp(config, (req) => ctxByRequest.get(req) ?? { authorized: false }, deps);
  const exactPaths = new Set(bundle.ownedExactPaths);

  return (req, res, ctx) => {
    let pathname: string;
    try {
      pathname = new URL(req.url ?? "/", "http://placeholder").pathname;
    } catch {
      return Promise.resolve(false);
    }
    const owned = exactPaths.has(pathname) || bundle.ownedPathPrefixes.some((prefix) => pathname.startsWith(prefix));
    if (!owned) return Promise.resolve(false);

    ctxByRequest.set(req, ctx);
    const { promise, resolve } = Promise.withResolvers<boolean>();
    const finish = () => resolve(true);
    res.on("finish", finish);
    res.on("close", finish);
    // An express app instance is a Node request listener; the third
    // argument runs when no route matched or a handler errored.
    bundle.app(req as Request, res as Response, (err: unknown) => {
      if (!res.headersSent) {
        if (err) {
          log.warn(`OAuth facade error: ${err instanceof Error ? err.message : String(err)}`);
          res.statusCode = 500;
          res.setHeader("content-type", "application/json; charset=utf-8");
          res.end(JSON.stringify({ error: "server_error", error_description: "internal error" }));
        } else {
          res.statusCode = 404;
          res.setHeader("content-type", "application/json; charset=utf-8");
          res.end(JSON.stringify({ error: "not_found", error_description: "unknown OAuth endpoint" }));
        }
      }
      resolve(true);
    });
    return promise;
  };
}
