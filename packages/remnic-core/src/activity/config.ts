import { coerceBooleanLike, coerceNumber } from "../connectors/coerce.js";
import { assertValidTimezone } from "./digest.js";
import type { ImportanceLevel } from "../types.js";
import type { ActivityConfig, ActivityExtractionMode, ActivitySourceConfig, ActivityTimelineConfig } from "./types.js";

const EXTRACTION_MODES: readonly ActivityExtractionMode[] = ["off", "smart"];
const IMPORTANCE_LEVELS: readonly ImportanceLevel[] = ["critical", "high", "normal", "low", "trivial"];
const LOOPBACK_HOSTS: Record<string, true> = { localhost: true, "127.0.0.1": true, "::1": true };

/** The inert default: disabled, search-only, no sources, no extraction. */
export function defaultActivityConfig(): ActivityConfig {
  return {
    enabled: false,
    timezone: "UTC",
    syncDays: 1,
    autoSyncIntervalMinutes: 15,
    sources: [],
    extractionMode: "off",
    sourceTrust: 0.6,
    autoApproveTrust: 0.8,
    reviewTrust: 0.5,
    minConfidence: 0.7,
    minImportance: "normal",
    maxMemoriesPerDay: 0,
    timeline: { enabled: false },
  };
}

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

function parseUnitInterval(value: unknown, key: string, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = coerceNumber(value);
  if (parsed === undefined || !Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new RangeError(`activity.${key} must be a number in [0, 1]`);
  }
  return parsed;
}

/**
 * Parse, protocol-check, and confine an activity source base URL to a local
 * loopback host. Shared with ActivityHttpSourceClient so config-load and client
 * construction reject the exact same shapes with the same prefixed message. The
 * bearer token travels in an Authorization header, so a non-loopback baseUrl
 * would exfiltrate it; the subsystem contract is local capture daemons only.
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

/**
 * Parse the unified `activity.*` block. `enabled` gates source ingestion (and
 * requires at least one source); `extractionMode` independently gates durable
 * trust-gated memory extraction (default `off`, i.e. search-only).
 */
export function parseActivityConfig(raw: unknown): ActivityConfig {
  const defaults = defaultActivityConfig();
  if (raw === undefined || raw === null) {
    return { ...defaults };
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

  // Extraction gate (independent of `enabled` ingestion). Default `off`.
  // Default only for a missing key; an explicit null/non-string is a malformed
  // enum and must fail rather than silently disabling extraction.
  const extractionMode = config.extractionMode === undefined ? defaults.extractionMode : config.extractionMode;
  if (typeof extractionMode !== "string" || !EXTRACTION_MODES.includes(extractionMode as ActivityExtractionMode)) {
    throw new RangeError(`activity.extractionMode must be one of: ${EXTRACTION_MODES.join(", ")}`);
  }
  const minImportance = config.minImportance === undefined ? defaults.minImportance : config.minImportance;
  if (typeof minImportance !== "string" || !IMPORTANCE_LEVELS.includes(minImportance as ImportanceLevel)) {
    throw new RangeError(`activity.minImportance must be one of: ${IMPORTANCE_LEVELS.join(", ")}`);
  }
  // Default only for a missing key; an explicit null/unparseable value must fail
  // rather than silently uncapping (parity with the enum/unit-interval fields).
  const rawMaxMemoriesPerDay =
    config.maxMemoriesPerDay === undefined ? defaults.maxMemoriesPerDay : config.maxMemoriesPerDay;
  const maxMemoriesPerDay = coerceNumber(rawMaxMemoriesPerDay);
  if (maxMemoriesPerDay === undefined || !Number.isInteger(maxMemoriesPerDay) || maxMemoriesPerDay < 0) {
    throw new RangeError("activity.maxMemoriesPerDay must be a non-negative integer");
  }
  const autoApproveTrust = parseUnitInterval(config.autoApproveTrust, "autoApproveTrust", defaults.autoApproveTrust);
  const reviewTrust = parseUnitInterval(config.reviewTrust, "reviewTrust", defaults.reviewTrust);
  if (reviewTrust >= autoApproveTrust) {
    throw new RangeError(
      `activity.reviewTrust (${reviewTrust}) must be below autoApproveTrust (${autoApproveTrust})`,
    );
  }
  return {
    enabled,
    timezone,
    syncDays,
    autoSyncIntervalMinutes,
    sources,
    extractionMode: extractionMode as ActivityExtractionMode,
    sourceTrust: parseUnitInterval(config.sourceTrust, "sourceTrust", defaults.sourceTrust),
    autoApproveTrust,
    reviewTrust,
    minConfidence: parseUnitInterval(config.minConfidence, "minConfidence", defaults.minConfidence),
    minImportance: minImportance as ImportanceLevel,
    maxMemoriesPerDay,
    timeline: parseTimelineConfig(config.timeline),
  };
}

/**
 * Parse the `activity.timeline.*` block. `enabled` is the master gate for
 * timeline-card derivation (issue #2049); default false. A non-object block
 * is malformed and must fail rather than silently disabling the layer.
 */
function parseTimelineConfig(raw: unknown): ActivityTimelineConfig {
  if (raw === undefined) return { enabled: false };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new TypeError("activity.timeline must be an object");
  }
  const timeline = raw as Record<string, unknown>;
  const enabledValue = coerceBooleanLike(timeline.enabled, "activity.timeline.enabled");
  if (timeline.enabled !== undefined && enabledValue === undefined) {
    throw new TypeError("activity.timeline.enabled must be a boolean");
  }
  return { enabled: enabledValue ?? false };
}
