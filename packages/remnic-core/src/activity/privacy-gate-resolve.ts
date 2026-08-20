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

// Frozen at runtime AND still literal-typed: `Object.freeze` preserves the
// `as const` tuple, so ActivityFeatureGate stays a five-member union for
// TypeScript consumers while a JavaScript consumer cannot push a key into
// the array and have resolveActivityGates accept it forever. An explicit
// `readonly string[]` annotation would widen the union back to `string`.
export const ACTIVITY_FEATURE_GATES = Object.freeze([
  "analysis",
  "journal",
  "weekly",
  "export",
  "memoryCreation",
] as const);
export type ActivityFeatureGate = (typeof ACTIVITY_FEATURE_GATES)[number];

export type ActivityGateSet = Readonly<Record<ActivityFeatureGate, boolean>>;


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
      if (!(ACTIVITY_FEATURE_GATES as readonly string[]).includes(key)) {
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
    // Object.keys above enumerates OWN properties only, so an inherited
    // "analysis" never reaches the unknown-key check. Reading it here anyway
    // would let a gate object with an altered prototype enable a gate the
    // caller never set: read own properties only.
    // A PRESENT own key whose value is undefined is not the same as an
    // absent key: composed config objects often carry explicit undefined,
    // and the API promises to throw for invalid values, so present-but-
    // undefined goes through parseGateValue (which refuses it) rather than
    // silently reading as false.
    const present = rawGates !== undefined && Object.hasOwn(rawGates, gate);
    result[gate] = present ? parseGateValue(gate, (rawGates as Record<string, unknown>)[gate]) : false;
  }
  if (!master) {
    for (const gate of ACTIVITY_FEATURE_GATES) {
      result[gate] = false;
    }
  }
  return Object.freeze(result);
}
