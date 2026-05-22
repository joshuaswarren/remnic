import * as React from "react";
import { Link } from "react-router-dom";
import type { BenchResultSummaryPayload } from "../bench-data";
import {
  deltaPolarityClass,
  formatDelta,
  formatMetricValue,
  getBenchmarkCards,
  humanizeIdentifier,
} from "../bench-data";
import { benchmarkRoute } from "../components/RunTable";
import { ScoreCard } from "../components/ScoreCard";

const INGESTION_BENCHMARKS = [
  "ingestion-entity-recall",
  "ingestion-backlink-f1",
  "ingestion-citation-accuracy",
  "ingestion-schema-completeness",
  "ingestion-setup-friction",
] as const;

const INGESTION_DESCRIPTIONS: Record<string, string> = {
  "ingestion-entity-recall":
    "Recall of people, orgs, projects, topics, and events extracted from raw inbox fixtures against a curated gold entity set.",
  "ingestion-backlink-f1":
    "Precision and F1 of the extracted bidirectional link graph compared to the gold link set.",
  "ingestion-citation-accuracy":
    "Fraction of claims in generated summaries that carry a valid source-chunk citation, verified by the judge.",
  "ingestion-schema-completeness":
    "Pass rate across required frontmatter fields (title, type, state, created, see-also), exec-summary, and timeline on generated pages.",
  "ingestion-setup-friction":
    "Number of commands and prompts required for a human to make the ingested inbox useful. Lower is better.",
};

export function Ingestion({ payload }: { payload: BenchResultSummaryPayload }) {
  const allCards = getBenchmarkCards(payload);
  const ingestionCards = allCards.filter((card) =>
    (INGESTION_BENCHMARKS as readonly string[]).includes(card.benchmark),
  );

  const missingBenchmarks = (INGESTION_BENCHMARKS as readonly string[]).filter(
    (id) => !ingestionCards.some((card) => card.benchmark === id),
  );

  return (
    <section className="page">
      <header className="page-header">
        <div>
          <span className="section-kicker">Ingestion</span>
          <h3>Ingestion tier benchmark suite</h3>
        </div>
        <p>
          Five metrics that measure whether Remnic can turn raw input (emails, calendars, project
          folders, chat transcripts) into a well-structured memory graph. Covers entity recall,
          backlink fidelity, citation accuracy, frontmatter schema completeness, and setup friction.
        </p>
      </header>

      {ingestionCards.length === 0 && missingBenchmarks.length === INGESTION_BENCHMARKS.length ? (
        <div className="panel panel--empty">
          <p>
            No ingestion benchmark results found. Run one or more ingestion benchmarks to populate
            this view.
          </p>
        </div>
      ) : (
        <>
          <div className="score-grid">
            {ingestionCards.map((card) => (
              <Link key={card.benchmark} to={benchmarkRoute(card.benchmark)}>
                <ScoreCard card={card} />
              </Link>
            ))}
          </div>

          {missingBenchmarks.length > 0 && (
            <section className="panel">
              <div className="section-title">
                <span className="section-kicker">Pending</span>
                <h4>Benchmarks not yet run</h4>
              </div>
              <ul className="failure-list">
                {missingBenchmarks.map((id) => (
                  <li key={id}>
                    <strong>{humanizeIdentifier(id)}</strong>
                    <p>{INGESTION_DESCRIPTIONS[id] ?? ""}</p>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}

      <section className="panel">
        <div className="section-title">
          <span className="section-kicker">Reference</span>
          <h4>Ingestion benchmark axis</h4>
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>Benchmark</th>
              <th>Primary metric</th>
              <th>Latest score</th>
              <th>vs. prior</th>
            </tr>
          </thead>
          <tbody>
            {(INGESTION_BENCHMARKS as readonly string[]).map((id) => {
              const card = ingestionCards.find((c) => c.benchmark === id);
              const deltaClass = card
                ? deltaPolarityClass(card.delta, card.latest.primaryMetric ?? undefined)
                : "";
              return (
                <tr key={id}>
                  <td>
                    {card ? (
                      <Link to={benchmarkRoute(id)}>{humanizeIdentifier(id)}</Link>
                    ) : (
                      <span className="muted-copy">{humanizeIdentifier(id)}</span>
                    )}
                  </td>
                  <td>{card?.latest.primaryMetric ?? <span className="muted-copy">—</span>}</td>
                  <td>{card ? formatMetricValue(card.latest.primaryScore, card.latest.primaryMetric ?? undefined) : <span className="muted-copy">—</span>}</td>
                  <td>
                    {card ? (
                      <span className={`delta-pill${deltaClass ? ` ${deltaClass}` : ""}`}>
                        {formatDelta(card.delta, card.latest.primaryMetric ?? undefined)}
                      </span>
                    ) : (
                      <span className="muted-copy">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
    </section>
  );
}
