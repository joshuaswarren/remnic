/**
 * Normalize Granola notes into Remnic's provider-agnostic
 * `WearableConversation` shape, plus the timezone-aware day-window helpers the
 * Granola `created_after`/`created_before` filters need.
 *
 * Granola transcript items carry absolute `start_time`/`end_time` (ISO) and a
 * `speaker.source` of `microphone` (the wearer's own captured audio) or
 * `speaker` (other meeting audio); iOS adds a `diarization_label`
 * (`Speaker A/B/...`). The wearables speaker registry owns final naming.
 * Meeting timing prefers the linked calendar event; notes with a summary but no
 * transcript degrade to a single `note` segment.
 */

import type {
  WearableConversation,
  WearableTranscriptSegment,
} from "@remnic/core";

import type { GranolaNote } from "./client.js";

export const GRANOLA_SOURCE_ID = "granola";

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
 * Reject an invalid/unsupported IANA timezone loudly instead of silently
 * coercing to UTC and shifting every meeting's day window (AGENTS.md §39).
 */
function assertValidTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
  } catch {
    throw new RangeError(
      `Invalid IANA timezone "${timezone}" for the Granola connector — check wearables.timezone.`,
    );
  }
}

/**
 * Half-open [createdAfter, createdBefore) UTC ISO bounds of a local day — the
 * window the Granola notes list filters on.
 */
export function granolaDayWindow(
  date: string,
  timezone: string,
): { createdAfter: string; createdBefore: string } {
  assertValidTimezone(timezone);
  return {
    createdAfter: new Date(zonedDayStartIso(date, timezone)).toISOString(),
    createdBefore: new Date(zonedDayStartIso(nextIsoDate(date), timezone)).toISOString(),
  };
}

function trimmed(value: string | null | undefined): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function isoOrUndefined(value: string | null | undefined): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

export function noteToConversation(note: GranolaNote): WearableConversation {
  const event = note.calendar_event ?? undefined;
  const items = note.transcript ?? [];

  const segments: WearableTranscriptSegment[] = [];
  for (const item of items) {
    const text = trimmed(item.text);
    if (text === undefined) continue;
    const source = trimmed(item.speaker?.source);
    const label = trimmed(item.speaker?.diarization_label);
    const startIso = isoOrUndefined(item.start_time);
    const endIso = isoOrUndefined(item.end_time);
    // macOS marks the wearer's own audio as `microphone` (vs `speaker` for
    // other meeting audio). When a diarization_label is present (iOS single
    // stream) the source no longer distinguishes the wearer, so don't guess.
    const isWearer = source === "microphone" && label === undefined;
    segments.push({
      text,
      speakerKey: label ?? source ?? "unknown",
      ...(isWearer ? { isWearer: true } : {}),
      ...(startIso !== undefined ? { startIso } : {}),
      ...(endIso !== undefined ? { endIso } : {}),
    });
  }

  const summary = trimmed(note.summary_text) ?? trimmed(note.summary_markdown);

  // Note-only fallback: a summarized meeting with no transcript still anchors
  // recall for the day.
  if (segments.length === 0 && summary !== undefined) {
    segments.push({ text: summary, speakerKey: "note" });
  }

  const title = trimmed(event?.event_title) ?? trimmed(note.title);
  const startIso =
    isoOrUndefined(event?.scheduled_start_time) ??
    segments.find((segment) => segment.startIso !== undefined)?.startIso ??
    isoOrUndefined(note.created_at) ??
    "";
  const endIso =
    isoOrUndefined(event?.scheduled_end_time) ??
    [...segments].reverse().find((segment) => segment.endIso !== undefined)?.endIso;

  return {
    id: note.id,
    source: GRANOLA_SOURCE_ID,
    ...(title !== undefined ? { title } : {}),
    ...(summary !== undefined ? { summary } : {}),
    startIso,
    ...(endIso !== undefined ? { endIso } : {}),
    segments,
  };
}
