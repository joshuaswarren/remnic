import type {
  BenchmarkResult,
  ComparisonResult,
  ComparisonMetricDelta,
} from "../types.js";
import { pairedDeltaConfidenceInterval } from "./bootstrap.js";
import { cohensD, interpretEffectSize } from "./effect-size.js";

function percentChange(candidateValue: number, baselineValue: number): number {
  if (baselineValue === 0) {
    return candidateValue === 0 ? 0 : Math.sign(candidateValue) * Infinity;
  }
  return (candidateValue - baselineValue) / baselineValue;
}

function hasMetricScore(
  scores: Record<string, number>,
  metricName: string,
): boolean {
  return Object.prototype.hasOwnProperty.call(scores, metricName);
}

function pairedScoresForMetric(
  baseline: BenchmarkResult,
  candidate: BenchmarkResult,
  metricName: string,
): { baselineScores: number[]; candidateScores: number[] } {
  const baselineByTaskId = new Map(
    baseline.results.tasks.map((task) => [task.taskId, task]),
  );
  const baselineScores: number[] = [];
  const candidateScores: number[] = [];

  for (const candidateTask of candidate.results.tasks) {
    if (!hasMetricScore(candidateTask.scores, metricName)) {
      continue;
    }
    const baselineTask = baselineByTaskId.get(candidateTask.taskId);
    if (!baselineTask || !hasMetricScore(baselineTask.scores, metricName)) {
      continue;
    }
    candidateScores.push(candidateTask.scores[metricName]!);
    baselineScores.push(baselineTask.scores[metricName]!);
  }

  return { baselineScores, candidateScores };
}

function verdictFromMetricDeltas(
  metricDeltas: Record<string, ComparisonMetricDelta>,
  threshold: number,
  lowerIsBetter: ReadonlySet<string>,
): ComparisonResult["verdict"] {
  let hasImprovement = false;
  let hasRegression = false;

  for (const [metricName, metric] of Object.entries(metricDeltas)) {
    // For lower-is-better metrics, a positive percent change is a regression.
    const directedChange = lowerIsBetter.has(metricName)
      ? -metric.percentChange
      : metric.percentChange;
    if (directedChange > threshold) {
      hasImprovement = true;
    }
    if (directedChange < -threshold) {
      hasRegression = true;
    }
  }

  if (hasRegression) return "regression";
  if (hasImprovement) return "improvement";
  return "pass";
}

export function compareResults(
  baseline: BenchmarkResult,
  candidate: BenchmarkResult,
  threshold = 0.05,
  lowerIsBetter: ReadonlySet<string> = new Set(),
): ComparisonResult {
  const metricDeltas: Record<string, ComparisonMetricDelta> = {};

  for (const [metricName, aggregate] of Object.entries(candidate.results.aggregates)) {
    const baselineAggregate = baseline.results.aggregates[metricName];
    if (!baselineAggregate) {
      continue;
    }

    const { baselineScores, candidateScores } = pairedScoresForMetric(
      baseline,
      candidate,
      metricName,
    );

    const delta = aggregate.mean - baselineAggregate.mean;
    const metricDelta: ComparisonMetricDelta = {
      baseline: baselineAggregate.mean,
      candidate: aggregate.mean,
      delta,
      percentChange: percentChange(aggregate.mean, baselineAggregate.mean),
      effectSize: {
        cohensD: 0,
        interpretation: "negligible",
      },
    };

    if (candidateScores.length > 0) {
      const effectSizeValue = cohensD(candidateScores, baselineScores);
      metricDelta.effectSize = {
        cohensD: effectSizeValue,
        interpretation: interpretEffectSize(effectSizeValue),
      };
    }

    if (candidateScores.length > 0) {
      metricDelta.ciOnDelta = pairedDeltaConfidenceInterval(
        candidateScores,
        baselineScores,
      );
    }

    metricDeltas[metricName] = metricDelta;
  }

  return {
    benchmark: candidate.meta.benchmark,
    metricDeltas,
    verdict: verdictFromMetricDeltas(metricDeltas, threshold, lowerIsBetter),
  };
}

/**
 * Registry of lower-is-better metric sets keyed by benchmark id.  Callers
 * (such as the CLI comparison command) can look up the appropriate set and
 * pass it to compareResults so verdicts correctly treat friction/error-style
 * metrics as regressions when they increase.
 */
import { INGESTION_SETUP_FRICTION_LOWER_IS_BETTER } from "../benchmarks/remnic/ingestion-setup-friction/runner.js";
import { RETRIEVAL_REASONING_TRACE_LOWER_IS_BETTER } from "../benchmarks/remnic/retrieval-reasoning-trace/runner.js";

const LOWER_IS_BETTER_BY_BENCHMARK: Record<string, ReadonlySet<string>> = {
  "ingestion-setup-friction": INGESTION_SETUP_FRICTION_LOWER_IS_BETTER,
  "retrieval-reasoning-trace": RETRIEVAL_REASONING_TRACE_LOWER_IS_BETTER,
};

export function getBenchmarkLowerIsBetter(benchmarkId: string): ReadonlySet<string> {
  return LOWER_IS_BETTER_BY_BENCHMARK[benchmarkId] ?? new Set<string>();
}
