/**
 * Reitti payload normalization (issue #2045).
 *
 * Maps validated `/api/v1/timeline` entries (VISIT/TRIP) and `/api/v1/visits`
 * place summaries onto the core `LocationObservation` instant model.
 *
 * Encoding: each interval becomes two observations — one at its start, one at
 * its end, both carrying the interval's place. Core's `observationSegments`
 * merges consecutive same-place observations back into half-open segments,
 * so this is the exact inverse: `A[8,9] T[9,10] B[10,11]` round-trips as
 * place-day segments without gaps.
 *
 * Preservation rules (the core observation type is intentionally narrow):
 * - place ids: `reitti:place:<placeId>` for named places; the entry id is
 *   embedded for synthetic ids (`reitti:trip:<id>`, `reitti:visit:<id>`)
 *   so source identifiers survive.
 * - nullable places: a TRIP (or a VISIT Reitti could not resolve) never
 *   invents a place name. TRIP becomes a `transit`-kind observation whose
 *   label carries the transport mode and distance; an unresolved VISIT
 *   becomes an `other`-kind observation labeled "Unnamed place".
 * - duration is start→end, reconstructible from the two instants.
 * - encoded paths (`path`) are ignored by design (no track storage).
 * - coordinates are never emitted; retention is a core config decision.
 *
 * Instants are clamped into the requested half-open [startUtc, endUtc)
 * window: Reitti returns day-overlapping entries, while core requires every
 * observation to fall inside the window it asked for.
 */

import type { LocationObservation, LocationPlace } from "@remnic/core/location";

import type {
  ReittiPlaceVisitSummary,
  ReittiSignificantPlace,
  ReittiTimelineEntry,
} from "./client.js";

export interface LocationWindow {
  startUtc: string;
  endUtc: string;
}

const PLACE_KIND_BY_REITTI_TYPE: Record<string, LocationPlace["kind"]> = {
  HOME: "home",
  WORK: "work",
};

function placeLabel(place: ReittiSignificantPlace): string {
  return place.name ?? place.address ?? place.city ?? `Place ${place.id ?? "?"}`;
}

function namedPlace(place: ReittiSignificantPlace): LocationPlace {
  return {
    id: `reitti:place:${place.id ?? "unknown"}`,
    label: placeLabel(place),
    kind: PLACE_KIND_BY_REITTI_TYPE[place.type ?? ""] ?? "poi",
  };
}

function tripPlace(entry: ReittiTimelineEntry): LocationPlace {
  const mode = entry.transportMode ?? "UNKNOWN";
  const km = entry.distanceMeters !== null && entry.distanceMeters > 0 ? ` · ${(entry.distanceMeters / 1000).toFixed(1)} km` : "";
  return { id: `reitti:trip:${entry.id}`, label: `Trip (${mode}${km})`, kind: "transit" };
}

function unnamedVisitPlace(entry: ReittiTimelineEntry): LocationPlace {
  return { id: `reitti:visit:${entry.id}`, label: "Unnamed place", kind: "other" };
}

function entryPlace(entry: ReittiTimelineEntry): LocationPlace {
  if (entry.type === "TRIP") return tripPlace(entry);
  return entry.place !== null ? namedPlace(entry.place) : unnamedVisitPlace(entry);
}

/**
 * Observations for one interval, clamped to the window. A whole-window entry
 * (started before the day, ends after it) yields observations at the window
 * edges so its occupancy still lands in the day document.
 */
function intervalObservations(
  startMs: number,
  endMs: number,
  place: LocationPlace,
  window: { startMs: number; endMs: number },
): LocationObservation[] {
  const clampedStart = Math.max(startMs, window.startMs);
  const clampedEnd = Math.min(endMs, window.endMs - 1);
  if (clampedStart > clampedEnd) return [];
  const instants = clampedStart === clampedEnd ? [clampedStart] : [clampedStart, clampedEnd];
  return instants.map((ms) => ({ observedAtUtc: new Date(ms).toISOString(), place }));
}

function windowBounds(window: LocationWindow): { startMs: number; endMs: number } {
  const startMs = Date.parse(window.startUtc);
  const endMs = Date.parse(window.endUtc);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs >= endMs) {
    throw new RangeError(`Reitti window must satisfy finite startUtc < endUtc, got [${window.startUtc}, ${window.endUtc})`);
  }
  return { startMs, endMs };
}

function sortByInstant(observations: LocationObservation[]): LocationObservation[] {
  return observations.sort((a, b) =>
    a.observedAtUtc === b.observedAtUtc ? 0 : a.observedAtUtc < b.observedAtUtc ? -1 : 1,
  );
}

/** Normalize validated timeline entries (primary source) into observations. */
export function timelineObservations(
  entries: readonly ReittiTimelineEntry[],
  window: LocationWindow,
): LocationObservation[] {
  const bounds = windowBounds(window);
  const observations: LocationObservation[] = [];
  for (const entry of entries) {
    const startMs = Date.parse(entry.startTime);
    const endMs = Date.parse(entry.endTime);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
      throw new RangeError(`Reitti timeline entry "${entry.id}" has non-finite instants`);
    }
    observations.push(...intervalObservations(startMs, endMs, entryPlace(entry), bounds));
  }
  return sortByInstant(observations);
}

/** Normalize validated visit summaries (fallback source) into observations. */
export function visitSummaryObservations(
  summaries: readonly ReittiPlaceVisitSummary[],
  window: LocationWindow,
): LocationObservation[] {
  const bounds = windowBounds(window);
  const observations: LocationObservation[] = [];
  for (const summary of summaries) {
    const place = namedPlace(summary.place);
    for (const visit of summary.visits) {
      const startMs = Date.parse(visit.startTime);
      const endMs = Date.parse(visit.endTime);
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
        throw new RangeError("Reitti visit detail has non-finite instants");
      }
      observations.push(...intervalObservations(startMs, endMs, place, bounds));
    }
  }
  return sortByInstant(observations);
}
