/**
 * Span materialization + validation (issue #2333 Phase A).
 *
 * `materializeSpanFact` slices the exact string the model saw, validates it,
 * and falls open PER FACT to the fact's generated `content` on any failure.
 * Fail-open never throws and never drops the fact: a bad span costs the
 * token savings for that fact, not the memory itself.
 *
 * Validation rejects:
 * - out-of-range or non-integer offsets, empty or reversed intervals
 *   (`0 <= charStart < charEnd <= message.length`, end-exclusive),
 * - slices longer than 400 chars,
 * - whitespace-only slices,
 * - frames longer than 15 words,
 * - source drift: the message text's stamp (sha256 + length of the exact
 *   string sent to the model) no longer verifying.
 */

import { verifySpanSource } from "@remnic/core/extraction-span-source-hash";
import type { SegmentMessage } from "./segment.js";
import type { SpanModeFact } from "./schema.js";

export const SPAN_MAX_SLICE_CHARS = 400;
export const SPAN_MAX_FRAME_WORDS = 15;

export type SpanMaterializeOutcome = "span" | "fallback";

export interface MaterializedFact {
  /** The single content form everything downstream sees. */
  content: string;
  outcome: SpanMaterializeOutcome;
  /** Machine-readable rejection reason; undefined when the span materialized. */
  reason?: string;
  /** Provenance triple — offsets die here, never persisted. */
  quote?: string;
  charStart?: number;
  charEnd?: number;
  sourceMessageIndex?: number;
}

function reject(reason: string, fallbackContent: string): MaterializedFact {
  return { content: fallbackContent, outcome: "fallback", reason };
}

export function materializeSpanFact(
  fact: SpanModeFact,
  segmentMessages: readonly SegmentMessage[],
): MaterializedFact {
  // Fail-open falls back to the fact's generated content; in span mode the
  // only generated text is the span's own frame, so that is the fallback.
  const fallbackContent = (fact.content ?? fact.span?.frame ?? "").trim();
  const span = fact.span ?? null;

  if (span === null) {
    return reject("no_span", fallbackContent);
  }
  if (fallbackContent === "") {
    // The fail-open path needs generated content to fall back to; without it
    // the fact is unmaterializable. Reject loudly rather than persist "".
    return { content: "", outcome: "fallback", reason: "missing_fallback_content" };
  }

  const { sourceMessageIndex, charStart, charEnd, frame } = span;
  if (!Number.isInteger(sourceMessageIndex) || sourceMessageIndex < 0 || sourceMessageIndex >= segmentMessages.length) {
    return reject("message_index_out_of_range", fallbackContent);
  }
  const message = segmentMessages[sourceMessageIndex];

  const stampCheck = verifySpanSource(message.text, message.stamp);
  if (!stampCheck.ok) {
    return reject(`source_${stampCheck.error}`, fallbackContent);
  }

  if (
    !Number.isInteger(charStart) ||
    !Number.isInteger(charEnd) ||
    charStart < 0 ||
    charEnd > message.text.length
  ) {
    return reject("offsets_out_of_range", fallbackContent);
  }
  if (charStart >= charEnd) {
    return reject("empty_interval", fallbackContent);
  }

  const slice = message.text.slice(charStart, charEnd);
  if (slice.length > SPAN_MAX_SLICE_CHARS) {
    return reject("slice_too_long", fallbackContent);
  }
  if (slice.trim() === "") {
    return reject("blank_slice", fallbackContent);
  }
  const frameWords = frame.trim().split(/\s+/).filter(Boolean);
  if (frameWords.length === 0 || frameWords.length > SPAN_MAX_FRAME_WORDS) {
    return reject("frame_word_count", fallbackContent);
  }

  const trimmedFrame = frameWords.join(" ");
  const content = frameEndsWithPunctuation(trimmedFrame)
    ? `${trimmedFrame} ${slice}`
    : `${trimmedFrame}: ${slice}`;
  return {
    content,
    outcome: "span",
    quote: slice,
    charStart,
    charEnd,
    sourceMessageIndex,
  };
}

function frameEndsWithPunctuation(frame: string): boolean {
  return /[:—-]$/.test(frame);
}
