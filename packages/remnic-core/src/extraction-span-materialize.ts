/**
 * Span-mode materialization for production extraction (issue #2333 Phase B).
 *
 * Runs immediately after the extraction result is parsed and BEFORE
 * sanitize/grounding/judge/dedup/persistence, so everything downstream sees
 * exactly one content form and the content-hash dedup invariant (checklist
 * §13) holds by construction. Offsets die here — nothing offset-based is
 * stored.
 *
 * Modes:
 * - "off":    spans are never requested; a stray span is stripped untrusted.
 * - "shadow": spans are requested alongside full content; materialization
 *             runs for comparison only, the generated content is persisted
 *             unchanged (zero behavior change), agreement telemetry logged.
 * - "on":     materialized frame+span content is persisted; per-fact fail-open
 *             to the generated content (the frame) on any validation failure.
 *
 * Validation (identical to the Phase A bench contract):
 * - `0 <= charStart < charEnd <= turn.text.length`, end-exclusive, integers;
 * - slice length <= 400 chars and non-whitespace;
 * - frame 1..15 words;
 * - the turn text's stamp (sha256 + length of the exact in-memory string the
 *   model saw) must verify — offset drift is rejected, never guessed around.
 */

import { log } from "./logger.js";
import { stampSpanSource, verifySpanSource, type SpanSourceStamp } from "./extraction-span-source-hash.js";
import { validateSpanOffsets } from "./extraction-span-validate.js";
import { sliceSpanText } from "./extraction-span-slice.js";
import type { ExtractionResult } from "./types.js";
import type { ExtractedFactSpanRef } from "./extraction-span-config.js";

export const SPAN_MAX_SLICE_CHARS = 400;
export const SPAN_MAX_FRAME_WORDS = 15;

export type SpanMode = "off" | "shadow" | "on";

/** A source turn exactly as rendered into the extraction prompt. */
export interface SpanMaterializeTurn {
  text: string;
  stamp: SpanSourceStamp;
}

export interface SpanMaterializeFact {
  content: string;
  span?: ExtractedFactSpanRef | null;
  quote?: string;
}

export interface SpanMaterializeTelemetry {
  /** Facts that carried a span ref. */
  attempts: number;
  /** Spans that failed validation and fell back to generated content. */
  fallbacks: number;
  /** Shadow mode only: comparisons made / exact-or-containment agreements. */
  shadowComparisons: number;
  shadowAgreements: number;
}

/** Strip span refs from facts that were never given the span prompt
 * (e.g. the proactive second pass). Untrusted: never validated, never used.
 * The key is omitted entirely so no `span: undefined` reaches persistence. */
export function stripUntrustedFactSpans<T extends { span?: unknown }>(facts: readonly T[]): T[] {
  return facts.map((fact) => {
    if (fact.span === undefined || fact.span === null) return fact;
    const { span: _span, ...rest } = fact;
    return rest as T;
  });
}

export function buildSpanMaterializeTurns(texts: readonly string[]): SpanMaterializeTurn[] {
  return texts.map((text) => ({ text, stamp: stampSpanSource(text) }));
}

export function factCarriesSpan(fact: { span?: ExtractedFactSpanRef | null }): boolean {
  return fact.span !== undefined && fact.span !== null;
}

/**
 * Materialize one fact's span. Never throws: any validation failure falls
 * open to the fact's generated content and is counted.
 */
export function materializeFactSpan<T extends SpanMaterializeFact>(
  fact: T,
  turns: readonly SpanMaterializeTurn[],
  mode: SpanMode,
): { fact: T; outcome: "span" | "fallback"; materialized?: string } {
  const span = fact.span ?? null;
  if (span === null) {
    return { fact, outcome: "fallback" };
  }
  const { sourceMessageIndex, charStart, charEnd, frame, sourceHash, sourceLength } = span;
  const turn = turns[sourceMessageIndex];
  if (
    !Number.isInteger(sourceMessageIndex) ||
    sourceMessageIndex < 0 ||
    sourceMessageIndex >= turns.length ||
    turn === undefined
  ) {
    return { fact: stripSpan(fact), outcome: "fallback" };
  }
  const stampCheck = verifySpanSource(turn.text, turn.stamp);
  if (!stampCheck.ok) {
    return { fact: stripSpan(fact), outcome: "fallback" };
  }
  if (
    (sourceHash !== undefined && sourceHash !== turn.stamp.hash) ||
    (sourceLength !== undefined && sourceLength !== turn.stamp.length)
  ) {
    return { fact: stripSpan(fact), outcome: "fallback" };
  }
  const offsetCheck = validateSpanOffsets({ start: charStart, end: charEnd, textLength: turn.text.length });
  if (!offsetCheck.ok) {
    return { fact: stripSpan(fact), outcome: "fallback" };
  }
  const slice = sliceSpanText({ text: turn.text, start: charStart, end: charEnd });
  if (slice.length > SPAN_MAX_SLICE_CHARS || slice.trim().length === 0) {
    return { fact: stripSpan(fact), outcome: "fallback" };
  }
  const frameWords = frame.trim().split(/\s+/).filter(Boolean);
  if (frameWords.length === 0 || frameWords.length > SPAN_MAX_FRAME_WORDS) {
    return { fact: stripSpan(fact), outcome: "fallback" };
  }

  const trimmedFrame = frameWords.join(" ");
  const materialized = /[:—-]$/.test(trimmedFrame)
    ? `${trimmedFrame} ${slice}`
    : `${trimmedFrame}: ${slice}`;

  if (mode === "on") {
    return {
      fact: { ...stripSpan(fact), content: materialized, quote: slice },
      outcome: "span",
      materialized,
    };
  }
  // shadow: persist generated content unchanged; materialize for comparison.
  return { fact: stripSpan(fact), outcome: "span", materialized };
}

/** Shadow agreement: exact match or containment either way. */
export function spanAgreesWithContent(materialized: string, content: string): boolean {
  const left = materialized.trim();
  const right = content.trim();
  return left === right || left.includes(right) || right.includes(left);
}

/**
 * Whole-result span materialization pass (issue #2333 Phase B). Called from
 * `ExtractionEngine.applySpanMaterialization` after parse, before sanitize /
 * grounding / judge / dedup / persist. Fast path: no span refs → unchanged
 * result. "off" strips stray spans untrusted. Shadow logs agreement
 * telemetry and persists generated content; "on" persists materialized
 * frame+span content with per-fact fail-open.
 */
export function applyExtractionSpanMaterialization(
  result: ExtractionResult,
  turns: readonly SpanMaterializeTurn[],
  mode: SpanMode,
): ExtractionResult {
  const anySpan = result.facts.some(factCarriesSpan);
  if (!anySpan) {
    return result;
  }
  if (mode === "off") {
    // Spans were never requested; a stray span is untrusted and stripped
    // without validation (storage format unchanged either way).
    return { ...result, facts: stripUntrustedFactSpans(result.facts) };
  }
  let attempts = 0;
  let fallbacks = 0;
  let agreements = 0;
  const facts = result.facts.map((fact) => {
    if (!factCarriesSpan(fact)) {
      return fact;
    }
    attempts += 1;
    const { fact: materialized, outcome, materialized: text } = materializeFactSpan(
      fact,
      turns,
      mode,
    );
    if (outcome === "fallback") {
      fallbacks += 1;
    } else if (mode === "shadow" && text !== undefined) {
      if (spanAgreesWithContent(text, fact.content)) {
        agreements += 1;
      }
    }
    return materialized;
  });
  if (mode === "shadow") {
    log.info(
      `extraction span-mode shadow: ${agreements}/${attempts} span facts agree with generated content (${fallbacks} span validation fallbacks)`,
    );
  } else if (fallbacks > 0) {
    log.info(
      `extraction span-mode: ${fallbacks}/${attempts} span facts fell back to generated content`,
    );
  }
  return { ...result, facts };
}

function stripSpan<T extends SpanMaterializeFact>(fact: T): T {
  const { span: _span, ...rest } = fact;
  return rest as T;
}
