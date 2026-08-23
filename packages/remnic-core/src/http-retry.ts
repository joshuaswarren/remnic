/**
 * Shared retrying fetch for connector packages (issue #2792).
 *
 * One copy of the retry loop that six connector clients and the X MCP
 * client duplicated: attempt counting, per-attempt timeout signal,
 * 429/5xx retry with Retry-After (seconds or HTTP-date) plus capped
 * exponential backoff, raw rethrow of caller aborts, and socket
 * release on retryable responses. Vendors keep everything
 * request-specific: headers/body, the error classes their callers
 * match on, and what happens to a successful response body.
 *
 * Import via the `@remnic/core/http-retry` subpath (same pattern as
 * `@remnic/core/abort-error`) — the root index stays untouched.
 */

export interface RetryingFetchOptions {
  /** Request init for every attempt. Ignored when `buildInit` is set. */
  init?: RequestInit;
  /**
   * Init builder invoked ONCE, before the retry loop. Request
   * construction (e.g. token acquisition) must stay outside the
   * transport retry boundary: a deterministic provider failure —
   * missing grant, revoked grant, unpersistable token file — runs once
   * and propagates unwrapped, never retried or vendor-wrapped.
   */
  buildInit?: () => RequestInit | Promise<RequestInit>;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Retries after the first attempt. Default 3 (4 attempts total). */
  maxRetries?: number;
  maxRetryDelayMs?: number;
  /** First backoff step; doubles per attempt. Default 1_000. */
  backoffBaseMs?: number;
  /**
   * Vendor Retry-After parsing (e.g. a body field). A `null`/`undefined`
   * result falls back to the shared Retry-After header parse, then to
   * exponential backoff. A number (including 0) is used as-is.
   */
  retryAfterMs?: (response: Response) => number | null | undefined | Promise<number | null | undefined>;
  /** Wraps an exhausted network/timeout failure into the vendor error. */
  networkError: (err: unknown, attempts: number, context: NetworkErrorContext) => Error;
  /** Wraps a retryable (429/5xx) response; thrown when retries are exhausted. */
  retryableError: (response: Response) => Error | Promise<Error>;
}

export interface NetworkErrorContext {
  /** True when the helper's own timeout signal fired (not a caller abort). */
  timedOut: boolean;
}

/**
 * Base class for connector API errors: a message plus optional HTTP
 * status and vendor detail. Vendor subclasses set their own `name`.
 */
export class ConnectorApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly detail?: string,
  ) {
    super(message);
    this.name = "ConnectorApiError";
  }
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_MAX_RETRY_DELAY_MS = 30_000;
const DEFAULT_BACKOFF_BASE_MS = 1_000;

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
export function describeNetworkError(err: unknown): string {
  if (!(err instanceof Error)) return "unexpected non-Error failure";
  const code = (err as NodeJS.ErrnoException).code;
  return typeof code === "string" && code.length > 0 ? `${err.name} (${code})` : err.name;
}

/** Loop instead of `/\/+$/` — CodeQL js/polynomial-redos on user-set URLs. */
export function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 0x2f) end--;
  return value.slice(0, end);
}

/** Release the socket back to the pool: an unconsumed response body pins the undici connection. */
export function discardResponseBody(response: Response): void {
  void response.body?.cancel().catch(() => {});
}

/**
 * Parse a `Retry-After` header as delay in ms, capped at `capMs`:
 * delay-seconds first, then HTTP-date. `undefined` when absent or
 * unparseable.
 */
export function retryAfterHeaderMs(response: Response, capMs: number): number | undefined {
  const header = response.headers.get("retry-after");
  if (header === null || header.length === 0) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(capMs, Math.ceil(seconds * 1_000));
  }
  const when = Date.parse(header);
  if (Number.isFinite(when)) {
    return Math.min(capMs, Math.max(0, when - Date.now()));
  }
  return undefined;
}

/**
 * Fetch with retries on network failures, 429, and 5xx. Returns the
 * final response (ok or non-retryable status) for the caller to
 * interpret; throws the vendor-wrapped error when retries are exhausted
 * or the transport fails.
 */
export async function retryingFetch(
  url: string,
  options: RetryingFetchOptions,
): Promise<Response> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const maxRetryDelayMs = options.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
  const backoffBaseMs = options.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
  const backoffMs = (attempt: number): number =>
    Math.min(maxRetryDelayMs, backoffBaseMs * 2 ** attempt);
  const attempts = maxRetries + 1;

  // Request construction runs once, outside the retry boundary: only
  // fetch/network/HTTP-retryable failures retry, so initializer/token
  // provider errors execute once and propagate unchanged (issue #2792).
  options.signal?.throwIfAborted();
  const init = options.buildInit ? await options.buildInit() : options.init;

  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    options.signal?.throwIfAborted();
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const combined = options.signal
      ? AbortSignal.any([options.signal, timeoutSignal])
      : timeoutSignal;
    let response: Response;
    try {
      response = await fetchImpl(url, { ...init, signal: combined });
    } catch (err) {
      // The caller's abort always propagates unwrapped and unretried.
      if (options.signal?.aborted) throw err;
      if (attempt < maxRetries) {
        await sleep(backoffMs(attempt));
        continue;
      }
      throw options.networkError(err, attempts, { timedOut: timeoutSignal.aborted });
    }

    if (response.status === 429 || response.status >= 500) {
      lastError = await options.retryableError(response);
      if (attempt < maxRetries) {
        const override = options.retryAfterMs ? await options.retryAfterMs(response) : undefined;
        const delay = override ?? retryAfterHeaderMs(response, maxRetryDelayMs) ?? backoffMs(attempt);
        discardResponseBody(response);
        await sleep(delay);
        continue;
      }
      discardResponseBody(response);
      throw lastError;
    }
    return response;
  }
  // Unreachable: every terminal loop path throws. Kept for exhaustiveness.
  throw lastError instanceof Error ? lastError : new ConnectorApiError("request failed");
}
