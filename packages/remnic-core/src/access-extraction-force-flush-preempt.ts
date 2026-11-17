/**
 * The force-flush preemption callback factory.
 *
 * A keyed force-flush must abort ONLY the armed slot matching the caller's
 * session (`coordinator.preemptKeyed`) - `preemptRunning(preferredKey?)`
 * falls back to the newest armed slot whenever no key-matched slot is armed,
 * which killed unrelated background drains exactly when the caller's own
 * extraction was not yet armed (the failure PR #3468 reports). The keyless
 * call keeps `preemptRunning`'s newest-slot fallback, which the front-enqueue
 * flush path relies on.
 */
import { extractionForceFlush } from "./access-extraction-force-flush.js";
import type { AccessObserveWriteSurfaceDeps } from "./access-observe-write-surface.js";
import { PendingObserveExtractionTracker } from "./access-observe-helpers.js";
import type { EngramAccessExtractionForceFlushRequest, EngramAccessExtractionForceFlushResponse } from "./access-service.js";

export function forceFlushPreemptCallback(
  sessionKey: string | undefined,
  coordinator:
    | {
        preemptRunning?: (preferredKey?: string) => void;
        preemptKeyed?: (key: string) => void;
      }
    | undefined,
): () => void {
  return () => {
    if (sessionKey !== undefined) {
      coordinator?.preemptKeyed?.(sessionKey);
      return;
    }
    coordinator?.preemptRunning?.();
  };
}

/** The force-flush call with the keyed preemption callback attached, so the
 *  write surface stays under the file-size ratchet (issue #1995). */
export function forceFlushPreemptCall(
  deps: AccessObserveWriteSurfaceDeps,
  request: EngramAccessExtractionForceFlushRequest,
  pending: PendingObserveExtractionTracker,
): Promise<EngramAccessExtractionForceFlushResponse> {
  return extractionForceFlush(
    deps,
    request,
    (sessionKey, principal, namespace, abortSignal, registerCancellation, scopeHint) =>
      pending.wait(
        sessionKey,
        principal,
        namespace,
        abortSignal,
        registerCancellation,
        scopeHint,
        forceFlushPreemptCallback(sessionKey, deps.orchestrator.extractionQueueCoordinator),
      ),
  );
}
