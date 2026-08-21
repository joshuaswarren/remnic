import * as React from "react";
import type { BenchResultSummary } from "../bench-data";
import { formatCurrency, formatDuration } from "../bench-data";

export function CostSummary({ summary }: { summary: BenchResultSummary }) {
  return (
    <section className="cost-summary">
      <article className="stat-card stat-card--compact">
        <span>Estimated cost</span>
        <strong>{formatCurrency(summary.estimatedCostUsd)}</strong>
        <p>{summary.totalTokens ?? 0} total tokens</p>
      </article>
      <article className="stat-card stat-card--compact">
        <span>Total latency</span>
        <strong>{formatDuration(summary.totalLatencyMs)}</strong>
        <p>{summary.taskCount} task evaluations</p>
      </article>
      <article className="stat-card stat-card--compact">
        <span>Mean query latency</span>
        <strong>{formatDuration(summary.meanQueryLatencyMs)}</strong>
        <p>{summary.adapterMode} adapter mode</p>
      </article>
    </section>
  );
}
