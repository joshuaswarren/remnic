/**
 * Shared scoring utilities for bench runners.
 */

import type { AggregateMetrics } from "./types.js";
import type { BenchJudgeResult } from "./adapters/types.js";

export function exactMatch(
  predicted: string,
  expected: string | number | unknown,
): number {
  return normalizeText(predicted) === normalizeText(expected) ? 1 : 0;
}

export function f1Score(
  predicted: string,
  expected: string | number | unknown,
): number {
  const predictedTokens = tokenize(predicted);
  const expectedTokens = tokenize(expected);

  if (predictedTokens.length === 0 && expectedTokens.length === 0) return 1;
  if (predictedTokens.length === 0 || expectedTokens.length === 0) return 0;

  const predictedCounts = frequencyMap(predictedTokens);
  const expectedCounts = frequencyMap(expectedTokens);

  let overlap = 0;
  for (const [token, count] of expectedCounts.entries()) {
    overlap += Math.min(count, predictedCounts.get(token) ?? 0);
  }

  if (overlap === 0) return 0;

  const precision = overlap / predictedTokens.length;
  const recall = overlap / expectedTokens.length;

  return (2 * precision * recall) / (precision + recall);
}

export function rougeL(
  predicted: string,
  expected: string | number | unknown,
): number {
  const predictedTokens = tokenize(predicted);
  const expectedTokens = tokenize(expected);

  if (predictedTokens.length === 0 && expectedTokens.length === 0) return 1;
  if (predictedTokens.length === 0 || expectedTokens.length === 0) return 0;

  const lcsLength = longestCommonSubsequence(predictedTokens, expectedTokens);
  const precision = lcsLength / predictedTokens.length;
  const recall = lcsLength / expectedTokens.length;

  if (precision + recall === 0) return 0;
  return (2 * precision * recall) / (precision + recall);
}

export function recallAtK(
  retrieved: string[],
  relevant: string[],
  k: number,
): number {
  if (!Number.isInteger(k) || k <= 0) return 0;
  if (relevant.length === 0) return 1;

  const topK = retrieved.slice(0, k).map(normalizeText);
  const relevantSet = new Set(relevant.map(normalizeText));
  const hits = new Set(
    topK.filter((candidate) => relevantSet.has(candidate)),
  ).size;

  return hits / relevantSet.size;
}

export function precisionAtK(
  retrieved: string[],
  relevant: string[],
  k: number,
): number {
  if (!Number.isInteger(k) || k <= 0) return 0;

  const topK = retrieved.slice(0, k).map(normalizeText);
  if (topK.length === 0) return 0;

  const relevantSet = new Set(relevant.map(normalizeText));
  const hits = new Set(
    topK.filter((candidate) => relevantSet.has(candidate)),
  ).size;

  return hits / k;
}

export function containsAnswer(
  predicted: string,
  expected: string | number | unknown,
): number {
  const normalizedExpected = normalizeTextForContainment(expected);
  if (normalizedExpected.length === 0) return 0;

  const normalizedPredicted = normalizeTextForContainment(predicted);
  if (isShortLexicalAnswer(normalizedExpected)) {
    return containsShortLexicalAnswer(normalizedPredicted, normalizedExpected)
      ? 1
      : 0;
  }

  return normalizedPredicted.includes(normalizedExpected) ? 1 : 0;
}

export async function llmJudgeScore(
  judge:
    | {
      score(question: string, predicted: string, expected: string): Promise<number>;
      scoreWithMetrics?(
        question: string,
        predicted: string,
        expected: string,
      ): Promise<BenchJudgeResult>;
    }
    | undefined,
  question: string,
  predicted: string,
  expected: string,
): Promise<number> {
  return (await llmJudgeScoreDetailed(judge, question, predicted, expected)).score;
}

export async function llmJudgeScoreDetailed(
  judge:
    | {
      score(question: string, predicted: string, expected: string): Promise<number>;
      scoreWithMetrics?(
        question: string,
        predicted: string,
        expected: string,
      ): Promise<BenchJudgeResult>;
    }
    | undefined,
  question: string,
  predicted: string,
  expected: string,
): Promise<BenchJudgeResult> {
  if (!judge) {
    return {
      score: -1,
      tokens: { input: 0, output: 0 },
      latencyMs: 0,
    };
  }

  const startedAt = performance.now();
  try {
    if (judge.scoreWithMetrics) {
      return await judge.scoreWithMetrics(question, predicted, expected);
    }

    const { result: score, durationMs } = await timed(() =>
      judge.score(question, predicted, expected),
    );

    return {
      score,
      tokens: { input: 0, output: 0 },
      latencyMs: durationMs,
    };
  } catch {
    return {
      score: deterministicJudgeFallback(predicted, expected),
      tokens: { input: 0, output: 0 },
      latencyMs: Math.round(performance.now() - startedAt),
      model: "deterministic-fallback",
    };
  }
}

export async function llmBinaryJudgeScoreDetailed(
  judge:
    | {
      scoreBinaryPrompt(prompt: string): Promise<BenchJudgeResult>;
    }
    | undefined,
  prompt: string,
  fallback: {
    predicted: string;
    expected: unknown;
  },
): Promise<BenchJudgeResult> {
  if (!judge) {
    return {
      score: -1,
      tokens: { input: 0, output: 0 },
      latencyMs: 0,
    };
  }

  const startedAt = performance.now();
  try {
    return await judge.scoreBinaryPrompt(prompt);
  } catch {
    return {
      score: deterministicJudgeFallback(fallback.predicted, fallback.expected),
      tokens: { input: 0, output: 0 },
      latencyMs: Math.round(performance.now() - startedAt),
      model: "deterministic-fallback",
    };
  }
}

function deterministicJudgeFallback(
  predicted: string,
  expected: string | number | unknown,
): number {
  if (exactMatch(predicted, expected) === 1 || containsAnswer(predicted, expected) === 1) {
    return 1;
  }
  return f1Score(predicted, expected) >= 0.8 ? 1 : 0;
}

export async function timed<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; durationMs: number }> {
  const startedAt = performance.now();
  const result = await fn();
  return {
    result,
    durationMs: Math.round(performance.now() - startedAt),
  };
}

export function aggregateTaskScores(
  metricsList: Array<Record<string, number>>,
): AggregateMetrics {
  const metricValues = collectMetricValues(metricsList);
  const aggregates: AggregateMetrics = {};

  for (const [metricName, values] of Object.entries(metricValues)) {
    aggregates[metricName] = summarizeMetricValues(values);
  }

  return aggregates;
}

// Legacy aggregate format retained for the still-unmigrated published runners.
export function aggregateScores(
  scores: Array<Record<string, number>>,
): Record<string, number> {
  const detailedAggregates = aggregateTaskScores(scores);
  const aggregate: Record<string, number> = {};

  for (const [metricName, stats] of Object.entries(detailedAggregates)) {
    aggregate[`${metricName}_mean`] = stats.mean;
    aggregate[`${metricName}_min`] = stats.min;
    aggregate[`${metricName}_max`] = stats.max;
  }

  return aggregate;
}

function collectMetricValues(
  metricsList: Array<Record<string, number>>,
): Record<string, number[]> {
  if (metricsList.length === 0) return {};

  const metricNames = new Set<string>();
  for (const metrics of metricsList) {
    for (const metricName of Object.keys(metrics)) {
      metricNames.add(metricName);
    }
  }

  const metricValues: Record<string, number[]> = {};
  for (const metricName of metricNames) {
    const values = metricsList
      .map((metrics) => metrics[metricName])
      .filter((value) => typeof value === "number" && !Number.isNaN(value))
      .sort((left, right) => left - right);

    if (values.length > 0) {
      metricValues[metricName] = values;
    }
  }

  return metricValues;
}

function summarizeMetricValues(values: number[]): AggregateMetrics[string] {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const median =
    values.length % 2 === 0
      ? (values[values.length / 2 - 1]! + values[values.length / 2]!) / 2
      : values[Math.floor(values.length / 2)]!;
  const variance =
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
    values.length;

  return {
    mean,
    median,
    stdDev: Math.sqrt(variance),
    min: values[0]!,
    max: values[values.length - 1]!,
  };
}

function normalizeText(value: string | number | unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

function normalizeTextForContainment(value: string | number | unknown): string {
  return trimTrailingSentencePunctuation(normalizeText(value).replace(/\s+/g, " "));
}

function isShortLexicalAnswer(value: string): boolean {
  return (
    value.length <= 3 &&
    [...value].some((character) => isAsciiLetter(character)) &&
    [...value].every((character) => isAsciiAlphaNumeric(character))
  );
}

function containsShortLexicalAnswer(value: string, expected: string): boolean {
  return value
    .split(/[^a-z0-9]+/)
    .some((token) => token === expected);
}

function isAsciiAlphaNumeric(value: string): boolean {
  return (
    isAsciiLetter(value) ||
    (value >= "0" && value <= "9")
  );
}

function isAsciiLetter(value: string): boolean {
  return value >= "a" && value <= "z";
}

function trimTrailingSentencePunctuation(value: string): string {
  let end = value.length;

  while (end > 0 && isTerminalSentencePunctuation(value[end - 1]!)) {
    end -= 1;
  }

  return value.slice(0, end);
}

function isTerminalSentencePunctuation(value: string): boolean {
  return (
    value === "." ||
    value === "!" ||
    value === "?" ||
    value === "," ||
    value === ";" ||
    value === ":"
  );
}

function tokenize(value: string | number | unknown): string[] {
  return normalizeText(value)
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 0);
}

function frequencyMap(tokens: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const token of tokens) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return counts;
}

function longestCommonSubsequence(left: string[], right: string[]): number {
  let previous = new Array<number>(right.length + 1).fill(0);
  let current = new Array<number>(right.length + 1).fill(0);

  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    for (
      let rightIndex = 1;
      rightIndex <= right.length;
      rightIndex += 1
    ) {
      if (left[leftIndex - 1] === right[rightIndex - 1]) {
        current[rightIndex] = previous[rightIndex - 1]! + 1;
      } else {
        current[rightIndex] = Math.max(
          previous[rightIndex]!,
          current[rightIndex - 1]!,
        );
      }
    }

    [previous, current] = [current, previous];
    current.fill(0);
  }

  return previous[right.length]!;
}
