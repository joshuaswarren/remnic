/**
 * Extraction gate for sessions claimed by `remnic buffer drain`.
 *
 * A claimed session's turns belong to the drain: they live in a durable
 * claim file and are extracted out of process. The live buffer owner hands
 * its copy of such a session into the claim instead of writing it back, so
 * extracting it here as well would persist the same content twice.
 */

import { log } from "../logger.js";
import type { ExtractionRunResult } from "./extraction-run.js";

/** The claim check a buffer owner exposes. */
export interface ClaimAwareBuffer {
  isSessionClaimed(key: string): boolean;
}

/**
 * Settle the extraction as skipped when `bufferKey` is claimed by a drain.
 * Returns true when the caller must stop (the window stays in the claim).
 */
export function skipClaimedSession(
  buffer: ClaimAwareBuffer,
  bufferKey: string,
  settle: (result: ExtractionRunResult) => void,
): boolean {
  if (!buffer.isSessionClaimed(bufferKey)) return false;
  log.debug(`extraction skip: session claimed by buffer drain (${bufferKey})`);
  settle({
    status: "skipped",
    reason: "claimed_by_buffer_drain",
    persistedCount: 0,
    durableOutputCount: 0,
  });
  return true;
}
