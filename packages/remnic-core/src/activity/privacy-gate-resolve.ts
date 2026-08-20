/**
 * Master-override resolution for activity feature gates (issue #2053).
 *
 * With `activity.enabled` false, every feature gate reads false regardless of
 * its own config value. Gate values accept booleans and the same string tokens
 * as `parsePrivacyEnabled`; anything else throws so a typo can never silently
 * disable (or enable) a gate. Internal helper — wiring it into parseConfig is
 * a later slice.
 */

import { parsePrivacyEnabled } from "./privacy-enabled.js";

export const ACTIVITY_FEATURE_GATES = [
  "analysis",
  "journal",
  "weekly",
  "export",
  "memoryCreation",
] as const;
export type ActivityFeatureGate = (typeof ACTIVITY_FEATURE_GATES)[number];

export type ActivityGateSet = Readonly<Record<ActivityFeatureGate, boolean>>;

const GATE_KEY_LIST: readonly string[] = ACTIVITY_FEATURE_GATES;

function parseGateValue(key: string, value: unknown): boolean {
  const parsed = parsePrivacyEnabled(value);
  if (!parsed.ok) {
    throw new TypeError(
      `invalid value for activity gate "${key}": ${JSON.stringify(value)} is not a boolean or known token`,
    );
  }
  return parsed.enabled;
}

export function resolveActivityGates(input: {
  enabled?: unknown;
  gates?: Readonly<Record<string, unknown>>;
}): ActivityGateSet {
  const rawGates = input.gates;
  if (rawGates !== undefined && (typeof rawGates !== "object" || rawGates === null || Array.isArray(rawGates))) {
    throw new TypeError("activity gates must be an object");
  }
  if (rawGates) {
    for (const key of Object.keys(rawGates)) {
      if (!GATE_KEY_LIST.includes(key)) {
        throw new TypeError(
          `unknown activity gate "${key}"; allowed gates: ${ACTIVITY_FEATURE_GATES.join(", ")}`,
        );
      }
    }
  }

  const master =
    input.enabled === undefined ? false : parseGateValue("enabled", input.enabled);

  const result = {} as Record<ActivityFeatureGate, boolean>;
  for (const gate of ACTIVITY_FEATURE_GATES) {
    const raw = rawGates?.[gate];
    result[gate] = raw === undefined ? false : parseGateValue(gate, raw);
  }
  if (!master) {
    for (const gate of ACTIVITY_FEATURE_GATES) {
      result[gate] = false;
    }
  }
  return Object.freeze(result);
}
