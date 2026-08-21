/**
 * Parse a deep-recall policy name (issue #2332 leftover).
 *
 * Pure. Surfaces wait. Unknown or empty values fail closed.
 */
export const DEEP_POLICY_NAMES = ["stop", "expand-once"] as const;

export type DeepPolicyName = (typeof DEEP_POLICY_NAMES)[number];

export type ParseDeepPolicyNameResult =
  | { ok: true; policy: DeepPolicyName }
  | { ok: false; error: "unknown_policy" };

export function parseDeepPolicyName(value: unknown): ParseDeepPolicyNameResult {
  if (typeof value !== "string" || value.length === 0) {
    return { ok: false, error: "unknown_policy" };
  }
  if (!(DEEP_POLICY_NAMES as readonly string[]).includes(value)) {
    return { ok: false, error: "unknown_policy" };
  }
  return { ok: true, policy: value as DeepPolicyName };
}
