import * as React from "react";
import { useEffect, useState } from "react";
import type { BenchResultSummary, BenchResultSummaryPayload } from "../bench-data";
import { buildCompareModel, pickDefaultCompareIds } from "../bench-data";
import { ComparisonTable } from "../components/ComparisonTable";
import { TaskBreakdown } from "../components/TaskBreakdown";

export function canCompareBenchRuns(
  baselineSummary: BenchResultSummary | null,
  candidateSummary: BenchResultSummary | null,
): boolean {
  return (
    baselineSummary !== null &&
    candidateSummary !== null &&
    baselineSummary.id !== candidateSummary.id &&
    baselineSummary.benchmark === candidateSummary.benchmark
  );
}

export function filterComparableCandidateRuns(
  payload: BenchResultSummaryPayload,
  baselineSummary: BenchResultSummary | null,
): BenchResultSummary[] {
  if (!baselineSummary) {
    return payload.summaries;
  }

  return payload.summaries.filter(
    (summary) =>
      summary.benchmark === baselineSummary.benchmark &&
      summary.id !== baselineSummary.id,
  );
}

export function Compare({ payload }: { payload: BenchResultSummaryPayload }) {
  const defaults = pickDefaultCompareIds(payload);
  const [baselineId, setBaselineId] = useState<string>(defaults.baselineId ?? "");
  const [candidateId, setCandidateId] = useState<string>(defaults.candidateId ?? "");

  useEffect(() => {
    setBaselineId(defaults.baselineId ?? "");
    setCandidateId(defaults.candidateId ?? "");
  }, [defaults.baselineId, defaults.candidateId]);

  const baselineSummary =
    payload.summaries.find((summary) => summary.id === baselineId) ?? null;
  const candidateSummary =
    payload.summaries.find((summary) => summary.id === candidateId) ?? null;

  useEffect(() => {
    if (baselineSummary && candidateSummary && !canCompareBenchRuns(baselineSummary, candidateSummary)) {
      setCandidateId("");
    }
  }, [baselineSummary, candidateSummary]);

  const candidateOptions = filterComparableCandidateRuns(payload, baselineSummary);

  const comparison = canCompareBenchRuns(baselineSummary, candidateSummary)
    ? buildCompareModel(payload, baselineId, candidateId)
    : null;

  return (
    <section className="page">
      <header className="page-header">
        <div>
          <span className="section-kicker">Compare</span>
          <h3>Run-versus-run inspection</h3>
        </div>
        <p>Choose two local runs and compare aggregate movement, confidence intervals, and task deltas.</p>
      </header>

      <section className="panel controls-grid">
        <label>
          <span>Baseline run</span>
          <select value={baselineId} onChange={(event) => setBaselineId(event.target.value)}>
            <option value="">Select baseline</option>
            {payload.summaries.map((summary) => (
              <option key={summary.id} value={summary.id}>
                {summary.id} · {summary.benchmark}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Candidate run</span>
          <select value={candidateId} onChange={(event) => setCandidateId(event.target.value)}>
            <option value="">Select candidate</option>
            {candidateOptions.map((summary) => (
              <option key={summary.id} value={summary.id}>
                {summary.id} · {summary.benchmark}
              </option>
            ))}
          </select>
        </label>
      </section>

      {comparison ? (
        <>
          <section className="compare-summary">
            <article className="stat-card stat-card--compact">
              <span>Baseline</span>
              <strong>{comparison.baseline.id}</strong>
              <p>{comparison.baseline.benchmark}</p>
            </article>
            <article className="stat-card stat-card--compact">
              <span>Candidate</span>
              <strong>{comparison.candidate.id}</strong>
              <p>{comparison.candidate.benchmark}</p>
            </article>
          </section>
          <ComparisonTable rows={comparison.metricRows} />
          <TaskBreakdown
            rows={comparison.taskRows}
            title="Largest task-level shifts"
          />
        </>
      ) : (
        <div className="panel panel--empty">
          <p>Select two runs to unlock the comparison view.</p>
        </div>
      )}
    </section>
  );
}
