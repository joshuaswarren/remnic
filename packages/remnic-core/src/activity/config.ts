import { coerceBooleanLike, coerceNumber } from "../connectors/coerce.js";
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

function parseSource(value: unknown): ActivitySourceConfig {
  const raw = asRecord(value, "activity source");
  const machineLabel = optionalString(raw.machineLabel, "activity source machineLabel");
  const baseUrl = optionalString(raw.baseUrl, "activity source baseUrl");
  if (machineLabel === undefined || baseUrl === undefined) {
    throw new TypeError("activity source requires machineLabel and baseUrl");
  }
  const parsed = new URL(baseUrl);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new RangeError("activity source baseUrl must use HTTP or HTTPS");
  }
  const token = optionalString(raw.token, "activity source token");
  return { machineLabel, baseUrl, ...(token === undefined ? {} : { token }) };
}

export function parseActivityConfig(raw: unknown): ActivityConfig {
  if (raw === undefined || raw === null) {
    return { enabled: false, timezone: "UTC", syncDays: 1, sources: [] };
  }
  const config = asRecord(raw, "activity");
  const enabledValue = coerceBooleanLike(config.enabled, "activity.enabled");
  if (config.enabled !== undefined && enabledValue === undefined) {
    throw new TypeError("activity.enabled must be a boolean");
  }
  const timezone = optionalString(config.timezone, "activity.timezone") ?? "UTC";
  const syncDaysValue = coerceNumber(config.syncDays, "activity.syncDays");
  if (config.syncDays !== undefined && syncDaysValue === undefined) {
    throw new TypeError("activity.syncDays must be a finite number");
  }
  const syncDays = syncDaysValue ?? 1;
  if (!Number.isInteger(syncDays) || syncDays < 1 || syncDays > 90) {
    throw new RangeError("activity.syncDays must be an integer from 1 to 90");
  }
  if (config.sources !== undefined && !Array.isArray(config.sources)) {
    throw new TypeError("activity.sources must be an array");
  }
  const sources = (config.sources ?? []).map(parseSource);
  const enabled = enabledValue ?? false;
  if (enabled && sources.length === 0) throw new RangeError("activity.enabled requires at least one source");
  return { enabled, timezone, syncDays, sources };
}
