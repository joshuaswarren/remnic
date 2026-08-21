import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { BenchmarkResult } from "../evals/adapter/types.js";
import { portableDatasetDir, resultForPersistence, writeResult } from "../evals/reporter.js";

function benchmarkResult(datasetDir: string): BenchmarkResult {
  return {
    meta: {
      name: "locomo",
      version: "1",
      description: "fixture",
      category: "conversational",
    },
    engramVersion: "test",
    gitSha: "test",
    timestamp: "2026-07-16T00:00:00.000Z",
    adapterMode: "direct",
    taskCount: 1,
    scores: [],
    aggregate: { accuracy: 1 },
    config: { datasetDir },
    durationMs: 1,
  };
}

test("portableDatasetDir makes repository datasets portable", () => {
  const repoRoot = path.resolve(os.tmpdir(), "remnic-repo");
  const datasetDir = path.join(repoRoot, "evals", "datasets", "locomo");

  assert.equal(portableDatasetDir(datasetDir, repoRoot), "evals/datasets/locomo");
  assert.equal(portableDatasetDir("evals/datasets/locomo", repoRoot), "evals/datasets/locomo");
});

test("portableDatasetDir redacts external host paths", () => {
  const repoRoot = path.resolve(os.tmpdir(), "remnic-repo");
  const externalDir = path.resolve(os.tmpdir(), "private-user", "locomo");

  assert.equal(portableDatasetDir(externalDir, repoRoot), "<external>");
});

test("resultForPersistence preserves config without mutating the result", () => {
  const result = benchmarkResult(path.resolve("evals/datasets/locomo"));
  result.config.limit = 5;
  const persisted = resultForPersistence(result);

  assert.equal(persisted.config.datasetDir, "evals/datasets/locomo");
  assert.equal(persisted.config.limit, 5);
  assert.equal(result.config.datasetDir, path.resolve("evals/datasets/locomo"));
});

test("writeResult omits developer-local dataset paths", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "remnic-eval-result-"));
  try {
    const result = benchmarkResult(path.resolve(os.tmpdir(), "private-user", "locomo"));
    const filePath = await writeResult(result, outputDir);
    const persisted = JSON.parse(await readFile(filePath, "utf8")) as BenchmarkResult;

    assert.equal(persisted.config.datasetDir, "<external>");
    assert.equal(result.config.datasetDir, path.resolve(os.tmpdir(), "private-user", "locomo"));
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test("committed legacy results contain no developer-local dataset paths", async () => {
  const resultsDir = path.resolve(import.meta.dirname, "../evals/results");
  const files = (await readdir(resultsDir)).filter((name) => name.endsWith(".json"));
  assert.ok(files.length > 0, "expected committed legacy result fixtures");

  for (const name of files) {
    const content = await readFile(path.join(resultsDir, name), "utf8");
    const result = JSON.parse(content) as BenchmarkResult;
    const datasetDir = result.config?.datasetDir;
    if (typeof datasetDir === "string") {
      const isAbsolute = path.isAbsolute(datasetDir) || /^[A-Za-z]:[\\/]/.test(datasetDir);
      assert.equal(isAbsolute, false, `${name} contains an absolute datasetDir`);
      assert.doesNotMatch(datasetDir, /openclaw-engram/i, `${name} contains a legacy local repo path`);
    }
  }
});
