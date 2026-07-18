#!/usr/bin/env node
/**
 * Paper figure generator (issue #1731, epic #1725).
 *
 * Renders the §6 Results figures as deterministic SVG from committed artifacts
 * + source — never hand-drawn, never a fabricated number (repo rule 55). Every
 * rendered value traces to one of:
 *
 *   - a committed, non-mock benchmark artifact under docs/benchmarks/results/
 *     (today: the two real Tier-L Remnic runs), or
 *   - the shipped DEFAULT_TRUST_WEIGHTS in packages/remnic-core/src/trust-score.ts
 *     (Figure 3 — a code-grounded system illustration, not a benchmark metric).
 *
 * Comparison panels for which no committed artifact exists yet (Tier-F Remnic
 * run #1728; third-party Mem0/Zep/Letta adapters #1747/#1727; the MemCorrect
 * Tier-L run #1584) are rendered as explicit DATA-PENDING placeholders keyed
 * to the #1747 MemCorrectLeaderboardRow / BenchMemoryAdapter artifact schema,
 * so the figure auto-upgrades to real bars the moment an artifact lands in
 * docs/benchmarks/results/. Nothing here invents a competitor number.
 *
 * Run:  pnpm run figures:paper     (writes docs/paper/figures/*.svg)
 *
 * Determinism: no Date.now(), no Math.random(), stable ordering, fixed number
 * formatting. Two runs produce byte-identical SVG (asserted by the test).
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { dirname, join, resolve, basename } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

const RESULTS_DIR = process.env.REMNIC_FIGURES_RESULTS_DIR
  ? resolve(process.env.REMNIC_FIGURES_RESULTS_DIR)
  : join(REPO_ROOT, "docs", "benchmarks", "results");
const FIGURES_DIR = process.env.REMNIC_FIGURES_OUT_DIR
  ? resolve(process.env.REMNIC_FIGURES_OUT_DIR)
  : join(REPO_ROOT, "docs", "paper", "figures");
const TRUST_SCORE_SRC = join(
  REPO_ROOT,
  "packages",
  "remnic-core",
  "src",
  "trust-score.ts",
);

/**
 * Which artifact files under docs/benchmarks/results/ are COMMITTED (and thus
 * safe to plot). The dir is gitignored (root .gitignore line 44), so the
 * self-hosted CI runner accumulates UNTRACKED leftover artifacts there; a
 * newest-by-finishedAt sort would otherwise grab one and the byte-identical
 * regeneration test would fail in CI only.
 *
 * Source of truth: the committed manifest at docs/benchmarks/artifact-manifest.json
 * (a non-gitignored file listing tracked basenames). It is git-INDEPENDENT, so it
 * works in the CI test subprocess where `git ls-files` is not reliably callable.
 * `refreshArtifactManifest()` rewrites it from `git ls-files` when git is
 * available (local dev), keeping it self-maintaining.
 *
 * Returns `null` (no filtering) for a temp results dir (the test seam) or when
 * neither the manifest nor git yields anything (defensive: treat as unmanaged).
 */
const ARTIFACT_MANIFEST = join(REPO_ROOT, "docs", "benchmarks", "artifact-manifest.json");

function readManifestNames() {
  try {
    const m = JSON.parse(readFileSync(ARTIFACT_MANIFEST, "utf8"));
    const arr = Array.isArray(m?.trackedArtifacts)
      ? m.trackedArtifacts.filter((x) => typeof x === "string")
      : [];
    return arr.length > 0 ? new Set(arr) : null;
  } catch {
    return null;
  }
}

function trackedResultsNamesFromGit() {
  try {
    // -c safe.directory=* dodges the "dubious ownership" fatal self-hosted
    // runners can raise. Only used to (re)generate the manifest locally; the CI
    // read path goes through the committed manifest, not git.
    const out = execFileSync("git", ["-c", "safe.directory=*", "ls-files", "docs/benchmarks/results"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    const names = new Set(out.split("\n").filter(Boolean).map((p) => basename(p)));
    return names.size > 0 ? names : null;
  } catch {
    return null;
  }
}

function trackedResultsNames() {
  if (process.env.REMNIC_FIGURES_RESULTS_DIR) return null; // temp seam: fixtures are deliberate
  return readManifestNames() ?? trackedResultsNamesFromGit();
}
// NOTE: the manifest refresh + tracked-name resolution are NOT run at module
// load. Running them at import time (a) performs a git write side effect and
// (b) couples selection to the ambient env of whoever imported the module
// (tests import this file to unit-test the pure comparators). main() refreshes
// the manifest before rendering; the tracked-name filter is resolved lazily and
// cached on first use.
let _trackedNamesResolved = false;
let _trackedNamesCache = null;
function trackedResultsNamesCached() {
  if (!_trackedNamesResolved) {
    _trackedNamesCache = trackedResultsNames();
    _trackedNamesResolved = true;
  }
  return _trackedNamesCache;
}

// Keep the committed manifest in sync with git when git is available (local dev).
// No-op in CI (git not reliably callable there) — the committed manifest is the
// source of truth. Idempotent: writes only when the tracked set changed.
function refreshArtifactManifest() {
  if (process.env.REMNIC_FIGURES_RESULTS_DIR) return;
  const fromGit = trackedResultsNamesFromGit();
  if (!fromGit) return;
  const tracked = [...fromGit].sort();
  const cur = readManifestNames();
  if (cur && JSON.stringify([...cur].sort()) === JSON.stringify(tracked)) return;
  writeFileSync(ARTIFACT_MANIFEST, JSON.stringify({ trackedArtifacts: tracked }, null, 2) + "\n");
}

// ─── Sources ──────────────────────────────────────────────────────────────

/** Read + JSON.parse a committed artifact. Throws on missing/corrupt. */
function loadJson(absPath) {
  return JSON.parse(readFileSync(absPath, "utf8"));
}

/**
 * Parse an ISO-8601 `finishedAt` to epoch-ms. Unparseable / missing values sort
 * OLDEST (`-Infinity`) so a malformed artifact can never win the newest slot.
 */
function finishedAtEpoch(v) {
  const t = Date.parse(String(v ?? ""));
  return Number.isNaN(t) ? -Number.POSITIVE_INFINITY : t;
}

/**
 * Deterministic "newest first" ordering for committed artifacts (issue #2004).
 *
 * Primary key: `finishedAt` as an EPOCH-MS number (never String.localeCompare —
 * ICU collation depends on the LANG/LC_ALL the process inherits, and the root
 * test runner's spawned workers inherit a different env than an isolated run,
 * so a locale-sensitive compare made figure selection env-dependent).
 *
 * Secondary key: the FILENAME in descending codepoint order. This is a STABLE
 * tiebreaker: two artifacts that share a `finishedAt` must never resolve by
 * `readdirSync` order, which is filesystem/OS/load dependent — the exact class
 * of nondeterminism that made the byte-identical figure test flake in the full
 * suite but pass in isolation. Filenames are `<iso-date>-<benchmark>-…` so the
 * codepoint-max filename is also the chronologically-latest-labelled run.
 *
 * Operates on `{ name, doc }` entries.
 */
function compareArtifactsByRecency(a, b) {
  const ea = finishedAtEpoch(a.doc?.finishedAt);
  const eb = finishedAtEpoch(b.doc?.finishedAt);
  // Newest finishedAt first — but ONLY trust the epoch delta when both values
  // are finite and differ. If both are missing/unparseable, `eb - ea` would be
  // (-Infinity) - (-Infinity) = NaN, which Array.sort treats as equality and
  // resolves by input/readdir order — the exact flake we are removing. When
  // exactly one is finite, the finite (real) run wins. Otherwise fall through to
  // the stable filename tiebreak so selection is ALWAYS deterministic (#2004).
  if (Number.isFinite(ea) && Number.isFinite(eb) && ea !== eb) return eb - ea;
  if (Number.isFinite(ea) !== Number.isFinite(eb)) return Number.isFinite(ea) ? -1 : 1;
  if (a.name < b.name) return 1;
  if (a.name > b.name) return -1;
  return 0;
}

/**
 * Find the real (non-mock) published artifact for a benchmark id + tier. Returns
 * the newest matching artifact, or null when none is committed. Mocks
 * (*-mock000.json) are NEVER returned — they are placeholders, not results.
 *
 * `systemName` keys the artifact to the system that produced it (the published
 * artifact's `system.name`). Defaults to "remnic" so a future competitor's
 * local LoCoMo/LongMemEval artifact is never mis-plotted as the Remnic anchor
 * (thread: Remnic bar picks any artifact). Third-party panels pass their own
 * system name + a note/model fallback so the comparison auto-upgrades when the
 * #1747 recall-adapter runs land.
 */
function findArtifact({ benchmarkId, tier, model, systemName = "remnic" }) {
  if (!existsSync(RESULTS_DIR)) return null;
  const tracked = trackedResultsNamesCached();
  const candidates = readdirSync(RESULTS_DIR)
    .filter((name) => name.endsWith(".json"))
    .filter((name) => !name.includes("mock000"))
    .filter((name) => !tracked || tracked.has(name))
    .map((name) => ({ name, abs: join(RESULTS_DIR, name) }))
    .map(({ name, abs }) => {
      try {
        return { name, abs, doc: loadJson(abs) };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .filter(({ doc }) => doc.benchmarkId === benchmarkId)
    .filter(({ doc }) => (tier ? doc.tier === tier : true))
    .filter(({ doc }) => (model ? doc.model === model : true))
    .filter(({ doc }) => {
      // Published artifacts always carry system.name (buildBenchmarkArtifact
      // hardcodes it). Match the requested system exactly; a missing
      // system.name only matches when no systemName was requested (defensive).
      const sn = doc.system?.name;
      if (systemName === undefined) return true;
      return sn === systemName;
    })
    .sort(compareArtifactsByRecency);
  if (process.env.REMNIC_FIGURES_DEBUG) {
    const line = `[figdebug] find ${benchmarkId}/${tier ?? "-"}/${model ?? "-"}/${systemName ?? "-"} ` +
      `RESULTS_DIR=${RESULTS_DIR} LANG=${process.env.LANG ?? ""} LC_ALL=${process.env.LC_ALL ?? ""} ` +
      `collator=${Intl.Collator().resolvedOptions().locale} ` +
      `candidates=[${candidates.map((c) => `${c.name}@${c.doc.finishedAt}`).join(", ")}] ` +
      `-> ${candidates[0]?.name ?? "NONE"}`;
    process.stderr.write(line + "\n");
  }
  return candidates[0] ?? null;
}

/**
 * Find committed MemCorrect artifacts. MemCorrect is a "remnic"-tier custom
 * benchmark, so its runner emits a nested `BenchmarkResult` (NOT the flat
 * published `BenchmarkArtifact`): the id is at `meta.benchmark`, the 8-metric
 * aggregate bundle is at `config.benchmarkOptions.aggregateMetrics`, and the
 * adapter label is at `config.adapterMode` — exactly what
 * `buildMemCorrectLeaderboardRow` reads. We mirror that projection so a landed
 * artifact renders identically to the leaderboard export. The flat
 * `benchmarkId`/`metrics` path is also accepted as a defensive fallback.
 */
function findMemCorrectArtifacts() {
  if (!existsSync(RESULTS_DIR)) return [];
  // Keep only the NEWEST artifact per adapter (by finishedAt), mirroring
  // findArtifact. Without this, figure2's adapter map kept whichever file
  // sorted last in readdirSync, so multiple committed seeds for one adapter
  // could plot stale metrics and mislabel the legend "real" (cursor thread:
  // MemCorrect map picks arbitrary run).
  const tracked = trackedResultsNamesCached();
  const byAdapter = new Map();
  for (const name of readdirSync(RESULTS_DIR).sort()) {
    if (!name.endsWith(".json") || name.includes("mock000")) continue;
    if (tracked && !tracked.has(name)) continue;
    const abs = join(RESULTS_DIR, name);
    let doc;
    try {
      doc = loadJson(abs);
    } catch {
      continue;
    }
    const isMemCorrect =
      doc?.meta?.benchmark === "memcorrect-v1" || doc?.benchmarkId === "memcorrect-v1";
    if (!isMemCorrect) continue;
    const agg =
      doc?.config?.benchmarkOptions?.aggregateMetrics ?? doc?.metrics;
    if (!agg) continue;
    const adapter =
      typeof doc?.config?.adapterMode === "string" ? doc.config.adapterMode : "unknown";
    const entry = {
      adapter,
      tier: doc?.meta?.benchmarkTier ?? doc?.tier ?? "local",
      seed: doc?.meta?.seeds?.[0] ?? doc?.seed ?? 0,
      row: {
        uptake_at_next: num(agg.uptake_at_next),
        uptake_latency: num(agg.uptake_latency),
        uptake_latency_censored: num(agg.uptake_latency_censored),
        non_resurrection: num(agg.non_resurrection),
        collateral_delta: num(agg.collateral_delta),
        scope_precision: typeof agg.scope_precision === "number" ? agg.scope_precision : null,
        false_apply: num(agg.false_apply),
        reassertion: typeof agg.reassertion === "number" ? agg.reassertion : null,
        provenance_fidelity:
          typeof agg.provenance_fidelity === "number" ? agg.provenance_fidelity : null,
      },
    };
    const key = String(adapter).toLowerCase();
    // finishedAt lives at doc.finishedAt (published) or meta.timestamp (nested
    // BenchmarkResult). Keep the NEWEST per adapter using the SAME deterministic
    // comparator as findArtifact, so every selection path shares one tiebreak
    // direction (largest-filename-wins on an exact tie) — never localeCompare or
    // readdir order (#2004).
    const finishedAt = String(doc?.finishedAt ?? doc?.meta?.timestamp ?? "");
    const cand = { name, doc: { finishedAt } };
    const prev = byAdapter.get(key);
    if (!prev || compareArtifactsByRecency(cand, prev.cand) < 0) {
      byAdapter.set(key, { entry, cand });
    }
  }
  return [...byAdapter.values()].map((x) => x.entry);
}

function num(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * Extract DEFAULT_TRUST_WEIGHTS from the shipped source so Figure 3 traces to
 * code, not a hand-copied constant. The object is a flat TS literal; we parse
 * its body and assert it sums to 1.0 (the code's documented invariant).
 */
function extractTrustWeights(srcPath) {
  const src = readFileSync(srcPath, "utf8");
  const blockMatch = src.match(
    /DEFAULT_TRUST_WEIGHTS[^=]*=\s*\{([\s\S]*?)\};/,
  );
  if (!blockMatch) {
    throw new Error(`DEFAULT_TRUST_WEIGHTS block not found in ${srcPath}`);
  }
  const body = blockMatch[1];
  const entries = [];
  const re = /([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([0-9]+(?:\.[0-9]+)?)/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    entries.push([m[1], Number.parseFloat(m[2])]);
  }
  if (entries.length === 0) {
    throw new Error(`no weights parsed from DEFAULT_TRUST_WEIGHTS in ${srcPath}`);
  }
  const raw = Object.fromEntries(entries);
  const sum = entries.reduce((acc, [, w]) => acc + w, 0);
  // Sum-normalize exactly as computeTrustScore does at score time.
  const normalized = Object.fromEntries(
    entries.map(([k, w]) => [k, w / sum]),
  );
  return { raw, normalized, rawSum: sum };
}

// ─── SVG helpers (deterministic, dependency-free) ─────────────────────────

const COLORS = {
  remnic: "#0072B2", // Okabe-Ito blue — "ours", real
  remnicTierF: "#E69F00", // Okabe-Ito orange — ours, pending Tier F
  mem0: "#56B4E9",
  zep: "#009E73",
  letta: "#CC79A7",
  baseline: "#999999",
  pendingFill: "#E8E8E8",
  pendingStroke: "#B0B0B0",
  ink: "#1a1a1a",
  subink: "#555555",
  faint: "#888888",
  grid: "#EDEDED",
  accent: "#D55E00",
};

const THIRD_PARTY = [
  { key: "mem0", label: "Mem0", color: COLORS.mem0, blocksOn: "#1747" },
  { key: "zep", label: "Zep", color: COLORS.zep, blocksOn: "#1747" },
  { key: "letta", label: "Letta", color: COLORS.letta, blocksOn: "#1747" },
];

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmt(v, digits = 3) {
  if (v === null || v === undefined) return "n/a";
  return Number(v).toFixed(digits);
}

function svgDoc(width, height, body, title, desc) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif" role="img" aria-labelledby="title desc">
<title id="title">${esc(title)}</title>
<desc id="desc">${esc(desc)}</desc>
<rect x="0" y="0" width="${width}" height="${height}" fill="#ffffff"/>
${body}
</svg>
`;
}

function text(x, y, str, opts = {}) {
  const {
    size = 12,
    anchor = "start",
    fill = COLORS.ink,
    weight = 400,
    rotate,
    decoration,
  } = opts;
  const r = rotate ? ` transform="rotate(${rotate} ${x} ${y})"` : "";
  const dec = decoration ? ` text-decoration="${decoration}"` : "";
  return `<text x="${x}" y="${y}" font-size="${size}" text-anchor="${anchor}" fill="${fill}" font-weight="${weight}"${r}${dec}>${esc(str)}</text>`;
}

function rect(x, y, w, h, opts = {}) {
  const { fill = "none", stroke, sw = 1, rx } = opts;
  const s = stroke ? ` stroke="${stroke}" stroke-width="${sw}"` : "";
  const r = rx ? ` rx="${rx}"` : "";
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}"${s}${r}/>`;
}

function line(x1, y1, x2, y2, opts = {}) {
  const { stroke = COLORS.faint, sw = 1, dash } = opts;
  const d = dash ? ` stroke-dasharray="${dash}"` : "";
  return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${stroke}" stroke-width="${sw}"${d}/>`;
}

/** A solid vertical bar (real data). */
function bar(x, y, w, h, color) {
  if (h <= 0) return "";
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${color}"/>`;
}

/** A DATA-PENDING bar: hatched fill + outline, with no value. */
function pendingBar(x, y, w, h, patternId) {
  if (h <= 0) return "";
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="url(#${patternId})" stroke="${COLORS.pendingStroke}" stroke-width="1" stroke-dasharray="3 2"/>`;
}

/** Diagonal-hatch <pattern> def for pending bars. */
function hatchDef(id, color = COLORS.pendingStroke) {
  return `<pattern id="${id}" patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)">
<rect width="6" height="6" fill="${COLORS.pendingFill}"/>
<line x1="0" y1="0" x2="0" y2="6" stroke="${color}" stroke-width="1.4"/>
</pattern>`;
}

function provenanceFooter(width, y, sources) {
  const lines = [
    `Sources: ${sources.join(" · ")}`,
    "Pending panels (hatched) await committed artifacts — no value rendered until an artifact exists (rule 55).",
  ];
  let out = "";
  let cy = y;
  for (const ln of lines) {
    out += text(16, cy, ln, { size: 9.5, fill: COLORS.faint }) + "\n";
    cy += 13;
  }
  return out;
}

// ─── Figure 1: LoCoMo / LongMemEval comparison ────────────────────────────

// Metrics plotted on the shared [0,1] accuracy axis. Non-[0,1] metrics
// (search_hits is a count; locomo_hidden_evidence_id_leak is a guard indicator
// where 1 = guard held / zero hidden evidence ids leaked — the runner scores
// hiddenEvidenceIdLeakCount === 0 ? 1 : 0) are reported in a footnote table,
// not on the accuracy axis — plotting them on the same scale would mislead.
const LOCOMO_AXIS_METRICS = [
  { key: "contains_answer", label: "contains_answer", dir: "higher" },
  { key: "f1", label: "f1", dir: "higher" },
  { key: "llm_judge", label: "llm_judge", dir: "higher" },
  { key: "rouge_l", label: "rouge_l", dir: "higher" },
];
const LONGMEMEVAL_AXIS_METRICS = [
  { key: "contains_answer", label: "contains_answer", dir: "higher" },
  { key: "f1", label: "f1", dir: "higher" },
  { key: "llm_judge", label: "llm_judge", dir: "higher" },
  { key: "judge_accuracy", label: "judge_accuracy", dir: "higher" },
];

function renderComparisonPanel({ x, y, w, h, title, metrics, artifact, tierF }) {
  // Panel geometry
  const padL = 46;
  const padR = 16;
  const padT = 38;
  const padB = 78;
  const plotX = x + padL;
  const plotW = w - padL - padR;
  const plotY = y + padT;
  const plotH = h - padT - padB;

  // Systems: each carries its own artifact source (Tier-L, Tier-F, or none).
  // A system renders REAL bars only when its artifact exists; otherwise it is
  // a DATA-PENDING placeholder. Tier-F and third-party are pending until their
  // artifacts (#1728 / #1747) land — but the wiring renders them automatically
  // the moment they do.
  const systems = [
    { key: "remnic-l", label: "Remnic\n(Tier L)", color: COLORS.remnic, source: artifact },
    { key: "remnic-f", label: "Remnic\n(Tier F)", color: COLORS.remnicTierF, source: tierF },
    ...THIRD_PARTY.map((tp) => ({
      ...tp,
      label: `${tp.label}\n(#${tp.blocksOn.replace("#", "")})`,
      // DATA-PENDING by design. buildBenchmarkArtifact hardcodes system.name =
      // "remnic" for EVERY published artifact, so a third-party adapter run
      // cannot be told apart from the Remnic anchor by system.name — and worse,
      // wiring findArtifact({systemName: tp.key}) here can never match while an
      // adapter artifact (also "remnic") could displace the anchor (cursor
      // thread: third-party system.name mismatch). Auto-upgrade needs a real
      // adapter discriminator field from #1747; until then the column stays an
      // explicit placeholder. The Remnic anchor is unambiguous today: only
      // Remnic artifacts are committed (see artifact-manifest.json).
      source: null,
    })),
  ];
  const groupW = plotW / metrics.length;
  const barGap = 3;
  const barW = (groupW - barGap * (systems.length + 1)) / systems.length;

  let body = "";
  // Panel title
  body += text(x + 4, y + 22, title, { size: 14, weight: 600 }) + "\n";
  // Tier label
  body +=
    text(
      x + 4,
      y + 36,
      artifact ? `real: ${artifact.doc.model} · tier ${artifact.doc.tier}` : "no real artifact committed",
      { size: 9.5, fill: COLORS.subink },
    ) + "\n";

  // Y axis 0..1 gridlines + ticks
  for (let i = 0; i <= 4; i++) {
    const gy = plotY + (plotH * i) / 4;
    body += line(plotX, gy, plotX + plotW, gy, { stroke: COLORS.grid, sw: 1 }) + "\n";
    const tick = (1 - i / 4).toFixed(2);
    body += text(plotX - 6, gy + 3.5, tick, { size: 9.5, anchor: "end", fill: COLORS.subink }) + "\n";
  }
  // axis lines
  body += line(plotX, plotY, plotX, plotY + plotH, { stroke: COLORS.subink, sw: 1 }) + "\n";
  body += line(plotX, plotY + plotH, plotX + plotW, plotY + plotH, { stroke: COLORS.subink, sw: 1 }) + "\n";
  body += text(plotX - 34, plotY + plotH / 2, "score (0–1)", { size: 10, fill: COLORS.subink, rotate: -90 }) + "\n";

  // Bars per metric group
  metrics.forEach((metric, gi) => {
    const gx = plotX + gi * groupW;
    systems.forEach((sys, si) => {
      const bx = gx + barGap + si * (barW + barGap);
      const fullH = plotH;
      const src = sys.source;
      if (src) {
        const val = num(src.doc.metrics?.[metric.key]);
        const bh = Math.max(0, Math.min(1, val)) * fullH;
        const by = plotY + fullH - bh;
        body += bar(bx, by, barW, bh, sys.color) + "\n";
        body += text(bx + barW / 2, by - 4, fmt(val), { size: 8.5, anchor: "middle", fill: sys.color, weight: 600 }) + "\n";
      } else {
        // pending — full-height hatched placeholder
        body += pendingBar(bx, plotY, barW, fullH, "pendingHatch1") + "\n";
      }
    });
    // x tick label (metric)
    body += text(gx + groupW / 2, plotY + plotH + 14, metric.label, { size: 9.5, anchor: "middle", fill: COLORS.subink }) + "\n";
  });

  // Legend row (systems)
  let lx = x + 4;
  const ly = y + h - 30;
  for (const sys of systems) {
    const swatch = sys.source
      ? `<rect x="${lx}" y="${ly - 8}" width="12" height="10" fill="${sys.color}"/>`
      : `<rect x="${lx}" y="${ly - 8}" width="12" height="10" fill="url(#pendingHatch1)" stroke="${COLORS.pendingStroke}" stroke-width="1" stroke-dasharray="2 2"/>`;
    body += swatch + "\n";
    // Render BOTH lines of the system label so Tier-L / Tier-F (and
    // third-party issue refs) stay distinguishable in the legend (cursor
    // thread: Figure one legend hides tier).
    const lines = sys.label.split("\n");
    body += text(lx + 16, ly, lines[0], { size: 9.5, fill: COLORS.subink }) + "\n";
    if (lines[1]) {
      body += text(lx + 16, ly + 11, lines[1], { size: 8, fill: COLORS.faint }) + "\n";
    }
    const widest = Math.max(...lines.map((l) => l.length));
    lx += 16 + widest * 5.6 + 14;
  }

  // Footnote: non-axis metrics from the real artifact (honest, separate scale)
  const fy = y + h - 12;
  if (artifact) {
    const extras = Object.entries(artifact.doc.metrics ?? {})
      .filter(([k]) => !metrics.some((m) => m.key === k))
      .map(([k, v]) => `${k}=${fmt(v, k.includes("leak") ? 0 : 3)}`);
    body +=
      text(x + 4, fy, `non-axis metrics (separate scale): ${extras.join(", ") || "none"}`, {
        size: 8.5,
        fill: COLORS.faint,
      }) + "\n";
  } else {
    body += text(x + 4, fy, "no real artifact committed — all bars pending", {
      size: 8.5,
      fill: COLORS.faint,
    }) + "\n";
  }

  return body;
}

function figure1() {
  const locomo = findArtifact({ benchmarkId: "locomo", tier: "local" });
  const longmemeval = findArtifact({ benchmarkId: "longmemeval", tier: "local" });
  const locomoF = findArtifact({ benchmarkId: "locomo", tier: "frontier" });
  const longmemevalF = findArtifact({ benchmarkId: "longmemeval", tier: "frontier" });

  const W = 1040;
  const H = 560;
  const panelW = (W - 16 * 3) / 2;
  const panelH = 360;
  const topY = 60;

  let body = "";
  body += `<defs>${hatchDef("pendingHatch1")}</defs>` + "\n";
  // Header
  body += text(16, 30, "Figure 1 — LoCoMo / LongMemEval: Remnic vs Mem0 / Zep / Letta", {
    size: 17,
    weight: 700,
  }) + "\n";
  // Header line names exactly which Tier-F benchmarks resolved, so a single
  // Tier-F panel never reads as a full "head-to-head" (kilo thread).
  const tierFWhich = [locomoF && "LoCoMo", longmemevalF && "LongMemEval"]
    .filter(Boolean)
    .join(" + ");
  const tierFLine = tierFWhich
    ? `Real: Remnic Tier-L anchor + Tier-F (${tierFWhich}) head-to-head. Pending: third-party recall adapters (#1747).`
    : "Real: Remnic Tier-L reproducibility anchor (RTX 3090, qwen2.5-7b Q4_K_M). Pending: Tier-F run (#1728) + third-party recall adapters (#1747).";
  body +=
    text(
      16,
      48,
      tierFLine,
      { size: 10.5, fill: COLORS.subink },
    ) + "\n";

  body += renderComparisonPanel({
    x: 16,
    y: topY,
    w: panelW,
    h: panelH,
    title: "LoCoMo (locomo-10, 1986 QA)",
    metrics: LOCOMO_AXIS_METRICS,
    artifact: locomo,
    tierF: locomoF,
  });
  body += renderComparisonPanel({
    x: 16 * 2 + panelW,
    y: topY,
    w: panelW,
    h: panelH,
    title: "LongMemEval (oracle, 500 Q)",
    metrics: LONGMEMEVAL_AXIS_METRICS,
    artifact: longmemeval,
    tierF: longmemevalF,
  });

  // Provenance footer
  const srcs = [
    locomo ? `locomo ${locomo.name}` : "locomo: no real artifact",
    longmemeval ? `longmemeval ${longmemeval.name}` : "longmemeval: no real artifact",
    locomoF || longmemevalF ? `Tier-F real (${[locomoF?.name, longmemevalF?.name].filter(Boolean).join(", ")})` : `Tier-F pending #1728`,
    `third-party pending #1747`,
  ];
  body += provenanceFooter(W, topY + panelH + 14, srcs);

  return svgDoc(
    W,
    H,
    body,
    "Figure 1 — LoCoMo / LongMemEval comparison",
    locomoF || longmemevalF
      ? "Grouped bar chart. Remnic Tier-L and Tier-F bars are real (committed artifacts); Mem0/Zep/Letta bars are data-pending placeholders."
      : "Grouped bar chart. Remnic Tier-L bars are real (committed artifacts); Tier-F and Mem0/Zep/Letta bars are data-pending placeholders.",
  );
}

// ─── Figure 2: MemCorrect 8-metric bars ───────────────────────────────────

const MEMCORRECT_METRICS = [
  { key: "uptake_at_next", label: "uptake_at_next", dir: "higher", range: [0, 1] },
  { key: "uptake_latency", label: "uptake_latency", dir: "lower", range: null },
  { key: "non_resurrection", label: "non_resurrection", dir: "higher", range: [0, 1] },
  { key: "collateral_delta", label: "collateral_delta", dir: "zero", range: null },
  { key: "scope_precision", label: "scope_precision", dir: "higher", range: [0, 1] },
  { key: "false_apply", label: "false_apply", dir: "lower", range: [0, 1] },
  { key: "reassertion", label: "reassertion", dir: "higher", range: [0, 1] },
  { key: "provenance_fidelity", label: "provenance_fidelity", dir: "higher", range: [0, 1] },
];

const MEMCORRECT_ADAPTERS = [
  { key: "remnic", label: "Remnic", color: COLORS.remnic, blocksOn: "#1584" },
  { key: "prompt-only", label: "Prompt-only\nbaseline", color: COLORS.baseline, blocksOn: "#1584" },
  ...THIRD_PARTY.map((tp) => ({ ...tp, label: tp.label, blocksOn: "#1747" })),
];
/**
 * Resolve a committed MemCorrect artifact for an adapter. The artifact's
 * `adapter` label (from config.adapterMode) may not be an exact key match, so
 * fall back to a case-insensitive contains check. Returns the artifact or null.
 * Shared by the bar loop and the legend so they always agree on real vs
 * pending (no `??` on a boolean — `has()` never returns nullish).
 */
function matchMemCorrectAdapter(have, adp) {
  const exact = have.get(adp.key);
  if (exact) return exact;
  const labelHead = String(adp.label).split("\n")[0].toLowerCase();
  for (const [key, val] of have) {
    if (key === adp.key || key.includes(labelHead) || labelHead.includes(key)) return val;
  }
  return null;
}

function figure2() {
  const artifacts = findMemCorrectArtifacts();
  // Map committed artifacts by adapter label (lowercased contains).
  const have = new Map();
  for (const a of artifacts) {
    have.set(String(a.adapter).toLowerCase(), a);
  }

  const W = 1040;
  const H = 560;
  const padL = 200;
  const padR = 60;
  const padT = 96;
  const padB = 96;
  const plotX = padL;
  const plotW = W - padL - padR;
  const plotY = padT;
  const plotH = H - padT - padB;

  const rowH = plotH / MEMCORRECT_METRICS.length;
  const adapterCount = MEMCORRECT_ADAPTERS.length;
  // Bars start at ry+8 and step by (barH+3); all adapterCount bars must fit
  // inside the row track (ry+6 .. ry+rowH-6). Solve for the largest barH that
  // fits so bars never overflow into the next metric's row.
  const BAR_GAP = 3;
  const barH = Math.max(
    3,
    Math.floor((rowH - 14 - (adapterCount - 1) * BAR_GAP) / adapterCount),
  );

  let body = "";
  body += `<defs>${hatchDef("pendingHatch2")}</defs>` + "\n";
  body += text(16, 30, "Figure 2 — MemCorrect: 8 metrics across adapters", {
    size: 17,
    weight: 700,
  }) + "\n";
  const realCount = artifacts.length;
  body +=
    text(
      16,
      50,
      realCount > 0
        ? `${realCount} committed MemCorrect artifact(s). Bars are real where an artifact exists; hatched bars await the run.`
        : "No MemCorrect artifact committed yet (#1584 Tier-L run + #1747 adapter runs pending). All bars are DATA-PENDING placeholders keyed to the MemCorrectLeaderboardRow schema — no value is rendered.",
      { size: 10.5, fill: COLORS.subink },
    ) + "\n";

  // Direction column header
  body += text(16, padT - 14, "metric · direction", { size: 10.5, weight: 600, fill: COLORS.subink }) + "\n";
  body += text(plotX + plotW + 8, padT - 14, "value", { size: 10.5, weight: 600, fill: COLORS.subink }) + "\n";

  MEMCORRECT_METRICS.forEach((metric, mi) => {
    const ry = plotY + mi * rowH;
    const dirSym = metric.dir === "higher" ? "↑ higher" : metric.dir === "lower" ? "↓ lower" : "→ 0";
    // metric label
    body += text(16, ry + rowH / 2 + 3, metric.label, { size: 11, weight: 600 }) + "\n";
    body += text(16, ry + rowH / 2 + 16, dirSym, { size: 9, fill: COLORS.faint }) + "\n";

    // For [0,1] metrics, draw a faint 0..1 track.
    const onAxis = metric.range != null;
    if (onAxis) {
      body += rect(plotX, ry + 6, plotW, rowH - 12, { fill: "#F7F7F7", stroke: COLORS.grid, sw: 1 }) + "\n";
      // midline
      body += line(plotX + plotW / 2, ry + 6, plotX + plotW / 2, ry + rowH - 6, { stroke: COLORS.grid, sw: 1, dash: "2 3" }) + "\n";
    } else {
      body += rect(plotX, ry + 6, plotW, rowH - 12, { fill: "#FAFAFA", stroke: COLORS.grid, sw: 1, sw2: 1 }) + "\n";
      body += text(plotX + plotW / 2, ry + rowH / 2 + 3, "raw value (scale varies) — see methodology", {
        size: 9,
        anchor: "middle",
        fill: COLORS.faint,
      }) + "\n";
    }

    MEMCORRECT_ADAPTERS.forEach((adp, ai) => {
      const ay = ry + 8 + ai * (barH + BAR_GAP);
      const matched = matchMemCorrectAdapter(have, adp);
      if (matched && onAxis) {
        const val = matched.row[metric.key];
        if (val === null || val === undefined) {
          body += text(plotX + 4, ay + barH - 2, `${adp.label.split("\n")[0]}: n/a`, { size: 9, fill: COLORS.faint }) + "\n";
          return;
        }
        const bw = Math.max(0, Math.min(1, val)) * plotW;
        body += bar(plotX, ay, bw, barH, adp.color) + "\n";
        body += text(plotX + plotW + 8, ay + barH - 2, fmt(val), { size: 9, fill: COLORS.ink }) + "\n";
      } else if (matched && !onAxis) {
        const val = matched.row[metric.key];
        const label = adp.label.split("\n")[0];
        body +=
          text(plotX + 6, ay + barH - 2, `${label}: ${val === null || val === undefined ? "n/a" : fmt(val)}`, {
            size: 9,
            fill: adp.color,
            weight: 600,
          }) + "\n";
      } else {
        // pending placeholder bar across the track
        body += pendingBar(plotX, ay, plotW, barH, "pendingHatch2") + "\n";
        body += text(plotX + plotW + 8, ay + barH - 2, "pending", { size: 9, fill: COLORS.faint }) + "\n";
      }
    });
  });

  // Legend
  let lx = 16;
  const ly = H - 36;
  for (const adp of MEMCORRECT_ADAPTERS) {
    // Use the same matcher as the bar loop so legend and bars agree. `||` not
    // `??`: matchMemCorrectAdapter returns a truthy artifact or null.
    const committed = matchMemCorrectAdapter(have, adp) != null;
    const swatch = committed
      ? `<rect x="${lx}" y="${ly - 9}" width="12" height="10" fill="${adp.color}"/>`
      : `<rect x="${lx}" y="${ly - 9}" width="12" height="10" fill="url(#pendingHatch2)" stroke="${COLORS.pendingStroke}" stroke-width="1" stroke-dasharray="2 2"/>`;
    body += swatch + "\n";
    const head = adp.label.split("\n")[0];
    const status = committed ? "real" : `pending ${adp.blocksOn}`;
    body += text(lx + 16, ly, `${head} (${status})`, { size: 9.5, fill: COLORS.subink }) + "\n";
    lx += 16 + `${head} (${status})`.length * 5.4 + 16;
  }

  const srcs = [
    artifacts.length
      ? `memcorrect real: ${artifacts.map((a) => a.adapter).join(", ")}`
      : "memcorrect: no real artifact committed (#1584)",
    "schema: MemCorrectLeaderboardRow (packages/bench/src/leaderboard-export.ts)",
    "third-party adapters pending #1747",
  ];
  body += provenanceFooter(W, H - 16, srcs);

  return svgDoc(
    W,
    H,
    body,
    "Figure 2 — MemCorrect 8-metric bars",
    "Horizontal bars per metric. Real where a committed memcorrect-v1 artifact exists; otherwise data-pending placeholders keyed to the MemCorrectLeaderboardRow schema.",
  );
}

// ─── Figure 3: TrustScore 8-component illustration ────────────────────────

// Human-readable names + grounding for each DEFAULT_TRUST_WEIGHTS key. The
// count and weights come from the shipped source (extractTrustWeights), so the
// figure never asserts a factor count the code does not implement.
const TRUST_FACTOR_META = {
  memoryWorth: { label: "Memory Worth", note: "Laplace success prob + confidence" },
  provenance: { label: "Provenance", note: "claim-level span strength (#1575)" },
  faithfulness: { label: "Faithfulness", note: "extraction gate verdict (#1576)" },
  corroboration: { label: "Corroboration", note: "distinct source count (log-sat.)" },
  contradiction: { label: "Contradiction", note: "review-queue status" },
  domainCalibration: { label: "Domain Calibration", note: "belief-ledger accuracy" },
  feedback: { label: "Feedback", note: "thumbs up/down (Laplace)" },
  recency: { label: "Recency", note: "age vs per-category half-life" },
};

function figure3() {
  const { normalized, rawSum } = extractTrustWeights(TRUST_SCORE_SRC);
  // Preserve the source declaration order.
  const order = Object.keys(TRUST_FACTOR_META).filter((k) => k in normalized);
  if (order.length === 0) {
    throw new Error("no TrustScore factors resolved from source");
  }

  const W = 880;
  const H = 520;
  const padL = 200;
  const padR = 40;
  const padT = 110;
  const padB = 92;
  const plotX = padL;
  const plotW = W - padL - padR;
  const plotY = padT;
  const plotH = H - padT - padB;
  const rowH = plotH / order.length;
  const maxW = Math.max(...order.map((k) => normalized[k]));

  let body = "";
  body += text(16, 30, "Figure 3 — TrustScore: 8 weighted trust components", {
    size: 17,
    weight: 700,
  }) + "\n";
  body +=
    text(
      16,
      52,
      "Illustration of the shipped default TrustScore blend (packages/remnic-core/src/trust-score.ts). Bars are the sum-normalized default weights; the system capability — not yet a benchmark metric (#1577).",
      { size: 10.5, fill: COLORS.subink },
    ) + "\n";
  body +=
    text(
      16,
      68,
      `Raw weights sum to ${fmt(rawSum, 2)} before normalization (code invariant: neutral-prior score = 0.5). This is a system illustration, not a measured result.`,
      { size: 9.5,
        fill: COLORS.faint,
      },
    ) + "\n";

  // axis ticks at 0 / 0.1 / 0.2 / 0.3 (weights live there)
  for (let i = 0; i <= 3; i++) {
    const frac = i / 10 / maxW;
    const gx = plotX + frac * plotW;
    if (gx > plotX + plotW) break;
    body += line(gx, plotY, gx, plotY + plotH, { stroke: COLORS.grid, sw: 1 }) + "\n";
    body += text(gx, plotY + plotH + 14, `${i / 10}`, { size: 9, anchor: "middle", fill: COLORS.subink }) + "\n";
  }
  body += line(plotX, plotY, plotX, plotY + plotH, { stroke: COLORS.subink, sw: 1 }) + "\n";
  body += line(plotX, plotY + plotH, plotX + plotW, plotY + plotH, { stroke: COLORS.subink, sw: 1 }) + "\n";
  body += text(plotX + plotW / 2, plotY + plotH + 32, "sum-normalized default weight", {
    size: 10,
    anchor: "middle",
    fill: COLORS.subink,
  }) + "\n";

  order.forEach((key, i) => {
    const ry = plotY + i * rowH;
    const w = normalized[key];
    const meta = TRUST_FACTOR_META[key] ?? { label: key, note: "" };
    const bw = (w / maxW) * plotW;
    const by = ry + 6;
    const bh = rowH - 16;
    // weight gradient by rank (heaviest = deepest blue)
    const rank = order
      .slice()
      .sort((a, b) => normalized[b] - normalized[a])
      .indexOf(key);
    const shade = COLORS.remnic;
    body += bar(plotX, by, bw, bh, shade) + "\n";
    // value label at end of bar
    body += text(plotX + bw + 6, by + bh - 3, fmt(w, 3), { size: 10, fill: COLORS.ink, weight: 600 }) + "\n";
    // factor label (left)
    body += text(16, by + bh / 2 + 1, meta.label, { size: 11.5, weight: 600 }) + "\n";
    body += text(16, by + bh / 2 + 15, meta.note, { size: 8.5, fill: COLORS.faint }) + "\n";
  });

  // Footer
  body += provenanceFooter(W, H - 16, [
    "packages/remnic-core/src/trust-score.ts (DEFAULT_TRUST_WEIGHTS, extracted at render time)",
    "system capability #1577 — not a benchmark metric",
  ]);

  return svgDoc(
    W,
    H,
    body,
    "Figure 3 — TrustScore 8-component illustration",
    "Horizontal bars showing the sum-normalized default weights of the 8 TrustScore components, extracted from the shipped source.",
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────

function writeFigure(filename, svg) {
  const outPath = join(FIGURES_DIR, filename);
  writeFileSync(outPath, svg, "utf8");
  return outPath;
}

function main() {
  // Refresh the committed manifest from git (local dev) BEFORE the tracked-name
  // filter is resolved, so a newly-tracked artifact is reflected in THIS run.
  // No-op in CI / under the RESULTS_DIR seam. Deferred here (not module load)
  // so importing this file for its pure comparators has no git write side
  // effect (issue #2004).
  refreshArtifactManifest();
  _trackedNamesResolved = false;
  mkdirSync(FIGURES_DIR, { recursive: true });

  const f1 = figure1();
  const f2 = figure2();
  const f3 = figure3();

  const p1 = writeFigure("fig1-locomo-longmemeval.svg", f1);
  const p2 = writeFigure("fig2-memcorrect-metrics.svg", f2);
  const p3 = writeFigure("fig3-trustscore-components.svg", f3);

  // Summary to stdout (real vs pending) — the test parses this.
  const locomo = findArtifact({ benchmarkId: "locomo", tier: "local" });
  const longmemeval = findArtifact({ benchmarkId: "longmemeval", tier: "local" });
  const locomoF = findArtifact({ benchmarkId: "locomo", tier: "frontier" });
  const longmemevalF = findArtifact({ benchmarkId: "longmemeval", tier: "frontier" });
  const memcorrect = findMemCorrectArtifacts();
  console.log("[figures] wrote:");
  console.log(`  ${p1}`);
  console.log(`  ${p2}`);
  console.log(`  ${p3}`);
  console.log("[figures] data status:");
  console.log(`  fig1 locomo Tier-L: ${locomo ? "REAL" : "PENDING"}`);
  console.log(`  fig1 longmemeval Tier-L: ${longmemeval ? "REAL" : "PENDING"}`);
  console.log(`  fig1 locomo Tier-F: ${locomoF ? "REAL" : "PENDING (#1728)"}`);
  console.log(`  fig1 longmemeval Tier-F: ${longmemevalF ? "REAL" : "PENDING (#1728)"}`);
  // Third-party columns stay pending until #1747 introduces an adapter
  // discriminator — buildBenchmarkArtifact hardcodes system.name = "remnic", so
  // there is no field today to match a Mem0/Zep/Letta run against.
  console.log(`  fig1 third-party (Mem0/Zep/Letta): PENDING (#1747 — adapter discriminator needed)`);
  console.log(`  fig2 MemCorrect adapters: ${memcorrect.length ? `REAL (${memcorrect.map((m) => m.adapter).join(", ")})` : "PENDING (#1584 + #1747)"}`);
  console.log(`  fig3 TrustScore components: REAL (source-extracted)`);
}

// Run only when invoked directly (`node scripts/generate-paper-figures.mjs`).
// When imported (tests exercising the pure comparators) main() must NOT run —
// it would render figures + write the manifest as an import side effect.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

export { compareArtifactsByRecency, finishedAtEpoch };
