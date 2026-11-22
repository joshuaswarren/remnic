
import { log } from "../logger.js";
import type { ExtractionRunResult } from "./extraction-run.js";

/** The claim check a buffer owner exposes. Optional: buffers without a claim
 * registry (older hosts, test doubles) simply never report a claim. */
export interface ClaimAwareBuffer {
  isSessionClaimed?(key: string): boolean;
}

/**
 * Settle the extraction as skipped when `bufferKey` is claimed by a drain.
 * Returns true when the caller must stop (the window stays in the claim).
 * A missing buffer (deps without one) is never claimed.
 */
export function skipClaimedSession(
  buffer: ClaimAwareBuffer | undefined,
  bufferKey: string,
  settle: (result: ExtractionRunResult) => void,
): boolean {
  if (!buffer?.isSessionClaimed?.(bufferKey)) return false;
  log.debug(`extraction skip: session claimed by buffer drain (${bufferKey})`);
  settle({
    status: "skipped",
    reason: "claimed_by_buffer_drain",
    persistedCount: 0,
    durableOutputCount: 0,
  });
  return true;
}
