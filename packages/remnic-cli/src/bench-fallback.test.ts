import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import test from "node:test";

import {
  buildBenchRunnerArgs,
  createFallbackBenchOutputDir,
  findUnsupportedFallbackBenchOptions,
  resolveFallbackBenchResultPath,
} from "./bench-fallback.js";
import { parseBenchArgs, type ParsedBenchArgs } from "./bench-args.js";

function createParsedBenchArgs(overrides: Partial<ParsedBenchArgs> = {}): ParsedBenchArgs {
  return {
    action: "run",
    benchmarks: ["longmemeval"],
    quick: false,
    all: false,
    json: false,
    detail: false,
    ...overrides,
  };
}

test("buildBenchRunnerArgs forwards a run-scoped output directory", () => {
  const parsed = createParsedBenchArgs({
    quick: true,
    datasetDir: "/tmp/datasets/longmemeval",
  });

  const args = buildBenchRunnerArgs(
    parsed,
    "longmemeval",
    "/tmp/remnic-bench/fallback-runs/longmemeval-1710000000000-123",
  );

  assert.deepEqual(args, [
    "--benchmark",
    "longmemeval",
    "--lightweight",
    "--limit",
    "1",
    "--dataset-dir",
    "/tmp/datasets/longmemeval",
    "--output-dir",
    "/tmp/remnic-bench/fallback-runs/longmemeval-1710000000000-123",
  ]);
});

test("buildBenchRunnerArgs forwards an explicit fallback run limit", () => {
  const parsed = parseBenchArgs(["run", "locomo", "--limit", "5"]);

  const args = buildBenchRunnerArgs(parsed, "locomo", "/tmp/remnic-bench/fallback-runs/locomo");

  assert.deepEqual(args, [
    "--benchmark",
    "locomo",
    "--limit",
    "5",
    "--output-dir",
    "/tmp/remnic-bench/fallback-runs/locomo",
  ]);
});

test("buildBenchRunnerArgs preserves an explicit zero fallback run limit", () => {
  const parsed = parseBenchArgs(["run", "locomo", "--limit", "0"]);

  const args = buildBenchRunnerArgs(parsed, "locomo", "/tmp/remnic-bench/fallback-runs/locomo");

  assert.deepEqual(args, [
    "--benchmark",
    "locomo",
    "--limit",
    "0",
    "--output-dir",
    "/tmp/remnic-bench/fallback-runs/locomo",
  ]);
});

test("buildBenchRunnerArgs lets explicit limits override quick-mode fallback limit", () => {
  const parsed = parseBenchArgs(["run", "locomo", "--quick", "--limit", "5"]);

  const args = buildBenchRunnerArgs(parsed, "locomo", "/tmp/remnic-bench/fallback-runs/locomo");

  assert.deepEqual(args, [
    "--benchmark",
    "locomo",
    "--lightweight",
    "--limit",
    "5",
    "--output-dir",
    "/tmp/remnic-bench/fallback-runs/locomo",
  ]);
});

test("findUnsupportedFallbackBenchOptions rejects package-only timeout options", () => {
  const parsed = createParsedBenchArgs({
    drainTimeout: 1,
    max429WaitMs: 2,
  });

  assert.deepEqual(findUnsupportedFallbackBenchOptions(parsed), [
    "--drain-timeout",
    "--max-429-wait",
  ]);
});

test("findUnsupportedFallbackBenchOptions rejects package-only run scoping options", () => {
  const parsed = createParsedBenchArgs({
    publishedTrialLimit: 2,
    publishedTrialConcurrency: 3,
    publishedIngestConcurrency: 4,
    publishedTaskFilter: "task-1",
    publishedSeed: 5,
  });

  assert.deepEqual(findUnsupportedFallbackBenchOptions(parsed), [
    "--trial-limit",
    "--trial-concurrency",
    "--ingest-concurrency",
    "--task-filter",
    "--seed",
  ]);
});

test("createFallbackBenchOutputDir scopes fallback artifacts per run", () => {
  const outputDir = createFallbackBenchOutputDir(
    "/tmp/remnic-bench-results",
    "locomo",
    456,
    1_710_000_000_123,
  );

  assert.equal(
    outputDir,
    path.join(
      "/tmp/remnic-bench-results",
      "fallback-runs",
      "locomo-1710000000123-456",
    ),
  );
});

test("resolveFallbackBenchResultPath only reads the dedicated run directory", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-fallback-run-"));
  const runDir = path.join(root, "fallback-runs", "ama-bench-1710000000456-789");
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(runDir, "ama-bench-v1.json"), "{}\n");
  await writeFile(path.join(root, "ama-bench-v0.json"), "{}\n");

  const resultPath = resolveFallbackBenchResultPath(runDir);
  assert.equal(resultPath, path.join(runDir, "ama-bench-v1.json"));
});

test("resolveFallbackBenchResultPath rejects fallback runs without JSON artifacts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-fallback-run-"));
  const runDir = path.join(root, "fallback-runs", "locomo-1710000000456-789");
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(runDir, "locomo.log"), "completed without result\n");

  assert.throws(
    () => resolveFallbackBenchResultPath(runDir),
    {
      message: `Fallback benchmark runner did not write a JSON result artifact in ${runDir}`,
    },
  );
});
