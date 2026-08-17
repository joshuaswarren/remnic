/**
 * Remote daemon targeting for `@remnic/cli` (issue #2448).
 *
 * The CLI historically built every daemon URL as
 * `http://${server.host}:${server.port}`, so a TLS-terminated remnic-server
 * origin was unreachable from the CLI. This module owns URL resolution now:
 *
 * - `REMNIC_DAEMON_URL` (legacy `ENGRAM_DAEMON_URL`) or `server.url` in
 *   remnic.config.json configures a full remote origin — `http://` or
 *   `https://`, with an optional path prefix for reverse proxies. Env wins
 *   over the file, mirroring the daemon's own env-over-config precedence.
 * - With a remote origin set, `status`, `query`, `xray`, the `doctor`
 *   daemon check, and the `oauth` commands target that origin with
 *   `Authorization: Bearer <token>` (token precedence identical to
 *   `resolveOperatorToken`). No local daemon is spawned or probed;
 *   `remnic daemon start|install` stays local by design.
 * - Without a remote origin, `resolveDaemonBaseUrl()` keeps the previous
 *   `http://host:port` behavior, env overrides included, so it matches
 *   the endpoint `startServer()` actually binds.
 *
 * Invalid remote URLs throw instead of silently falling back to the
 * local `http://host:port` form, and an `https://` origin is never
 * rewritten to plain http — that downgrade is a loud error.
 */
import fs from "node:fs";
import type { RecallXraySnapshot } from "@remnic/core";
import type { QueryRenderableResult } from "./index.js";

/** Remote daemon target: normalized base URL plus its bearer token. */
export interface RemoteDaemon {
  baseUrl: string;
  token?: string;
}

/** Primary env var wins; legacy env var is checked as fallback. */
export function readCompatEnv(primary: string, legacy: string): string | undefined {
  return process.env[primary] ?? process.env[legacy];
}

/**
 * Read + parse the remnic config file, returning a `Record<string, unknown>`
 * view of its top level. Returns `undefined` on any IO / parse error so
 * callers can fall through to the env / default path. The cast is the
 * single point that materialises the unsafe boundary; callers narrow with
 * `typeof` / `in` at every access (rule: `ts-no_inline-cast-access`).
 */
export function readRemnicConfigRecord(configPath: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Normalize a configured remote daemon URL to a base URL (origin plus an
 * optional path prefix, no trailing slash). Throws for anything the client
 * cannot honor — an unparseable URL or a non-http(s) scheme — so a bad
 * `REMNIC_DAEMON_URL` / `server.url` surfaces at the call site instead of
 * silently downgrading to the local `http://host:port` form.
 */
export function normalizeRemoteDaemonUrl(raw: string, source: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    throw new Error(`Invalid ${source} "${raw}": expected an http:// or https:// URL.`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Invalid ${source} "${raw}": scheme must be http:// or https://.`);
  }
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
}

/**
 * Resolve the remote origin, if one is configured. Env
 * `REMNIC_DAEMON_URL` (legacy `ENGRAM_DAEMON_URL`) wins over `server.url`
 * in the config file. Returns `undefined` in local mode.
 */
export function resolveRemoteDaemonUrl(configPath: string): string | undefined {
  const envUrl = readCompatEnv("REMNIC_DAEMON_URL", "ENGRAM_DAEMON_URL");
  if (typeof envUrl === "string" && envUrl.trim().length > 0) {
    return normalizeRemoteDaemonUrl(envUrl, "REMNIC_DAEMON_URL/ENGRAM_DAEMON_URL");
  }
  const raw = readRemnicConfigRecord(configPath);
  if (raw && "server" in raw) {
    const server = raw.server;
    if (server && typeof server === "object") {
      const candidate = (server as Record<string, unknown>).url;
      if (typeof candidate === "string" && candidate.trim().length > 0) {
        return normalizeRemoteDaemonUrl(candidate, "server.url");
      }
    }
  }
  return undefined;
}

/**
 * Resolve the base URL every CLI daemon call targets. A configured remote
 * origin (http or https, verified) wins; otherwise this resolves the local
 * daemon endpoint. Env overrides win over the file for host/port, matching
 * the daemon: `startServer()` merges REMNIC_HOST/REMNIC_PORT (ENGRAM_*
 * legacy) over `server.host`/`server.port`, so the CLI must resolve the
 * same endpoint or it targets the wrong port.
 */
export function resolveDaemonBaseUrl(configPath: string): string {
  const remoteUrl = resolveRemoteDaemonUrl(configPath);
  if (remoteUrl) return remoteUrl;

  let port = 4318;
  let host = "127.0.0.1";
  const raw = readRemnicConfigRecord(configPath);
  if (raw && "server" in raw) {
    const server = raw.server;
    if (server && typeof server === "object") {
      const hostCandidate = (server as Record<string, unknown>).host;
      if (typeof hostCandidate === "string" && hostCandidate.length > 0) {
        host = hostCandidate;
      }
      const portCandidate = (server as Record<string, unknown>).port;
      if (typeof portCandidate === "number" && Number.isInteger(portCandidate)) {
        port = portCandidate;
      }
    }
  }
  const envHost = readCompatEnv("REMNIC_HOST", "ENGRAM_HOST");
  if (typeof envHost === "string" && envHost.length > 0) {
    host = envHost;
  }
  const envPortRaw = readCompatEnv("REMNIC_PORT", "ENGRAM_PORT");
  if (typeof envPortRaw === "string" && envPortRaw.length > 0) {
    const envPort = Number(envPortRaw);
    // Reject an explicitly-set-but-invalid port instead of silently
    // falling back (the daemon rejects it too, so a bad value is a
    // misconfiguration the operator must see, not paper over).
    if (!Number.isInteger(envPort) || envPort < 1 || envPort > 65535) {
      throw new Error(
        `Invalid REMNIC_PORT/ENGRAM_PORT "${envPortRaw}": expected an integer in [1, 65535].`,
      );
    }
    port = envPort;
  }
  return `http://${host}:${port}`;
}

/**
 * Resolve the operator bearer token, matching the daemon's precedence
 * exactly. `startServer()` merges `REMNIC_AUTH_TOKEN` (env) OVER
 * `server.authToken` (file), so the running daemon accepts the env token
 * when both are set. This resolver therefore checks env FIRST, then the
 * file value (with `ENGRAM_AUTH_TOKEN` as the legacy env alias). A file
 * that still holds the literal `${REMNIC_AUTH_TOKEN}` placeholder no
 * longer shadows the real env token. Returns `undefined` when no token is
 * configured; callers fail loudly rather than auto-pick a default.
 */
export function resolveOperatorToken(configPath: string): string | undefined {
  const envToken = readCompatEnv("REMNIC_AUTH_TOKEN", "ENGRAM_AUTH_TOKEN");
  if (typeof envToken === "string" && envToken.length > 0) return envToken;
  const raw = readRemnicConfigRecord(configPath);
  if (raw && "server" in raw) {
    const server = raw.server;
    if (server && typeof server === "object" && "authToken" in server) {
      const candidate = (server as Record<string, unknown>).authToken;
      // A config created by `remnic init` may still hold the literal
      // `${REMNIC_AUTH_TOKEN}` placeholder; treat that as unresolved so
      // callers fall through to other sources rather than sending the
      // placeholder as a real bearer token.
      if (
        typeof candidate === "string" &&
        candidate.length > 0 &&
        !candidate.includes("${")
      ) {
        return candidate;
      }
    }
  }
  return undefined;
}

/**
 * Resolve the full remote target (base URL + bearer token) or `undefined`
 * when the CLI should keep using the local daemon.
 */
export function resolveRemoteDaemon(configPath: string): RemoteDaemon | undefined {
  const baseUrl = resolveRemoteDaemonUrl(configPath);
  if (!baseUrl) return undefined;
  const token = resolveOperatorToken(configPath);
  return token ? { baseUrl, token } : { baseUrl };
}

function isTransportError(err: unknown): boolean {
  return err instanceof Error && (
    err.message.includes("ECONNREFUSED") ||
    err.message.includes("ECONNRESET") ||
    err.message.includes("fetch failed") ||
    err.message.includes("aborted") ||
    err.message.includes("ENOTFOUND")
  );
}

function unreachableError(baseUrl: string): Error {
  return new Error(
    `cannot reach remnic-server at ${baseUrl} — check REMNIC_DAEMON_URL / server.url and the remote server's availability.`,
  );
}

/**
 * Fetch one daemon endpoint. Applies the bearer token and a timeout, and
 * enforces the https guard: a base URL configured as `https://` must never
 * be silently rewritten to `http://host:port` — that downgrade is a loud
 * error, not a fallback (issue #2448).
 */
async function daemonFetch(
  baseUrl: string,
  relativePath: string,
  token: string | undefined,
  timeoutMs: number,
  init?: RequestInit,
): Promise<Response> {
  // `relativePath` is resolved RELATIVE to the base URL so a configured
  // path prefix (a reverse-proxy mount) is preserved — an absolute
  // "/engram/..." path would silently drop it.
  const url = new URL(relativePath, `${baseUrl}/`);
  if (baseUrl.startsWith("https:") && url.protocol !== "https:") {
    throw new Error(
      `refusing to downgrade https daemon URL ${baseUrl} to ${url.protocol}// — fix REMNIC_DAEMON_URL / server.url.`,
    );
  }
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = { accept: "application/json" };
    if (token) headers.authorization = `Bearer ${token}`;
    return await fetch(url, {
      ...init,
      headers: { ...headers, ...init?.headers as Record<string, string> | undefined },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

export interface DaemonHealthProbe {
  ok: boolean;
  status?: number;
  error?: string;
}

/** Probe `/engram/v1/health` without printing. Never throws. */
export async function probeDaemonHealth(
  baseUrl: string,
  token: string | undefined,
  timeoutMs = 3000,
): Promise<DaemonHealthProbe> {
  try {
    const response = await daemonFetch(baseUrl, "engram/v1/health", token, timeoutMs);
    return response.ok ? { ok: true, status: response.status } : { ok: false, status: response.status };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Print the `remnic status` health section for a daemon base URL. Moved
 * from the inline `cmdStatus` block so the local and remote paths render
 * identically.
 */
export async function printHealthCheck(
  baseUrl: string,
  token: string | undefined,
  timeoutMs = 3000,
): Promise<void> {
  try {
    const response = await daemonFetch(baseUrl, "engram/v1/health", token, timeoutMs);
    if (!response.ok) {
      const hint =
        response.status === 401 && !token
          ? " (daemon requires auth and no token was found — set REMNIC_AUTH_TOKEN or configure server.authToken)"
          : response.status === 401
            ? " (token rejected by the daemon)"
            : "";
      console.log(`Health: server responded with ${response.status} ${response.statusText}${hint}`);
      return;
    }
    const health = (await response.json()) as {
      status?: unknown;
      qmd?: {
        pendingEmbeddings?: number | null;
        oldestPendingAgeMs?: number | null;
        embeddingBacklogThreshold?: number;
        degradedReason?: string;
      };
    };
    const status = typeof health.status === "string" ? health.status : "ok";
    console.log(`Health: ${status}`);
    const qmd = health.qmd;
    if (qmd?.pendingEmbeddings != null) {
      console.log(`  Pending embeddings: ${qmd.pendingEmbeddings}`);
      if (qmd.oldestPendingAgeMs != null) {
        console.log(`  Oldest pending: ${Math.round(qmd.oldestPendingAgeMs / 60_000)}m`);
      }
      if (qmd.embeddingBacklogThreshold != null) {
        console.log(`  Backlog threshold: ${qmd.embeddingBacklogThreshold}`);
      }
    }
    if (qmd?.degradedReason) {
      console.log(`  Degraded: ${qmd.degradedReason}`);
    }
  } catch {
    console.log("Health: unable to reach server");
  }
}

/** Minimal recall-response shape the CLI query renderers consume. */
export interface RemoteRecallResult {
  results?: QueryRenderableResult[];
  count?: number;
  context?: string;
}

/**
 * Run a recall against the remote daemon's `POST /engram/v1/recall`.
 * The request body is the same shape `buildQueryRecallRequest` builds and
 * `readValidatedBody(req, "recall")` validates server-side. Throws with a
 * user-facing message on transport errors, 401, or non-JSON responses.
 */
export async function remoteRecall(
  daemon: RemoteDaemon,
  request: { query: string; mode?: string; sessionKey: string },
): Promise<RemoteRecallResult> {
  let response: Response;
  try {
    response = await daemonFetch(daemon.baseUrl, "engram/v1/recall", daemon.token, 10_000, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
  } catch (err) {
    if (isTransportError(err)) throw unreachableError(daemon.baseUrl);
    throw err;
  }
  if (response.status === 401) {
    throw new Error(
      `token rejected by remnic-server at ${daemon.baseUrl} (HTTP 401). Update server.authToken or REMNIC_AUTH_TOKEN to match the remote daemon.`,
    );
  }
  if (!response.ok) {
    throw new Error(`remnic-server returned HTTP ${response.status} ${response.statusText}`);
  }
  try {
    return await response.json() as RemoteRecallResult;
  } catch {
    throw new Error("remnic-server returned a non-JSON response");
  }
}

/**
 * Run a recall X-ray against the remote daemon's
 * `GET /engram/v1/recall/xray`. Returns the same `{ snapshotFound,
 * snapshot? }` shape `runXrayCommand`'s IO contract expects, so remote and
 * local xray share all rendering.
 */
export async function remoteRecallXray(
  daemon: RemoteDaemon,
  request: { query: string; namespace?: string; budget?: number },
): Promise<{ snapshotFound: boolean; snapshot?: RecallXraySnapshot }> {
  const params = new URLSearchParams({ q: request.query });
  if (request.namespace && request.namespace.length > 0) {
    params.set("namespace", request.namespace);
  }
  if (request.budget !== undefined) {
    params.set("budget", String(request.budget));
  }
  let response: Response;
  try {
    response = await daemonFetch(
      daemon.baseUrl,
      `engram/v1/recall/xray?${params.toString()}`,
      daemon.token,
      10_000,
    );
  } catch (err) {
    if (isTransportError(err)) throw unreachableError(daemon.baseUrl);
    throw err;
  }
  if (response.status === 401) {
    throw new Error(
      `token rejected by remnic-server at ${daemon.baseUrl} (HTTP 401). Update server.authToken or REMNIC_AUTH_TOKEN to match the remote daemon.`,
    );
  }
  if (!response.ok) {
    throw new Error(`remnic-server returned HTTP ${response.status} ${response.statusText}`);
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error("remnic-server returned a non-JSON response");
  }
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const record = payload as Record<string, unknown>;
    if (record.snapshotFound === true && record.snapshot && typeof record.snapshot === "object") {
      return { snapshotFound: true, snapshot: record.snapshot as RecallXraySnapshot };
    }
  }
  return { snapshotFound: false };
}
