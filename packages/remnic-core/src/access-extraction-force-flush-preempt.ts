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
