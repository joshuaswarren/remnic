/**
 * Merge-judge skip predicate (issue #2330 leftover).
 *
 * Pure. Disabled merge skips the judge (create). skipThreshold 0 never
 * skips on score. score >= skipThreshold skips. Invalid units throw.
 */

export interface MergeThresholdInput {
  enabled: boolean;
  score: number;
  skipThreshold: number;
}

function assertUnitInterval(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`invalid merge ${name}: ${value}`);
  }
}

export function shouldSkipMergeJudge(input: MergeThresholdInput): boolean {
  assertUnitInterval(input.score, "score");
  assertUnitInterval(input.skipThreshold, "skipThreshold");
  if (!input.enabled) return true;
  if (input.skipThreshold === 0) return false;
  return input.score >= input.skipThreshold;
}
