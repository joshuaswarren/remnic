/**
 * Empty-trace guard for deep-recall results (issue #2332 leftover).
 *
 * null, undefined, and [] are empty. A non-array throws.
 */

import type { DeepRecallTraceStep } from "./recall-deep.js";

/** True when the trace is absent or has no steps. */
export function isEmptyDeepRecallTrace(
  trace: unknown,
): trace is null | undefined | readonly [] {
  if (trace == null) return true;
  if (!Array.isArray(trace)) {
    throw new TypeError("trace must be an array");
  }
  return (trace as DeepRecallTraceStep[]).length === 0;
}
