/**
 * Minimal Omi Developer API client (raw fetch, no SDK).
 *
 * Current contract verified against docs.omi.me in 2026-07:
 *
 *  - base `https://api.omi.me`, auth `Authorization: Bearer omi_dev_...`
 *    (Developer API key from Settings → Developer → Create Key)
 *  - `GET /v1/dev/user/conversations` with `limit`/`offset`
 *    pagination, `start_date`/`end_date` (ISO 8601), and
 *    `include_transcript=true`
 *  - `GET /v1/dev/user/memories` with `limit`/`offset`
 *  - responses are arrays; every optional field may be absent
 *  - errors are FastAPI-shaped `{"detail": "..."}`
 *
 * The older app-scoped Integrations API remains supported when both
 * `appId` and `userId` are configured.
 *
 * The API key is never logged and never appears in thrown error
 * messages.
 */

import {
  ConnectorApiError,
  describeNetworkError,
  retryingFetch,
  stripTrailingSlashes,
} from "@remnic/core/http-retry";

export const OMI_DEFAULT_BASE_URL = "https://api.omi.me";

const DEFAULT_TIMEOUT_MS = 30_000;
/** Page size for both conversations and memories (API max is 1000). */
const PAGE_SIZE = 100;

export interface OmiTranscriptSegment {
  text?: string;
  speaker?: string;
  speaker_id?: number | string | null;
  speaker_name?: string | null;
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
  appId?: string;
  userId?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

type OmiApiMode = "developer" | "integration";

export class OmiApiError extends ConnectorApiError {
  constructor(
    message: string,
    status?: number,
    detail?: string,
  ) {
    super(message, status, detail);
    this.name = "OmiApiError";
  }
}

export class OmiClient {
  private readonly apiKey: string;
  private readonly appId?: string;
  private readonly userId?: string;
  private readonly mode: OmiApiMode;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: OmiClientOptions) {
    if (typeof options.apiKey !== "string" || options.apiKey.trim().length === 0) {
      throw new OmiApiError(
        "Omi API key is missing. Set wearables.sources.omi.apiKey or the " +
          "OMI_API_KEY environment variable (create a Developer API key in " +
          "Settings → Developer → Create Key in the Omi app).",
      );
    }

    const appId =
      typeof options.appId === "string" && options.appId.trim().length > 0
        ? options.appId.trim()
        : undefined;
    const userId =
      typeof options.userId === "string" && options.userId.trim().length > 0
        ? options.userId.trim()
        : undefined;
    if ((appId === undefined) !== (userId === undefined)) {
      throw new OmiApiError(
        "Omi legacy integration mode requires both wearables.sources.omi.appId " +
          "and wearables.sources.omi.userId. Omit both to use the Developer " +
          "API key-only process.",
      );
    }

    this.apiKey = options.apiKey.trim();
    this.appId = appId;
    this.userId = userId;
    this.mode = appId !== undefined && userId !== undefined ? "integration" : "developer";
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
      limit: String(PAGE_SIZE),
      offset: String(offset),
      start_date: params.startIso,
      end_date: params.endIso,
    });
    let payload: unknown;
    if (this.mode === "developer") {
      search.set("include_transcript", "true");
      payload = await this.requestJson(
        `/v1/dev/user/conversations?${search.toString()}`,
        params.signal,
      );
    } else {
      search.set("uid", this.userId ?? "");
      search.set("include_discarded", "false");
      // -1 = unlimited; the legacy API default silently truncates
      // transcripts to their first 100 segments.
      search.set("max_transcript_segments", "-1");
      // Repeated param (FastAPI List[str]) — comma-joining does NOT work.
      search.append("statuses", "completed");
      payload = await this.requestJson(
        `/v2/integrations/${encodeURIComponent(this.appId ?? "")}/conversations?${search.toString()}`,
        params.signal,
      );
    }
    const conversations =
      this.mode === "developer"
        ? payload
        : (payload as { conversations?: unknown }).conversations;
    if (!Array.isArray(conversations)) {
      throw new OmiApiError(
        this.mode === "developer"
          ? "Omi API returned an unexpected conversations shape (expected array)"
          : "Omi API returned an unexpected conversations shape (missing conversations array)",
      );
    }
    const valid = conversations.filter(
      (entry): entry is OmiConversation =>
        entry !== null &&
        typeof entry === "object" &&
        typeof (entry as { id?: unknown }).id === "string",
    )
      .filter(isCompletedOrStatuslessConversation)
      .filter((conversation) =>
        startsInsideHalfOpenWindow(conversation, params.startIso, params.endIso),
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
      limit: String(PAGE_SIZE),
      offset: String(offset),
    });
    let payload: unknown;
    if (this.mode === "developer") {
      payload = await this.requestJson(
        `/v1/dev/user/memories?${search.toString()}`,
        params.signal,
      );
    } else {
      search.set("uid", this.userId ?? "");
      payload = await this.requestJson(
        `/v2/integrations/${encodeURIComponent(this.appId ?? "")}/memories?${search.toString()}`,
        params.signal,
      );
    }
    const memories =
      this.mode === "developer" ? payload : (payload as { memories?: unknown }).memories;
    if (!Array.isArray(memories)) {
      throw new OmiApiError(
        this.mode === "developer"
          ? "Omi API returned an unexpected memories shape (expected array)"
          : "Omi API returned an unexpected memories shape (missing memories array)",
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
        limit: "1",
        offset: "0",
      });
      if (this.mode === "developer") {
        search.set("include_transcript", "false");
        await this.requestJson(
          `/v1/dev/user/conversations?${search.toString()}`,
          signal,
        );
      } else {
        search.set("uid", this.userId ?? "");
        search.set("max_transcript_segments", "1");
        await this.requestJson(
          `/v2/integrations/${encodeURIComponent(this.appId ?? "")}/conversations?${search.toString()}`,
          signal,
        );
      }
      return { ok: true };
    } catch (err) {
      if (err instanceof OmiApiError && err.status !== undefined) {
        // The auth chain yields distinct, actionable detail strings.
        // Legacy integration mode can also surface app/user capability
        // failures, so keep those hints mode-specific.
        const hint =
          err.status === 401
            ? "missing/malformed Authorization header"
            : err.status === 403
              ? this.mode === "developer"
                ? "Developer API key rejected or missing conversation access"
                : "key rejected, app not enabled for this uid, or missing read_conversations capability"
              : err.status === 404
                ? this.mode === "developer"
                  ? "Developer API endpoint not found — check the configured baseUrl"
                  : "app not found — check wearables.sources.omi.appId"
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
    const response = await retryingFetch(`${this.baseUrl}${pathAndQuery}`, {
      init: {
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          Accept: "application/json",
        },
      },
      fetchImpl: this.fetchImpl,
      sleep: this.sleep,
      signal,
      timeoutMs: this.timeoutMs,
      networkError: (err, attempts) =>
        new OmiApiError(
          `Omi API request failed after ${attempts} attempts: ${describeNetworkError(err)}`,
        ),
      retryableError: async (retryable) =>
        new OmiApiError(
          `Omi API responded ${retryable.status}`,
          retryable.status,
          await readDetail(retryable),
        ),
    });
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
}

function startsInsideHalfOpenWindow(
  conversation: OmiConversation,
  startIso: string,
  endIso: string,
): boolean {
  const startMs = Date.parse(startIso);
  const endMs = Date.parse(endIso);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return true;

  const conversationIso =
    typeof conversation.started_at === "string"
      ? conversation.started_at
      : conversation.created_at;
  if (typeof conversationIso !== "string" || conversationIso.length === 0) {
    return true;
  }
  const conversationMs = Date.parse(conversationIso);
  if (!Number.isFinite(conversationMs)) return true;
  return conversationMs >= startMs && conversationMs < endMs;
}

function isCompletedOrStatuslessConversation(conversation: OmiConversation): boolean {
  if (typeof conversation.status !== "string" || conversation.status.length === 0) {
    return true;
  }
  return conversation.status === "completed";
}

async function readDetail(response: Response): Promise<string | undefined> {
  try {
    const body = (await response.clone().json()) as { detail?: unknown };
    return typeof body?.detail === "string" ? body.detail : undefined;
  } catch {
    return undefined;
  }
}
