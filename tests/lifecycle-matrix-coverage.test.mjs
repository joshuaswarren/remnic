/**
 * Tests for the lifecycle scenario-matrix coverage gate (issue #1993, PR3).
 *
 * Drives the pure functions in scripts/lifecycle-matrix/check-coverage.mjs with
 * fixture changed-file lists and manifests — no git, no real PR — to prove the
 * acceptance behavior: a mapped lifecycle path passes, a NEW unmapped
 * lifecycle-manifest path fails naming the path, a grandfathered path only
 * warns, and the grandfather list is a ratchet that cannot grow. Also validates
 * the committed coverage.json against the real registered subjects.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { splitEffectiveDiff } from "../scripts/effective-diff.mjs";
import {
  classifyGlob,
  evaluateCoverage,
  flattenChangedPaths,
  grandfatherGrowth,
  loadCoverageManifest,
  parseNameStatusZ,
  registeredSubjectNames,
  unregisteredSubjects,
} from "../scripts/lifecycle-matrix/check-coverage.mjs";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const realManifestPath = join(repoRoot, "scripts", "lifecycle-matrix", "coverage.json");
const subjectsDir = join(repoRoot, "packages", "remnic-core", "src", "testing", "subjects");

function loadReal() {
  return loadCoverageManifest(JSON.parse(readFileSync(realManifestPath, "utf8")));
}

test("the committed coverage.json is structurally valid", () => {
  const manifest = loadReal();
  assert.ok(manifest.lifecycleManifest.length > 0);
  assert.ok(Object.keys(manifest.coverage).length > 0);
});

test("every coverage subject name is a registered LifecycleSubject", () => {
  const manifest = loadReal();
  const registered = registeredSubjectNames(subjectsDir);
  assert.ok(registered.includes("extraction-lifecycle"), "extraction-lifecycle must be registered");
  assert.ok(registered.includes("serialized-write-chain"), "serialized-write-chain must be registered");
  assert.deepEqual(unregisteredSubjects(manifest, registered), []);
});

test("a PR touching a mapped lifecycle path passes (orchestration/turn-ingestion.ts)", () => {
  const manifest = loadReal();
  const { covered, warnings, violations } = evaluateCoverage(
    ["packages/remnic-core/src/orchestration/turn-ingestion.ts"],
    manifest,
  );
  assert.equal(violations.length, 0, "a mapped path must not violate");
  assert.equal(warnings.length, 0);
  assert.equal(covered.length, 1);
  assert.equal(covered[0].subject, "extraction-lifecycle");
});

test("session-toggles.ts maps to the serialized-write-chain subject", () => {
  const manifest = loadReal();
  const { covered, violations } = evaluateCoverage(
    ["packages/remnic-core/src/session-toggles.ts"],
    manifest,
  );
  assert.equal(violations.length, 0);
  assert.equal(covered[0]?.subject, "serialized-write-chain");
});

test("a NEW lifecycle-manifest path with no mapping fails, naming the path", () => {
  const manifest = loadCoverageManifest({
    lifecycleManifest: [
      "packages/remnic-core/src/orchestration/**",
      "packages/remnic-core/src/new-lifecycle-subsystem.ts",
    ],
    coverage: { "packages/remnic-core/src/orchestration/**": "extraction-lifecycle" },
    grandfathered: [],
  });
  const { violations } = evaluateCoverage(
    ["packages/remnic-core/src/new-lifecycle-subsystem.ts"],
    manifest,
  );
  assert.equal(violations.length, 1, "an unmapped manifest path must fail when touched");
  assert.equal(violations[0].file, "packages/remnic-core/src/new-lifecycle-subsystem.ts");
  assert.equal(violations[0].glob, "packages/remnic-core/src/new-lifecycle-subsystem.ts");
});

test("a grandfathered path only warns, never fails", () => {
  const manifest = loadReal();
  const { warnings, violations, covered } = evaluateCoverage(
    ["packages/remnic-core/src/qmd-recall-cache.ts"],
    manifest,
  );
  assert.equal(violations.length, 0, "grandfathered paths must not fail the gate");
  assert.equal(covered.length, 0);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].file, "packages/remnic-core/src/qmd-recall-cache.ts");
});

test("a non-lifecycle path is ignored entirely", () => {
  const manifest = loadReal();
  const result = evaluateCoverage(["README.md", "packages/remnic-core/src/config.ts"], manifest);
  assert.deepEqual(result, { covered: [], warnings: [], violations: [] });
});

test("classifyGlob distinguishes covered / grandfathered / unmapped", () => {
  const manifest = loadReal();
  assert.equal(classifyGlob("packages/remnic-core/src/orchestration/**", manifest), "covered");
  assert.equal(classifyGlob("packages/remnic-core/src/qmd-recall-cache.ts", manifest), "grandfathered");
  assert.equal(classifyGlob("packages/remnic-core/src/does-not-exist.ts", manifest), "unmapped");
});

test("the grandfather list is a ratchet: growth is a violation", () => {
  const base = loadCoverageManifest({
    lifecycleManifest: ["a.ts", "b.ts"],
    coverage: {},
    grandfathered: ["a.ts"],
  });
  const grown = loadCoverageManifest({
    lifecycleManifest: ["a.ts", "b.ts"],
    coverage: {},
    grandfathered: ["a.ts", "b.ts"],
  });
  const shrunk = loadCoverageManifest({
    lifecycleManifest: ["a.ts", "b.ts"],
    coverage: { "b.ts": "extraction-lifecycle" },
    grandfathered: [],
  });
  assert.deepEqual(grandfatherGrowth(base, grown), ["b.ts"], "adding a grandfather entry is growth");
  assert.deepEqual(grandfatherGrowth(base, shrunk), [], "removing entries (covering them) is allowed");
});

test("loadCoverageManifest rejects malformed manifests", () => {
  assert.throws(
    () => loadCoverageManifest({ lifecycleManifest: ["a.ts"], coverage: { "b.ts": "x" }, grandfathered: [] }),
    /coverage key .* is not in lifecycleManifest/,
  );
  assert.throws(
    () =>
      loadCoverageManifest({
        lifecycleManifest: ["a.ts"],
        coverage: { "a.ts": "x" },
        grandfathered: ["a.ts"],
      }),
    /cannot be both covered and grandfathered/,
  );
  assert.throws(() => loadCoverageManifest({ lifecycleManifest: [], coverage: {}, grandfathered: [] }), /non-empty/);
});

const checkCoveragePath = join(repoRoot, "scripts", "lifecycle-matrix", "check-coverage.mjs");

test("parseNameStatusZ splits git --name-status -z records, keeping rename sources", () => {
  // R085\0old\0new\0M\0path\0A\0added\0
  const text = "R085\0packages/remnic-core/src/session-toggles.ts\0bench/artifacts/moved.ts\0M\0README.md\0A\0src/new.ts\0";
  assert.deepEqual(parseNameStatusZ(text), [
    { filename: "bench/artifacts/moved.ts", previous_filename: "packages/remnic-core/src/session-toggles.ts" },
    { filename: "README.md" },
    { filename: "src/new.ts" },
  ]);
});

test("flattenChangedPaths keeps BOTH sides of a rename and dedupes", () => {
  const flat = flattenChangedPaths([
    { filename: "bench/artifacts/moved.ts", previous_filename: "packages/remnic-core/src/session-toggles.ts" },
    "packages/remnic-core/src/buffer.ts",
    "packages/remnic-core/src/buffer.ts",
  ]);
  assert.deepEqual(flat, [
    "bench/artifacts/moved.ts",
    "packages/remnic-core/src/session-toggles.ts",
    "packages/remnic-core/src/buffer.ts",
  ]);
});

test("renaming a lifecycle path across an ignore boundary does NOT bypass the gate", () => {
  const manifest = loadReal();
  // A lifecycle path (session-toggles.ts, covered) renamed into an ignored
  // artifact path. --name-only would surface only the ignored destination and
  // silently drop the lifecycle change; the rename-aware pipeline preserves the
  // source so coverage is still enforced.
  const records = parseNameStatusZ(
    "R100\0packages/remnic-core/src/session-toggles.ts\0bench/artifacts/session-toggles.ts\0",
  );
  const ignorePatterns = ["bench/artifacts/**"];
  const { effective } = splitEffectiveDiff(flattenChangedPaths(records), ignorePatterns);
  assert.ok(
    effective.includes("packages/remnic-core/src/session-toggles.ts"),
    "the lifecycle rename source must survive the ignore filter",
  );
  assert.ok(
    !effective.includes("bench/artifacts/session-toggles.ts"),
    "the ignored artifact destination must be dropped",
  );
  const { covered, violations } = evaluateCoverage(effective, manifest);
  assert.equal(violations.length, 0);
  assert.equal(covered.length, 1);
  assert.equal(covered[0].subject, "serialized-write-chain");
});

function runCli(args, env = {}) {
  try {
    const stdout = execFileSync("node", [checkCoveragePath, ...args], {
      cwd: repoRoot,
      env: { ...process.env, ...env },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, output: stdout };
  } catch (err) {
    return { code: err.status ?? 1, output: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

test("the CLI enforces the grandfather ratchet against the base manifest", () => {
  const dir = mkdtempSync(join(tmpdir(), "lifecycle-ratchet-"));
  try {
    const base = {
      lifecycleManifest: ["packages/remnic-core/src/orchestration/**", "packages/remnic-core/src/lifecycle.ts"],
      coverage: { "packages/remnic-core/src/orchestration/**": "extraction-lifecycle" },
      grandfathered: [],
    };
    const grown = {
      ...base,
      grandfathered: ["packages/remnic-core/src/lifecycle.ts"],
    };
    const basePath = join(dir, "base.json");
    const grownPath = join(dir, "grown.json");
    writeFileSync(basePath, JSON.stringify(base));
    writeFileSync(grownPath, JSON.stringify(grown));

    // Growth: adding a grandfather entry vs the base must fail the CLI gate.
    const grow = runCli([`--manifest=${grownPath}`, `--base-manifest=${basePath}`, "--files="]);
    assert.equal(grow.code, 1, "grandfather-list growth must fail the CLI");
    assert.match(grow.output, /grandfather list grew/);
    assert.match(grow.output, /lifecycle\.ts/);

    // Same list vs base (no growth) passes.
    const flat = runCli([`--manifest=${basePath}`, `--base-manifest=${basePath}`, "--files="]);
    assert.equal(flat.code, 0, "an unchanged grandfather list must pass");

    // Shrinking (covering a formerly grandfathered path) passes.
    const shrunk = {
      lifecycleManifest: base.lifecycleManifest,
      coverage: {
        "packages/remnic-core/src/orchestration/**": "extraction-lifecycle",
        "packages/remnic-core/src/lifecycle.ts": "extraction-lifecycle",
      },
      grandfathered: [],
    };
    const shrunkPath = join(dir, "shrunk.json");
    writeFileSync(shrunkPath, JSON.stringify(shrunk));
    const shrink = runCli([`--manifest=${shrunkPath}`, `--base-manifest=${grownPath}`, "--files="]);
    assert.equal(shrink.code, 0, "removing a grandfather entry (covering it) must pass");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("storage submodule files are in the manifest (grandfathered), not silently ignored", () => {
  const manifest = loadReal();
  for (const file of [
    "packages/remnic-core/src/storage/entity-store.ts",
    "packages/remnic-core/src/storage/identity-continuity-store.ts",
  ]) {
    const { covered, warnings, violations } = evaluateCoverage([file], manifest);
    assert.equal(violations.length, 0, `${file} must not violate (grandfathered)`);
    assert.equal(covered.length, 0);
    assert.equal(warnings.length, 1, `${file} must be seen by the gate (warn), not ignored`);
    assert.equal(warnings[0].file, file);
  }
});
