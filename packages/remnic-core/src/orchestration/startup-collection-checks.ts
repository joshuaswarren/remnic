import { log } from "../logger.js";
import {
  qmdStartupCollectionCheckTimeoutMs,
  type SearchCollectionState,
} from "./orchestrator-helpers.js";

export interface QmdStartupCollectionCheckResult {
  namespace: string;
  state: SearchCollectionState;
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
  const fallback = namespaces.map((namespace) => ({ namespace, state: "unknown" as const }));
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<QmdStartupCollectionCheckResult[]>((resolve) => {
    timer = setTimeout(() => {
      log.warn(
        `QMD startup collection check batch timed out after ${timeoutMs}ms; keeping search enabled fail-open`,
      );
      resolve(fallback);
    }, timeoutMs);
  });
  try {
    return await Promise.race([Promise.all(checks), timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
