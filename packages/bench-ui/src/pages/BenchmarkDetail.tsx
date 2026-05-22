import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import type { BenchResultSummary, BenchResultSummaryPayload, TaskDeltaRow } from "../bench-data";
import {
  benchmarkRuns,
  buildHistogram,
  formatMetricValue,
  formatTimestamp,
  humanizeIdentifier,
  isLowerIsBetterMetric,
  isRawCountMetric,
} from "../bench-data";
import { CostSummary } from "../components/CostSummary";
import { TaskBreakdown } from "../components/TaskBreakdown";

export function buildBenchmarkDetailTaskRows(selected: BenchResultSummary): TaskDeltaRow[] {
  return selected.taskSummaries.map((task) => ({
    taskId: task.taskId,
    baseline: null,
    candidate: task.primaryScore,
    delta: null,
    question: task.question,
    latencyMs: task.latencyMs,
  }));
}

export function selectLowestScoringTasks(
  taskRows: TaskDeltaRow[],
  metricName?: string,
  limit = 5,
): TaskDeltaRow[] {
  if (isLowerIsBetterMetric(metricName)) {
    return taskRows
      .filter((task) => (task.candidate ?? 0) > 0)
      .slice()
      .sort((left, right) => (right.candidate ?? 0) - (left.candidate ?? 0))
      .slice(0, limit);
  }

  return taskRows
    .filter((task) => (task.candidate ?? 1) < 0.6)
    .slice()
    .sort((left, right) => (left.candidate ?? 1) - (right.candidate ?? 1))
    .slice(0, limit);
}

export function resolveSelectedRunId(
  runs: BenchResultSummary[],
  selectedRunId: string,
): string {
  if (runs.some((run) => run.id === selectedRunId)) {
    return selectedRunId;
  }

  return runs[0]?.id ?? "";
}

export function histogramBarHeight(
  count: number,
  maxCount: number,
  maxHeight = 120,
  minNonZeroHeight = 12,
): number {
  if (count <= 0 || maxCount <= 0) {
    return 0;
  }
  return Math.max((count / maxCount) * maxHeight, minNonZeroHeight);
}

export function BenchmarkDetail({ payload }: { payload: BenchResultSummaryPayload }) {
  const { benchmarkId } = useParams();
  const runs = benchmarkId ? benchmarkRuns(payload, benchmarkId) : [];
  const [selectedRunId, setSelectedRunId] = useState<string>(runs[0]?.id ?? "");
  const resolvedSelectedRunId = resolveSelectedRunId(runs, selectedRunId);

  useEffect(() => {
    if (selectedRunId !== resolvedSelectedRunId) {
      setSelectedRunId(resolvedSelectedRunId);
    }
  }, [resolvedSelectedRunId, selectedRunId]);

  const selected = runs.find((run) => run.id === resolvedSelectedRunId) ?? runs[0] ?? null;

  if (!benchmarkId || !selected) {
    return (
      <section className="page">
        <header className="page-header">
          <div>
            <span className="section-kicker">Benchmark detail</span>
            <h3>Benchmark not found</h3>
          </div>
          <p>Choose a benchmark from Overview or Runs to inspect its task-level detail.</p>
        </header>
      </section>
    );
  }

  const primaryMetric = selected.primaryMetric ?? undefined;
  const showNormalizedHistogram = !isRawCountMetric(primaryMetric);
  const histogram = showNormalizedHistogram ? buildHistogram(selected) : [];
  const maxHistogramCount = histogram.reduce(
    (max, bucket) => Math.max(max, bucket.count),
    0,
  );
  const taskRows = buildBenchmarkDetailTaskRows(selected);
  const lowScoring = selectLowestScoringTasks(taskRows, primaryMetric);
  const failureTitle = isLowerIsBetterMetric(primaryMetric)
    ? "Highest-friction tasks"
    : "Lowest-scoring tasks";

  return (
    <section className="page">
      <header className="page-header">
        <div>
          <span className="section-kicker">Benchmark detail</span>
          <h3>{humanizeIdentifier(benchmarkId)}</h3>
        </div>
        <p>
          Latest local metrics, task score distribution, and failure analysis for this benchmark family.
        </p>
      </header>

      <section className="panel controls-grid">
        <label>
          <span>Inspect run</span>
          <select value={selected.id} onChange={(event) => setSelectedRunId(event.target.value)}>
            {runs.map((run) => (
              <option key={run.id} value={run.id}>
                {run.id} · {formatTimestamp(run.timestamp)}
              </option>
            ))}
          </select>
        </label>
      </section>

      <div className="detail-hero">
        <article className="stat-card">
          <span>Primary score</span>
          <strong>{formatMetricValue(selected.primaryScore, primaryMetric)}</strong>
          <p>{selected.primaryMetric ?? "No primary metric"}</p>
        </article>
        <article className="stat-card">
          <span>Metric stack</span>
          <strong>{selected.aggregateMetrics.length}</strong>
          <p>{selected.aggregateMetrics.map((metric) => metric.name).slice(0, 4).join(", ") || "No aggregates"}</p>
        </article>
      </div>

      <CostSummary summary={selected} />

      {showNormalizedHistogram ? (
        <section className="panel">
          <div className="section-title">
            <span className="section-kicker">Distribution</span>
            <h4>Task score histogram</h4>
          </div>
          <div className="histogram">
            {histogram.map((bucket) => (
              <div className="histogram__bucket" key={bucket.label}>
                <div className="histogram__bar-wrap">
                  <div
                    className="histogram__bar"
                    style={{ height: `${histogramBarHeight(bucket.count, maxHistogramCount)}px` }}
                  />
                </div>
                <strong>{bucket.count}</strong>
                <span>{bucket.label}</span>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <TaskBreakdown rows={taskRows} title="Task-level score breakdown" metricName={primaryMetric} />

      <section className="panel">
        <div className="section-title">
          <span className="section-kicker">Failure analysis</span>
          <h4>{failureTitle}</h4>
        </div>
        {lowScoring.length > 0 ? (
          <ul className="failure-list">
            {lowScoring.map((task) => (
              <li key={task.taskId}>
                <strong>{task.taskId}</strong>
                <span>{formatMetricValue(task.candidate, primaryMetric)}</span>
                <p>{task.question}</p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted-copy">No low-scoring task cluster was detected for the selected run.</p>
        )}
      </section>
    </section>
  );
}
import * as React from "react";
