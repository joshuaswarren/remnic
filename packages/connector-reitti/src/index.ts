/**
 * @remnic/connector-reitti — Reitti location provider (issue #2045).
 *
 * Optional adapter around the core location contract (#2044): an API client
 * and normalizer only. No file I/O, memory writes, config parsing, host SDK
 * imports, or LLM calls. `@remnic/core` never imports this package — hosts
 * register the provider through the core location registry, ideally via a
 * computed-specifier dynamic import so bundlers cannot statically resolve it:
 *
 *   const mod = await import("@remnic/" + "connector-reitti");
 *   mod.ensureReittiProviderRegistered({ baseUrl, token, timezone });
 *
 * Gates: the master `location.enabled=false` and source `enabled=false`
 * short-circuits live in core config and the core pipeline — the provider is
 * never consulted for a disabled source. Tokens arrive pre-resolved from
 * Remnic's secret reference mechanism and never reach logs or error text.
 */

import {
  getLocationProvider,
  isValidLocationDate,
  registerLocationProvider,
  type LocationObservationPage,
  type LocationProvider,
} from "@remnic/core/location";

import {
  ReittiApiError,
  ReittiClient,
  assertReittiTimezone,
  normalizeReittiBaseUrl,
  type ReittiAuthMode,
} from "./client.js";
import { timelineObservations, visitSummaryObservations } from "./normalize.js";

export {
  ReittiApiError,
  ReittiClient,
  REITTI_AUTH_MODES,
  REITTI_PLACE_TYPES,
  REITTI_TRANSPORT_MODES,
  assertReittiTimezone,
  normalizeReittiBaseUrl,
} from "./client.js";
export type {
  ReittiAuthMode,
  ReittiClientOptions,
  ReittiDayRequest,
  ReittiErrorKind,
  ReittiPlaceType,
  ReittiPlaceVisitSummary,
  ReittiSignificantPlace,
  ReittiTimelineEntry,
  ReittiTransportMode,
  ReittiVisitDetail,
} from "./client.js";
export { timelineObservations, visitSummaryObservations } from "./normalize.js";
export type { LocationWindow } from "./normalize.js";

export const REITTI_PROVIDER_ID = "reitti";
export const REITTI_PROVIDER_DISPLAY_NAME = "Reitti";

/** Second-page cursor the provider offers when the visits fallback fires. */
export const REITTI_VISITS_CURSOR = "visits";

export interface ReittiProviderOptions {
  /** Absolute HTTP(S) base URL of the self-hosted instance. */
  baseUrl: string;
  /** Pre-resolved API token from Remnic's secret reference mechanism. */
  token: string;
  /** Which documented header form to use; exactly one is sent. */
  authMode?: ReittiAuthMode;
  /** IANA zone used to bucket observations into local days (from location config). */
  timezone: string;
  /**
   * When `true`, an empty timeline day falls back to `/api/v1/visits` as the
   * place/visit source (second page, `REITTI_VISITS_CURSOR`). Default `false`.
   */
  visitsFallback?: boolean;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

export function createReittiProvider(options: ReittiProviderOptions): LocationProvider {
  normalizeReittiBaseUrl(options.baseUrl);
  if (typeof options.token !== "string" || options.token.trim().length === 0) {
    throw new TypeError("Reitti provider requires a non-empty token (resolve the secret reference first)");
  }
  assertReittiTimezone(options.timezone);
  if (options.visitsFallback !== undefined && typeof options.visitsFallback !== "boolean") {
    throw new TypeError("Reitti visitsFallback must be a boolean");
  }
  const client = new ReittiClient({
    baseUrl: options.baseUrl,
    token: options.token,
    authMode: options.authMode,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
    maxResponseBytes: options.maxResponseBytes,
    sleep: options.sleep,
  });
  const timezone = options.timezone;
  const visitsFallback = options.visitsFallback ?? false;
  const dayFormatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const localDate = (ms: number): string => dayFormatter.format(new Date(ms));
  const now = options.now ?? (() => new Date());

  return {
    id: REITTI_PROVIDER_ID,
    displayName: REITTI_PROVIDER_DISPLAY_NAME,

    async verify(signal) {
      try {
        const date = localDate(now().getTime());
        if (!isValidLocationDate(date)) {
          return { ok: false, detail: `could not derive a valid local date in ${timezone}` };
        }
        await client.fetchTimeline({ date, timezone, signal });
        return { ok: true };
      } catch (error) {
        // A caller-driven abort is cancellation, not provider unavailability.
        if (error instanceof Error && error.name === "AbortError") throw error;
        if (error instanceof ReittiApiError && error.kind === "auth") {
          return {
            ok: false,
            detail: "Reitti rejected the token (401/403) — check the token value and authMode",
          };
        }
        return { ok: false, detail: error instanceof Error ? error.name : "Reitti probe failed" };
      }
    },

    async fetchObservations(opts): Promise<LocationObservationPage> {
      const startMs = Date.parse(opts.startUtc);
      const endMs = Date.parse(opts.endUtc);
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs >= endMs) {
        throw new RangeError(
          `Reitti window must satisfy finite startUtc < endUtc, got [${opts.startUtc}, ${opts.endUtc})`,
        );
      }
      if (opts.cursor !== null && opts.cursor !== undefined && opts.cursor !== REITTI_VISITS_CURSOR) {
        throw new TypeError(`Reitti provider received an unknown cursor "${opts.cursor}"`);
      }
      const date = localDate(startMs);
      if (!isValidLocationDate(date)) {
        throw new RangeError(`Reitti provider could not derive a valid local date from "${opts.startUtc}" in ${timezone}`);
      }
      const window = { startUtc: opts.startUtc, endUtc: opts.endUtc };

      if (opts.cursor === REITTI_VISITS_CURSOR) {
        const summaries = await client.fetchVisits({ date, timezone, signal: opts.signal });
        return { observations: visitSummaryObservations(summaries, window), nextCursor: null };
      }
      const entries = await client.fetchTimeline({ date, timezone, signal: opts.signal });
      const observations = timelineObservations(entries, window);
      // Empty day vs failure (§22): a valid empty timeline is an explicit
      // empty result; the visits fallback, when enabled, is a second page.
      if (visitsFallback && observations.length === 0) {
        return { observations, nextCursor: REITTI_VISITS_CURSOR };
      }
      return { observations, nextCursor: null };
    },
  };
}

/**
 * Idempotently register the Reitti provider with the core location registry.
 * Returns `true` when this call performed the registration, `false` when a
 * provider with this id was already registered.
 */
export function ensureReittiProviderRegistered(options: ReittiProviderOptions): boolean {
  if (getLocationProvider(REITTI_PROVIDER_ID) !== undefined) return false;
  registerLocationProvider(createReittiProvider(options));
  return true;
}
