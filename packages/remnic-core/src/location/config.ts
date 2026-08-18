import { coerceBooleanLike, coerceNumber } from "../connectors/coerce.js";
import { assertValidTimezone } from "../activity/digest.js";
import type { LocationConfig, LocationSourceConfig } from "./types.js";

const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/** The inert default: disabled, UTC days, one day per run, no sources, no coordinates. */
export function defaultLocationConfig(): LocationConfig {
  return {
    enabled: false,
    timezone: "UTC",
    syncDays: 1,
    retainCoordinates: false,
    sources: [],
  };
}

function asRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function optionalNonEmptyString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${name} must be a non-empty string`);
  return value;
}

function parseSource(value: unknown): LocationSourceConfig {
  const raw = asRecord(value, "location source");
  const id = optionalNonEmptyString(raw.id, "location source id");
  if (id === undefined) {
    throw new TypeError("location source requires id");
  }
  if (!PROVIDER_ID_PATTERN.test(id)) {
    throw new RangeError(
      `location source id must be a lowercase kebab string (a-z, 0-9, hyphens): got "${id}"`,
    );
  }
  const enabledValue = coerceBooleanLike(raw.enabled, "location source enabled");
  if (raw.enabled !== undefined && enabledValue === undefined) {
    throw new TypeError(`location source '${id}' enabled must be a boolean`);
  }
  return { id, enabled: enabledValue ?? true };
}

/**
 * Parse the unified `location.*` block. `enabled` gates everything and
 * requires at least one source; a source's own `enabled` gates that source
 * only. `retainCoordinates` defaults to `false` — coordinates are privacy
 * data and are dropped everywhere unless explicitly retained.
 */
export function parseLocationConfig(raw: unknown): LocationConfig {
  const defaults = defaultLocationConfig();
  if (raw === undefined || raw === null) {
    return { ...defaults };
  }
  const config = asRecord(raw, "location");
  const enabledValue = coerceBooleanLike(config.enabled, "location.enabled");
  if (config.enabled !== undefined && enabledValue === undefined) {
    throw new TypeError("location.enabled must be a boolean");
  }
  const enabled = enabledValue ?? false;

  const timezone = optionalNonEmptyString(config.timezone, "location.timezone") ?? "UTC";
  // Validate the IANA zone at parse so a typo fails at config load, not
  // mid-sync after some sources may already have advanced their state.
  assertValidTimezone(timezone);

  const syncDaysValue = coerceNumber(config.syncDays, "location.syncDays");
  if (config.syncDays !== undefined && syncDaysValue === undefined) {
    throw new TypeError("location.syncDays must be a finite number");
  }
  const syncDays = syncDaysValue ?? 1;
  if (!Number.isInteger(syncDays) || syncDays < 1 || syncDays > 90) {
    throw new RangeError("location.syncDays must be an integer from 1 to 90");
  }

  const retainCoordinatesValue = coerceBooleanLike(config.retainCoordinates, "location.retainCoordinates");
  if (config.retainCoordinates !== undefined && retainCoordinatesValue === undefined) {
    throw new TypeError("location.retainCoordinates must be a boolean");
  }
  const retainCoordinates = retainCoordinatesValue ?? false;

  if (config.sources !== undefined && !Array.isArray(config.sources)) {
    throw new TypeError("location.sources must be an array");
  }
  const sources = (config.sources ?? []).map(parseSource);
  // Day payloads and sync state are keyed on source id; two sources sharing
  // an id would overwrite each other's state. Reject the collision at parse.
  const ids = new Set<string>();
  for (const source of sources) {
    if (ids.has(source.id)) {
      throw new RangeError(`location source id must be unique: ${source.id}`);
    }
    ids.add(source.id);
  }
  if (enabled && sources.length === 0) {
    throw new RangeError("location.enabled requires at least one source");
  }

  return { enabled, timezone, syncDays, retainCoordinates, sources };
}
