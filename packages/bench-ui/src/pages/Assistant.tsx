import * as React from "react";
import { useMemo, useState } from "react";
import type { BenchResultSummary, BenchResultSummaryPayload } from "../bench-data";
import {
  ASSISTANT_BENCHMARK_IDS,
  benchmarkRuns,
  formatTimestamp,
  getAssistantDimensionBars,
  getLatestAssistantRunByBenchmark,
  humanizeIdentifier,
} from "../bench-data";
import { AssistantDimensionChart } from "../components/AssistantDimensionChart";
import { AssistantSpotCheckViewer } from "../components/AssistantSpotCheckViewer";

export function resolveAssistantUiSelection(
  payload: BenchResultSummaryPayload,
  activeBenchmark: string,
  selectedRunId: string | null,
): { runsForActive: BenchResultSummary[]; selectedRun: BenchResultSummary | null } {
  const runsForActive = benchmarkRuns(payload, activeBenchmark);
  return {
    runsForActive,
    selectedRun:
      runsForActive.find((run) => run.id === selectedRunId) ??
      runsForActive[0] ??
      null,
  };
}

export function Assistant({
  payload,
}: {
  payload: BenchResultSummaryPayload;
}) {
  const latestByBenchmark = getLatestAssistantRunByBenchmark(payload);
  const firstId = ASSISTANT_BENCHMARK_IDS[0];
  const [activeBenchmark, setActiveBenchmark] = useState<string>(firstId);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const { runsForActive, selectedRun } = useMemo(
    () => resolveAssistantUiSelection(payload, activeBenchmark, selectedRunId),
    [payload, activeBenchmark, selectedRunId],
  );
  const bars = getAssistantDimensionBars(selectedRun);

  return (
    <section className="page">
      <header className="page-header">
        <div>
          <span className="section-kicker">Assistant</span>
          <h3>Assistant / Personalization tier</h3>
        </div>
        <p>
          Sealed-rubric evaluations scored along four dimensions
          (identity_accuracy, stance_coherence, novelty, calibration) with
          bootstrap 95% confidence intervals. Error bars widen when the judge
          disagrees across seeded runs — treat wide intervals as a signal to
          look at the spot-check log.
        </p>
      </header>

      <section className="score-grid">
        {ASSISTANT_BENCHMARK_IDS.map((id) => {
          const latest = latestByBenchmark[id];
          const isActive = id === activeBenchmark;
          return (
            <button
              key={id}
              type="button"
              className={`score-card assistant-card${
                isActive ? " assistant-card--active" : ""
              }`}
              onClick={() => {
                setActiveBenchmark(id);
                setSelectedRunId(null);
              }}
            >
              <div className="score-card__header">
                <div>
                  <span className="section-kicker">remnic</span>
                  <h4>{humanizeIdentifier(id)}</h4>
                </div>
                {latest ? (
                  <span className="score-card__timestamp">
                    {formatTimestamp(latest.timestamp)}
                  </span>
                ) : (
                  <span className="score-card__timestamp">no runs</span>
                )}
              </div>
              <div className="score-card__score-row">
                <strong>
                  {latest?.primaryScore !== null && latest?.primaryScore !== undefined
                    ? latest.primaryScore.toFixed(2)
                    : "—"}
                </strong>
                <span className="delta-pill">{latest?.runCount ?? 0} runs</span>
              </div>
              <dl className="score-card__meta">
                <div>
                  <dt>Rubric</dt>
                  <dd>{latest?.assistantRubricId ?? "—"}</dd>
                </div>
                <div>
                  <dt>System</dt>
                  <dd>{latest?.systemProvider ?? "—"}</dd>
                </div>
                <div>
                  <dt>Judge</dt>
                  <dd>{latest?.judgeProvider ?? "—"}</dd>
                </div>
              </dl>
            </button>
          );
        })}
      </section>

      <section className="panel controls-panel">
        <div className="control-group">
          <label htmlFor="assistant-run-select">Run</label>
          <select
            id="assistant-run-select"
            value={selectedRun?.id ?? ""}
            onChange={(event) => setSelectedRunId(event.target.value)}
            disabled={runsForActive.length === 0}
          >
            {runsForActive.length === 0 ? (
              <option value="">No runs available</option>
            ) : (
              runsForActive.map((run) => (
                <option key={run.id} value={run.id}>
                  {formatTimestamp(run.timestamp)} · {run.mode} ·{" "}
                  {run.systemProvider}
                </option>
              ))
            )}
          </select>
        </div>
        {selectedRun?.assistantRubricSha256 ? (
          <div className="assistant-rubric-pill" title="Sealed rubric digest">
            <span className="section-kicker">rubric sha256</span>
            <code>{selectedRun.assistantRubricSha256.slice(0, 12)}…</code>
          </div>
        ) : null}
      </section>

      <section className="page-block">
        <div className="section-title">
          <span className="section-kicker">Per-dimension scores</span>
          <h4>{humanizeIdentifier(activeBenchmark)} — 95% CI error bars</h4>
        </div>
        <AssistantDimensionChart bars={bars} />
      </section>

      <section className="page-block">
        <div className="section-title">
          <span className="section-kicker">Spot-check viewer</span>
          <h4>Per-seed judge decisions</h4>
        </div>
        <AssistantSpotCheckViewer summary={selectedRun} />
      </section>
    </section>
  );
}
