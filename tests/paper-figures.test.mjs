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
import { compareArtifactsByRecency } from "../scripts/generate-paper-figures.mjs";

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
  // Hermetic env (#2004): the root test runner injects
  // NODE_OPTIONS=--conditions=remnic-source and may carry stray
  // REMNIC_FIGURES_* / locale vars into the worker that an isolated
  // `tsx --test` run never sees. The committed figures are produced by
  // `pnpm run figures:paper` (`node scripts/generate-paper-figures.mjs`, a
  // clean env), so the regeneration MUST run in that same environment or the
  // byte-identical assertion compares two different regimes and flakes.
  // Strip the leaking vars and pin the collation locale so any locale-sensitive
  // compare is stable regardless of who spawned the suite.
  const childEnv = { ...process.env };
  delete childEnv.NODE_OPTIONS;
  delete childEnv.REMNIC_FIGURES_RESULTS_DIR;
  delete childEnv.REMNIC_FIGURES_OUT_DIR;
  delete childEnv.REMNIC_FIGURES_DEBUG;
  childEnv.LC_ALL = "C";
  childEnv.LANG = "C";
  return spawnSync(process.execPath, [GEN], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { ...childEnv, ...env },
  });
}

function readFigure(name) {
  return readFileSync(join(FIGURES_DIR, name), "utf8");
}

function loadJson(p) {
  return JSON.parse(readFileSync(p, "utf8"));
}

// ─── Helpers: find the real (non-mock) committed artifacts ────────────────

// Which artifacts under docs/benchmarks/results/ are COMMITTED (safe to plot
// or to seed a regeneration from). The dir is gitignored (root .gitignore line
// 44), so the self-hosted CI runner accumulates UNTRACKED leftovers there; this
// helper must ignore them or the byte-identical regeneration test fails in CI
// only.
//
// Source of truth: the committed manifest at docs/benchmarks/artifact-manifest.json
// (git-INDEPENDENT — works in the CI subprocess where `git ls-files` is not
// reliably callable). Falls back to `git ls-files` for local dev. `null` means
// nothing tracked → no filtering (defensive).
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
    const res = spawnSync("git", ["-c", "safe.directory=*", "ls-files", "docs/benchmarks/results"], {
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
function trackedResultsNames() {
  return readManifestNames() ?? trackedResultsNamesFromGit();
}
const TRACKED_RESULTS_NAMES = trackedResultsNames();
function isTrackedResult(name) {
  return !TRACKED_RESULTS_NAMES || TRACKED_RESULTS_NAMES.has(name);
}

// Copy only git-tracked artifacts into dest so a regeneration is hermetic to
// the UNTRACKED leftovers the self-hosted CI runner accumulates in the
// gitignored results dir. Returns the copied basenames.
function copyTrackedResults(dest) {
  const copied = [];
  for (const name of readdirSync(RESULTS_DIR)) {
    if (!name.endsWith(".json")) continue;
    if (!isTrackedResult(name)) continue;
    writeFileSync(join(dest, name), readFileSync(join(RESULTS_DIR, name)));
    copied.push(name);
  }
  return copied;
}

function findRealArtifact(benchmarkId, tier) {
  // Match the generator EXACTLY (#2004): among committed (manifest-tracked),
  // non-mock artifacts for this benchmark+tier, return the NEWEST run using the
  // generator's own deterministic comparator (epoch-ms + filename tiebreak, no
  // locale-sensitive localeCompare). Using the same comparator the committed
  // figure was rendered with is what keeps this assertion in lockstep with the
  // SVG across environments.
  const matches = [];
  for (const name of readdirSync(RESULTS_DIR)) {
    if (!name.endsWith(".json") || name.includes("mock000")) continue;
    if (!isTrackedResult(name)) continue;
    const doc = loadJson(join(RESULTS_DIR, name));
    if (doc.benchmarkId === benchmarkId && (!tier || doc.tier === tier)) {
      matches.push({ name, doc });
    }
  }
  matches.sort(compareArtifactsByRecency);
  return matches[0] ?? null;
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
  //
  // Regenerate from a HERMETIC copy of only the git-tracked artifacts. The
  // self-hosted CI runner accumulates UNTRACKED artifacts in the gitignored
  // results dir; regenerating from the live dir would let the generator pick
  // a leftover (newest finishedAt) and fail this test in CI only. The
  // generator's own git-tracked filter covers `pnpm run figures:paper`; this
  // env-override seam makes the assertion itself immune to CI leftovers.
  const tmpResults = mkdtempSync(join(tmpdir(), "fig-sync-results-"));
  const tmpOut = mkdtempSync(join(tmpdir(), "fig-sync-out-"));
  try {
    assert.ok(
      copyTrackedResults(tmpResults).length > 0,
      "git-tracked artifacts must exist to regenerate from",
    );
    const res = runGenerator({ REMNIC_FIGURES_RESULTS_DIR: tmpResults, REMNIC_FIGURES_OUT_DIR: tmpOut });
    // Surface a spawn failure as a clear assertion instead of a downstream
    // ENOENT when readFileSync can't find an unwritten figure (#2004): under
    // full-suite concurrency a failed/partial spawn otherwise masquerades as a
    // figure mismatch flake.
    assert.equal(res.status, 0, `generator failed:\n${res.stderr}`);
    for (const f of [
      "fig1-locomo-longmemeval.svg",
      "fig2-memcorrect-metrics.svg",
      "fig3-trustscore-components.svg",
    ]) {
      const fresh = readFileSync(join(tmpOut, f), "utf8");
      const committed = readFigure(f);
      assert.equal(fresh, committed, `committed ${f} is stale — run \`pnpm run figures:paper\``);
    }
  } finally {
    rmSync(tmpResults, { recursive: true, force: true });
    rmSync(tmpOut, { recursive: true, force: true });
  }
});

test("artifact selection breaks a finishedAt tie deterministically (no localeCompare/readdir dependence) — #2004", () => {
  // Root cause of the #2004 flake: two committed same-benchmark+tier artifacts
  // whose finishedAt collate-equal made the "newest wins" sort fall back to
  // readdirSync order, which is filesystem/OS/load dependent. The figure
  // committed in one environment and the figure regenerated inside the
  // full-suite worker could then choose different artifacts — byte mismatch in
  // the full suite, pass in isolation. The comparator must break ties by a
  // stable key (filename codepoint order), never by input/readdir order.
  const tie = "2026-07-17T07:29:53.153Z";
  const A = { name: "2026-07-17-longmemeval-alpha.json", doc: { finishedAt: tie } };
  const B = { name: "2026-07-17-longmemeval-bravo.json", doc: { finishedAt: tie } };
  const pick = (arr) => [...arr].sort(compareArtifactsByRecency)[0].name;
  assert.equal(
    pick([A, B]),
    pick([B, A]),
    "tie winner must not depend on candidate/readdir order (was localeCompare→0→input order)",
  );
  // Distinct timestamps still resolve newest-first, regardless of input order.
  const older = { name: "2026-07-14-longmemeval-opus.json", doc: { finishedAt: "2026-07-14T04:02:21.944Z" } };
  const newer = { name: "2026-07-17-longmemeval-luna.json", doc: { finishedAt: tie } };
  assert.equal(pick([older, newer]), newer.name, "newest finishedAt wins");
  assert.equal(pick([newer, older]), newer.name, "newest finishedAt wins regardless of input order");
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

test("Figure 1: Tier-F panels are REAL when frontier artifacts are committed; third-party stays DATA-PENDING", () => {
  const svg = readFigure("fig1-locomo-longmemeval.svg");
  const locomoF = findRealArtifact("locomo", "frontier");
  const longmemevalF = findRealArtifact("longmemeval", "frontier");

  if (locomoF || longmemevalF) {
    // Tier-F artifacts exist → the figure must render real Tier-F values,
    // not pending-hatched bars. No "#1728" pending marker for Tier-F.
    assert.doesNotMatch(svg, /pending #1728/, "Tier-F is real — no #1728 pending marker");
    // The real values must trace to the committed artifacts.
    if (longmemevalF) {
      const v = longmemevalF.doc.metrics.llm_judge ?? longmemevalF.doc.metrics.judge_accuracy;
      assert.ok(v !== undefined, "longmemeval frontier artifact has a judge metric");
      assert.ok(svg.includes(v.toFixed(3)), `fig1 renders longmemeval Tier-F llm_judge=${v.toFixed(3)}`);
    }
    if (locomoF) {
      const v = locomoF.doc.metrics.llm_judge;
      assert.ok(v !== undefined, "locomo frontier artifact has an llm_judge metric");
      assert.ok(svg.includes(v.toFixed(3)), `fig1 renders locomo Tier-F llm_judge=${v.toFixed(3)}`);
    }
  } else {
    // No Tier-F artifact → pending bars with hatch + blocking issue cite.
    assert.match(svg, /url\(#pendingHatch1\)/, "pending panels are hatched");
    assert.match(svg, /pending #1728/, "Tier-F pending cites the blocking issue");
  }

  // Third-party (Mem0/Zep/Letta) is ALWAYS pending until #1747 adapter runs land,
  // regardless of Tier-F state — no fabricated competitor numbers.
  assert.match(svg, /third-party pending #1747/, "third-party pending cites the adapter issue");
  assert.doesNotMatch(svg, /mock000/, "no mock cited as a result");
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
    // Carry the real locomo/longmemeval artifacts so fig1 still resolves. Use
    // the filtered copy so UNTRACKED CI leftovers in the gitignored results
    // dir never seed the temp dir (cursor thread: auto-upgrade copies CI junk).
    copyTrackedResults(tmpResults);
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
