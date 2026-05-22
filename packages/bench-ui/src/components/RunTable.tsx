import { Link } from "react-router-dom";
import type { BenchResultSummary } from "../bench-data";
import {
  formatCurrency,
  formatDelta,
  formatDuration,
  formatMetricValue,
  formatTimestamp,
  humanizeIdentifier,
} from "../bench-data";
import { IntegrityBadge } from "./IntegrityBadge";

export function formatRunPrimaryScore(run: Pick<BenchResultSummary, "primaryMetric" | "primaryScore">): string {
  return formatMetricValue(run.primaryScore, run.primaryMetric ?? undefined);
}

export function formatRunPrimaryDelta(
  run: Pick<BenchResultSummary, "primaryMetric"> & { delta?: number | null },
): string {
  return formatDelta(run.delta ?? null, run.primaryMetric ?? undefined);
}

export function benchmarkRoute(benchmark: string): string {
  return `/benchmark/${encodeURIComponent(benchmark)}`;
}

export function RunTable({
  runs,
  showDelta = true,
}: {
  runs: Array<BenchResultSummary & { delta?: number | null }>;
  showDelta?: boolean;
}) {
  if (runs.length === 0) {
    return (
      <div className="panel panel--empty">
        <p>No runs match the current filters.</p>
      </div>
    );
  }

  return (
    <div className="panel">
      <table className="table table--runs">
        <thead>
          <tr>
            <th>Run</th>
            <th>Benchmark</th>
            <th>Providers</th>
            <th>Score</th>
            {showDelta ? <th>Delta</th> : null}
            <th>Integrity</th>
            <th>Latency</th>
            <th>Cost</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => (
            <tr key={run.id}>
              <td>
                <div className="run-cell">
                  <strong>{run.id}</strong>
                  <span>{formatTimestamp(run.timestamp)}</span>
                </div>
              </td>
              <td>
                <div className="run-cell">
                  <Link className="inline-link" to={benchmarkRoute(run.benchmark)}>
                    {humanizeIdentifier(run.benchmark)}
                  </Link>
                  <span>{run.mode}</span>
                </div>
              </td>
              <td>
                <div className="run-cell">
                  <strong>{run.systemProvider}</strong>
                  <span>{run.judgeProvider}</span>
                </div>
              </td>
              <td>{formatRunPrimaryScore(run)}</td>
              {showDelta ? <td>{formatRunPrimaryDelta(run)}</td> : null}
              <td>
                <IntegrityBadge summary={run.integrity} />
              </td>
              <td>{formatDuration(run.totalLatencyMs)}</td>
              <td>{formatCurrency(run.estimatedCostUsd)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
import * as React from "react";
