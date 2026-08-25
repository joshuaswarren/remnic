import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { runCodexMaterialize as runFromRunner } from "@remnic/core/connectors/codex-materialize-runner";
import {
  materializeForNamespace,
  runCodexMaterialize as runFromIndex,
} from "@remnic/core/connectors";
import * as secureStore from "@remnic/core/secure-store/index";
import * as temporalIndex from "@remnic/core/temporal-index";

type ExportConditions = { types?: string; "remnic-source"?: string; import?: string };

async function readExportsMap(): Promise<Record<string, ExportConditions>> {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
    exports?: Record<string, ExportConditions>;
  };
  return packageJson.exports ?? {};
}

test("core connector surfaces expose Codex materialize exports", () => {
  assert.equal(typeof runFromRunner, "function");
  assert.equal(typeof runFromIndex, "function");
  assert.equal(typeof materializeForNamespace, "function");
});

test("core secure-store surface keeps its public functions", () => {
  assert.equal(typeof secureStore.seal, "function");
  assert.equal(typeof secureStore.open, "function");
  assert.equal(typeof secureStore.keyring, "object");
  assert.equal(typeof secureStore.keyring.unlock, "function");
  assert.equal(typeof secureStore.keyring.size, "function");
});

test("root package export map exposes LCM subpaths via core", async () => {
  const exportsMap = await readExportsMap();

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
    const expectedTarget =
      subpath === "lcm" ? "./packages/remnic-core/dist/lcm/index.js" : `./packages/remnic-core/dist/${subpath}.js`;
    assert.deepEqual(exportsMap[`./${subpath}`], {
      types: expectedTarget.replace(/\.js$/, ".d.ts"),
      "remnic-source": expectedTarget
        .replace("./packages/remnic-core/dist/", "./packages/remnic-core/src/")
        .replace(/\.js$/, ".ts"),
      import: expectedTarget,
    }, subpath);
    assert.equal(exportsMap[`./${subpath}.js`]?.import, expectedTarget, `${subpath}.js`);
  }
});

test("root package export map exposes compat and source subpaths via core", async () => {
  const exportsMap = await readExportsMap();

  for (const [subpath, expectedTarget] of [
    ["access-cli", "./packages/remnic-core/dist/access-cli.js"],
    ["cli", "./packages/remnic-core/dist/cli.js"],
    ["compat/checks", "./packages/remnic-core/dist/compat/checks.js"],
    ["compat/types", "./packages/remnic-core/dist/compat/types.js"],
    ["connectors", "./packages/remnic-core/dist/connectors/index.js"],
    ["consolidation-provenance-check", "./packages/remnic-core/dist/consolidation-provenance-check.js"],
    ["entity-retrieval", "./packages/remnic-core/dist/entity-retrieval.js"],
    ["extraction", "./packages/remnic-core/dist/extraction.js"],
    ["secure-store", "./packages/remnic-core/dist/secure-store/index.js"],
    ["secure-store/index", "./packages/remnic-core/dist/secure-store/index.js"],
    ["temporal-index", "./packages/remnic-core/dist/temporal-index.js"],
    ["temporal-validity", "./packages/remnic-core/dist/temporal-validity.js"],
    ["tier-migration", "./packages/remnic-core/dist/tier-migration.js"],
    ["tier-routing", "./packages/remnic-core/dist/tier-routing.js"],
  ] as const) {
    assert.equal(exportsMap[`./${subpath}`]?.import, expectedTarget, subpath);
    assert.equal(exportsMap[`./${subpath}.js`]?.import, expectedTarget, `${subpath}.js`);
  }
});

test("root package resolver exposes temporal and tier subpaths via core", () => {
  for (const subpath of ["temporal-index", "temporal-validity", "tier-migration", "tier-routing"] as const) {
    assert.equal(
      import.meta.resolve(`remnic-workspace/${subpath}`),
      import.meta.resolve(`@remnic/core/${subpath}`),
      subpath,
    );
    assert.equal(
      import.meta.resolve(`remnic-workspace/${subpath}.js`),
      import.meta.resolve(`@remnic/core/${subpath}`),
      `${subpath}.js`,
    );
  }
});

test("root tsup build keeps only real entrypoints, no core copy shims", () => {
  const tsupConfig = readFileSync(new URL("../tsup.config.ts", import.meta.url), "utf8");
  const entries = [...tsupConfig.matchAll(/"(src\/[^"]+\.ts)"/g)].map((m) => m[1]);

  assert.deepEqual(entries, ["src/index.ts", "src/explicit-capture.ts"]);
});

test("core temporal-index keeps the public exports the root shim used to forward", () => {
  for (const exportName of [
    "indexMemory",
    "indexesExist",
    "isTemporalQuery",
    "queryByTagsAsync",
    "recencyWindowFromPrompt",
    "resolvePromptTagPrefilterAsync",
  ] as const) {
    assert.equal(typeof temporalIndex[exportName], "function", exportName);
  }
});
