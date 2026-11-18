import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildImportGraph,
  buildReverseIndex,
  extractSpecifiers,
  isGlobalChange,
  listImportableFiles,
  loadPackageIndex,
  resolveSpecifier,
  selectShadowRun,
} from "../scripts/test-selection-shadow-lib.mjs";

function makeFixture() {
  const root = mkdtempSync(path.join(tmpdir(), "ts-sel-"));
  const write = (rel, content) => {
    const full = path.join(root, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  };
  write("tests/a.test.ts", 'import { f } from "../src/feature.js";\nimport { w } from "@remnic/core/widget";\n');
  write("tests/b.test.ts", 'import { o } from "../src/other.js";\n');
  write("src/feature.ts", 'import { d } from "./deep/dep.js";\nexport const f = d;\n');
  write("src/deep/dep.ts", "export const d = 1;\n");
  write("src/other.ts", "export const o = 2;\n");
  write(
    "packages/remnic-core/package.json",
    JSON.stringify({
      name: "@remnic/core",
      exports: { "./widget": { "remnic-source": "./src/widget.ts", import: "./dist/widget.js" } },
    }),
  );
  write("packages/remnic-core/src/widget.ts", "export const w = 3;\n");
  write("packages/remnic-core/src/unused.ts", "export const u = 4;\n");
  return root;
}

const ALL_TESTS = ["tests/a.test.ts", "tests/b.test.ts"];

function fixtureGraph(root) {
  const pkgIndex = loadPackageIndex(root);
  const graph = buildImportGraph(root, listImportableFiles(root), pkgIndex);
  return buildReverseIndex(graph);
}

test("extractSpecifiers covers import forms", () => {
  const specs = extractSpecifiers(
    'import a from "./a.js"; import "./side.js"; const b = await import("./dyn.js"); const c = require("./req.cjs"); export { x } from "./re.js";',
  );
  assert.deepEqual(specs.sort(), ["./a.js", "./dyn.js", "./re.js", "./req.cjs", "./side.js"].sort());
});

test("resolveSpecifier maps .js specifier to .ts source", () => {
  const root = makeFixture();
  try {
    assert.equal(resolveSpecifier(root, "tests/a.test.ts", "../src/feature.js", loadPackageIndex(root)), "src/feature.ts");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveSpecifier resolves @remnic subpath via remnic-source export", () => {
  const root = makeFixture();
  try {
    const pkgIndex = loadPackageIndex(root);
    assert.equal(
      resolveSpecifier(root, "tests/a.test.ts", "@remnic/core/widget", pkgIndex),
      "packages/remnic-core/src/widget.ts",
    );
    assert.equal(resolveSpecifier(root, "tests/a.test.ts", "node:fs", pkgIndex), null);
    assert.equal(resolveSpecifier(root, "tests/a.test.ts", "lodash", pkgIndex), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("selectShadowRun: transitive source change selects importing test", () => {
  const root = makeFixture();
  try {
    const reverse = fixtureGraph(root);
    const result = selectShadowRun({
      shardFiles: ALL_TESTS,
      allTestFiles: ALL_TESTS,
      changedFiles: ["src/deep/dep.ts"],
      reverseIndex: reverse,
    });
    assert.equal(result.mode, "selected");
    assert.deepEqual(result.wouldRun, ["tests/a.test.ts"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("selectShadowRun: package src change reaches test through exports map", () => {
  const root = makeFixture();
  try {
    const reverse = fixtureGraph(root);
    const result = selectShadowRun({
      shardFiles: ALL_TESTS,
      allTestFiles: ALL_TESTS,
      changedFiles: ["packages/remnic-core/src/widget.ts"],
      reverseIndex: reverse,
    });
    assert.equal(result.mode, "selected");
    assert.deepEqual(result.wouldRun, ["tests/a.test.ts"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("selectShadowRun: changed test file selects itself", () => {
  const root = makeFixture();
  try {
    const reverse = fixtureGraph(root);
    const result = selectShadowRun({
      shardFiles: ALL_TESTS,
      allTestFiles: ALL_TESTS,
      changedFiles: ["tests/b.test.ts"],
      reverseIndex: reverse,
    });
    assert.deepEqual(result.wouldRun, ["tests/b.test.ts"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("selectShadowRun: unrelated leaf change selects nothing", () => {
  const root = makeFixture();
  try {
    const reverse = fixtureGraph(root);
    const result = selectShadowRun({
      shardFiles: ALL_TESTS,
      allTestFiles: ALL_TESTS,
      changedFiles: ["packages/remnic-core/src/unused.ts"],
      reverseIndex: reverse,
    });
    assert.equal(result.mode, "selected");
    assert.deepEqual(result.wouldRun, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("selectShadowRun: global change selects whole shard", () => {
  const root = makeFixture();
  try {
    const reverse = fixtureGraph(root);
    for (const globalPath of ["package.json", "pnpm-lock.yaml", "scripts/run-root-tests.mjs", "tests/helpers.ts", "packages/remnic-core/package.json"]) {
      const result = selectShadowRun({
        shardFiles: ALL_TESTS,
        allTestFiles: ALL_TESTS,
        changedFiles: [globalPath],
        reverseIndex: reverse,
      });
      assert.equal(result.mode, "all", globalPath);
      assert.deepEqual(result.wouldRun, ALL_TESTS, globalPath);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("selectShadowRun: empty or missing changed list selects all", () => {
  const root = makeFixture();
  try {
    const reverse = fixtureGraph(root);
    for (const changed of [null, []]) {
      const result = selectShadowRun({
        shardFiles: ALL_TESTS,
        allTestFiles: ALL_TESTS,
        changedFiles: changed,
        reverseIndex: reverse,
      });
      assert.equal(result.mode, "all");
      assert.deepEqual(result.wouldRun, ALL_TESTS);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("isGlobalChange never fires on an expanded test file", () => {
  const testFileSet = new Set(ALL_TESTS);
  assert.equal(isGlobalChange("tests/a.test.ts", testFileSet), false);
  assert.equal(isGlobalChange("tests/fixtures/data.json", testFileSet), true);
  assert.equal(isGlobalChange("docs/readme.md", testFileSet), false);
});

test("selectShadowRun respects shard membership", () => {
  const root = makeFixture();
  try {
    const reverse = fixtureGraph(root);
    const result = selectShadowRun({
      shardFiles: ["tests/b.test.ts"],
      allTestFiles: ALL_TESTS,
      changedFiles: ["src/feature.ts"],
      reverseIndex: reverse,
    });
    assert.equal(result.mode, "selected");
    assert.deepEqual(result.wouldRun, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
