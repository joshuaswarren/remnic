import { log } from "../logger.js";

/**
 * Fail a persistence pass after a durable write rejected (#3227, same
 * contract as the entity write path from #3228). Earlier writes in the batch
 * are already committed, so their batch-end effects are finalized first; the
 * original error is then rethrown so the run leaves its input retryable
 * instead of recording the fingerprint and clearing the source turns.
 */
export async function rethrowAfterCommittedWriteFinalization(
  finalizeCommittedWrites: (scheduleQmd: boolean) => Promise<void>,
  cause: unknown,
  outputKind: string,
): Promise<never> {
  await finalizeCommittedWrites(true).catch((finalizeErr) =>
    log.warn(`committed-write finalization after ${outputKind} failure failed: ${finalizeErr}`),
  );
  throw cause;
}
