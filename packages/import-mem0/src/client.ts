// ---------------------------------------------------------------------------
// Mem0 REST client (issue #568 slice 5)
// ---------------------------------------------------------------------------
//
// mem0.ai exposes a paginated memories list endpoint. A production user will
// typically hit the hosted service at `https://api.mem0.ai/v1/memories/`,
// supply a Bearer API key, and pull down their account's memories page by
// page. Some users self-host and need a configurable base URL.
//
// This client is intentionally tiny:
//   - fetch-based; no SDK dependency.
//   - Injectable `fetch` impl so tests can replay a record/replay fixture.
//   - Abort-signal aware for clean cancellation.
//   - Rate-limit aware (sleeps between page requests when `rateLimit` is set
//     on `RunImportOptions`).
//
// The adapter calls `fetchAllMem0Memories()` once; it walks pagination and
// returns a flat array. The transform layer then maps each raw record to an
// `ImportedMemory`.

export interface Mem0Memory {
  /** Stable memory id. */
  id: string;
  /** Memory body. API older responses nest this in `memory`. */
  memory?: string;
  content?: string;
  text?: string;
  user_id?: string;
  agent_id?: string;
  created_at?: string;
  updated_at?: string;
  metadata?: Record<string, unknown>;
  categories?: string[];
  score?: number;
}

/**
 * Shape returned by the paginated memories endpoint. The real API uses
 * `results` + `next` (cursor URL) on v1 and `memories` + `page` + `total`
 * on v0; the client accepts either so tests can replay both.
 */
export interface Mem0ListResponse {
  results?: Mem0Memory[];
  memories?: Mem0Memory[];
  next?: string | null;
  total?: number;
  page?: number;
  per_page?: number;
}

export interface Mem0ClientOptions {
  apiKey: string;
  /** Default: `https://api.mem0.ai`. Trailing slash tolerated. */
  baseUrl?: string;
  /**
   * Path prefix for the list endpoint. Defaults to `/v1/memories/` for
   * the hosted API. Self-hosted mem0-oss deployments typically expose
   * `/memories/` without the `/v1` prefix — set `MEM0_LIST_PATH` /
   * pass this explicitly in that case. Codex review on PR #602.
   */
  listPath?: string;
  /** Injected for tests. Falls back to `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
  /** Requests per second limiter. Applied between pages. */
  rateLimit?: number;
  /**
   * Filters required by hosted mem0 list requests. Defaults to a broad empty
   * filter body for the current hosted API.
   */
  filters?: Record<string, unknown>;
  /** Use the legacy GET list contract for self-hosted or older v1 deployments. */
  legacyGet?: boolean;
  /** Abort signal wired through to fetch. */
  signal?: AbortSignal;
  /** Sleep function for rate limiting; injectable so tests run instantly. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_BASE_URL = "https://api.mem0.ai";
const DEFAULT_LIST_PATH = "/v3/memories/?page=1&page_size=50";

/**
 * Fetch all mem0 memories across pagination. Returns a flat array; the
 * caller is responsible for deduplication (the orchestrator does this
 * naturally via content hashing).
 */
export async function fetchAllMem0Memories(
  options: Mem0ClientOptions,
): Promise<Mem0Memory[]> {
  if (!options.apiKey || typeof options.apiKey !== "string") {
    throw new Error("mem0 import requires a non-empty apiKey");
  }
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error(
      "No fetch implementation available. Provide `fetchImpl` or run on Node 18+.",
    );
  }
  const sleep = options.sleep ?? defaultSleep;
  const base = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const listPath = normalizeListPath(options.listPath ?? DEFAULT_LIST_PATH);
  const intervalMs =
    options.rateLimit && options.rateLimit > 0 ? 1000 / options.rateLimit : 0;

  const all: Mem0Memory[] = [];
  const firstUrl = `${base}${listPath}`;
  // Capture the allow-listed origin ONCE so cross-origin cursors can't
  // tunnel the API key to an attacker-controlled host. Codex review on
  // PR #602. We also validate that the configured base URL itself is a
  // parseable absolute URL — mem0 servers that return relative cursors
  // are then resolved against this origin.
  const allowedOrigin = safeUrlOrigin(firstUrl);
  let nextUrl: string | null = firstUrl;
  let pageIndex = 0;
  while (nextUrl) {
    throwIfAborted(options.signal);
    if (pageIndex > 0 && intervalMs > 0) {
      await sleepWithAbort(sleep, intervalMs, options.signal);
    }
    const response = await fetchImpl(nextUrl, buildMem0ListRequest(options));
    if (!response.ok) {
      const body = await safeText(response);
      throw new Error(
        `mem0 API request to ${nextUrl} failed with ${response.status}: ${body}`,
      );
    }
    const json = (await response.json()) as Mem0ListResponse;
    const page = json.results ?? json.memories ?? [];
    for (const entry of page) {
      if (entry && typeof entry === "object" && typeof entry.id === "string") {
        all.push(entry);
      }
    }
    nextUrl = resolveNextUrl(json, firstUrl, pageIndex, page.length, allowedOrigin);
    pageIndex += 1;
  }
  return all;
}

function buildMem0ListRequest(options: Mem0ClientOptions): RequestInit {
  if (options.legacyGet === true) {
    return {
      method: "GET",
      headers: {
        Authorization: `Token ${options.apiKey}`,
        Accept: "application/json",
      },
      ...(options.signal ? { signal: options.signal } : {}),
    };
  }
  return {
    method: "POST",
    headers: {
      Authorization: `Token ${options.apiKey}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ filters: options.filters ?? {} }),
    ...(options.signal ? { signal: options.signal } : {}),
  };
}

function normalizeListPath(p: string): string {
  const withLeadingSlash = p.startsWith("/") ? p : `/${p}`;
  if (withLeadingSlash.includes("?")) return withLeadingSlash;
  return withLeadingSlash.endsWith("/") ? withLeadingSlash : `${withLeadingSlash}/`;
}

function safeUrlOrigin(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

/**
 * Decide the next URL to request.
 *
 * Preferred: the `next` cursor the server returns (v1 shape). When `next`
 * is a **relative** path, it's resolved against the configured base URL.
 * When absolute, it MUST match the allow-listed origin — cross-origin
 * cursors are rejected so an upstream/proxy can't exfiltrate the API key
 * by redirecting the pagination walk. Codex review on PR #602.
 *
 * Fallback: when `next` is explicitly `null` (server says "no more pages"),
 * stop. When `next` is absent (field omitted) AND the response exposes
 * numeric pagination fields (`page` / `total` / `per_page`, the older v0
 * shape), synthesize a `?page=<N>` request for the next page. Cursor
 * review on PR #602 flagged that servers returning only numeric
 * pagination were silently truncated under the original code, AND that
 * the implementation conflated `null` with `undefined`.
 */
function resolveNextUrl(
  json: Mem0ListResponse,
  firstUrl: string,
  currentPageIndex: number,
  pageSize: number,
  allowedOrigin: string | undefined,
): string | null {
  // Has the server explicitly returned a next value?
  if ("next" in json) {
    if (json.next === null) return null; // authoritative stop
    if (typeof json.next === "string" && json.next.length > 0) {
      return resolveCursorOrThrow(json.next, firstUrl, allowedOrigin);
    }
    // `next` was present but not a non-empty string or null (e.g. number).
    // Don't fall through to numeric pagination — the server sent a signal
    // we can't interpret. Treat as end-of-stream.
    return null;
  }

  // Numeric-pagination fallback. `page` is 1-based in the real API.
  const responsePage = typeof json.page === "number" && Number.isFinite(json.page)
    ? json.page
    : currentPageIndex + 1;
  const perPage = typeof json.per_page === "number" && Number.isFinite(json.per_page)
    ? json.per_page
    : pageSize;
  const total = typeof json.total === "number" && Number.isFinite(json.total)
    ? json.total
    : undefined;
  if (total === undefined || perPage <= 0) return null;
  const fetchedSoFar = responsePage * perPage;
  if (fetchedSoFar >= total) return null;
  const nextPage = responsePage + 1;
  try {
    const u = new URL(firstUrl);
    u.searchParams.set("page", String(nextPage));
    return u.toString();
  } catch {
    return null;
  }
}

/**
 * Resolve a server-provided cursor against the base URL and enforce
 * same-origin. Relative cursors are accepted (resolved against firstUrl);
 * absolute cursors must match `allowedOrigin`. Throws on cross-origin to
 * surface the security-relevant mismatch immediately instead of silently
 * leaking the API key.
 */
function resolveCursorOrThrow(
  cursor: string,
  firstUrl: string,
  allowedOrigin: string | undefined,
): string {
  if (!allowedOrigin) {
    // Base URL wasn't parseable as an absolute URL; refuse to follow any
    // cursor because we can't compare origins.
    throw new Error(
      `mem0 pagination cursor '${cursor}' cannot be followed: configured baseUrl is not an absolute URL.`,
    );
  }
  let resolved: URL;
  try {
    resolved = new URL(cursor, firstUrl);
  } catch {
    throw new Error(
      `mem0 pagination cursor '${cursor}' is not a valid URL.`,
    );
  }
  if (resolved.origin !== allowedOrigin) {
    throw new Error(
      `mem0 pagination cursor '${cursor}' points to origin '${resolved.origin}', ` +
        `but the configured mem0 origin is '${allowedOrigin}'. ` +
        "Refusing to forward the API key to a cross-origin endpoint.",
    );
  }
  return resolved.toString();
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw makeAbortError();
  }
}

function makeAbortError(): Error {
  const err = new Error("mem0 import aborted");
  (err as Error & { name: string }).name = "AbortError";
  return err;
}

function sleepWithAbort(
  sleep: (ms: number) => Promise<void>,
  ms: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (!signal) return sleep(ms);
  if (signal.aborted) return Promise.reject(makeAbortError());

  let removeAbortListener: (() => void) | undefined;
  const abortPromise = new Promise<never>((_, reject) => {
    const onAbort = () => {
      removeAbortListener?.();
      reject(makeAbortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    removeAbortListener = () => signal.removeEventListener("abort", onAbort);
  });

  return Promise.race([sleep(ms), abortPromise]).finally(() => {
    removeAbortListener?.();
  });
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 500);
  } catch {
    return "(failed to read response body)";
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
