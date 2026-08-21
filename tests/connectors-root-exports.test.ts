import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { runCodexMaterialize as runFromRunnerShim } from "../src/connectors/codex-materialize-runner.js";
import {
  materializeForNamespace,
  runCodexMaterialize as runFromIndexShim,
} from "../src/connectors/index.js";
import * as secureStore from "../src/secure-store/index.js";

test("root connector shims expose Codex materialize exports", () => {
  assert.equal(typeof runFromRunnerShim, "function");
  assert.equal(typeof runFromIndexShim, "function");
  assert.equal(typeof materializeForNamespace, "function");
});

test("root secure-store shim exposes the core secure-store surface", () => {
  assert.equal(typeof secureStore.seal, "function");
  assert.equal(typeof secureStore.open, "function");
  assert.equal(typeof secureStore.keyring, "object");
  assert.equal(typeof secureStore.keyring.unlock, "function");
  assert.equal(typeof secureStore.keyring.size, "function");
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
    ["secure-store", "./dist/secure-store/index.js"],
    ["secure-store/index", "./dist/secure-store/index.js"],
    ["temporal-index", "./dist/temporal-index.js"],
    ["temporal-validity", "./dist/temporal-validity.js"],
    ["tier-migration", "./dist/tier-migration.js"],
    ["tier-routing", "./dist/tier-routing.js"],
  ] as const) {
    assert.deepEqual(exportsMap[`./${subpath}`], { import: expectedTarget }, subpath);
    assert.deepEqual(exportsMap[`./${subpath}.js`], { import: expectedTarget }, `${subpath}.js`);
  }
});

test("root package resolver exposes temporal and tier shims", () => {
  for (const subpath of ["temporal-index", "temporal-validity", "tier-migration", "tier-routing"] as const) {
    const expectedUrl = new URL(`../dist/${subpath}.js`, import.meta.url).href;
    assert.equal(import.meta.resolve(`remnic-workspace/${subpath}`), expectedUrl, subpath);
    assert.equal(import.meta.resolve(`remnic-workspace/${subpath}.js`), expectedUrl, `${subpath}.js`);
  }
});

test("root build emits temporal and tier shim artifacts", () => {
  const tsupConfig = readFileSync(new URL("../tsup.config.ts", import.meta.url), "utf8");

  for (const entry of [
    "src/temporal-index.ts",
    "src/temporal-validity.ts",
    "src/tier-migration.ts",
    "src/tier-routing.ts",
  ] as const) {
    assert.match(tsupConfig, new RegExp(`"${entry}"`), entry);
  }
});

test("root temporal index shim preserves public core exports", () => {
  const shimSource = readFileSync(new URL("../src/temporal-index.ts", import.meta.url), "utf8");

  for (const exportName of [
    "indexMemory",
    "indexesExist",
    "isTemporalQuery",
    "queryByTagsAsync",
    "recencyWindowFromPrompt",
    "resolvePromptTagPrefilterAsync",
  ] as const) {
    assert.match(shimSource, new RegExp(`\\b${exportName}\\b`), exportName);
  }
});
