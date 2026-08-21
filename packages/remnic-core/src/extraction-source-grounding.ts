import type { ExtractionResult, ProvenanceConfig } from "./types.js";
import { buildFactProvenance, type ProvenanceTurnInput } from "./provenance.js";
import { delinearize } from "./delinearize.js";
import {
  applyExtractionSourceGrounding as applyGroundingRules,
  filterExtractionResultBySource as filterGroundingRules,
} from "./extraction-source-grounding-rules.js";
import type {
  ExtractionGroundingRoleSources,
  ExtractionSourceGroundingOptions,
} from "./extraction-source-grounding-rules.js";

export type { ExtractionGroundingRoleSources, ExtractionSourceGroundingOptions } from "./extraction-source-grounding-rules.js";

export function applyExtractionSourceGrounding(
  result: ExtractionResult,
  sourceText: string,
  assertionSourceText: string = sourceText,
  roleAssertionSources: ExtractionGroundingRoleSources | undefined,
  messageTimestamp: Date | undefined,
  options: ExtractionSourceGroundingOptions,
): ExtractionResult {
  const sourceForGrounding = (source: string | undefined): string | undefined =>
    source === undefined || !options.anchorTemporalExpressions
      ? source
      : delinearize(source, result.entities, messageTimestamp ?? new Date());
  const groundedRoleSources = roleAssertionSources === undefined
    ? undefined
    : {
      profile: sourceForGrounding(roleAssertionSources.profile),
      identity: sourceForGrounding(roleAssertionSources.identity),
    };
  return applyGroundingRules(
    result,
    sourceForGrounding(sourceText) ?? sourceText,
    sourceForGrounding(assertionSourceText) ?? assertionSourceText,
    groundedRoleSources,
    messageTimestamp,
    options,
  );
}

/**
 * Attach claim-level provenance spans to each fact after extraction has
 * completed. The validator never throws or drops a fact: an unverifiable
 * quote remains a tagged state. When provenance is disabled, transient
 * model-provided quotes are stripped before the result leaves extraction.
 */
export function attachExtractionProvenance(
  result: ExtractionResult,
  turns: ReadonlyArray<{
    content: string;
    sessionKey?: string;
    logicalSessionKey?: string;
    timestamp: string;
    turnFingerprint?: string;
  }>,
  provenanceConfig: ProvenanceConfig,
): ExtractionResult {
  if (!provenanceConfig.enabled) {
    if (result.facts.length === 0) return result;
    return {
      ...result,
      facts: result.facts.map((fact) => {
        if (fact.quote === undefined) return fact;
        const { quote: _stripped, ...rest } = fact;
        return rest;
      }),
    };
  }
  if (result.facts.length === 0) return result;
  const provenanceTurns: ProvenanceTurnInput[] = turns.map((turn) => ({
    content: turn.content,
    sessionKey: turn.sessionKey,
    logicalSessionKey: turn.logicalSessionKey,
    timestamp: turn.timestamp,
    turnId: turn.turnFingerprint,
  }));
  const facts = result.facts.map((fact) => {
    const built = buildFactProvenance(
      fact.quote,
      provenanceTurns,
      provenanceConfig,
    );
    const { quote: _stripped, ...factWithoutQuote } = fact;
    return {
      ...factWithoutQuote,
      ...(built.sources && built.sources.length > 0 ? { sources: built.sources } : {}),
      ...(built.provenance !== "none" ? { provenance: built.provenance } : {}),
      ...(built.requireSpansPending ? { requireSpansPending: true } : {}),
    };
  });
  return { ...result, facts };
}

export function filterExtractionResultBySource(
  result: ExtractionResult,
  source: string,
  assertionSource?: string,
  roleAssertionSources?: ExtractionGroundingRoleSources,
  eventTimeNormalizer?: (eventTime: string) => string,
): ExtractionResult {
  return filterGroundingRules(result, source, assertionSource, roleAssertionSources, eventTimeNormalizer);
}
