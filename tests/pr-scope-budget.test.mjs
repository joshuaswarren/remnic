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

  // Only ARTICLES form the descriptive noun phrase.
  for (const article of ["the", "a", "an"]) {
    assert.equal(
      extractIssueRefs(`Follow-up to ${article} closed #999.`).size,
      0,
      `"${article} closed #999" must not count as a claim`
    );
  }

  // Real claims still count, including mid-sentence and multi-ref forms.
  assert.deepEqual([...extractIssueRefs("Closes #5 and #6")].sort((a, b) => a - b), [5, 6]);
  assert.deepEqual([...extractIssueRefs("This reverts behavior; Fixes #78")], [78]);

  // Present-tense keywords behind a demonstrative are ordinary claims.
  assert.deepEqual([...extractIssueRefs("This fixes #123")], [123]);
  assert.deepEqual([...extractIssueRefs("That resolves #456")], [456]);
  assert.deepEqual([...extractIssueRefs("This closes #7 and #8")].sort((a, b) => a - b), [7, 8]);

  // So are PAST-tense keywords whose lead is the grammatical subject rather
  // than an article — suppressing these undercounted a real multi-issue PR.
  assert.deepEqual([...extractIssueRefs("This closed #123 and #456")].sort((a, b) => a - b), [123, 456]);
  assert.deepEqual([...extractIssueRefs("That fixed #7")], [7]);
  assert.deepEqual([...extractIssueRefs("Already resolved #9")], [9]);

  assert.deepEqual(
    [...extractIssueRefs("This fixes #10. Follow-up to the closed #11.")],
    [10],
    "the claim counts while the article-led historical reference beside it does not"
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

test("claimed issues come only from PR-body closing keywords (this-run #2919)", () => {
  const bodies = [
    ["single", "Fixes #2919", [2919]],
    ["comma list", "Closes #1, #2, and #3", [1, 2, 3]],
    ["cross-repo", "Fixes octo-org/octo-repo#100", ["octo-org/octo-repo#100"]],
    [
      "docs mixed list",
      "Resolves #10, resolves #123, resolves octo-org/octo-repo#100",
      [10, 123, "octo-org/octo-repo#100"],
    ],
    ["qualified continuation", "Fixes #1 and octo-org/octo-repo#2", [1]],
    ["comma qualified continuation", "Fixes #1, octo-org/octo-repo#2", [1]],
    ["qualified-to-qualified continuation", "Fixes octo-org/octo-repo#1 and acme/widgets#2", ["octo-org/octo-repo#1"]],
    ["same-number mixed", "Fixes #100. Fixes octo-org/octo-repo#100", [100, "octo-org/octo-repo#100"]],
    ["repeated keyword mixed", "Fixes #1 and fixes octo-org/octo-repo#2", [1, "octo-org/octo-repo#2"]],
    ["mixed case", "FIXES #7 cLoSeD #8 ReSoLvEs #9", [7, 8, 9]],
    ["fenced code", "Fixes #42\n\n```\nFixes #999\n```", [42]],
    ["ordinary citations", "Follow-up to #2448. See #12. Part of #34. As reported in #99.", []],
    [
      "malformed keywords",
      "refixes #1, prefix #2, suffix #3, fixes: #4, fixes abc#5, fixes owner#6, fixes owner/repo #7, fixes #12ab, fixes ##13",
      [],
    ],
  ];
  for (const [name, body, expected] of bodies) {
    assert.deepEqual(extractIssueRefs(body), new Set(expected), name);
  }
});

test("same-repo qualified refs canonicalize to one issue identity (this-run #2948)", () => {
  // `Fixes #1234` and `Fixes joshuaswarren/remnic#1234` name the SAME issue —
  // GitHub renders the qualified spelling when a full reference is pasted.
  // Counting both inflated the multi-issue signal on a single-issue PR.
  // Cross-repo qualifiers stay distinct identities.
  const bodies = [
    ["bare", "Fixes #1234", [1234]],
    ["qualified current repo", "Fixes joshuaswarren/remnic#1234", [1234]],
    ["both spellings, one issue", "Fixes #1234 (also fixes joshuaswarren/remnic#1234)", [1234]],
    ["case-insensitive qualifier", "Fixes joshuaswarren/Remnic#1234", [1234]],
    ["cross-repo stays distinct", "Fixes octo-org/octo-repo#1234", ["octo-org/octo-repo#1234"]],
    [
      "same number, different repos",
      "Fixes joshuaswarren/remnic#100. Fixes octo-org/octo-repo#100",
      [100, "octo-org/octo-repo#100"],
    ],
    ["genuine multi-issue body", "Fixes #2948. Also fixes joshuaswarren/remnic#2919.", [2919, 2948]],
  ];
  for (const [name, body, expected] of bodies) {
    assert.deepEqual(extractIssueRefs(body), new Set(expected), name);
  }
});

test("gate level: same-repo spellings of one issue stay single-issue (#2948)", () => {
  const files = [
    coreFile(200, "packages/remnic-core/src/recall/recall.ts"),
    coreFile(200, "packages/remnic-cli/src/main.ts"),
  ];
  const one = evaluateScopeBudget({
    files,
    labels: [],
    thresholds: THRESHOLDS,
    ignorePatterns: NO_IGNORES,
    subsystemGroups: GROUPS,
    prText: "Fixes #2948 and fixes joshuaswarren/remnic#2948",
  });
  assert.equal(one.verdict, "pass", "two spellings of one issue are one claimed issue");

  const two = evaluateScopeBudget({
    files,
    labels: [],
    thresholds: THRESHOLDS,
    ignorePatterns: NO_IGNORES,
    subsystemGroups: GROUPS,
    prText: "Fixes #2948 and fixes joshuaswarren/remnic#2919",
  });
  assert.equal(two.verdict, "fail", "two genuinely distinct issues across unrelated groups still fails");
  assert.match(two.detail, /2 referenced issues \(#2919, #2948\)/);
});

test("touched-code historical citations never inflate the count (#2769 shape, this-run #2919)", () => {
  // The #2769/#2774 failure: the gate reported the predecessor issues a
  // touched module's docstring cites, on a PR claiming ONE issue. The parser
  // consumes PR text only — file contents, commit messages, and review text
  // are structurally outside its input.
  const body = [
    "## Summary",
    "",
    "Fixes #2919",
    "",
    "Context: the touched module's docstring (quoted verbatim) reads:",
    "",
    "```",
    "/**",
    " * Loopback classification (issues #2448 and #2712) — narrowed here.",
    " */",
    "```",
    "",
    "This is a follow-up to the closed #2488. See #2448 for the original report.",
  ].join("\n");
  assert.deepEqual([...extractIssueRefs(body)], [2919]);
});

test("gate level: cross-repo claims count as multi-issue; citations alone stay single-issue (this-run #2919)", () => {
  const files = [
    coreFile(200, "packages/remnic-core/src/recall/recall.ts"),
    coreFile(200, "packages/remnic-cli/src/main.ts"),
  ];
  const quiet = evaluateScopeBudget({
    files,
    labels: [],
    thresholds: THRESHOLDS,
    ignorePatterns: NO_IGNORES,
    subsystemGroups: GROUPS,
    prText: "Fixes #2919. Follow-up to #2448, see #2712, part of the closed #2488.",
  });
  assert.equal(quiet.verdict, "pass", "one claimed issue + historical citations stays single-issue");

  const loud = evaluateScopeBudget({
    files,
    labels: [],
    thresholds: THRESHOLDS,
    ignorePatterns: NO_IGNORES,
    subsystemGroups: GROUPS,
    prText: "Fixes #2919 and fixes octo-org/octo-repo#100",
  });
  assert.equal(loud.verdict, "fail");
  assert.match(loud.detail, /octo-org\/octo-repo#100, #2919/);

  const sameNumber = evaluateScopeBudget({
    files,
    labels: [],
    thresholds: THRESHOLDS,
    ignorePatterns: NO_IGNORES,
    subsystemGroups: GROUPS,
    prText: "Fixes #100. Fixes octo-org/octo-repo#100",
  });
  assert.equal(sameNumber.verdict, "fail", "local #100 and owner/repo#100 are distinct claims");
  assert.match(sameNumber.detail, /2 referenced issues \(#100, octo-org\/octo-repo#100\)/);

  const keywordless = evaluateScopeBudget({
    files,
    labels: [],
    thresholds: THRESHOLDS,
    ignorePatterns: NO_IGNORES,
    subsystemGroups: GROUPS,
    prText: "Fixes #1 and octo-org/octo-repo#2",
  });
  assert.equal(keywordless.verdict, "pass", "keywordless qualified continuation is not a second claim");
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
