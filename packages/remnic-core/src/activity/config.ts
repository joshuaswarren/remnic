import { coerceBooleanLike, coerceNumber } from "../connectors/coerce.js";
import { assertValidTimezone } from "./digest.js";
import type { ActivityConfig, ActivitySourceConfig } from "./types.js";

function asRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${name} must be a non-empty string`);
  return value;
}

const LOOPBACK_HOSTS: Record<string, true> = { localhost: true, "127.0.0.1": true, "::1": true };

/**
 * Parse, protocol-check, and confine an activity source base URL to a local
 * loopback host. Shared with ActivityHttpSourceClient so config-load and client
 * construction reject the exact same shapes with the same prefixed message (a
 * bare `new URL()` throws an opaque TypeError on malformed input). The bearer
 * token travels in an Authorization header, so a non-loopback baseUrl would
 * exfiltrate it; the subsystem contract is local capture daemons only.
 */
export function validateActivityBaseUrl(baseUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new RangeError(`activity source baseUrl must be a valid URL: ${baseUrl}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new RangeError("activity source baseUrl must use HTTP or HTTPS");
  }
  // URL keeps IPv6 hosts bracketed (e.g. "[::1]"); normalize before the lookup.
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  if (LOOPBACK_HOSTS[host] !== true && !/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) {
    throw new RangeError(`activity source baseUrl must target a loopback host (got ${parsed.hostname})`);
  }
  return parsed;
}

function parseSource(value: unknown): ActivitySourceConfig {
  const raw = asRecord(value, "activity source");
  const machineLabel = optionalString(raw.machineLabel, "activity source machineLabel");
  const baseUrl = optionalString(raw.baseUrl, "activity source baseUrl");
  if (machineLabel === undefined || baseUrl === undefined) {
    throw new TypeError("activity source requires machineLabel and baseUrl");
  }
  // Reject whitespace-only labels here so config-load fails loudly rather than
  // parsing clean and then failing on the first sync (the client and pipeline
  // both reject a blank label via trim()).
  if (machineLabel.trim().length === 0) {
    throw new RangeError("activity source machineLabel must not be blank");
  }
  validateActivityBaseUrl(baseUrl);
  const token = optionalString(raw.token, "activity source token");
  return { machineLabel, baseUrl, ...(token === undefined ? {} : { token }) };
}

export function parseActivityConfig(raw: unknown): ActivityConfig {
  if (raw === undefined || raw === null) {
    return { enabled: false, timezone: "UTC", syncDays: 1, autoSyncIntervalMinutes: 15, sources: [] };
  }
  const config = asRecord(raw, "activity");
  const enabledValue = coerceBooleanLike(config.enabled, "activity.enabled");
  if (config.enabled !== undefined && enabledValue === undefined) {
    throw new TypeError("activity.enabled must be a boolean");
  }
  const timezone = optionalString(config.timezone, "activity.timezone") ?? "UTC";
  // Validate the IANA zone at parse so a typo fails before any daemon is
  // contacted; otherwise activityDayWindow() throws mid-sync after snapshot
  // pages may already be persisted, and every retry replays the same window.
  assertValidTimezone(timezone);
  const syncDaysValue = coerceNumber(config.syncDays, "activity.syncDays");
  if (config.syncDays !== undefined && syncDaysValue === undefined) {
    throw new TypeError("activity.syncDays must be a finite number");
  }
  const syncDays = syncDaysValue ?? 1;
  if (!Number.isInteger(syncDays) || syncDays < 1 || syncDays > 90) {
    throw new RangeError("activity.syncDays must be an integer from 1 to 90");
  }
  const intervalValue = coerceNumber(config.autoSyncIntervalMinutes, "activity.autoSyncIntervalMinutes");
  if (config.autoSyncIntervalMinutes !== undefined && intervalValue === undefined) {
    throw new TypeError("activity.autoSyncIntervalMinutes must be a finite number");
  }
  const autoSyncIntervalMinutes = intervalValue ?? 15;
  if (!Number.isInteger(autoSyncIntervalMinutes) || autoSyncIntervalMinutes < 1 || autoSyncIntervalMinutes > 1440) {
    throw new RangeError("activity.autoSyncIntervalMinutes must be an integer from 1 to 1440");
  }
  if (config.sources !== undefined && !Array.isArray(config.sources)) {
    throw new TypeError("activity.sources must be an array");
  }
  const sources = (config.sources ?? []).map(parseSource);
  // Cursors and row dedup are keyed on machineLabel alone; two sources sharing
  // a label would share a cursor and dedup namespace, silently skipping or
  // conflating snapshots. Reject the collision at parse.
  const labels = new Set<string>();
  for (const source of sources) {
    if (labels.has(source.machineLabel)) {
      throw new RangeError(`activity source machineLabel must be unique: ${source.machineLabel}`);
    }
    labels.add(source.machineLabel);
  }
  const enabled = enabledValue ?? false;
  if (enabled && sources.length === 0) throw new RangeError("activity.enabled requires at least one source");
  return { enabled, timezone, syncDays, autoSyncIntervalMinutes, sources };
}
