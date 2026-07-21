/**
 * Minimal Fireflies.ai GraphQL API client (raw fetch, no SDK).
 *
 * API verified against https://docs.fireflies.ai/graphql-api/query/transcripts
 * and https://docs.fireflies.ai/fundamentals/authorization (fetched
 * 2026-07-21):
 *   - Endpoint: POST https://api.fireflies.ai/graphql
 *   - Auth: `Authorization: Bearer <api key>`
 *   - `transcripts(fromDate, toDate, limit, skip)` where fromDate/toDate are
 *     ISO-8601 date-time strings and `limit` maxes at 50.
 *   - Each transcript exposes `id`, `title`, `date` (epoch ms), `duration`
 *     (minutes), `summary { overview short_summary }`, `participants`, and
 *     `sentences { index speaker_name speaker_id text start_time end_time }`
 *     where start_time/end_time are second-offsets from the meeting start.
 *
 * GraphQL transport returns HTTP 200 with an `errors` array on query/auth
 * failure; those are surfaced as FirefliesApiError (a backend failure), never
 * as an empty result (AGENTS.md §22).
 */

export const FIREFLIES_DEFAULT_ENDPOINT = "https://api.fireflies.ai/graphql";

/** Hard API maximum for `limit` on the transcripts query. */
export const TRANSCRIPTS_MAX_PAGE_SIZE = 50;

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 3;
/** Backoff cap so a hostile retryAfter can't stall a sync for minutes. */
const MAX_RETRY_DELAY_MS = 30_000;

const TRANSCRIPTS_QUERY = `query RemnicTranscripts($fromDate: DateTime, $toDate: DateTime, $limit: Int, $skip: Int) {
  transcripts(fromDate: $fromDate, toDate: $toDate, limit: $limit, skip: $skip) {
    id
    title
    date
    duration
    participants
    summary { overview short_summary }
    speakers { id name }
    sentences { index speaker_name speaker_id text start_time end_time }
  }
}`;

const AUTH_PROBE_QUERY = `query RemnicFirefliesAuthProbe { transcripts(limit: 1) { id } }`;

export interface FirefliesSentence {
  index?: number;
  speaker_name?: string | null;
  speaker_id?: number | string | null;
  text?: string | null;
  start_time?: number | null;
  end_time?: number | null;
}

export interface FirefliesSummary {
  overview?: string | null;
  short_summary?: string | null;
}

export interface FirefliesSpeaker {
  id?: number | string | null;
  name?: string | null;
}

export interface FirefliesTranscript {
  id: string;
  title?: string | null;
  /** Meeting datetime — epoch milliseconds (Float) or an ISO string. */
  date?: number | string | null;
  /** Meeting duration in minutes (Fireflies reports minutes). */
  duration?: number | null;
  participants?: string[] | null;
  summary?: FirefliesSummary | null;
  speakers?: FirefliesSpeaker[] | null;
  sentences?: FirefliesSentence[] | null;
}

export interface TranscriptsPage {
  transcripts: FirefliesTranscript[];
  /** True when a full page came back (more may exist beyond this skip). */
  hadFullPage: boolean;
  /** Raw row count Fireflies returned at this offset (drives the skip cursor). */
  rawCount: number;
}

export interface FirefliesClientOptions {
  apiKey: string;
  /** Override the GraphQL endpoint (self-hosted / proxy setups). */
  baseUrl?: string;
  /** Injectable for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Per-request timeout (ms). */
  timeoutMs?: number;
  /** Injectable sleep for tests. */
  sleep?: (ms: number) => Promise<void>;
}

export class FirefliesApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "FirefliesApiError";
  }
}

/** Narrow unknown JSON to a plain object so field reads are actually checked. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export class FirefliesClient {
  private readonly apiKey: string;
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: FirefliesClientOptions) {
    if (typeof options.apiKey !== "string" || options.apiKey.trim().length === 0) {
      throw new FirefliesApiError(
        "Fireflies API key is missing. Set wearables.sources.fireflies.apiKey " +
          "or the REMNIC_FIREFLIES_API_KEY / FIREFLIES_API_KEY environment variable " +
          "(create a key under Settings → Developer settings in the Fireflies app).",
      );
    }
    this.apiKey = options.apiKey.trim();
    this.endpoint = stripTrailingSlashes(options.baseUrl ?? FIREFLIES_DEFAULT_ENDPOINT);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.sleep = options.sleep ?? defaultSleep;
  }

  /** One page of transcripts created inside the [fromDate, toDate) window. */
  async listTranscripts(params: {
    fromDate: string;
    toDate: string;
    skip?: number;
    signal?: AbortSignal;
  }): Promise<TranscriptsPage> {
    const skip = Number.isInteger(params.skip) && (params.skip as number) > 0 ? (params.skip as number) : 0;
    const data = await this.graphql(
      TRANSCRIPTS_QUERY,
      { fromDate: params.fromDate, toDate: params.toDate, limit: TRANSCRIPTS_MAX_PAGE_SIZE, skip },
      params.signal,
    );
    const raw = isRecord(data) ? data.transcripts : undefined;
    if (!Array.isArray(raw)) {
      throw new FirefliesApiError(
        "Fireflies API returned an unexpected transcripts shape (missing data.transcripts array)",
      );
    }
    const transcripts = raw.filter(
      (entry): entry is FirefliesTranscript => isRecord(entry) && typeof entry.id === "string",
    );
    return { transcripts, hadFullPage: raw.length >= TRANSCRIPTS_MAX_PAGE_SIZE, rawCount: raw.length };
  }

  /** Cheap auth probe. */
  async verifyAuth(signal?: AbortSignal): Promise<{ ok: boolean; detail?: string }> {
    try {
      await this.graphql(AUTH_PROBE_QUERY, {}, signal);
      return { ok: true };
    } catch (err) {
      if (err instanceof FirefliesApiError && (err.status === 401 || err.status === 403)) {
        return {
          ok: false,
          detail:
            "Fireflies rejected the API key (401/403) — create a new key under Settings → Developer settings",
        };
      }
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  private async graphql(
    query: string,
    variables: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      signal?.throwIfAborted();
      const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
      const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
      let response: Response;
      try {
        response = await this.fetchImpl(this.endpoint, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({ query, variables }),
          signal: combined,
        });
      } catch (err) {
        if (signal?.aborted) throw err;
        lastError = err;
        if (attempt < MAX_RETRIES) {
          await this.sleep(backoffMs(attempt));
          continue;
        }
        throw new FirefliesApiError(
          `Fireflies API request failed after ${MAX_RETRIES + 1} attempts: ${describeNetworkError(err)}`,
        );
      }

      if (response.status === 429 || response.status >= 500) {
        lastError = new FirefliesApiError(`Fireflies API responded ${response.status}`, response.status);
        if (attempt < MAX_RETRIES) {
          await this.sleep(await retryDelayMs(response, attempt));
          continue;
        }
        throw lastError;
      }
      if (response.status === 401 || response.status === 403) {
        throw new FirefliesApiError(`Fireflies API responded ${response.status}`, response.status);
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new FirefliesApiError("Fireflies API returned a non-JSON body");
      }
      // GraphQL returns 200 with an `errors` array on failure. That is a
      // backend failure, not an empty result (AGENTS.md §22): surface it so
      // an expired token never reads as a quiet day.
      const errors = isRecord(body) ? body.errors : undefined;
      if (Array.isArray(errors) && errors.length > 0) {
        throw graphqlError(errors[0]);
      }
      const data = isRecord(body) ? body.data : undefined;
      if (data === undefined || data === null) {
        throw new FirefliesApiError("Fireflies API returned no data and no errors");
      }
      return data;
    }
    throw lastError instanceof Error ? lastError : new FirefliesApiError("Fireflies API request failed");
  }
}

function graphqlError(first: unknown): FirefliesApiError {
  const record = isRecord(first) ? first : undefined;
  const message = record && typeof record.message === "string" ? record.message : "unknown GraphQL error";
  const extensions = record && isRecord(record.extensions) ? record.extensions : undefined;
  const code = extensions && typeof extensions.code === "string" ? extensions.code : undefined;
  const authLike =
    code === "unauthenticated" ||
    code === "forbidden" ||
    /unauthor|forbidden|invalid.*(token|api key)|expired/i.test(message);
  return new FirefliesApiError(`Fireflies GraphQL error: ${message}`, authLike ? 401 : undefined);
}

function defaultSleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

/**
 * Network/timeout failures wrap Node error text that can carry loader
 * paths or stack fragments; sync errors reach MCP clients verbatim, so
 * only the error name + code survive.
 */
function describeNetworkError(err: unknown): string {
  if (isRecord(err)) {
    const name = typeof err.name === "string" ? err.name : "Error";
    const code = err.code;
    return typeof code === "string" ? `${name} (${code})` : name;
  }
  return "network error";
}

/** Loop instead of `/\/+$/` — CodeQL js/polynomial-redos on user-set URLs. */
function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end--;
  return value.slice(0, end);
}

function backoffMs(attempt: number): number {
  return Math.min(MAX_RETRY_DELAY_MS, 1_000 * 2 ** attempt);
}

async function retryDelayMs(response: Response, attempt: number): Promise<number> {
  const header = response.headers.get("retry-after");
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(MAX_RETRY_DELAY_MS, seconds * 1_000);
    }
    const when = Date.parse(header);
    if (Number.isFinite(when)) {
      return Math.min(MAX_RETRY_DELAY_MS, Math.max(0, when - Date.now()));
    }
  }
  return backoffMs(attempt);
}
