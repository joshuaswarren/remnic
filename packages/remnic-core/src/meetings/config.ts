/**
 * Meetings config parsing — strict, loud, and default-safe (issue #1900).
 *
 * Mirrors the wearables/procedural blocks in config.ts: shape violations and
 * unparseable values throw with actionable messages (CLAUDE.md rule 51);
 * boolean-ish strings coerce via the shared helper (rule 36); every numeric
 * knob is bounds-checked; the master gate defaults OFF (rule 48) so base
 * installs see zero behavior change.
 *
 * This slice wires only the keys detection + fusion + the record store need.
 * The memory-generation knobs (summaryMode, sourceTrust, autoApproveTrust,
 * reviewTrust) land with the trust-pipeline slice.
 */

import { coerceBool, coerceNumber } from "../connectors/coerce.js";
import { DEFAULT_MEETING_APP_PATTERNS } from "./detect.js";
import type { MeetingsConfig, MeetingSummaryMode } from "./types.js";

const DEFAULT_MIN_OVERLAP_MINUTES = 2;
const DEFAULT_AUDIO_ONLY_MIN_MINUTES = 15;
const DEFAULT_MERGE_GAP_MINUTES = 2;
const DEFAULT_CONTEXT_DWELL_SECONDS = 20;
const DEFAULT_MAX_CONTEXT_CHARS = 4000;
const DEFAULT_SUMMARY_MODE: MeetingSummaryMode = "smart";
const DEFAULT_SOURCE_TRUST = 0.85;
const DEFAULT_AUTO_APPROVE_TRUST = 0.7;
const DEFAULT_REVIEW_TRUST = 0.45;
const SUMMARY_MODES: readonly MeetingSummaryMode[] = ["off", "review", "smart"];

export const DEFAULT_MEETINGS_CONFIG: MeetingsConfig = {
  enabled: false,
  appPatterns: [...DEFAULT_MEETING_APP_PATTERNS],
  minOverlapMinutes: DEFAULT_MIN_OVERLAP_MINUTES,
  audioOnlyMinMinutes: DEFAULT_AUDIO_ONLY_MIN_MINUTES,
  mergeGapMinutes: DEFAULT_MERGE_GAP_MINUTES,
  contextDwellSeconds: DEFAULT_CONTEXT_DWELL_SECONDS,
  maxContextChars: DEFAULT_MAX_CONTEXT_CHARS,
  summaryMode: DEFAULT_SUMMARY_MODE,
  sourceTrust: DEFAULT_SOURCE_TRUST,
  autoApproveTrust: DEFAULT_AUTO_APPROVE_TRUST,
  reviewTrust: DEFAULT_REVIEW_TRUST,
};

function parseBool(value: unknown, name: string, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback;
  const coerced = coerceBool(value);
  if (coerced === undefined) {
    throw new Error(
      `${name} must be a boolean-like value (true/false/1/0/yes/no/on/off); got ${JSON.stringify(value)}`,
    );
  }
  return coerced;
}

function parseBoundedInt(
  value: unknown,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined || value === null) return fallback;
  const coerced = coerceNumber(value);
  if (
    coerced === undefined ||
    !Number.isFinite(coerced) ||
    !Number.isInteger(coerced) ||
    coerced < min ||
    coerced > max
  ) {
    throw new Error(
      `${name} must be an integer between ${min} and ${max}; got ${JSON.stringify(value)}`,
    );
  }
  return coerced;
}

function parseAppPatterns(value: unknown): string[] {
  if (value === undefined || value === null) {
    return [...DEFAULT_MEETING_APP_PATTERNS];
  }
  if (!Array.isArray(value)) {
    throw new Error(
      `meetings.appPatterns must be an array of non-empty strings; got ${JSON.stringify(value)}`,
    );
  }
  const patterns: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      throw new Error(
        `meetings.appPatterns entries must be non-empty strings; got ${JSON.stringify(entry)}`,
      );
    }
    patterns.push(entry);
  }
  // Additive over the shipped defaults so a user extension never silently
  // drops a built-in meeting app (issue #1900 — appPatterns is additive).
  const merged = [...DEFAULT_MEETING_APP_PATTERNS, ...patterns];
  return [...new Set(merged)];
}

function parseSummaryMode(value: unknown): MeetingSummaryMode {
  if (value === undefined || value === null) return DEFAULT_SUMMARY_MODE;
  if (typeof value === "string" && (SUMMARY_MODES as readonly string[]).includes(value)) {
    return value as MeetingSummaryMode;
  }
  throw new Error(
    `meetings.summaryMode must be one of ${SUMMARY_MODES.join(", ")}; got ${JSON.stringify(value)}`,
  );
}

function parseTrust01(value: unknown, name: string, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  const coerced = coerceNumber(value);
  if (coerced === undefined || !Number.isFinite(coerced) || coerced < 0 || coerced > 1) {
    throw new Error(`${name} must be a number in [0, 1]; got ${JSON.stringify(value)}`);
  }
  return coerced;
}

/** Parse the `meetings` config block. Absent/`{}` → defaults (subsystem off). */
export function parseMeetingsConfig(value: unknown): MeetingsConfig {
  if (value === undefined || value === null) {
    return { ...DEFAULT_MEETINGS_CONFIG, appPatterns: [...DEFAULT_MEETING_APP_PATTERNS] };
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`meetings must be an object; got ${JSON.stringify(value)}`);
  }
  const raw = value as Record<string, unknown>;
  const config: MeetingsConfig = {
    enabled: parseBool(raw.enabled, "meetings.enabled", DEFAULT_MEETINGS_CONFIG.enabled),
    appPatterns: parseAppPatterns(raw.appPatterns),
    minOverlapMinutes: parseBoundedInt(
      raw.minOverlapMinutes,
      "meetings.minOverlapMinutes",
      DEFAULT_MIN_OVERLAP_MINUTES,
      0,
      1440,
    ),
    audioOnlyMinMinutes: parseBoundedInt(
      raw.audioOnlyMinMinutes,
      "meetings.audioOnlyMinMinutes",
      DEFAULT_AUDIO_ONLY_MIN_MINUTES,
      1,
      1440,
    ),
    mergeGapMinutes: parseBoundedInt(
      raw.mergeGapMinutes,
      "meetings.mergeGapMinutes",
      DEFAULT_MERGE_GAP_MINUTES,
      0,
      1440,
    ),
    contextDwellSeconds: parseBoundedInt(
      raw.contextDwellSeconds,
      "meetings.contextDwellSeconds",
      DEFAULT_CONTEXT_DWELL_SECONDS,
      0,
      86_400,
    ),
    maxContextChars: parseBoundedInt(
      raw.maxContextChars,
      "meetings.maxContextChars",
      DEFAULT_MAX_CONTEXT_CHARS,
      0,
      1_000_000,
    ),
    summaryMode: parseSummaryMode(raw.summaryMode),
    sourceTrust: parseTrust01(raw.sourceTrust, "meetings.sourceTrust", DEFAULT_SOURCE_TRUST),
    autoApproveTrust: parseTrust01(raw.autoApproveTrust, "meetings.autoApproveTrust", DEFAULT_AUTO_APPROVE_TRUST),
    reviewTrust: parseTrust01(raw.reviewTrust, "meetings.reviewTrust", DEFAULT_REVIEW_TRUST),
  };
  // decideSmart checks the auto-approve band FIRST, so autoApproveTrust below
  // reviewTrust fails open (a claim under the review bar would auto-activate).
  // Reject the inversion loudly rather than silently mis-gate meeting facts.
  if (config.autoApproveTrust < config.reviewTrust) {
    throw new Error(
      `meetings.autoApproveTrust (${config.autoApproveTrust}) must be >= meetings.reviewTrust ` +
        `(${config.reviewTrust}); an inverted gate would auto-approve below the review bar`,
    );
  }
  return config;
}
