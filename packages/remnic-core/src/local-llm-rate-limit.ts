/**
 * Process-wide rate-limit handling for the local LLM client (COS-447).
 *
 * A LiteLLM proxy in front of the local models answers `429 No deployments
 * available` (and `503`/`408`) when every deployment is busy or in cooldown.
 * Before this module the client returned on the first 429 and the caller
 * loop immediately issued the next request, so one daemon could hammer the
 * proxy with thousands of calls per hour while it was saturated.
 *
 * This module provides three pieces that the client composes:
 *
 * - classification of rate-limit responses and of the retry hint
 *   (`Retry-After` header as delta-seconds or HTTP-date, falling back to
 *   LiteLLM's `Try again in N seconds` body text);
 * - exponential backoff with full jitter;
 * - process-wide state shared by every `LocalLlmClient` instance: a
 *   concurrency semaphore for in-flight HTTP attempts and a per-endpoint
 *   "do not call before" deadline, so one client's 429 slows every client
 *   pointed at the same endpoint.
 *
 * State lives on `globalThis` so duplicated module copies in bundled output
 * still share one limiter.
 */

export const RATE_LIMIT_STATUSES: ReadonlySet<number> = new Set([408, 429, 503]);

const RATE_LIMIT_BODY_PATTERN = /no deployments available|cooldown_list|all deployments.*cooldown/i;
const TRY_AGAIN_PATTERN = /try again in (\d+(?:\.\d+)?) ?(seconds?|secs?|s|milliseconds?|ms|minutes?|mins?)\b/i;

/** Upper bound on any server-provided wait we will record (sanity clamp). */
export const MAX_RECORDED_BACKOFF_MS = 10 * 60_000;

export const DEFAULT_RATE_LIMIT_RETRY_COUNT = 3;
export const DEFAULT_RATE_LIMIT_BACKOFF_BASE_MS = 1_000;
export const DEFAULT_RATE_LIMIT_BACKOFF_MAX_MS = 60_000;
export const DEFAULT_MAX_CONCURRENCY = 4;

export interface LocalLlmRateLimitSettings {
  retryCount: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  /** 0 disables the process-wide concurrency cap. */
  maxConcurrency: number;
}

function nonNegativeInt(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) return fallback;
  return Math.floor(value);
}

export function resolveRateLimitSettings(config: {
  localLlmRateLimitRetryCount?: number;
  localLlmRateLimitBackoffBaseMs?: number;
  localLlmRateLimitBackoffMaxMs?: number;
  localLlmMaxConcurrency?: number;
}): LocalLlmRateLimitSettings {
  const backoffBaseMs = Math.max(
    1,
    nonNegativeInt(config.localLlmRateLimitBackoffBaseMs, DEFAULT_RATE_LIMIT_BACKOFF_BASE_MS)
  );
  const backoffMaxMs = Math.max(
    backoffBaseMs,
    nonNegativeInt(config.localLlmRateLimitBackoffMaxMs, DEFAULT_RATE_LIMIT_BACKOFF_MAX_MS)
  );
  return {
    retryCount: nonNegativeInt(config.localLlmRateLimitRetryCount, DEFAULT_RATE_LIMIT_RETRY_COUNT),
    backoffBaseMs,
    backoffMaxMs,
    maxConcurrency: nonNegativeInt(config.localLlmMaxConcurrency, DEFAULT_MAX_CONCURRENCY),
  };
}

/**
 * True for responses that mean "the endpoint is saturated, slow down":
 * 408/429/503, or a 5xx whose body carries LiteLLM's cooldown wording.
 * 400s are never rate limits (context-window errors mention fallbacks).
 */
export function isRateLimitedResponse(status: number, bodyText: string): boolean {
  if (RATE_LIMIT_STATUSES.has(status)) return true;
  return status >= 500 && RATE_LIMIT_BODY_PATTERN.test(bodyText);
}

/**
 * Parse an HTTP `Retry-After` value (RFC 9110: delta-seconds or HTTP-date).
 * Returns milliseconds to wait, or null when absent/invalid.
 */
export function parseRetryAfterMs(value: string | null | undefined, nowMs: number = Date.now()): number | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    return Math.min(MAX_RECORDED_BACKOFF_MS, Math.round(Number(trimmed) * 1000));
  }
  const dateMs = Date.parse(trimmed);
  if (Number.isNaN(dateMs)) return null;
  return Math.min(MAX_RECORDED_BACKOFF_MS, Math.max(0, dateMs - nowMs));
}

/** Parse LiteLLM's `Try again in N seconds` hint from an error body. */
export function parseTryAgainHintMs(bodyText: string): number | null {
  const match = bodyText.match(TRY_AGAIN_PATTERN);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return null;
  const unit = match[2].toLowerCase();
  let ms: number;
  if (unit.startsWith("ms") || unit.startsWith("milli")) ms = amount;
  else if (unit.startsWith("min")) ms = amount * 60_000;
  else ms = amount * 1000;
  return Math.min(MAX_RECORDED_BACKOFF_MS, Math.round(ms));
}

/** Server-provided wait: `Retry-After` header first, then the body hint. */
export function serverRetryHintMs(
  retryAfterHeader: string | null | undefined,
  bodyText: string,
  nowMs: number = Date.now()
): number | null {
  return parseRetryAfterMs(retryAfterHeader, nowMs) ?? parseTryAgainHintMs(bodyText);
}

/**
 * Exponential backoff with full jitter: uniform in [0, min(max, base * 2^(n-1))].
 * `attempt` is 1-based (the number of consecutive rate-limit responses).
 */
export function computeFullJitterBackoffMs(
  attempt: number,
  baseMs: number,
  maxMs: number,
  random: () => number = Math.random
): number {
  const exponent = Math.max(0, Math.min(30, attempt - 1));
  const ceiling = Math.min(maxMs, baseMs * 2 ** exponent);
  return Math.floor(random() * ceiling);
}

/**
 * Delay before the next attempt after a rate-limit response. A server hint
 * is a floor (never call earlier than asked); jitter is added on top of the
 * exponential term so synchronized callers spread out.
 */
export function computeRateLimitDelayMs(
  attempt: number,
  settings: Pick<LocalLlmRateLimitSettings, "backoffBaseMs" | "backoffMaxMs">,
  serverHintMs: number | null,
  random: () => number = Math.random
): number {
  const jittered = computeFullJitterBackoffMs(attempt, settings.backoffBaseMs, settings.backoffMaxMs, random);
  return serverHintMs === null ? jittered : Math.max(serverHintMs, jittered);
}

type Waiter = { highPriority: boolean; grant: () => void };

/** FIFO counting semaphore with a high-priority lane (recall-critical first). */
export class LocalLlmConcurrencyLimiter {
  private active = 0;
  private max: number;
  private readonly waiters: Waiter[] = [];

  constructor(max: number) {
    this.max = max;
  }

  setMax(max: number): void {
    this.max = max;
    this.pump();
  }

  get inFlight(): number {
    return this.active;
  }

  get queued(): number {
    return this.waiters.length;
  }

  /**
   * Wait for a slot. Resolves to a release function, or null when the
   * signal aborts first. `max <= 0` means unlimited.
   */
  acquire(
    options: { highPriority?: boolean; signal?: AbortSignal; timeoutMs?: number } = {}
  ): Promise<(() => void) | null> {
    const { signal, timeoutMs } = options;
    if (signal?.aborted) return Promise.resolve(null);
    if (this.max <= 0 || (this.active < this.max && this.waiters.length === 0)) {
      this.active += 1;
      return Promise.resolve(this.releaser());
    }
    if (timeoutMs !== undefined && timeoutMs <= 0) return Promise.resolve(null);
    return new Promise((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      const waiter: Waiter = {
        highPriority: options.highPriority === true,
        grant: () => {
          signal?.removeEventListener("abort", onAbort);
          if (timer) clearTimeout(timer);
          resolve(this.releaser());
        },
      };
      const onAbort = (): void => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        signal?.removeEventListener("abort", onAbort);
        if (timer) clearTimeout(timer);
        resolve(null);
      };
      if (waiter.highPriority) {
        const firstLow = this.waiters.findIndex((w) => !w.highPriority);
        if (firstLow < 0) this.waiters.push(waiter);
        else this.waiters.splice(firstLow, 0, waiter);
      } else {
        this.waiters.push(waiter);
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      if (timeoutMs !== undefined) timer = setTimeout(onAbort, timeoutMs);
    });
  }

  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      this.pump();
    };
  }

  private pump(): void {
    while (this.waiters.length > 0 && (this.max <= 0 || this.active < this.max)) {
      const next = this.waiters.shift();
      if (!next) break;
      this.active += 1;
      next.grant();
    }
  }
}

interface EndpointBackoffState {
  untilMs: number;
  consecutiveRateLimits: number;
}

interface RateLimitGlobalState {
  limiter: LocalLlmConcurrencyLimiter;
  endpoints: Map<string, EndpointBackoffState>;
}

declare global {
  // Shared across duplicated module copies in bundled output.
  var __remnicLocalLlmRateLimitState: RateLimitGlobalState | undefined;
}

function globalState(): RateLimitGlobalState {
  globalThis.__remnicLocalLlmRateLimitState ??= {
    limiter: new LocalLlmConcurrencyLimiter(DEFAULT_MAX_CONCURRENCY),
    endpoints: new Map(),
  };
  return globalThis.__remnicLocalLlmRateLimitState;
}

/** Process-wide limiter, resized to the caller's configured cap. */
export function getLocalLlmConcurrencyLimiter(maxConcurrency: number): LocalLlmConcurrencyLimiter {
  const { limiter } = globalState();
  limiter.setMax(maxConcurrency);
  return limiter;
}

/** Milliseconds until `endpoint` may be called again (0 when clear). */
export function endpointBackoffRemainingMs(endpoint: string, nowMs: number = Date.now()): number {
  const entry = globalState().endpoints.get(endpoint);
  return entry ? Math.max(0, entry.untilMs - nowMs) : 0;
}

/**
 * Record a rate-limit response for `endpoint`. Returns the consecutive
 * rate-limit count (1-based) to feed the backoff exponent.
 */
export function noteEndpointRateLimited(endpoint: string): number {
  const { endpoints } = globalState();
  const entry = endpoints.get(endpoint) ?? { untilMs: 0, consecutiveRateLimits: 0 };
  entry.consecutiveRateLimits += 1;
  endpoints.set(endpoint, entry);
  return entry.consecutiveRateLimits;
}

/** Push the endpoint's "do not call before" deadline out to at least `nowMs + delayMs`. */
export function extendEndpointBackoff(endpoint: string, delayMs: number, nowMs: number = Date.now()): void {
  const { endpoints } = globalState();
  const entry = endpoints.get(endpoint) ?? { untilMs: 0, consecutiveRateLimits: 0 };
  const bounded = Math.min(MAX_RECORDED_BACKOFF_MS, Math.max(0, delayMs));
  entry.untilMs = Math.max(entry.untilMs, nowMs + bounded);
  endpoints.set(endpoint, entry);
}

/**
 * Reset the backoff exponent after a non-rate-limited response. An already
 * recorded deadline is left to expire so concurrent callers that saw the
 * 429 still wait it out.
 */
export function noteEndpointRecovered(endpoint: string): void {
  const entry = globalState().endpoints.get(endpoint);
  if (entry) entry.consecutiveRateLimits = 0;
}

/** Test seam: drop all process-wide state. */
export function resetLocalLlmRateLimitStateForTests(): void {
  const state = globalState();
  state.endpoints.clear();
  state.limiter = new LocalLlmConcurrencyLimiter(DEFAULT_MAX_CONCURRENCY);
}

export type RateLimitAttemptGate =
  | { kind: "go"; release: () => void }
  | { kind: "aborted" }
  | { kind: "skip"; reason: "backoff" | "queue"; remainingMs: number };

export type RateLimitDecision =
  | { kind: "not-rate-limited" }
  | { kind: "retry"; delayMs: number; hintMs: number | null; consecutive: number; retry: number }
  | { kind: "give-up"; delayMs: number; retries: number };

/**
 * Per-request driver for the rate-limit policy. The client calls
 * `beforeAttempt` ahead of every HTTP attempt (waits out the shared endpoint
 * deadline, then takes a concurrency slot) and `onResponse` after every
 * non-ok response.
 */
export class LocalLlmRateLimitSession {
  private retries = 0;
  private readonly limiter: LocalLlmConcurrencyLimiter;
  readonly settings: LocalLlmRateLimitSettings;

  /**
   * @param waitBudgetMs the caller's per-attempt time budget. Waiting for the
   * endpoint backoff or a concurrency slot never exceeds it, and a backoff
   * longer than it skips the request instead (fail open to the caller).
   */
  constructor(
    private readonly endpoint: string,
    settings: LocalLlmRateLimitSettings,
    private readonly highPriority: boolean,
    private readonly waitBudgetMs: number = settings.backoffMaxMs
  ) {
    this.settings = settings;
    this.limiter = getLocalLlmConcurrencyLimiter(settings.maxConcurrency);
  }

  get retryCount(): number {
    return this.retries;
  }

  async beforeAttempt(signal?: AbortSignal): Promise<RateLimitAttemptGate> {
    const deadlineMs = Date.now() + Math.max(0, this.waitBudgetMs);
    // Recheck the shared deadline after every async wait: another attempt may
    // have recorded or extended a cooldown while this one slept or queued.
    for (;;) {
      const remainingMs = endpointBackoffRemainingMs(this.endpoint);
      if (remainingMs > 0) {
        if (remainingMs > Math.min(this.settings.backoffMaxMs, deadlineMs - Date.now())) {
          return { kind: "skip", reason: "backoff", remainingMs };
        }
        if (!(await waitWithSignal(remainingMs, signal))) return { kind: "aborted" };
        continue;
      }
      const release = await this.limiter.acquire({
        highPriority: this.highPriority,
        signal,
        timeoutMs: deadlineMs - Date.now(),
      });
      if (!release) return signal?.aborted ? { kind: "aborted" } : { kind: "skip", reason: "queue", remainingMs: 0 };
      if (endpointBackoffRemainingMs(this.endpoint) > 0) {
        release();
        continue;
      }
      return { kind: "go", release };
    }
  }

  onSuccess(): void {
    noteEndpointRecovered(this.endpoint);
  }

  onResponse(status: number, retryAfterHeader: string | null | undefined, bodyText: string): RateLimitDecision {
    if (!isRateLimitedResponse(status, bodyText)) {
      noteEndpointRecovered(this.endpoint);
      return { kind: "not-rate-limited" };
    }
    const consecutive = noteEndpointRateLimited(this.endpoint);
    const hintMs = serverRetryHintMs(retryAfterHeader, bodyText);
    const delayMs = computeRateLimitDelayMs(consecutive, this.settings, hintMs);
    extendEndpointBackoff(this.endpoint, delayMs);
    if (this.retries >= this.settings.retryCount || delayMs > Math.min(this.settings.backoffMaxMs, this.waitBudgetMs)) {
      return { kind: "give-up", delayMs, retries: this.retries };
    }
    this.retries += 1;
    return { kind: "retry", delayMs, hintMs, consecutive, retry: this.retries };
  }
}

function waitWithSignal(ms: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve(false);
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
