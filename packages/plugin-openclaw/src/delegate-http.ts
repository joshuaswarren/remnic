/**
 * JSON transport for the delegate's daemon routes.
 *
 * Extracted from `delegate-runtime.ts` so both the runtime and the
 * flush-plan ingestion can reach it without importing each other, and so
 * the runtime stays under the new-file line ceiling (issue #1995).
 */

import {
  daemonUrl,
  type DaemonAuthToken,
  type DaemonAuthTokenSource,
  type DelegateDaemonTarget,
} from "./bridge.js";
import { reportDaemonAuthorizationFailure } from "./delegate-authorization.js";

export interface DelegateJsonResponse {
  status: number;
  body: Record<string, unknown> | null;
}

/** Parse a 2xx body, or `null` when it is not a JSON object. */
async function readJsonObject(res: Response): Promise<Record<string, unknown> | null> {
  const parsed: unknown = await res.json().catch(() => null);
  return typeof parsed === "object" && parsed !== null
    ? (parsed as Record<string, unknown>)
    : null;
}

/**
 * Report an authorization refusal once, then drain the body so the socket
 * is reusable.
 */
async function noteRefusal(
  res: Response,
  serviceId: string,
  pathname: string,
  source: DaemonAuthTokenSource,
): Promise<DelegateJsonResponse> {
  await res.body?.cancel();
  if (res.status === 401 || res.status === 403) {
    reportDaemonAuthorizationFailure(serviceId, pathname, res.status, source);
  }
  return { status: res.status, body: null };
}

/**
 * Retry one unauthorized request after resolving the credential again.
 *
 * OpenClaw can rotate a connector token while a session remains active. A
 * single retry lets a resolver that observed that rotation recover the
 * current request, including `TRIGGER_REAUTHENTICATION`, without re-registering
 * the session hooks. A network failure still rejects from `fetch`.
 */
async function fetchWithAuthRetry(
  target: DelegateDaemonTarget,
  pathname: string,
  timeoutMs: number,
  init: RequestInit = {},
): Promise<{ response: Response; auth: DaemonAuthToken }> {
  const request = async (auth: DaemonAuthToken): Promise<Response> => {
    const headers = new Headers(init.headers);
    if (auth.token) headers.set("Authorization", `Bearer ${auth.token}`);
    return fetch(daemonUrl(target, pathname), {
      ...init,
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
  };
  const auth = target.resolveAuthToken();
  const response = await request(auth);
  if (response.status !== 401) return { response, auth };

  await response.body?.cancel();
  target.invalidateAuthToken?.(auth);
  const refreshedAuth = target.resolveAuthToken();
  if (refreshedAuth.token === auth.token) return { response, auth };
  return { response: await request(refreshedAuth), auth: refreshedAuth };
}

/**
 * POST that reports the daemon's status instead of collapsing it.
 *
 * `postJson` below cannot tell a caller WHY a request failed: 401/403
 * become `null` and every other non-2xx throws. A client that adapts to the
 * daemon's body limit needs the difference, because halving the payload fixes
 * a 413 and does nothing for a refused credential (issue #2303). Transport
 * failures still reject — only HTTP responses are reported.
 */
export async function postJsonWithStatus(
  target: DelegateDaemonTarget,
  serviceId: string,
  pathname: string,
  body: Record<string, unknown>,
  timeoutMs: number,
): Promise<DelegateJsonResponse> {
  const { response: res, auth } = await fetchWithAuthRetry(target, pathname, timeoutMs, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) return noteRefusal(res, serviceId, pathname, auth.source);
  return { status: res.status, body: await readJsonObject(res) };
}


/**
 * Legacy contract kept for every existing delegate route: `null` on an
 * authorization refusal, a throw on any other non-2xx.
 */
export async function postJson(
  target: DelegateDaemonTarget,
  serviceId: string,
  pathname: string,
  body: Record<string, unknown>,
  timeoutMs: number,
): Promise<Record<string, unknown> | null> {
  const response = await postJsonWithStatus(target, serviceId, pathname, body, timeoutMs);
  if (response.status === 401 || response.status === 403) return null;
  if (response.status < 200 || response.status > 299) {
    throw new Error(`daemon ${pathname} responded ${response.status}`);
  }
  return response.body;
}
export async function getJson(
  target: DelegateDaemonTarget,
  serviceId: string,
  pathname: string,
  timeoutMs: number,
): Promise<DelegateJsonResponse> {
  const { response: res, auth } = await fetchWithAuthRetry(target, pathname, timeoutMs);
  if (!res.ok) return noteRefusal(res, serviceId, pathname, auth.source);
  return { status: res.status, body: await readJsonObject(res) };
}
