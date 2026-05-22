import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { runCodexMaterialize as runFromRunnerShim } from "../src/connectors/codex-materialize-runner.js";
import {
  materializeForNamespace,
  runCodexMaterialize as runFromIndexShim,
} from "../src/connectors/index.js";

test("root connector shims expose Codex materialize exports", () => {
  assert.equal(typeof runFromRunnerShim, "function");
  assert.equal(typeof runFromIndexShim, "function");
  assert.equal(typeof materializeForNamespace, "function");
});

test("root package export map exposes LCM shims", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
    exports?: Record<string, { import?: string }>;
  };
  const exportsMap = packageJson.exports ?? {};

  for (const subpath of [
    "lcm",
    "lcm/index",
    "lcm/archive",
    "lcm/dag",
    "lcm/engine",
    "lcm/queue",
    "lcm/recall",
    "lcm/schema",
    "lcm/summarizer",
    "lcm/tools",
  ]) {
    const expectedTarget = subpath === "lcm"
      ? "./dist/lcm/index.js"
      : `./dist/${subpath}.js`;
    assert.deepEqual(exportsMap[`./${subpath}`], { import: expectedTarget }, subpath);
    assert.deepEqual(exportsMap[`./${subpath}.js`], { import: expectedTarget }, `${subpath}.js`);
  }
});

test("root package export map exposes compat and source shims", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
    exports?: Record<string, { import?: string }>;
  };
  const exportsMap = packageJson.exports ?? {};

  for (const [subpath, expectedTarget] of [
    ["access-cli", "./dist/access-cli.js"],
    ["cli", "./dist/cli.js"],
    ["compat/checks", "./dist/compat/checks.js"],
    ["compat/types", "./dist/compat/types.js"],
    ["connectors", "./dist/connectors/index.js"],
    ["consolidation-provenance-check", "./dist/consolidation-provenance-check.js"],
    ["entity-retrieval", "./dist/entity-retrieval.js"],
    ["extraction", "./dist/extraction.js"],
  ] as const) {
    assert.deepEqual(exportsMap[`./${subpath}`], { import: expectedTarget }, subpath);
    assert.deepEqual(exportsMap[`./${subpath}.js`], { import: expectedTarget }, `${subpath}.js`);
  }
});
