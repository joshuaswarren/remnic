/**
 * Core location matcher (issue #2046) — the ONE place that decides whether a
 * memory or wearable conversation gets provider location context.
 *
 * Pure and deterministic: no IO, no clocks, no randomness. Inputs are UTC
 * ISO-8601 instants and half-open [start, end) intervals everywhere.
 *
 * Rules (issue #2046 / umbrella #2043 decision D):
 * 1. A valid memory interval is required — derived ONLY from the memory's own
 *   bi-temporal frontmatter (`valid_at` / `observedAt` / `invalid_at`), never
 *   from wall-clock time or message order. Untimed memories stay untagged.
 * 2. Intervals longer than 24h describe long-lived facts, not events at a
 *   place; they stay untagged.
 * 3. A place is tagged only when it is DOMINANT (strictly the longest overlap
 *   among candidate places; ties are conflicts and leave the memory untagged)
 *   and meets `minimumOverlapSeconds` and `minimumConfidence`.
 * 4. Only resolved named places participate (`kind` home/work/poi): transit
 *   legs and unnamed visits never tag a memory.
 * 5. No address is ever inferred from text, coordinates, IP, or proximity —
 *   only provider-supplied place metadata is echoed, and coordinates only
 *   when `retainCoordinates` is enabled.
 *
 * Provider-owned metadata contract: the tag is `location:<stable-place-slug>`
 * and the opaque provider place id lives in structured attributes. Every
 * field the matcher writes is provider-owned; a memory that carries
 * location-ish metadata WITHOUT the `locationSource` marker is treated as
 * manual/user-authored and is never touched.
 */

import { TAG_LIMITS, STRUCTURED_ATTRIBUTE_LIMITS } from "../write-envelope.js";
import type { LocationPlace, LocationSegment } from "./types.js";

/** Maximum memory span eligible for location tagging. */
export const LOCATION_MATCH_MAX_MEMORY_SPAN_MS = 24 * 60 * 60 * 1000;

/** Prefix of provider-owned location tags. */
export const LOCATION_TAG_PREFIX = "location:";

/** Structured-attribute keys owned by the tagging pipeline (never manual). */
export const LOCATION_ATTRIBUTE_KEYS = [
  "locationSource",
  "locationPlaceId",
  "locationPlace",
  "locationConfidence",
  "locationVisitStart",
  "locationVisitEnd",
  "locationLatitude",
  "locationLongitude",
] as const;

/** Place kinds eligible for tagging: resolved, named places only. */
export const TAGGABLE_PLACE_KINDS: Record<string, true> = { home: true, work: true, poi: true };

export interface LocationTagPolicy {
  minimumOverlapSeconds: number;
  minimumConfidence: number;
  retainCoordinates: boolean;
}

/** The memory side of a match: a half-open interval, or a single instant. */
export type MemoryLocationWindow =
  | { kind: "interval"; startUtc: string; endUtc: string }
  | { kind: "instant"; atUtc: string };

/** Why a window was rejected before matching. */
export type WindowRejectReason = "untimed" | "span-too-long";

export interface WindowResult {
  window?: MemoryLocationWindow;
  /** Local days (YYYY-MM-DD in the tag policy timezone) the window touches. */
  days?: string[];
  rejected?: WindowRejectReason;
}

/**
 * Derive the match window from a memory's own frontmatter. `validAt` (the
 * event start; assumed copies carry the ingestion anchor) opens the window;
 * `invalid_at` closes it. An end-only memory (no start bound) is untimed.
 */
export function memoryLocationWindow(
  frontmatter: { valid_at?: string; observedAt?: string; invalid_at?: string },
  localDay: (instantUtc: string) => string,
): WindowResult {
  const start = frontmatter.valid_at ?? frontmatter.observedAt;
  if (start === undefined || Number.isNaN(Date.parse(start))) {
    return { rejected: "untimed" };
  }
  const end = frontmatter.invalid_at;
  if (end === undefined || Number.isNaN(Date.parse(end)) || Date.parse(end) <= Date.parse(start)) {
    return { window: { kind: "instant", atUtc: start }, days: [localDay(start)] };
  }
  if (Date.parse(end) - Date.parse(start) > LOCATION_MATCH_MAX_MEMORY_SPAN_MS) {
    return { rejected: "span-too-long" };
  }
  // The interval is half-open [start, end): its last instant is end-1ms, so a
  // memory ending exactly at local midnight never touches the next day.
  const lastInstant = new Date(Date.parse(end) - 1).toISOString();
  const days = [localDay(start)];
  const endDay = localDay(lastInstant);
  if (endDay !== days[0]) days.push(endDay);
  return { window: { kind: "interval", startUtc: start, endUtc: end }, days };
}

/** One source's segments for a day, keyed by the configured source id. */
export interface LocationSourceSegments {
  sourceId: string;
  segments: LocationSegment[];
}

export interface LocationMatch {
  sourceId: string;
  place: LocationPlace;
  /** Overlap (ms) with the window — interval mode; see `visitMs` otherwise. */
  overlapMs: number;
  /** Total dwell (ms) of the dominant place inside the window's day(s). */
  visitMs: number;
  /** Minimum contributing segment confidence, when any source reported one. */
  confidence?: number;
  /** Envelope [start, end) of the segments that produced the match. */
  visitStartUtc: string;
  visitEndUtc: string;
}

export type MatchOutcome =
  | { status: "matched"; match: LocationMatch }
  | { status: "unmatched"; reason: "no-overlap" | "ambiguous" | "below-minimum-overlap" | "below-minimum-confidence" };

interface PlaceAccumulator {
  sourceId: string;
  place: LocationPlace;
  overlapMs: number;
  visitMs: number;
  confidence: number | undefined;
  startUtc: string;
  endUtc: string;
}

function overlapMsOf(
  window: MemoryLocationWindow,
  segment: { startUtc: string; endUtc: string },
): number {
  if (window.kind === "instant") {
    const at = Date.parse(window.atUtc);
    return at >= Date.parse(segment.startUtc) && at < Date.parse(segment.endUtc) ? 1 : 0;
  }
  return Math.max(
    0,
    Math.min(Date.parse(window.endUtc), Date.parse(segment.endUtc)) -
      Math.max(Date.parse(window.startUtc), Date.parse(segment.startUtc)),
  );
}

/**
 * The dominant qualifying place for a window, across every source's
 * segments. Deterministic: strict overlap comparison, ties (conflicts) are
 * rejected, and equal-place contributions merge across sources.
 */
export function matchDominantPlace(
  window: MemoryLocationWindow,
  sources: readonly LocationSourceSegments[],
  policy: LocationTagPolicy,
): MatchOutcome {
  const byPlace = new Map<string, PlaceAccumulator>();
  for (const source of sources) {
    for (const segment of source.segments) {
      if (TAGGABLE_PLACE_KINDS[segment.place.kind ?? ""] !== true) continue;
      const overlap = overlapMsOf(window, segment);
      if (overlap <= 0) continue;
      const duration = Date.parse(segment.endUtc) - Date.parse(segment.startUtc);
      const existing = byPlace.get(segment.place.id);
      if (existing === undefined) {
        byPlace.set(segment.place.id, {
          sourceId: source.sourceId,
          place: segment.place,
          overlapMs: overlap,
          visitMs: duration,
          confidence: segment.confidence,
          startUtc: segment.startUtc,
          endUtc: segment.endUtc,
        });
        continue;
      }
      // Same place from another source (or a revisit): accumulate.
      existing.overlapMs += overlap;
      existing.visitMs += duration;
      existing.confidence =
        existing.confidence === undefined
          ? segment.confidence
          : segment.confidence === undefined
            ? existing.confidence
            : Math.min(existing.confidence, segment.confidence);
      if (Date.parse(segment.startUtc) < Date.parse(existing.startUtc)) existing.startUtc = segment.startUtc;
      if (Date.parse(segment.endUtc) > Date.parse(existing.endUtc)) existing.endUtc = segment.endUtc;
    }
  }
  if (byPlace.size === 0) return { status: "unmatched", reason: "no-overlap" };

  let best: PlaceAccumulator | null = null;
  let tie = false;
  for (const candidate of byPlace.values()) {
    if (best === null || candidate.overlapMs > best.overlapMs) {
      best = candidate;
      tie = false;
      continue;
    }
    if (candidate.overlapMs === best.overlapMs) tie = true;
  }
  if (best === null || tie) return { status: "unmatched", reason: "ambiguous" };

  const overlapForThreshold = window.kind === "instant" ? best.visitMs : best.overlapMs;
  if (policy.minimumOverlapSeconds > 0 && overlapForThreshold < policy.minimumOverlapSeconds * 1000) {
    return { status: "unmatched", reason: "below-minimum-overlap" };
  }
  if (best.confidence !== undefined && best.confidence < policy.minimumConfidence) {
    return { status: "unmatched", reason: "below-minimum-confidence" };
  }
  return {
    status: "matched",
    match: {
      sourceId: best.sourceId,
      place: best.place,
      overlapMs: best.overlapMs,
      visitMs: best.visitMs,
      ...(best.confidence !== undefined ? { confidence: best.confidence } : {}),
      visitStartUtc: best.startUtc,
      visitEndUtc: best.endUtc,
    },
  };
}

/** Deterministic tag slug for a provider place id (`reitti:place:7` → `reitti-place-7`). */
export function locationTagSlug(placeId: string): string {
  const delimited = placeId.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  // Trim delimiter runs without a trim regex: CodeQL flags polynomial
  // `-+` alternation on provider-supplied ids (uncontrolled data).
  let start = 0;
  let end = delimited.length;
  while (start < end && delimited[start] === "-") start += 1;
  while (end > start && delimited[end - 1] === "-") end -= 1;
  return delimited.slice(start, end).slice(0, TAG_LIMITS.maxTagLength - LOCATION_TAG_PREFIX.length);
}

/** The provider-owned tag for a matched place. */
export function locationTagForPlace(placeId: string): string {
  return `${LOCATION_TAG_PREFIX}${locationTagSlug(placeId)}`;
}

function boundedAttributeValue(value: string): string {
  return value.slice(0, STRUCTURED_ATTRIBUTE_LIMITS.maxValueLength);
}

/** Provider-owned structured attributes describing a match. */
export function locationAttributesForMatch(
  match: LocationMatch,
  policy: LocationTagPolicy,
): Record<string, string> {
  const attributes: Record<string, string> = {
    locationSource: match.sourceId,
    locationPlaceId: boundedAttributeValue(match.place.id),
    locationPlace: boundedAttributeValue(match.place.label),
    ...(match.confidence !== undefined ? { locationConfidence: match.confidence.toFixed(3) } : {}),
    locationVisitStart: match.visitStartUtc,
    locationVisitEnd: match.visitEndUtc,
  };
  if (policy.retainCoordinates && match.place.latitude !== undefined && match.place.longitude !== undefined) {
    attributes.locationLatitude = String(match.place.latitude);
    attributes.locationLongitude = String(match.place.longitude);
  }
  return attributes;
}

export interface LocationUpdatePlan {
  /** Patch for `writeMemoryFrontmatter`; absent when nothing changes. */
  patch?: { tags: string[]; structuredAttributes: Record<string, string> };
  /** Outcome for reporting. */
  outcome:
    | "tagged"
    | "updated"
    | "removed"
    | "unchanged"
    | "manual-metadata"
    | "unmatched"
    | "untimed"
    | "span-too-long";
}

function frontmatterHasLocationMetadata(
  frontmatter: { tags?: string[]; structuredAttributes?: Record<string, string> },
): boolean {
  if ((frontmatter.tags ?? []).some((tag) => tag.startsWith(LOCATION_TAG_PREFIX))) return true;
  return Object.keys(frontmatter.structuredAttributes ?? {}).some((key) =>
    (LOCATION_ATTRIBUTE_KEYS as readonly string[]).includes(key),
  );
}

function isProviderOwned(frontmatter: { structuredAttributes?: Record<string, string> }): boolean {
  const source = frontmatter.structuredAttributes?.locationSource;
  return typeof source === "string" && source.length > 0;
}

/**
 * Plan the provider-owned update for one memory: a match adds/replaces ONLY
 * provider-owned fields; a lost match removes them (corrected observations);
 * manual location metadata (no `locationSource` marker) always wins and is
 * never touched. Unrelated tags and attributes survive every path.
 */
export function planLocationUpdate(
  frontmatter: { tags?: string[]; structuredAttributes?: Record<string, string> },
  outcome: MatchOutcome,
  policy: LocationTagPolicy,
): LocationUpdatePlan {
  if (frontmatterHasLocationMetadata(frontmatter) && !isProviderOwned(frontmatter)) {
    return { outcome: "manual-metadata" };
  }
  const tags = [...(frontmatter.tags ?? [])];
  const attributes = { ...(frontmatter.structuredAttributes ?? {}) };
  const providerTagIndex = tags.findIndex((tag) => tag.startsWith(LOCATION_TAG_PREFIX));
  const stripProviderFields = (): void => {
    if (providerTagIndex >= 0) tags.splice(providerTagIndex, 1);
    for (const key of LOCATION_ATTRIBUTE_KEYS) delete attributes[key];
  };

  if (outcome.status !== "matched") {
    if (!isProviderOwned(frontmatter)) return { outcome: "unmatched" };
    if (providerTagIndex < 0 && !("locationPlaceId" in attributes)) {
      return { outcome: "unchanged" };
    }
    stripProviderFields();
    return { patch: { tags, structuredAttributes: attributes }, outcome: "removed" };
  }

  const desiredTag = locationTagForPlace(outcome.match.place.id);
  const desiredAttributes = locationAttributesForMatch(outcome.match, policy);
  if (tags.length >= TAG_LIMITS.maxTags && providerTagIndex < 0) {
    // Full tag budget with no provider slot to reuse — leave the memory alone.
    return { outcome: "unchanged" };
  }
  const alreadyCurrent =
    providerTagIndex >= 0 &&
    tags[providerTagIndex] === desiredTag &&
    LOCATION_ATTRIBUTE_KEYS.every((key) => {
      const want = desiredAttributes[key];
      const have = attributes[key];
      return want === undefined ? have === undefined : have === want;
    });
  if (alreadyCurrent) return { outcome: "unchanged" };

  if (providerTagIndex >= 0) tags[providerTagIndex] = desiredTag;
  else tags.push(desiredTag);
  for (const key of LOCATION_ATTRIBUTE_KEYS) delete attributes[key];
  Object.assign(attributes, desiredAttributes);
  const wasProviderOwned = isProviderOwned(frontmatter);
  return {
    patch: { tags, structuredAttributes: attributes },
    outcome: wasProviderOwned ? "updated" : "tagged",
  };
}
