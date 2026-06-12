/**
 * Minimal Omi Integrations API client (raw fetch, no SDK).
 *
 * Contract verified against docs.omi.me and the open-source backend
 * (`backend/routers/integration.py`, `models/integrations.py`) in
 * 2026-06:
 *
 *  - base `https://api.omi.me`, auth `Authorization: Bearer sk_...`
 *    (an app API key created in the Omi app; the app needs the
 *    External Integration `read_conversations` / `read_memories`
 *    capabilities and must be enabled for the target user)
 *  - `uid` rides as a query parameter on every endpoint
 *  - `GET /v2/integrations/{app_id}/conversations` with
 *    `limit`/`offset` pagination, `start_date`/`end_date` (ISO 8601),
 *    repeated `statuses` params, and `max_transcript_segments=-1`
 *    (the API default silently truncates to the first 100 segments)
 *  - `GET /v2/integrations/{app_id}/memories` with `limit`/`offset`
 *  - responses serialize with exclude_none — every optional field may
 *    be entirely absent
 *  - errors are FastAPI-shaped `{"detail": "..."}`
 *
 * The API key is never logged and never appears in thrown error
 * messages.
 */

export const OMI_DEFAULT_BASE_URL = "https://api.omi.me";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 3;
const MAX_RETRY_DELAY_MS = 30_000;
/** Page size for both conversations and memories (API max is 1000). */
const PAGE_SIZE = 100;

export interface OmiTranscriptSegment {
  text?: string;
  speaker?: string;
  is_user?: boolean;
  person_id?: string | null;
  start?: number;
  end?: number;
}

export interface OmiConversation {
  id: string;
  created_at?: string;
  started_at?: string;
  finished_at?: string;
  structured?: {
    title?: string;
    overview?: string;
    category?: string;
    action_items?: Array<{ description?: string; completed?: boolean }>;
  };
  transcript_segments?: OmiTranscriptSegment[];
  geolocation?: { address?: string | null } | null;
  status?: string;
  discarded?: boolean;
}

export interface OmiMemory {
  id: string;
  content?: string;
  category?: string;
  tags?: string[];
  created_at?: string;
}

export interface OmiConversationsPage {
  conversations: OmiConversation[];
  nextOffset: number | null;
}

export interface OmiMemoriesPage {
  memories: OmiMemory[];
  nextOffset: number | null;
}

export interface OmiClientOptions {
  apiKey: string;
  appId: string;
  userId: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export class OmiApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    /** FastAPI `detail` string when the body carried one. */
    readonly detail?: string,
  ) {
    super(message);
    this.name = "OmiApiError";
  }
}

export class OmiClient {
  private readonly apiKey: string;
  private readonly appId: string;
  private readonly userId: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: OmiClientOptions) {
    if (typeof options.apiKey !== "string" || options.apiKey.trim().length === 0) {
      throw new OmiApiError(
        "Omi API key is missing. Set wearables.sources.omi.apiKey or the " +
          "OMI_API_KEY environment variable (create a key under your app's " +
          "API Keys in the Omi app).",
      );
    }
    if (typeof options.appId !== "string" || options.appId.trim().length === 0) {
      throw new OmiApiError(
        "Omi app id is missing. Set wearables.sources.omi.appId to your " +
          "integration app's id.",
      );
    }
    if (typeof options.userId !== "string" || options.userId.trim().length === 0) {
      throw new OmiApiError(
        "Omi user id is missing. Set wearables.sources.omi.userId to the " +
          "target uid (shown when the user installs/opens your Omi app).",
      );
    }
    this.apiKey = options.apiKey.trim();
    this.appId = options.appId.trim();
    this.userId = options.userId.trim();
    this.baseUrl = stripTrailingSlashes(options.baseUrl ?? OMI_DEFAULT_BASE_URL);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.sleep =
      options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** One page of completed conversations inside [startIso, endIso). */
  async listConversations(params: {
    startIso: string;
    endIso: string;
    offset?: number;
    signal?: AbortSignal;
  }): Promise<OmiConversationsPage> {
    const offset = params.offset ?? 0;
    const search = new URLSearchParams({
      uid: this.userId,
      limit: String(PAGE_SIZE),
      offset: String(offset),
      start_date: params.startIso,
      end_date: params.endIso,
      include_discarded: "false",
      // -1 = unlimited; the API default silently truncates transcripts
      // to their first 100 segments.
      max_transcript_segments: "-1",
    });
    // Repeated param (FastAPI List[str]) — comma-joining does NOT work.
    search.append("statuses", "completed");
    const payload = await this.requestJson(
      `/v2/integrations/${encodeURIComponent(this.appId)}/conversations?${search.toString()}`,
      params.signal,
    );
    const conversations = (payload as { conversations?: unknown }).conversations;
    if (!Array.isArray(conversations)) {
      throw new OmiApiError(
        "Omi API returned an unexpected conversations shape (missing conversations array)",
      );
    }
    const valid = conversations.filter(
      (entry): entry is OmiConversation =>
        entry !== null &&
        typeof entry === "object" &&
        typeof (entry as { id?: unknown }).id === "string",
    );
    return {
      conversations: valid,
      nextOffset: conversations.length === PAGE_SIZE ? offset + PAGE_SIZE : null,
    };
  }

  /** One page of Omi memories (provider-extracted facts). */
  async listMemories(params: {
    offset?: number;
    signal?: AbortSignal;
  } = {}): Promise<OmiMemoriesPage> {
    const offset = params.offset ?? 0;
    const search = new URLSearchParams({
      uid: this.userId,
      limit: String(PAGE_SIZE),
      offset: String(offset),
    });
    const payload = await this.requestJson(
      `/v2/integrations/${encodeURIComponent(this.appId)}/memories?${search.toString()}`,
      params.signal,
    );
    const memories = (payload as { memories?: unknown }).memories;
    if (!Array.isArray(memories)) {
      throw new OmiApiError(
        "Omi API returned an unexpected memories shape (missing memories array)",
      );
    }
    const valid = memories.filter(
      (entry): entry is OmiMemory =>
        entry !== null &&
        typeof entry === "object" &&
        typeof (entry as { id?: unknown }).id === "string",
    );
    return {
      memories: valid,
      nextOffset: memories.length === PAGE_SIZE ? offset + PAGE_SIZE : null,
    };
  }

  async verifyAuth(signal?: AbortSignal): Promise<{ ok: boolean; detail?: string }> {
    try {
      const search = new URLSearchParams({
        uid: this.userId,
        limit: "1",
        offset: "0",
        max_transcript_segments: "1",
      });
      await this.requestJson(
        `/v2/integrations/${encodeURIComponent(this.appId)}/conversations?${search.toString()}`,
        signal,
      );
      return { ok: true };
    } catch (err) {
      if (err instanceof OmiApiError && err.status !== undefined) {
        // The backend's authorization chain yields distinct, actionable
        // detail strings: bad key (403), app not enabled for the user
        // (403), missing capability (403), app not found (404).
        const hint =
          err.status === 401
            ? "missing/malformed Authorization header"
            : err.status === 403
              ? "key rejected, app not enabled for this uid, or missing read_conversations capability"
              : err.status === 404
                ? "app not found — check wearables.sources.omi.appId"
                : undefined;
        return {
          ok: false,
          detail: [err.detail, hint].filter(Boolean).join(" — ") || err.message,
        };
      }
      // OmiApiError messages are our own constructed strings (already
      // scrubbed — network text is reduced to name + code inside
      // requestJson); foreign errors reduce to name + errno code so raw
      // Node text (paths, loader stacks) never reaches operator
      // surfaces.
      return {
        ok: false,
        detail: err instanceof OmiApiError ? err.message : describeNetworkError(err),
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
            Authorization: `Bearer ${this.apiKey}`,
            Accept: "application/json",
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
        throw new OmiApiError(
          `Omi API request failed after ${MAX_RETRIES + 1} attempts: ${describeNetworkError(err)}`,
        );
      }

      if (response.status === 429 || response.status >= 500) {
        lastError = new OmiApiError(
          `Omi API responded ${response.status}`,
          response.status,
          await readDetail(response),
        );
        if (attempt < MAX_RETRIES) {
          await this.sleep(retryDelayMs(response, attempt));
          continue;
        }
        throw lastError;
      }
      if (!response.ok) {
        throw new OmiApiError(
          `Omi API responded ${response.status} for ${pathAndQuery.split("?")[0]}`,
          response.status,
          await readDetail(response),
        );
      }
      try {
        return await response.json();
      } catch {
        throw new OmiApiError("Omi API returned a non-JSON body");
      }
    }
    throw lastError instanceof Error ? lastError : new OmiApiError("Omi API request failed");
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

async function readDetail(response: Response): Promise<string | undefined> {
  try {
    const body = (await response.clone().json()) as { detail?: unknown };
    return typeof body?.detail === "string" ? body.detail : undefined;
  } catch {
    return undefined;
  }
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
