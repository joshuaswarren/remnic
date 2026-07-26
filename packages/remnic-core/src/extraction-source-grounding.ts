import type { ExtractionResult } from "./types.js";
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

export function filterExtractionResultBySource(
  result: ExtractionResult,
  source: string,
  assertionSource?: string,
  roleAssertionSources?: ExtractionGroundingRoleSources,
  eventTimeNormalizer?: (eventTime: string) => string,
): ExtractionResult {
  return filterGroundingRules(result, source, assertionSource, roleAssertionSources, eventTimeNormalizer);
}
