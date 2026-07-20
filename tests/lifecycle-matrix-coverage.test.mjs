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
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { splitEffectiveDiff } from "../scripts/effective-diff.mjs";
import {
  classifyGlob,
  discoverSubjectRegistrations,
  deletedOrRenamedPaths,
  deletedPaths,
  evaluateCoverage,
  flattenChangedPaths,
  grandfatherGrowth,
  isLifecycleTestFile,
  loadCoverageManifest,
  manifestShrinkage,
  parseNameStatusZ,
  registeredSubjectNames,
  renameSourcesWithinLifecycle,
  unexplainedRemovals,
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
  const result = evaluateCoverage(["README.md", "packages/remnic-core/src/version.ts"], manifest);
  assert.deepEqual(result, { covered: [], warnings: [], violations: [] });
});

test("classifyGlob distinguishes covered / grandfathered / unmapped", () => {
  const manifest = loadReal();
  assert.equal(classifyGlob("packages/remnic-core/src/orchestration/extraction-run.ts", manifest), "covered");
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
    { status: "R085", filename: "bench/artifacts/moved.ts", previous_filename: "packages/remnic-core/src/session-toggles.ts" },
    { status: "M", filename: "README.md" },
    { status: "A", filename: "src/new.ts" },
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

const LIFECYCLE_ENV_VARS = [
  "LIFECYCLE_BASE_MANIFEST_PATH",
  "LIFECYCLE_BASE_IGNORE_PATH",
  "REMNIC_LIFECYCLE_CHANGED_FILES_PATH",
  "LIFECYCLE_BASE_REF",
  "GITHUB_BASE_REF",
];

function runCli(args, env = {}) {
  // Hermetic by default: scrub the lifecycle env vars a prior CI step sets, so a
  // spawned CLI case is driven ONLY by its explicit args (pass `env` for a case
  // that intentionally wants env-driven behavior). Otherwise an inherited
  // LIFECYCLE_BASE_MANIFEST_PATH would make temp-manifest cases without
  // --base-manifest silently compare against the real base manifest.
  const scrubbed = { ...process.env };
  for (const key of LIFECYCLE_ENV_VARS) delete scrubbed[key];
  try {
    const stdout = execFileSync("node", [checkCoveragePath, ...args], {
      cwd: repoRoot,
      env: { ...scrubbed, ...env },
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

    // Removing a glob from lifecycleManifest silently disables the gate for it → must fail.
    const removed = {
      lifecycleManifest: ["packages/remnic-core/src/orchestration/**"],
      coverage: { "packages/remnic-core/src/orchestration/**": "extraction-lifecycle" },
      grandfathered: [],
    };
    const removedPath = join(dir, "removed.json");
    writeFileSync(removedPath, JSON.stringify(removed));
    const drop = runCli([`--manifest=${removedPath}`, `--base-manifest=${basePath}`, "--files="]);
    assert.equal(drop.code, 1, "dropping a lifecycleManifest path must fail the CLI");
    assert.match(drop.output, /lifecycleManifest removed path/);
    assert.match(drop.output, /lifecycle\.ts/);
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
  // Existing storage files are grandfathered individually; a NEW storage file
  // matches only the storage/** catch-all (unmapped) and must FAIL the gate.
  const fresh = evaluateCoverage(["packages/remnic-core/src/storage/brand-new-store.ts"], manifest);
  assert.equal(fresh.violations.length, 1, "a new storage submodule file must fail as unmapped until covered or grandfathered");
  assert.equal(fresh.warnings.length, 0);
});

test("manifestShrinkage flags lifecycleManifest globs removed vs the base", () => {
  const base = loadCoverageManifest({
    lifecycleManifest: ["a.ts", "b.ts"],
    coverage: { "a.ts": "extraction-lifecycle" },
    grandfathered: ["b.ts"],
  });
  const dropped = loadCoverageManifest({
    lifecycleManifest: ["a.ts"],
    coverage: { "a.ts": "extraction-lifecycle" },
    grandfathered: [],
  });
  const grew = loadCoverageManifest({
    lifecycleManifest: ["a.ts", "b.ts", "c.ts"],
    coverage: { "a.ts": "extraction-lifecycle", "c.ts": "extraction-lifecycle" },
    grandfathered: ["b.ts"],
  });
  assert.deepEqual(manifestShrinkage(base, dropped), ["b.ts"], "removing a manifest glob is shrinkage");
  assert.deepEqual(manifestShrinkage(base, grew), [], "adding globs (with coverage) is allowed");
});

test("loadCoverageManifest rejects globs that can never match a repo-relative path", () => {
  const base = { coverage: {}, grandfathered: [] };
  assert.throws(
    () => loadCoverageManifest({ ...base, lifecycleManifest: ["/packages/remnic-core/src/orchestrator.ts"] }),
    /leading-slash forms never match/,
    "a leading slash must be rejected, not silently ignored",
  );
  assert.throws(
    () => loadCoverageManifest({ ...base, lifecycleManifest: ["packages\\remnic-core\\src\\orchestrator.ts"] }),
    /must use forward slashes/,
    "backslashes must be rejected",
  );
  assert.throws(
    () => loadCoverageManifest({ ...base, lifecycleManifest: ["!packages/remnic-core/src/orchestrator.ts"] }),
    /negation and leading-slash forms/,
    "negation must be rejected",
  );
  assert.throws(
    () => loadCoverageManifest({ ...base, lifecycleManifest: [" packages/remnic-core/src/orchestrator.ts"] }),
    /leading\/trailing whitespace/,
    "surrounding whitespace must be rejected",
  );
  assert.throws(
    () => loadCoverageManifest({ ...base, lifecycleManifest: [""] }),
    /non-empty string/,
    "an empty glob must be rejected",
  );
});

test("discoverSubjectRegistrations records only genuine TOP-LEVEL calls", () => {
  const source = [
    'runLifecycleMatrix("real-subject", subject);',
    '// runLifecycleMatrix("commented-line", subject)',
    '/* runLifecycleMatrix("commented-block", subject) */',
    "const doc = 'runLifecycleMatrix(\"string-literal\", subject)';",
    'const t = `runLifecycleMatrix("template-literal", subject)`;',
    "runLifecycleMatrix('single-quoted-real', subject);",
    'if (false) { runLifecycleMatrix("nested-in-dead-block", subject); }',
    'function unused() { runLifecycleMatrix("in-uncalled-helper", subject); }',
    'runLifecycleMatrix("narrowed-rows", subject, { rows: [MATRIX_ROWS[0]] });',
    'runLifecycleMatrix("redirected", subject, { register: fake, registerSkipped: skip });',
    'runLifecycleMatrix("inline-two-arg", { async setup() {}, async exercise() {} });',
    'const opts = { rows: [MATRIX_ROWS[0]] }; runLifecycleMatrix("aliased-opts", subject, opts);',
    'runLifecycleMatrix("nested-call-arg", makeSubject(a, b));',
    'const re = /runLifecycleMatrix("regex-literal", subject)/;',
    'runLifecycleMatrix("after-regex", subject);',
    'process.env.RUN_MATRIX && runLifecycleMatrix("env-gated", subject);',
    'false && runLifecycleMatrix("short-circuit", subject);',
    'if (false) runLifecycleMatrix("braceless-if", subject);',
    'const assigned = runLifecycleMatrix("assigned-not-statement", subject);',
    'runLifecycleMatrix("trailing-comma", subject,);',
    'for (; false; runLifecycleMatrix("for-update", subject)) {}',
    'foo(runLifecycleMatrix("in-call-arg", subject));',
  ].join("\n");
  assert.deepEqual(
    discoverSubjectRegistrations(source),
    ["real-subject", "single-quoted-real", "inline-two-arg", "nested-call-arg", "after-regex", "trailing-comma"],
    "only genuine module-load standalone 2-arg registrations count (legal trailing comma ok); comments, strings, template/regex literals, brace-nested calls, options args, non-standalone wrappers (short-circuit/braceless-if/assignment), and calls inside parens/brackets (for-header, call arg, array) are ignored",
  );
});

test("discoverSubjectRegistrations records ASI-separated (newline, no semicolon) registrations", () => {
  const source = [
    'runLifecycleMatrix("asi-first", subject)',
    'runLifecycleMatrix("asi-second", subject)',
    'helper()',
    'runLifecycleMatrix("after-call-asi", subject)',
    'if (false) runLifecycleMatrix("same-line-if", subject)',
    'false && runLifecycleMatrix("short-circuit", subject)',
    'if (process.env.RUN)',
    'runLifecycleMatrix("newline-if-body", subject)',
    'for (const x of xs)',
    'runLifecycleMatrix("newline-for-body", subject)',
    'if (a) foo()',
    'else',
    'runLifecycleMatrix("newline-else-body", subject)',
    'do',
    'runLifecycleMatrix("newline-do-body", subject)',
    'while (false)',
    'if (a) foo()',
    'else /* trailing block comment */',
    'runLifecycleMatrix("else-block-comment-body", subject)',
    'if (b) foo()',
    'else // trailing line comment',
    'runLifecycleMatrix("else-line-comment-body", subject)',
    'for await (const x of xs)',
    'runLifecycleMatrix("for-await-body", subject)',
  ].join("\n");
  assert.deepEqual(
    discoverSubjectRegistrations(source),
    ["asi-first", "asi-second", "after-call-asi"],
    "adjacent newline-separated registrations and a call+newline ASI boundary are recorded; same-line wrappers and control/body-keyword next-line bodies (if/for headers, else, do) — even with a block or line comment hiding the keyword — stay rejected",
  );
});

test("registeredSubjectNames ignores commented-out and string-literal runLifecycleMatrix examples", () => {
  const dir = mkdtempSync(join(tmpdir(), "lifecycle-subjects-"));
  try {
    writeFileSync(
      join(dir, "example.test.ts"),
      [
        'runLifecycleMatrix("real-subject", subject);',
        '// runLifecycleMatrix("commented-line", subject)',
        '/* runLifecycleMatrix("commented-block", subject) */',
        "const doc = 'runLifecycleMatrix(\"string-literal\", subject)';",
      ].join("\n"),
    );
    assert.deepEqual(registeredSubjectNames(dir), ["real-subject"], "only the live registration counts");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("retrieval/intent/config paths are tracked (grandfathered), not silently ignored", () => {
  const manifest = loadReal();
  for (const p of [
    "packages/remnic-core/src/entity-retrieval.ts",
    "packages/remnic-core/src/intent.ts",
    "packages/remnic-core/src/config.ts",
  ]) {
    assert.equal(classifyGlob(p, manifest), "grandfathered", `${p} must be tracked so a touch warns`);
    const { warnings, violations } = evaluateCoverage([p], manifest);
    assert.equal(violations.length, 0, `${p} must not be a hard violation yet`);
    assert.equal(warnings.length, 1, `${p} must warn, not be silently ignored by the gate`);
  }
});

test("root src/ lifecycle shims are tracked (grandfathered), not silently ignored", () => {
  const manifest = loadReal();
  for (const p of [
    "src/lifecycle.ts",
    "src/qmd-recall-cache.ts",
    "src/session-integrity.ts",
    "src/session-observer-bands.ts",
    "src/session-observer-state.ts",
  ]) {
    assert.equal(classifyGlob(p, manifest), "grandfathered", `${p} root shim must be tracked so a touch warns`);
    const { warnings, violations } = evaluateCoverage([p], manifest);
    assert.equal(violations.length, 0, `${p} must not be a hard violation yet`);
    assert.equal(warnings.length, 1, `${p} shipped root shim must warn, not be silently ignored`);
  }
});

test("the CLI reads ai-review-ignore from the base path, not the head checkout", () => {
  const dir = mkdtempSync(join(tmpdir(), "lifecycle-baseignore-"));
  try {
    const lifecyclePath = "packages/remnic-core/src/orchestrator.ts";
    const manifest = { lifecycleManifest: [lifecyclePath], coverage: {}, grandfathered: [] };
    const manifestPath = join(dir, "coverage.json");
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const emptyIgnore = join(dir, "empty-ignore.txt");
    writeFileSync(emptyIgnore, "");
    const listingIgnore = join(dir, "listing-ignore.txt");
    writeFileSync(listingIgnore, `${lifecyclePath}\n`);

    // Base ignore does NOT list the path → it is evaluated → unmapped violation.
    const notIgnored = runCli([`--manifest=${manifestPath}`, `--base-ignore=${emptyIgnore}`, `--files=${lifecyclePath}`]);
    assert.equal(notIgnored.code, 1, "a touched, unmapped lifecycle path must fail when the base does not ignore it");
    assert.match(notIgnored.output, /NO coverage mapping/);

    // Base ignore lists the path → dropped before evaluateCoverage → passes.
    // (In CI this file comes from the BASE ref, so a head-side ignore edit cannot bypass the gate.)
    const ignored = runCli([`--manifest=${manifestPath}`, `--base-ignore=${listingIgnore}`, `--files=${lifecyclePath}`]);
    assert.equal(ignored.code, 0, "only the base-ref ignore rules may drop a path from the gate");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runCli is hermetic: an ambient LIFECYCLE_BASE_MANIFEST_PATH is not compared against a temp manifest", () => {
  const dir = mkdtempSync(join(tmpdir(), "lifecycle-env-"));
  try {
    // A base with a grandfathered entry the head drops → manifestShrinkage IF compared.
    const base = {
      lifecycleManifest: ["a.ts", "b.ts"],
      coverage: { "a.ts": "extraction-lifecycle" },
      grandfathered: ["b.ts"],
    };
    const head = { lifecycleManifest: ["a.ts"], coverage: { "a.ts": "extraction-lifecycle" }, grandfathered: [] };
    const basePath = join(dir, "base.json");
    const headPath = join(dir, "head.json");
    writeFileSync(basePath, JSON.stringify(base));
    writeFileSync(headPath, JSON.stringify(head));

    const prev = process.env.LIFECYCLE_BASE_MANIFEST_PATH;
    process.env.LIFECYCLE_BASE_MANIFEST_PATH = basePath;
    try {
      // No --base-manifest arg: the inherited env must be scrubbed → no shrinkage failure.
      const hermetic = runCli([`--manifest=${headPath}`, "--files="]);
      assert.equal(
        hermetic.code,
        0,
        "runCli must scrub LIFECYCLE_BASE_MANIFEST_PATH so a temp manifest is not compared to the CI base",
      );
      // Positive control: an explicit --base-manifest is still honored.
      const explicit = runCli([`--manifest=${headPath}`, `--base-manifest=${basePath}`, "--files="]);
      assert.equal(explicit.code, 1, "an explicit --base-manifest must still be compared");
      assert.match(explicit.output, /lifecycleManifest removed path/);
      // Intentional env-driven behavior is still reachable via the `env` param.
      const viaEnv = runCli([`--manifest=${headPath}`, "--files="], { LIFECYCLE_BASE_MANIFEST_PATH: basePath });
      assert.equal(viaEnv.code, 1, "a case may opt into env-driven base comparison via the env param");
    } finally {
      if (prev === undefined) delete process.env.LIFECYCLE_BASE_MANIFEST_PATH;
      else process.env.LIFECYCLE_BASE_MANIFEST_PATH = prev;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("orchestration coverage is per-file: only files extraction-lifecycle exercises are covered", () => {
  const manifest = loadReal();
  const P = "packages/remnic-core/src/orchestration/";
  // No broad orchestration wildcard may claim coverage.
  assert.ok(
    !Object.keys(manifest.coverage).some((k) => k.endsWith("/orchestration/**")),
    "orchestration/** must not be a covered glob — it would falsely cover unexercised files",
  );
  // Files the extraction/flush/persist lifecycle actually drives → covered.
  for (const f of ["extraction-run.ts", "extraction-persist.ts", "turn-ingestion.ts", "session-context.ts"]) {
    const { covered, violations } = evaluateCoverage([P + f], manifest);
    assert.equal(violations.length, 0, `${f} must not violate`);
    assert.equal(covered.length, 1, `${f} must be covered`);
    assert.equal(covered[0].subject, "extraction-lifecycle");
  }
  // Files no current subject exercises → grandfathered (warn), never silently covered.
  for (const f of ["maintenance.ts", "recall-internal.ts", "tier-migration-coordinator.ts", "consolidation-run.ts"]) {
    const { covered, warnings, violations } = evaluateCoverage([P + f], manifest);
    assert.equal(covered.length, 0, `${f} must NOT be covered (extraction-lifecycle does not exercise it)`);
    assert.equal(violations.length, 0, `${f} is grandfathered, not a hard violation`);
    assert.equal(warnings.length, 1, `${f} must warn so its lifecycle change is visible`);
  }
  // A NEW, unlisted orchestration file cannot pass via a broad glob — it violates.
  const fresh = evaluateCoverage([P + "brand-new-coordinator.ts"], manifest);
  assert.equal(fresh.violations.length, 1, "a new orchestration file must fail the gate until covered or grandfathered");
});

test("co-located orchestration test files are ignored by the gate, not violations", () => {
  const manifest = loadReal();
  const P = "packages/remnic-core/src/orchestration/";
  // Test/spec files match the broad orchestration/** glob but are not production
  // lifecycle code — a pure test-file change must not fail (or warn on) the gate.
  for (const f of ["extraction-run.test.ts", "maintenance.test.ts", "brand-new.spec.ts", "helper.test.mts"]) {
    assert.ok(isLifecycleTestFile(P + f), `${f} must be recognized as a test file`);
    const { covered, warnings, violations } = evaluateCoverage([P + f], manifest);
    assert.deepEqual(
      { covered: covered.length, warnings: warnings.length, violations: violations.length },
      { covered: 0, warnings: 0, violations: 0 },
      `${f} must be ignored entirely by the coverage gate`,
    );
  }
  // A production source file is still evaluated (not mistaken for a test).
  assert.equal(isLifecycleTestFile(P + "extraction-run.ts"), false);
});

test("root flush-plan lifecycle entrypoint is tracked (grandfathered), not silently ignored", () => {
  const manifest = loadReal();
  const p = "src/openclaw-flush-plan-lifecycle.ts";
  assert.equal(classifyGlob(p, manifest), "grandfathered", `${p} must be tracked so a touch warns`);
  const { covered, warnings, violations } = evaluateCoverage([p], manifest);
  assert.equal(covered.length, 0);
  assert.equal(violations.length, 0, `${p} must not be a hard violation yet`);
  assert.equal(warnings.length, 1, `${p} flush-plan lifecycle change must warn, not be silently ignored`);
});

test("retrieval + namespace resolver paths are tracked (grandfathered), not silently ignored", () => {
  const manifest = loadReal();
  for (const p of [
    "packages/remnic-core/src/retrieval-agents.ts",
    "src/retrieval-agents.ts",
    "packages/remnic-core/src/retrieval-tiers.ts",
    "packages/remnic-core/src/namespaces/storage.ts",
    "packages/remnic-core/src/namespaces/search.ts",
    "packages/remnic-core/src/namespaces/catalog.ts",
    "packages/remnic-core/src/namespaces/principal.ts",
    "packages/remnic-core/src/namespaces/scope-profiles.ts",
    "packages/remnic-core/src/namespaces/identity.ts",
    "src/namespaces/storage.ts",
    "src/namespaces/search.ts",
    "src/namespaces/principal.ts",
  ]) {
    assert.equal(classifyGlob(p, manifest), "grandfathered", `${p} must be tracked so a touch warns`);
    const { covered, warnings, violations } = evaluateCoverage([p], manifest);
    assert.equal(covered.length, 0);
    assert.equal(violations.length, 0, `${p} must not be a hard violation yet`);
    assert.equal(warnings.length, 1, `${p} retrieval/namespace change must warn, not silently bypass the gate`);
  }
});

test("recall-budget subject covers the recall-output budgeting paths", () => {
  const manifest = loadReal();
  for (const p of [
    "packages/remnic-core/src/orchestration/recall-section-coordinator.ts",
    "src/orchestration/recall-section-coordinator.ts",
    "packages/remnic-core/src/retrieval.ts",
    "src/retrieval.ts",
    "packages/remnic-core/src/recall-mmr.ts",
    "packages/remnic-core/src/recall-qos.ts",
    "src/recall-qos.ts",
  ]) {
    assert.equal(classifyGlob(p, manifest), "covered", `${p} must be covered by the recall-budget subject`);
    assert.equal(manifest.coverage[p], "recall-budget", `${p} maps to the recall-budget subject`);
    const { covered, warnings, violations } = evaluateCoverage([p], manifest);
    assert.equal(covered.length, 1, `${p} touch is a covered pass`);
    assert.equal(warnings.length, 0);
    assert.equal(violations.length, 0);
  }
});

test("every committed manifest path resolves to a real file — no pre-covering absent paths", () => {
  const manifest = loadReal();
  const dirHasTs = (dir) => {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return false;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const child = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (dirHasTs(child)) return true;
      } else if (entry.name.endsWith(".ts")) {
        return true;
      }
    }
    return false;
  };
  const resolves = (p) =>
    p.endsWith("/**") ? dirHasTs(join(repoRoot, p.slice(0, -3))) : existsSync(join(repoRoot, p));
  for (const p of manifest.lifecycleManifest) {
    assert.ok(
      resolves(p),
      `manifest path ${p} resolves to no real file — remove it (do not pre-cover an absent root shim / future path)`,
    );
  }
  // coverage keys and grandfathered entries are a subset of lifecycleManifest,
  // so they are covered transitively; assert explicitly for a clear failure.
  for (const p of Object.keys(manifest.coverage)) assert.ok(resolves(p), `covered path ${p} must exist`);
  for (const p of manifest.grandfathered) assert.ok(resolves(p), `grandfathered path ${p} must exist`);
});

test("manifest removal is explained by deletion or within-lifecycle rename, not move-out", () => {
  const manifest = loadCoverageManifest({
    lifecycleManifest: ["packages/remnic-core/src/orchestrator.ts", "within-dest.ts"],
    coverage: { "packages/remnic-core/src/orchestrator.ts": "extraction-lifecycle" },
    grandfathered: ["within-dest.ts"],
  });
  // a.ts deleted; b.ts renamed to within-dest.ts (destination stays in lifecycle);
  // c.ts renamed to out/gone.ts (destination NOT in lifecycle → move-out).
  const records = parseNameStatusZ("D\0a.ts\0R100\0b.ts\0within-dest.ts\0R100\0c.ts\0out/gone.ts\0");
  const explained = deletedOrRenamedPaths(records, manifest);
  assert.ok(explained.has("a.ts"), "a deleted path explains its manifest removal");
  assert.ok(explained.has("b.ts"), "a rename whose destination stays in lifecycle explains the source removal");
  assert.ok(!explained.has("c.ts"), "a move-out rename does NOT explain removal — it stays gated by the ratchet");
  const removed = ["a.ts", "b.ts", "c.ts", "some/dir/**"];
  assert.deepEqual(
    unexplainedRemovals(removed, explained),
    ["c.ts", "some/dir/**"],
    "deletion + within-lifecycle rename removals pass; move-out and glob removals still fail",
  );
  // With no diff evidence, every removal is unexplained.
  assert.deepEqual(unexplainedRemovals(removed, deletedOrRenamedPaths([], manifest)), removed);
});

test("a deleted file under a catch-all is filtered from the gate, not a violation", () => {
  const manifest = loadReal();
  // Deleting a storage file (matches storage/** catch-all) must NOT violate:
  // the deleted path has no code left to cover. A rename SOURCE still evaluates.
  const records = parseNameStatusZ(
    "D\0packages/remnic-core/src/storage/old-store.ts\0M\0packages/remnic-core/src/orchestrator.ts\0",
  );
  const deleted = deletedPaths(records);
  assert.ok(deleted.has("packages/remnic-core/src/storage/old-store.ts"));
  assert.ok(!deleted.has("packages/remnic-core/src/orchestrator.ts"));
  const effective = flattenChangedPaths(records).filter((p) => !deleted.has(p));
  const { covered, violations } = evaluateCoverage(effective, manifest);
  assert.equal(violations.length, 0, "deleting a tracked file must not fail the gate");
  assert.equal(covered.length, 1, "the co-changed live path is still evaluated");
  assert.equal(covered[0].file, "packages/remnic-core/src/orchestrator.ts");
});

test("a rename within lifecycle evaluates the destination, not the moved source", () => {
  const manifest = loadReal();
  // Rename WITHIN lifecycle (dest matches the orchestration/** catch-all): the
  // moved-away source must be dropped so it does not double-fail; only the
  // destination is evaluated.
  const within = parseNameStatusZ(
    "R100\0packages/remnic-core/src/orchestration/old-coord.ts\0packages/remnic-core/src/orchestration/new-coord.ts\0",
  );
  const dropWithin = renameSourcesWithinLifecycle(within, manifest);
  assert.ok(dropWithin.has("packages/remnic-core/src/orchestration/old-coord.ts"), "the within-lifecycle source is dropped");
  const effWithin = flattenChangedPaths(within).filter((p) => !dropWithin.has(p));
  assert.deepEqual(effWithin, ["packages/remnic-core/src/orchestration/new-coord.ts"], "only the destination is evaluated");

  // Move OUT to an ignored/non-lifecycle path: the source is KEPT (rename-bypass
  // hardening), so moving a covered file out of coverage still surfaces it.
  const out = parseNameStatusZ(
    "R100\0packages/remnic-core/src/session-toggles.ts\0bench/artifacts/moved.ts\0",
  );
  const dropOut = renameSourcesWithinLifecycle(out, manifest);
  assert.ok(!dropOut.has("packages/remnic-core/src/session-toggles.ts"), "a move-out source is not dropped");
});

test("a NEW namespace file fails the gate via the namespaces/** catch-all", () => {
  const manifest = loadReal();
  for (const dir of ["packages/remnic-core/src/namespaces", "src/namespaces"]) {
    const fresh = evaluateCoverage([`${dir}/brand-new-resolver.ts`], manifest);
    assert.equal(fresh.violations.length, 1, `a new file under ${dir} must fail as unmapped`);
    assert.equal(fresh.warnings.length, 0);
  }
  // Existing namespace files stay grandfathered (warn), not violations.
  const existing = evaluateCoverage(["packages/remnic-core/src/namespaces/principal.ts"], manifest);
  assert.equal(existing.warnings.length, 1);
  assert.equal(existing.violations.length, 0);
});

test("the lifecycle/ directory is gated: tombstones grandfathered, a new file violates", () => {
  const manifest = loadReal();
  const existing = evaluateCoverage(["packages/remnic-core/src/lifecycle/tombstones.ts"], manifest);
  assert.equal(existing.warnings.length, 1, "tombstones.ts must warn (grandfathered), not be silently ignored");
  assert.equal(existing.violations.length, 0);
  const fresh = evaluateCoverage(["packages/remnic-core/src/lifecycle/brand-new.ts"], manifest);
  assert.equal(fresh.violations.length, 1, "a new lifecycle/ file must fail as unmapped via the catch-all");
  assert.equal(fresh.warnings.length, 0);
});

test("retrieval freshness entrypoints are tracked (grandfathered), not silently ignored", () => {
  const manifest = loadReal();
  for (const p of [
    "packages/remnic-core/src/harmonic-retrieval.ts",
    "src/harmonic-retrieval.ts",
    "packages/remnic-core/src/causal-retrieval.ts",
    "src/causal-retrieval.ts",
    "packages/remnic-core/src/temporal-supersession.ts",
  ]) {
    assert.equal(classifyGlob(p, manifest), "grandfathered", `${p} must be tracked so a touch warns`);
    const { covered, warnings, violations } = evaluateCoverage([p], manifest);
    assert.equal(covered.length, 0);
    assert.equal(violations.length, 0, `${p} must not be a hard violation yet`);
    assert.equal(warnings.length, 1, `${p} freshness change must warn, not silently bypass the gate`);
  }
});

test("recall lifecycle modules are tracked (grandfathered), not silently ignored", () => {
  const manifest = loadReal();
  for (const p of [
    "packages/remnic-core/src/recall-state.ts",
    "src/recall-state.ts",
    "packages/remnic-core/src/recall-query-policy.ts",
    "src/recall-query-policy.ts",
    "packages/remnic-core/src/verified-recall.ts",
    "src/verified-recall.ts",
  ]) {
    assert.equal(classifyGlob(p, manifest), "grandfathered", `${p} must be tracked so a touch warns`);
    const { warnings, violations } = evaluateCoverage([p], manifest);
    assert.equal(violations.length, 0, `${p} must not be a hard violation yet`);
    assert.equal(warnings.length, 1, `${p} recall lifecycle change must warn, not silently bypass the gate`);
  }
});

test("the maintenance/ directory is gated: namespace-maintenance modules grandfathered, new files violate", () => {
  const manifest = loadReal();
  for (const p of [
    "packages/remnic-core/src/maintenance/namespace-planner.ts",
    "packages/remnic-core/src/maintenance/namespace-maintenance-fanout.ts",
  ]) {
    const { warnings, violations } = evaluateCoverage([p], manifest);
    assert.equal(warnings.length, 1, `${p} must warn (grandfathered)`);
    assert.equal(violations.length, 0);
  }
  const fresh = evaluateCoverage(["packages/remnic-core/src/maintenance/brand-new-maintenance.ts"], manifest);
  assert.equal(fresh.violations.length, 1, "a new maintenance/ module must fail as unmapped via the catch-all");
  assert.equal(fresh.warnings.length, 0);
});
