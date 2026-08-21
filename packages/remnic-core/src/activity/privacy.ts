/**
 * Activity retention and export policy (issue #2053 first slice).
 *
 * Pure helpers. Surfaces and parseConfig wiring wait for a later PR.
 * Master `activity.enabled` false denies retain and empties export.
 */
import { coerceBooleanLike, coerceNumber } from "../connectors/coerce.js";

export const MS_PER_DAY = 86_400_000;

export interface ActivityPrivacyPolicy {
  enabled: boolean;
  /** `0` keeps forever. */
  retentionDays: number;
  exportIncludeObservations: boolean;
}

function asRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function parseGate(value: unknown, key: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  const parsed = coerceBooleanLike(value, key);
  if (parsed === undefined) throw new TypeError(`${key} must be a boolean`);
  return parsed;
}

/** Parse retention and export knobs. Independent of timeline/journal/weekly blocks. */
export function parseActivityPrivacy(raw?: unknown): ActivityPrivacyPolicy {
  if (raw === undefined || raw === null) {
    return { enabled: false, retentionDays: 0, exportIncludeObservations: false };
  }
  const config = asRecord(raw, "activity");
  const enabled = parseGate(config.enabled, "activity.enabled", false);
  let retentionDays = 0;
  if (config.retentionDays !== undefined) {
    const parsed = coerceNumber(config.retentionDays, "activity.retentionDays");
    if (parsed === undefined || !Number.isInteger(parsed) || parsed < 0) {
      throw new RangeError("activity.retentionDays must be a non-negative integer");
    }
    retentionDays = parsed;
  }
  const exportIncludeObservations = parseGate(
    config.exportIncludeObservations,
    "activity.exportIncludeObservations",
    false,
  );
  return { enabled, retentionDays, exportIncludeObservations };
}

/**
 * Half-open retain window: keep when age is in `[0, retentionDays)`.
 * `retentionDays === 0` keeps forever. Master off denies.
 */
export function shouldRetain(
  capturedAtMs: number,
  nowMs: number,
  retentionDays: number,
  enabled = true,
): boolean {
  if (!enabled) return false;
  if (retentionDays < 0 || !Number.isInteger(retentionDays)) {
    throw new RangeError("activity.retentionDays must be a non-negative integer");
  }
  if (retentionDays === 0) return true;
  return nowMs - capturedAtMs < retentionDays * MS_PER_DAY;
}

/** Export payload. Master off or the export gate off returns empty. */
export function observationsForExport<T>(
  observations: readonly T[],
  policy: Pick<ActivityPrivacyPolicy, "enabled" | "exportIncludeObservations">,
): readonly T[] {
  if (!policy.enabled || !policy.exportIncludeObservations) return [];
  return observations;
}
