import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import test from "node:test";

import { __benchDatasetTestHooks } from "./index.js";

test("paired answer replay cache is exclusive to LoCoMo", () => {
  const cache = new Map();

  assert.equal(
    __benchDatasetTestHooks.pairedAnswerReplayCacheForBenchmark("locomo", cache),
    cache,
  );
  assert.equal(
    __benchDatasetTestHooks.pairedAnswerReplayCacheForBenchmark("longmemeval", cache),
    undefined,
  );
});

test("resolveDownloadedBenchDatasetDir rejects explicit dataset paths without benchmark markers", async () => {

  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-datasets-"));
  const invalidDataset = path.join(root, "not-downloaded");

  assert.equal(
    __benchDatasetTestHooks.resolveBenchDatasetDir(
      "memory-arena",
      false,
      invalidDataset,
    ),
    invalidDataset,
  );
  assert.equal(
    __benchDatasetTestHooks.resolveDownloadedBenchDatasetDir(
      "memory-arena",
      false,
      invalidDataset,
    ),
    undefined,
  );
});

test("resolveDownloadedBenchDatasetDir accepts explicit dataset paths with benchmark markers", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-datasets-"));
  const datasetDir = path.join(root, "memory-arena");
  await mkdir(datasetDir, { recursive: true });
  await writeFile(path.join(datasetDir, "shopping.jsonl"), "{}\n");

  assert.equal(
    __benchDatasetTestHooks.resolveDownloadedBenchDatasetDir(
      "memory-arena",
      false,
      datasetDir,
    ),
    datasetDir,
  );
});

test("resolveDownloadedBenchDatasetDir ignores MemoryArena WebShop sidecars as dataset markers", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-datasets-"));
  const datasetDir = path.join(root, "memory-arena");
  await mkdir(datasetDir, { recursive: true });
  await writeFile(path.join(datasetDir, "webshop-products.jsonl"), "{}\n");

  assert.equal(
    __benchDatasetTestHooks.resolveDownloadedBenchDatasetDir(
      "memory-arena",
      false,
      datasetDir,
    ),
    undefined,
  );
});

test("resolveDownloadedBenchDatasetDir accepts non-ReDial MemoryAgentBench splits without entity mapping", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-datasets-"));
  const datasetDir = path.join(root, "memoryagentbench");
  await mkdir(datasetDir, { recursive: true });
  await writeFile(path.join(datasetDir, "Test_Time_Learning.json"), "[]\n");

  assert.equal(
    __benchDatasetTestHooks.resolveDownloadedBenchDatasetDir(
      "memoryagentbench",
      false,
      datasetDir,
    ),
    datasetDir,
  );
});

test("resolveDownloadedBenchDatasetDir requires MemoryAgentBench ReDial entity mapping for ReDial bundles", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-datasets-"));
  const datasetDir = path.join(root, "memoryagentbench");
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "memoryagentbench.json"),
    JSON.stringify([
      {
        context: "The user asked for cyberpunk action movies.",
        questions: ["User: I want a cyberpunk action movie. Recommender:"],
        answers: [["1"]],
        metadata: {
          source: "recsys_redial",
          qa_pair_ids: ["redial-1"],
          question_types: ["recommendation"],
        },
      },
    ]),
    "utf8",
  );

  assert.equal(
    __benchDatasetTestHooks.resolveDownloadedBenchDatasetDir(
      "memoryagentbench",
      false,
      datasetDir,
    ),
    undefined,
  );

  await writeFile(path.join(datasetDir, "entity2id.json"), "{}\n");

  assert.equal(
    __benchDatasetTestHooks.resolveDownloadedBenchDatasetDir(
      "memoryagentbench",
      false,
      datasetDir,
    ),
    datasetDir,
  );
});

test("published dry-run validation forwards MemoryAgentBench trial limit", async () => {
  let captured:
    | {
        id: string;
        options: {
          benchmarkOptions?: Record<string, unknown>;
          datasetDir?: string;
          limit?: number;
          seed?: number;
          onTaskComplete?: (
            task: {
              taskId: string;
              scores: Record<string, number>;
              latencyMs: number;
              tokens: { input: number; output: number };
            },
            completedCount: number,
            totalCount?: number,
          ) => void;
        };
      }
    | undefined;
  const benchModule = {
    async runBenchmark(id: string, options: NonNullable<typeof captured>["options"]) {
      captured = { id, options };
      options.onTaskComplete?.(
        {
          taskId: "dry-run-check",
          scores: {},
          latencyMs: 0,
          tokens: { input: 0, output: 0 },
        },
        1,
        1,
      );
      throw new Error("dry-run adapter should stop benchmark execution");
    },
  };

  const benchmarkOptions =
    __benchDatasetTestHooks.buildPublishedBenchmarkOptionsForTest(
      "memoryagentbench",
      { publishedTrialLimit: 1 },
    );

  await __benchDatasetTestHooks
    .validateRunnerManagedPublishedDryRunDatasetWithModuleForTest(
      benchModule,
      "memoryagentbench",
      "full",
      "/tmp/memoryagentbench",
      10,
      123,
      benchmarkOptions,
    );

  assert.equal(captured?.id, "memoryagentbench");
  assert.equal(captured?.options.datasetDir, "/tmp/memoryagentbench");
  assert.equal(captured?.options.limit, 10);
  assert.equal(captured?.options.seed, 123);
  assert.deepEqual(captured?.options.benchmarkOptions, { trialLimit: 1 });
});
