/**
 * Location context subsystem — shared types (issue #2044).
 *
 * A host-agnostic foundation: the provider contract, the observation/day
 * shapes, and health-check results. No HTTP client lives here — providers are
 * registered from host adapters (a future provider package is one such
 * adapter), keeping `@remnic/core` free of host SDKs and network specifics.
 *
 * All timestamps are UTC ISO-8601; day bucketing is half-open [start, end).
 */

/** A named place the user was observed at. */
export interface LocationPlace {
  /** Provider-stable place identifier. */
  id: string;
  /** Human-readable label, already redacted by the provider. */
  label: string;
  kind?: "home" | "work" | "poi" | "transit" | "other";
  /** Present only when coordinate retention is enabled. */
  latitude?: number;
  longitude?: number;
}

export interface LocationObservation {
  /** UTC ISO-8601 observation instant. */
  observedAtUtc: string;
  place: LocationPlace;
  /** Provider confidence in [0,1], when reported. */
  confidence?: number;
}

/** One page of observations from a provider fetch. */
export interface LocationObservationPage {
  observations: LocationObservation[];
  nextCursor: string | null;
}

/** Result of a provider auth/health probe. */
export interface LocationProviderCheck {
  ok: boolean;
  detail?: string;
}

/**
 * Provider contract for a location source. Implemented by host adapters and
 * registered in `registry.ts`; core never statically imports a provider
 * package, so à-la-carte installs stay partial (a source whose provider is
 * not registered is skipped, not an error).
 */
export interface LocationProvider {
  /** Stable provider id (registry key; matches a config source id). */
  id: string;
  displayName: string;
  /** Probe connectivity/auth without mutating anything. */
  verify(signal?: AbortSignal): Promise<LocationProviderCheck>;
  /** Fetch every observation in the half-open [startUtc, endUtc) window. */
  fetchObservations(opts: {
    startUtc: string;
    endUtc: string;
    cursor?: string | null;
    signal?: AbortSignal;
  }): Promise<LocationObservationPage>;
}

/** One configured location source: a registered provider plus its toggle. */
export interface LocationSourceConfig {
  /** Must match a registered provider id. */
  id: string;
  /** `false` short-circuits this source only. */
  enabled: boolean;
}

/** Opt-in location synchronization settings. */
export interface LocationConfig {
  /** Master gate: `false` short-circuits every location path. */
  enabled: boolean;
  /** IANA timezone used to bucket observations into local days. */
  timezone: string;
  /** Number of local days to synchronize per run; integer 1..90. */
  syncDays: number;
  /**
   * When `false` (the default), place coordinates are dropped before any
   * persistence, rendering, or error reporting — only place labels remain.
   */
  retainCoordinates: boolean;
  sources: LocationSourceConfig[];
  /**
   * Minimum dominant-place overlap (seconds) required to tag a memory.
   * `0` disables the overlap floor. Integer ≥ 0; default 300.
   */
  minimumOverlapSeconds: number;
  /**
   * Minimum provider-reported place confidence in [0,1] for a tagging
   * match. Providers that report no confidence pass this gate (there is
   * nothing to doubt), reported values below it fail. Default 0.7.
   */
  minimumConfidence: number;
  /** Provider-owned location tagging gates (issue #2046). */
  tagging: LocationTaggingConfig;
}

/** Opt-in gates for attaching provider location context to memories. */
export interface LocationTaggingConfig {
  /** `false` (default) disables every memory-tagging path. */
  enabled: boolean;
  /** Extra gate for the historical backfill command; default `false`. */
  backfillEnabled: boolean;
}

/** A time-resolved place visit derived from consecutive observations. */
export interface LocationSegment {
  startUtc: string;
  endUtc: string;
  place: LocationPlace;
  /** Minimum contributing observation confidence, when any was reported. */
  confidence?: number;
}
