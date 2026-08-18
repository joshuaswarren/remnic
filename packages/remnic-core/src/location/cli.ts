/**
 * Location surface helpers (issue #2044): status, provider health checks, and
 * multi-day sync. Pure `@remnic/core` — no optional packages, no host CLI
 * wiring; a host adapter (or the core CLI, in a later slice) renders these
 * structured results into its own command surface.
 */

import { getLocationProvider } from "./registry.js";
import { isValidLocationDate, localDayKey } from "./intervals.js";
import { listLocationDayDates, loadLocationSyncState, parseLocationDaySummary, readLocationDay } from "./store.js";
import { syncLocationDay, type LocationDaySyncOptions, type LocationSourceSyncResult } from "./pipeline.js";
import type { LocationConfig, LocationProvider } from "./types.js";

export interface LocationSourceStatus {
  id: string;
  enabled: boolean;
  providerRegistered: boolean;
  lastSyncedAtUtc?: string;
  trackedDays: number;
}

export interface LocationDayStatus {
  date: string;
  sources: string[];
  observationCount: number;
}

export interface LocationStatusReport {
  enabled: boolean;
  timezone: string;
  sources: LocationSourceStatus[];
  /** Stored day documents, newest first (at most `maxDays`). */
  recentDays: LocationDayStatus[];
}

export interface LocationStatusOptions {
  /** Provider lookup seam (defaults to the registry); tests inject doubles. */
  getProvider?: (id: string) => LocationProvider | undefined;
  /** Cap on day documents listed; defaults to 7. */
  maxDays?: number;
  now?: () => Date;
}

export async function locationStatus(
  config: LocationConfig,
  memoryDir: string,
  options: LocationStatusOptions = {},
): Promise<LocationStatusReport> {
  const resolveProvider = options.getProvider ?? getLocationProvider;
  const state = await loadLocationSyncState(memoryDir);
  const sources: LocationSourceStatus[] = config.sources.map((source) => {
    const sourceState = state.sources[source.id];
    return {
      id: source.id,
      enabled: source.enabled,
      providerRegistered: resolveProvider(source.id) !== undefined,
      ...(sourceState?.lastSyncedAtUtc === undefined ? {} : { lastSyncedAtUtc: sourceState.lastSyncedAtUtc }),
      trackedDays: Object.keys(sourceState?.days ?? {}).length,
    };
  });

  const maxDays = options.maxDays ?? 7;
  const recentDays: LocationDayStatus[] = [];
  for (const date of (await listLocationDayDates(memoryDir)).slice(0, Math.max(0, maxDays))) {
    const raw = await readLocationDay(memoryDir, date);
    const summary = raw === null ? null : parseLocationDaySummary(raw);
    recentDays.push({
      date,
      sources: summary?.sources ?? [],
      observationCount: summary?.observationCount ?? 0,
    });
  }
  return { enabled: config.enabled, timezone: config.timezone, sources, recentDays };
}

export interface LocationSourceCheckResult {
  id: string;
  ok: boolean;
  detail?: string;
  skipped?: "location-disabled" | "source-disabled" | "provider-not-registered";
}

export interface LocationCheckOptions {
  signal?: AbortSignal;
  getProvider?: (id: string) => LocationProvider | undefined;
}

/** Probe every configured provider's health. The master gate short-circuits. */
export async function checkLocationSources(
  config: LocationConfig,
  options: LocationCheckOptions = {},
): Promise<LocationSourceCheckResult[]> {
  if (!config.enabled) {
    return config.sources.map((source) => ({ id: source.id, ok: false, skipped: "location-disabled" as const }));
  }
  const resolveProvider = options.getProvider ?? getLocationProvider;
  const results: LocationSourceCheckResult[] = [];
  for (const source of config.sources) {
    if (!source.enabled) {
      results.push({ id: source.id, ok: false, skipped: "source-disabled" });
      continue;
    }
    const provider = resolveProvider(source.id);
    if (provider === undefined) {
      results.push({ id: source.id, ok: false, skipped: "provider-not-registered" });
      continue;
    }
    try {
      const check = await provider.verify(options.signal);
      results.push({
        id: source.id,
        ok: check.ok,
        ...(check.detail === undefined || check.detail.length === 0 ? {} : { detail: check.detail }),
      });
    } catch (error) {
      results.push({ id: source.id, ok: false, detail: error instanceof Error ? error.name : "provider error" });
    }
  }
  return results;
}

function shiftIsoDate(date: string, days: number): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

export interface LocationSyncRunOptions
  extends Omit<LocationDaySyncOptions, "config" | "date" | "memoryDir"> {
  config: LocationConfig;
  memoryDir: string;
  /** Exclusive end date (local YYYY-MM-DD); defaults to today in config.timezone. */
  endDate?: string;
  /** Number of days to sync ending at endDate; defaults to config.syncDays. */
  days?: number;
  now?: () => Date;
}
/**
 * Sync the trailing `days` local days ending AT `endDate` (inclusive).
 * `endDate` defaults to yesterday in config.timezone (today is incomplete);
 * days run oldest-first so a failure stops before newer days, matching the
 * incremental-sync intent of `syncDays`.
 */
export async function syncLocation(
  options: LocationSyncRunOptions,
): Promise<Array<{ date: string; results: LocationSourceSyncResult[] }>> {
  const { config, memoryDir, endDate, days, ...rest } = options;
  if (endDate !== undefined && !isValidLocationDate(endDate)) {
    throw new RangeError(`Invalid location endDate "${endDate}"; expected a real YYYY-MM-DD day.`);
  }
  const now = rest.now ?? (() => new Date());
  const end = endDate ?? shiftIsoDate(localDayKey(now().toISOString(), config.timezone), -1);
  const count = days ?? config.syncDays;
  if (!Number.isInteger(count) || count < 1 || count > 90) {
    throw new RangeError("location sync days must be an integer from 1 to 90");
  }
  const runs: Array<{ date: string; results: LocationSourceSyncResult[] }> = [];
  for (let offset = count; offset >= 1; offset -= 1) {
    const date = shiftIsoDate(end, -(offset - 1));
    runs.push({ date, results: await syncLocationDay({ ...rest, config, memoryDir, date, now }) });
  }
  return runs;
}
