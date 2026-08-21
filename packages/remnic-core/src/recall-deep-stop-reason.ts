/**
 * Parse a deep-recall stop reason (issue #2332 leftover).
 *
 * Pure. Surfaces wait. Unknown or empty values fail closed.
 */
export const DEEP_STOP_REASONS = [
  "budget_exhausted",
  "policy_stop",
  "expand_once",
  "refine_done",
] as const;

export type DeepStopReason = (typeof DEEP_STOP_REASONS)[number];

export type ParseDeepStopReasonResult =
  | { ok: true; reason: DeepStopReason }
  | { ok: false; error: "unknown_reason" };

export function parseDeepStopReason(value: unknown): ParseDeepStopReasonResult {
  if (typeof value !== "string" || value.length === 0) {
    return { ok: false, error: "unknown_reason" };
  }
  if (!(DEEP_STOP_REASONS as readonly string[]).includes(value)) {
    return { ok: false, error: "unknown_reason" };
  }
  return { ok: true, reason: value as DeepStopReason };
}
