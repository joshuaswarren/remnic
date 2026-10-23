/**
 * Quote-anchored source grounding.
 *
 * An extracted fact carries the exact words that support it in `quote`. A quote
 * that is a verbatim substring of the source (whitespace-normalized) is real
 * evidence: the claim only has to be supported by the text around that span,
 * not by word overlap against the whole conversation. Items without such a
 * quote never get an anchor here and stay on the whole-source rules.
 */

import type { ExtractionResult } from "./types.js";
import {
  GROUNDING_MIN_SHARED_TOKENS,
  areGroundingTokensCompatible,
  isGroundedEntityName,
  normalizedEntityIdentifierTokens,
  tokenize,
} from "./extraction-source-grounding-helpers.js";

/** Shortest normalized quote that counts as evidence; "the" or "I" prove nothing. */
export const QUOTE_ANCHOR_MIN_CHARS = 12;
/** Characters of context kept on each side of the quote inside its turn. */
export const QUOTE_ANCHOR_CONTEXT_CHARS = 400;
/** Share of a claim's content words that must occur in the quote's window. */
export const QUOTE_ANCHOR_MIN_WINDOW_COVERAGE = 0.35;
/** Share of a claim's content words that must occur anywhere in the source; the rest is invented. */
export const QUOTE_ANCHOR_MIN_SOURCE_COVERAGE = 0.75;
const QUOTE_ANCHOR_MAX_OCCURRENCES = 8;
const TURN_SEPARATOR = "\n\n";
const NEGATOR_PATTERN = /\b(?:not|no|never|cannot|without|neither|nor)\b|n't\b/iu;
const EXCLUSION_PATTERN =
  /\b(?:exclu\w*|avoid\w*|omit\w*|skip\w*|ignor\w*|forbid\w*|prohibit\w*|disallow\w*|prevent\w*|reject\w*|refus\w*|insufficient|instead|rather|unless|except)\b/iu;

/** A verbatim quote and the text around it inside its turn. */
export interface QuoteAnchor {
  /** Whitespace-normalized quote, exactly as it appears in the source. */
  quote: string;
  /** `quote` with its turn-local context; `;` inside the quote is rewritten to `,`. */
  window: string;
}

export type TokenPool = (token: string) => boolean;

type Entity = ExtractionResult["entities"][number];
type Relationship = NonNullable<ExtractionResult["relationships"]>[number];

function normalizeWhitespaceWithMap(source: string): { text: string; originalIndex: number[] } {
  const chars: string[] = [];
  const originalIndex: number[] = [];
  let inSpace = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!;
    if (/\s/u.test(char)) {
      if (inSpace) continue;
      inSpace = true;
      chars.push(" ");
    } else {
      inSpace = false;
      chars.push(char);
    }
    originalIndex.push(index);
  }
  return { text: chars.join(""), originalIndex };
}

function findQuoteAnchors(quote: string, source: string): QuoteAnchor[] {
  const needle = quote.replace(/\s+/gu, " ").trim();
  if (needle.length < QUOTE_ANCHOR_MIN_CHARS) return [];
  const normalized = normalizeWhitespaceWithMap(source);
  const anchors: QuoteAnchor[] = [];
  let from = 0;
  while (anchors.length < QUOTE_ANCHOR_MAX_OCCURRENCES) {
    const at = normalized.text.indexOf(needle, from);
    if (at < 0) break;
    from = at + 1;
    const start = normalized.originalIndex[at]!;
    const end = normalized.originalIndex[at + needle.length - 1]! + 1;
    if (source.slice(start, end).includes(TURN_SEPARATOR)) continue;

    let before = source.slice(Math.max(0, start - QUOTE_ANCHOR_CONTEXT_CHARS), start);
    const turnStart = before.lastIndexOf(TURN_SEPARATOR);
    if (turnStart >= 0) before = before.slice(turnStart + TURN_SEPARATOR.length);
    else if (start > QUOTE_ANCHOR_CONTEXT_CHARS) before = before.replace(/^\S+/u, "");

    let after = source.slice(end, end + QUOTE_ANCHOR_CONTEXT_CHARS);
    const turnEnd = after.indexOf(TURN_SEPARATOR);
    if (turnEnd >= 0) after = after.slice(0, turnEnd);
    else if (source.length - end > QUOTE_ANCHOR_CONTEXT_CHARS) after = after.replace(/\S+$/u, "");

    anchors.push({ quote: needle, window: `${before}${needle.replace(/;/gu, ",")}${after}` });
  }
  return anchors;
}

/**
 * Returns one anchor per place `quote` occurs verbatim in `source`, or [] when
 * the quote is absent, too short, or not an exact substring. A quote that
 * spans a turn separator is not one turn's words and yields no anchor; windows
 * never extend past their turn.
 *
 * The quote is one evidence unit: a `;` inside it is rewritten to `,` in the
 * window so sentence splitting cannot cut it, or a claim that merges two of
 * its clauses could never be grounded in a single sentence.
 *
 * `source` may have been rewritten before grounding (temporal anchoring,
 * pronoun resolution) while the model quoted the original words. When the raw
 * quote is not found, `transformQuote` applies the same rewrite to the quote.
 */
export function quoteAnchors(
  quote: string | undefined,
  source: string,
  transformQuote?: (quote: string) => string,
): QuoteAnchor[] {
  if (typeof quote !== "string") return [];
  const exact = findQuoteAnchors(quote, source);
  if (exact.length > 0 || transformQuote === undefined) return exact;
  return findQuoteAnchors(transformQuote(quote), source);
}

export function tokenPool(tokens: ReadonlySet<string>): TokenPool {
  const list = [...tokens];
  return (token) => tokens.has(token) || list.some((poolToken) => areGroundingTokensCompatible(token, poolToken));
}

/**
 * True when the claim states the opposite of a negated quote clause it
 * restates: "did not approve the budget" reworded as "approved the budget".
 * A claim that keeps any negator or exclusion word ("do not X" reworded as
 * "X is excluded") is not inverted.
 */
function invertsNegatedQuote(content: string, quote: string): boolean {
  if (NEGATOR_PATTERN.test(content) || EXCLUSION_PATTERN.test(content)) return false;
  const contentHas = tokenPool(tokenize(content));
  return quote.split(/[;.!?\n]+/u).some((clause) => {
    if (!NEGATOR_PATTERN.test(clause)) return false;
    const clauseTokens = [...tokenize(clause)];
    const shared = clauseTokens.filter(contentHas).length;
    return shared >= GROUNDING_MIN_SHARED_TOKENS && shared / clauseTokens.length >= 0.5;
  });
}

/**
 * A claim is supported by a verbatim quote when it shares at least
 * GROUNDING_MIN_SHARED_TOKENS content words with the quote, a good part of its
 * words sit in the text around the quote, nearly all of them occur in the
 * source at all, and it does not invert a negated clause of the quote. Reworded
 * and lightly elaborated claims pass; claims that bring words the conversation
 * never used, or that have nothing to do with the quote, do not.
 */
export function isQuoteAnchoredClaim(content: string, anchor: QuoteAnchor, sourceHas: TokenPool): boolean {
  const contentTokens = [...tokenize(content)];
  if (contentTokens.length === 0) return false;
  const quoteHas = tokenPool(tokenize(anchor.quote));
  if (contentTokens.filter(quoteHas).length < GROUNDING_MIN_SHARED_TOKENS) return false;
  const windowHas = tokenPool(tokenize(anchor.window));
  if (contentTokens.filter(windowHas).length / contentTokens.length < QUOTE_ANCHOR_MIN_WINDOW_COVERAGE) {
    return false;
  }
  return contentTokens.filter(sourceHas).length / contentTokens.length >= QUOTE_ANCHOR_MIN_SOURCE_COVERAGE
    && !invertsNegatedQuote(content, anchor.quote);
}

/** Keeps the entity facts (flat and sectioned) `isSupported` accepts; undefined when none remain. */
export function filterEntityFacts(entity: Entity, isSupported: (fact: string) => boolean): Entity | undefined {
  const facts = entity.facts.filter(isSupported);
  const structuredSections = entity.structuredSections?.flatMap((section) => {
    const groundedFacts = section.facts.filter(isSupported);
    return groundedFacts.length > 0 ? [{ ...section, facts: groundedFacts }] : [];
  });
  if (facts.length === 0 && (structuredSections === undefined || structuredSections.length === 0)) {
    return undefined;
  }
  const { structuredSections: _structuredSections, ...entityWithoutSections } = entity;
  return {
    ...entityWithoutSections,
    facts,
    ...(structuredSections && structuredSections.length > 0 ? { structuredSections } : {}),
  };
}

/**
 * Entities carry no quote of their own; the anchors of facts that kept support
 * them. Returns a fact predicate, or undefined when no anchor window names the entity.
 */
export function quoteAnchoredEntitySupport(
  entity: Entity,
  anchors: readonly QuoteAnchor[],
  sourceHas: TokenPool,
): ((fact: string) => boolean) | undefined {
  const nameAnchors = anchors.filter((anchor) => isGroundedEntityName(entity.name, anchor.window));
  if (nameAnchors.length === 0) return undefined;
  return (fact) => nameAnchors.some((anchor) => isQuoteAnchoredClaim(fact, anchor, sourceHas));
}

/** Both names and the label must sit in one anchor window; an invented or empty label never passes. */
export function isQuoteAnchoredRelationship(
  relationship: Relationship,
  anchors: readonly QuoteAnchor[],
  sourceHas: TokenPool,
): boolean {
  const labelTokens = [...tokenize(relationship.label)];
  if (labelTokens.length === 0) return false;
  const relationText = [
    normalizedEntityIdentifierTokens(relationship.source).join(" "),
    relationship.label,
    normalizedEntityIdentifierTokens(relationship.target).join(" "),
  ].join(" ");
  return anchors.some((anchor) => {
    const windowHas = tokenPool(tokenize(anchor.window));
    return labelTokens.every(windowHas)
      && isGroundedEntityName(relationship.source, anchor.window)
      && isGroundedEntityName(relationship.target, anchor.window)
      && isQuoteAnchoredClaim(relationText, anchor, sourceHas);
  });
}
