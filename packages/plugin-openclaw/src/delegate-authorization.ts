/**
 * Daemon authorization probing for the delegate runtime.
 *
 * `GET /engram/v1/authorization` is the daemon's own namespace-aware answer to
 * "may this token do X here?". It backs both the registration preflight and
 * the per-operation check that stops a substituted default namespace from
 * 403-ing on its first use. Split from delegate-runtime.ts so that file stays
 * under its size cap.
 */

import { log } from "@remnic/core/logger";

import { daemonUrl, type DaemonAuthToken, type DelegateDaemonTarget } from "./bridge.js";

export const DEFAULT_DELEGATE_AUTHORIZATION_OPERATIONS = [
  "recall",
  "observe",
  "lcm_compaction_flush",
  // The daemon-backed memory-slot capability searches through
  // /engram/v1/memories/search, which enforces its own `memory_search`
  // operation. Omitting it here would let the preflight report a
  // least-privilege token authorized while every capability search 403s.
  "memory_search",
] as const;

export type DelegateAuthorizationOperation =
  (typeof DEFAULT_DELEGATE_AUTHORIZATION_OPERATIONS)[number];

export interface DelegateAuthorizationPreflight {
  readonly state: "authorized" | "unauthorized" | "unavailable";
  readonly tokenSource: DaemonAuthToken["source"];
  readonly status?: 401 | 403;
}

const daemonAuthFailureLogKeys = new Set<string>();

export function reportDaemonAuthorizationFailure(
  serviceId: string,
  pathname: string,
  status: 401 | 403,
  tokenSource: DaemonAuthToken["source"],
): void {
  const key = `${serviceId}:${pathname}:${status}:${tokenSource}`;
  if (daemonAuthFailureLogKeys.has(key)) return;
  daemonAuthFailureLogKeys.add(key);
  log.error(
    `delegate ${pathname} authorization failed (${status}; token source: ${tokenSource})`,
  );
}

const AUTHORIZATION_PROBE_TIMEOUT_MS = 2_000;

export async function probeDelegateAuthorization(
  target: DelegateDaemonTarget,
  namespace = "",
  operations: readonly DelegateAuthorizationOperation[] = DEFAULT_DELEGATE_AUTHORIZATION_OPERATIONS,
  /** Cap from a caller's shared deadline; the default is this probe's own. */
  timeoutMs?: number,
): Promise<DelegateAuthorizationPreflight> {
  const auth = target.resolveAuthToken();
  const headers = auth.token ? { Authorization: `Bearer ${auth.token}` } : undefined;
  const query = new URLSearchParams();
  for (const operation of operations) query.append("op", operation);
  query.set("namespace", namespace);
  try {
    const response = await fetch(daemonUrl(target, `/engram/v1/authorization?${query}`), {
      headers,
      signal: AbortSignal.timeout(
        timeoutMs === undefined ? AUTHORIZATION_PROBE_TIMEOUT_MS : Math.min(AUTHORIZATION_PROBE_TIMEOUT_MS, timeoutMs),
      ),
    });
    await response.body?.cancel();
    if (response.status === 200) {
      return { state: "authorized", tokenSource: auth.source };
    }
    if (response.status === 401 || response.status === 403) {
      return { state: "unauthorized", status: response.status, tokenSource: auth.source };
    }
  } catch {
    return { state: "unavailable", tokenSource: auth.source };
  }
  return { state: "unavailable", tokenSource: auth.source };
}
