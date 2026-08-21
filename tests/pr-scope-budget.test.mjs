import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { parseIgnoreManifest } from "../scripts/effective-diff.mjs";
import {
  CORE_PATH_PREFIXES,
  EXEMPT_LABEL,
  MIN_SHARED_ANCESTOR_SEGMENTS,
  classifySubsystem,
  evaluateScopeBudget,
  extractIssueRefs,
  loadSubsystemGroups,
  loadThresholds,
  sharedAncestorSegments,
} from "../scripts/pr-scope-budget.mjs";

const THRESHOLDS = { warnLines: 1500, failLines: 4000 };
const NO_IGNORES = [];

// Representative subsystem-group map for the detection tests (issue #2067).
const GROUPS = {
  "packages/remnic-core/src/recall": "recall",
  "packages/remnic-core/src/config": "config",
  "packages/remnic-core/src/storage": "storage",
  "packages/remnic-cli/": "cli",
  "src/": "root-src",
};

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
    /no filename/
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
      {
        filename: "gen/parked.json",
        previous_filename: "packages/remnic-core/src/old.ts",
        additions: 900,
        deletions: 900,
      },
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

// --- Subsystem-group / multi-issue detection (issue #2067) ---

test("issue references are extracted, deduped, boundary-checked, and code-stripped", () => {
  const issues = extractIssueRefs("Closes #12, Fixes #12 again, and Resolves #99.");
  assert.deepEqual(
    [...issues].sort((a, b) => a - b),
    [12, 99]
  );
  assert.equal(extractIssueRefs("").size, 0);
  assert.equal(extractIssueRefs(undefined).size, 0);
  const filtered = extractIssueRefs(
    "Fixes #42, hidden <!-- Closes #77 -->, color `#123456`, block ```\nFixes #999\n```, run#7 x#8y ##9"
  );
  assert.deepEqual([...filtered], [42]);
});

test("a closing keyword behind a determiner is description, not a claim (this-run #2774)", () => {
  // Verbatim shape of a real single-issue PR body that this gate reported as
  // spanning two issues: it cited the predecessor issue in prose, and the
  // touched file's own docstring referenced it too.
  const issues = extractIssueRefs(
    "Fixes #2712\n\nFollow-up to the closed #2448 / #2488, which made `status` honor the env var but left the daemon verbs local."
  );
  assert.deepEqual([...issues], [2712], "only the claimed issue counts");

  // Every determiner form stays descriptive.
  for (const lead of ["the", "this", "that", "already", "was", "recently"]) {
    assert.equal(
      extractIssueRefs(`Follow-up to ${lead} closed #999.`).size,
      0,
      `"${lead} closed #999" must not count as a claim`
    );
  }

  // Real claims still count, including mid-sentence and multi-ref forms.
  assert.deepEqual([...extractIssueRefs("Closes #5 and #6")].sort((a, b) => a - b), [5, 6]);
  assert.deepEqual([...extractIssueRefs("This reverts behavior; Fixes #78")], [78]);

  // A determiner in front of a PRESENT-tense keyword is still a claim.
  // Suppressing on the determiner alone undercounted these, which would let a
  // real multi-issue PR evade the gate — worse than the false positive above.
  assert.deepEqual([...extractIssueRefs("This fixes #123")], [123]);
  assert.deepEqual([...extractIssueRefs("That resolves #456")], [456]);
  assert.deepEqual([...extractIssueRefs("This closes #7 and #8")].sort((a, b) => a - b), [7, 8]);
  assert.deepEqual(
    [...extractIssueRefs("This fixes #10. Follow-up to the closed #11.")],
    [10],
    "present-tense claim counts while the historical reference beside it does not"
  );
});

test("extractIssueRefs ignores see/part-of/pull URLs (this-run #2550)", () => {
  const issues = extractIssueRefs(
    "Fixes #2387.\nSupport-passport recovery from https://github.com/joshuaswarren/remnic/pull/2360. See #12, part of #34."
  );
  assert.deepEqual([...issues], [2387]);
});

test("extractIssueRefs accepts GitHub Fixes #1 and #2 lists", () => {
  assert.deepEqual(
    [...extractIssueRefs("Fixes #111 and #222, also Closes #333, #444")].sort((a, b) => a - b),
    [111, 222, 333, 444],
  );
});

test("classifySubsystem picks the longest matching prefix", () => {
  const map = {
    "packages/remnic-core/": "core",
    "packages/remnic-core/src/recall": "recall",
  };
  assert.equal(classifySubsystem("packages/remnic-core/src/recall-state.ts", map).group, "recall");
  assert.equal(classifySubsystem("packages/remnic-core/src/other.ts", map).group, "core");
  assert.equal(classifySubsystem("docs/x.md", map), null);
});

test("sharedAncestorSegments measures the common path-prefix depth", () => {
  assert.equal(sharedAncestorSegments(["packages/remnic-core/src/recall", "packages/remnic-core/src/config"]), 3);
  assert.equal(sharedAncestorSegments(["packages/remnic-core/src/recall", "packages/remnic-cli/"]), 1);
  assert.equal(sharedAncestorSegments(["src/tools.ts", "packages/remnic-core/x"]), 0);
  assert.equal(sharedAncestorSegments([]), 0);
});

test("single-group PR is unaffected by multi-issue text (line-count behavior unchanged)", () => {
  const result = evaluateScopeBudget({
    files: [
      coreFile(100, "packages/remnic-core/src/recall-state.ts"),
      coreFile(120, "packages/remnic-core/src/recall-timings.ts"),
    ],
    labels: [],
    thresholds: THRESHOLDS,
    ignorePatterns: NO_IGNORES,
    subsystemGroups: GROUPS,
    prText: "Fixes #111 and #222",
  });
  assert.equal(result.verdict, "pass");
  assert.doesNotMatch(result.detail, /subsystem groups/);
});

test(">=3 related groups + >=2 issues warns without failing (shared package ancestor)", () => {
  const result = evaluateScopeBudget({
    files: [
      coreFile(80, "packages/remnic-core/src/recall-state.ts"),
      coreFile(80, "packages/remnic-core/src/config.ts"),
      coreFile(80, "packages/remnic-core/src/storage.ts"),
    ],
    labels: [],
    thresholds: THRESHOLDS,
    ignorePatterns: NO_IGNORES,
    subsystemGroups: GROUPS,
    prText: "Fixes #111. Fixes #222",
  });
  assert.equal(result.verdict, "warn");
  assert.match(result.detail, /span 3 subsystem groups/);
  assert.match(result.detail, /#111, #222/);
  assert.match(result.detail, /one PR per issue/);
});

test("unrelated groups (no package ancestor) + >=2 issues fails; exempt bypasses", () => {
  const base = {
    files: [coreFile(80, "packages/remnic-core/src/recall-state.ts"), coreFile(80, "packages/remnic-cli/src/index.ts")],
    thresholds: THRESHOLDS,
    ignorePatterns: NO_IGNORES,
    subsystemGroups: GROUPS,
    prText: "Fixes #111. Fixes #222",
  };
  const fail = evaluateScopeBudget({ ...base, labels: [] });
  assert.equal(fail.verdict, "fail");
  assert.match(fail.detail, /share no package-level ancestor/);
  assert.match(fail.detail, /cli, recall/);

  const exempt = evaluateScopeBudget({ ...base, labels: [EXEMPT_LABEL] });
  assert.equal(exempt.verdict, "exempt");
  assert.match(exempt.detail, /passing ONLY because/);
  assert.match(exempt.detail, /share no package-level ancestor/);
});

test("rename classifies by the core side (previous_filename) not the destination", () => {
  // A core recall file renamed out to docs, plus an unrelated cli change, both
  // for two issues: grouping must follow the core previous_filename so the
  // recall+cli split fail still triggers (review: cursor + codex on #2067).
  const result = evaluateScopeBudget({
    files: [
      {
        filename: "docs/moved.md",
        previous_filename: "packages/remnic-core/src/recall-state.ts",
        additions: 40,
        deletions: 40,
      },
      coreFile(80, "packages/remnic-cli/src/index.ts"),
    ],
    labels: [],
    thresholds: THRESHOLDS,
    ignorePatterns: NO_IGNORES,
    subsystemGroups: GROUPS,
    prText: "Fixes #111 and #222",
  });
  assert.equal(result.verdict, "fail");
  assert.match(result.detail, /cli, recall/);
});

test("core-to-core rename classifies both the source and destination subsystems", () => {
  // Move recall code into remnic-cli (both sides count): one file yields two
  // groups, so a two-issue PR trips the unrelated-subsystem split fail even
  // though only a single entry changed (review: codex on #2067).
  const result = evaluateScopeBudget({
    files: [
      {
        filename: "packages/remnic-cli/src/recall-moved.ts",
        previous_filename: "packages/remnic-core/src/recall-state.ts",
        additions: 60,
        deletions: 60,
      },
    ],
    labels: [],
    thresholds: THRESHOLDS,
    ignorePatterns: NO_IGNORES,
    subsystemGroups: GROUPS,
    prText: "Fixes #111 and #222",
  });
  assert.equal(result.verdict, "fail");
  assert.match(result.detail, /cli, recall/);
});

test("unrelated groups but a single distinct issue does not trigger the split rule", () => {
  const result = evaluateScopeBudget({
    files: [coreFile(80, "packages/remnic-core/src/recall-state.ts"), coreFile(80, "packages/remnic-cli/src/index.ts")],
    labels: [],
    thresholds: THRESHOLDS,
    ignorePatterns: NO_IGNORES,
    subsystemGroups: GROUPS,
    prText: "Fixes #111 (and #111 mentioned twice)",
  });
  assert.equal(result.verdict, "pass");
});

test("loadThresholds reads and validates the subsystemGroups map", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "scope-groups-"));
  try {
    const file = path.join(dir, "cfg.json");
    writeFileSync(file, JSON.stringify({ warnLines: 1500, failLines: 4000, subsystemGroups: GROUPS }));
    assert.deepEqual(loadThresholds(file).subsystemGroups, GROUPS);

    writeFileSync(file, JSON.stringify({ warnLines: 1500, failLines: 4000 }));
    assert.deepEqual(loadThresholds(file).subsystemGroups, {});

    writeFileSync(file, JSON.stringify({ warnLines: 1500, failLines: 4000, subsystemGroups: { "a/": 5 } }));
    assert.throws(() => loadThresholds(file), /must be a non-empty string/);

    writeFileSync(file, JSON.stringify({ warnLines: 1500, failLines: 4000, subsystemGroups: { "/abs": "x" } }));
    assert.throws(() => loadThresholds(file), /must be repo-relative/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadSubsystemGroups rejects non-object shapes; MIN ancestor is package-level", () => {
  assert.deepEqual(loadSubsystemGroups(undefined), {});
  assert.deepEqual(loadSubsystemGroups(null), {});
  assert.throws(() => loadSubsystemGroups([]), /must be an object/);
  assert.equal(MIN_SHARED_ANCESTOR_SEGMENTS, 2);
});
