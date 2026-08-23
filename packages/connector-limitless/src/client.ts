/**
 * Minimal Limitless Developer API client (raw fetch, no SDK).
 *
 * Contract verified against https://www.limitless.ai/developers/docs/api
 * (2026-06): base https://api.limitless.ai, header `X-API-Key`,
 * `GET /v1/lifelogs` with cursor pagination at `meta.lifelogs.nextCursor`
 * and a hard per-page max of 10. Rate limit is 180 req/min; 429 bodies
 * carry `retryAfter` (a string, in seconds).
 *
 * The API key is never logged and never included in thrown error
 * messages.
 */

import {
  ConnectorApiError,
  describeNetworkError,
  retryAfterHeaderMs,
  retryingFetch,
  stripTrailingSlashes,
} from "@remnic/core/http-retry";

export const LIMITLESS_DEFAULT_BASE_URL = "https://api.limitless.ai";

/** Hard API maximum for `limit` on /v1/lifelogs. */
export const LIFELOGS_MAX_PAGE_SIZE = 10;

const DEFAULT_TIMEOUT_MS = 30_000;
/** Backoff cap so a hostile retryAfter can't stall a sync for minutes. */
const MAX_RETRY_DELAY_MS = 30_000;

export interface LimitlessContentNode {
  type: string;
  content?: string;
  startTime?: string;
  endTime?: string;
  startOffsetMs?: number;
  endOffsetMs?: number;
  children?: LimitlessContentNode[];
  speakerName?: string | null;
  speakerIdentifier?: "user" | null;
}

export interface LimitlessLifelog {
  id: string;
  title?: string;
  markdown?: string | null;
  startTime?: string;
  endTime?: string;
  isStarred?: boolean;
  updatedAt?: string;
  contents?: LimitlessContentNode[];
}

export interface LifelogsPage {
  lifelogs: LimitlessLifelog[];
  nextCursor: string | null;
}

export interface LimitlessClientOptions {
  apiKey: string;
  baseUrl?: string;
  /** Injectable for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Per-request timeout (ms). */
  timeoutMs?: number;
  /** Injectable sleep for tests. */
  sleep?: (ms: number) => Promise<void>;
}

export class LimitlessApiError extends ConnectorApiError {
  constructor(
    message: string,
    status?: number,
  ) {
    super(message, status);
    this.name = "LimitlessApiError";
  }
}

export class LimitlessClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: LimitlessClientOptions) {
    if (typeof options.apiKey !== "string" || options.apiKey.trim().length === 0) {
      throw new LimitlessApiError(
        "Limitless API key is missing. Set wearables.sources.limitless.apiKey " +
          "or the LIMITLESS_API_KEY environment variable (create a key under " +
          "Developer settings in the Limitless app).",
      );
    }
    this.apiKey = options.apiKey.trim();
    this.baseUrl = stripTrailingSlashes(options.baseUrl ?? LIMITLESS_DEFAULT_BASE_URL);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.sleep =
      options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** One page of lifelogs for a single day. */
  async listLifelogs(params: {
    date: string;
    timezone: string;
    cursor?: string | null;
    signal?: AbortSignal;
  }): Promise<LifelogsPage> {
    const search = new URLSearchParams({
      date: params.date,
      timezone: params.timezone,
      limit: String(LIFELOGS_MAX_PAGE_SIZE),
      direction: "asc",
      // The markdown rendering duplicates what `contents` carries and
      // inflates payloads; segments come from `contents`.
      includeMarkdown: "false",
      includeHeadings: "false",
      includeContents: "true",
    });
    if (typeof params.cursor === "string" && params.cursor.length > 0) {
      search.set("cursor", params.cursor);
    }
    const payload = await this.requestJson(
      `/v1/lifelogs?${search.toString()}`,
      params.signal,
    );
    const data = (payload as { data?: { lifelogs?: unknown } }).data;
    const lifelogsRaw = data?.lifelogs;
    if (!Array.isArray(lifelogsRaw)) {
      throw new LimitlessApiError(
        "Limitless API returned an unexpected /v1/lifelogs shape (missing data.lifelogs array)",
      );
    }
    const meta = (payload as { meta?: { lifelogs?: { nextCursor?: unknown } } }).meta;
    const nextCursorRaw = meta?.lifelogs?.nextCursor;
    return {
      lifelogs: lifelogsRaw.filter(
        (entry): entry is LimitlessLifelog =>
          entry !== null && typeof entry === "object" && typeof (entry as { id?: unknown }).id === "string",
      ),
      nextCursor:
        typeof nextCursorRaw === "string" && nextCursorRaw.length > 0
          ? nextCursorRaw
          : null,
    };
  }

  /** Cheap auth probe. */
  async verifyAuth(signal?: AbortSignal): Promise<{ ok: boolean; detail?: string }> {
    try {
      const search = new URLSearchParams({
        limit: "1",
        includeMarkdown: "false",
        includeHeadings: "false",
      });
      await this.requestJson(`/v1/lifelogs?${search.toString()}`, signal);
      return { ok: true };
    } catch (err) {
      if (err instanceof LimitlessApiError && (err.status === 401 || err.status === 403)) {
        return {
          ok: false,
          detail: "Limitless rejected the API key (401/403) — create a new key under Developer settings",
        };
      }
      return {
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private async requestJson(pathAndQuery: string, signal?: AbortSignal): Promise<unknown> {
    const response = await retryingFetch(`${this.baseUrl}${pathAndQuery}`, {
      init: {
        method: "GET",
        headers: {
          "X-API-Key": this.apiKey,
          Accept: "application/json",
        },
      },
      fetchImpl: this.fetchImpl,
      sleep: this.sleep,
      signal,
      timeoutMs: this.timeoutMs,
      // 429 bodies carry retryAfter as a STRING of seconds (per docs); a
      // Retry-After header may also appear. Either is honored, capped.
      retryAfterMs: async (retryable) => {
        const fromHeader = retryAfterHeaderMs(retryable, MAX_RETRY_DELAY_MS);
        if (fromHeader !== undefined) return fromHeader;
        try {
          const body = (await retryable.clone().json()) as { retryAfter?: unknown };
          const parsed = Number(body?.retryAfter);
          if (Number.isFinite(parsed) && parsed > 0) {
            return Math.min(MAX_RETRY_DELAY_MS, Math.ceil(parsed * 1_000));
          }
        } catch {
          // Body unavailable or non-JSON — fall through to exponential backoff.
        }
        return null;
      },
      networkError: (err, attempts) =>
        new LimitlessApiError(
          `Limitless API request failed after ${attempts} attempts: ${describeNetworkError(err)}`,
        ),
      retryableError: (retryable) =>
        new LimitlessApiError(`Limitless API responded ${retryable.status}`, retryable.status),
    });
    if (!response.ok) {
      throw new LimitlessApiError(
        `Limitless API responded ${response.status} for ${pathAndQuery.split("?")[0]}`,
        response.status,
      );
    }
    try {
      return await response.json();
    } catch {
      throw new LimitlessApiError("Limitless API returned a non-JSON body");
    }
  }
}


