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
import { CaptureConfigError, CaptureInputError } from "./errors.js";
import { ulid } from "./util.js";

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

/** Default per issue #1897 config surface. */
export const DEFAULT_CONVERSATION_GAP_MINUTES = 10;

/** A conversation the stateful assembler is building incrementally. */
export interface AssembledConversation {
  id: string;
  startedAtUtc: string;
  endedAtUtc: string;
  state: ConversationState;
  segments: AssemblySegment[];
}

export interface AssemblerOptions {
  gapMinutes?: number;
  /** Injectable for deterministic ids in tests; defaults to `conv_<ulid>`. */
  makeId?: () => string;
}

/** Parse an ISO-8601 timestamp to epoch ms, rejecting garbage loudly. */
function epochMs(value: string, field: string): number {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) {
    throw new CaptureInputError(`segment.${field}: expected an ISO-8601 timestamp`);
  }
  return ms;
}

/**
 * Incremental sibling of `assembleConversations` for the live daemon: feed
 * segments one chunk at a time and it groups them into conversations under the
 * same `gap < threshold` rule, tracking a single open (`capturing`)
 * conversation. The batch function stays the source of truth for replay; this
 * class owns the streaming case. Pure in-memory — the processor decides when to
 * persist and provides restart continuity via `resume`.
 */
export class ConversationAssembler {
  readonly #gapMs: number;
  readonly #makeId: () => string;
  readonly #conversations: AssembledConversation[] = [];

  constructor(options: AssemblerOptions = {}) {
    const gapMinutes = options.gapMinutes ?? DEFAULT_CONVERSATION_GAP_MINUTES;
    if (!Number.isFinite(gapMinutes) || gapMinutes < 0) {
      throw new CaptureConfigError("conversationGapMinutes must be a non-negative number");
    }
    this.#gapMs = gapMinutes * 60_000;
    this.#makeId = options.makeId ?? (() => `conv_${ulid()}`);
  }

  /**
   * Append one segment, returning the conversation it landed in. Segments
   * arrive in non-decreasing start order; a gap of at least the threshold
   * closes the open conversation and starts a new one.
   */
  add(segment: AssemblySegment): AssembledConversation {
    const startMs = epochMs(segment.startUtc, "startUtc");
    epochMs(segment.endUtc, "endUtc");
    const open = this.#open();
    if (open) {
      const lastEnd = epochMs(open.endedAtUtc, "endedAtUtc");
      if (startMs - lastEnd >= this.#gapMs) {
        open.state = "final";
      } else {
        open.segments.push(segment);
        if (segment.endUtc > open.endedAtUtc) open.endedAtUtc = segment.endUtc;
        return open;
      }
    }
    return this.#start(segment);
  }

  /** Flip every open (`capturing`) conversation to `final`; returns the count changed. */
  finalize(): number {
    let changed = 0;
    for (const conv of this.#conversations) {
      if (conv.state === "capturing") {
        conv.state = "final";
        changed++;
      }
    }
    return changed;
  }

  /**
   * Re-open a conversation recovered from durable storage so a chunk arriving
   * after a process restart continues it (subject to the same gap rule via
   * `add`) instead of splitting off a new one. No-op when a conversation is
   * already open in this run.
   */
  resume(conversation: { id: string; startedAtUtc: string; endedAtUtc: string }): void {
    if (this.#open()) return;
    epochMs(conversation.endedAtUtc, "endedAtUtc");
    this.#conversations.push({
      id: conversation.id,
      startedAtUtc: conversation.startedAtUtc,
      endedAtUtc: conversation.endedAtUtc,
      state: "capturing",
      segments: [],
    });
  }

  /** Ordered snapshot; segments are cloned so callers cannot mutate internal state. */
  conversations(): AssembledConversation[] {
    return this.#conversations.map((conv) => ({ ...conv, segments: conv.segments.slice() }));
  }

  /**
   * Finalize the open conversation when `nowUtc` is at least the gap past its
   * last segment, so a run of silent chunks (which carry no segments to `add`)
   * still closes a conversation instead of leaving it `capturing` until stop.
   * Returns the closed conversation's id, or null when nothing closed.
   */
  closeIfIdle(nowUtc: string): string | null {
    const open = this.#open();
    if (!open) return null;
    if (epochMs(nowUtc, "nowUtc") - epochMs(open.endedAtUtc, "endedAtUtc") < this.#gapMs) return null;
    open.state = "final";
    return open.id;
  }

  #open(): AssembledConversation | undefined {
    const last = this.#conversations[this.#conversations.length - 1];
    return last && last.state === "capturing" ? last : undefined;
  }

  #start(segment: AssemblySegment): AssembledConversation {
    const conv: AssembledConversation = {
      id: this.#makeId(),
      startedAtUtc: segment.startUtc,
      endedAtUtc: segment.endUtc,
      state: "capturing",
      segments: [segment],
    };
    this.#conversations.push(conv);
    return conv;
  }
}
