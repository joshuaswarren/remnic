/**
 * Parse the activity privacy enabled flag (issue #2053 leftover).
 *
 * Boolean passthrough. String tokens true/1/yes/on and false/0/no/off.
 * Unknown values fail closed as invalid_enabled.
 */

export type ParsePrivacyEnabledResult =
  | { ok: true; enabled: boolean }
  | { ok: false; error: "invalid_enabled" };

const ENABLED_TOKENS: Record<string, boolean> = {
  true: true,
  "1": true,
  yes: true,
  on: true,
  false: false,
  "0": false,
  no: false,
  off: false,
};

/** Accept a boolean or known token. Unknown values are invalid_enabled. */
export function parsePrivacyEnabled(value: unknown): ParsePrivacyEnabledResult {
  if (typeof value === "boolean") return { ok: true, enabled: value };
  if (typeof value === "string") {
    const token = value.trim().toLowerCase();
    if (Object.hasOwn(ENABLED_TOKENS, token)) {
      return { ok: true, enabled: ENABLED_TOKENS[token] };
    }
  }
  return { ok: false, error: "invalid_enabled" };
}
