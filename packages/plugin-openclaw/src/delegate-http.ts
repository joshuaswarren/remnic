
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

async function readJsonObject(res: Response): Promise<Record<string, unknown> | null> {
  const parsed: unknown = await res.json().catch(() => null);
  return typeof parsed === "object" && parsed !== null
    ? (parsed as Record<string, unknown>)
    : null;
}

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

async function fetchWithAuthRetry(
  target: DelegateDaemonTarget,
  pathname: string,
  timeoutMs: number,
  init: RequestInit = {},
): Promise<{ response: Response; auth: DaemonAuthToken }> {
  const deadline = Date.now() + timeoutMs;
  const request = async (auth: DaemonAuthToken): Promise<Response> => {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw new Error("daemon request deadline exceeded");
    const headers = new Headers(init.headers);
    if (auth.token) headers.set("Authorization", `Bearer ${auth.token}`);
    return fetch(daemonUrl(target, pathname), {
      ...init,
      headers,
      signal: AbortSignal.timeout(remainingMs),
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
