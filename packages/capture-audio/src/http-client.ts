/**
 * HTTP client for the desktop capture daemon's read-only API.
 *
 * The daemon (see daemon.ts) is the sole process owner; this client only
 * reads what the daemon already finalized. It never transcribes, writes
 * the spool, or invents conversations — it fetches `final` conversations
 * and probes health. On loopback the daemon trusts localhost and needs no
 * token; a non-loopback daemon requires `Authorization: Bearer <token>`.
 */

import { DEFAULT_HOST, DEFAULT_PORT } from "./constants.js";
import type { ConversationPage, DaemonConversation } from "./spool.js";

export const DESKTOP_DEFAULT_BASE_URL = `http://${DEFAULT_HOST}:${DEFAULT_PORT}`;

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 3;
/** Backoff cap so a hostile retry loop can't stall a sync for minutes. */
const MAX_RETRY_DELAY_MS = 30_000;

export interface DesktopCaptureClientOptions {
  /** Daemon base URL. Defaults to the loopback host:port. */
  baseUrl?: string;
  /** Bearer token; omitted on loopback where the daemon trusts localhost. */
  token?: string;
  /** Injectable for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Per-request timeout (ms). */
  timeoutMs?: number;
  /** Injectable sleep for tests. */
  sleep?: (ms: number) => Promise<void>;
}

export class DesktopApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "DesktopApiError";
  }
}

export interface ListConversationsParams {
  /** Local day, YYYY-MM-DD in `timezone`. */
  date: string;
  /** IANA timezone the date is interpreted in. */
  timezone: string;
  /** Keyset cursor from a previous page. */
  cursor?: string | null;
  /** Page size; defaults to the daemon's own default when omitted. */
  limit?: number;
  signal?: AbortSignal;
}

export class DesktopCaptureClient {
  private readonly baseUrl: string;
  private readonly token: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: DesktopCaptureClientOptions = {}) {
    this.baseUrl = stripTrailingSlashes(options.baseUrl ?? DESKTOP_DEFAULT_BASE_URL);
    const token = options.token?.trim();
    this.token = token && token.length > 0 ? token : undefined;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    // Executor form (not Promise.withResolvers) to stay within the
    // package's ES2022 type target, matching the sibling connector clients.
    this.sleep =
      options.sleep ??
      ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  }

  /** One page of final conversations for a single local day. */
  async listConversations(params: ListConversationsParams): Promise<ConversationPage> {
    const search = new URLSearchParams({
      date: params.date,
      timezone: params.timezone,
    });
    if (typeof params.limit === "number" && Number.isFinite(params.limit)) {
      search.set("limit", String(params.limit));
    }
    if (typeof params.cursor === "string" && params.cursor.length > 0) {
      search.set("cursor", params.cursor);
    }
    const payload = await this.requestJson(
      `/v1/conversations?${search.toString()}`,
      params.signal,
    );
    const conversationsRaw =
      payload !== null && typeof payload === "object" && "conversations" in payload
        ? payload.conversations
        : undefined;
    if (!Array.isArray(conversationsRaw)) {
      throw new DesktopApiError(
        "Desktop capture daemon returned an unexpected /v1/conversations shape (missing conversations array)",
      );
    }
    const nextCursorRaw =
      payload !== null && typeof payload === "object" && "nextCursor" in payload
        ? payload.nextCursor
        : undefined;
    // The daemon owns this shape and serves only well-formed `final`
    // conversations; the array guard above is the boundary check.
    const conversations = conversationsRaw as DaemonConversation[];
    return {
      conversations,
      nextCursor:
        typeof nextCursorRaw === "string" && nextCursorRaw.length > 0
          ? nextCursorRaw
          : null,
    };
  }

  /** Cheap liveness + auth probe against /v1/health. */
  async verifyAuth(signal?: AbortSignal): Promise<{ ok: boolean; detail?: string }> {
    try {
      const payload = await this.requestJson("/v1/health", signal);
      const healthy =
        payload !== null &&
        typeof payload === "object" &&
        "ok" in payload &&
        payload.ok === true;
      if (healthy) {
        return { ok: true };
      }
      return { ok: false, detail: "Desktop capture daemon reported an unhealthy status" };
    } catch (err) {
      if (err instanceof DesktopApiError && (err.status === 401 || err.status === 403)) {
        return {
          ok: false,
          detail:
            "Desktop capture daemon rejected the bearer token (401) — set " +
            "REMNIC_CAPTURE_AUDIO_TOKEN, point at the daemon token file, or bind loopback",
        };
      }
      return {
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private async requestJson(pathAndQuery: string, signal?: AbortSignal): Promise<unknown> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      signal?.throwIfAborted();
      const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
      const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
      const headers: Record<string, string> = { Accept: "application/json" };
      if (this.token) headers.Authorization = `Bearer ${this.token}`;
      let response: Response;
      try {
        response = await this.fetchImpl(`${this.baseUrl}${pathAndQuery}`, {
          method: "GET",
          headers,
          signal: combined,
        });
      } catch (err) {
        if (signal?.aborted) throw err;
        lastError = err;
        if (attempt < MAX_RETRIES) {
          await this.sleep(backoffMs(attempt));
          continue;
        }
        throw new DesktopApiError(
          `Desktop capture daemon request failed after ${MAX_RETRIES + 1} attempts: ${describeNetworkError(err)}`,
        );
      }

      if (response.status === 429 || response.status >= 500) {
        lastError = new DesktopApiError(
          `Desktop capture daemon responded ${response.status}`,
          response.status,
        );
        if (attempt < MAX_RETRIES) {
          await this.sleep(backoffMs(attempt));
          continue;
        }
        throw lastError;
      }
      if (!response.ok) {
        throw new DesktopApiError(
          `Desktop capture daemon responded ${response.status} for ${pathAndQuery.split("?")[0]}`,
          response.status,
        );
      }
      try {
        return await response.json();
      } catch {
        throw new DesktopApiError("Desktop capture daemon returned a non-JSON body");
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new DesktopApiError("Desktop capture daemon request failed");
  }
}

/**
 * Network/timeout failures wrap Node error text that can carry loader
 * paths or stack fragments; sync errors reach MCP clients verbatim, so
 * only the error name + code survive.
 */
function describeNetworkError(err: unknown): string {
  if (err !== null && typeof err === "object") {
    const name = "name" in err && typeof err.name === "string" ? err.name : undefined;
    const code = "code" in err && typeof err.code === "string" ? err.code : undefined;
    if (name && code) return `${name} (${code})`;
    if (name) return name;
    if (code) return code;
  }
  return "network error";
}

/** Loop instead of `/\/+$/` — CodeQL js/polynomial-redos on user-set URLs. */
function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end--;
  return value.slice(0, end);
}

/** Exponential backoff (1s, 2s, 4s, …) capped so retries can't stall a sync. */
function backoffMs(attempt: number): number {
  return Math.min(MAX_RETRY_DELAY_MS, 1_000 * 2 ** attempt);
}
