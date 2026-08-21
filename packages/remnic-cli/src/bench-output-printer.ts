import { padEndDisplay } from "@remnic/core";

import type { ComparisonResult } from "@remnic/bench";

type BenchSummaryTask = {
  taskId?: string;
  latencyMs?: number;
  scores?: Record<string, number>;
};
type BenchSummaryResult = {
  meta: { benchmark: string; mode: string };
  config: { runtimeProfile?: string | null };
  cost: { meanQueryLatencyMs: number };
  results: {
    tasks: ReadonlyArray<BenchSummaryTask>;
    aggregates: Record<string, { mean: number }>;
  };
};

type PrintableBenchmarkResult = BenchSummaryResult & {
  meta: { id: string; benchmark: string; mode: string };
};

export function printStoredBenchResultSummary(
  result: PrintableBenchmarkResult,
  summary: { id: string; path: string },
): void {
  console.log(`Run id: ${summary.id}`);
  printBenchPackageSummary(result, summary.path, "Stored result");
}

export function printBenchStatusLine(jsonMode: boolean, message: string): void {
  if (jsonMode) {
    console.error(message);
  } else {
    console.log(message);
  }
}

export function printBenchPackageSummary(
  result: BenchSummaryResult,
  outputPath: string,
  outputLabel = "Results saved",
): void {
  console.log(`Benchmark: ${result.meta.benchmark}`);
  console.log(`Mode: ${result.meta.mode}`);
  if (result.config.runtimeProfile) {
    console.log(`Runtime profile: ${result.config.runtimeProfile}`);
  }
  console.log(`Tasks: ${result.results.tasks.length}`);
  console.log(`Mean query latency: ${result.cost.meanQueryLatencyMs.toFixed(1)}ms`);
  for (const [metric, aggregate] of Object.entries(result.results.aggregates).sort()) {
    console.log(`  ${padEndDisplay(metric, 20)} ${aggregate.mean.toFixed(4)}`);
  }
  console.log(`${outputLabel}: ${outputPath}`);
}

export function printStoredBenchResultDetails(
  result: PrintableBenchmarkResult,
  summary: { id: string; path: string },
): void {
  printStoredBenchResultSummary(result, summary);
  if (result.results.tasks.length === 0) {
    console.log("Tasks: none");
    return;
  }

  console.log("Task breakdown:");
  for (const task of result.results.tasks) {
    const scores = Object.entries(task.scores ?? {})
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([metric, value]) => `${metric}=${(value as number).toFixed(4)}`)
      .join(", ");
    const taskLabel = task.taskId ?? "(unknown task)";
    const taskLatency = typeof task.latencyMs === "number" ? task.latencyMs.toFixed(1) : "?";
    console.log(
      `  ${taskLabel}: ${taskLatency}ms` +
      `${scores.length > 0 ? ` [${scores}]` : ""}`,
    );
  }
}

export function printBenchComparisonSummary(
  comparison: ComparisonResult,
  baseline: { id: string; path: string },
  candidate: { id: string; path: string },
): void {
  console.log(`Benchmark: ${comparison.benchmark}`);
  console.log(`Baseline: ${baseline.id} (${baseline.path})`);
  console.log(`Candidate: ${candidate.id} (${candidate.path})`);
  console.log(`Verdict: ${comparison.verdict}`);

  const metrics = Object.entries(comparison.metricDeltas).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  if (metrics.length === 0) {
    console.log("No overlapping metrics were found between the two results.");
    return;
  }

  console.log("Metrics:");
  for (const [metric, delta] of metrics) {
    const percent = Number.isFinite(delta.percentChange)
      ? `${(delta.percentChange * 100).toFixed(2)}%`
      : delta.percentChange > 0
        ? "+Infinity%"
        : "-Infinity%";
    const direction = delta.delta >= 0 ? "+" : "";
    console.log(
      `  ${padEndDisplay(metric, 18)} ${delta.baseline.toFixed(4)} -> ${delta.candidate.toFixed(4)} (${direction}${delta.delta.toFixed(4)}, ${percent}, d=${delta.effectSize.cohensD.toFixed(3)} ${delta.effectSize.interpretation})`,
    );
    if (delta.ciOnDelta) {
      console.log(
        `    95% CI on delta: [${delta.ciOnDelta.lower.toFixed(4)}, ${delta.ciOnDelta.upper.toFixed(4)}]`,
      );
    }
  }
}
