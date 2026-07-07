/**
 * Shared infrastructure for third-party MemCorrect adapters (issue #1727).
 *
 * Each third-party memory system (Mem0, Zep, Letta) gets a MemCorrectSystemAdapter
 * implementation that talks to its public HTTP API. These adapters exist so the
 * paper can substantiate head-to-head claims: without them, "we beat X" is
 * unsubstantiable.
 *
 * Design constraints (from the issue):
 *
 *   1. **No keys in CI.** Adapters require operator-provided credentials
 *      (API key + endpoint) to run. Without them, every method throws
 *      `MissingCredentialError` — which the bench harness treats as a
 *      skip-with-reason, not a test failure. No network calls happen in CI.
 *
 *   2. **Injectable transport.** Each adapter accepts a `fetch` override so the
 *      deterministic fixture smoke test can drive the full request/response
 *      cycle without touching the network. The production path uses the global
 *      `fetch`.
 *
 *   3. **Faithful to each system's normal path.** The adapter calls the same
 *      public endpoints an integrator would use in production. Reaching into
 *      internals would make the comparison meaningless (the issue's hard
 *      constraint, inherited from #1584).
 */

import type { MemCorrectSystemAdapter } from "../types.js";

/** Injectable fetch — matches the global `fetch` signature. */
export type FetchLike = typeof fetch;

/** Common configuration every third-party adapter accepts. */
export interface ThirdPartyAdapterConfig {
  /** Auth token / API key. Required to actually run (operator-provided). */
  apiKey?: string;
  /** Base URL of the deployment. Required for self-hosted; optional for hosted. */
  baseUrl?: string;
  /** Injectable fetch for deterministic testing. Defaults to global `fetch`. */
  fetch?: FetchLike;
  /** Per-request timeout in milliseconds. */
  timeoutMs?: number;
}

/**
 * Thrown when an adapter is asked to run without the operator-provided
 * credentials it needs. The bench harness treats this as a skip-with-reason,
 * not a failure — no third-party system is reachable in CI.
 */
export class MissingCredentialError extends Error {
  readonly reason: string;
  constructor(system: string, missing: string[]) {
    const reason =
      `${system} MemCorrect adapter is not runnable: missing ${missing.join(", ")}. ` +
      `Provide the required credentials (env vars or config) to exercise this adapter; ` +
      `skipped — no keys in CI.`;
    super(reason);
    this.name = "MissingCredentialError";
    this.reason = reason;
  }
}

/**
 * Throw `MissingCredentialError` if any required credential field names are
 * listed as missing. Adapters compute the missing list (checking their own
 * config fields) and pass it here for the descriptive error.
 */
export function requireCredentials(system: string, missing: string[]): void {
  if (missing.length > 0) {
    throw new MissingCredentialError(system, missing);
  }
}

/** Resolve the fetch implementation: explicit override → global fetch. */
export function resolveFetch(override?: FetchLike): FetchLike {
  if (override) return override;
  if (typeof fetch === "function") return fetch;
  throw new Error(
    "No fetch implementation available. Provide `fetch` in the adapter config " +
      "or run in a runtime with a global fetch (Node 18+).",
  );
}

/**
 * JSON POST helper with a per-request timeout. Uses `Promise.withResolvers`
 * for the timeout race so control flow stays linear. Throws a typed
 * `HttpError` on non-2xx so adapters can surface server-side failure context.
 */
export async function httpJson(
  fetchImpl: FetchLike,
  method: string,
  url: string,
  options: {
    headers?: Record<string, string>;
    body?: unknown;
    timeoutMs?: number;
  } = {},
): Promise<unknown> {
  const { headers = {}, body, timeoutMs } = options;
  const controller = new AbortController();
  const { promise: timeoutPromise, resolve: resolveTimeout } =
    Promise.withResolvers<void>();
  const timer =
    timeoutMs !== undefined
      ? setTimeout(() => resolveTimeout(), timeoutMs)
      : undefined;
  if (timer) timer.unref?.();

  const fetchPromise = fetchImpl(url, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: controller.signal,
  });
  // Swallow the eventual AbortError rejection after timeout so it does not
  // surface as an unhandled promise rejection. The timeout path throws a
  // clean Error instead.
  fetchPromise.catch(() => {});

  let response: Response;
  try {
    if (timer) {
      // Race the fetch against the timeout. On timeout, abort the controller
      // so the in-flight request is cleaned up rather than orphaned.
      const winner = await Promise.race([
        fetchPromise.then((r) => r as Response),
        timeoutPromise.then(() => "timeout" as const),
      ]);
      if (winner === "timeout") {
        controller.abort();
        throw new Error(`Request timed out after ${timeoutMs}ms: ${method} ${url}`);
      }
      response = winner;
    } else {
      response = await fetchPromise;
    }
  } finally {
    if (timer) clearTimeout(timer);
  }

  // 204 No Content → return null (common for DELETE endpoints).
  if (response.status === 204) return null;

  const text = await response.text();
  if (!response.ok) {
    const excerpt = text.length > 500 ? `${text.slice(0, 500)}…` : text;
    throw new HttpError(method, url, response.status, excerpt);
  }

  if (text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Non-2xx HTTP error with the server response body excerpt for context. */
export class HttpError extends Error {
  readonly status: number;
  readonly method: string;
  readonly url: string;
  readonly bodyExcerpt: string;
  constructor(
    method: string,
    url: string,
    status: number,
    bodyExcerpt: string,
  ) {
    super(`HTTP ${status} from ${method} ${url}: ${bodyExcerpt}`);
    this.name = "HttpError";
    this.method = method;
    this.url = url;
    this.status = status;
    this.bodyExcerpt = bodyExcerpt;
  }
}

/**
 * Await `ms` milliseconds. Used by hosted-mode adapters that poll an async
 * event endpoint until processing completes. Uses `Promise.withResolvers`
 * for linear control flow.
 */
export function delay(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(() => resolve(), ms);
  return promise;
}

/** Re-export the adapter contract for implementers in this directory. */
export type { MemCorrectSystemAdapter };
