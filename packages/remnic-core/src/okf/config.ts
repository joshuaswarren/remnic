/**
 * OKF conformance config (issue #1946). Parsed off the raw `okf` config
 * block; mirrors the meetings/wearables parse-module seam so config.ts
 * stays a thin caller.
 */
import { coerceBooleanLike } from "../connectors/coerce.js";

export interface OkfConfig {
  /** Emit inert OKF `type` metadata on writes and gate the sweep (default true). */
  conformanceEnabled: boolean;
  /** Opt-in governance sweep that backfills `type` on legacy files (default false). */
  sweepEnabled: boolean;
}

export const DEFAULT_OKF_CONFIG: OkfConfig = Object.freeze({
  conformanceEnabled: true,
  sweepEnabled: false,
});

const OKF_CONFIG_KEYS: Readonly<Record<string, true>> = Object.freeze({
  conformanceEnabled: true,
  sweepEnabled: true,
});

export function parseOkfConfig(raw: unknown): OkfConfig {
  if (raw === undefined || raw === null) return { ...DEFAULT_OKF_CONFIG };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(
      `okf must be an object (got ${JSON.stringify(raw)}). Use okf: { conformanceEnabled: false } to opt out; omit the key for defaults.`,
    );
  }
  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (OKF_CONFIG_KEYS[key] !== true) {
      throw new Error(
        `okf config contains unknown key '${key}'; valid keys are ${Object.keys(OKF_CONFIG_KEYS).join(", ")}.`,
      );
    }
  }
  const conformance = coerceBooleanLike(record.conformanceEnabled, "okf.conformanceEnabled");
  const sweep = coerceBooleanLike(record.sweepEnabled, "okf.sweepEnabled");
  return {
    conformanceEnabled: conformance ?? DEFAULT_OKF_CONFIG.conformanceEnabled,
    sweepEnabled: sweep ?? DEFAULT_OKF_CONFIG.sweepEnabled,
  };
}
