/**
 * Span-mode segment rendering (issue #2333 Phase A).
 *
 * Renders the numbered, offset-guided segment the extraction LLM sees in span
 * mode, and stamps each message's exact text so materialization can reject
 * offset drift (the stamp covers the same string the model indexed — no
 * trimming, no newline normalization).
 *
 * Offsets index JavaScript string positions (UTF-16 code units) of the message
 * `text` exactly as rendered. The `[charStart, charEnd)` interval is
 * end-exclusive.
 */

import { stampSpanSource, type SpanSourceStamp } from "@remnic/core/extraction-span-source-hash";
import type { SpanBenchConversation } from "./fixture.js";

export interface SegmentMessage {
  index: number;
  speaker: string;
  /** The exact string the model indexes. Offsets die at materialization. */
  text: string;
  /** Hash + length of `text` as sent. Materialization must verify this. */
  stamp: SpanSourceStamp;
}

export interface RenderedSegment {
  messages: SegmentMessage[];
  /** Full prompt-rendered segment text (numbered lines + span guidance). */
  prompt: string;
}

export function renderSegment(conversation: SpanBenchConversation): RenderedSegment {
  const lines: string[] = [
    "Numbered conversation segment. Character offsets index each message text",
    "exactly as printed below (offsets are [charStart, charEnd), end-exclusive).",
    "For each memory, return sourceMessageIndex plus a verbatim supporting",
    "span's charStart/charEnd, and a frame of at most 15 words that makes the",
    "span self-contained (resolve pronouns, name the subject).",
    "",
  ];
  const messages = conversation.messages.map<SegmentMessage>((message, index) => {
    const line = `[${index}] ${message.speaker}: ${message.text}`;
    lines.push(`(${line.length} chars) ${line}`);
    return {
      index,
      speaker: message.speaker,
      text: message.text,
      stamp: stampSpanSource(message.text),
    };
  });
  return { messages, prompt: lines.join("\n") };
}
