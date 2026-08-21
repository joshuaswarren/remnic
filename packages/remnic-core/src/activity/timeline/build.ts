/**
 * Deterministic timeline-card day builder (issue #2049).
 *
 * Semantics (all half-open [start, end), all UTC internally):
 * - Observations are grouped per capture machine and sorted by
 *   (canonical capture instant, contentHash) — never by array position.
 * - Compatibility rule: two consecutive observations on one machine merge
 *   into the same card iff they share the exact (app, windowTitle) pair.
 * - Gap rule: a merge happens only when the inter-observation gap is
 *   ≤ MERGE_GAP_MS (2 min). A card's end extends from its last observation
 *   by at most MAX_DWELL_MS (15 min, matching the digest dwell cap), is
 *   clipped by the next observation on the machine, by any user pause, and
 *   by the local day end — so cards never overlap on a track.
 * - Idle: any uncovered remainder between consecutive cards on a machine
 *   track (which in practice means a gap > MAX_DWELL_MS) becomes a derived
 *   idle card with no evidence. The day's leading/trailing uncovered ranges
 *   are represented by the absence of cards, not by invented idle.
 * - Pause: user-declared intervals are unioned, clipped to the day, emitted
 *   as pause cards, and never overlapped by activity dwell or idle.
 * - Nothing is invented for gaps: idle/pause cards carry no evidence and are
 *   flagged by kind; an app/window match never claims user intent.
 *
 * Output is byte-stable: identical inputs produce identical
 * `serializeTimelineDay()` bytes across runs and process restarts.
 */

import { createHash } from "node:crypto";

import { activityDayWindow } from "../digest.js";
import { DEFAULT_TIMELINE_CATEGORIES, TIMELINE_RESERVED_IDLE, TIMELINE_RESERVED_PAUSE, validateTimelineCategories } from "./categories.js";
import { classifyTimelineObservation } from "./classify.js";
import type { TimelineCard, TimelineCategory, TimelineDay, TimelineObservation, TimelinePause } from "./types.js";

export const TIMELINE_FORMAT_VERSION = 1;

/** Max inter-observation gap that still merges into one card. */
export const TIMELINE_MERGE_GAP_MS = 120_000;
/** Max dwell attributed past a card's last observation (digest parity). */
export const TIMELINE_MAX_DWELL_MS = 15 * 60_000;

export interface TimelineBuildInput {
  /** Local day, YYYY-MM-DD. */
  date: string;
  timezone: string;
  /** Stored observations for the day (e.g. from ActivityStore.listSnapshotsForDay). */
  observations: readonly TimelineObservation[];
  /** User-declared pauses (UTC, half-open); may overlap and extend past the day. */
  pauses?: readonly TimelinePause[];
  /** Registry override; validated. Defaults to the built-in registry. */
  categories?: readonly TimelineCategory[];
}

/** Canonical UTC ISO instant, or the raw string when unparseable (dropped later). */
function canonicalMs(iso: string): number {
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function isoOf(ms: number): string {
  return new Date(ms).toISOString();
}

/** Content identity of one observation: machine + instant + content hash. */
function evidenceKeyOf(observation: TimelineObservation): string {
  return `${observation.machine}|${isoOf(canonicalMs(observation.capturedAtUtc))}|${observation.contentHash}`;
}

function stableCardId(identity: string): string {
  return `tlc_${createHash("sha256").update(identity, "utf8").digest("hex").slice(0, 16)}`;
}

function formatDurationMinutes(ms: number): string {
  return `${Math.round(ms / 60_000)}m`;
}

/** Union overlapping/adjacent [start,end) intervals; returns sorted, disjoint ms pairs. */
function unionIntervals(intervals: readonly (readonly [number, number])[]): Array<[number, number]> {
  const sorted = [...intervals].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: Array<[number, number]> = [];
  for (const interval of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && interval[0] <= last[1]) {
      last[1] = Math.max(last[1], interval[1]);
    } else {
      merged.push([interval[0], interval[1]]);
    }
  }
  return merged;
}

/** Remove [cutStart,cutEnd) from [start,end); returns the remaining pieces. */
function subtractInterval(start: number, end: number, cutStart: number, cutEnd: number): Array<[number, number]> {
  if (cutEnd <= start || cutStart >= end) return [[start, end]];
  const pieces: Array<[number, number]> = [];
  if (cutStart > start) pieces.push([start, cutStart]);
  if (cutEnd < end) pieces.push([cutEnd, end]);
  return pieces;
}

interface MergedObservations {
  machine: string;
  observations: TimelineObservation[];
}

/** Per-machine merge pass: compatibility + gap rules (see module doc). */
function mergeTrack(
  machine: string,
  track: TimelineObservation[],
  pauses: readonly (readonly [number, number])[],
): MergedObservations[] {
  const cards: MergedObservations[] = [];
  let current: TimelineObservation[] = [];
  const pauseStartsAfter = (fromMs: number, toMs: number): boolean =>
    pauses.some(([ps, pe]) => ps >= fromMs && ps < toMs && pe > ps);
  for (const observation of track) {
    const last = current[current.length - 1];
    if (last !== undefined) {
      const gap = canonicalMs(observation.capturedAtUtc) - canonicalMs(last.capturedAtUtc);
      const sameKey = observation.app === last.app && observation.windowTitle === last.windowTitle;
      const pauseBetween = pauseStartsAfter(canonicalMs(last.capturedAtUtc), canonicalMs(observation.capturedAtUtc));
      if (!sameKey || gap > TIMELINE_MERGE_GAP_MS || pauseBetween) {
        cards.push({ machine, observations: current });
        current = [];
      }
    }
    current.push(observation);
  }
  if (current.length > 0) cards.push({ machine, observations: current });
  return cards;
}

/** Build one replayable local day of timeline cards. Pure; throws on bad input. */
export function buildTimelineDay(input: TimelineBuildInput): TimelineDay {
  const categories = input.categories ?? DEFAULT_TIMELINE_CATEGORIES;
  validateTimelineCategories(categories);
  const window = activityDayWindow(input.date, input.timezone);
  const dayStartMs = Date.parse(window.startUtc);
  const dayEndMs = Date.parse(window.endUtc);

  // Observations: canonicalize, drop instants outside the day window.
  const observations = input.observations
    .filter((observation) => Number.isFinite(canonicalMs(observation.capturedAtUtc)))
    .filter((observation) => {
      const ms = canonicalMs(observation.capturedAtUtc);
      return ms >= dayStartMs && ms < dayEndMs;
    });

  // Pauses: validate instants, clip to the day, union overlaps.
  for (const pause of input.pauses ?? []) {
    const startMs = canonicalMs(pause.startUtc);
    const endMs = canonicalMs(pause.endUtc);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs >= endMs) {
      throw new RangeError("timeline pause must be a valid half-open [startUtc, endUtc) interval");
    }
  }
  const pauseIntervals = unionIntervals(
    (input.pauses ?? [])
      .map((pause) => [canonicalMs(pause.startUtc), canonicalMs(pause.endUtc)] as const)
      .map(([startMs, endMs]) => [Math.max(startMs, dayStartMs), Math.min(endMs, dayEndMs)] as const)
      .filter(([startMs, endMs]) => endMs > startMs),
  );

  // Group per machine; sort by (instant, contentHash) — position-independent.
  const tracks = new Map<string, TimelineObservation[]>();
  for (const observation of observations) {
    const track = tracks.get(observation.machine) ?? [];
    track.push(observation);
    tracks.set(observation.machine, track);
  }
  for (const track of tracks.values()) {
    track.sort(
      (a, b) => canonicalMs(a.capturedAtUtc) - canonicalMs(b.capturedAtUtc) || (a.contentHash < b.contentHash ? -1 : a.contentHash > b.contentHash ? 1 : 0),
    );
  }

  const cards: TimelineCard[] = [];
  const machines = [...tracks.keys()].sort();
  for (const machine of machines) {
    const track = tracks.get(machine) ?? [];
    const merged = mergeTrack(machine, track, pauseIntervals);
    // [startMs, endMs] per merged card, reused by the idle pass below.
    const trackIntervals: Array<[number, number]> = [];
    for (let index = 0; index < merged.length; index++) {
      const group = merged[index];
      const first = group.observations[0];
      const last = group.observations[group.observations.length - 1];
      const startMs = canonicalMs(first.capturedAtUtc);
      const lastMs = canonicalMs(last.capturedAtUtc);
      const nextObsMs = index + 1 < merged.length ? canonicalMs(merged[index + 1].observations[0].capturedAtUtc) : Number.POSITIVE_INFINITY;
      const pauseStartMs = pauseIntervals.find(([ps]) => ps > lastMs)?.[0] ?? Number.POSITIVE_INFINITY;
      const endMs = Math.max(lastMs, Math.min(lastMs + TIMELINE_MAX_DWELL_MS, nextObsMs, pauseStartMs, dayEndMs));
      trackIntervals.push([startMs, endMs]);
      const evidenceIds = group.observations.map((observation) => observation.id);
      const classification = classifyTimelineObservation(first, categories);
      cards.push({
        id: stableCardId(`activity|${machine}|${evidenceKeyOf(first)}|${evidenceKeyOf(last)}`),
        kind: "activity",
        title: first.windowTitle.length > 0 ? first.windowTitle : first.app,
        summary: `${first.app} · ${machine} · ${evidenceIds.length} obs · ${formatDurationMinutes(endMs - startMs)}`,
        categoryId: classification.categoryId,
        confidence: classification.confidence,
        startUtc: isoOf(startMs),
        endUtc: isoOf(endMs),
        dayKey: input.date,
        timezone: input.timezone,
        machine,
        evidenceIds,
        evidenceRange: { firstKey: evidenceKeyOf(first), lastKey: evidenceKeyOf(last) },
      });
    }

    // Idle: uncovered remainders between consecutive cards on this track,
    // pauses removed (a pause wins over idle covering the same minutes).
    for (let index = 0; index + 1 < trackIntervals.length; index++) {
      const gapStart = trackIntervals[index][1];
      const gapEnd = trackIntervals[index + 1][0];
      if (gapEnd <= gapStart) continue;
      let pieces: Array<[number, number]> = [[gapStart, gapEnd]];
      for (const [pauseStart, pauseEnd] of pauseIntervals) {
        pieces = pieces.flatMap(([start, end]) => subtractInterval(start, end, pauseStart, pauseEnd));
      }
      for (const [start, end] of pieces) {
        cards.push({
          id: stableCardId(`idle|${machine}|${isoOf(start)}|${isoOf(end)}`),
          kind: "idle",
          title: "Idle",
          summary: `${formatDurationMinutes(end - start)} gap on ${machine}`,
          categoryId: TIMELINE_RESERVED_IDLE,
          confidence: 1,
          startUtc: isoOf(start),
          endUtc: isoOf(end),
          dayKey: input.date,
          timezone: input.timezone,
          machine,
          evidenceIds: [],
          evidenceRange: null,
        });
      }
    }
  }

  for (const [pauseStart, pauseEnd] of pauseIntervals) {
    const reason = (input.pauses ?? []).find((pause) => canonicalMs(pause.startUtc) === pauseStart)?.reason;
    cards.push({
      id: stableCardId(`pause|${isoOf(pauseStart)}|${isoOf(pauseEnd)}`),
      kind: "pause",
      title: "Paused",
      summary: reason === undefined ? `${formatDurationMinutes(pauseEnd - pauseStart)} user pause` : `${formatDurationMinutes(pauseEnd - pauseStart)} user pause — ${reason}`,
      categoryId: TIMELINE_RESERVED_PAUSE,
      confidence: 1,
      startUtc: isoOf(pauseStart),
      endUtc: isoOf(pauseEnd),
      dayKey: input.date,
      timezone: input.timezone,
      machine: null,
      evidenceIds: [],
      evidenceRange: null,
    });
  }

  cards.sort((a, b) => a.startUtc < b.startUtc ? -1 : a.startUtc > b.startUtc ? 1 : a.endUtc < b.endUtc ? -1 : a.endUtc > b.endUtc ? 1 : (a.machine ?? "") < (b.machine ?? "") ? -1 : (a.machine ?? "") > (b.machine ?? "") ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

  return {
    formatVersion: TIMELINE_FORMAT_VERSION,
    date: input.date,
    timezone: input.timezone,
    startUtc: window.startUtc,
    endUtc: window.endUtc,
    cards,
  };
}

/**
 * Canonical byte-stable serialization. Card objects are constructed in a
 * fixed field order, so `JSON.stringify` output is stable across runs.
 */
export function serializeTimelineDay(day: TimelineDay): string {
  return JSON.stringify(day);
}
