import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  isArtifactOnlyPullRequest,
  isIgnoredPath,
  parseIgnoreManifest,
  splitEffectiveDiff,
} from "../scripts/effective-diff.mjs";

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

test("parseIgnoreManifest skips comments/blanks and returns patterns in order", () => {
  const patterns = parseIgnoreManifest("# c\n\nfoo/**\n  bar.json  \n");
  assert.deepEqual(patterns, ["foo/**", "bar.json"]);
});

test("parseIgnoreManifest rejects negation, leading slash, and backslashes loudly", () => {
  assert.throws(() => parseIgnoreManifest("!foo\n"), /line 1: unsupported pattern "!foo"/);
  assert.throws(() => parseIgnoreManifest("# ok\n/abs/path\n"), /line 2: unsupported/);
  assert.throws(() => parseIgnoreManifest("a\\b\n"), /forward slashes/);
  assert.throws(() => parseIgnoreManifest(42), /must be a string/);
});

test("pattern semantics: *, **, ?, and directory suffix", () => {
  const p = (s) => parseIgnoreManifest(s);
  // * stays within a segment
  assert.equal(isIgnoredPath("a/b.json", p("a/*.json")), true);
  assert.equal(isIgnoredPath("a/x/b.json", p("a/*.json")), false);
  // ** crosses segments (including zero segments for `**/`)
  assert.equal(isIgnoredPath("a/x/y/b.json", p("a/**/b.json")), true);
  assert.equal(isIgnoredPath("a/b.json", p("a/**/b.json")), true);
  assert.equal(isIgnoredPath("deep/x/lock.yaml", p("**/lock.yaml")), true);
  assert.equal(isIgnoredPath("lock.yaml", p("**/lock.yaml")), true);
  // ? matches exactly one non-separator char
  assert.equal(isIgnoredPath("v1.json", p("v?.json")), true);
  assert.equal(isIgnoredPath("v12.json", p("v?.json")), false);
  assert.equal(isIgnoredPath("v/x.json", p("v?.json")), false);
  // trailing slash anchors a directory prefix
  assert.equal(isIgnoredPath("bench/baselines/deep/file.json", p("bench/baselines/")), true);
  assert.equal(isIgnoredPath("bench/baselines-sibling/file.json", p("bench/baselines/")), false);
  // regex metacharacters in paths are literal
  assert.equal(isIgnoredPath("a+b/c.json", p("a+b/*.json")), true);
  assert.equal(isIgnoredPath("axb/c.json", p("a+b/*.json")), false);
});

test("splitEffectiveDiff handles strings and API file objects, and rejects pathless entries", () => {
  const patterns = parseIgnoreManifest("gen/\n*.lock\n");
  const { effective, ignored } = splitEffectiveDiff(
    ["src/a.ts", { filename: "gen/out.json" }, { path: "b.lock" }],
    patterns,
  );
  assert.deepEqual(effective, ["src/a.ts"]);
  assert.deepEqual(ignored, ["gen/out.json", "b.lock"]);
  assert.throws(() => splitEffectiveDiff([{}], patterns), /no usable path/);
  assert.throws(() => splitEffectiveDiff("nope", patterns), /must be an array/);
});

test("artifact-only detection: empty file list is never artifact-only", () => {
  const patterns = parseIgnoreManifest("gen/\n");
  assert.equal(isArtifactOnlyPullRequest([], patterns), false);
  assert.equal(isArtifactOnlyPullRequest(["gen/a.json", "gen/b.json"], patterns), true);
  assert.equal(isArtifactOnlyPullRequest(["gen/a.json", "src/x.ts"], patterns), false);
});

test("scales to artifact PRs beyond one API page (3000 files)", () => {
  const patterns = parseIgnoreManifest("packages/bench/baselines/\n");
  const files = Array.from({ length: 3000 }, (_, i) => `packages/bench/baselines/f${i}.json`);
  assert.equal(isArtifactOnlyPullRequest(files, patterns), true);
  files.push("packages/remnic-core/src/storage.ts");
  assert.equal(isArtifactOnlyPullRequest(files, patterns), false);
});

test("the committed manifest parses and classifies known repo paths correctly", () => {
  const manifest = readFileSync(path.join(REPO_ROOT, ".github", "ai-review-ignore"), "utf8");
  const patterns = parseIgnoreManifest(manifest);
  assert.ok(patterns.length > 0);
  // Ignored: bench baselines, lockfiles anywhere, machine-written baselines.
  assert.equal(isIgnoredPath("packages/bench/src/benchmarks/published/beam/artifacts/run1.json", patterns), true);
  assert.equal(isIgnoredPath("pnpm-lock.yaml", patterns), true);
  assert.equal(isIgnoredPath("packages/hermes-provider/package-lock.json", patterns), true);
  assert.equal(isIgnoredPath("scripts/ratchet-baseline.json", patterns), true);
  // NOT ignored: real source, tests, workflows, plugin manifests, docs.
  assert.equal(isIgnoredPath("packages/remnic-core/src/storage.ts", patterns), false);
  assert.equal(isIgnoredPath("packages/plugin-openclaw/openclaw.plugin.json", patterns), false);
  assert.equal(isIgnoredPath(".github/workflows/ci.yml", patterns), false);
  assert.equal(isIgnoredPath("docs/timeline.md", patterns), false);
  assert.equal(isIgnoredPath("packages/bench/src/adapters/remnic-adapter.ts", patterns), false);
});

test("renames from source paths into artifact paths stay effective (round 2)", () => {
  const patterns = parseIgnoreManifest("gen/\n");
  const { effective, ignored } = splitEffectiveDiff(
    [
      { filename: "gen/moved.json", previous_filename: "src/real-code.ts", status: "renamed" },
      { filename: "gen/shuffled.json", previous_filename: "gen/old-name.json", status: "renamed" },
      { filename: "gen/plain.json" },
    ],
    patterns,
  );
  assert.deepEqual(effective, ["gen/moved.json"]);
  assert.deepEqual(ignored, ["gen/shuffled.json", "gen/plain.json"]);
  // A PR that only renames source into artifact dirs is NOT artifact-only.
  assert.equal(
    isArtifactOnlyPullRequest(
      [{ filename: "gen/moved.json", previous_filename: "src/real-code.ts" }],
      patterns,
    ),
    false,
  );
});

test("published bench inputs (profiles, baselines) are no longer ignored (rounds 2-3)", () => {
  const manifest = readFileSync(path.join(REPO_ROOT, ".github", "ai-review-ignore"), "utf8");
  const patterns = parseIgnoreManifest(manifest);
  assert.equal(isIgnoredPath("packages/bench/profiles/README.md", patterns), false);
  assert.equal(isIgnoredPath("packages/bench/baselines/coding-graph-baseline.json", patterns), false);
  assert.equal(isIgnoredPath("packages/bench/src/benchmarks/published/beam/artifacts/out.json", patterns), true);
});
