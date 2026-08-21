import * as React from "react";
import { useId } from "react";

import type { TrendPoint } from "../bench-data";
import { formatMetricValue } from "../bench-data";

function pathForPoints(points: TrendPoint[], width: number, height: number): string {
  if (points.length === 0) {
    return "";
  }

  const max = Math.max(...points.map((point) => point.score));
  const min = Math.min(...points.map((point) => point.score));
  const span = max === min ? 1 : max - min;

  return points
    .map((point, index) => {
      const x = (index / Math.max(points.length - 1, 1)) * width;
      const normalized = (point.score - min) / span;
      const y = height - normalized * height;
      return `${index === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(" ");
}

export function TrendChart({ points }: { points: TrendPoint[] }) {
  const gradientId = `trend-stroke-${useId().replace(/:/g, "")}`;

  if (points.length === 0) {
    return (
      <div className="panel panel--empty">
        <p>No benchmark runs match the selected trend range yet.</p>
      </div>
    );
  }

  const width = 720;
  const height = 220;
  const path = pathForPoints(points, width, height);
  const scores = points.map((point) => point.score);
  const max = Math.max(...scores);
  const min = Math.min(...scores);
  const span = max === min ? 1 : max - min;

  return (
    <section className="panel trend-chart">
      <div className="trend-chart__header">
        <div>
          <span className="section-kicker">Trend</span>
          <h4>Score movement over time</h4>
        </div>
        <span className="trend-chart__summary">
          {formatMetricValue(points[points.length - 1]?.score ?? null)} latest
        </span>
      </div>

      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="trend-chart__canvas"
        role="img"
        aria-label="Benchmark score trend over time"
      >
        <defs>
          <linearGradient id={gradientId} x1="0%" x2="100%" y1="0%" y2="0%">
            <stop offset="0%" stopColor="#8fd6ff" />
            <stop offset="100%" stopColor="#ffab78" />
          </linearGradient>
        </defs>
        <path d={path} fill="none" stroke={`url(#${gradientId})`} strokeWidth="4" />
        {points.map((point, index) => {
          const x = (index / Math.max(points.length - 1, 1)) * width;
          const normalized = (point.score - min) / span;
          const y = height - normalized * height;

          return <circle key={point.runId} cx={x} cy={y} r="5" fill="#0f1721" stroke="#d7f3ff" strokeWidth="2" />;
        })}
      </svg>

      <div className="trend-chart__labels">
        <span>{points[0]?.label}</span>
        <span>{points[points.length - 1]?.label}</span>
      </div>
    </section>
  );
}
