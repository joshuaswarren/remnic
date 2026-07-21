/**
 * Retrospective meeting detection (issue #1900, Phase 4 slice 1).
 *
 * Pure functions over a day's already-ingested signals. A meeting candidate is
 * either (a) an audio conversation overlapping a meeting-app foreground span
 * (`app+audio`), (b) a provider meeting with its own boundaries (`provider`),
 * or (c) a long enough multi-speaker conversation with no app span
 * (`audio`, the phone-call/in-person fallback). App spans with no overlapping
 * audio are NOT meetings (you were watching a recording). Candidates are then
 * merged so a day's meetings never overlap, and each gets a re-run-stable id.
 */

import { createHash } from "node:crypto";

import type {
  DetectedMeeting,
  MeetingAppSpan,
  MeetingAudioWindow,
  MeetingDetectionSource,
  MeetingsDetectionConfig,
  MeetingsDetectionInput,
} from "./types.js";

/** Shipped meeting-app patterns (used by the later activity-span derivation). */
export const DEFAULT_MEETING_APP_PATTERNS: readonly string[] = [
  "zoom.us",
  "Zoom",
  "Microsoft Teams",
  "teams.microsoft.com",
  "meet.google.com",
  "Webex",
  "Slack", // huddle windows
  "FaceTime",
];

export const DEFAULT_MEETINGS_DETECTION_CONFIG: MeetingsDetectionConfig = {
  appPatterns: [...DEFAULT_MEETING_APP_PATTERNS],
  minOverlapMinutes: 2,
  audioOnlyMinMinutes: 15,
  mergeGapMinutes: 2,
};

interface Candidate {
  startMs: number;
  endMs: number;
  app?: string;
  detectionSource: MeetingDetectionSource;
  sources: string[];
  title?: string;
}

function ms(iso: string): number {
  const value = Date.parse(iso);
  return Number.isFinite(value) ? value : Number.NaN;
}

/** Overlap of two half-open [start,end) windows, in milliseconds (0 if disjoint). */
function overlapMs(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  const start = Math.max(aStart, bStart);
  const end = Math.min(aEnd, bEnd);
  return end > start ? end - start : 0;
}

/** UTC ISO truncated to the minute — the stable-id anchor. */
function roundToMinuteUtc(startMs: number): string {
  return new Date(Math.floor(startMs / 60_000) * 60_000).toISOString();
}

/** Re-run-stable id: same date + rounded start + app ⇒ same id, so re-syncs
 *  with slightly more data never renumber existing records. */
export function meetingId(date: string, startUtc: string, app: string | undefined): string {
  const startMs = ms(startUtc);
  const anchor = Number.isNaN(startMs) ? startUtc : roundToMinuteUtc(startMs);
  const hash = createHash("sha256").update(`${date}|${anchor}|${app ?? ""}`, "utf8").digest("hex").slice(0, 8);
  return `mtg-${date}-${hash}`;
}

function isFinitePair(a: number, b: number): boolean {
  return Number.isFinite(a) && Number.isFinite(b) && b > a;
}

function combineDetection(a: MeetingDetectionSource, b: MeetingDetectionSource): MeetingDetectionSource {
  if (a === "app+audio" || b === "app+audio") return "app+audio";
  if (a === "provider" || b === "provider") return "provider";
  return "audio";
}

function buildCandidates(
  audioWindows: MeetingAudioWindow[],
  appSpans: MeetingAppSpan[],
  config: MeetingsDetectionConfig,
): Candidate[] {
  const minOverlapMs = config.minOverlapMinutes * 60_000;
  const audioOnlyMs = config.audioOnlyMinMinutes * 60_000;
  const candidates: Candidate[] = [];

  for (const window of audioWindows) {
    const startMs = ms(window.startUtc);
    const endMs = ms(window.endUtc);
    if (!isFinitePair(startMs, endMs)) continue;

    if (window.providerMeeting === true) {
      candidates.push({
        startMs,
        endMs,
        detectionSource: "provider",
        sources: [window.source],
        ...(window.title !== undefined ? { title: window.title } : {}),
      });
      continue;
    }

    // Best-overlapping meeting-app span (deterministic: max overlap, then earliest start).
    let bestApp: { span: MeetingAppSpan; overlap: number } | undefined;
    for (const span of appSpans) {
      const spanStart = ms(span.startUtc);
      const spanEnd = ms(span.endUtc);
      if (!isFinitePair(spanStart, spanEnd)) continue;
      const overlap = overlapMs(startMs, endMs, spanStart, spanEnd);
      if (overlap < minOverlapMs) continue;
      if (
        bestApp === undefined ||
        overlap > bestApp.overlap ||
        (overlap === bestApp.overlap && spanStart < ms(bestApp.span.startUtc))
      ) {
        bestApp = { span, overlap };
      }
    }

    if (bestApp !== undefined) {
      candidates.push({
        startMs,
        endMs,
        app: bestApp.span.app,
        detectionSource: "app+audio",
        sources: [window.source],
        ...(window.title !== undefined ? { title: window.title } : {}),
      });
      continue;
    }

    // Audio-only fallback: long enough, ≥ 2 distinct non-wearer speakers.
    if (endMs - startMs >= audioOnlyMs && window.distinctNonWearerSpeakers >= 2) {
      candidates.push({
        startMs,
        endMs,
        detectionSource: "audio",
        sources: [window.source],
        ...(window.title !== undefined ? { title: window.title } : {}),
      });
    }
  }

  return candidates;
}

/**
 * Merge candidates so the day's meetings never overlap. Two candidates merge
 * when they overlap, or when they are within `mergeGapMinutes` and share the
 * same app (rejoin-after-drop). Deterministic: sort by (start, end) first.
 */
function mergeCandidates(candidates: Candidate[], mergeGapMs: number): Candidate[] {
  const sorted = [...candidates].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  const merged: Candidate[] = [];
  for (const candidate of sorted) {
    const prev = merged[merged.length - 1];
    const overlaps = prev !== undefined && candidate.startMs < prev.endMs;
    const sameAppAdjacent =
      prev !== undefined &&
      prev.app !== undefined &&
      prev.app === candidate.app &&
      candidate.startMs - prev.endMs <= mergeGapMs;
    if (prev !== undefined && (overlaps || sameAppAdjacent)) {
      prev.endMs = Math.max(prev.endMs, candidate.endMs);
      prev.app = prev.app ?? candidate.app;
      prev.detectionSource = combineDetection(prev.detectionSource, candidate.detectionSource);
      prev.sources = [...new Set([...prev.sources, ...candidate.sources])];
      prev.title = prev.title ?? candidate.title;
      continue;
    }
    merged.push({ ...candidate, sources: [...candidate.sources] });
  }
  return merged;
}

/** Detect the day's non-overlapping meetings from its audio + app-span signals. */
export function detectMeetings(
  input: MeetingsDetectionInput,
  config: MeetingsDetectionConfig = DEFAULT_MEETINGS_DETECTION_CONFIG,
): DetectedMeeting[] {
  const candidates = buildCandidates(input.audioWindows, input.appSpans, config);
  const merged = mergeCandidates(candidates, config.mergeGapMinutes * 60_000);
  return merged.map((candidate) => {
    const startUtc = new Date(candidate.startMs).toISOString();
    const endUtc = new Date(candidate.endMs).toISOString();
    return {
      id: meetingId(input.date, startUtc, candidate.app),
      date: input.date,
      startUtc,
      endUtc,
      ...(candidate.app !== undefined ? { app: candidate.app } : {}),
      detectionSource: candidate.detectionSource,
      sources: [...candidate.sources].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
      ...(candidate.title !== undefined ? { title: candidate.title } : {}),
    };
  });
}
