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
