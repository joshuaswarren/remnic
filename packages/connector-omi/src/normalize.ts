/**
 * Normalize Omi conversations into Remnic's provider-agnostic
 * `WearableConversation` shape, plus the timezone-aware day-window
 * helpers the Omi API needs (its date filters are ISO datetimes).
 *
 * Legacy Omi integration segments carry `is_user` for the wearer,
 * opaque `SPEAKER_NN` diarization labels, optional `person_id`s
 * (user-defined people), and start/end offsets in seconds relative to
 * the conversation start. The current Developer API returns
 * `speaker_name`/`speaker_id` instead; normalize both shapes.
 */

import {
  activityDayWindow,
  timezoneOffsetIso as resolveTimezoneOffset,
  type WearableConversation,
  type WearableNativeMemory,
  type WearableTranscriptSegment,
} from "@remnic/core";

import type { OmiConversation, OmiMemory } from "./client.js";

export const OMI_SOURCE_ID = "omi";

/** "GMT+05:30" → "+05:30"; an unknown zone falls back to "+00:00" so a bad config never crashes the sync. */
export function timezoneOffsetIso(instant: Date, timezone: string): string {
  try {
    return resolveTimezoneOffset(instant, timezone);
  } catch {
    return "+00:00";
  }
}

export function nextIsoDate(date: string): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + 1);
  return parsed.toISOString().slice(0, 10);
}

/**
 * Half-open [start, end) local-midnight ISO bounds of a local day, in the
 * offset-datetime form the Omi API's date filters expect. Field names and
 * format map to the Omi API; the DST-aware window math is core's
 * `activityDayWindow`.
 */
export function omiDayWindow(
  date: string,
  timezone: string,
): { startIso: string; endIso: string } {
  const { startUtc, endUtc } = activityDayWindow(date, timezone);
  return {
    startIso: instantToOffsetIso(new Date(startUtc), timezone),
    endIso: instantToOffsetIso(new Date(endUtc), timezone),
  };
}

/**
 * Render a resolved instant as an offset datetime in `timezone`. Formatting
 * the wall-clock at that instant (not `T00:00:00`) is what preserves skipped
 * local midnights: a 00:00→01:00 spring-forward resolves to 01:00 local, and
 * rebuilding `T00:00:00` would move the instant an hour into the prior day.
 */
function instantToOffsetIso(instant: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const field = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "00";
  const day = `${field("year")}-${field("month")}-${field("day")}`;
  const time = `${field("hour")}:${field("minute")}:${field("second")}`;
  return `${day}T${time}${timezoneOffsetIso(instant, timezone)}`;
}

/**
 * @deprecated Compatibility wrapper (pre-core-refactor export); delegates to
 * `omiDayWindow`. Returns the resolved start bound, not a rebuilt midnight.
 */
export function zonedDayStartIso(date: string, timezone: string): string {
  return omiDayWindow(date, timezone).startIso;
}

/** @deprecated Compatibility wrapper (pre-core-refactor export); delegates to `omiDayWindow`. */
export function zonedDayBounds(
  date: string,
  timezone: string,
): { startIso: string; endIso: string } {
  return omiDayWindow(date, timezone);
}

export function conversationToWearable(
  conversation: OmiConversation,
): WearableConversation {
  const startedAtMs = conversation.started_at
    ? Date.parse(conversation.started_at)
    : Number.NaN;
  const segments: WearableTranscriptSegment[] = [];
  for (const segment of conversation.transcript_segments ?? []) {
    const text = typeof segment.text === "string" ? segment.text.trim() : "";
    if (text.length === 0) continue;
    const isWearer = segment.is_user === true;
    const personId =
      typeof segment.person_id === "string" && segment.person_id.length > 0
        ? segment.person_id
        : undefined;
    const speakerId =
      typeof segment.speaker_id === "string" || typeof segment.speaker_id === "number"
        ? String(segment.speaker_id)
        : undefined;
    const label =
      typeof segment.speaker_name === "string" && segment.speaker_name.trim().length > 0
        ? segment.speaker_name.trim()
        : typeof segment.speaker === "string" && segment.speaker.trim().length > 0
          ? segment.speaker.trim()
          : undefined;
    const startIso =
      !Number.isNaN(startedAtMs) && typeof segment.start === "number"
        ? new Date(startedAtMs + segment.start * 1_000).toISOString()
        : undefined;
    const endIso =
      !Number.isNaN(startedAtMs) && typeof segment.end === "number"
        ? new Date(startedAtMs + segment.end * 1_000).toISOString()
        : undefined;
    segments.push({
      text,
      // person_id is the most stable key when the user has tagged the
      // speaker as a known person in Omi. The Developer API's
      // speaker_id is the next best stable key, then the diarization
      // label.
      speakerKey: isWearer ? "user" : (personId ?? speakerId ?? label ?? "unknown"),
      ...(label !== undefined ? { speakerName: label } : {}),
      ...(isWearer ? { isWearer: true } : {}),
      ...(startIso !== undefined ? { startIso } : {}),
      ...(endIso !== undefined ? { endIso } : {}),
    });
  }

  const title = conversation.structured?.title?.trim();
  const overview = conversation.structured?.overview?.trim();
  const address = conversation.geolocation?.address;

  return {
    id: conversation.id,
    source: OMI_SOURCE_ID,
    ...(title && title.length > 0 ? { title } : {}),
    ...(overview && overview.length > 0 ? { summary: overview } : {}),
    startIso: conversation.started_at ?? conversation.created_at ?? "",
    ...(conversation.finished_at !== undefined
      ? { endIso: conversation.finished_at }
      : {}),
    ...(typeof address === "string" && address.length > 0
      ? { location: address }
      : {}),
    segments,
  };
}

export function memoryToNativeMemory(memory: OmiMemory): WearableNativeMemory | null {
  const content = typeof memory.content === "string" ? memory.content.trim() : "";
  if (content.length === 0) return null;
  return {
    id: memory.id,
    content,
    ...(memory.created_at !== undefined ? { createdIso: memory.created_at } : {}),
    ...(Array.isArray(memory.tags) && memory.tags.length > 0
      ? { tags: memory.tags }
      : {}),
  };
}
