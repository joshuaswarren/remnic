import * as React from "react";

import type { BenchResultSummary } from "../bench-data";
import { flattenAssistantSpotChecks } from "../bench-data";

export function AssistantSpotCheckViewer({
  summary,
}: {
  summary: BenchResultSummary | null;
}) {
  const rows = flattenAssistantSpotChecks(summary);

  if (!summary) {
    return (
      <p className="assistant-spot-check__empty">
        Select an Assistant benchmark run to inspect per-seed judge decisions.
      </p>
    );
  }

  if (rows.length === 0) {
    return (
      <p className="assistant-spot-check__empty">
        This run has no per-seed judge decisions available. Spot-check JSONL
        logs live under
        {" "}
        <code>benchmarks/results/spot-checks/{summary.assistantRunId ?? "<run-id>"}.jsonl</code>.
      </p>
    );
  }

  return (
    <div className="assistant-spot-check">
      <table className="assistant-spot-check__table">
        <thead>
          <tr>
            <th scope="col">Task</th>
            <th scope="col">Seed</th>
            <th scope="col">Identity</th>
            <th scope="col">Stance</th>
            <th scope="col">Novelty</th>
            <th scope="col">Calibration</th>
            <th scope="col">Parsed</th>
            <th scope="col">Notes</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={`${row.taskId}#${row.seed}`}>
              <td>
                <span className="assistant-spot-check__task">{row.taskId}</span>
                {row.focus ? (
                  <span className="assistant-spot-check__focus">({row.focus})</span>
                ) : null}
              </td>
              <td>{row.seed}</td>
              <td>{formatSeedScore(row.identityAccuracy)}</td>
              <td>{formatSeedScore(row.stanceCoherence)}</td>
              <td>{formatSeedScore(row.novelty)}</td>
              <td>{formatSeedScore(row.calibration)}</td>
              <td>{row.parseOk ? "yes" : "no"}</td>
              <td>
                <span className="assistant-spot-check__notes">
                  {row.notes || "—"}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="assistant-spot-check__footnote">
        The randomly-sampled JSONL log of judge decisions is written to
        {" "}
        <code>benchmarks/results/spot-checks/{summary.assistantRunId ?? "<run-id>"}.jsonl</code>
        {" "}for offline review.
      </p>
    </div>
  );
}

function formatSeedScore(value: number | null): string {
  return value === null ? "—" : value.toFixed(2);
}
