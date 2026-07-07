// Paper figure generator tests (issue #1731, epic #1725).
//
// These tests are the acceptance gate for the figure pipeline. They prove:
//   1. the committed SVGs exist and were produced by the generator,
//   2. every rendered value in a REAL panel traces to a committed artifact or
//      the shipped source (no fabricated number — rule 55),
//   3. panels without a committed artifact are explicitly DATA-PENDING
//      (hatched + labelled), never a silent zero or invented value,
//   4. generation is deterministic (byte-identical re-run), and
//   5. the pipeline auto-upgrades: drop a memcorrect artifact in the results
//      dir and Figure 2 renders real bars instead of placeholders.
//
// Run: pnpm exec tsx --test tests/paper-figures.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  readFileSync,
  existsSync,
  writeFileSync,
  mkdtempSync,
  rmSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const GEN = join(REPO_ROOT, "scripts", "generate-paper-figures.mjs");
const RESULTS_DIR = join(REPO_ROOT, "docs", "benchmarks", "results");
const FIGURES_DIR = join(REPO_ROOT, "docs", "paper", "figures");
const TRUST_SCORE_SRC = join(
  REPO_ROOT,
  "packages",
  "remnic-core",
  "src",
  "trust-score.ts",
);

function runGenerator(env = {}) {
  return spawnSync(process.execPath, [GEN], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

function readFigure(name) {
  return readFileSync(join(FIGURES_DIR, name), "utf8");
}

function loadJson(p) {
  return JSON.parse(readFileSync(p, "utf8"));
}

// ─── Helpers: find the real (non-mock) committed artifacts ────────────────

// Basenames git-tracked under the committed results dir. The self-hosted CI
// runner accumulates UNTRACKED artifacts there (the dir is gitignored); both
// the generator and these assertions must ignore them or the byte-identical
// regeneration test fails in CI only. `null` means git unavailable / nothing
// tracked → no filtering (defensive).
function trackedResultsNames() {
  try {
    const res = spawnSync("git", ["ls-files", "docs/benchmarks/results"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    if (res.status !== 0) return null;
    const names = new Set(
      res.stdout.split("\n").filter(Boolean).map((line) => line.split("/").pop()),
    );
    return names.size > 0 ? names : null;
  } catch {
    return null;
  }
}
const TRACKED_RESULTS_NAMES = trackedResultsNames();
function isTrackedResult(name) {
  return !TRACKED_RESULTS_NAMES || TRACKED_RESULTS_NAMES.has(name);
}

function findRealArtifact(benchmarkId, tier) {
  for (const name of readdirSync(RESULTS_DIR).sort()) {
    if (!name.endsWith(".json") || name.includes("mock000")) continue;
    if (!isTrackedResult(name)) continue;
    const doc = loadJson(join(RESULTS_DIR, name));
    if (doc.benchmarkId === benchmarkId && (!tier || doc.tier === tier)) {
      return { name, doc };
    }
  }
  return null;
}

// ─── 1. Committed SVGs exist + are the generator's output ─────────────────

test("all three figure SVGs are committed and well-formed", () => {
  for (const f of [
    "fig1-locomo-longmemeval.svg",
    "fig2-memcorrect-metrics.svg",
    "fig3-trustscore-components.svg",
  ]) {
    const p = join(FIGURES_DIR, f);
    assert.ok(existsSync(p), `${f} must be committed under docs/paper/figures/`);
    const svg = readFileSync(p, "utf8");
    assert.match(svg, /<svg[\s\S]*<\/svg>/, `${f} must be a single root <svg>`);
    assert.equal((svg.match(/<svg/g) || []).length, 1, `${f} has one <svg> root`);
  }
});

test("generator runs clean and exits 0 (into a temp dir — never mutates committed figures)", () => {
  // node:test runs subtests concurrently; writing to the committed figures
  // here would race the content tests below that read them. Always render
  // into an isolated temp dir.
  const tmp = mkdtempSync(join(tmpdir(), "fig-run-"));
  try {
    const res = runGenerator({ REMNIC_FIGURES_OUT_DIR: tmp });
    assert.equal(res.status, 0, `generator failed:\n${res.stderr}`);
    assert.match(res.stdout, /\[figures\] wrote:/);
    for (const f of [
      "fig1-locomo-longmemeval.svg",
      "fig2-memcorrect-metrics.svg",
      "fig3-trustscore-components.svg",
    ]) {
      assert.ok(existsSync(join(tmp, f)), `${f} written to temp out dir`);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("committed figures are in sync with the generator (regeneration is byte-identical)", () => {
  // Catches stale committed figures: if someone edits an artifact or the
  // generator and forgets to re-run `pnpm run figures:paper`, this fails.
  const tmp = mkdtempSync(join(tmpdir(), "fig-sync-"));
  try {
    runGenerator({ REMNIC_FIGURES_OUT_DIR: tmp });
    for (const f of [
      "fig1-locomo-longmemeval.svg",
      "fig2-memcorrect-metrics.svg",
      "fig3-trustscore-components.svg",
    ]) {
      const fresh = readFileSync(join(tmp, f), "utf8");
      const committed = readFigure(f);
      assert.equal(fresh, committed, `committed ${f} is stale — run \`pnpm run figures:paper\``);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ─── 2. Real values trace to committed artifacts / source ─────────────────

test("Figure 1: Remnic Tier-L bars trace to the committed locomo/longmemeval artifacts", () => {
  const svg = readFigure("fig1-locomo-longmemeval.svg");
  const locomo = findRealArtifact("locomo", "local");
  const longmemeval = findRealArtifact("longmemeval", "local");
  assert.ok(locomo, "a real (non-mock) locomo Tier-L artifact must be committed");
  assert.ok(longmemeval, "a real (non-mock) longmemeval Tier-L artifact must be committed");

  // Every plotted [0,1] metric value must appear verbatim (3dp) in the SVG.
  for (const key of ["contains_answer", "f1", "llm_judge", "rouge_l"]) {
    const v = locomo.doc.metrics[key];
    assert.ok(typeof v === "number", `locomo metric ${key} present in artifact`);
    assert.ok(
      svg.includes(v.toFixed(3)),
      `fig1 must render locomo ${key}=${v.toFixed(3)} (traced to ${locomo.name})`,
    );
  }
  for (const key of ["contains_answer", "f1", "llm_judge", "judge_accuracy"]) {
    const v = longmemeval.doc.metrics[key];
    assert.ok(typeof v === "number", `longmemeval metric ${key} present in artifact`);
    assert.ok(
      svg.includes(v.toFixed(3)),
      `fig1 must render longmemeval ${key}=${v.toFixed(3)} (traced to ${longmemeval.name})`,
    );
  }
});

test("Figure 1: Tier-F + third-party panels are DATA-PENDING (no fabricated competitor numbers)", () => {
  const svg = readFigure("fig1-locomo-longmemeval.svg");
  // Pending bars use the hatch pattern fill.
  assert.match(svg, /url\(#pendingHatch1\)/, "pending panels are hatched");
  assert.match(svg, /pending #1728/, "Tier-F pending cites the blocking issue");
  assert.match(svg, /third-party pending #1747/, "third-party pending cites the adapter issue");
  // No Tier-F artifact committed today → the figure must NOT claim a Tier-F value.
  const locomoF = findRealArtifact("locomo", "frontier");
  const longmemevalF = findRealArtifact("longmemeval", "frontier");
  if (!locomoF && !longmemevalF) {
    assert.doesNotMatch(
      svg,
      /Opus|frontier.*real/i,
      "no Tier-F value may be rendered while no Tier-F artifact is committed",
    );
  }
});

test("Figure 1: mocks are never cited as results", () => {
  const svg = readFigure("fig1-locomo-longmemeval.svg");
  assert.doesNotMatch(svg, /mock000/, "mock artifacts must never be cited as results");
});

test("Figure 3: TrustScore component weights trace to the shipped source", () => {
  const svg = readFigure("fig3-trustscore-components.svg");
  const src = readFileSync(TRUST_SCORE_SRC, "utf8");
  const block = src.match(/DEFAULT_TRUST_WEIGHTS[^=]*=\s*\{([\s\S]*?)\};/);
  assert.ok(block, "DEFAULT_TRUST_WEIGHTS present in source");
  // Extract each key:weight and assert the normalized weight renders.
  const entries = [];
  const re = /([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([0-9]+(?:\.[0-9]+)?)/g;
  let m;
  while ((m = re.exec(block[1])) !== null) entries.push([m[1], Number(m[2])]);
  const sum = entries.reduce((a, [, w]) => a + w, 0);
  const count = entries.length;
  assert.equal(count, 8, `TrustScore has exactly 8 weighted components (found ${count})`);
  for (const [k, w] of entries) {
    assert.ok(
      svg.includes((w / sum).toFixed(3)),
      `fig3 must render normalized weight for ${k} = ${(w / sum).toFixed(3)}`,
    );
  }
  // All 8 factor labels appear.
  for (const label of [
    "Memory Worth",
    "Provenance",
    "Faithfulness",
    "Corroboration",
    "Contradiction",
    "Domain Calibration",
    "Feedback",
    "Recency",
  ]) {
    assert.ok(svg.includes(label), `fig3 must label factor "${label}"`);
  }
  assert.match(svg, /not.*benchmark metric|#1577/i, "fig3 must flag TrustScore as a system capability, not a metric");
});

// ─── 3. MemCorrect figure: all 8 metrics, all-pending until an artifact lands

test("Figure 2: renders all 8 MemCorrect metrics with direction + adapter placeholders", () => {
  const svg = readFigure("fig2-memcorrect-metrics.svg");
  for (const metric of [
    "uptake_at_next",
    "uptake_latency",
    "non_resurrection",
    "collateral_delta",
    "scope_precision",
    "false_apply",
    "reassertion",
    "provenance_fidelity",
  ]) {
    assert.ok(svg.includes(metric), `fig2 must include metric ${metric}`);
  }
  // Direction indicators per the methodology doc.
  assert.match(svg, /higher/, "higher-is-better metrics flagged");
  assert.match(svg, /lower/, "lower-is-better metrics flagged");
  assert.match(svg, /→ 0/, "collateral_delta zero-target flagged");
});

test("Figure 2: with no committed memcorrect artifact, every adapter bar is DATA-PENDING", () => {
  // Only git-tracked artifacts count (mirror the generator) and accept both
  // the flat published shape (benchmarkId) and the nested BenchmarkResult
  // shape (meta.benchmark) the MemCorrect runner emits.
  const real = readdirSync(RESULTS_DIR).some((n) => {
    if (!n.endsWith(".json") || n.includes("mock000")) return false;
    if (!isTrackedResult(n)) return false;
    try {
      const doc = loadJson(join(RESULTS_DIR, n));
      return doc.benchmarkId === "memcorrect-v1" || doc?.meta?.benchmark === "memcorrect-v1";
    } catch {
      return false;
    }
  });
  const svg = readFigure("fig2-memcorrect-metrics.svg");
  assert.match(svg, /url\(#pendingHatch2\)/, "pending adapter bars are hatched");
  if (!real) {
    assert.match(
      svg,
      /No MemCorrect artifact committed yet/,
      "fig2 must state no artifact is committed",
    );
    assert.match(svg, /MemCorrectLeaderboardRow/, "pending bars key to the public schema");
  }
});

// ─── 4. Determinism ───────────────────────────────────────────────────────

test("generation is byte-identical across runs (deterministic)", () => {
  const out1 = mkdtempSync(join(tmpdir(), "fig-run1-"));
  const out2 = mkdtempSync(join(tmpdir(), "fig-run2-"));
  try {
    runGenerator({ REMNIC_FIGURES_OUT_DIR: out1 });
    runGenerator({ REMNIC_FIGURES_OUT_DIR: out2 });
    for (const f of [
      "fig1-locomo-longmemeval.svg",
      "fig2-memcorrect-metrics.svg",
      "fig3-trustscore-components.svg",
    ]) {
      const a = readFileSync(join(out1, f), "utf8");
      const b = readFileSync(join(out2, f), "utf8");
      assert.equal(a, b, `${f} must be byte-identical across runs`);
    }
  } finally {
    rmSync(out1, { recursive: true, force: true });
    rmSync(out2, { recursive: true, force: true });
  }
});

// ─── 5. Auto-upgrade: a landed memcorrect artifact renders real bars ──────

test("Figure 2 auto-upgrades: a committed memcorrect artifact yields real bars", () => {
  // Isolated results dir: copy the real Tier-L artifacts + add a synthetic
  // memcorrect-v1 artifact shaped exactly like the runner's output.
  const tmpResults = mkdtempSync(join(tmpdir(), "fig-results-"));
  const tmpOut = mkdtempSync(join(tmpdir(), "fig-out-"));
  try {
    // Carry the real locomo/longmemeval artifacts so fig1 still resolves.
    for (const name of readdirSync(RESULTS_DIR)) {
      if (name.endsWith(".json")) {
        writeFileSync(join(tmpResults, name), readFileSync(join(RESULTS_DIR, name)));
      }
    }
    // Synthetic memcorrect-v1 artifact in the MemCorrectLeaderboardRow schema.
    const memcorrect = {
      benchmarkId: "memcorrect-v1",
      tier: "local",
      seed: 1,
      model: "qwen2.5-7b-32k:latest",
      meta: { seeds: [1], mode: "quick", timestamp: "2026-07-07T01:00:00Z", gitSha: "synthetic", remnicVersion: "test" },
      config: {
        adapterMode: "remnic",
        benchmarkOptions: {
          aggregateMetrics: {
            uptake_at_next: 0.92,
            uptake_latency: 1.4,
            uptake_latency_censored: 0,
            non_resurrection: 0.88,
            collateral_delta: 0.01,
            scope_precision: 0.95,
            false_apply: 0.05,
            reassertion: 0.9,
            provenance_fidelity: 0.77,
          },
        },
      },
    };
    writeFileSync(
      join(tmpResults, "2026-07-07-memcorrect-v1-remnic-test.json"),
      JSON.stringify(memcorrect, null, 2),
    );

    const res = runGenerator({
      REMNIC_FIGURES_RESULTS_DIR: tmpResults,
      REMNIC_FIGURES_OUT_DIR: tmpOut,
    });
    assert.equal(res.status, 0, `generator failed on synthetic artifact:\n${res.stderr}`);

    const svg = readFileSync(join(tmpOut, "fig2-memcorrect-metrics.svg"), "utf8");
    // The synthetic real values must render verbatim — proving the figure
    // upgrades to real data the instant an artifact lands.
    assert.ok(svg.includes("0.920"), "uptake_at_next real value renders");
    assert.ok(svg.includes("0.880"), "non_resurrection real value renders");
    assert.ok(svg.includes("0.950"), "scope_precision real value renders");
    // And the pending disclaimer is gone once real data exists.
    assert.doesNotMatch(svg, /No MemCorrect artifact committed yet/);
  } finally {
    rmSync(tmpResults, { recursive: true, force: true });
    rmSync(tmpOut, { recursive: true, force: true });
  }
});
