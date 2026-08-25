/**
 * Recall-navigation config (issue #1956) — the `recallNavigation` block.
 *
 * Parsed the same way `deepRecall` is: shape-validated, string-coercion
 * safe (§24), no silent clamping of documented values (§33). Navigation is
 * a read-only surface over already-served recall results, so it defaults
 * ON; the `conservative` preset pins `enabled: false`.
 */

import { coerceBool, coerceNumber } from "./connectors/coerce.js";

export interface RecallNavigationConfig {
  /** Master switch. Default true (read-only, additive surface). */
  enabled: boolean;
  /**
   * How many of the session's most recent recall snapshots an expandable
   * or traversable id may come from. Default 3.
   */
  windowSnapshots: number;
  /** Ceiling for a traverse/entity-neighbor limit override. Default 10. */
  maxNeighbors: number;
}

export interface RecallNavigationSettings {
  recallNavigation: RecallNavigationConfig;
}

export const DEFAULT_NAVIGATION_WINDOW_SNAPSHOTS = 3;

export const RECALL_NAVIGATION_CONFIG_DEFAULTS: RecallNavigationConfig = {
  enabled: true,
  windowSnapshots: DEFAULT_NAVIGATION_WINDOW_SNAPSHOTS,
  maxNeighbors: 10,
};

/** Record served ids when display handles or navigation authority needs them. */
export function shouldRecordRecallAuthorityHistory(config: {
  recallMemoryHandles?: boolean;
  recallNavigation?: { enabled?: boolean };
}): boolean {
  return config.recallMemoryHandles === true || config.recallNavigation?.enabled === true;
}

function parseFlag(src: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = src[key];
  if (value === undefined || value === null) return fallback;
  const coerced = coerceBool(value);
  if (coerced === undefined) {
    throw new Error(
      `recallNavigation.${key} must be a boolean (or "true"/"false"/"1"/"0"); got ${JSON.stringify(value)}`,
    );
  }
  return coerced;
}

function parseBoundedInt(
  src: Record<string, unknown>,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = src[key];
  if (value === undefined || value === null) return fallback;
  const coerced = coerceNumber(value);
  if (coerced === undefined || !Number.isFinite(coerced) || !Number.isInteger(coerced)) {
    throw new Error(
      `recallNavigation.${key} must be an integer between ${min} and ${max}; got ${JSON.stringify(value)}`,
    );
  }
  if (coerced < min || coerced > max) {
    throw new Error(
      `recallNavigation.${key} must be an integer between ${min} and ${max}; got ${JSON.stringify(value)}`,
    );
  }
  return coerced;
}

export function parseRecallNavigationConfig(raw: unknown): RecallNavigationConfig {
  if (raw === undefined || raw === null) return { ...RECALL_NAVIGATION_CONFIG_DEFAULTS };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`recallNavigation must be an object; got ${JSON.stringify(raw)}`);
  }
  const src = raw as Record<string, unknown>;
  const { enabled: _enabled, windowSnapshots: _windowSnapshots, maxNeighbors: _maxNeighbors, ...unknown } = src;
  const unknownKey = Object.keys(unknown)[0];
  if (unknownKey !== undefined) {
    throw new Error(`recallNavigation contains unknown key ${JSON.stringify(unknownKey)}`);
  }
  return {
    enabled: parseFlag(src, "enabled", RECALL_NAVIGATION_CONFIG_DEFAULTS.enabled),
    windowSnapshots: parseBoundedInt(
      src,
      "windowSnapshots",
      RECALL_NAVIGATION_CONFIG_DEFAULTS.windowSnapshots,
      1,
      50,
    ),
    maxNeighbors: parseBoundedInt(
      src,
      "maxNeighbors",
      RECALL_NAVIGATION_CONFIG_DEFAULTS.maxNeighbors,
      1,
      50,
    ),
  };
}
