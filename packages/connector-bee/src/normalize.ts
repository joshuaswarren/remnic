/**
 * Normalize Bee conversations into Remnic's provider-agnostic
 * `WearableConversation` shape.
 *
 * Bee timestamps are epoch milliseconds; utterance `speaker` values are
 * opaque diarization labels ("0", "1", ...) with no wearer marker — the
 * Remnic speaker registry is how labels become names
 * (`remnic wearables speakers set bee 0 "You" --self`).
 */

import type {
  WearableConversation,
  WearableNativeMemory,
  WearableTranscriptSegment,
} from "@remnic/core";

import type { BeeConversationDetail, BeeFact } from "./client.js";

export const BEE_SOURCE_ID = "bee";

function msToIso(ms: number | null | undefined): string | undefined {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return undefined;
  return new Date(ms).toISOString();
}

export function conversationToWearable(
  detail: BeeConversationDetail,
): WearableConversation {
  const segments: WearableTranscriptSegment[] = [];
  for (const transcription of detail.transcriptions ?? []) {
    for (const utterance of transcription.utterances ?? []) {
      const text = typeof utterance.text === "string" ? utterance.text.trim() : "";
      if (text.length === 0) continue;
      const speaker =
        typeof utterance.speaker === "string" && utterance.speaker.trim().length > 0
          ? utterance.speaker.trim()
          : "unknown";
      segments.push({
        text,
        speakerKey: speaker,
        ...(msToIso(utterance.spoken_at) !== undefined
          ? { startIso: msToIso(utterance.spoken_at) }
          : {}),
      });
    }
  }
  // Bee nests utterances per transcription block; order within a block
  // is chronological but blocks can interleave — sort stably by time
  // when timestamps exist.
  segments.sort((a, b) => {
    const aMs = a.startIso ? Date.parse(a.startIso) : Number.NaN;
    const bMs = b.startIso ? Date.parse(b.startIso) : Number.NaN;
    if (Number.isNaN(aMs) || Number.isNaN(bMs)) return 0;
    if (aMs < bMs) return -1;
    if (aMs > bMs) return 1;
    return 0;
  });

  const title =
    typeof detail.short_summary === "string" && detail.short_summary.trim().length > 0
      ? detail.short_summary.trim().split("\n")[0]
      : undefined;

  return {
    id: String(detail.id),
    source: BEE_SOURCE_ID,
    ...(title !== undefined ? { title } : {}),
    ...(typeof detail.summary === "string" && detail.summary.trim().length > 0
      ? { summary: detail.summary.trim() }
      : {}),
    startIso: msToIso(detail.start_time) ?? "",
    ...(msToIso(detail.end_time ?? undefined) !== undefined
      ? { endIso: msToIso(detail.end_time ?? undefined) }
      : {}),
    ...(typeof detail.primary_location?.address === "string" &&
    detail.primary_location.address.length > 0
      ? { location: detail.primary_location.address }
      : {}),
    segments,
  };
}

export function factToNativeMemory(fact: BeeFact): WearableNativeMemory {
  return {
    id: String(fact.id),
    content: fact.text,
    ...(msToIso(fact.created_at) !== undefined
      ? { createdIso: msToIso(fact.created_at) }
      : {}),
    ...(Array.isArray(fact.tags) && fact.tags.length > 0 ? { tags: fact.tags } : {}),
  };
}
