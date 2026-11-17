/**
 * The force-flush preemption callback factory.
 *
 * `extractionQueueCoordinator.preemptRunning(preferredKey?)` prefers a
 * key-matched armed slot and only falls back to the newest armed slot when no
 * key is given. The write surface called it with no key, so every force-flush
 * aborted whichever background task armed last — typically the backlog
 * scheduler's buffer drain — instead of the caller's own queued extraction
 * (observed 2026-11-17 as repeated `extraction preempted for force-flush`
 * failures on unrelated backlog sessions while the caller's session stayed
 * blocked). Forwarding the caller's session key scopes the preemption to the
 * slot the force-flush is actually waiting on.
 */
export function forceFlushPreemptCallback(
  sessionKey: string | undefined,
  coordinator: { preemptRunning?: (preferredKey?: string) => void } | undefined,
): () => void {
  return () => {
    coordinator?.preemptRunning?.(sessionKey);
  };
}
