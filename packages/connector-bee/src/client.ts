/**
 * Minimal Bee developer API client (raw fetch, no SDK).
 *
 * Contract verified against the official `@beeai/cli` source and
 * docs.bee.computer (2026-06). Two access modes:
 *
 *  - **Proxy mode (default):** the official `bee proxy` command serves
 *    the full developer API unauthenticated on `http://127.0.0.1:8787`.
 *    No token required.
 *  - **Direct mode:** `https://app-api-developer.ce.bee.amazon.dev`
 *    with `Authorization: Bearer <token>` (token from `bee login`,
 *    stored at `~/.bee/token-prod`). The direct host uses Bee's private
 *    CA — point `NODE_EXTRA_CA_CERTS` at it when going direct.
 *
 * The legacy pre-acquisition API (`api.bee.computer`, `x-api-key`,
 * page/totalPages) no longer resolves and is intentionally not
 * supported.
 *
 * List endpoints use `limit` + `cursor` pagination with a `next_cursor`
 * in the envelope; timestamps are epoch milliseconds. Tokens are never
 * logged and never appear in thrown error messages.
 */

export const BEE_DEFAULT_BASE_URL = "http://127.0.0.1:8787";
export const BEE_DIRECT_BASE_URL = "https://app-api-developer.ce.bee.amazon.dev";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 3;
const MAX_RETRY_DELAY_MS = 30_000;
const LIST_PAGE_SIZE = 50;

export interface BeeConversationListItem {
  id: number;
  start_time: number;
  end_time?: number | null;
  device_type?: string;
  short_summary?: string | null;
  summary?: string | null;
  state?: string;
}

export interface BeeUtterance {
  id?: number;
  start?: number | null;
  end?: number | null;
  spoken_at?: number;
  text?: string;
  speaker?: string;
}

export interface BeeConversationDetail extends BeeConversationListItem {
  transcriptions?: Array<{
    id?: number;
    utterances?: BeeUtterance[];
  }>;
  primary_location?: {
    address?: string | null;
    latitude?: number;
    longitude?: number;
  } | null;
}

export interface BeeFact {
  id: number;
  text: string;
  tags?: string[];
  created_at?: number;
  confirmed?: boolean;
}

export interface BeeConversationsPage {
  conversations: BeeConversationListItem[];
  nextCursor: string | null;
}

export interface BeeFactsPage {
  facts: BeeFact[];
  nextCursor: string | null;
}

export interface BeeClientOptions {
  /** Bearer token for direct mode. Omit entirely for proxy mode. */
  token?: string;
  /** Defaults to the local `bee proxy` address. */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export class BeeApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "BeeApiError";
  }
}

export class BeeClient {
  private readonly token: string | undefined;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: BeeClientOptions = {}) {
    this.token =
      typeof options.token === "string" && options.token.trim().length > 0
        ? options.token.trim()
        : undefined;
    this.baseUrl = stripTrailingSlashes(options.baseUrl ?? BEE_DEFAULT_BASE_URL);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.sleep =
      options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  get usingLocalProxy(): boolean {
    return isLocalProxyUrl(this.baseUrl);
  }

  async listConversations(params: {
    cursor?: string | null;
    limit?: number;
    signal?: AbortSignal;
  } = {}): Promise<BeeConversationsPage> {
    const search = new URLSearchParams({
      limit: String(params.limit ?? LIST_PAGE_SIZE),
    });
    if (typeof params.cursor === "string" && params.cursor.length > 0) {
      search.set("cursor", params.cursor);
    }
    const payload = await this.requestJson(
      `/v1/conversations?${search.toString()}`,
      params.signal,
    );
    const conversations = (payload as { conversations?: unknown }).conversations;
    if (!Array.isArray(conversations)) {
      throw new BeeApiError(
        "Bee API returned an unexpected /v1/conversations shape (missing conversations array)",
      );
    }
    return {
      conversations: conversations.filter(isConversationListItem),
      nextCursor: readNextCursor(payload),
    };
  }

  async getConversation(
    id: number,
    signal?: AbortSignal,
  ): Promise<BeeConversationDetail | null> {
    let payload: unknown;
    try {
      payload = await this.requestJson(`/v1/conversations/${id}`, signal);
    } catch (err) {
      // A conversation can be deleted between the list and the detail
      // fetch — a 404 skips that conversation instead of aborting the
      // whole day sync. Other failures (auth, 5xx after retries) still
      // throw so transient outages retry the sync rather than silently
      // dropping data.
      if (err instanceof BeeApiError && err.status === 404) return null;
      throw err;
    }
    // Current API returns the detail at the top level; the legacy shape
    // wrapped it as {conversation: {...}}. Accept both.
    const detail =
      payload !== null &&
      typeof payload === "object" &&
      "conversation" in (payload as Record<string, unknown>)
        ? (payload as { conversation: unknown }).conversation
        : payload;
    return isConversationListItem(detail) ? (detail as BeeConversationDetail) : null;
  }

  async listFacts(params: {
    cursor?: string | null;
    signal?: AbortSignal;
  } = {}): Promise<BeeFactsPage> {
    const search = new URLSearchParams({
      limit: String(LIST_PAGE_SIZE),
      confirmed: "true",
    });
    if (typeof params.cursor === "string" && params.cursor.length > 0) {
      search.set("cursor", params.cursor);
    }
    const payload = await this.requestJson(`/v1/facts?${search.toString()}`, params.signal);
    const facts = (payload as { facts?: unknown }).facts;
    if (!Array.isArray(facts)) {
      throw new BeeApiError(
        "Bee API returned an unexpected /v1/facts shape (missing facts array)",
      );
    }
    return {
      facts: facts.filter(
        (entry): entry is BeeFact =>
          entry !== null &&
          typeof entry === "object" &&
          typeof (entry as { id?: unknown }).id === "number" &&
          typeof (entry as { text?: unknown }).text === "string",
      ),
      nextCursor: readNextCursor(payload),
    };
  }

  async verifyAuth(signal?: AbortSignal): Promise<{ ok: boolean; detail?: string }> {
    try {
      await this.requestJson("/v1/me", signal);
      return {
        ok: true,
        detail: this.usingLocalProxy ? "via local bee proxy" : "direct API access",
      };
    } catch (err) {
      if (err instanceof BeeApiError && (err.status === 401 || err.status === 403)) {
        return {
          ok: false,
          detail: this.usingLocalProxy
            ? "the bee proxy rejected the request — re-run `bee login` then restart `bee proxy`"
            : "Bee rejected the token (401/403) — re-run `bee login` and update BEE_API_TOKEN",
        };
      }
      // BeeApiError messages are our own constructed strings (status
      // codes + endpoint role; network failures already carry the
      // `bee proxy` hint from requestJson) — keep them actionable.
      // Only foreign errors are reduced to name + code.
      return {
        ok: false,
        detail: err instanceof BeeApiError ? err.message : describeNetworkError(err),
      };
    }
  }

  private async requestJson(pathAndQuery: string, signal?: AbortSignal): Promise<unknown> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      signal?.throwIfAborted();
      const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
      const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
      let response: Response;
      try {
        response = await this.fetchImpl(`${this.baseUrl}${pathAndQuery}`, {
          method: "GET",
          headers: {
            Accept: "application/json",
            ...(this.token !== undefined
              ? { Authorization: `Bearer ${this.token}` }
              : {}),
          },
          signal: combined,
        });
      } catch (err) {
        if (signal?.aborted) throw err;
        lastError = err;
        if (attempt < MAX_RETRIES) {
          await this.sleep(backoffMs(attempt));
          continue;
        }
        throw new BeeApiError(
          `Bee API request failed after ${MAX_RETRIES + 1} attempts: ${describeNetworkError(err)}` +
            (this.usingLocalProxy ? " — is `bee proxy` running?" : ""),
        );
      }

      if (response.status === 429 || response.status >= 500) {
        lastError = new BeeApiError(
          `Bee API responded ${response.status}`,
          response.status,
        );
        if (attempt < MAX_RETRIES) {
          await this.sleep(retryDelayMs(response, attempt));
          continue;
        }
        throw lastError;
      }
      if (!response.ok) {
        throw new BeeApiError(
          `Bee API responded ${response.status} for ${pathAndQuery.split("?")[0]}`,
          response.status,
        );
      }
      try {
        return await response.json();
      } catch {
        throw new BeeApiError("Bee API returned a non-JSON body");
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new BeeApiError("Bee API request failed");
  }
}

function isConversationListItem(entry: unknown): entry is BeeConversationListItem {
  return (
    entry !== null &&
    typeof entry === "object" &&
    typeof (entry as { id?: unknown }).id === "number" &&
    typeof (entry as { start_time?: unknown }).start_time === "number"
  );
}

function readNextCursor(payload: unknown): string | null {
  const cursor = (payload as { next_cursor?: unknown }).next_cursor;
  if (typeof cursor === "string" && cursor.length > 0) return cursor;
  if (typeof cursor === "number") return String(cursor);
  return null;
}

/**
 * True when the URL points at the local `bee proxy`. Hostname is
 * compared exactly after parsing — a prefix match would also treat
 * hosts like 127.0.0.1.evil.example as local.
 */
export function isLocalProxyUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.hostname === "127.0.0.1" ||
      parsed.hostname === "localhost" ||
      parsed.hostname === "[::1]" ||
      parsed.hostname === "::1"
    );
  } catch {
    return false;
  }
}

/**
 * Network/timeout failures wrap Node error text that can carry loader
 * paths or stack fragments; sync errors reach MCP clients verbatim, so
 * only the error name + code survive.
 */
function describeNetworkError(err: unknown): string {
  if (!(err instanceof Error)) return "unexpected non-Error failure";
  const code = (err as NodeJS.ErrnoException).code;
  return typeof code === "string" && code.length > 0 ? `${err.name} (${code})` : err.name;
}

/** Loop instead of `/\/+$/` — CodeQL js/polynomial-redos on user-set URLs. */
function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 0x2f) end--;
  return value.slice(0, end);
}

function backoffMs(attempt: number): number {
  return Math.min(MAX_RETRY_DELAY_MS, 1_000 * 2 ** attempt);
}

function retryDelayMs(response: Response, attempt: number): number {
  const headerValue = response.headers.get("retry-after");
  if (headerValue !== null) {
    const parsed = Number(headerValue);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.min(MAX_RETRY_DELAY_MS, Math.ceil(parsed * 1_000));
    }
  }
  return backoffMs(attempt);
}
