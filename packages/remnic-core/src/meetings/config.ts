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
import type { MeetingsConfig } from "./types.js";

const DEFAULT_MIN_OVERLAP_MINUTES = 2;
const DEFAULT_AUDIO_ONLY_MIN_MINUTES = 15;
const DEFAULT_MERGE_GAP_MINUTES = 2;
const DEFAULT_CONTEXT_DWELL_SECONDS = 20;
const DEFAULT_MAX_CONTEXT_CHARS = 4000;

export const DEFAULT_MEETINGS_CONFIG: MeetingsConfig = {
  enabled: false,
  appPatterns: [...DEFAULT_MEETING_APP_PATTERNS],
  minOverlapMinutes: DEFAULT_MIN_OVERLAP_MINUTES,
  audioOnlyMinMinutes: DEFAULT_AUDIO_ONLY_MIN_MINUTES,
  mergeGapMinutes: DEFAULT_MERGE_GAP_MINUTES,
  contextDwellSeconds: DEFAULT_CONTEXT_DWELL_SECONDS,
  maxContextChars: DEFAULT_MAX_CONTEXT_CHARS,
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

/** Parse the `meetings` config block. Absent/`{}` → defaults (subsystem off). */
export function parseMeetingsConfig(value: unknown): MeetingsConfig {
  if (value === undefined || value === null) {
    return { ...DEFAULT_MEETINGS_CONFIG, appPatterns: [...DEFAULT_MEETING_APP_PATTERNS] };
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`meetings must be an object; got ${JSON.stringify(value)}`);
  }
  const raw = value as Record<string, unknown>;
  return {
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
  };
}
