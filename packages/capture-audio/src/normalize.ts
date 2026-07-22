/**
 * Normalize the daemon's `final` conversations into Remnic's
 * provider-agnostic `WearableConversation` shape.
 *
 * The daemon already diarized and finalized each conversation; this is a
 * pure field mapping — no cleanup, corrections, or trust gating (those
 * stay in core so every wearable source shares one pipeline). The
 * per-channel origin (`mic` / `system`) is a capture detail with no place
 * in the provider-agnostic segment, so it is intentionally dropped here.
 */

import type { WearableConversation, WearableTranscriptSegment } from "@remnic/core";

import type { DaemonConversation, DaemonSegment } from "./spool.js";

export const DESKTOP_SOURCE_ID = "desktop";

export function daemonConversationToWearable(
  conversation: DaemonConversation,
): WearableConversation {
  return {
    id: conversation.id,
    source: DESKTOP_SOURCE_ID,
    startIso: conversation.startedAtUtc,
    ...(conversation.endedAtUtc ? { endIso: conversation.endedAtUtc } : {}),
    segments: conversation.segments.map(segmentToWearable),
  };
}

function segmentToWearable(segment: DaemonSegment): WearableTranscriptSegment {
  return {
    text: segment.textRaw,
    // The daemon keys speakers by diarization cluster; an unclustered
    // utterance keys as "unknown" so the speaker registry can still
    // resolve it as `desktop:unknown`.
    speakerKey: segment.speakerKey ?? "unknown",
    ...(segment.isWearer ? { isWearer: true } : {}),
    ...(segment.startUtc ? { startIso: segment.startUtc } : {}),
    ...(segment.endUtc ? { endIso: segment.endUtc } : {}),
  };
}
