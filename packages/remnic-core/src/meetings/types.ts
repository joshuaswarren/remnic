/**
 * Meeting-intelligence subsystem — shared types (issue #1900).
 *
 * Retrospective meeting detection over already-ingested day signals: audio
 * conversation windows (from wearable day transcripts, any source) plus
 * meeting-app foreground spans (derived from screen activity in a later slice).
 * This slice is pure detection — no store, no fusion, no surfaces. All
 * timestamps are UTC ISO-8601; windows are half-open [startUtc, endUtc).
 */

import type {
  FusedSegment,
  FusedSpeaker,
  FusionConversationInput,
} from "../wearables/fusion/types.js";

/** A contiguous meeting-app foreground span (derived from activity in a later slice). */
export interface MeetingAppSpan {
  /** Meeting app label (e.g. "Zoom", "Google Meet"). */
  app: string;
  startUtc: string;
  endUtc: string;
}

/** An audio conversation window from a wearable/connector day transcript. */
export interface MeetingAudioWindow {
  /** Wearable source id the conversation came from (desktop, limitless, granola, …). */
  source: string;
  startUtc: string;
  endUtc: string;
  /** Distinct non-wearer speakers in the conversation (drives the audio-only rule). */
  distinctNonWearerSpeakers: number;
  /**
   * True when the source is a cloud meeting provider that supplies explicit
   * meeting boundaries (Granola/Fireflies): such a window is a meeting on its
   * own, without a matching app span.
   */
  providerMeeting?: boolean;
  /** Provider-supplied meeting title, when available. */
  title?: string;
}

/** How a meeting was detected. */
export type MeetingDetectionSource = "app+audio" | "audio" | "provider";

/** One detected meeting for a day (non-overlapping after merge). */
export interface DetectedMeeting {
  /** Stable id `mtg-<date>-<hash>`, hashed from date + the exact START instant
   *  (app + end deliberately excluded) so a resync that grows the meeting never
   *  renumbers it, while non-overlapping meetings keep distinct ids. */
  id: string;
  /** Local day YYYY-MM-DD. */
  date: string;
  startUtc: string;
  endUtc: string;
  /** Meeting app, when app context contributed to detection. */
  app?: string;
  detectionSource: MeetingDetectionSource;
  /** Contributing wearable source ids, sorted, de-duplicated. */
  sources: string[];
  /** Title, when a provider supplied one. */
  title?: string;
}

/** Per-day detection input (assembled by a later wiring slice). */
export interface MeetingsDetectionInput {
  date: string;
  appSpans: MeetingAppSpan[];
  audioWindows: MeetingAudioWindow[];
}

/** Detection-relevant configuration (full parseConfig wiring lands in a later slice). */
export interface MeetingsDetectionConfig {
  /** Meeting-app match patterns (used when deriving app spans from activity). */
  appPatterns: string[];
  /** Min app-span ∩ audio-window overlap to pair them (minutes). */
  minOverlapMinutes: number;
  /** Audio-only fallback: min conversation length (minutes). */
  audioOnlyMinMinutes: number;
  /** Merge candidates within this gap of each other (minutes). */
  mergeGapMinutes: number;
}

/**
 * One screen-activity snapshot fed into meeting fusion (assembled from the
 * activity store by a later wiring slice; injected directly in tests). Text is
 * already post-redaction — meeting fusion never sees raw capture.
 */
export interface MeetingActivitySnapshot {
  /** ISO 8601 UTC instant the snapshot was captured. */
  tsUtc: string;
  /** Foreground application label (e.g. "Preview", "Chrome", "Zoom"). */
  app: string;
  /** Window title, when known. */
  title?: string;
  /** Browser URL, when known. */
  url?: string;
  /** Extracted on-screen text excerpt, when known. */
  text?: string;
}

/** One entry in a meeting's screen-context timeline (an other-app dwell). */
export interface MeetingScreenContextEvent {
  /** ISO 8601 UTC instant the dwell began (clamped to the meeting window). */
  tsUtc: string;
  /** `HH:MM` (UTC) render used on the timeline line. */
  clock: string;
  /** App label. */
  app: string;
  /** Compact label, e.g. `Preview: Q3-roadmap.pdf` or `Chrome: github.com/x`. */
  label: string;
  /** Foreground dwell within the meeting window, in whole seconds. */
  dwellSeconds: number;
}

/** LLM meeting-summary mode: off (episode only), review (all to review queue),
 *  or smart (trust-gated). */
export type MeetingSummaryMode = "off" | "review" | "smart";

/** Detection-plus-fusion configuration for meeting building. */
export interface MeetingsConfig extends MeetingsDetectionConfig {
  /** Master gate for the meetings subsystem. */
  enabled: boolean;
  /** Min foreground dwell (seconds) for an other-app span to enter context. */
  contextDwellSeconds: number;
  /** Cap on total deduped screen-context excerpt characters. */
  maxContextChars: number;
  /** LLM summary/facts mode: off | review | smart (default smart). */
  summaryMode: MeetingSummaryMode;
  /** Provenance trust prior for meeting-derived facts (0..1). */
  sourceTrust: number;
  /** Trust at/above which a smart-mode fact is auto-approved to active. */
  autoApproveTrust: number;
  /** Trust at/above which a smart-mode fact is queued for review. */
  reviewTrust: number;
}

/** Per-meeting build input (day conversations + activity are clipped here). */
export interface MeetingBuildInput {
  meeting: DetectedMeeting;
  /**
   * Fusion conversation inputs across ALL wearable sources for the day. Only
   * segments overlapping the meeting window are used; passing whole-day inputs
   * is fine (they are clipped in `fuseMeeting`).
   */
  conversations: FusionConversationInput[];
  /** Day screen-activity snapshots (filtered to the window in `fuseMeeting`). */
  activity?: MeetingActivitySnapshot[];
}

/** The fused, screen-aware view of a meeting produced by `fuseMeeting`. */
export interface FusedMeeting {
  /** Distinct resolved non-wearer attendee labels, sorted. */
  attendees: string[];
  /** Contributing transcript sources, sorted + de-duplicated. */
  sources: string[];
  /** Sources that corroborated a higher-trust pick (alternatives), sorted. */
  corroboratedBy: string[];
  /** Screen-context timeline (other-app dwell >= contextDwellSeconds). */
  screenContext: MeetingScreenContextEvent[];
  /** Deduped notable on-screen text excerpts (capped by maxContextChars). */
  contextExcerpts: string[];
  /** Fused, reconciled transcript segments in chronological order. */
  transcript: FusedSegment[];
  /** Reconciled speakers (deduped across sources). */
  speakers: FusedSpeaker[];
  /** Count of activity snapshots inside the meeting window. */
  snapshotCount: number;
}

/**
 * A persisted meeting record. Frontmatter + fused body serialize to
 * `<memoryDir>/meetings/<date>/<id>.md`; rebuilt idempotently on contentHash.
 */
export interface MeetingRecord extends FusedMeeting {
  id: string;
  date: string;
  startUtc: string;
  endUtc: string;
  app?: string;
  detectionSource: MeetingDetectionSource;
  title?: string;
  /** SHA-256 over the record's canonical semantic content (idempotency key). */
  contentHash: string;
  /** Serializer format version (bump invalidates older files). */
  formatVersion: number;
}
