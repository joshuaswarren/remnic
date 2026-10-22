import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { byteLineStarts, parseHunkAddedLines, parseOxlintJson, spanLines } from "./check-anti-slop.mjs";

const WORKTREE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const RUNNER = fileURLToPath(new URL("./check-anti-slop.mjs", import.meta.url));

// Fixture commits inherit the repository's configured identity; invented
// synthetic identities are rejected by the host guard.
function repoGitIdentity(key, format) {
  let result = spawnSync("git", ["-C", WORKTREE_ROOT, "config", key], { encoding: "utf8" });
  if (result.status !== 0 || !result.stdout.trim()) {
    result = spawnSync("git", ["-C", WORKTREE_ROOT, "log", "-1", `--format=${format}`], { encoding: "utf8" });
  }
  assert.equal(result.status, 0, `could not resolve fixture identity: ${key}`);
  return result.stdout.trim();
}
const GIT_NAME = repoGitIdentity("user.name", "%an");
const GIT_EMAIL = repoGitIdentity("user.email", "%ae");
const GIT_IDENTITY = ["-c", `user.name=${GIT_NAME}`, "-c", `user.email=${GIT_EMAIL}`];

const VIOLATION = "type AliasHidesUnknown = string | unknown;\n";
const MULTI_LINE_VIOLATION = "export type Wide =\n  | string\n  | unknown;\n";
const CLEAN_SOURCE = "export const ready = true;\n";

function git(root, args) {
  const result = spawnSync("git", ["-C", root, ...GIT_IDENTITY, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
}

function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), "anti-slop-gate-"));
  git(root, ["init", "-q"]);
  git(root, ["config", "commit.gpgsign", "false"]);
  return root;
}

function write(root, file, content) {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), content);
}

function commitAll(root, message) {
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "--allow-empty", "-m", message]);
}

function runGate(root, args = []) {
  return spawnSync(process.execPath, [RUNNER, "--root", root, ...args], {
    encoding: "utf8",
    // An inherited CI value would hijack default-resolution cases; empty is
    // treated as unset by the runner.
    env: { ...process.env, REMNIC_ANTI_SLOP_BASE_REF: "" },
  });
}

function assertStatus(result, expected, label) {
  assert.equal(result.status, expected, `${label}: expected status ${expected}, got ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
}

test("clean diffs and no-source diffs pass with an explicit clean result", (t) => {
  const root = makeRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  commitAll(root, "base");
  write(root, "README.md", "# changed\n");
  let result = runGate(root, ["--base", "HEAD"]);
  assertStatus(result, 0, "README-only change");
  assert.match(result.stdout, /no changed JavaScript\/TypeScript sources/);
  write(root, "clean.ts", CLEAN_SOURCE);
  commitAll(root, "clean source");
  result = runGate(root, ["--base", "HEAD"]);
  assertStatus(result, 0, "clean tree");
  assert.match(result.stdout, /no changed JavaScript\/TypeScript sources/);
});

test("unchanged violations do not block a clean edit in the same file", (t) => {
  const root = makeRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  write(root, "mixed.ts", `${VIOLATION}export const kept = 1;\n`);
  commitAll(root, "base with committed debt");
  write(root, "mixed.ts", `${VIOLATION}export const kept = 1;\nexport const added = 2;\n`);
  const result = runGate(root, ["--base", "HEAD"]);
  assertStatus(result, 0, "clean edit next to committed debt");
  assert.match(result.stdout, /no anti-slop findings/);
});

test("introduced violations fail even when another violation is removed", (t) => {
  const root = makeRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  write(root, "swapped.ts", `${VIOLATION}const between = 1;\n`);
  commitAll(root, "one existing violation");
  // Removes the existing violation and introduces a new multi-line one: the
  // count is unchanged, the gate must still fail on the added lines.
  write(root, "swapped.ts", `const between = 1;\n${MULTI_LINE_VIOLATION}`);
  git(root, ["config", "color.ui", "always"]);
  const result = runGate(root, ["--base", "HEAD"]);
  assertStatus(result, 1, "count-neutral introduction");
  assert.match(result.stderr, /swapped\.ts/);
  assert.match(result.stderr, /anti-slop\(no-unknown-type-aliases\)/);
});

test("new, staged, renamed, and new-extension sources are scanned whole, including paths with spaces", (t) => {
  const root = makeRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  write(root, "kept file.ts", CLEAN_SOURCE);
  commitAll(root, "base");

  write(root, "new file.ts", VIOLATION);
  assertStatus(runGate(root, ["--base", "HEAD"]), 1, "untracked file");

  git(root, ["add", "new file.ts"]);
  assertStatus(runGate(root, ["--base", "HEAD"]), 1, "staged file");

  commitAll(root, "untracked becomes committed debt");
  // Pure rename of a path that already holds committed debt: the new path
  // has no base revision, so the whole file must be scanned.
  git(root, ["mv", "new file.ts", "moved file.ts"]);
  let result = runGate(root, ["--base", "HEAD"]);
  assertStatus(result, 1, "renamed path scanned whole");
  assert.match(result.stderr, /moved file\.ts/);

  rmSync(join(root, "moved file.ts"));
  write(root, "notes.md", VIOLATION);
  commitAll(root, "add non-source debt");
  git(root, ["mv", "notes.md", "notes.ts"]);
  result = runGate(root, ["--base", "HEAD"]);
  assertStatus(result, 1, "new extension scanned whole");
  assert.match(result.stderr, /notes\.ts/);
});

test("unresolvable bases, missing defaults, and syntax errors fail closed", (t) => {
  const root = makeRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  write(root, "clean.ts", CLEAN_SOURCE);
  commitAll(root, "base");

  let result = runGate(root, ["--base", "no-such-ref"]);
  assertStatus(result, 2, "invalid explicit base");
  assert.match(result.stderr, /does not resolve/);
  for (const args of [["--base="], ["--base"], ["--root="], ["--root"]]) {
    assertStatus(runGate(root, args), 2, `invalid arguments ${args.join(" ")}`);
  }

  result = runGate(root);
  assertStatus(result, 2, "default base without origin/main");
  assert.match(result.stderr, /cannot resolve a base ref/);

  const rootCommit = makeRepo();
  t.after(() => rmSync(rootCommit, { recursive: true, force: true }));
  write(rootCommit, "clean.ts", CLEAN_SOURCE);
  commitAll(rootCommit, "root commit");
  git(rootCommit, ["branch", "origin/main"]);
  result = runGate(rootCommit);
  assertStatus(result, 2, "merge-base equals HEAD with no parent");
  assert.match(result.stderr, /no parent commit/);

  write(root, "broken.ts", "const = = ;\n");
  result = runGate(root, ["--base", "HEAD"]);
  assertStatus(result, 2, "syntax error in changed source");
  assert.match(result.stderr, /syntax error/);
});

test("default resolution uses the origin/main merge-base and falls back to HEAD^ when equal", (t) => {
  const root = makeRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  write(root, "clean.ts", CLEAN_SOURCE);
  commitAll(root, "base");
  git(root, ["branch", "origin/main"]);
  write(root, "late.ts", VIOLATION);
  commitAll(root, "introduce violation");

  let result = runGate(root);
  assertStatus(result, 1, "merge-base detects the violation");
  assert.match(result.stderr, /late\.ts/);

  git(root, ["branch", "-f", "origin/main", "HEAD"]);
  result = runGate(root);
  assertStatus(result, 1, "equal-HEAD fallback to HEAD^ still detects");
  assert.match(result.stderr, /late\.ts/);
});

test("parsers fail closed on malformed tool output and map hunks and spans to lines", () => {
  assert.throws(() => parseOxlintJson("not json"), /malformed oxlint JSON/);
  assert.throws(() => parseOxlintJson('{"number_of_files":1}'), /diagnostics array/);
  assert.throws(() => parseOxlintJson('{"diagnostics":"all"}'), /diagnostics array/);
  assert.throws(() => parseOxlintJson('{"diagnostics":[null]}'), /must be objects/);
  assert.deepEqual(parseOxlintJson('{"diagnostics":[]}'), []);

  assert.deepEqual(parseHunkAddedLines("@@ -1 +1 @@\n+one\n"), new Set([1]));
  assert.deepEqual(parseHunkAddedLines("@@ -0,0 +3,2 @@\n+three\n+four\n"), new Set([3, 4]));
  assert.deepEqual(parseHunkAddedLines("@@ -5,3 +5,0 @@\n-removed\n"), new Set());
  assert.deepEqual(parseHunkAddedLines("@@ -1 +1 @@ trailing section\n+one\n"), new Set([1]));

  const lineStarts = byteLineStarts(Buffer.from("ab\ncde\n"));
  assert.deepEqual(lineStarts, [0, 3, 7]);
  assert.deepEqual(spanLines({ offset: 1, length: 4 }, lineStarts), [1, 2]);
  assert.deepEqual(spanLines({ offset: 3, length: 0 }, lineStarts), [2, 2]);
  assert.deepEqual(spanLines({ offset: 0, length: 6 }, lineStarts), [1, 2]);
  for (const span of [{ offset: -1, length: 1 }, { offset: 0, length: -1 }, { offset: 1.5, length: 1 }, { offset: 20, length: 1 }]) {
    assert.throws(() => spanLines(span, lineStarts, 7), /invalid source span/);
  }
  const unicode = byteLineStarts(Buffer.from("\ufeffé\nnext\n"));
  assert.deepEqual(spanLines({ offset: 6, length: 4 }, unicode, 11), [2, 2]);
});

test("gate wiring contract in root package, config, and CI files", () => {
  const pkg = JSON.parse(readFileSync(join(WORKTREE_ROOT, "package.json"), "utf8"));
  assert.match(pkg.scripts.lint, /test:anti-slop/);
  assert.match(pkg.scripts.lint, /check:anti-slop-types/);
  assert.match(pkg.scripts.lint, /lint:anti-slop/);
  assert.match(pkg.scripts["lint:anti-slop"], /scripts\/check-anti-slop\.mjs/);
  assert.match(pkg.scripts["test:anti-slop"], /scripts\/check-anti-slop\.test\.mjs/);

  const config = JSON.parse(readFileSync(join(WORKTREE_ROOT, ".oxlintrc.json"), "utf8"));
  assert.equal(config.categories.correctness, "off");
  assert.deepEqual(config.jsPlugins, [{ name: "anti-slop", specifier: "./tools/oxlint/anti-slop/index.ts" }]);
  const rules = Object.entries(config.rules).filter(([name]) => name.startsWith("anti-slop/"));
  assert.equal(rules.length, 15);
  assert.ok(rules.every(([, level]) => level === "error"));

  const ci = readFileSync(join(WORKTREE_ROOT, ".github", "workflows", "ci.yml"), "utf8");
  assert.match(ci, /REMNIC_ANTI_SLOP_BASE_REF/);
  assert.match(ci, /Lint \(Biome and scoped anti-slop\)/);
  assert.match(ci, /run: pnpm run lint/);
  assert.match(ci, /needs: \[checks, tests, build-artifacts, lifecycle-matrix\]/);
  assert.match(ci, /select\(\.value\.result != "success"\)/);
});
