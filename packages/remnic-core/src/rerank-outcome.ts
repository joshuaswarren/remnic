/**
 * H1 outcome-prior blend (issue #1958). Scaffolding only — no experiment runner.
 *
 * Text scores map onto [0, 1] with a fixed clamp. The clamp is not a batch
 * min-max, so one candidate cannot move another's scale.
 *
 * UNOBSERVED (no past result) keeps that unit text score when the weight is
 * positive. It does not use the Memory Worth Laplace prior (s+1)/(s+f+2).
 * An observed result uses the maximum-likelihood rate success/(success+fail).
 *
 * Weight 0 is an identity on the raw input score: same values, same order.
 * The recall pipeline calls `applyOutcomePriorScores` only when
 * `outcomeBoostEnabled === true` and the weight is greater than 0, so the
 * production default stays on the existing sort.
 */

import {
  type RecallEnhancementConfigProjection,
  resolveRecallEnhancementCapabilities,
} from "./capabilities.js";
import { coerceNumber } from "./connectors/coerce.js";
import { memoryForResult } from "./recall-memory-map.js";
import type { MemoryFile, QmdSearchResult } from "./types.js";

export const OUTCOME_STATE_UNOBSERVED = "UNOBSERVED" as const;
export const OUTCOME_STATE_OBSERVED = "OBSERVED" as const;

export type OutcomeObservationState =
  | typeof OUTCOME_STATE_UNOBSERVED
  | typeof OUTCOME_STATE_OBSERVED;

export interface OutcomeCounters {
  success?: number;
  fail?: number;
}

export interface OutcomeObservation {
  state: OutcomeObservationState;
  /** Present only for OBSERVED. Maximum-likelihood rate in [0, 1]. */
  outcomeScore?: number;
}

export function scaleTextScore(score: number): number {
  if (!Number.isFinite(score) || score <= 0) return 0;
  if (score >= 1) return 1;
  return score;
}

function finiteNonNegative(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return value;
}

/**
 * Both counters missing, explicit 0+0, or any present-but-invalid counter
 * (non-finite or negative) is UNOBSERVED. One counter present and positive
 * with the other missing is OBSERVED; the missing counter counts as 0.
 */
export function resolveOutcomeObservation(
  counters: OutcomeCounters | undefined,
): OutcomeObservation {
  if (!counters) return { state: OUTCOME_STATE_UNOBSERVED };
  const successPresent = counters.success !== undefined;
  const failPresent = counters.fail !== undefined;
  if (!successPresent && !failPresent) return { state: OUTCOME_STATE_UNOBSERVED };

  const success = finiteNonNegative(counters.success);
  const fail = finiteNonNegative(counters.fail);
  if (successPresent && success === undefined) return { state: OUTCOME_STATE_UNOBSERVED };
  if (failPresent && fail === undefined) return { state: OUTCOME_STATE_UNOBSERVED };

  const successes = success ?? 0;
  const failures = fail ?? 0;
  if (successes === 0 && failures === 0) return { state: OUTCOME_STATE_UNOBSERVED };
  return {
    state: OUTCOME_STATE_OBSERVED,
    outcomeScore: successes / (successes + failures),
  };
}

export function blendOutcomeScore(
  textScore: number,
  observation: OutcomeObservation,
  weight: number,
): number {
  if (weight === 0) return textScore;
  const textUnit = scaleTextScore(textScore);
  if (observation.state === OUTCOME_STATE_UNOBSERVED || observation.outcomeScore === undefined) {
    return textUnit;
  }
  return (1 - weight) * textUnit + weight * observation.outcomeScore;
}

export interface OutcomePriorCandidate<T> {
  item: T;
  textScore: number;
  success?: number;
  fail?: number;
}

export interface OutcomePriorRanked<T> {
  item: T;
  textScore: number;
  score: number;
  state: OutcomeObservationState;
  originalIndex: number;
}

function assertOutcomeWeight(weight: number): void {
  if (!Number.isFinite(weight) || weight < 0 || weight > 1) {
    throw new Error(
      `outcomeBoostWeight must be a finite number in [0, 1] (got ${JSON.stringify(weight)}).`,
    );
  }
}

function compareRanked(
  left: { score: number; originalIndex: number },
  right: { score: number; originalIndex: number },
): number {
  const leftScore = Number.isFinite(left.score) ? left.score : Number.NEGATIVE_INFINITY;
  const rightScore = Number.isFinite(right.score) ? right.score : Number.NEGATIVE_INFINITY;
  if (leftScore !== rightScore) return leftScore > rightScore ? -1 : 1;
  if (left.originalIndex === right.originalIndex) return 0;
  return left.originalIndex < right.originalIndex ? -1 : 1;
}

export function rerankWithOutcomePrior<T>(
  candidates: readonly OutcomePriorCandidate<T>[],
  weight: number,
): OutcomePriorRanked<T>[] {
  assertOutcomeWeight(weight);
  const ranked = candidates.map((candidate, originalIndex) => {
    const observation = resolveOutcomeObservation({
      success: candidate.success,
      fail: candidate.fail,
    });
    return {
      item: candidate.item,
      textScore: candidate.textScore,
      score: blendOutcomeScore(candidate.textScore, observation, weight),
      state: observation.state,
      originalIndex,
    };
  });
  if (weight === 0) return ranked;
  ranked.sort(compareRanked);
  return ranked;
}

export function outcomePriorBoostActive(
  config: RecallEnhancementConfigProjection & { outcomeBoostWeight?: number },
): boolean {
  const weight = config.outcomeBoostWeight;
  return (
    resolveRecallEnhancementCapabilities(config).outcomeBoost === true &&
    typeof weight === "number" &&
    Number.isFinite(weight) &&
    weight > 0
  );
}

export function applyOutcomePriorScores(
  results: QmdSearchResult[],
  memoryByPath: ReadonlyMap<string, MemoryFile>,
  config: { outcomeBoostWeight?: number },
): void {
  const weight = config.outcomeBoostWeight;
  if (!(typeof weight === "number" && Number.isFinite(weight) && weight > 0)) return;
  assertOutcomeWeight(weight);
  const ranked = results.map((result, originalIndex) => {
    const memory = memoryForResult(memoryByPath, result);
    const observation = resolveOutcomeObservation(
      memory
        ? { success: memory.frontmatter.mw_success, fail: memory.frontmatter.mw_fail }
        : undefined,
    );
    return {
      result,
      originalIndex,
      score: blendOutcomeScore(result.score, observation, weight),
    };
  });
  ranked.sort(compareRanked);
  const next = ranked.map((row) =>
    row.score === row.result.score ? row.result : { ...row.result, score: row.score },
  );
  results.splice(0, results.length, ...next);
}

/**
 * Absent / null / exact empty string → 0. A present value that is not a
 * finite number in [0, 1] throws. Boolean false is not a zero weight.
 */
export function parseOutcomeBoostWeight(raw: unknown): number {
  if (raw === undefined || raw === null || raw === "") return 0;
  const parsed = coerceNumber(raw, "outcomeBoostWeight");
  if (parsed === undefined || parsed < 0 || parsed > 1) {
    throw new Error(
      `outcomeBoostWeight must be a number in [0, 1] (got ${JSON.stringify(raw)}).`,
    );
  }
  return parsed;
}
