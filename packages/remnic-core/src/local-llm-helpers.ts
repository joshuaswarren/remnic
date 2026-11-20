import type { ResponseFormatJSONSchema } from "openai/resources/shared";
import type { Agent } from "undici";
import { log } from "./logger.js";
import { directProbeDispatcher } from "./local-llm-transport.js";
import type { LocalLlmRequestPriority } from "./local-llm.js";

export interface LocalLlmChatCompletionOptions {
  temperature?: number;
  maxTokens?: number;
  responseFormat?: { type: string } | ResponseFormatJSONSchema;
  timeoutMs?: number;
  operation?: string;
  forceDisableThinking?: boolean;
  disableThinking?: boolean;
  priority?: LocalLlmRequestPriority;
  signal?: AbortSignal;
  redactProviderErrors?: boolean;
  /** Per-request model; defaults to config.localLlmModel. */
  model?: string;
  /**
   * Optional out-box for the terminal failure cause (issue #2891): on a
   * failed request the client records the last provider error here so
   * callers can classify it (e.g. HTTP 429 → rate-limited) in memory
   * instead of seeing only null. Never logged.
   */
  failureDiag?: { lastError?: unknown; finishReason?: string };
}

export interface LocalLlmChatCompletionResult {
  content: string;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
}
export function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const maybe = err as { name?: string; message?: string };
  return (
    maybe.name === "AbortError" ||
    maybe.message === "This operation was aborted" ||
    maybe.message === "The operation was aborted"
  );
}

/** Caller signal combined with a client-wide shutdown signal, so a daemon
 *  stop aborts in-flight requests and retry loops at once — even for
 *  callers that pass no signal of their own. */
export function combineClientAbortSignals(
  caller: AbortSignal | undefined,
  shutdown: AbortSignal | undefined,
): AbortSignal | undefined {
  if (shutdown === undefined) return caller;
  if (caller === undefined) return shutdown;
  return AbortSignal.any([caller, shutdown]);
}

export function waitForRetryBackoff(backoffMs: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(false);
    };
    const onTimer = (): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      resolve(true);
    };
    timer = setTimeout(onTimer, backoffMs);
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

export function normalizeBackendTripReason(reason: string): string {
  const cleaned = reason.replace(/\s+/g, " ").replace(/^[-:–—\s]+/, "").trim();
  if (!cleaned) return "unknown local backend failure";
  return cleaned.length > 160 ? `${cleaned.slice(0, 157)}...` : cleaned;
}

export function extractNonRecoverableBackendReason(reason: string): string | null {
  const match = reason.match(
    /Failed to load model|Library not loaded|different Team IDs|code signature|llm_engine_mlx_amphibian/i,
  );
  return match?.[0] ?? null;
}

export function extractNonRecoverableBackendReasonFromErrorText(errorText: string): string | null {
  const directReason = extractNonRecoverableBackendReason(errorText);
  if (directReason) return directReason;
  try {
    const parsed = JSON.parse(errorText) as { error?: { message?: string } };
    return extractNonRecoverableBackendReason(parsed?.error?.message ?? "");
  } catch {
    return null;
  }
}

/**
 * Flatten a fetch rejection into one line, including the `cause` undici hides
 * the real reason behind (`fetch failed` alone says nothing).
 */
export function describeFetchFailure(err: unknown): string {
  const name = err instanceof Error ? err.name : "";
  const message = err instanceof Error ? err.message : String(err);
  const cause: unknown = err instanceof Error ? (err as Error & { cause?: unknown }).cause : undefined;
  const causeText = cause instanceof Error
    ? ` (cause: ${cause.name}: ${cause.message}${
      typeof (cause as Error & { code?: unknown }).code === "string"
        ? ` [${String((cause as Error & { code?: unknown }).code)}]`
        : ""
    })`
    : cause === undefined
      ? ""
      : ` (cause: ${String(cause)})`;
  return `${name ? `${name}: ` : ""}${message}${causeText}`;
}

/**
 * What to record when every availability probe failed.
 *
 * A probe that TIMED OUT is not evidence the backend is down: the budget is a
 * fixed 2s and a busy event loop can burn it before the socket is scheduled,
 * so the backend looks dead while it answers other callers in single-digit ms.
 * Caching that verdict took extraction offline for a whole health-check
 * interval at a time (issue #2210), so a timeout leaves availability UNKNOWN —
 * this call fails, the next one re-probes instead of reading a stale false.
 *
 * A backend that ANSWERED and said no is a real verdict and stays cached, or
 * the daemon re-probes a known-bad endpoint on every request.
 */
export function resolveUnavailableVerdict(args: {
  baseUrl: string;
  sawAbortedProbe: boolean;
  wasAvailable: boolean | null;
}): { cacheVerdict: boolean; warning: string | null } {
  if (args.sawAbortedProbe) {
    return {
      cacheVerdict: false,
      warning:
        `local LLM availability probe timed out at ${args.baseUrl} (event loop busy?); treating availability as ` +
        "unknown and re-probing on the next request rather than marking the backend down",
    };
  }
  return {
    cacheVerdict: true,
    // Surfaced at warn, not debug: extraction stops silently when this flips,
    // and the daemon emits no debug at all unless configured for it.
    warning: args.wasAvailable !== false ? `local LLM became unavailable at ${args.baseUrl}` : null,
  };
}

export interface ProbeFetchResult {
  ok: boolean;
  data: unknown;
  status: number | null;
  /** The probe hit its own budget rather than getting an answer. */
  aborted?: boolean;
}

/**
 * One health-probe request.
 *
 * Every failure is logged with its cause: a transport error and a 404 both
 * returned `ok: false` with nothing recorded, so an unreachable backend was
 * indistinguishable from a wrong path and an availability failure had no
 * diagnosable reason at all (§22, issue #2210).
 */
export async function probeFetch(
  url: string,
  options: { timeoutMs: number; headers: Record<string, string>; signal?: AbortSignal },
): Promise<ProbeFetchResult> {
  const controller = new AbortController();
  const requestSignal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const init: RequestInit & { dispatcher?: Agent } = { signal: requestSignal, headers: options.headers };
    const dispatcher = directProbeDispatcher();
    if (dispatcher) init.dispatcher = dispatcher;
    const response = await fetch(url, init);
    clearTimeout(timeout);
    if (!response.ok) {
      log.debug(`local LLM probe: ${url} returned HTTP ${response.status}`);
      return { ok: false, data: null, status: response.status };
    }
    const contentType = response.headers.get("content-type");
    const data = contentType?.includes("application/json") ? await response.json() : await response.text();
    return { ok: true, data, status: response.status };
  } catch (err) {
    clearTimeout(timeout);
    const aborted = isAbortError(err);
    log.debug(
      `local LLM probe: ${url} ${aborted ? `timed out after ${options.timeoutMs}ms` : "failed"}: ${describeFetchFailure(err)}`,
    );
    return { ok: false, data: null, status: null, aborted };
  }
}

interface PendingProbe {
  promise: Promise<boolean>;
  controller: AbortController;
  /** Callers still awaiting this sequence; at zero the sequence is aborted. */
  waiters: number;
}

/**
 * Collapses concurrent probe sequences onto one in-flight run.
 *
 * A timed-out availability probe deliberately caches nothing (issue #2210),
 * which removed the false verdict that used to absorb concurrent callers:
 * every queued request would then run its own full probe sequence, on a host
 * already slow enough to blow the probe budget.
 *
 * Cancellation is refcounted rather than shared: one caller walking away must
 * not abort a sequence the others are still waiting on, so the underlying task
 * is aborted only once every waiter has gone.
 */
export class SingleFlightProbe {
  private pending: PendingProbe | null = null;

  run(task: (signal: AbortSignal) => Promise<boolean>, signal?: AbortSignal): Promise<boolean> {
    let active = this.pending;
    if (!active) {
      const controller = new AbortController();
      const created: PendingProbe = { promise: Promise.resolve(false), controller, waiters: 0 };
      created.promise = task(controller.signal).finally(() => {
        if (this.pending === created) this.pending = null;
      });
      this.pending = created;
      active = created;
    }
    const entry = active;
    entry.waiters += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      entry.waiters -= 1;
      if (entry.waiters > 0) return;
      // Detach BEFORE aborting. `pending` would otherwise still point at this
      // doomed entry until the task's own `finally` runs a microtask later, and
      // a caller arriving in that window would join an aborted sequence and
      // read its `false` as a verdict.
      if (this.pending === entry) this.pending = null;
      entry.controller.abort();
    };
    if (!signal) return entry.promise.finally(release);
    return new Promise<boolean>((resolve, reject) => {
      const onAbort = () => {
        release();
        resolve(false);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      entry.promise.then(
        (value) => {
          signal.removeEventListener("abort", onAbort);
          release();
          resolve(value);
        },
        (err: unknown) => {
          signal.removeEventListener("abort", onAbort);
          release();
          reject(err instanceof Error ? err : new Error(String(err)));
        },
      );
    });
  }
}

/** True when `value` is safe for `fetch` request headers (HTTP token / field value). */
export function isHttpHeaderFieldValue(value: string): boolean {
  if (!value) return false;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

function trimTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url.charCodeAt(end - 1) === 47) end -= 1;
  return end === url.length ? url : url.slice(0, end);
}

/** Circuit-breaker and rate-limit scope when recall/extraction share one proxy URL. */
export function formatLocalLlmPoolKey(chatUrl: string, operation: string): string {
  let normalized = chatUrl.replace("localhost", "127.0.0.1");
  normalized = trimTrailingSlashes(normalized);
  if (normalized.endsWith("/v1")) {
    normalized = normalized.slice(0, -3);
  }
  const completions = normalized.endsWith("/chat/completions")
    ? normalized
    : `${normalized}/v1/chat/completions`;
  return `${completions}|op=${operation}`;
}

/** HTTP headers the jarvis-ml recall proxy reads for pool routing. */
export function buildLocalLlmRoutingHeaders(
  operation: string,
  priority: "recall-critical" | "background" | undefined,
): Record<string, string> {
  const routingEntries: Array<readonly [string, string]> = [
    ["Content-Type", "application/json"],
  ];
  if (operation !== "unspecified" && isHttpHeaderFieldValue(operation)) {
    routingEntries.push(["X-Remnic-Operation", operation]);
  }
  if (priority) {
    routingEntries.push(["X-Remnic-Priority", priority]);
  }
  return Object.fromEntries(routingEntries) satisfies Record<string, string>;
}

const LOCAL_LLM_GLOBAL_BACKEND_STATE = "__openclawEngramLocalLlmBackendState";

export type LocalLlmBackendPoolState = {
  untilMs: number;
  reason: string;
  /** Once the trip lapses this is set instead of deleting the entry: every
   * client must observe the transition once, so a tombstone stays visible for
   * BACKEND_POOL_TOMBSTONE_MS. */
  expiredAtMs?: number;
};

/** How long a lapsed circuit stays readable so each client can invalidate its
 * cached health verdict once (the health cache is 60s; this leaves margin). */
const BACKEND_POOL_TOMBSTONE_MS = 15 * 60_000;

function localLlmBackendPoolMap(): Map<string, LocalLlmBackendPoolState> {
  // SAFETY: globalThis carries one optional Map slot keyed for backend pool state.
  const globalAny = globalThis as typeof globalThis & {
    [LOCAL_LLM_GLOBAL_BACKEND_STATE]?: Map<string, LocalLlmBackendPoolState>;
  };
  const existing = globalAny[LOCAL_LLM_GLOBAL_BACKEND_STATE];
  if (existing) return existing;
  const created = new Map<string, LocalLlmBackendPoolState>();
  globalAny[LOCAL_LLM_GLOBAL_BACKEND_STATE] = created;
  return created;
}

export function getLocalLlmTrippedBackendPoolState(
  now: number,
  chatUrl: string,
  operation: string,
): LocalLlmBackendPoolState | null {
  const key = formatLocalLlmPoolKey(chatUrl, operation);
  const map = localLlmBackendPoolMap();
  const state = map.get(key) ?? null;
  if (!state) return null;
  if (state.untilMs <= now) {
    state.expiredAtMs ??= state.untilMs;
    if (state.expiredAtMs + BACKEND_POOL_TOMBSTONE_MS <= now) map.delete(key);
    return null;
  }
  return state;
}

/** The instant this pool's circuit lapsed, or null while it is active or
 * absent. The tombstone stays in the map so every client holding a cached
 * health verdict can observe the transition once — deleting on first read left
 * later clients stale (wAN review on #3474). */
export function localLlmBackendPoolExpiredAtMs(now: number, chatUrl: string, operation: string): number | null {
  const key = formatLocalLlmPoolKey(chatUrl, operation);
  const state = localLlmBackendPoolMap().get(key) ?? null;
  if (state && state.untilMs <= now) {
    state.expiredAtMs ??= state.untilMs;
    return state.expiredAtMs;
  }
  return null;
}

export function markLocalLlmBackendPoolUnavailable(
  reason: string,
  durationMs: number,
  chatUrl: string,
  operation: string,
): void {
  const normalizedReason = normalizeBackendTripReason(reason);
  const key = formatLocalLlmPoolKey(chatUrl, operation);
  if (durationMs > 0) {
    localLlmBackendPoolMap().set(key, { untilMs: Date.now() + durationMs, reason: normalizedReason });
  } else {
    localLlmBackendPoolMap().delete(key);
  }
}
