/**
 * Meeting-intelligence subsystem — shared types (issue #1900).
 *
 * Retrospective meeting detection over already-ingested day signals: audio
 * conversation windows (from wearable day transcripts, any source) plus
 * meeting-app foreground spans (derived from screen activity in a later slice).
 * This slice is pure detection — no store, no fusion, no surfaces. All
 * timestamps are UTC ISO-8601; windows are half-open [startUtc, endUtc).
 */

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
  /** Stable id `mtg-<date>-<hash>`, hashed from date + rounded START only
   *  (app excluded, end excluded) so a resync that grows the meeting never
   *  renumbers it. */
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
