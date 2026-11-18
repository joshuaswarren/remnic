import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  resolveSpecifierAll,
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

test("selectShadowRun: unmapped non-code change is reported but selects nothing", () => {
  const root = makeFixture();
  try {
    const reverse = fixtureGraph(root);
    const knownFiles = new Set(listImportableFiles(root));
    const result = selectShadowRun({
      shardFiles: ALL_TESTS,
      allTestFiles: ALL_TESTS,
      changedFiles: ["docs/readme.md"],
      reverseIndex: reverse,
      knownFiles,
    });
    assert.equal(result.mode, "selected");
    assert.deepEqual(result.wouldRun, []);
    assert.deepEqual(result.unmapped, ["docs/readme.md"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("selectShadowRun: unmapped code change forces the whole shard", () => {
  const root = makeFixture();
  try {
    const reverse = fixtureGraph(root);
    const knownFiles = new Set(listImportableFiles(root));
    // A deleted or never-imported code file outside the graph: nothing can
    // prove no test reads it, so the shard runs everything.
    const result = selectShadowRun({
      shardFiles: ALL_TESTS,
      allTestFiles: ALL_TESTS,
      changedFiles: ["bin/helper.js"],
      reverseIndex: reverse,
      knownFiles,
    });
    assert.equal(result.mode, "all");
    assert.deepEqual(result.wouldRun, ALL_TESTS);
    assert.deepEqual(result.unmapped, ["bin/helper.js"]);
    assert.match(result.why, /unmapped code change/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("selectShadowRun: unmapped paths are all reported even when a global change wins", () => {
  const root = makeFixture();
  try {
    const reverse = fixtureGraph(root);
    const knownFiles = new Set(listImportableFiles(root));
    const result = selectShadowRun({
      shardFiles: ALL_TESTS,
      allTestFiles: ALL_TESTS,
      changedFiles: ["package.json", "bin/helper.js"],
      reverseIndex: reverse,
      knownFiles,
    });
    assert.equal(result.mode, "all");
    assert.match(result.why, /global change/);
    assert.deepEqual(result.unmapped, ["package.json", "bin/helper.js"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("selectShadowRun: string exports map resolves a bare package import", () => {
  const root = makeFixture();
  try {
    const write = (rel, content) => {
      const full = path.join(root, rel);
      mkdirSync(path.dirname(full), { recursive: true });
      writeFileSync(full, content);
    };
    write(
      "packages/remnic-bare/package.json",
      JSON.stringify({ name: "@remnic/bare", exports: "./src/api.mjs" }),
    );
    write("packages/remnic-bare/src/api.mjs", "export const b = 1;\n");
    write("tests/c.test.ts", 'import "@remnic/bare";\n');
    const allTests = [...ALL_TESTS, "tests/c.test.ts"];
    const pkgIndex = loadPackageIndex(root);
    const graph = buildImportGraph(root, listImportableFiles(root), pkgIndex);
    const result = selectShadowRun({
      shardFiles: allTests,
      allTestFiles: allTests,
      changedFiles: ["packages/remnic-bare/src/api.mjs"],
      reverseIndex: buildReverseIndex(graph),
      knownFiles: new Set(listImportableFiles(root)),
    });
    assert.equal(result.mode, "selected");
    assert.deepEqual(result.wouldRun, ["tests/c.test.ts"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("selectShadowRun: a shard test importing another shard test propagates selection", () => {
  const root = makeFixture();
  try {
    const write = (rel, content) => {
      const full = path.join(root, rel);
      mkdirSync(path.dirname(full), { recursive: true });
      writeFileSync(full, content);
    };
    // a.test.ts imports b.test.ts; b.test.ts imports src/other.ts. Changing
    // src/other.ts must reach a through b even though b is itself a shard test.
    write("tests/a.test.ts", 'import "./b.test.js";\n');
    write("tests/b.test.ts", 'import { o } from "../src/other.js";\n');
    const allTests = ALL_TESTS;
    const pkgIndex = loadPackageIndex(root);
    const graph = buildImportGraph(root, listImportableFiles(root), pkgIndex);
    const result = selectShadowRun({
      shardFiles: allTests,
      allTestFiles: allTests,
      changedFiles: ["src/other.ts"],
      reverseIndex: buildReverseIndex(graph),
      knownFiles: new Set(listImportableFiles(root)),
    });
    assert.equal(result.mode, "selected");
    assert.deepEqual(result.wouldRun.sort(), ["tests/a.test.ts", "tests/b.test.ts"].sort());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveSpecifier resolves a JSON module import to the file", () => {
  const root = makeFixture();
  try {
    const write = (rel, content) => {
      const full = path.join(root, rel);
      mkdirSync(path.dirname(full), { recursive: true });
      writeFileSync(full, content);
    };
    write("src/settings.json", "{}");
    write("tests/d.test.ts", 'import cfg from "../src/settings.json" with { type: "json" };\n');
    const pkgIndex = loadPackageIndex(root);
    const resolved = resolveSpecifier(root, "tests/d.test.ts", "../src/settings.json", pkgIndex);
    assert.equal(resolved, "src/settings.json");
    const graph = buildImportGraph(root, listImportableFiles(root), pkgIndex);
    const reverse = buildReverseIndex(graph);
    assert.ok(reverse.get("src/settings.json")?.has("tests/d.test.ts"));
    const allTests = [...ALL_TESTS, "tests/d.test.ts"];
    const result = selectShadowRun({
      shardFiles: allTests,
      allTestFiles: allTests,
      changedFiles: ["src/settings.json"],
      reverseIndex: reverse,
      knownFiles: new Set(listImportableFiles(root)),
    });
    assert.equal(result.mode, "selected");
    assert.deepEqual(result.wouldRun, ["tests/d.test.ts"]);
    assert.deepEqual(result.unmapped, ["src/settings.json"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveSpecifier keeps a missing JSON import path so deletion still selects the importer", () => {
  const root = makeFixture();
  try {
    const write = (rel, content) => {
      const full = path.join(root, rel);
      mkdirSync(path.dirname(full), { recursive: true });
      writeFileSync(full, content);
    };
    // d.test.ts imports ../src/settings.json but the file does not exist
    // (deleted). The edge must survive so the changed deleted path selects it.
    write("tests/d.test.ts", 'import cfg from "../src/settings.json" with { type: "json" };\n');
    const pkgIndex = loadPackageIndex(root);
    const resolved = resolveSpecifier(root, "tests/d.test.ts", "../src/settings.json", pkgIndex);
    assert.equal(resolved, "src/settings.json");
    const graph = buildImportGraph(root, listImportableFiles(root), pkgIndex);
    const reverse = buildReverseIndex(graph);
    const allTests = [...ALL_TESTS, "tests/d.test.ts"];
    const result = selectShadowRun({
      shardFiles: allTests,
      allTestFiles: allTests,
      changedFiles: ["src/settings.json"],
      reverseIndex: reverse,
      knownFiles: new Set(listImportableFiles(root)),
    });
    assert.equal(result.mode, "selected");
    assert.deepEqual(result.wouldRun, ["tests/d.test.ts"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("exportTarget resolves a top-level conditional exports object as the root export", () => {
  const root = makeFixture();
  try {
    const pkgDir = path.join(root, "packages", "widget");
    mkdirSync(path.join(pkgDir, "src"), { recursive: true });
    writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({
      name: "@remnic/widget",
      exports: { "remnic-source": "./src/api.mjs", default: "./dist/api.mjs" },
    }));
    writeFileSync(path.join(pkgDir, "src", "api.mjs"), "export const api = 1;\n");
    const pkgIndex = loadPackageIndex(root);
    const resolved = resolveSpecifier(root, "tests/a.test.ts", "@remnic/widget", pkgIndex);
    assert.equal(resolved, "packages/widget/src/api.mjs");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("isGlobalChange treats plugin hooks.json as a full-shard trigger", () => {
  assert.equal(isGlobalChange("packages/plugin-claude-code/hooks/hooks.json", new Set()), true);
  assert.equal(isGlobalChange("packages/plugin-agy/hooks.json", new Set()), true);
  assert.equal(isGlobalChange("docs/hooks.json", new Set()), false);
  assert.equal(isGlobalChange("packages/plugin-claude-code/hooks/README.md", new Set()), false);
});

test("exportTarget resolves nested conditions in manifest order for top-level and '.' forms", () => {
  const root = makeFixture();
  try {
    const nested = { node: { import: "./src/node.mjs", default: "./src/node-fallback.mjs" }, default: "./dist/api.mjs" };
    for (const [label, exportsField] of [
      ["top-level", nested],
      ["dot", { ".": nested }],
    ]) {
      const pkgDir = path.join(root, "packages", `widget-${label}`);
      mkdirSync(path.join(pkgDir, "src"), { recursive: true });
      writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({
        name: `@remnic/widget-${label}`,
        exports: exportsField,
      }));
      writeFileSync(path.join(pkgDir, "src", "node.mjs"), "export const n = 1;\n");
      const pkgIndex = loadPackageIndex(root);
      const resolved = resolveSpecifier(root, "tests/a.test.ts", `@remnic/widget-${label}`, pkgIndex);
      assert.equal(resolved, `packages/widget-${label}/src/node.mjs`, label);
    }
    // Manifest order wins: default listed before node selects default.
    const pkgDir = path.join(root, "packages", "widget-order");
    mkdirSync(path.join(pkgDir, "src"), { recursive: true });
    writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({
      name: "@remnic/widget-order",
      exports: { default: "./dist/api.mjs", node: { import: "./src/node.mjs" } },
    }));
    mkdirSync(path.join(pkgDir, "dist"), { recursive: true });
    writeFileSync(path.join(pkgDir, "dist", "api.mjs"), "export const d = 1;\n");
    writeFileSync(path.join(pkgDir, "src", "node.mjs"), "export const n = 1;\n");
    const resolved = resolveSpecifier(root, "tests/a.test.ts", "@remnic/widget-order", loadPackageIndex(root));
    assert.equal(resolved, "packages/widget-order/dist/api.mjs");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveSpecifierAll records every export condition target", () => {
  const root = makeFixture();
  try {
    const pkgDir = path.join(root, "packages", "widget-dual");
    mkdirSync(path.join(pkgDir, "src"), { recursive: true });
    mkdirSync(path.join(pkgDir, "dist"), { recursive: true });
    writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({
      name: "@remnic/widget-dual",
      exports: { ".": { require: "./dist/cjs.cjs", import: "./src/esm.mjs" } },
    }));
    writeFileSync(path.join(pkgDir, "src", "esm.mjs"), "export const e = 1;\n");
    writeFileSync(path.join(pkgDir, "dist", "cjs.cjs"), "module.exports = {};\n");
    const pkgIndex = loadPackageIndex(root);
    const all = resolveSpecifierAll(root, "tests/a.test.ts", "@remnic/widget-dual", pkgIndex).sort();
    assert.deepEqual(all, ["packages/widget-dual/dist/cjs.cjs", "packages/widget-dual/src/esm.mjs"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
