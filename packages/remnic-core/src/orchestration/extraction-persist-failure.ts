import { log } from "../logger.js";

type FinalizeCommittedWrites = (scheduleQmd: boolean) => Promise<void>;

/**
 * Fail a persistence pass after a durable write rejected (#3227, same
 * contract as the entity write path from #3228). Earlier writes in the batch
 * are already committed, so their batch-end effects are finalized first; the
 * original error is then rethrown so the run leaves its input retryable
 * instead of recording the fingerprint and clearing the source turns.
 */
export async function rethrowAfterCommittedWriteFinalization(
  finalizeCommittedWrites: FinalizeCommittedWrites,
  cause: unknown,
  outputKind: string,
): Promise<never> {
  await finalizeCommittedWrites(true).catch((finalizeErr) =>
    log.warn(`committed-write finalization after ${outputKind} failure failed: ${finalizeErr}`),
  );
  throw cause;
}

/**
 * Batch-end finalization for one persistExtraction pass (#3288).
 *
 * `bind` wraps the pass's finalizer so it runs at most once. The success
 * tail, the per-branch catch sites and the pass boundary can all reach it,
 * and a second run would append the same behavior signals again.
 *
 * `run` is the pass boundary. A throw from a branch with no catch site of its
 * own (a chunked-parent post-write step, the semantic-merge post effects, the
 * profile or question write) still finalizes the writes already committed
 * before the original error propagates. When a catch site or the success tail
 * already ran the finalizer, the boundary only rethrows. Nothing is durable
 * before the finalizer is bound, so an earlier throw propagates as is.
 */
export class CommittedWriteFinalization {
  private finalizer: FinalizeCommittedWrites | undefined;
  private started: Promise<void> | undefined;

  bind(finalize: FinalizeCommittedWrites): FinalizeCommittedWrites {
    this.finalizer = (scheduleQmd) => (this.started ??= finalize(scheduleQmd));
    return this.finalizer;
  }

  async run<T>(pass: () => Promise<T>): Promise<T> {
    try {
      return await pass();
    } catch (err) {
      if (!this.finalizer || this.started) throw err;
      return rethrowAfterCommittedWriteFinalization(this.finalizer, err, "persist pass");
    }
  }
}

/** A pass method's parameter list without its leading CommittedWriteFinalization. */
export type ArgsAfterFinalization<Params> = Params extends [CommittedWriteFinalization, ...infer Rest] ? Rest : never;
