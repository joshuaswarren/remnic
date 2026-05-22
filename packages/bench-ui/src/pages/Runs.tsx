import { useState } from "react";
import type { BenchResultSummaryPayload, RunFilters, TrendRange } from "../bench-data";
import { filterRuns, listBenchmarks, listProviders } from "../bench-data";
import { RunTable } from "../components/RunTable";

const ranges: TrendRange[] = ["7d", "30d", "90d", "all"];

export function reconcileRunFilters(
  payload: BenchResultSummaryPayload,
  filters: RunFilters,
): RunFilters {
  const benchmarks = new Set(listBenchmarks(payload));
  const systemProviders = new Set(listProviders(payload, "systemProvider"));
  const judgeProviders = new Set(listProviders(payload, "judgeProvider"));

  return {
    ...filters,
    benchmark:
      filters.benchmark === "all" || benchmarks.has(filters.benchmark)
        ? filters.benchmark
        : "all",
    systemProvider:
      filters.systemProvider === "all" || systemProviders.has(filters.systemProvider)
        ? filters.systemProvider
        : "all",
    judgeProvider:
      filters.judgeProvider === "all" || judgeProviders.has(filters.judgeProvider)
        ? filters.judgeProvider
        : "all",
  };
}

export function Runs({ payload }: { payload: BenchResultSummaryPayload }) {
  const [filters, setFilters] = useState<RunFilters>({
    benchmark: "all",
    systemProvider: "all",
    judgeProvider: "all",
    mode: "all",
    range: "all",
  });
  const reconciledFilters = reconcileRunFilters(payload, filters);
  const benchmarks = listBenchmarks(payload);
  const systemProviders = listProviders(payload, "systemProvider");
  const judgeProviders = listProviders(payload, "judgeProvider");
  const filtered = filterRuns(payload, reconciledFilters);

  return (
    <section className="page">
      <header className="page-header">
        <div>
          <span className="section-kicker">Runs</span>
          <h3>Filterable run history</h3>
        </div>
        <p>Slice the local result set by benchmark, provider stack, mode, and recency window.</p>
      </header>

      <section className="panel controls-grid">
        <label>
          <span>Benchmark</span>
          <select
            value={reconciledFilters.benchmark}
            onChange={(event) => setFilters((current) => ({ ...current, benchmark: event.target.value }))}
          >
            <option value="all">All benchmarks</option>
            {benchmarks.map((benchmark) => (
              <option key={benchmark} value={benchmark}>
                {benchmark}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>System provider</span>
          <select
            value={reconciledFilters.systemProvider}
            onChange={(event) =>
              setFilters((current) => ({ ...current, systemProvider: event.target.value }))
            }
          >
            <option value="all">All systems</option>
            {systemProviders.map((provider) => (
              <option key={provider} value={provider}>
                {provider}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Judge provider</span>
          <select
            value={reconciledFilters.judgeProvider}
            onChange={(event) =>
              setFilters((current) => ({ ...current, judgeProvider: event.target.value }))
            }
          >
            <option value="all">All judges</option>
            {judgeProviders.map((provider) => (
              <option key={provider} value={provider}>
                {provider}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Mode</span>
          <select
            value={reconciledFilters.mode}
            onChange={(event) => setFilters((current) => ({ ...current, mode: event.target.value }))}
          >
            <option value="all">All modes</option>
            <option value="quick">quick</option>
            <option value="full">full</option>
          </select>
        </label>
        <label>
          <span>Range</span>
          <select
            value={reconciledFilters.range}
            onChange={(event) =>
              setFilters((current) => ({ ...current, range: event.target.value as TrendRange }))
            }
          >
            {ranges.map((range) => (
              <option key={range} value={range}>
                {range}
              </option>
            ))}
          </select>
        </label>
      </section>

      <RunTable runs={filtered} showDelta={false} />
    </section>
  );
}
import * as React from "react";
