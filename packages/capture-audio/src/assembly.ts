/**
 * Pure conversation assembly (issue #1897, Component 2 step 5).
 *
 * A conversation is a run of consecutive speech segments whose inter-segment
 * gap stays *strictly below* `conversationGapMinutes`. The first segment at or
 * beyond that gap opens the next conversation and closes the prior one. A
 * conversation still receiving segments is `capturing`; it flips to `final`
 * when the next one begins or on an explicit `finalize()`.
 *
 * This module is pure in-memory logic — no I/O, deterministic given the
 * injected id generator — so the daemon's processing layer owns when to feed
 * segments and when to persist. Durable persistence and replay idempotency
 * live in the Spool (`appendAssembledSegments`).
 */

import { CaptureConfigError, CaptureInputError } from "./errors.js";
import type { ConversationState } from "./spool.js";
import { ulid } from "./util.js";

/** Default per issue #1897 config surface. */
export const DEFAULT_CONVERSATION_GAP_MINUTES = 10;

export interface AssemblySegment {
  channel: string;
  text: string;
  startUtc: string;
  endUtc: string;
  speakerCluster?: string | null;
  isWearer?: boolean;
}

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

export class ConversationAssembler {
  readonly #gapMs: number;
  readonly #makeId: () => string;
  readonly #conversations: AssembledConversation[] = [];

  constructor(options: AssemblerOptions = {}) {
    const gapMinutes = options.gapMinutes ?? DEFAULT_CONVERSATION_GAP_MINUTES;
    if (!Number.isFinite(gapMinutes) || gapMinutes <= 0) {
      throw new CaptureConfigError("conversationGapMinutes must be a positive number");
    }
    this.#gapMs = gapMinutes * 60_000;
    this.#makeId = options.makeId ?? (() => `conv_${ulid()}`);
  }

  /**
   * Append one segment, returning the conversation it landed in. Segments
   * arrive in non-decreasing start order (the daemon feeds transcribed chunks
   * in time order); a gap of at least the threshold closes the open
   * conversation and starts a new one.
   */
  add(segment: AssemblySegment): AssembledConversation {
    const startMs = epochMs(segment.startUtc, "startUtc");
    epochMs(segment.endUtc, "endUtc");
    const open = this.#open();
    if (open) {
      const lastEnd = epochMs(open.segments[open.segments.length - 1].endUtc, "endUtc");
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

  /** Ordered snapshot; segments are cloned so callers cannot mutate internal state. */
  conversations(): AssembledConversation[] {
    return this.#conversations.map((conv) => ({ ...conv, segments: conv.segments.slice() }));
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
