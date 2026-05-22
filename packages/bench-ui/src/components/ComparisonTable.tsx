import type { CompareMetricRow } from "../bench-data";
import { formatMetricValue } from "../bench-data";

export function ComparisonTable({ rows }: { rows: CompareMetricRow[] }) {
  if (rows.length === 0) {
    return (
      <div className="panel panel--empty">
        <p>No overlapping benchmark metrics were found for this run pair.</p>
      </div>
    );
  }

  return (
    <div className="panel">
      <table className="table">
        <thead>
          <tr>
            <th>Metric</th>
            <th>Baseline</th>
            <th>Candidate</th>
            <th>Delta</th>
            <th>CI</th>
            <th>Effect</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.name}>
              <td>{row.name}</td>
              <td>{formatMetricValue(row.baseline, row.name)}</td>
              <td>{formatMetricValue(row.candidate, row.name)}</td>
              <td>{formatMetricValue(row.delta, row.name)}</td>
              <td>
                {row.ciLower !== null && row.ciUpper !== null
                  ? `${formatMetricValue(row.ciLower, row.name)} to ${formatMetricValue(row.ciUpper, row.name)}`
                  : "n/a"}
              </td>
              <td>
                {row.effectSize !== null
                  ? `${row.effectSize.toFixed(2)} ${row.effectInterpretation ?? ""}`.trim()
                  : "n/a"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
import * as React from "react";
