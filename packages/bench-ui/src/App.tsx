import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { HashRouter, NavLink, Navigate, Route, Routes } from "react-router-dom";
import type { BenchResultSummaryPayload } from "./bench-data";
import { listBenchmarks } from "./bench-data";
import { Assistant } from "./pages/Assistant";
import { BenchmarkDetail } from "./pages/BenchmarkDetail";
import { Compare } from "./pages/Compare";
import { Ingestion } from "./pages/Ingestion";
import { Overview } from "./pages/Overview";
import { Providers } from "./pages/Providers";
import { Runs } from "./pages/Runs";

const navigationItems = [
  { label: "Overview", path: "/" },
  { label: "Assistant", path: "/assistant" },
  { label: "Ingestion", path: "/ingestion" },
  { label: "Runs", path: "/runs" },
  { label: "Compare", path: "/compare" },
  { label: "Benchmark Detail", path: "/benchmark" },
  { label: "Providers", path: "/providers" },
];

const emptyPayload: BenchResultSummaryPayload = {
  resultsDir: "",
  summaries: [],
  skippedFiles: [],
};

function AppShell({
  children,
  payload,
  loading,
  error,
  onRefresh,
}: {
  children: ReactNode;
  payload: BenchResultSummaryPayload;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
}) {
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-lockup">
          <span className="brand-kicker">@remnic/bench-ui</span>
          <h1>Bench dashboard</h1>
          <p>
            Local benchmark views for overview, run history, comparison, benchmark
            diagnosis, and provider drift.
          </p>
        </div>

        <div className="sidebar-summary">
          <article>
            <span>Runs</span>
            <strong>{payload.summaries.length}</strong>
          </article>
          <article>
            <span>Benchmarks</span>
            <strong>{listBenchmarks(payload).length}</strong>
          </article>
        </div>

        <nav className="nav-list" aria-label="Bench navigation">
          {navigationItems.map((item) => (
            <NavLink
              key={item.path}
              to={item.path}
              end={item.path === "/"}
              className={({ isActive }) =>
                `nav-item${isActive ? " nav-item--active" : ""}`
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>

        <button type="button" className="refresh-button" onClick={onRefresh}>
          {loading ? "Refreshing..." : "Refresh local results"}
        </button>
      </aside>

      <main className="main-panel">
        <header className="topbar">
          <div>
            <span className="status-chip">{loading ? "loading" : "local data"}</span>
            <h2>Remnic benchmark workspace</h2>
          </div>
          <div className="topbar-copy">
            <p>{payload.resultsDir || "Awaiting local benchmark result files"}</p>
            {error ? <p className="error-copy">{error}</p> : null}
            {(payload.skippedFiles?.length ?? 0) > 0 ? (
              <p className="warning-copy">
                {payload.skippedFiles!.length} result file
                {payload.skippedFiles!.length === 1 ? "" : "s"} skipped:{" "}
                {payload.skippedFiles!
                  .slice(0, 3)
                  .map((entry) => entry.filePath.split(/[\\/]/u).pop() || entry.filePath)
                  .join(", ")}
              </p>
            ) : null}
          </div>
        </header>

        {children}
      </main>
    </div>
  );
}

function NotFoundPage() {
  return (
    <section className="page">
      <header className="page-header">
        <div>
          <span className="section-kicker">Bench UI</span>
          <h3>Page not found</h3>
        </div>
        <p>Use the dashboard navigation to move between the available views.</p>
      </header>
    </section>
  );
}

export function App() {
  const [payload, setPayload] = useState<BenchResultSummaryPayload>(emptyPayload);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(0);

  const loadPayload = useCallback(async (): Promise<void> => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setLoading(true);
    setError(null);

    try {
      const response = await fetch("/api/results");
      if (!response.ok) {
        throw new Error(`Failed to load bench results: ${response.status}`);
      }

      const next = (await response.json()) as BenchResultSummaryPayload;
      if (requestId !== requestIdRef.current) return;
      setPayload(next);
    } catch (cause) {
      if (requestId !== requestIdRef.current) return;
      setError(cause instanceof Error ? cause.message : String(cause));
      setPayload(emptyPayload);
    } finally {
      if (requestId === requestIdRef.current) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    void loadPayload();
  }, [loadPayload]);

  const defaultBenchmark = listBenchmarks(payload)[0] ?? "longmemeval";

  return (
    <HashRouter>
      <AppShell
        payload={payload}
        loading={loading}
        error={error}
        onRefresh={() => {
          void loadPayload();
        }}
      >
        <Routes>
          <Route path="/" element={<Overview payload={payload} />} />
          <Route path="/assistant" element={<Assistant payload={payload} />} />
          <Route path="/ingestion" element={<Ingestion payload={payload} />} />
          <Route path="/runs" element={<Runs payload={payload} />} />
          <Route path="/compare" element={<Compare payload={payload} />} />
          <Route
            path="/benchmark/:benchmarkId"
            element={<BenchmarkDetail payload={payload} />}
          />
          <Route path="/providers" element={<Providers payload={payload} />} />
          <Route
            path="/benchmark"
            element={<Navigate to={`/benchmark/${encodeURIComponent(defaultBenchmark)}`} replace />}
          />
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </AppShell>
    </HashRouter>
  );
}
