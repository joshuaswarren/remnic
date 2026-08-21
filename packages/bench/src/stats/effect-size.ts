import type { EffectSizeInterpretation } from "../types.js";

function mean(values: number[]): number {
  if (values.length === 0) {
    throw new Error("effect size requires at least one value");
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function sampleVariance(values: number[], avg: number): number {
  if (values.length <= 1) {
    return 0;
  }
  return values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / (values.length - 1);
}

export function cohensD(
  candidateValues: number[],
  baselineValues: number[],
): number {
  if (candidateValues.length === 0 || baselineValues.length === 0) {
    throw new Error("effect size requires non-empty candidate and baseline arrays");
  }

  const candidateMean = mean(candidateValues);
  const baselineMean = mean(baselineValues);
  const candidateVariance = sampleVariance(candidateValues, candidateMean);
  const baselineVariance = sampleVariance(baselineValues, baselineMean);
  const pooledDegreesOfFreedom =
    candidateValues.length + baselineValues.length - 2;

  if (pooledDegreesOfFreedom <= 0) {
    return candidateMean === baselineMean
      ? 0
      : Math.sign(candidateMean - baselineMean) * Infinity;
  }

  const pooledVariance =
    ((candidateValues.length - 1) * candidateVariance +
      (baselineValues.length - 1) * baselineVariance) /
    pooledDegreesOfFreedom;

  if (!Number.isFinite(pooledVariance) || pooledVariance === 0) {
    return candidateMean === baselineMean
      ? 0
      : Math.sign(candidateMean - baselineMean) * Infinity;
  }

  return (candidateMean - baselineMean) / Math.sqrt(pooledVariance);
}

export function interpretEffectSize(
  cohensDValue: number,
): EffectSizeInterpretation {
  if (Number.isNaN(cohensDValue)) {
    throw new Error("effect size interpretation requires a numeric value");
  }
  const absolute = Math.abs(cohensDValue);
  if (absolute < 0.2) return "negligible";
  if (absolute < 0.5) return "small";
  if (absolute < 0.8) return "medium";
  return "large";
}
