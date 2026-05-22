import * as React from "react";

import type { AssistantDimensionBar } from "../bench-data";

const MAX_SCORE = 5;

export function AssistantDimensionChart({
  bars,
}: {
  bars: AssistantDimensionBar[];
}) {
  return (
    <div className="assistant-chart" role="img" aria-label="Per-dimension rubric scores with 95% CI error bars">
      {bars.map((bar) => {
        const meanPercent =
          bar.mean !== null
            ? Math.max(0, Math.min(100, (bar.mean / MAX_SCORE) * 100))
            : 0;
        const ciLowerPercent =
          bar.ciLower !== null
            ? Math.max(0, Math.min(100, (bar.ciLower / MAX_SCORE) * 100))
            : meanPercent;
        const ciUpperPercent =
          bar.ciUpper !== null
            ? Math.max(0, Math.min(100, (bar.ciUpper / MAX_SCORE) * 100))
            : meanPercent;
        const hasCi =
          bar.ciLower !== null &&
          bar.ciUpper !== null &&
          bar.ciUpper > bar.ciLower;

        return (
          <div key={bar.dimension} className="assistant-chart__row">
            <div className="assistant-chart__label">{bar.label}</div>
            <div className="assistant-chart__track" aria-hidden="true">
              {bar.mean === null ? (
                <span className="assistant-chart__na">no data</span>
              ) : (
                <>
                  <div
                    className="assistant-chart__fill"
                    style={{ width: `${meanPercent}%` }}
                  />
                  {hasCi ? (
                    <div
                      className="assistant-chart__error-bar"
                      style={{
                        left: `${ciLowerPercent}%`,
                        width: `${Math.max(0.5, ciUpperPercent - ciLowerPercent)}%`,
                      }}
                      title={`95% CI: ${bar.ciLower?.toFixed(2)} - ${bar.ciUpper?.toFixed(2)}`}
                    />
                  ) : null}
                </>
              )}
            </div>
            <div className="assistant-chart__value">
              {bar.mean === null ? "—" : bar.mean.toFixed(2)}
              {hasCi ? (
                <span className="assistant-chart__ci">
                  {" "}
                  (95% CI {bar.ciLower?.toFixed(2)}–{bar.ciUpper?.toFixed(2)})
                </span>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}
