import type { ConfidenceInterval } from "../types.js";

export interface BootstrapOptions {
  iterations?: number;
  level?: number;
  random?: () => number;
}

const DEFAULT_ITERATIONS = 1_000;
const DEFAULT_LEVEL = 0.95;

function mean(values: number[]): number {
  if (values.length === 0) {
    throw new Error("bootstrap requires at least one value");
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(sortedValues: number[], percentileValue: number): number {
  if (sortedValues.length === 0) {
    throw new Error("percentile requires at least one value");
  }

  const clamped = Math.min(1, Math.max(0, percentileValue));
  const index = (sortedValues.length - 1) * clamped;
  const lowerIndex = Math.floor(index);
  const upperIndex = Math.ceil(index);

  if (lowerIndex === upperIndex) {
    return sortedValues[lowerIndex]!;
  }

  const weight = index - lowerIndex;
  const lower = sortedValues[lowerIndex]!;
  const upper = sortedValues[upperIndex]!;
  return lower + (upper - lower) * weight;
}

function createBootstrapMeans(
  values: number[],
  {
    iterations = DEFAULT_ITERATIONS,
    random = Math.random,
  }: Pick<BootstrapOptions, "iterations" | "random">,
): number[] {
  if (values.length === 0) {
    throw new Error("bootstrap requires at least one value");
  }
  if (!Number.isInteger(iterations) || iterations <= 0) {
    throw new Error("bootstrap iterations must be a positive integer");
  }

  const samples: number[] = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const sample: number[] = [];
    for (let index = 0; index < values.length; index += 1) {
      const pickedIndex = Math.floor(random() * values.length);
      sample.push(values[pickedIndex]!);
    }
    samples.push(mean(sample));
  }

  return samples;
}

export function bootstrapMeanConfidenceInterval(
  values: number[],
  options: BootstrapOptions = {},
): ConfidenceInterval {
  const level = options.level ?? DEFAULT_LEVEL;
  if (!(level > 0 && level < 1)) {
    throw new Error("bootstrap confidence level must be between 0 and 1");
  }

  const bootstrappedMeans = createBootstrapMeans(values, options).sort(
    (left, right) => left - right,
  );
  const tail = (1 - level) / 2;

  return {
    lower: percentile(bootstrappedMeans, tail),
    upper: percentile(bootstrappedMeans, 1 - tail),
    level,
  };
}

export function pairedDeltaConfidenceInterval(
  candidateValues: number[],
  baselineValues: number[],
  options: BootstrapOptions = {},
): ConfidenceInterval {
  if (candidateValues.length !== baselineValues.length) {
    throw new Error("paired delta confidence intervals require equal-length arrays");
  }

  const deltas = candidateValues.map(
    (candidate, index) => candidate - baselineValues[index]!,
  );
  return bootstrapMeanConfidenceInterval(deltas, options);
}
