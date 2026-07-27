import { log } from "./logger.js";
export function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const maybe = err as { name?: string; message?: string };
  return (
    maybe.name === "AbortError" ||
    maybe.message === "This operation was aborted" ||
    maybe.message === "The operation was aborted"
  );
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
    const response = await fetch(url, { signal: requestSignal, headers: options.headers });
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
