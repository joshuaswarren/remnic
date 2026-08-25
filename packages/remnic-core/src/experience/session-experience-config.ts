/**
 * Session-end experience extraction config (issue #2979) — the
 * `sessionExperience` block.
 *
 * Parsed like `recallNavigation`: shape-validated, fail-closed on unknown
 * keys, no silent clamping. Defaults OFF (a machine-generated memory write
 * from the completed session must be an explicit operator opt-in); the
 * `conservative` preset pins `enabled: false`.
 */

import { coerceBool } from "../connectors/coerce.js";

export interface SessionExperienceConfig {
  /**
   * Master switch for session-end Situation/Approach/Reflection episode
   * extraction. Default false.
   */
  enabled: boolean;
}

export const SESSION_EXPERIENCE_CONFIG_DEFAULTS: SessionExperienceConfig = {
  enabled: false,
};

function parseFlag(src: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = src[key];
  if (value === undefined || value === null) return fallback;
  const coerced = coerceBool(value);
  if (coerced === undefined) {
    throw new Error(
      `sessionExperience.${key} must be a boolean (or "true"/"false"/"1"/"0"); got ${JSON.stringify(value)}`,
    );
  }
  return coerced;
}

export function parseSessionExperienceConfig(raw: unknown): SessionExperienceConfig {
  if (raw === undefined || raw === null) return { ...SESSION_EXPERIENCE_CONFIG_DEFAULTS };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`sessionExperience must be an object; got ${JSON.stringify(raw)}`);
  }
  const src = raw as Record<string, unknown>;
  const { enabled: _enabled, ...unknown } = src;
  const unknownKey = Object.keys(unknown)[0];
  if (unknownKey !== undefined) {
    throw new Error(`sessionExperience contains unknown key ${JSON.stringify(unknownKey)}`);
  }
  return {
    enabled: parseFlag(src, "enabled", SESSION_EXPERIENCE_CONFIG_DEFAULTS.enabled),
  };
}
