/**
 * Location day-sync pipeline (issue #2044).
 *
 * For one local day, each configured (enabled, registered) provider's
 * observations are fetched over the day's half-open UTC window, folded into
 * place-visit segments, merged with the other sources' last-known day
 * payloads from sync state, and rendered to the day document. Sync state
 * advances only AFTER the day document (when any) is durable, so a failed
 * write never moves the watermark past data that did not land. An empty
 * fetch is a successful sync — never conflated with a provider failure
 * (AGENTS.md rule 22).
 */

import { getLocationProvider } from "./registry.js";
import { locationDayWindow, observationSegments } from "./intervals.js";
import {
  composeLocationDayBody,
  composeLocationDayMeta,
  loadLocationSyncState,
  serializeLocationDay,
  updateLocationSourceDay,
  writeLocationDay,
  type LocationDaySourceEntry,
} from "./store.js";
import type { LocationConfig, LocationObservation, LocationProvider, LocationSegment } from "./types.js";

const MAX_SYNC_PAGES = 10_000;

export interface LocationDaySyncOptions {
  config: LocationConfig;
  memoryDir: string;
  date: string;
  signal?: AbortSignal;
  /** Runaway-pagination guard; defaults to MAX_SYNC_PAGES. */
  maxPages?: number;
  now?: () => Date;
  /** Provider lookup seam (defaults to the registry); tests inject doubles. */
  getProvider?: (id: string) => LocationProvider | undefined;
}

export interface LocationSourceSyncResult {
  sourceId: string;
  status: "synced" | "skipped" | "failed";
  skipReason?: "source-disabled" | "provider-not-registered";
  fetched: number;
  dayWritten: boolean;
  stateSaved: boolean;
  /** Sanitized provider error (no tokens, URLs, or coordinates). */
  error?: string;
}

/** Redact credential, URL query, and coordinate shapes from a provider error. */
export function sanitizeProviderError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/[?#][^ \t"']*/g, "[redacted]")
    .replace(/[+-]?\d+\.\d{3,},\s?[+-]?\d+\.\d{3,}/g, "[coordinates]")
    .slice(0, 300);
}

function assertValidObservation(observation: LocationObservation): void {
  if (typeof observation !== "object" || observation === null) {
    throw new TypeError("location provider returned a non-object observation");
  }
  if (typeof observation.observedAtUtc !== "string" || !Number.isFinite(Date.parse(observation.observedAtUtc))) {
    throw new TypeError("location provider returned an observation with an invalid observedAtUtc");
  }
  const place = observation.place;
  if (typeof place !== "object" || place === null || typeof place.id !== "string" || place.id.length === 0) {
    throw new TypeError("location provider returned an observation without a valid place");
  }
  if (typeof place.label !== "string" || place.label.trim().length === 0) {
    throw new TypeError(`location provider returned place '${place.id}' without a label`);
  }
}

/** Fetch every observation one provider holds for the window, all pages. */
async function fetchWindow(
  provider: LocationProvider,
  window: { startUtc: string; endUtc: string },
  options: LocationDaySyncOptions,
): Promise<LocationObservation[]> {
  const maxPages = options.maxPages ?? MAX_SYNC_PAGES;
  if (!Number.isInteger(maxPages) || maxPages < 1) {
    throw new RangeError("location sync maxPages must be a positive integer");
  }
  const observations: LocationObservation[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  let pages = 0;
  let completed = false;
  while (pages < maxPages) {
    options.signal?.throwIfAborted();
    const page = await provider.fetchObservations({
      startUtc: window.startUtc,
      endUtc: window.endUtc,
      cursor,
      signal: options.signal,
    });
    pages += 1;
    for (const observation of page.observations) assertValidObservation(observation);
    observations.push(...page.observations);
    if (page.nextCursor === null) {
      completed = true;
      break;
    }
    if (typeof page.nextCursor !== "string" || page.nextCursor.length === 0) {
      throw new TypeError("location provider returned an invalid cursor");
    }
    if (seenCursors.has(page.nextCursor)) {
      throw new Error("location provider returned a repeated cursor");
    }
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
  // Only a loop that ran out of its page budget without a terminal null
  // cursor is a runaway; completing on the final allowed page is normal.
  if (!completed) {
    throw new Error(`location provider exceeded ${maxPages} pages`);
  }
  return observations;
}

/**
 * Sync every configured source for one local day. The master gate
 * (`config.enabled === false`) short-circuits every path: no providers are
 * contacted and nothing touches the filesystem. A provider failure fails
 * that source only (state not advanced) and never blocks the others.
 */
export async function syncLocationDay(options: LocationDaySyncOptions): Promise<LocationSourceSyncResult[]> {
  if (!options.config.enabled) return [];
  const window = locationDayWindow(options.date, options.config.timezone);
  const now = options.now ?? (() => new Date());
  const resolveProvider = options.getProvider ?? getLocationProvider;

  const results: LocationSourceSyncResult[] = [];
  for (const source of options.config.sources) {
    if (!source.enabled) {
      results.push({
        sourceId: source.id,
        status: "skipped",
        skipReason: "source-disabled",
        fetched: 0,
        dayWritten: false,
        stateSaved: false,
      });
      continue;
    }
    const provider = resolveProvider(source.id);
    if (provider === undefined) {
      results.push({
        sourceId: source.id,
        status: "skipped",
        skipReason: "provider-not-registered",
        fetched: 0,
        dayWritten: false,
        stateSaved: false,
      });
      continue;
    }

    let observations: LocationObservation[];
    try {
      observations = await fetchWindow(provider, window, options);
    } catch (error) {
      results.push({
        sourceId: source.id,
        status: "failed",
        fetched: 0,
        dayWritten: false,
        stateSaved: false,
        ...(error instanceof Error && error.name === "AbortError"
          ? { error: "aborted" }
          : { error: sanitizeProviderError(error) }),
      });
      continue;
    }

    try {
      options.signal?.throwIfAborted();
      const segments = observationSegments(observations, window, {
        retainCoordinates: options.config.retainCoordinates,
      });
      const payload = { observationCount: observations.length, segments, providerDisplayName: provider.displayName };
      const merged = await mergeDaySources(options.memoryDir, source.id, options.date, payload);
      let dayWritten = false;
      if (Object.values(merged).some((entry) => entry.observationCount > 0)) {
        const body = composeLocationDayBody(options.date, options.config.timezone, merged);
        const meta = composeLocationDayMeta(options.date, options.config.timezone, merged, body);
        dayWritten = await writeLocationDay(options.memoryDir, options.date, serializeLocationDay(meta, body));
      }
      // State advances only after the durable day write above succeeded.
      await updateLocationSourceDay(
        options.memoryDir,
        source.id,
        options.date,
        payload,
        now().toISOString(),
      );
      results.push({
        sourceId: source.id,
        status: "synced",
        fetched: observations.length,
        dayWritten,
        stateSaved: true,
      });
    } catch (error) {
      results.push({
        sourceId: source.id,
        status: "failed",
        fetched: observations.length,
        dayWritten: false,
        stateSaved: false,
        ...(error instanceof Error && error.name === "AbortError"
          ? { error: "aborted" }
          : { error: sanitizeProviderError(error) }),
      });
    }
  }
  return results;
}

/**
 * The day-document source map: this source's fresh payload plus every OTHER
 * source's last-known payload from sync state. Rendered documents therefore
 * survive a re-sync of one source without re-fetching the others.
 */
async function mergeDaySources(
  memoryDir: string,
  sourceId: string,
  date: string,
  payload: { observationCount: number; segments: LocationSegment[] },
): Promise<Record<string, LocationDaySourceEntry>> {
  const state = await loadLocationSyncState(memoryDir);
  const merged: Record<string, LocationDaySourceEntry> = {};
  for (const [otherId, otherState] of Object.entries(state.sources)) {
    if (otherId === sourceId) continue;
    const day = otherState.days?.[date];
    if (day === undefined) continue;
    merged[otherId] = { ...day, segments: [...day.segments] };
  }
  merged[sourceId] = payload;
  return merged;
}
