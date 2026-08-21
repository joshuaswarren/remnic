import { MEMORY_EVAL_DIMENSIONS } from "./memory-evals.js";
import type { BenchmarkResult, MetricAggregate, TaskResult } from "./types.js";

type ReportStatus = "complete" | "partial" | "backend-unusable" | "unscored";

export interface ReportCardProvenanceContext {
  /** Human-readable reference to the manifest that covers this result. */
  manifestReference?: string;
  /** Reproducibility manifest artifact hash, when the manifest records one. */
  artifactHash?: string;
}

interface MetricValue {
  name: string;
  value: number;
}

const PRIMARY_METRIC_ORDER = [
  "overall_score",
  "llm_judge",
  "accuracy",
  "answer_accuracy",
  "exact_match",
  "f1",
  "uptake_at_next",
] as const;

const CORRECTION_METRICS = [
  {
    name: "uptake_at_next",
    label: "Correction visible next",
    description: "Share of corrections visible at the first post-correction probe.",
    direction: "Higher is better",
  },
  {
    name: "non_resurrection",
    label: "Stale fact stayed retired",
    description: "Share of corrected facts that did not return during maintenance and re-ingest.",
    direction: "Higher is better",
  },
  {
    name: "false_apply",
    label: "False corrections",
    description: "Share of anti-events that incorrectly changed memory.",
    direction: "Lower is better",
  },
] as const;

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll(`"`, "&quot;")
    .replaceAll("'", "&#39;");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function formatNumber(value: number): string {
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
}

function formatPercent(value: number | undefined): string {
  return value === undefined ? "Not measured" : `${formatNumber(value * 100)}%`;
}

function formatDimensionMetric(name: string, value: number): string {
  const percentageMetric =
    name.includes("rate") ||
    name.includes("precision") ||
    name.includes("recall") ||
    name.includes("success") ||
    name.includes("alignment") ||
    name.includes("lift");
  return percentageMetric ? formatPercent(value) : formatNumber(value);
}

function aggregateMeans(result: BenchmarkResult): Record<string, number> {
  const means: Record<string, number> = {};
  for (const name of Object.keys(result.results.aggregates).sort()) {
    const mean = finiteNumber(result.results.aggregates[name]?.mean);
    if (mean !== undefined) means[name] = mean;
  }
  return means;
}

function correctionMetricValues(result: BenchmarkResult): Record<string, number> {
  const benchmarkOptions = result.config.benchmarkOptions;
  const persistedBundle = isRecord(benchmarkOptions)
    ? benchmarkOptions.aggregateMetrics
    : undefined;
  const values: Record<string, number> = {};
  if (isRecord(persistedBundle)) {
    for (const name of Object.keys(persistedBundle).sort()) {
      const value = finiteNumber(persistedBundle[name]);
      if (value !== undefined) values[name] = value;
    }
  }
  const means = aggregateMeans(result);
  for (const metric of CORRECTION_METRICS) {
    if (values[metric.name] === undefined && means[metric.name] !== undefined) {
      values[metric.name] = means[metric.name]!;
    }
  }
  return values;
}

function resultStatus(result: BenchmarkResult): ReportStatus {
  const failure = result.meta.failureReason ?? "";
  const typedBackendFailure = /(?:backend[ _-]?unusable|transport[ _-]?failure|tool[ _-]?failure|invalid[ _-]?response)/i;
  if (
    result.meta.status === "partial" &&
    result.results.tasks.length === 0 &&
    typedBackendFailure.test(failure)
  ) {
    return "backend-unusable";
  }
  if (result.meta.status === "partial") return "partial";
  if (result.results.tasks.length === 0) return "unscored";
  return "complete";
}

function statusCopy(status: ReportStatus): { label: string; detail: string } {
  switch (status) {
    case "backend-unusable":
      return {
        label: "Backend unusable",
        detail: "The memory backend failed before a trustworthy score could be produced.",
      };
    case "partial":
      return {
        label: "Partial run",
        detail: "The run stopped early. Scores describe completed tasks only and are not a full result.",
      };
    case "unscored":
      return {
        label: "No scored tasks",
        detail: "The run completed without task-level evidence, so no overall score is claimed.",
      };
    case "complete":
      return {
        label: "Complete run",
        detail: "All persisted task results are included in this report card.",
      };
  }
}

function primaryMetric(result: BenchmarkResult): MetricValue | undefined {
  const means = aggregateMeans(result);
  const correction = correctionMetricValues(result);
  if (result.meta.benchmark === "memcorrect-v1" && correction.uptake_at_next !== undefined) {
    return { name: "uptake_at_next", value: correction.uptake_at_next };
  }
  for (const name of PRIMARY_METRIC_ORDER) {
    if (means[name] !== undefined) return { name, value: means[name]! };
  }
  return undefined;
}

function renderScore(result: BenchmarkResult, status: ReportStatus): string {
  const metric = primaryMetric(result);
  if (status === "backend-unusable" || status === "unscored" || !metric) {
    return `<div class="score score--na"><span class="score__value">N/A</span><span class="score__label">No defensible score</span></div>`;
  }
  const value = metric.value >= 0 && metric.value <= 1
    ? formatPercent(metric.value)
    : formatNumber(metric.value);
  return `<div class="score"><span class="score__value">${escapeHtml(value)}</span><span class="score__label">Overall score · ${escapeHtml(metric.name)}</span><span class="score__note">Recorded mean of the named primary metric; no cross-metric composite.</span></div>`;
}

function renderCorrectionSpotlight(result: BenchmarkResult): string {
  const values = correctionMetricValues(result);
  const tasks = [...result.results.tasks].sort((left, right) =>
    left.taskId.localeCompare(right.taskId),
  );
  const accepted = tasks.filter((task) => task.scores.uptake_at_next === 1).length;
  const notObserved = tasks.filter((task) => task.scores.uptake_at_next === 0).length;
  const staleReturned = tasks.filter((task) => task.scores.non_resurrection === 0).length;
  const measuredCorrectionTasks = accepted + notObserved;
  const measuredRetirementTasks = tasks.filter(
    (task) => task.scores.non_resurrection === 0 || task.scores.non_resurrection === 1,
  ).length;

  const cards = CORRECTION_METRICS.map((metric) => {
    const value = values[metric.name];
    const state = value === undefined ? "not-measured" : "measured";
    return `        <article class="ledger-card ledger-card--${state}">
          <p class="eyebrow">${escapeHtml(metric.direction)}</p>
          <p class="ledger-card__value">${formatPercent(value)}</p>
          <h3>${escapeHtml(metric.label)}</h3>
          <p>${escapeHtml(metric.description)}</p>
        </article>`;
  }).join("\n");

  const countSummary = measuredCorrectionTasks > 0 || measuredRetirementTasks > 0
    ? `        <p class="ledger-summary"><strong>${accepted}</strong> visible at the next probe · <strong>${notObserved}</strong> not observed at the next probe · <strong>${staleReturned}</strong> stale-fact return${staleReturned === 1 ? "" : "s"}</p>`
    : `        <p class="ledger-summary ledger-summary--empty">This run did not record MemCorrect scenario outcomes.</p>`;

  return `      <section class="spotlight" aria-labelledby="correction-heading">
        <div class="section-heading">
          <div>
            <p class="eyebrow">Correction ledger</p>
            <h2 id="correction-heading">Did the system take the correction—and keep it?</h2>
          </div>
          <p>Values come from persisted MemCorrect metrics when present. Missing evidence stays missing.</p>
        </div>
        <div class="ledger">
${cards}
        </div>
${countSummary}
      </section>`;
}

function taskContext(task: TaskResult): { shape: string; category: string } {
  const details = task.details;
  if (!isRecord(details)) return { shape: "—", category: "—" };
  return {
    shape: typeof details.shape === "string" ? details.shape : "—",
    category: typeof details.category === "string" ? details.category : "—",
  };
}

function taskScore(task: TaskResult, name: string): string {
  const value = finiteNumber(task.scores[name]);
  return value === undefined ? "—" : formatPercent(value);
}

function renderScenarioDrilldown(result: BenchmarkResult): string {
  const tasks = [...result.results.tasks].sort((left, right) =>
    left.taskId.localeCompare(right.taskId),
  );
  if (tasks.length === 0) {
    return `      <section aria-labelledby="scenario-heading">
        <div class="section-heading"><div><p class="eyebrow">Evidence</p><h2 id="scenario-heading">Scenario drill-down</h2></div></div>
        <p class="empty-state">No task-level scenarios were persisted for this run.</p>
      </section>`;
  }
  const rows = tasks.map((task) => {
    const context = taskContext(task);
    return `            <tr>
              <th scope="row">${escapeHtml(task.taskId)}</th>
              <td>${escapeHtml(context.shape)}</td>
              <td>${escapeHtml(context.category)}</td>
              <td>${taskScore(task, "uptake_at_next")}</td>
              <td>${taskScore(task, "non_resurrection")}</td>
              <td>${taskScore(task, "false_apply")}</td>
            </tr>`;
  }).join("\n");
  return `      <section aria-labelledby="scenario-heading">
        <div class="section-heading">
          <div><p class="eyebrow">Evidence</p><h2 id="scenario-heading">Scenario drill-down</h2></div>
          <p>“—” means the scenario did not record that metric; it is not a zero.</p>
        </div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Scenario</th><th>Shape</th><th>Category</th><th>Correction next</th><th>Stayed retired</th><th>False apply</th></tr></thead>
            <tbody>
${rows}
            </tbody>
          </table>
        </div>
      </section>`;
}

function renderDimensions(result: BenchmarkResult): string {
  const means = aggregateMeans(result);
  const cards = MEMORY_EVAL_DIMENSIONS.map((dimension) => {
    const measured = dimension.metrics.filter((metric) => means[metric.name] !== undefined);
    const body = measured.length === 0
      ? `<p class="dimension__empty">Not measured in this run. No pass or fail is inferred.</p>`
      : `<dl>${measured.map((metric) => `
              <div><dt>${escapeHtml(metric.name)}</dt><dd>${escapeHtml(formatDimensionMetric(metric.name, means[metric.name]!))}</dd></div>
              <p>${escapeHtml(metric.higherIsBetter ? "Higher is better" : "Lower is better")} · No pass threshold is recorded in the result.</p>`).join("")}
            </dl>`;
    return `        <article class="dimension">
          <p class="eyebrow">${escapeHtml(dimension.category)}</p>
          <h3>${escapeHtml(dimension.question)}</h3>
          ${body}
        </article>`;
  }).join("\n");
  return `      <section aria-labelledby="dimensions-heading">
        <div class="section-heading">
          <div><p class="eyebrow">Memory eval dimensions</p><h2 id="dimensions-heading">What this run can—and cannot—claim</h2></div>
          <p>Dimensions map only to matching <code>MEMORY_EVAL_DIMENSIONS</code> metrics.</p>
        </div>
        <div class="dimension-grid">
${cards}
        </div>
      </section>`;
}

function renderAggregateMetrics(result: BenchmarkResult): string {
  const names = Object.keys(result.results.aggregates).sort();
  if (names.length === 0) {
    return `      <section aria-labelledby="aggregate-heading">
        <div class="section-heading"><div><p class="eyebrow">Raw record</p><h2 id="aggregate-heading">Aggregate Metrics</h2></div></div>
        <p class="empty-state">No aggregate metrics were recorded. The report does not replace them with zeros.</p>
      </section>`;
  }
  const rows = names.map((name) => {
    const aggregate: MetricAggregate = result.results.aggregates[name]!;
    return `            <tr><th scope="row">${escapeHtml(name)}</th><td>${formatNumber(aggregate.mean)}</td><td>${formatNumber(aggregate.median)}</td><td>${formatNumber(aggregate.stdDev)}</td><td>${formatNumber(aggregate.min)}</td><td>${formatNumber(aggregate.max)}</td></tr>`;
  }).join("\n");
  return `      <section aria-labelledby="aggregate-heading">
        <div class="section-heading"><div><p class="eyebrow">Raw record</p><h2 id="aggregate-heading">Aggregate Metrics</h2></div><p>Untransformed values from the stored result.</p></div>
        <div class="table-wrap"><table><thead><tr><th>Metric</th><th>Mean</th><th>Median</th><th>Std dev</th><th>Min</th><th>Max</th></tr></thead><tbody>
${rows}
        </tbody></table></div>
      </section>`;
}

function optionString(result: BenchmarkResult, names: readonly string[]): string | undefined {
  const options = result.config.benchmarkOptions;
  if (!isRecord(options)) return undefined;
  for (const name of names) {
    const value = options[name];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return undefined;
}

function providerLabel(provider: BenchmarkResult["config"]["judgeProvider"]): string {
  return provider ? `${provider.provider} / ${provider.model}` : "Not recorded";
}

function renderProvenance(
  result: BenchmarkResult,
  provenance: ReportCardProvenanceContext,
): string {
  const rubricVersion = result.config.judgeProvider?.rubricVersion ??
    optionString(result, ["rubricVersion", "judgeRubricVersion", "rubric_version"]);
  const remnicConfigKeyCount = Object.keys(result.config.remnicConfig ?? {}).length;
  const machine = [result.environment.os, result.environment.nodeVersion, result.environment.hardware]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join(" · ");
  const entries: Array<[string, string]> = [
    ["Result ID", result.meta.id],
    ["Task Count", String(result.results.tasks.length)],
    ["Git SHA", result.meta.gitSha],
    ["Remnic / benchmark", `${result.meta.remnicVersion} / ${result.meta.version}`],
    ["Judge", providerLabel(result.config.judgeProvider)],
    ["Rubric version", rubricVersion ?? "Not recorded in stored result"],
    ["Dataset hash", result.meta.datasetHash ?? "Not recorded"],
    ["Sealed qrels hash", result.meta.qrelsSealedHash ?? "Not recorded"],
    ["Judge prompt hash", result.meta.judgePromptHash ?? "Not recorded"],
    ["Seeds", result.meta.seeds?.join(", ") || "Not recorded"],
    ["Manifest reference", provenance.manifestReference ?? "Not available"],
    ["Manifest artifact hash", provenance.artifactHash ?? "Not available"],
    ["Machine fingerprint", machine || "Not recorded"],
    [
      "Remnic config",
      remnicConfigKeyCount === 0
        ? "No keys recorded"
        : `[redacted ${remnicConfigKeyCount} key${remnicConfigKeyCount === 1 ? "" : "s"}]`,
    ],
  ];
  return `      <footer aria-labelledby="provenance-heading">
        <div class="section-heading"><div><p class="eyebrow">Receipts</p><h2 id="provenance-heading">Provenance</h2></div><p>Result fields are persisted with the run. Manifest receipts appear only when the caller supplies a verified adjacent manifest.</p></div>
        <dl class="receipts">
${entries.map(([label, value]) => `          <div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join("\n")}
        </dl>
      </footer>`;
}

export function renderMemoryReportCard(
  result: BenchmarkResult,
  provenance: ReportCardProvenanceContext = {},
): string {
  const status = resultStatus(result);
  const statusText = statusCopy(status);
  const system = result.config.systemProvider
    ? `${result.config.systemProvider.provider} / ${result.config.systemProvider.model}`
    : result.config.adapterMode;
  const failure = result.meta.failureReason
    ? `<p class="failure"><strong>Run stopped:</strong> ${escapeHtml(result.meta.failureReason)}</p>`
    : "";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Remnic Bench Report: ${escapeHtml(result.meta.benchmark)}</title>
    <style>
      :root { color-scheme: light; --ink:#142523; --muted:#5d6e69; --mist:#e9f0ed; --paper:#f8fbf9; --line:#cbd8d3; --teal:#0b7168; --teal-soft:#d8ebe6; --ember:#c9563f; --ember-soft:#f8e1db; --shadow:0 18px 48px rgba(20,37,35,.09); font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
      * { box-sizing:border-box; }
      body { margin:0; background:var(--mist); color:var(--ink); }
      main { width:min(1180px,calc(100% - 32px)); margin:0 auto; padding:32px 0 64px; }
      h1,h2,h3,p,dl,dd { margin:0; }
      h1,h2 { font-family:Georgia,"Times New Roman",serif; font-weight:500; letter-spacing:-.025em; }
      h1 { max-width:780px; font-size:clamp(2.5rem,7vw,5.8rem); line-height:.94; }
      h2 { font-size:clamp(1.7rem,3vw,2.5rem); line-height:1.05; }
      h3 { font-size:1rem; line-height:1.25; }
      p { line-height:1.55; }
      code,.eyebrow,.score__value,.receipts dd,table { font-family:"SFMono-Regular",Consolas,"Liberation Mono",monospace; }
      .eyebrow { margin-bottom:10px; color:var(--teal); font-size:.72rem; font-weight:700; letter-spacing:.12em; text-transform:uppercase; }
      .hero { position:relative; overflow:hidden; padding:clamp(28px,5vw,60px); background:var(--ink); color:var(--paper); border-radius:24px; box-shadow:var(--shadow); }
      .hero::after { content:""; position:absolute; width:320px; height:320px; right:-120px; top:-160px; border:56px solid var(--teal); border-radius:50%; opacity:.62; }
      .hero__meta { position:relative; z-index:1; display:flex; flex-wrap:wrap; gap:10px; margin-bottom:40px; }
      .pill { padding:7px 11px; border:1px solid rgba(248,251,249,.28); border-radius:999px; font-size:.78rem; }
      .hero__grid { position:relative; z-index:1; display:grid; grid-template-columns:minmax(0,1fr) minmax(220px,330px); gap:36px; align-items:end; }
      .hero__lede { max-width:650px; margin-top:22px; color:#bdd0ca; font-size:1.05rem; }
      .status { display:inline-flex; align-items:center; gap:8px; margin-top:24px; font-weight:700; }
      .status::before { content:""; width:9px; height:9px; background:var(--teal); border-radius:50%; box-shadow:0 0 0 5px rgba(11,113,104,.25); }
      .status--partial::before,.status--backend-unusable::before { background:var(--ember); box-shadow:0 0 0 5px rgba(201,86,63,.24); }
      .status__detail { display:block; margin-top:8px; color:#bdd0ca; font-size:.88rem; }
      .score { padding:24px; background:rgba(248,251,249,.08); border:1px solid rgba(248,251,249,.18); border-radius:18px; }
      .score__value { display:block; color:#75d2c4; font-size:clamp(2.8rem,6vw,4.8rem); line-height:1; }
      .score--na .score__value { color:#f2a18f; }
      .score__label { display:block; margin-top:10px; font-weight:750; }
      .score__note { display:block; margin-top:8px; color:#bdd0ca; font-size:.78rem; line-height:1.45; }
      .failure { position:relative; z-index:1; margin-top:24px; padding:14px 16px; background:rgba(201,86,63,.18); border-left:3px solid #f08d76; border-radius:8px; color:#ffe9e4; }
      section,footer { margin-top:22px; padding:clamp(22px,4vw,38px); background:var(--paper); border:1px solid var(--line); border-radius:20px; }
      .spotlight { margin-top:-1px; border-top-left-radius:0; border-top-right-radius:0; border-top:6px solid var(--teal); }
      .section-heading { display:flex; justify-content:space-between; gap:28px; align-items:end; margin-bottom:24px; }
      .section-heading>p { max-width:430px; color:var(--muted); font-size:.9rem; }
      .ledger { display:grid; grid-template-columns:repeat(3,1fr); gap:1px; overflow:hidden; border:1px solid var(--line); border-radius:16px; background:var(--line); }
      .ledger-card { min-height:220px; padding:24px; background:white; }
      .ledger-card--not-measured { background:#f0f3f1; color:var(--muted); }
      .ledger-card__value { margin:22px 0 8px; color:var(--teal); font-family:Georgia,"Times New Roman",serif; font-size:2.4rem; }
      .ledger-card--not-measured .ledger-card__value { color:var(--muted); font-size:1.4rem; }
      .ledger-card h3 { margin-bottom:8px; }
      .ledger-card p:last-child { color:var(--muted); font-size:.87rem; }
      .ledger-summary { margin-top:18px; padding:14px 16px; background:var(--teal-soft); border-radius:10px; }
      .ledger-summary--empty { background:#eef1ef; color:var(--muted); }
      .dimension-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px; }
      .dimension { padding:20px; border:1px solid var(--line); border-radius:14px; background:white; }
      .dimension h3 { min-height:2.5em; margin-bottom:18px; }
      .dimension dl>div { display:flex; justify-content:space-between; gap:16px; padding-top:10px; border-top:1px solid var(--line); }
      .dimension dl p,.dimension__empty { margin-top:8px; color:var(--muted); font-size:.78rem; }
      .dimension dt { overflow-wrap:anywhere; }
      .dimension dd { color:var(--teal); font-weight:700; }
      .table-wrap { overflow-x:auto; border:1px solid var(--line); border-radius:12px; }
      table { width:100%; border-collapse:collapse; font-size:.8rem; }
      th,td { padding:12px 14px; text-align:left; border-top:1px solid var(--line); white-space:nowrap; }
      thead th { border-top:0; background:#edf3f0; color:var(--muted); font-size:.7rem; letter-spacing:.05em; text-transform:uppercase; }
      tbody th { color:var(--ink); }
      .empty-state { padding:22px; background:#eef1ef; border-radius:12px; color:var(--muted); }
      footer { background:#dfe9e5; }
      .receipts { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:1px; overflow:hidden; border:1px solid #bccbc5; border-radius:12px; background:#bccbc5; }
      .receipts>div { min-width:0; padding:14px 16px; background:var(--paper); }
      .receipts dt { margin-bottom:6px; color:var(--muted); font-size:.72rem; text-transform:uppercase; letter-spacing:.06em; }
      .receipts dd { overflow-wrap:anywhere; font-size:.82rem; }
      @media (max-width:760px) { main{width:min(100% - 20px,1180px);padding-top:10px}.hero{border-radius:16px}.hero__grid,.ledger,.dimension-grid,.receipts{grid-template-columns:1fr}.section-heading{display:block}.section-heading>p{margin-top:12px}.spotlight{border-radius:0 0 16px 16px}.ledger-card{min-height:0} }
      @media (prefers-reduced-motion:reduce) { *,*::before,*::after { scroll-behavior:auto!important; } }
      @media print { body{background:white}main{width:100%;padding:0}.hero,section,footer{box-shadow:none;break-inside:avoid}.hero{border-radius:0} }
    </style>
  </head>
  <body>
    <main>
      <header class="hero">
        <div class="hero__meta"><span class="pill">${escapeHtml(result.meta.benchmark)}</span><span class="pill">${escapeHtml(result.meta.mode)} mode</span><span class="pill">${result.results.tasks.length} task${result.results.tasks.length === 1 ? "" : "s"}</span><span class="pill">${escapeHtml(result.meta.timestamp)}</span></div>
        <div class="hero__grid">
          <div>
            <p class="eyebrow">Remnic memory report card</p>
            <h1>${escapeHtml(system)}</h1>
            <p class="hero__lede">Adapter: ${escapeHtml(result.config.adapterMode)} · Run ${escapeHtml(result.meta.id)} · Git ${escapeHtml(result.meta.gitSha)}</p>
            <p class="status status--${status}">${escapeHtml(statusText.label)}</p>
            <span class="status__detail">${escapeHtml(statusText.detail)}</span>
          </div>
          ${renderScore(result, status)}
        </div>
        ${failure}
      </header>
${renderCorrectionSpotlight(result)}
${renderDimensions(result)}
${renderScenarioDrilldown(result)}
${renderAggregateMetrics(result)}
${renderProvenance(result, provenance)}
    </main>
  </body>
</html>
`;
}
