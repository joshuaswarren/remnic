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

export const LIMITLESS_DEFAULT_BASE_URL = "https://api.limitless.ai";

/** Hard API maximum for `limit` on /v1/lifelogs. */
export const LIFELOGS_MAX_PAGE_SIZE = 10;

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 3;
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

export class LimitlessApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
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
            "X-API-Key": this.apiKey,
            Accept: "application/json",
          },
          signal: combined,
        });
      } catch (err) {
        // Network failure / timeout: retry unless the caller aborted.
        if (signal?.aborted) throw err;
        lastError = err;
        if (attempt < MAX_RETRIES) {
          await this.sleep(backoffMs(attempt));
          continue;
        }
        throw new LimitlessApiError(
          `Limitless API request failed after ${MAX_RETRIES + 1} attempts: ${describeNetworkError(err)}`,
        );
      }

      if (response.status === 429 || response.status >= 500) {
        lastError = new LimitlessApiError(
          `Limitless API responded ${response.status}`,
          response.status,
        );
        if (attempt < MAX_RETRIES) {
          await this.sleep(await retryDelayMs(response, attempt));
          continue;
        }
        throw lastError;
      }
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
    // Unreachable: every loop path returns or throws. Keep the throw for
    // exhaustiveness.
    throw lastError instanceof Error
      ? lastError
      : new LimitlessApiError("Limitless API request failed");
  }
}

/**
 * Network/timeout failures wrap Node error text that can carry loader
 * paths or stack fragments; sync errors reach MCP clients verbatim, so
 * only the error name + code survive (Cursor review on PR #1458).
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

async function retryDelayMs(response: Response, attempt: number): Promise<number> {
  // 429 bodies carry retryAfter as a STRING of seconds (per docs); a
  // Retry-After header may also appear. Either is honored, capped.
  const headerValue = response.headers.get("retry-after");
  let seconds: number | undefined;
  if (headerValue !== null) {
    const parsed = Number(headerValue);
    if (Number.isFinite(parsed) && parsed > 0) seconds = parsed;
  }
  if (seconds === undefined) {
    try {
      const body = (await response.clone().json()) as { retryAfter?: unknown };
      const parsed = Number(body?.retryAfter);
      if (Number.isFinite(parsed) && parsed > 0) seconds = parsed;
    } catch {
      // Body unavailable or non-JSON — fall through to exponential backoff.
    }
  }
  if (seconds !== undefined) {
    return Math.min(MAX_RETRY_DELAY_MS, Math.ceil(seconds * 1_000));
  }
  return backoffMs(attempt);
}
