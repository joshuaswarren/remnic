import * as React from "react";
import { Link } from "react-router-dom";
import { useState } from "react";
import type { BenchResultSummaryPayload, TrendRange } from "../bench-data";
import { getBenchmarkCards, getRecentRuns, getTrendPoints } from "../bench-data";
import { benchmarkRoute, RunTable } from "../components/RunTable";
import { ScoreCard } from "../components/ScoreCard";
import { TrendChart } from "../components/TrendChart";

const ranges: TrendRange[] = ["7d", "30d", "90d", "all"];

export function Overview({ payload }: { payload: BenchResultSummaryPayload }) {
  const cards = getBenchmarkCards(payload);
  const [range, setRange] = useState<TrendRange>("30d");
  const [benchmark, setBenchmark] = useState<string>("all");
  const trendPoints = getTrendPoints(payload, benchmark, range);
  const recentRuns = getRecentRuns(payload);

  return (
    <section className="page">
      <header className="page-header">
        <div>
          <span className="section-kicker">Overview</span>
          <h3>Local benchmark command center</h3>
        </div>
        <p>Latest scores, trend movement, and the most recent run activity pulled from local result files.</p>
      </header>

      <div className="score-grid">
        {cards.map((card) => (
          <Link key={card.benchmark} to={benchmarkRoute(card.benchmark)}>
            <ScoreCard card={card} />
          </Link>
        ))}
      </div>

      <section className="panel controls-panel">
        <div className="control-group">
          <label htmlFor="trend-benchmark">Trend benchmark</label>
          <select
            id="trend-benchmark"
            value={benchmark}
            onChange={(event) => setBenchmark(event.target.value)}
          >
            <option value="all">All benchmarks</option>
            {cards.map((card) => (
              <option key={card.benchmark} value={card.benchmark}>
                {card.benchmark}
              </option>
            ))}
          </select>
        </div>
        <div className="range-group" role="tablist" aria-label="Trend range">
          {ranges.map((option) => (
            <button
              key={option}
              type="button"
              className={`range-pill${range === option ? " range-pill--active" : ""}`}
              onClick={() => setRange(option)}
            >
              {option}
            </button>
          ))}
        </div>
      </section>

      <TrendChart points={trendPoints} />

      <section className="page-block">
        <div className="section-title">
          <span className="section-kicker">Recent runs</span>
          <h4>Latest benchmark executions</h4>
        </div>
        <RunTable runs={recentRuns} />
      </section>
    </section>
  );
}
