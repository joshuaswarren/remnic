/**
 * Normalize Omi conversations into Remnic's provider-agnostic
 * `WearableConversation` shape, plus the timezone-aware day-window
 * helpers the Omi API needs (its date filters are ISO datetimes).
 *
 * Omi segments carry `is_user` for the wearer, opaque `SPEAKER_NN`
 * diarization labels, optional `person_id`s (user-defined people), and
 * start/end offsets in seconds relative to the conversation start.
 */

import type {
  WearableConversation,
  WearableNativeMemory,
  WearableTranscriptSegment,
} from "@remnic/core";

import type { OmiConversation, OmiMemory } from "./client.js";

export const OMI_SOURCE_ID = "omi";

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

/** Half-open [start, end) ISO bounds of a local day. */
export function zonedDayBounds(
  date: string,
  timezone: string,
): { startIso: string; endIso: string } {
  return {
    startIso: zonedDayStartIso(date, timezone),
    endIso: zonedDayStartIso(nextIsoDate(date), timezone),
  };
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
    const label =
      typeof segment.speaker === "string" && segment.speaker.trim().length > 0
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
      // speaker as a known person in Omi; the diarization label
      // otherwise.
      speakerKey: isWearer ? "user" : (personId ?? label ?? "unknown"),
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
