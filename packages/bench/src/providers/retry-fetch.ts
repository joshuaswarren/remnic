/**
 * Fetch wrapper with retry for transient failures.
 * Retries on ECONNREFUSED, ECONNRESET, ETIMEDOUT, HTTP 429 (rate limit),
 * and HTTP 5xx. 429 pauses according to the Retry-After header (or a
 * default backoff) before retrying. When max429WaitMs is set, the same
 * wall-clock budget also covers transient 5xx responses from throttled
 * provider backends that surface quota resets as server errors.
 */

export interface RetryFetchOptions {
  maxAttempts?: number;
  baseBackoffMs?: number;
  timeoutMs?: number;
  /**
   * Maximum wall-clock time (ms) to keep retrying 429 responses.
   * When set, 429s are retried with capped exponential backoff
   * until this budget expires, regardless of maxAttempts.
   * Useful for session-quota rate limits that take minutes to reset.
   * Set to 0 or undefined to disable (uses maxAttempts instead).
   */
  max429WaitMs?: number;
}

const DEFAULTS: Required<RetryFetchOptions> = {
  maxAttempts: 3,
  baseBackoffMs: 1000,
  timeoutMs: 120_000,
  max429WaitMs: 0,
};

function normalizeRetryFetchOptions(options?: RetryFetchOptions): Required<RetryFetchOptions> {
  const normalized = {
    maxAttempts: options?.maxAttempts ?? DEFAULTS.maxAttempts,
    baseBackoffMs: options?.baseBackoffMs ?? DEFAULTS.baseBackoffMs,
    timeoutMs: options?.timeoutMs ?? DEFAULTS.timeoutMs,
    max429WaitMs: options?.max429WaitMs ?? DEFAULTS.max429WaitMs,
  };
  if (!Number.isInteger(normalized.maxAttempts) || normalized.maxAttempts <= 0) {
    throw new Error("retryFetch maxAttempts must be a positive integer");
  }
  for (const field of ["baseBackoffMs", "timeoutMs", "max429WaitMs"] as const) {
    if (!Number.isFinite(normalized[field]) || normalized[field] < 0) {
      throw new Error(`retryFetch ${field} must be a finite non-negative number`);
    }
  }
  return normalized;
}

/** Maximum time to wait on a single Retry-After value (seconds). */
const MAX_RETRY_AFTER_S = 600;

/** Maximum backoff for a single 429 retry when no Retry-After header (seconds). */
const MAX_429_BACKOFF_S = 120;

async function readBodyPreview(response: Response, maxBytes: number): Promise<string> {
  try {
    const text = await response.text();
    return text.slice(0, maxBytes);
  } catch {
    return "";
  }
}

function isTransientError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    msg.includes("econnrefused") ||
    msg.includes("econnreset") ||
    msg.includes("etimedout") ||
    msg.includes("econnaborted") ||
    msg.includes("socket hang up") ||
    msg.includes("fetch failed") ||
    err.name === "AbortError"
  );
}

/**
 * Parse a Retry-After header value into milliseconds.
 * Accepts either an integer number of seconds or an HTTP-date.
 * Returns `undefined` when the header is absent or unparseable.
 */
export function parseRetryAfterMs(value: string | null): number | undefined {
  if (value === null || value.length === 0) return undefined;

  const asNumber = Number(value);
  if (Number.isFinite(asNumber) && asNumber >= 0) {
    return Math.min(asNumber, MAX_RETRY_AFTER_S) * 1000;
  }

  // Only try HTTP-date parsing for non-numeric values.
  if (Number.isNaN(asNumber)) {
    const dateMs = Date.parse(value);
    if (Number.isFinite(dateMs)) {
      const delta = dateMs - Date.now();
      return delta > 0 ? Math.min(delta, MAX_RETRY_AFTER_S * 1000) : 0;
    }
  }

  return undefined;
}

function parseBodySuggestedRetryMs(body: string): number | undefined {
  const match = body.match(/try again in\s+(\d+)\s+seconds?/i);
  if (!match) return undefined;
  const seconds = Number(match[1]);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.min(seconds, MAX_RETRY_AFTER_S) * 1000;
}

function abortAwareSleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) { resolve(); return; }
    const onAbort = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function retryFetch(
  url: string,
  init: RequestInit,
  options?: RetryFetchOptions,
): Promise<Response> {
  const opts = normalizeRetryFetchOptions(options);
  let lastError: Error | null = null;
  let last429Response: Response | null = null;
  let last429IsStale = false;
  const loopStartMs = Date.now();

  const remainingExtendedBudgetMs = () =>
    opts.max429WaitMs > 0
      ? Math.max(0, opts.max429WaitMs - (Date.now() - loopStartMs))
      : 0;

  for (let attempt = 1; ; attempt++) {
    const callerSignal = init.signal as AbortSignal | undefined;
    if (callerSignal?.aborted) {
      throw new DOMException("The operation was aborted.", "AbortError");
    }

    // Non-429 errors (transient, 5xx) are always capped by maxAttempts.
    // The 429 budget only extends retries for 429 responses beyond maxAttempts.
    if (attempt > opts.maxAttempts) {
      const remainingBudget = remainingExtendedBudgetMs();
      if (remainingBudget <= 0) {
        // Only return a saved 429 when the budget feature is active and
        // no non-429 failures have occurred since the last 429.
        // With max429WaitMs=0 (default), always break to throw lastError.
        if (opts.max429WaitMs > 0 && last429Response && !last429IsStale) return last429Response;
        break;
      }
      // Past maxAttempts but within the extended provider budget — only
      // continue if a retryable response/error has already been observed.
      if (!last429Response && !lastError) {
        break;
      }
    }

    const controller = new AbortController();
    const onCallerAbort = () => controller.abort();
    callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
    const timeout = setTimeout(() => controller.abort(), opts.timeoutMs);

    try {
      const { signal: _callerSignal, ...initWithoutSignal } = init;
      const response = await fetch(url, { ...initWithoutSignal, signal: controller.signal });
      clearTimeout(timeout);

      if (response.ok) {
        callerSignal?.removeEventListener("abort", onCallerAbort);
        return response;
      }

      // 1xx informational / 3xx redirect — return immediately, no retry.
      if (response.status < 400) {
        callerSignal?.removeEventListener("abort", onCallerAbort);
        return response;
      }

      // 429 Too Many Requests — pause and retry.
      if (response.status === 429) {
        const inBudget = remainingExtendedBudgetMs() > 0;
        const underMaxAttempts = attempt < opts.maxAttempts;

        // Stop if past maxAttempts with no budget remaining.
        // Under maxAttempts, 429s always retry regardless of budget —
        // the budget only EXTENDS retries beyond maxAttempts.
        if (!underMaxAttempts && !inBudget) {
          // Return the response with a readable body for the caller.
          callerSignal?.removeEventListener("abort", onCallerAbort);
          return response;
        }

        const retryAfter = parseRetryAfterMs(response.headers.get("retry-after"));
        const body = await response.text();
        last429Response = new Response(body, {
          status: response.status,
          statusText: response.statusText,
          headers: new Headers(response.headers),
        });
        last429IsStale = false;

        let waitMs =
          retryAfter != null
            ? Math.max(retryAfter, 100)
            : Math.min(
                opts.baseBackoffMs * Math.pow(2, attempt - 1),
                MAX_429_BACKOFF_S * 1000,
              );

        // Clamp to remaining 429 budget so we don't overshoot.
        if (opts.max429WaitMs > 0) {
          waitMs = Math.min(waitMs, remainingExtendedBudgetMs());
        }

        const budgetTag = inBudget
          ? ` (${Math.round((Date.now() - loopStartMs) / 1000)}s/${Math.round(opts.max429WaitMs / 1000)}s budget)`
          : "";

        console.error(
          `[rate-limit] 429 received (attempt ${attempt}/${opts.maxAttempts})${budgetTag}, ` +
            `pausing ${Math.round(waitMs / 1000)}s before retry…`,
        );
        await abortAwareSleep(waitMs, callerSignal);

        callerSignal?.removeEventListener("abort", onCallerAbort);
        continue;
      }

      // 4xx (other than 429) — return immediately, no retry.
      if (response.status >= 400 && response.status < 500) {
        callerSignal?.removeEventListener("abort", onCallerAbort);
        return response;
      }

      // 5xx — retry with exponential backoff. When an extended provider
      // wait budget is configured, keep retrying transient server errors
      // within that same wall-clock budget so cloud throttling does not
      // become a false benchmark task failure.
      const bodyPreview = await readBodyPreview(response, 512);
      if (attempt >= opts.maxAttempts && remainingExtendedBudgetMs() <= 0) {
        callerSignal?.removeEventListener("abort", onCallerAbort);
        throw new Error(
          `HTTP ${response.status} ${response.statusText} (attempt ${attempt}/${opts.maxAttempts}): ${bodyPreview}`,
        );
      }
      lastError = new Error(
        `HTTP ${response.status} ${response.statusText} (attempt ${attempt}/${opts.maxAttempts}): ${bodyPreview}`,
      );
      last429IsStale = true;

      if (attempt >= opts.maxAttempts) {
        const retryAfter =
          parseRetryAfterMs(response.headers.get("retry-after")) ??
          parseBodySuggestedRetryMs(bodyPreview);
        const waitMs = Math.min(
          Math.max(retryAfter ?? opts.baseBackoffMs * Math.pow(2, attempt - 1), 100),
          remainingExtendedBudgetMs(),
        );
        console.error(
          `[transient] HTTP ${response.status} received (attempt ${attempt}/${opts.maxAttempts}) ` +
            `within extended provider budget, pausing ${Math.round(waitMs / 1000)}s before retry…`,
        );
        await abortAwareSleep(waitMs, callerSignal);
        callerSignal?.removeEventListener("abort", onCallerAbort);
        continue;
      }
    } catch (err) {
      clearTimeout(timeout);
      if (callerSignal?.aborted) {
        callerSignal?.removeEventListener("abort", onCallerAbort);
        throw err;
      }
      if (!isTransientError(err)) {
        callerSignal?.removeEventListener("abort", onCallerAbort);
        throw err;
      }
      lastError = err instanceof Error ? err : new Error(String(err));
      last429IsStale = true;
      callerSignal?.removeEventListener("abort", onCallerAbort);

      if (attempt >= opts.maxAttempts) {
        throw lastError;
      }
    }

    // Backoff before next attempt. Capped at maxAttempts for non-429 errors.
    if (attempt < opts.maxAttempts) {
      const backoffMs = opts.baseBackoffMs * Math.pow(2, attempt - 1);
      await abortAwareSleep(backoffMs, init.signal as AbortSignal | undefined);
    }
  }

  throw lastError ?? new Error("retryFetch: all attempts exhausted");
}
