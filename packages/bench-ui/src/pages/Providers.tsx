import type { BenchResultSummaryPayload } from "../bench-data";
import {
  buildProviderRows,
  formatCurrency,
  formatMetricValue,
  listBenchmarks,
  humanizeIdentifier,
} from "../bench-data";

export function Providers({ payload }: { payload: BenchResultSummaryPayload }) {
  const rows = buildProviderRows(payload);
  const benchmarks = listBenchmarks(payload);

  return (
    <section className="page">
      <header className="page-header">
        <div>
          <span className="section-kicker">Providers</span>
          <h3>System and judge performance matrix</h3>
        </div>
        <p>See how provider pairings influence scores and cost across the local benchmark set.</p>
      </header>

      {rows.length === 0 ? (
        <div className="panel panel--empty">
          <p>No provider data has been observed yet.</p>
        </div>
      ) : (
        <div className="panel">
          <table className="table table--providers">
            <thead>
              <tr>
                <th>Provider pair</th>
                <th>Runs</th>
                <th>Avg score</th>
                <th>Avg cost</th>
                {benchmarks.map((benchmark) => (
                  <th key={benchmark}>{humanizeIdentifier(benchmark)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.providerKey}>
                  <td>
                    <div className="run-cell">
                      <strong>{row.systemProvider}</strong>
                      <span>{row.judgeProvider}</span>
                    </div>
                  </td>
                  <td>{row.runCount}</td>
                  <td>{formatMetricValue(row.averageScore)}</td>
                  <td>{formatCurrency(row.averageCostUsd)}</td>
                  {benchmarks.map((benchmark) => (
                    <td key={`${row.providerKey}-${benchmark}`}>
                      {formatMetricValue(row.benchmarkScores[benchmark] ?? null)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
import * as React from "react";
