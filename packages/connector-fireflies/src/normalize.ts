/**
 * Normalize Fireflies.ai transcripts into Remnic's provider-agnostic
 * `WearableConversation` shape, plus the timezone-aware day-window helpers
 * the Fireflies `transcripts(fromDate, toDate)` filter needs.
 *
 * Fireflies sentences carry `start_time`/`end_time` as second-offsets from the
 * meeting start (`date`, epoch ms); they are converted to absolute UTC here
 * (the same trap the Omi connector handles). Speaker turns come as
 * `speaker_name`/`speaker_id`; the wearables speaker registry owns final
 * naming, so we never guess `isWearer`. Meetings that expose a summary but no
 * transcript degrade to a single `note`-keyed segment — a note is still
 * day-anchored recall material.
 */

import type {
  WearableConversation,
  WearableTranscriptSegment,
} from "@remnic/core";

import type { FirefliesTranscript } from "./client.js";

export const FIREFLIES_SOURCE_ID = "fireflies";

/** "GMT+05:30" → "+05:30"; plain "GMT" → "+00:00". */
export function timezoneOffsetIso(instant: Date, timezone: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      timeZoneName: "longOffset",
    }).formatToParts(instant);
    const name = parts.find((part) => part.type === "timeZoneName")?.value ?? "GMT";
    const match = name.match(/GMT([+-]\d{2}:\d{2})?/);
    return match?.[1] ?? "+00:00";
  } catch {
    return "+00:00";
  }
}

/** ISO instant for local midnight of `date` in `timezone`. */
export function zonedDayStartIso(date: string, timezone: string): string {
  // Two-pass offset resolution: guess from midday (stable away from DST
  // transitions), then re-derive at the candidate midnight itself.
  let offset = timezoneOffsetIso(new Date(`${date}T12:00:00Z`), timezone);
  const candidate = new Date(`${date}T00:00:00${offset}`);
  const refined = timezoneOffsetIso(candidate, timezone);
  if (refined !== offset) {
    offset = refined;
  }
  return `${date}T00:00:00${offset}`;
}

export function nextIsoDate(date: string): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + 1);
  return parsed.toISOString().slice(0, 10);
}

/**
 * Reject an invalid/unsupported IANA timezone loudly. `Intl.DateTimeFormat`
 * throws a RangeError for an unknown zone; without this guard a typo'd
 * timezone would silently coerce to UTC and shift every meeting's day window
 * and timestamps (AGENTS.md §39 — reject, don't silently default).
 */
function assertValidTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
  } catch {
    throw new RangeError(
      `Invalid IANA timezone "${timezone}" for the Fireflies connector — check wearables.timezone.`,
    );
  }
}

/**
 * Half-open [fromDate, toDate) UTC ISO bounds of a local day — the window the
 * Fireflies `transcripts` query filters on.
 */
export function firefliesDayWindow(
  date: string,
  timezone: string,
): { fromDate: string; toDate: string } {
  assertValidTimezone(timezone);
  return {
    fromDate: new Date(zonedDayStartIso(date, timezone)).toISOString(),
    toDate: new Date(zonedDayStartIso(nextIsoDate(date), timezone)).toISOString(),
  };
}

/** Meeting start as epoch ms, from Fireflies' epoch-ms Float or ISO string. */
function meetingStartMs(date: FirefliesTranscript["date"]): number {
  if (typeof date === "number" && Number.isFinite(date)) return date;
  if (typeof date === "string") {
    const parsed = Date.parse(date);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Number.NaN;
}

function offsetToIso(startMs: number, offsetSeconds: number | null | undefined): string | undefined {
  if (Number.isNaN(startMs)) return undefined;
  if (typeof offsetSeconds !== "number" || !Number.isFinite(offsetSeconds)) return undefined;
  return new Date(startMs + offsetSeconds * 1_000).toISOString();
}

export function transcriptToConversation(transcript: FirefliesTranscript): WearableConversation {
  const startMs = meetingStartMs(transcript.date);
  const startIso = Number.isNaN(startMs) ? "" : new Date(startMs).toISOString();
  // Fireflies reports `duration` in minutes.
  const endIso =
    !Number.isNaN(startMs) && typeof transcript.duration === "number" && Number.isFinite(transcript.duration)
      ? new Date(startMs + transcript.duration * 60_000).toISOString()
      : undefined;

  const segments: WearableTranscriptSegment[] = [];
  for (const sentence of transcript.sentences ?? []) {
    const text = typeof sentence.text === "string" ? sentence.text.trim() : "";
    if (text.length === 0) continue;
    const speakerName =
      typeof sentence.speaker_name === "string" && sentence.speaker_name.trim().length > 0
        ? sentence.speaker_name.trim()
        : undefined;
    const speakerId =
      sentence.speaker_id !== null && sentence.speaker_id !== undefined
        ? String(sentence.speaker_id).trim()
        : undefined;
    const segStart = offsetToIso(startMs, sentence.start_time);
    const segEnd = offsetToIso(startMs, sentence.end_time);
    segments.push({
      text,
      speakerKey: speakerName ?? (speakerId && speakerId.length > 0 ? speakerId : "unknown"),
      ...(speakerName !== undefined ? { speakerName } : {}),
      ...(segStart !== undefined ? { startIso: segStart } : {}),
      ...(segEnd !== undefined ? { endIso: segEnd } : {}),
    });
  }

  const summaryText = firstNonEmpty(transcript.summary?.overview, transcript.summary?.short_summary);

  // Note-only fallback: a meeting with a summary but no transcript still
  // anchors recall for the day.
  if (segments.length === 0 && summaryText !== undefined) {
    segments.push({ text: summaryText, speakerKey: "note" });
  }

  const title = typeof transcript.title === "string" && transcript.title.trim().length > 0
    ? transcript.title.trim()
    : undefined;

  return {
    id: transcript.id,
    source: FIREFLIES_SOURCE_ID,
    ...(title !== undefined ? { title } : {}),
    ...(summaryText !== undefined ? { summary: summaryText } : {}),
    startIso,
    ...(endIso !== undefined ? { endIso } : {}),
    segments,
  };
}

function firstNonEmpty(...values: Array<string | null | undefined>): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return undefined;
}
