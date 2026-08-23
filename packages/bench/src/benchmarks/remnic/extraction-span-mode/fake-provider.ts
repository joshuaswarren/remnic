/**
 * Deterministic fake extraction provider (issue #2333 Phase A).
 *
 * Simulates ONE small local extraction model under two prompt/schema variants
 * ("current" = full generated restatement, "span" = offsets + frame) with the
 * same model, same seed, same fact selection. No network, no secrets.
 *
 * Cost model, applied identically to both variants:
 * - output tokens: whole serialized JSON response payloads, 4 chars/token
 *   (the @remnic/core extraction-span-tokens convention);
 * - wall-clock: decode-bound local model at MS_PER_OUTPUT_TOKEN per output
 *   token (25 tok/s — small-local decode rate). Prefill is ignored; the
 *   experiment's premise is that generation output dominates extraction cost.
 *
 * Span corruption profile (seeded, deterministic):
 * - ~4% of facts get an INVALID span (out-of-range end, empty interval, or
 *   reversed) → counted as validation fallbacks;
 * - ~2% get an IN-BOUNDS DRIFTED span (+3 chars both ends) → materializes
 *   "successfully" but to slightly wrong text; only the judge catches it.
 */

import { estimateGeneratedTokens } from "@remnic/core/extraction-span-tokens";
import { createSeededRandom, type SeededRandom } from "../../../seeded-random.js";
import type { SpanBenchConversation, SpanBenchGoldFact } from "./fixture.js";
import type { CurrentModeFact, SpanModeFact } from "./schema.js";

/** 25 output tokens/second → 40 ms per output token. */
export const MS_PER_OUTPUT_TOKEN = 40;

export const INVALID_SPAN_RATE = 0.04;
export const DRIFT_SPAN_RATE = 0.02;
export const DRIFT_CHARS = 3;

export type ExtractionMode = "current" | "span";

export interface ProviderFactBase {
  category: SpanBenchGoldFact["category"];
  confidence: number;
  tags: string[];
}

export interface ProviderRun {
  /** Facts exactly as the model emitted them (pre-materialization). */
  rawFacts: unknown[];
  /** Serialized response payload — the output-token cost carrier. */
  responsePayload: string;
  outputTokens: number;
  /** Modeled decode-bound wall-clock for this conversation. */
  wallClockMs: number;
  /** Persisted memory entry count for this conversation. */
  memoryEntryCount: number;
}

function goldSpan(gold: SpanBenchGoldFact, conversation: SpanBenchConversation) {
  const text = conversation.messages[gold.messageIndex]?.text;
  if (text === undefined) {
    throw new Error(`fixture fact ${gold.id} references missing message ${gold.messageIndex}`);
  }
  const charStart = text.indexOf(gold.quote);
  if (charStart < 0) {
    throw new Error(`fixture fact ${gold.id} quote is not a verbatim substring of message ${gold.messageIndex}`);
  }
  return { charStart, charEnd: charStart + gold.quote.length };
}

export function runFakeExtraction(
  conversation: SpanBenchConversation,
  mode: ExtractionMode,
  seed: number,
): ProviderRun {
  // Same model + same seed → identical fact selection and RNG stream shape
  // across both variants; only the emission format differs. The per-
  // conversation salt decorrelates offset-error draws: reseeding every
  // conversation with the identical stream would corrupt the same fact slot
  // in every conversation (one bad draw amplified N times).
  const rng = createSeededRandom((seed * 0x1000193 + stableConversationSalt(conversation.id)) % 0x100000000);

  const rawFacts: unknown[] = conversation.facts.map((gold) => {
    const base: ProviderFactBase = {
      category: gold.category,
      confidence: gold.confidence,
      tags: gold.tags,
    };
    if (mode === "current") {
      const fact: CurrentModeFact = { ...base, content: gold.restatement, quote: gold.quote };
      return fact;
    }
    return emitSpanFact(gold, conversation, rng);
  });

  const responsePayload = JSON.stringify(rawFacts);
  const outputTokens = estimateGeneratedTokens(responsePayload.length);
  return {
    rawFacts,
    responsePayload,
    outputTokens,
    wallClockMs: outputTokens * MS_PER_OUTPUT_TOKEN,
    memoryEntryCount: rawFacts.length,
  };
}

function stableConversationSalt(id: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i += 1) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function emitSpanFact(
  gold: SpanBenchGoldFact,
  conversation: SpanBenchConversation,
  rng: SeededRandom,
): SpanModeFact {
  const { charStart, charEnd } = goldSpan(gold, conversation);
  const messageLength = conversation.messages[gold.messageIndex].text.length;
  const roll = rng();
  // The frame is the ONLY generated text in span mode — no content field is
  // emitted (that omission is the token saving). Materialization falls back
  // to the frame when the span fails validation.
  const base = { category: gold.category, confidence: gold.confidence, tags: gold.tags };

  if (roll < INVALID_SPAN_RATE) {
    const variant = Math.floor((roll / INVALID_SPAN_RATE) * 3) % 3;
    if (variant === 0) {
      return { ...base, span: { sourceMessageIndex: gold.messageIndex, charStart, charEnd: messageLength + 1, frame: gold.frame } };
    }
    if (variant === 1) {
      return { ...base, span: { sourceMessageIndex: gold.messageIndex, charStart, charEnd: charStart, frame: gold.frame } };
    }
    return { ...base, span: { sourceMessageIndex: gold.messageIndex, charStart: charEnd, charEnd: charStart, frame: gold.frame } };
  }
  if (
    roll < INVALID_SPAN_RATE + DRIFT_SPAN_RATE &&
    charStart + DRIFT_CHARS < charEnd &&
    charEnd + DRIFT_CHARS <= messageLength
  ) {
    return {
      ...base,
      span: {
        sourceMessageIndex: gold.messageIndex,
        charStart: charStart + DRIFT_CHARS,
        charEnd: charEnd + DRIFT_CHARS,
        frame: gold.frame,
      },
    };
  }
  return {
    ...base,
    span: { sourceMessageIndex: gold.messageIndex, charStart, charEnd, frame: gold.frame },
  };
}
