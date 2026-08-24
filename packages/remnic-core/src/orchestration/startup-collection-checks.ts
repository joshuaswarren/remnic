import { log } from "../logger.js";
import {
  qmdStartupCollectionCheckTimeoutMs,
  type SearchCollectionState,
} from "./orchestrator-helpers.js";

export interface QmdStartupCollectionCheckResult {
  namespace: string;
  state: SearchCollectionState;
}

export interface StartupDiscovery<T> {
  value: T;
  complete: boolean;
}

/**
 * Bound any startup discovery that must not hold a readiness gate forever.
 * Discovery APIs such as the namespace catalog do not accept an AbortSignal,
 * so a late result is deliberately ignored after the configured fallback wins.
 */
export async function startupDiscoveryWithTimeout<T>(
  discover: () => Promise<T>,
  configuredFallback: T,
  timeoutMs = qmdStartupCollectionCheckTimeoutMs(),
): Promise<StartupDiscovery<T>> {
  let timer: NodeJS.Timeout | undefined;
  const fallback: StartupDiscovery<T> = {
    value: configuredFallback,
    complete: false,
  };
  const timeoutPromise = new Promise<StartupDiscovery<T>>((resolve) => {
    timer = setTimeout(() => {
      log.warn(
        `startup discovery timed out after ${timeoutMs}ms; using configured fallback fail-open`,
      );
      resolve(fallback);
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      Promise.resolve()
        .then(discover)
        .then((value) => ({ value, complete: true })),
      timeoutPromise,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Bound the complete startup collection-check batch, not just each individual
 * check. This preserves service availability when a backend ignores an abort
 * signal or a check promise never settles: startup continues with fail-open
 * `unknown` states and the normal background retry path can repair search.
 */
export async function qmdStartupCollectionChecksWithTimeout(
  checks: readonly Promise<QmdStartupCollectionCheckResult>[],
  namespaces: readonly string[],
  timeoutMs = qmdStartupCollectionCheckTimeoutMs() + 1_000,
): Promise<QmdStartupCollectionCheckResult[]> {
  if (checks.length === 0) return [];
  const settled = new Map<string, QmdStartupCollectionCheckResult>();
  const trackedChecks = checks.map((check) => check.then((result) => {
    settled.set(result.namespace, result);
    return result;
  }));
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<QmdStartupCollectionCheckResult[]>((resolve) => {
    timer = setTimeout(() => {
      log.warn(
        `QMD startup collection check batch timed out after ${timeoutMs}ms; keeping search enabled fail-open`,
      );
      resolve(namespaces.map((namespace) =>
        settled.get(namespace) ?? { namespace, state: "unknown" as const },
      ));
    }, timeoutMs);
  });
  try {
    return await Promise.race([Promise.all(trackedChecks), timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
