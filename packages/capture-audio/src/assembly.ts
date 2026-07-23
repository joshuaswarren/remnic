/**
 * Conversation assembly (issue #1897, component 2.5).
 *
 * A conversation is a maximal run of consecutive speech segments whose
 * inter-segment gap stays below `conversationGapMinutes`. A gap greater
 * than OR EQUAL to the threshold starts a new conversation (the join rule
 * is strictly `gap < threshold`, per the issue). Pure over ordered
 * segments so the daemon pipeline and unit tests share one implementation;
 * output rows map 1:1 to Spool.insertConversation input.
 */

import type { ConversationInput, ConversationState, SegmentInput } from "./spool.js";

/** A segment as it enters assembly (post dedup + diarization). */
export type AssemblySegment = SegmentInput;

/**
 * Group ordered segments into conversations. Segments MUST already be in
 * chronological order (the pipeline emits them that way). Each returned
 * row omits `id` so Spool.insertConversation mints a `conv_<ulid>`.
 *
 * `gapMinutes` is the max silence that keeps two segments in the same
 * conversation; `state` is applied to every produced conversation
 * (default "final" — the API only serves final; callers pass "capturing"
 * for the still-open tail).
 */
export function assembleConversations(
  segments: readonly AssemblySegment[],
  gapMinutes: number,
  state: ConversationState = "final",
): ConversationInput[] {
  if (!Number.isFinite(gapMinutes) || gapMinutes < 0) {
    throw new Error("assembleConversations: gapMinutes must be a non-negative number");
  }
  const gapMs = gapMinutes * 60_000;
  const conversations: ConversationInput[] = [];
  let current: AssemblySegment[] = [];
  let prevEndMs = Number.NaN;

  const flush = (): void => {
    if (current.length === 0) return;
    const startedAtUtc = current[0].startUtc;
    const endedAtUtc = current[current.length - 1].endUtc;
    conversations.push({ startedAtUtc, endedAtUtc, state, segments: current });
    current = [];
  };

  for (const seg of segments) {
    const startMs = Date.parse(seg.startUtc);
    if (current.length > 0 && Number.isFinite(prevEndMs) && Number.isFinite(startMs) && startMs - prevEndMs >= gapMs) {
      flush();
    }
    current.push(seg);
    const endMs = Date.parse(seg.endUtc);
    prevEndMs = Number.isFinite(endMs) ? endMs : startMs;
  }
  flush();
  return conversations;
}
