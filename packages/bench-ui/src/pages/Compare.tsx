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

export function reconcileCompareSelection(
  payload: BenchResultSummaryPayload,
  selection: { baselineId: string; candidateId: string },
  options: { preserveClearedSelection?: boolean } = {},
): { baselineId: string; candidateId: string } {
  const preserveClearedSelection = options.preserveClearedSelection ?? true;
  const defaults = pickDefaultCompareIds(payload);
  const summariesById = new Map(payload.summaries.map((summary) => [summary.id, summary]));
  let baselineId = selection.baselineId;
  if (baselineId === "") {
    if (preserveClearedSelection) {
      return { baselineId: "", candidateId: "" };
    }
    baselineId = defaults.baselineId ?? "";
  }
  if (!summariesById.has(baselineId)) {
    baselineId = defaults.baselineId ?? "";
  }

  const baselineSummary = summariesById.get(baselineId) ?? null;
  if (!baselineSummary) {
    return { baselineId, candidateId: "" };
  }

  const candidateOptions = filterComparableCandidateRuns(payload, baselineSummary);
  const candidateIds = new Set(candidateOptions.map((summary) => summary.id));
  let candidateId = selection.candidateId;
  if (candidateId === "") {
    if (preserveClearedSelection) {
      return { baselineId, candidateId: "" };
    }
    if (defaults.candidateId && candidateIds.has(defaults.candidateId)) {
      candidateId = defaults.candidateId;
    } else {
      candidateId = candidateOptions[0]?.id ?? "";
    }
  }
  if (!candidateIds.has(candidateId)) {
    if (defaults.candidateId && candidateIds.has(defaults.candidateId)) {
      candidateId = defaults.candidateId;
    } else {
      candidateId = candidateOptions[0]?.id ?? "";
    }
  }

  return { baselineId, candidateId };
}

export function Compare({ payload }: { payload: BenchResultSummaryPayload }) {
  const defaults = pickDefaultCompareIds(payload);
  const [baselineId, setBaselineId] = useState<string>(defaults.baselineId ?? "");
  const [candidateId, setCandidateId] = useState<string>(defaults.candidateId ?? "");
  const [selectionTouched, setSelectionTouched] = useState(false);

  useEffect(() => {
    const next = reconcileCompareSelection(
      payload,
      { baselineId, candidateId },
      { preserveClearedSelection: selectionTouched },
    );
    if (next.baselineId !== baselineId) {
      setBaselineId(next.baselineId);
    }
    if (next.candidateId !== candidateId) {
      setCandidateId(next.candidateId);
    }
  }, [payload, baselineId, candidateId, selectionTouched]);

  const baselineSummary =
    payload.summaries.find((summary) => summary.id === baselineId) ?? null;
  const candidateSummary =
    payload.summaries.find((summary) => summary.id === candidateId) ?? null;

  const candidateOptions = baselineSummary
    ? filterComparableCandidateRuns(payload, baselineSummary)
    : [];

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
          <select value={baselineId} onChange={(event) => {
            setSelectionTouched(true);
            setBaselineId(event.target.value);
          }}>
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
          <select value={candidateId} onChange={(event) => {
            setSelectionTouched(true);
            setCandidateId(event.target.value);
          }}>
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
