import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  H6BenchmarkDatasetSchema,
  computeH6InventoryHash,
  resolveCommittedH6FixtureDirectory,
} from "./repo-gen/index.js";
import { RepeatedFailurePreflightError } from "./repeated-failure-preflight.js";
import {
  assertCoreRepoRootMatch,
  assertCoreRepoDirMatchesHarness,
  resolvePackageRootFromModuleFile,
} from "./repeated-failure-suite-analysis.js";
import { loadFixtureBundle } from "./repeated-failure-suite-execution.js";

test("core package root preflight fails closed on a different resolved root", () => {
  assert.throws(
    () => assertCoreRepoRootMatch("/workspace/packages/remnic-core", "/stale/node_modules/@remnic/core"),
    (error) => error instanceof RepeatedFailurePreflightError
      && error.invalidReason === "CORE_REPO_DIR_MISMATCH",
  );
});

test("core package root preflight accepts the resolved workspace package", async () => {
  await assert.doesNotReject(assertCoreRepoDirMatchesHarness);
});

test("core package root resolves from source-monorepo and installed package layouts", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "h6-core-package-root-"));
  const layouts = [
    {
      packageRoot: path.join(root, "source", "packages", "remnic-core"),
      modulePath: path.join("src", "coding", "pre-action-gate.ts"),
    },
    {
      packageRoot: path.join(root, "installed", "node_modules", "@remnic", "core"),
      modulePath: path.join("dist", "coding", "pre-action-gate.js"),
    },
  ];
  try {
    assert.equal(typeof resolvePackageRootFromModuleFile, "function");
    for (const layout of layouts) {
      const moduleFile = path.join(layout.packageRoot, layout.modulePath);
      await mkdir(path.dirname(moduleFile), { recursive: true });
      await writeFile(
        path.join(layout.packageRoot, "package.json"),
        `${JSON.stringify({ name: "@remnic/core" })}\n`,
        "utf8",
      );
      await writeFile(moduleFile, "", "utf8");
      assert.equal(
        await resolvePackageRootFromModuleFile(moduleFile, "@remnic/core"),
        await realpath(layout.packageRoot),
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("suite fixture loading rejects a duplicated state-defining corpus", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "h6-corpus-preflight-"));
  try {
    await cp(await resolveCommittedH6FixtureDirectory(), root, { recursive: true });
    const datasetPath = path.join(root, "dataset.json");
    const dataset = H6BenchmarkDatasetSchema.parse(JSON.parse(await readFile(datasetPath, "utf8")));
    const [source, duplicate] = dataset.tasks.filter(
      (task) => task.trapId === dataset.tasks[0].trapId,
    );
    assert.ok(source);
    assert.ok(duplicate);
    for (const filePath of [source.fingerprint.file, "test/check.js"]) {
      const sourceFile = source.variants[0].files.find((file) => file.path === filePath);
      const duplicateFile = duplicate.variants[0].files.find((file) => file.path === filePath);
      assert.ok(sourceFile);
      assert.ok(duplicateFile);
      duplicateFile.content = sourceFile.content;
    }
    const { inventoryHash: _inventoryHash, ...hashableDataset } = dataset;
    dataset.inventoryHash = computeH6InventoryHash(hashableDataset);
    await writeFile(datasetPath, `${JSON.stringify(dataset, null, 2)}\n`, "utf8");

    await assert.rejects(
      () => loadFixtureBundle(root),
      (error) => error instanceof RepeatedFailurePreflightError
        && error.invalidReason === "CORPUS_INVALID",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
