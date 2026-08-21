// Regex-safety pre-check tests (issue #2439).
//
// Mirrors check-dataset-hygiene.test.mjs conventions: spawnSync the script
// against fixture files built at runtime in a temp dir (so known-bad regex
// literals never land in committed source), assert exit codes + output.
// The git-diff mode test builds a throwaway git repo to pin changed-line
// scoping (only lines added since the base commit are scanned).

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { REDOS_SHAPES } from "../scripts/check-regex-safety.mjs";

const SCRIPT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "scripts",
  "check-regex-safety.mjs",
);

function runScript(args, cwd = process.cwd(), env = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

function withTempDir(prefix, fn) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function git(cwd, args) {
  execFileSync("git", ["-c", "user.email=dev@example.com", "-c", "user.name=Dev", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

// One line per flagged shape class, plus a second lazy-any shape.
const BAD_FIXTURE = [
  "// Known-bad ReDoS shapes (issue #2439 fixtures).",
  "export const wrapper = /<supermemory-context[^>]*>[\\s\\S]*?<\\/supermemory-context>/;",
  "export const lazyAny = /^start(.*?)end(.*?)$/;",
  "export const altClass = /<tag(?:b|strong)[^>]*>/;",
  "export const wsChain = /^(\\s*)([a-z]+)(\\s*)(\\d+)$/;",
  "export const nested = /(a+)+b/;",
  "",
].join("\n");

const GOOD_FIXTURE = [
  "// Benign regexes — bounded or unambiguous shapes must pass.",
  "export const isoDate = /^\\d{4}-\\d{2}-\\d{2}$/;",
  "export const words = /[a-z]+/g;",
  "export const split = /\\s+/;",
  "export const boundedTag = /<supermemory-context[^>]{0,256}>/;",
  "export const proto = /^https?:\\/\\/\\S+$/;",
  "const ratio = total / count / scale;",
  'const note = "contains [a-z]* and .*? inside a string";',
  "export const boundedRep = /(\\d{2})+/;",
  "export const literalStar = /(\\*)+/;",
  "const afterBlock = 1; /* note /fake[\\s\\S]*?re/ here */",
  " * const jsdoc = /[\\s\\S]*?x/;",
  "// comment with /fake.*?regex/ never scanned",
  "",
].join("\n");

test("flags every known ReDoS shape class from the issue body", () => {
  withTempDir("regex-safety-bad-", (dir) => {
    const bad = path.join(dir, "bad.ts");
    writeFileSync(bad, BAD_FIXTURE);

    const res = runScript([bad]);
    const output = `${res.stdout}\n${res.stderr}`;
    assert.equal(res.status, 1, output);
    assert.match(res.stderr, /bad\.ts:2: \[lazy-any\]/);
    assert.match(res.stderr, /\[\\s\\S\]\*\?/);
    assert.match(res.stderr, /bad\.ts:3: \[lazy-any\]/);
    assert.match(res.stderr, /bad\.ts:4: \[negated-class-alternation\]/);
    assert.match(res.stderr, /mirrors CodeQL js\/polynomial-redos/);
    assert.match(res.stderr, /bad\.ts:5: \[ws-capture-chain\]/);
    assert.match(res.stderr, /bad\.ts:6: \[nested-quantifier\]/);
    assert.match(res.stderr, /mirrors CodeQL js\/redos/);
  });
});

test("passes on benign regexes, division, strings, and comments", () => {
  withTempDir("regex-safety-good-", (dir) => {
    const good = path.join(dir, "good.ts");
    writeFileSync(good, GOOD_FIXTURE);

    const res = runScript([good]);
    assert.equal(res.status, 0, `${res.stdout}\n${res.stderr}`);
    assert.match(res.stdout, /Regex safety check passed/);
  });
});

test("ignores files that are not .ts/.mts", () => {
  withTempDir("regex-safety-ext-", (dir) => {
    const js = path.join(dir, "notscanned.js");
    writeFileSync(js, 'export const x = /[\\s\\S]*?y/;\n');
    const res = runScript([js]);
    assert.equal(res.status, 0, `${res.stdout}\n${res.stderr}`);
  });
});

test("nested-quantifier distinguishes bounded from unbounded brace repetition", () => {
  withTempDir("regex-safety-brace-", (dir) => {
    const safe = path.join(dir, "safe.ts");
    writeFileSync(safe, "export const pairs = /(\\d{2})+/;\n");
    assert.equal(runScript([safe]).status, 0);

    const risky = path.join(dir, "risky.ts");
    writeFileSync(risky, "export const unbounded = /(\\d{2,})+/;\n");
    const res = runScript([risky]);
    assert.equal(res.status, 1, `${res.stdout}\n${res.stderr}`);
    assert.match(res.stderr, /risky\.ts:1: \[nested-quantifier\]/);
  });
});

test("a closed same-line block comment masks only its own span; swapped any-pairs still fire", () => {
  withTempDir("regex-safety-block-", (dir) => {
    // Regex after the closing */ on the same line must be scanned.
    const blinded = path.join(dir, "after-close.ts");
    writeFileSync(blinded, "const a = 1; /* note */ const bad = /[\\s\\S]*?y/;\n");
    const res = runScript([blinded]);
    assert.equal(res.status, 1, `${res.stdout}\n${res.stderr}`);
    assert.match(res.stderr, /after-close\.ts:1: \[lazy-any\]/);

    // Regex inside the comment span is ignored; code after it is clean.
    const masked = path.join(dir, "inside-comment.ts");
    writeFileSync(masked, "const a = 1; /* /fake[\\s\\S]*?x/ */ const ok = /\\d+/;\n");
    assert.equal(runScript([masked]).status, 0);

    // Complementary pairs in either spelling are flagged.
    for (const [name, re] of [
      ["swapped", "[\\S\\s]*?"],
      ["wordpair", "[\\w\\W]*"],
      ["digitpair", "[\\d\\D]+"],
    ]) {
      const f = path.join(dir, `${name}.ts`);
      writeFileSync(f, `export const v = /${re}x/;\n`);
      const hit = runScript([f]);
      assert.equal(hit.status, 1, `${name}: ${hit.stdout}\n${hit.stderr}`);
      assert.match(hit.stderr, new RegExp(`${name}\\.ts:1: \\[lazy-any\\]`));
    }
  });
});

test("scans only lines added since the base commit, including uncommitted edits", () => {
  withTempDir("regex-safety-git-", (dir) => {
    const repo = path.join(dir, "repo");
    mkdirSync(repo, { recursive: true });
    git(repo, ["init", "-q"]);
    const target = path.join(repo, "scan.ts");
    // Commit 1: a ReDoS shape that predates the scan base.
    writeFileSync(target, "export const stale = /[\\s\\S]*?x/;\n");
    git(repo, ["add", "scan.ts"]);
    git(repo, ["commit", "-q", "-m", "base with a stale bad shape"]);
    // Commit 2: benign addition only.
    appendFileSync(target, "export const fresh = /abc/;\n");
    git(repo, ["add", "scan.ts"]);
    git(repo, ["commit", "-q", "-m", "benign addition"]);

    // The committed bad line predates HEAD~1, so the changed-line scan passes.
    const clean = runScript([], repo, { REMNIC_REGEX_SAFETY_ROOT: repo });
    assert.equal(clean.status, 0, `${clean.stdout}\n${clean.stderr}`);

    // An uncommitted bad line IS in the worktree diff and must fail with
    // its exact file:line.
    appendFileSync(target, "export const freshBad = /[\\s\\S]*?y/;\n");
    const dirty = runScript([], repo, { REMNIC_REGEX_SAFETY_ROOT: repo });
    assert.equal(dirty.status, 1, `${dirty.stdout}\n${dirty.stderr}`);
    assert.match(dirty.stderr, /scan\.ts:3: \[lazy-any\]/);
    assert.doesNotMatch(dirty.stderr, /scan\.ts:1/);

    // Committing the bad line keeps it in the HEAD~1..worktree diff: a
    // push event with a clean tree still scans the last commit.
    git(repo, ["add", "scan.ts"]);
    git(repo, ["commit", "-q", "-m", "add bad shape"]);
    const committed = runScript([], repo, { REMNIC_REGEX_SAFETY_ROOT: repo });
    assert.equal(committed.status, 1, `${committed.stdout}\n${committed.stderr}`);
    assert.match(committed.stderr, /scan\.ts:3: \[lazy-any\]/);

    // An untracked brand-new .ts file is fully "added" and must be scanned.
    writeFileSync(path.join(repo, "untracked.ts"), "export const u = /[\\s\\S]*?z/;\n");
    const withUntracked = runScript([], repo, { REMNIC_REGEX_SAFETY_ROOT: repo });
    assert.equal(withUntracked.status, 1, `${withUntracked.stdout}\n${withUntracked.stderr}`);
    assert.match(withUntracked.stderr, /untracked\.ts:1: \[lazy-any\]/);
  });
});

test("shape table keeps the four issue-body classes with CodeQL mappings", () => {
  assert.deepEqual(
    REDOS_SHAPES.map((s) => `${s.id}→${s.codeql}`),
    [
      "lazy-any→js/polynomial-redos",
      "negated-class-alternation→js/polynomial-redos",
      "ws-capture-chain→js/polynomial-redos",
      "nested-quantifier→js/redos",
    ],
  );
});
