/**
 * Minimal Granola public API client (raw fetch, no SDK).
 *
 * API verified against the official OpenAPI at
 * https://docs.granola.ai/api-reference/list-notes and
 * https://docs.granola.ai/api-reference/get-note (fetched 2026-07-21):
 *   - Base URL: https://public-api.granola.ai
 *   - Auth: `Authorization: Bearer grn_<key>`
 *   - `GET /v1/notes?created_after=&created_before=&cursor=&page_size=` →
 *     `{ notes: NoteSummary[], hasMore, cursor }` (page_size 1..30, default 10);
 *     `created_after`/`created_before` accept date or date-time. The list only
 *     returns notes that already have an AI summary + transcript.
 *   - `GET /v1/notes/{id}?include=transcript` → full Note with `calendar_event`
 *     (`scheduled_start_time`/`scheduled_end_time`), `attendees`, `summary_text`,
 *     `summary_markdown`, and `transcript` items
 *     `{ speaker: { source, diarization_label? }, text, start_time, end_time }`.
 *   - Rate limits: 5 req/s sustained, 25 burst → 429 on excess.
 *
 * A non-2xx or network failure throws GranolaApiError (a backend failure); an
 * empty `notes` array is a real empty result, never conflated (AGENTS.md §22).
 */

export const GRANOLA_DEFAULT_BASE_URL = "https://public-api.granola.ai";

/** Hard API maximum for `page_size` on the notes list. */
export const NOTES_MAX_PAGE_SIZE = 30;

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 3;
const MAX_RETRY_DELAY_MS = 30_000;

export interface GranolaSpeaker {
  source?: string | null;
  diarization_label?: string | null;
}

export interface GranolaTranscriptItem {
  speaker?: GranolaSpeaker | null;
  text?: string | null;
  start_time?: string | null;
  end_time?: string | null;
}

export interface GranolaCalendarEvent {
  event_title?: string | null;
  organiser?: string | null;
  scheduled_start_time?: string | null;
  scheduled_end_time?: string | null;
}

export interface GranolaUser {
  name?: string | null;
  email?: string | null;
}

export interface GranolaNote {
  id: string;
  title?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  calendar_event?: GranolaCalendarEvent | null;
  attendees?: GranolaUser[] | null;
  summary_text?: string | null;
  summary_markdown?: string | null;
  transcript?: GranolaTranscriptItem[] | null;
}

export interface NotesPage {
  notes: GranolaNote[];
  nextCursor: string | null;
}

export interface GranolaClientOptions {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export class GranolaApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "GranolaApiError";
  }
}

/** Narrow unknown JSON to a plain object so field reads are actually checked. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export class GranolaClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: GranolaClientOptions) {
    if (typeof options.apiKey !== "string" || options.apiKey.trim().length === 0) {
      throw new GranolaApiError(
        "Granola API key is missing. Set wearables.sources.granola.apiKey " +
          "or the REMNIC_GRANOLA_API_KEY / GRANOLA_API_KEY environment variable " +
          "(create a key under Settings → Connectors → API keys in the Granola app; " +
          "requires a Business/Enterprise plan).",
      );
    }
    this.apiKey = options.apiKey.trim();
    this.baseUrl = stripTrailingSlashes(options.baseUrl ?? GRANOLA_DEFAULT_BASE_URL);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.sleep = options.sleep ?? defaultSleep;
  }

  /** One page of note summaries in the half-open [createdAfter, createdBefore) window. */
  async listNotes(params: {
    createdAfter: string;
    createdBefore: string;
    cursor?: string | null;
    signal?: AbortSignal;
  }): Promise<NotesPage> {
    const search = new URLSearchParams({
      created_after: params.createdAfter,
      created_before: params.createdBefore,
      page_size: String(NOTES_MAX_PAGE_SIZE),
    });
    if (typeof params.cursor === "string" && params.cursor.length > 0) {
      search.set("cursor", params.cursor);
    }
    const payload = await this.requestJson(`/v1/notes?${search.toString()}`, params.signal);
    const notesRaw = isRecord(payload) ? payload.notes : undefined;
    if (!Array.isArray(notesRaw)) {
      throw new GranolaApiError("Granola API returned an unexpected /v1/notes shape (missing notes array)");
    }
    const notes = notesRaw.filter(
      (entry): entry is GranolaNote => isRecord(entry) && typeof entry.id === "string",
    );
    const hasMore = isRecord(payload) && payload.hasMore === true;
    const cursor = isRecord(payload) && typeof payload.cursor === "string" ? payload.cursor : null;
    if (hasMore && (cursor === null || cursor.length === 0)) {
      // A `hasMore: true` page with no usable cursor is a malformed pagination
      // response; fail loudly rather than silently sync a partial day (§22).
      throw new GranolaApiError("Granola reported hasMore=true but returned no pagination cursor");
    }
    return { notes, nextCursor: hasMore ? cursor : null };
  }

  /** A single note with its transcript, calendar event, summary, and attendees. */
  async getNote(id: string, signal?: AbortSignal): Promise<GranolaNote> {
    const payload = await this.requestJson(
      `/v1/notes/${encodeURIComponent(id)}?include=transcript`,
      signal,
    );
    if (!isRecord(payload) || typeof payload.id !== "string") {
      throw new GranolaApiError("Granola API returned an unexpected note shape (missing id)");
    }
    // Validated boundary: `id` is confirmed a string above; every other field
    // is optional and the normalizer re-checks each. Cast through `unknown`
    // because the external JSON shape can't be proven structurally here.
    return payload as unknown as GranolaNote;
  }

  /** Cheap auth probe. */
  async verifyAuth(signal?: AbortSignal): Promise<{ ok: boolean; detail?: string }> {
    try {
      await this.requestJson("/v1/notes?page_size=1", signal);
      return { ok: true };
    } catch (err) {
      if (err instanceof GranolaApiError && (err.status === 401 || err.status === 403)) {
        return {
          ok: false,
          detail: "Granola rejected the API key (401/403) — create a new key under Settings → Connectors → API keys",
        };
      }
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
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
        throw new GranolaApiError(
          `Granola API request failed after ${MAX_RETRIES + 1} attempts: ${describeNetworkError(err)}`,
        );
      }

      if (response.status === 429 || response.status >= 500) {
        discardBody(response);
        lastError = new GranolaApiError(`Granola API responded ${response.status}`, response.status);
        if (attempt < MAX_RETRIES) {
          await this.sleep(await retryDelayMs(response, attempt));
          continue;
        }
        throw lastError;
      }
      if (!response.ok) {
        discardBody(response);
        throw new GranolaApiError(
          `Granola API responded ${response.status} for ${pathAndQuery.split("?")[0]}`,
          response.status,
        );
      }
      try {
        return await response.json();
      } catch {
        throw new GranolaApiError("Granola API returned a non-JSON body");
      }
    }
    throw lastError instanceof Error ? lastError : new GranolaApiError("Granola API request failed");
  }
}

function defaultSleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

/**
 * Release the socket back to the pool on error paths: an unconsumed response
 * body pins the undici connection (stability review note).
 */
function discardBody(response: Response): void {
  void response.body?.cancel().catch(() => {});
}

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
