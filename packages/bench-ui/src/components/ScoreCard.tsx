import type { BenchmarkCard } from "../bench-data";
import {
  deltaPolarityClass,
  formatDelta,
  formatMetricValue,
  formatTimestamp,
  humanizeIdentifier,
} from "../bench-data";
import { IntegrityBadge } from "./IntegrityBadge";

export function ScoreCard({ card }: { card: BenchmarkCard }) {
  const deltaClass = deltaPolarityClass(
    card.delta,
    card.latest.primaryMetric ?? undefined,
  );

  return (
    <article className="score-card">
      <div className="score-card__header">
        <div>
          <span className="section-kicker">{card.latest.benchmarkTier}</span>
          <h4>{humanizeIdentifier(card.benchmark)}</h4>
        </div>
        <span className="score-card__timestamp">{formatTimestamp(card.latest.timestamp)}</span>
      </div>

      <div className="score-card__score-row">
        <strong>{formatMetricValue(card.latest.primaryScore, card.latest.primaryMetric ?? undefined)}</strong>
        <span
          className={`delta-pill${deltaClass ? ` ${deltaClass}` : ""}`}
        >
          {formatDelta(card.delta, card.latest.primaryMetric ?? undefined)}
        </span>
      </div>

      <IntegrityBadge summary={card.latest.integrity} />

      <dl className="score-card__meta">
        <div>
          <dt>Metric</dt>
          <dd>{card.latest.primaryMetric ?? "n/a"}</dd>
        </div>
        <div>
          <dt>System</dt>
          <dd>{card.latest.systemProvider}</dd>
        </div>
        <div>
          <dt>Judge</dt>
          <dd>{card.latest.judgeProvider}</dd>
        </div>
      </dl>
    </article>
  );
}
import * as React from "react";
