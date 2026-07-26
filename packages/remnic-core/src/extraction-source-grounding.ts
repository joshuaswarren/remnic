import type { ExtractionResult } from "./types.js";
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
  return applyGroundingRules(
    result,
    sourceText,
    assertionSourceText,
    roleAssertionSources,
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
