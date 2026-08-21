/**
 * Cancellation checkpoints for entity recall (issue #2291).
 *
 * Entity recall reads every entity and memory file for the recalled namespaces and
 * then makes several synchronous passes over the result. Both halves need the same
 * two things at every boundary, in the same shape, with the same abort message —
 * so they live here rather than being restated at each of a dozen call sites.
 */

import { throwIfAborted } from "./abort-error.js";
import { yieldToEventLoop } from "./recall-qos.js";

const ABORT_MESSAGE = "entity recall aborted";

/**
 * Entities/memories processed between two yields during an index build. Matches
 * the artifact scan's interval: large enough that the yields are free relative to
 * the work, small enough that a section deadline is observed promptly.
 */
export const ENTITY_SCAN_YIELD_INTERVAL = 256;

/** Stop at the caller's signal without yielding. */
export function checkEntityRecallAbort(abortSignal?: AbortSignal): void {
  throwIfAborted(abortSignal, ABORT_MESSAGE);
}

/**
 * Hand the loop a macrotask, then stop if the caller gave up while it ran.
 *
 * A section deadline is a timer, so a synchronous pass over the corpus must be
 * preceded by one of these or the deadline cannot fire during it.
 */
export async function yieldEntityRecallScan(abortSignal?: AbortSignal): Promise<void> {
  await yieldToEventLoop();
  throwIfAborted(abortSignal, ABORT_MESSAGE);
}

/**
 * The same yield/abort pair, but only every `ENTITY_SCAN_YIELD_INTERVAL` items —
 * for loops where yielding per item would cost more than the work itself.
 */
export async function yieldEntityRecallScanEvery(
  processed: number,
  abortSignal?: AbortSignal,
): Promise<void> {
  if (processed % ENTITY_SCAN_YIELD_INTERVAL !== 0) return;
  await yieldEntityRecallScan(abortSignal);
}

/**
 * Exit an entity-recall path with "no section", unless the caller has actually
 * cancelled — in which case throw, so the bounded runner records a breach rather
 * than a successful empty section.
 */
export function entityRecallSectionAbsent(abortSignal?: AbortSignal): null {
  throwIfAborted(abortSignal, ABORT_MESSAGE);
  return null;
}
