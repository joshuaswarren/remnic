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
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  classifyGlob,
  evaluateCoverage,
  grandfatherGrowth,
  loadCoverageManifest,
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
