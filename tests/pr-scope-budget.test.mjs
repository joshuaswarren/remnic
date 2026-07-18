import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { parseIgnoreManifest } from "../scripts/effective-diff.mjs";
import {
  CORE_PATH_PREFIXES,
  EXEMPT_LABEL,
  evaluateScopeBudget,
  loadThresholds,
} from "../scripts/pr-scope-budget.mjs";

const THRESHOLDS = { warnLines: 1500, failLines: 4000 };
const NO_IGNORES = [];

function coreFile(lines, filename = "packages/remnic-core/src/storage.ts") {
  return { filename, additions: lines, deletions: 0 };
}

test("pass under the warn threshold; non-core and artifact paths never count", () => {
  const patterns = parseIgnoreManifest("packages/bench/baselines/\n");
  const result = evaluateScopeBudget({
    files: [
      coreFile(1400),
      { filename: "docs/timeline.md", additions: 9000, deletions: 0 },
      { filename: "packages/bench/baselines/huge.json", additions: 50000, deletions: 0 },
      { filename: "packages/bench/src/runner.ts", additions: 800, deletions: 0 },
    ],
    labels: [],
    thresholds: THRESHOLDS,
    ignorePatterns: patterns,
  });
  assert.equal(result.verdict, "pass");
  assert.equal(result.coreLines, 1400);
});

test("warn tier annotates but does not fail; fail tier fails naming the split guidance", () => {
  const warn = evaluateScopeBudget({
    files: [coreFile(1600)],
    labels: [],
    thresholds: THRESHOLDS,
    ignorePatterns: NO_IGNORES,
  });
  assert.equal(warn.verdict, "warn");
  assert.match(warn.detail, /1600 changed lines — over the 1500-line budget/);

  const fail = evaluateScopeBudget({
    files: [coreFile(2500), coreFile(1600, "packages/remnic-cli/src/index.ts")],
    labels: [],
    thresholds: THRESHOLDS,
    ignorePatterns: NO_IGNORES,
  });
  assert.equal(fail.verdict, "fail");
  assert.equal(fail.coreLines, 4100);
  assert.match(fail.detail, /Split by subsystem/);
  assert.match(fail.detail, /scope-budget-exempt/);
});

test("exempt label converts fail to exempt; label removal re-fails (no sticky exemption)", () => {
  const base = {
    files: [coreFile(4100)],
    thresholds: THRESHOLDS,
    ignorePatterns: NO_IGNORES,
  };
  const exempt = evaluateScopeBudget({ ...base, labels: [EXEMPT_LABEL] });
  assert.equal(exempt.verdict, "exempt");
  assert.match(exempt.detail, /passing ONLY because/);

  const refail = evaluateScopeBudget({ ...base, labels: [] });
  assert.equal(refail.verdict, "fail");
});

test("deletions count; additions+deletions summed per file", () => {
  const result = evaluateScopeBudget({
    files: [{ filename: "packages/remnic-core/src/cli.ts", additions: 100, deletions: 1500 }],
    labels: [],
    thresholds: THRESHOLDS,
    ignorePatterns: NO_IGNORES,
  });
  assert.equal(result.coreLines, 1600);
  assert.equal(result.verdict, "warn");
});

test("largest offenders are listed deterministically (size desc, then name)", () => {
  const result = evaluateScopeBudget({
    files: [
      coreFile(2000, "packages/remnic-core/src/b.ts"),
      coreFile(2000, "packages/remnic-core/src/a.ts"),
      coreFile(3000, "packages/remnic-core/src/c.ts"),
    ],
    labels: [],
    thresholds: THRESHOLDS,
    ignorePatterns: NO_IGNORES,
  });
  assert.equal(result.verdict, "fail");
  const cIdx = result.detail.indexOf("c.ts");
  const aIdx = result.detail.indexOf("a.ts");
  const bIdx = result.detail.indexOf("b.ts");
  assert.ok(cIdx < aIdx && aIdx < bIdx, result.detail);
});

test("input validation: pathless files and bad thresholds are rejected", () => {
  assert.throws(
    () =>
      evaluateScopeBudget({
        files: [{ additions: 1 }],
        labels: [],
        thresholds: THRESHOLDS,
        ignorePatterns: NO_IGNORES,
      }),
    /no filename/,
  );

  const dir = mkdtempSync(path.join(tmpdir(), "scope-budget-"));
  try {
    const bad = path.join(dir, "bad.json");
    writeFileSync(bad, JSON.stringify({ warnLines: 4000, failLines: 1500 }));
    assert.throws(() => loadThresholds(bad), /failLines must exceed warnLines/);
    writeFileSync(bad, JSON.stringify({ warnLines: 0, failLines: 4000 }));
    assert.throws(() => loadThresholds(bad), /warnLines must be a positive integer/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("every core prefix is a real repo directory shape", () => {
  for (const prefix of CORE_PATH_PREFIXES) {
    assert.ok(prefix.endsWith("/"), `${prefix} must end with /`);
    assert.ok(!prefix.startsWith("/"), `${prefix} must be repo-relative`);
  }
});

test("renames out of core paths still count against the budget (round 3)", () => {
  const patterns = parseIgnoreManifest("gen/\n");
  const result = evaluateScopeBudget({
    files: [
      // Core file renamed into an ignored artifact dir: counts.
      { filename: "gen/parked.json", previous_filename: "packages/remnic-core/src/old.ts", additions: 900, deletions: 900 },
      // Core file renamed into a non-core docs path: counts.
      { filename: "docs/moved.md", previous_filename: "src/tools.ts", additions: 0, deletions: 100 },
      // Pure artifact shuffle: does not count.
      { filename: "gen/b.json", previous_filename: "gen/a.json", additions: 5000, deletions: 0 },
    ],
    labels: [],
    thresholds: { warnLines: 1500, failLines: 4000 },
    ignorePatterns: patterns,
  });
  assert.equal(result.coreLines, 1900);
  assert.equal(result.verdict, "warn");
});
