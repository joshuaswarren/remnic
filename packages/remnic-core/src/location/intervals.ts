/**
 * Location interval math (issue #2044).
 *
 * Pure, deterministic helpers over UTC ISO-8601 instants: half-open
 * [start, end) day windows (reusing the DST-correct activity day-window), IANA
 * local-day bucketing, overlap, observation→segment dwell, and dominant-place
 * selection with stable tie-breaking. No IO, no clocks, no randomness.
 */

import { activityDayWindow, isValidActivityDate } from "../activity/digest.js";
import type { LocationObservation, LocationPlace, LocationSegment } from "./types.js";

export function isValidLocationDate(date: string): boolean {
  return isValidActivityDate(date);
}

/** Half-open [start, end) UTC ISO bounds of a local day. */
export function locationDayWindow(date: string, timezone: string): { startUtc: string; endUtc: string } {
  if (!isValidActivityDate(date)) {
    throw new RangeError(`Invalid location date "${date}"; expected a real YYYY-MM-DD day.`);
  }
  return activityDayWindow(date, timezone);
}

function assertFiniteInstant(iso: string, what: string): number {
  const ms = Date.parse(iso);
  if (typeof iso !== "string" || !Number.isFinite(ms)) {
    throw new RangeError(`${what} must be a UTC ISO-8601 instant; got "${String(iso)}"`);
  }
  return ms;
}

/** The IANA local calendar day (YYYY-MM-DD) an instant falls in. */
export function localDayKey(instantUtc: string, timezone: string): string {
  assertFiniteInstant(instantUtc, "instantUtc");
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(instantUtc));
}

function compareObservations(a: LocationObservation, b: LocationObservation): number {
  if (a.observedAtUtc !== b.observedAtUtc) {
    return a.observedAtUtc < b.observedAtUtc ? -1 : 1;
  }
  // Total comparator (§12): equal-key observations fall back to place id so
  // ordering — and therefore dwell attribution — is deterministic.
  if (a.place.id !== b.place.id) {
    return a.place.id < b.place.id ? -1 : 1;
  }
  return 0;
}

/** Bucket observations into their IANA local days, sorted within each day. */
export function bucketObservationsByDay(
  observations: readonly LocationObservation[],
  timezone: string,
): Map<string, LocationObservation[]> {
  const buckets = new Map<string, LocationObservation[]>();
  for (const observation of observations) {
    assertFiniteInstant(observation.observedAtUtc, "observation observedAtUtc");
    const key = localDayKey(observation.observedAtUtc, timezone);
    const bucket = buckets.get(key);
    if (bucket === undefined) buckets.set(key, [observation]);
    else bucket.push(observation);
  }
  for (const bucket of buckets.values()) bucket.sort(compareObservations);
  return buckets;
}

/** Overlap in ms of two half-open intervals; 0 when disjoint. */
export function intervalOverlapMs(
  a: { startUtc: string; endUtc: string },
  b: { startUtc: string; endUtc: string },
): number {
  const overlap =
    Math.min(Date.parse(a.endUtc), Date.parse(b.endUtc)) - Math.max(Date.parse(a.startUtc), Date.parse(b.startUtc));
  return Math.max(0, overlap);
}

function placeForSegment(place: LocationPlace, retainCoordinates: boolean): LocationPlace {
  if (retainCoordinates || place.latitude === undefined || place.longitude === undefined) {
    return place;
  }
  return {
    id: place.id,
    label: place.label,
    ...(place.kind === undefined ? {} : { kind: place.kind }),
  };
}

/**
 * Derive place-visit segments from a day's observations: each observation
 * covers [its instant, the next observation's instant ∩ window end). The last
 * observation is capped by the window end, so dwell never crosses the day
 * boundary. Out-of-window observations are a provider contract violation and
 * are rejected loudly rather than silently reshaping the day. Coordinates are
 * stripped unless `retainCoordinates` is set.
 */
export function observationSegments(
  observations: readonly LocationObservation[],
  window: { startUtc: string; endUtc: string },
  options: { retainCoordinates: boolean },
): LocationSegment[] {
  const startMs = assertFiniteInstant(window.startUtc, "window startUtc");
  const endMs = assertFiniteInstant(window.endUtc, "window endUtc");
  if (startMs >= endMs) {
    throw new RangeError("location window must satisfy startUtc < endUtc");
  }
  const ordered = [...observations].sort(compareObservations);
  const segments: LocationSegment[] = [];
  for (let index = 0; index < ordered.length; index += 1) {
    const current = ordered[index]!;
    const currentMs = Date.parse(current.observedAtUtc);
    if (currentMs < startMs || currentMs >= endMs) {
      throw new RangeError(
        `location observation at "${current.observedAtUtc}" falls outside the requested [${window.startUtc}, ${window.endUtc}) window`,
      );
    }
    const nextMs =
      index + 1 < ordered.length ? Date.parse(ordered[index + 1]!.observedAtUtc) : endMs;
    const segmentEndMs = Math.min(nextMs, endMs);
    if (currentMs >= segmentEndMs) continue;
    segments.push({
      startUtc: new Date(currentMs).toISOString(),
      endUtc: new Date(segmentEndMs).toISOString(),
      place: placeForSegment(current.place, options.retainCoordinates),
      ...(current.confidence !== undefined ? { confidence: current.confidence } : {}),
    });
  }
  return segments;
}

/** Total time a place was occupied (union of its segment intervals, ms). */
export interface PlaceDuration {
  place: LocationPlace;
  totalMs: number;
  /** Earliest segment start contributing to this place's total. */
  firstStartUtc: string;
}

function unionIntervalMs(segments: readonly LocationSegment[]): number {
  // Merge overlapping [start, end) intervals per place so two providers
  // observing the same visit do not double-count its duration.
  const bounds = segments
    .map((segment) => ({ start: Date.parse(segment.startUtc), end: Date.parse(segment.endUtc) }))
    .sort((a, b) => (a.start !== b.start ? a.start - b.start : a.end - b.end));
  let total = 0;
  let sweepStart: number | null = null;
  let sweepEnd = 0;
  for (const bound of bounds) {
    if (sweepStart === null || bound.start > sweepEnd) {
      if (sweepStart !== null) total += sweepEnd - sweepStart;
      sweepStart = bound.start;
      sweepEnd = bound.end;
    } else if (bound.end > sweepEnd) {
      sweepEnd = bound.end;
    }
  }
  if (sweepStart !== null) total += sweepEnd - sweepStart;
  return total;
}

/** Per-place totals across every segment given (multi-source safe). */
export function placeDurations(segments: readonly LocationSegment[]): PlaceDuration[] {
  const byPlace = new Map<string, { place: LocationPlace; segments: LocationSegment[]; firstStartUtc: string }>();
  for (const segment of segments) {
    const existing = byPlace.get(segment.place.id);
    if (existing === undefined) {
      byPlace.set(segment.place.id, { place: segment.place, segments: [segment], firstStartUtc: segment.startUtc });
      continue;
    }
    existing.segments.push(segment);
    if (segment.startUtc < existing.firstStartUtc) existing.firstStartUtc = segment.startUtc;
    // Two providers may label the same place id differently; keep the
    // lexicographically smallest label so rendering stays deterministic.
    if (segment.place.label < existing.place.label) existing.place = segment.place;
  }
  const durations: PlaceDuration[] = [...byPlace.values()].map((entry) => ({
    place: entry.place,
    totalMs: unionIntervalMs(entry.segments),
    firstStartUtc: entry.firstStartUtc,
  }));
  durations.sort((a, b) => {
    if (a.place.id !== b.place.id) return a.place.id < b.place.id ? -1 : 1;
    return 0;
  });
  return durations;
}

export interface DominantPlaceResult {
  place: LocationPlace;
  totalMs: number;
}

/**
 * The place with the longest total occupancy. Ties are stable and
 * deterministic: earlier first start wins, then the lexicographically smaller
 * place id — never insertion order.
 */
export function dominantPlace(segments: readonly LocationSegment[]): DominantPlaceResult | null {
  const durations = placeDurations(segments);
  let best: PlaceDuration | null = null;
  for (const duration of durations) {
    if (best === null) {
      best = duration;
      continue;
    }
    if (duration.totalMs !== best.totalMs) {
      if (duration.totalMs > best.totalMs) best = duration;
      continue;
    }
    if (duration.firstStartUtc !== best.firstStartUtc) {
      if (duration.firstStartUtc < best.firstStartUtc) best = duration;
      continue;
    }
    if (duration.place.id < best.place.id) best = duration;
  }
  return best === null ? null : { place: best.place, totalMs: best.totalMs };
}
