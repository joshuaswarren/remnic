/**
 * Minimal Reitti API client (raw fetch, no SDK).
 *
 * Read-only, current-user endpoints only (issue #2045):
 *   GET /api/v1/timeline?date=YYYY-MM-DD&timezone=<IANA>
 *   GET /api/v1/visits?date=YYYY-MM-DD&timezone=<IANA>
 * Never /api/v1/visits/{userId} and never raw location-point endpoints.
 *
 * Auth uses exactly ONE configured header form — `X-API-Token` or
 * `Authorization: Bearer` — never both. The token never appears in any
 * error message, URL, or log line produced here.
 *
 * Transport distinguishes empty results from failures (§22): a valid empty
 * day is `[]`, while auth, rate-limit, server, network, timeout, JSON, size,
 * and schema problems are distinct `ReittiApiError` kinds. Retries apply to
 * transient GET failures only, always preserve the caller's abort signal,
 * and never advance any state (the client is stateless).
 */

import { isValidLocationDate } from "@remnic/core/location";

export type ReittiAuthMode = "x-api-token" | "bearer";

export const REITTI_AUTH_MODES = ["x-api-token", "bearer"] as const;

/** Reitti `TransportMode` values the normalizer preserves in trip labels. */
export const REITTI_TRANSPORT_MODES = [
  "WALKING",
  "CYCLING",
  "DRIVING",
  "TRAIN",
  "TRANSIT",
  "MOTORCYCLE",
  "SCOOTER",
  "AIRPLANE",
  "UNKNOWN",
] as const;

/** Reitti `SignificantPlace.PlaceType` values (upstream main, 2026-08). */
export const REITTI_PLACE_TYPES = [
  "RESTAURANT",
  "PARK",
  "SHOP",
  "HOME",
  "WORK",
  "HOSPITAL",
  "SCHOOL",
  "AIRPORT",
  "TRAIN_STATION",
  "GAS_STATION",
  "HOTEL",
  "BANK",
  "PHARMACY",
  "GYM",
  "LIBRARY",
  "CHURCH",
  "CINEMA",
  "CAFE",
  "MUSEUM",
  "LANDMARK",
  "TOURIST_ATTRACTION",
  "HISTORIC_SITE",
  "MONUMENT",
  "SHOPPING_MALL",
  "MARKET",
  "GALLERY",
  "THEATER",
  "GROCERY_STORE",
  "ATM",
  "OTHER",
] as const;

export type ReittiTransportMode = (typeof REITTI_TRANSPORT_MODES)[number];
export type ReittiPlaceType = (typeof REITTI_PLACE_TYPES)[number];

/** The place fields this connector consumes; other upstream fields are ignored. */
export interface ReittiSignificantPlace {
  id: number | string | null;
  name: string | null;
  address: string | null;
  city: string | null;
  type: ReittiPlaceType | null;
}

/** A validated `/api/v1/timeline` row (VISIT or TRIP). */
export interface ReittiTimelineEntry {
  id: string;
  type: "VISIT" | "TRIP";
  startTime: string;
  endTime: string;
  place: ReittiSignificantPlace | null;
  transportMode: ReittiTransportMode | null;
  distanceMeters: number | null;
}

/** A validated visit interval inside a `/api/v1/visits` place summary. */
export interface ReittiVisitDetail {
  startTime: string;
  endTime: string;
}

/** A validated `/api/v1/visits` place summary. */
export interface ReittiPlaceVisitSummary {
  place: ReittiSignificantPlace;
  visits: ReittiVisitDetail[];
}

export type ReittiErrorKind =
  | "auth"
  | "rate-limit"
  | "server"
  | "network"
  | "timeout"
  | "invalid-json"
  | "response-too-large"
  | "schema"
  | "http";

const RETRYABLE_KINDS: readonly ReittiErrorKind[] = ["rate-limit", "server", "network", "timeout"];

export class ReittiApiError extends Error {
  readonly kind: ReittiErrorKind;
  readonly status?: number;

  constructor(message: string, kind: ReittiErrorKind, status?: number) {
    super(message);
    this.name = "ReittiApiError";
    this.kind = kind;
    this.status = status;
  }

  get retryable(): boolean {
    return RETRYABLE_KINDS.includes(this.kind);
  }
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 3;
const MAX_RETRY_DELAY_MS = 30_000;
const DEFAULT_MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

export interface ReittiClientOptions {
  /** Absolute HTTP(S) base URL of the self-hosted Reitti instance. */
  baseUrl: string;
  /** Pre-resolved API token (from the secret store); never a placeholder. */
  token: string;
  /** Which documented header form to use; exactly one is sent. */
  authMode?: ReittiAuthMode;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface ReittiDayRequest {
  date: string;
  timezone: string;
  signal?: AbortSignal;
}

/** Canonical boundary guard for this package: a non-null plain object (arrays are caught by field checks). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

/** Validate an IANA timezone by constructing a formatter (throws RangeError). */
export function assertValidIanaTimezone(timezone: string): void {
  if (typeof timezone !== "string" || timezone.length === 0) {
    throw new TypeError("Reitti timezone must be a non-empty IANA zone string");
  }
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: timezone });
  } catch {
    throw new RangeError(`Reitti timezone "${timezone}" is not a valid IANA zone`);
  }
}

/**
 * Validate and normalize the base URL: absolute HTTP(S), trailing slashes
 * stripped without touching path semantics (a sub-path install keeps its
 * prefix). Loop instead of a `/\/+$/` regex — CodeQL polynomial-redos.
 */
export function normalizeReittiBaseUrl(raw: string): string {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new TypeError("Reitti baseUrl must be a non-empty string");
  }
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    throw new RangeError(`Reitti baseUrl "${raw}" is not a valid absolute URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new RangeError(`Reitti baseUrl must be http(s), got "${parsed.protocol}"`);
  }
  let path = parsed.pathname;
  while (path.length > 1 && path.endsWith("/")) {
    path = path.slice(0, -1);
  }
  return `${parsed.protocol}//${parsed.host}${path === "/" ? "" : path}`;
}

function assertFiniteInstant(iso: unknown, what: string): string {
  if (typeof iso !== "string" || iso.length === 0 || !Number.isFinite(Date.parse(iso))) {
    throw new ReittiApiError(`Reitti timeline entry has an invalid ${what}`, "schema");
  }
  return iso;
}

function parsePlace(value: unknown, context: string): ReittiSignificantPlace | null {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) {
    throw new ReittiApiError(`Reitti ${context} place must be an object or null`, "schema");
  }
  const id = value.id;
  if (id !== null && id !== undefined && typeof id !== "number" && typeof id !== "string") {
    throw new ReittiApiError(`Reitti ${context} place.id must be a number, string, or null`, "schema");
  }
  for (const field of ["name", "address", "city"] as const) {
    const raw = value[field];
    if (raw !== null && raw !== undefined && typeof raw !== "string") {
      throw new ReittiApiError(`Reitti ${context} place.${field} must be a string or null`, "schema");
    }
  }
  const type = value.type;
  if (type !== null && type !== undefined && !(REITTI_PLACE_TYPES as readonly string[]).includes(type as string)) {
    throw new ReittiApiError(`Reitti ${context} place.type "${String(type)}" is not a known Reitti place type`, "schema");
  }
  return {
    id: (id ?? null) as ReittiSignificantPlace["id"],
    name: (value.name ?? null) as string | null,
    address: (value.address ?? null) as string | null,
    city: (value.city ?? null) as string | null,
    type: (type ?? null) as ReittiPlaceType | null,
  };
}

function parseTimelineEntry(value: unknown): ReittiTimelineEntry {
  if (!isRecord(value)) {
    throw new ReittiApiError("Reitti timeline row must be an object", "schema");
  }
  if (value.id === undefined || typeof value.id !== "string" || value.id.length === 0) {
    throw new ReittiApiError("Reitti timeline row requires a non-empty string id", "schema");
  }
  if (value.type !== "VISIT" && value.type !== "TRIP") {
    throw new ReittiApiError(
      `Reitti timeline row type "${String(value.type)}" must be VISIT or TRIP`,
      "schema",
    );
  }
  const distance = value.distanceMeters;
  if (
    distance !== null &&
    distance !== undefined &&
    (typeof distance !== "number" || !Number.isFinite(distance) || distance < 0)
  ) {
    throw new ReittiApiError("Reitti timeline row distanceMeters must be a non-negative number or null", "schema");
  }
  const mode = value.transportMode;
  if (
    mode !== null &&
    mode !== undefined &&
    !(REITTI_TRANSPORT_MODES as readonly string[]).includes(mode as string)
  ) {
    throw new ReittiApiError(
      `Reitti timeline row transportMode "${String(mode)}" is not a known Reitti transport mode`,
      "schema",
    );
  }
  return {
    id: value.id,
    type: value.type,
    startTime: assertFiniteInstant(value.startTime, "startTime"),
    endTime: assertFiniteInstant(value.endTime, "endTime"),
    place: parsePlace(value.place, "timeline"),
    transportMode: (mode ?? null) as ReittiTransportMode | null,
    distanceMeters: (distance ?? null) as number | null,
  };
}

function parseVisitSummary(value: unknown): ReittiPlaceVisitSummary {
  if (!isRecord(value)) {
    throw new ReittiApiError("Reitti visit summary must be an object", "schema");
  }
  const rawVisits = value.visits;
  if (!Array.isArray(rawVisits)) {
    throw new ReittiApiError("Reitti visit summary requires a visits array", "schema");
  }
  const visits: ReittiVisitDetail[] = rawVisits.map((visit) => {
    if (!isRecord(visit)) {
      throw new ReittiApiError("Reitti visit detail must be an object", "schema");
    }
    return {
      startTime: assertFiniteInstant(visit.startTime, "visit startTime"),
      endTime: assertFiniteInstant(visit.endTime, "visit endTime"),
    };
  });
  return { place: parsePlace(value.placeInfo, "visit summary") ?? {
    id: null,
    name: null,
    address: null,
    city: null,
    type: null,
  }, visits };
}

export class ReittiClient {
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly authMode: ReittiAuthMode;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: ReittiClientOptions) {
    if (typeof options.token !== "string" || options.token.trim().length === 0) {
      throw new TypeError("Reitti token must be a non-empty string (resolve the secret reference first)");
    }
    this.token = options.token.trim();
    this.baseUrl = normalizeReittiBaseUrl(options.baseUrl);
    const authMode = options.authMode ?? "x-api-token";
    if (!(REITTI_AUTH_MODES as readonly string[]).includes(authMode)) {
      throw new RangeError(`Reitti authMode "${String(authMode)}" must be one of ${REITTI_AUTH_MODES.join(", ")}`);
    }
    this.authMode = authMode;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    this.sleep = options.sleep ?? defaultSleep;
  }

  /** Every VISIT/TRIP entry overlapping the local day (primary source). */
  async fetchTimeline(request: ReittiDayRequest): Promise<ReittiTimelineEntry[]> {
    assertValidIanaTimezone(request.timezone);
    if (!isValidLocationDate(request.date)) {
      throw new RangeError(`Reitti date "${request.date}" must be a real YYYY-MM-DD day`);
    }
    const payload = await this.requestJson(
      `/api/v1/timeline?date=${encodeURIComponent(request.date)}&timezone=${encodeURIComponent(request.timezone)}`,
      request.signal,
    );
    if (!Array.isArray(payload)) {
      throw new ReittiApiError("Reitti /api/v1/timeline returned a non-array body", "schema");
    }
    return payload.map(parseTimelineEntry);
  }

  /** Processed visits grouped by place (fallback/enrichment source). */
  async fetchVisits(request: ReittiDayRequest): Promise<ReittiPlaceVisitSummary[]> {
    assertValidIanaTimezone(request.timezone);
    if (!isValidLocationDate(request.date)) {
      throw new RangeError(`Reitti date "${request.date}" must be a real YYYY-MM-DD day`);
    }
    const payload = await this.requestJson(
      `/api/v1/visits?date=${encodeURIComponent(request.date)}&timezone=${encodeURIComponent(request.timezone)}`,
      request.signal,
    );
    if (!isRecord(payload) || !Array.isArray(payload.places)) {
      throw new ReittiApiError("Reitti /api/v1/visits returned an unexpected body (missing places array)", "schema");
    }
    return payload.places.map(parseVisitSummary);
  }

  private async requestJson(pathAndQuery: string, signal?: AbortSignal): Promise<unknown> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      signal?.throwIfAborted();
      const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
      const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
      let response: Response;
      try {
        response = await this.fetchImpl(`${this.baseUrl}${pathAndQuery}`, {
          method: "GET",
          headers: this.authHeaders(),
          signal: combined,
        });
      } catch (err) {
        // The caller's abort always propagates unwrapped and unretried.
        if (signal?.aborted) throw err;
        lastError = timeoutSignal.aborted
          ? new ReittiApiError(`Reitti request timed out after ${this.timeoutMs}ms`, "timeout")
          : new ReittiApiError(`Reitti request failed: ${err instanceof Error ? err.name : String(err)}`, "network");
        if (attempt < MAX_RETRIES) {
          await this.sleep(backoffMs(attempt));
          continue;
        }
        throw lastError;
      }

      if (response.status === 429 || response.status >= 500) {
        discardBody(response);
        lastError = new ReittiApiError(`Reitti API responded ${response.status}`, kindForStatus(response.status), response.status);
        if (attempt < MAX_RETRIES) {
          await this.sleep(await retryDelayMs(response, attempt));
          continue;
        }
        throw lastError;
      }
      if (!response.ok) {
        discardBody(response);
        throw new ReittiApiError(
          `Reitti API responded ${response.status} for ${pathAndQuery.split("?")[0]}`,
          kindForStatus(response.status),
          response.status,
        );
      }
      const text = await this.readBounded(response);
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new ReittiApiError("Reitti API returned a non-JSON body", "invalid-json");
      }
    }
    throw lastError instanceof Error ? lastError : new ReittiApiError("Reitti API request failed", "network");
  }

  /** Exactly one auth header, per the configured mode — never both. */
  private authHeaders(): Record<string, string> {
    return this.authMode === "bearer"
      ? { Authorization: `Bearer ${this.token}`, Accept: "application/json" }
      : { "X-API-Token": this.token, Accept: "application/json" };
  }

  private async readBounded(response: Response): Promise<string> {
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > this.maxResponseBytes) {
      discardBody(response);
      throw new ReittiApiError(
        `Reitti response exceeds the ${this.maxResponseBytes}-byte bound (${declared} bytes declared)`,
        "response-too-large",
      );
    }
    const reader = response.body?.getReader();
    if (reader === undefined) {
      const text = await response.text();
      if (Buffer.byteLength(text, "utf8") > this.maxResponseBytes) {
        throw new ReittiApiError(`Reitti response exceeds the ${this.maxResponseBytes}-byte bound`, "response-too-large");
      }
      return text;
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value?.byteLength ?? 0;
      if (total > this.maxResponseBytes) {
        await reader.cancel().catch(() => {});
        throw new ReittiApiError(`Reitti response exceeds the ${this.maxResponseBytes}-byte bound`, "response-too-large");
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  }
}

function kindForStatus(status: number): ReittiErrorKind {
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate-limit";
  if (status >= 500) return "server";
  return "http";
}

function defaultSleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

/** Release the socket back to the pool on error paths (unconsumed bodies pin it). */
function discardBody(response: Response): void {
  void response.body?.cancel().catch(() => {});
}


/** Loop instead of `/\/+$/` — CodeQL js/polynomial-redos on user-set URLs. */
function backoffMs(attempt: number): number {
  return Math.min(MAX_RETRY_DELAY_MS, 1_000 * 2 ** attempt);
}

async function retryDelayMs(response: Response, attempt: number): Promise<number> {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter !== null && /^\d+$/.test(retryAfter)) {
    return Math.min(MAX_RETRY_DELAY_MS, Number(retryAfter) * 1_000);
  }
  return backoffMs(attempt);
}
