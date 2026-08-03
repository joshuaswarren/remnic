import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * The ClawPack packlist gate is the last thing between a broken build and a
 * published plugin nobody can install. It regressed once already: an older
 * `>= 2 dist files` assertion silently encoded one code-split chunk as a
 * requirement, and deleting that module left the gate unsatisfiable, blocking
 * every release for days. These tests pin what the gate actually promises, so
 * the next packaging change fails here rather than on npm.
 */

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "verify-openclaw-clawpack.mjs");

/** Every temp root these fixtures create, removed once at the end. */
const tempRoots = [];
function makeTempRoot() {
  const root = mkdtempSync(path.join(tmpdir(), "clawpack-test-"));
  tempRoots.push(root);
  return root;
}
after(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

/** A minimal package that satisfies the gate: manifest, README, one real bundle. */
function makeFixture(overrides = {}) {
  const root = makeTempRoot();
  const pkgDir = path.join(root, "pkg");
  mkdirSync(path.join(pkgDir, "dist"), { recursive: true });
  writeFileSync(
    path.join(pkgDir, "package.json"),
    JSON.stringify({
      name: "@remnic/plugin-openclaw-fixture",
      version: "0.0.0",
      type: "module",
      main: "dist/index.js",
      files: overrides.files ?? ["dist", "openclaw.plugin.json"],
    }),
  );
  writeFileSync(path.join(pkgDir, "README.md"), "# fixture\n");
  writeFileSync(path.join(pkgDir, "openclaw.plugin.json"), JSON.stringify({ id: "fixture" }));
  writeFileSync(path.join(pkgDir, "dist", "index.js"), overrides.entry ?? "x".repeat(64 * 1024));
  for (const [name, body] of Object.entries(overrides.extraDist ?? {})) {
    writeFileSync(path.join(pkgDir, "dist", name), body);
  }
  return pkgDir;
}

function run(pkgDir) {
  return spawnSync(process.execPath, [SCRIPT, pkgDir], { encoding: "utf8" });
}

test("a complete package passes", () => {
  const result = run(makeFixture());
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Verified/);
});

test("a single-file dist passes — chunk count is not the contract", () => {
  // The exact regression: one dist file is a perfectly valid build.
  const result = run(makeFixture());
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /1 dist files/);
});

test("a code-split chunk left out of the packlist fails", () => {
  // The invariant the old count was reaching for: an emitted chunk that npm
  // does not pack breaks the plugin at runtime with a module-not-found.
  const pkgDir = makeFixture({
    files: ["dist/index.js", "openclaw.plugin.json"],
    extraDist: { "legacy-chunk-ABCD1234.js": "export const x = 1;\n" },
  });

  const result = run(pkgDir);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /built dist\/legacy-chunk-ABCD1234\.js but the packlist omits them/);
});

test("an unbuilt package fails instead of publishing an empty plugin", () => {
  const root = makeTempRoot();
  const pkgDir = path.join(root, "pkg");
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(
    path.join(pkgDir, "package.json"),
    JSON.stringify({ name: "fixture", version: "0.0.0", type: "module", files: ["dist", "openclaw.plugin.json"] }),
  );
  writeFileSync(path.join(pkgDir, "README.md"), "# fixture\n");
  writeFileSync(path.join(pkgDir, "openclaw.plugin.json"), JSON.stringify({ id: "fixture" }));

  const result = run(pkgDir);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /missing dist\/index\.js|no built dist/);
});

test("a small but real entry bundle passes — the shim package legitimately ships one", () => {
  const result = run(makeFixture({ entry: "export * from \"@remnic/core\";\n" }));
  assert.equal(result.status, 0, result.stderr);
});

test("an empty entry bundle fails", () => {
  const result = run(makeFixture({ entry: "" }));

  assert.equal(result.status, 1);
  assert.match(result.stderr, /packs an empty dist\/index\.js/);
});

test("an oversized manifest fails the OpenClaw 256 KiB host cap", () => {
  const pkgDir = makeFixture();
  writeFileSync(path.join(pkgDir, "openclaw.plugin.json"), JSON.stringify({ pad: "p".repeat(300 * 1024) }));

  const result = run(pkgDir);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /OpenClaw rejects manifests/);
});

test("a symlinked package root is refused rather than scanned", () => {
  const real = makeFixture();
  const link = path.join(path.dirname(real), "linked-pkg");
  symlinkSync(real, link, "dir");

  const result = run(link);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /package directory is a symlink/);
});

test("a symlinked dist root is refused rather than scanned", () => {
  const pkgDir = makeFixture();
  const elsewhere = path.join(path.dirname(pkgDir), "elsewhere");
  renameSync(path.join(pkgDir, "dist"), elsewhere);
  symlinkSync(elsewhere, path.join(pkgDir, "dist"), "dir");

  const result = run(pkgDir);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /dist directory is a symlink/);
});

test("a dangling symlink inside dist is refused, not thrown on", () => {
  const pkgDir = makeFixture();
  symlinkSync("/nonexistent/target.js", path.join(pkgDir, "dist", "linked.js"));

  const result = run(pkgDir);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /dist\/linked\.js is a symlink/);
});

test("a symlink inside dist pointing at a real file is refused too", () => {
  const pkgDir = makeFixture();
  symlinkSync(path.join(pkgDir, "dist", "index.js"), path.join(pkgDir, "dist", "linked.js"), "file");

  const result = run(pkgDir);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /dist\/linked\.js is a symlink/);
});

test("a prepack script that creates dist/ is honored, not pre-judged", () => {
  // Existence is re-read after `npm pack`, so a package whose prepack builds
  // into dist/ is not rejected on the pre-pack snapshot.
  const root = makeTempRoot();
  const pkgDir = path.join(root, "pkg");
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(
    path.join(pkgDir, "package.json"),
    JSON.stringify({
      name: "prepack-fixture",
      version: "0.0.0",
      type: "module",
      main: "dist/index.js",
      files: ["dist", "openclaw.plugin.json"],
      scripts: { prepack: "node -e \"require('node:fs').mkdirSync('dist',{recursive:true});require('node:fs').writeFileSync('dist/index.js','export const x=1;\\n')\"" },
    }),
  );
  writeFileSync(path.join(pkgDir, "README.md"), "# fixture\n");
  writeFileSync(path.join(pkgDir, "openclaw.plugin.json"), JSON.stringify({ id: "fixture" }));

  const result = run(pkgDir);

  assert.equal(result.status, 0, result.stderr);
});

test("a symlinked directory inside dist is refused before it is descended into", () => {
  // Node's recursive readdirSync follows directory links while building its
  // result, so the walk must lstat each entry before descending or it will have
  // already enumerated whatever the link points at.
  const pkgDir = makeFixture();
  const outside = path.join(path.dirname(pkgDir), "outside");
  mkdirSync(outside, { recursive: true });
  writeFileSync(path.join(outside, "leaked.js"), "export const leaked = 1;\n");
  symlinkSync(outside, path.join(pkgDir, "dist", "nested"), "dir");

  const result = run(pkgDir);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /dist\/nested is a symlink/);
  assert.doesNotMatch(result.stderr, /leaked\.js/, "the link target was never enumerated");
});
