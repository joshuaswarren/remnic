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
  if (typeof iso !== "string") return Number.NaN;
  const value = Date.parse(iso);
  if (!Number.isFinite(value)) return Number.NaN;
  // Reject invalid calendar rollovers (e.g. 2026-02-30 → 2026-03-02) for the
  // canonical UTC form the detector receives: the parsed instant's UTC fields
  // must reproduce the supplied Y-M-D H:M:S rather than silently shifting.
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/);
  if (m !== null && iso.endsWith("Z")) {
    const d = new Date(value);
    if (
      d.getUTCFullYear() !== Number(m[1]) ||
      d.getUTCMonth() + 1 !== Number(m[2]) ||
      d.getUTCDate() !== Number(m[3]) ||
      d.getUTCHours() !== Number(m[4]) ||
      d.getUTCMinutes() !== Number(m[5]) ||
      d.getUTCSeconds() !== Number(m[6])
    ) {
      return Number.NaN;
    }
  }
  return value;
}

/** Overlap of two half-open [start,end) windows, in milliseconds (0 if disjoint). */
function overlapMs(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  const start = Math.max(aStart, bStart);
  const end = Math.min(aEnd, bEnd);
  return end > start ? end - start : 0;
}

/** Re-run-stable id: same date + exact START instant ⇒ same id. Anchored on the
 *  start ONLY (end + app both excluded from the hash) so a resync that extends
 *  the meeting's end (a late source / rejoin) or reassigns its app never
 *  renumbers an existing record — the start is the stable identity. Full start
 *  precision (NOT minute-rounded) keeps ids unique even for short provider
 *  meetings that share a start minute: post-merge meetings are non-overlapping,
 *  so their start instants are always distinct.
 *
 *  A resync that moves a meeting's START earlier (a late source beginning before
 *  the first-ingested one) does change the id — a stateless pure detector cannot
 *  know the prior id. Preserving ids across a shifted start is cross-run identity
 *  work that needs prior-emission state, so it belongs to the fusion/store slice
 *  (#1900), which matches a re-detected meeting to its stored record by overlap
 *  and keeps the original id. This function stays pure and deterministic. */
export function meetingId(date: string, startUtc: string): string {
  const startMs = ms(startUtc);
  const anchor = Number.isNaN(startMs) ? startUtc : new Date(startMs).toISOString();
  const hash = createHash("sha256").update(`${date}|${anchor}`, "utf8").digest("hex").slice(0, 8);
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
      // Require genuine overlap for an app+audio pairing, even when the caller
      // sets minOverlapMinutes to 0 — disjoint windows must not pair.
      if (overlap <= 0 || overlap < minOverlapMs) continue;
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

/** Detection-source rank for a total, stable candidate ordering. */
const DETECTION_RANK: Record<MeetingDetectionSource, number> = {
  "app+audio": 0,
  provider: 1,
  audio: 2,
};

/** Total order over candidates so equal-time spans resolve deterministically. */
function candidateOrder(a: Candidate, b: Candidate): number {
  return (
    a.startMs - b.startMs ||
    a.endMs - b.endMs ||
    DETECTION_RANK[a.detectionSource] - DETECTION_RANK[b.detectionSource] ||
    (a.app ?? "").localeCompare(b.app ?? "") ||
    (a.title ?? "").localeCompare(b.title ?? "") ||
    (a.sources[0] ?? "").localeCompare(b.sources[0] ?? "")
  );
}

/**
 * Merge candidates so the day's meetings never overlap. Two candidates merge
 * when they overlap, or when they are within `mergeGapMinutes` and share the
 * same app (rejoin-after-drop). Deterministic via `candidateOrder`.
 */
function mergeCandidates(candidates: Candidate[], mergeGapMs: number): Candidate[] {
  const sorted = [...candidates].sort(candidateOrder);
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

function assertFiniteNonNegative(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`meetings config "${name}" must be a finite, non-negative number (got ${value}).`);
  }
}

function validateConfig(config: MeetingsDetectionConfig): void {
  assertFiniteNonNegative("minOverlapMinutes", config.minOverlapMinutes);
  assertFiniteNonNegative("audioOnlyMinMinutes", config.audioOnlyMinMinutes);
  assertFiniteNonNegative("mergeGapMinutes", config.mergeGapMinutes);
}

/** Detect the day's non-overlapping meetings from its audio + app-span signals. */
export function detectMeetings(
  input: MeetingsDetectionInput,
  config: MeetingsDetectionConfig = DEFAULT_MEETINGS_DETECTION_CONFIG,
): DetectedMeeting[] {
  validateConfig(config);
  const candidates = buildCandidates(input.audioWindows, input.appSpans, config);
  const merged = mergeCandidates(candidates, config.mergeGapMinutes * 60_000);
  return merged.map((candidate) => {
    const startUtc = new Date(candidate.startMs).toISOString();
    const endUtc = new Date(candidate.endMs).toISOString();
    return {
      id: meetingId(input.date, startUtc),
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
