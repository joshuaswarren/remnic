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
import type { ParsedBenchArgs } from "./bench-args.js";

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
