import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  buildBuildWeekEvidenceReceipt,
  serializeBuildWeekEvidenceReceipt,
} from "./build-week-evidence-receipt.ts";
import type { BenchmarkReproManifest } from "./repro-manifest.js";
import type { BenchmarkResult } from "./types.js";

const DATASET_HASH = "a".repeat(64);
const ARTIFACT_HASH = "b".repeat(64);

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function syntheticResult(overrides: Partial<BenchmarkResult["meta"]> = {}): BenchmarkResult {
  return {
    meta: {
      id: "synthetic-build-week-run",
      benchmark: "longmemeval",
      benchmarkTier: "published",
      version: "oracle-v1",
      remnicVersion: "9.7.6",
      gitSha: "abc1234",
      timestamp: "2026-07-16T20:00:00.000Z",
      mode: "full",
      status: "complete",
      runCount: 1,
      seeds: [42],
      datasetHash: DATASET_HASH,
      ...overrides,
    },
    config: {
      runtimeProfile: "real",
      systemProvider: {
        provider: "codex-cli",
        model: "gpt-5.6-luna",
        reasoningEffort: "medium",
      },
      internalProvider: {
        provider: "codex-cli",
        model: "gpt-5.6-luna",
        reasoningEffort: "medium",
      },
      judgeProvider: {
        provider: "codex-cli",
        model: "gpt-5.6-terra",
        reasoningEffort: "high",
      },
      adapterMode: "direct",
      remnicConfig: {
        memoryDir: "/home/private-production-remnic",
        apiKey: "sk-do-not-publish-this-value",
      },
    },
    cost: {
      totalTokens: 150,
      inputTokens: 100,
      outputTokens: 50,
      estimatedCostUsd: 1.25,
      totalLatencyMs: 2000,
      meanQueryLatencyMs: 1000,
      judgeModelCalls: 2,
    },
    results: {
      tasks: [
        {
          taskId: "private-task-1",
          question: "What private fact did the user disclose?",
          expected: "private expected answer",
          actual: "private generated answer",
          scores: { exact_match: 1 },
          latencyMs: 1000,
          tokens: { input: 50, output: 25 },
          details: { recall: "private recalled production text" },
        },
        {
          taskId: "private-task-2",
          question: "What is the other private question?",
          expected: "another private expected answer",
          actual: "another private generated answer",
          scores: { exact_match: 0.5 },
          latencyMs: 1000,
          tokens: { input: 50, output: 25 },
        },
      ],
      aggregates: {
        exact_match: { mean: 0.75, median: 0.75, stdDev: 0.25, min: 0.5, max: 1 },
      },
    },
    environment: {
      os: "linux",
      nodeVersion: process.version,
      hardware: "private workstation description",
    },
  };
}

function syntheticSources(args: {
  result?: BenchmarkResult;
  limit?: number;
  usageModel?: string;
} = {}): { resultJson: string; manifestJson: string } {
  const result = args.result ?? syntheticResult();
  const resultJson = `${JSON.stringify(result, null, 2)}\n`;
  const manifest: BenchmarkReproManifest = {
    schemaVersion: 1,
    generatedAt: "2026-07-16T21:00:00.000Z",
    run: {
      id: "synthetic-run-id",
      mode: "full",
      selectedBenchmarks: ["longmemeval"],
      runtimeProfiles: ["real"],
      selectedWorkItems: [{ benchmark: "longmemeval", runtimeProfile: "real" }],
      ...(args.limit === undefined ? {} : { limit: args.limit }),
    },
    git: { commit: "abc1234", shortCommit: "abc1234", dirty: false, dirtyEntryCount: 0 },
    command: {
      cwd: "/home/private/build-week-run",
      argv: ["bench", "run", "--api-key", "sk-private-command-secret"],
      envKeys: ["OPENAI_API_KEY"],
    },
    environment: {
      platform: "linux",
      arch: "x64",
      nodeVersion: process.version,
      hostname: "private-hostname",
    },
    configFiles: [{ label: "private", path: "/home/private/config.json", redacted: true }],
    datasets: [
      {
        benchmark: "longmemeval",
        status: "hashed",
        path: "/home/private/bench-datasets/longmemeval",
        realpath: "/home/private/bench-datasets/longmemeval",
        fileCount: 1,
        totalBytes: 1234,
        sha256: DATASET_HASH,
        files: [
          {
            path: "private-dataset.json",
            kind: "file",
            sizeBytes: 1234,
            sha256: DATASET_HASH,
          },
        ],
      },
    ],
    results: [
      {
        path: "/home/private/results/private-result.json",
        sha256: sha256(resultJson),
        sizeBytes: Buffer.byteLength(resultJson),
        resultId: result.meta.id,
        benchmark: result.meta.benchmark,
        mode: result.meta.mode,
        gitSha: result.meta.gitSha,
        runCount: result.meta.runCount,
        seeds: result.meta.seeds,
        taskCount: result.results.tasks.length,
        configHash: "c".repeat(64),
        judge: { provider: "codex-cli", model: "gpt-5.6-terra", rubricVersion: null },
      },
    ],
    codexCredit: {
      schemaVersion: 2,
      ledgerSha256: "d".repeat(64),
      budgetUnits: 2473,
      reserveUnits: 473,
      plannedSpendCeilingUnits: 2000,
      totalSpentUnits: 150,
      remainingBudgetUnits: 2323,
      blocked: false,
      cumulative: {
        calls: 20,
        inputTokens: 2000,
        cachedInputTokens: 500,
        outputTokens: 200,
        reasoningOutputTokens: 50,
        budgetUnits: 150,
        accountBalanceResolutionCount: 0,
        conservativeResolutionChargeUnits: 0,
        models: [],
      },
      run: {
        id: "synthetic-run-id",
        calls: 6,
        inputTokens: 1000,
        cachedInputTokens: 250,
        outputTokens: 100,
        reasoningOutputTokens: 25,
        budgetUnits: 42.5,
        accountBalanceResolutionCount: 0,
        conservativeResolutionChargeUnits: 0,
        models: [
          {
            model: args.usageModel ?? "gpt-5.6-luna",
            calls: 4,
            inputTokens: 700,
            cachedInputTokens: 200,
            outputTokens: 70,
            reasoningOutputTokens: 15,
            budgetUnits: 25,
          },
          {
            model: "gpt-5.6-terra",
            calls: 2,
            inputTokens: 300,
            cachedInputTokens: 50,
            outputTokens: 30,
            reasoningOutputTokens: 10,
            budgetUnits: 17.5,
          },
        ],
      },
    },
    artifactHash: ARTIFACT_HASH,
  };
  return { resultJson, manifestJson: `${JSON.stringify(manifest, null, 2)}\n` };
}

test("buildBuildWeekEvidenceReceipt emits deterministic aggregate-only evidence", () => {
  const sources = syntheticSources();
  const options = {
    ...sources,
    datasetVersion: "longmemeval-oracle-v1",
    limitationCodes: ["singleRun", "estimatedAccounting", "modelJudged"] as const,
    freshIsolatedStoreConfirmed: true as const,
    publicationScope: { kind: "full", expectedTaskCount: 2 } as const,
  };
  const first = buildBuildWeekEvidenceReceipt(options);
  const second = buildBuildWeekEvidenceReceipt(options);
  assert.deepEqual(first, second);
  assert.equal(serializeBuildWeekEvidenceReceipt(first), serializeBuildWeekEvidenceReceipt(second));
  assert.equal(first.benchmark.taskCount, 2);
  assert.equal(first.benchmark.failureCount, 0);
  assert.equal(first.estimatedUsage.calls, 6);
  assert.equal(first.estimatedUsage.totalTokens, 1100);
  assert.equal(first.estimatedUsage.localBudgetUnits, 42.5);
  assert.equal(first.integrity.resultSha256, sha256(sources.resultJson));
  assert.equal(first.integrity.manifestSha256, sha256(sources.manifestJson));
  assert.deepEqual(first.provenance.providers, [
    { role: "system", provider: "codex-cli", model: "gpt-5.6-luna", reasoningEffort: "medium", serviceTier: "default" },
    { role: "internal", provider: "codex-cli", model: "gpt-5.6-luna", reasoningEffort: "medium", serviceTier: "default" },
    { role: "judge", provider: "codex-cli", model: "gpt-5.6-terra", reasoningEffort: "high", serviceTier: "default" },
  ]);

  const serialized = serializeBuildWeekEvidenceReceipt(first);
  for (const forbidden of [
    "What private fact",
    "private expected answer",
    "private generated answer",
    "private recalled production text",
    "private-task-1",
    "/home/private",
    "sk-private",
    "hostname",
    "ledgerSha256",
    "accountBalance",
  ]) {
    assert.equal(serialized.includes(forbidden), false, `receipt leaked ${forbidden}`);
  }
  assert.equal(first.assertions.freshIsolatedStore, true);
  assert.match(first.assertions.freshIsolatedStoreStatement, /separate from production data/);
});

test("full receipts reject partial, quick, limited, incomplete, failed, and hash-mismatched sources", () => {
  const buildFull = (sources: ReturnType<typeof syntheticSources>, expectedTaskCount = 2) =>
    buildBuildWeekEvidenceReceipt({
      ...sources,
      datasetVersion: "oracle-v1",
      limitationCodes: ["singleRun"],
      freshIsolatedStoreConfirmed: true,
      publicationScope: { kind: "full", expectedTaskCount },
    });

  assert.throws(() => buildFull(syntheticSources({ result: syntheticResult({ status: "partial" }) })), /explicitly complete/);
  assert.throws(() => buildFull(syntheticSources({ result: syntheticResult({ mode: "quick" }) })), /full-mode/);
  assert.throws(() => buildFull(syntheticSources({ limit: 2 })), /limited manifest/);
  assert.throws(() => buildFull(syntheticSources(), 3), /task count 2 does not match expected 3/);

  const failed = syntheticResult();
  failed.results.tasks[0]!.details = { error: "private backend failure" };
  assert.throws(() => buildFull(syntheticSources({ result: failed })), /task\(s\) contain failure markers/);

  const sources = syntheticSources();
  const manifest = JSON.parse(sources.manifestJson) as BenchmarkReproManifest;
  manifest.results[0]!.sha256 = "e".repeat(64);
  assert.throws(
    () => buildFull({ ...sources, manifestJson: JSON.stringify(manifest) }),
    /result hash does not match/,
  );
});

test("bounded receipts require matching limit and limitation; Sol is always rejected", () => {
  const bounded = syntheticSources({ limit: 2 });
  assert.throws(
    () =>
      buildBuildWeekEvidenceReceipt({
        ...bounded,
        datasetVersion: "oracle-v1",
        limitationCodes: ["singleRun"],
        freshIsolatedStoreConfirmed: true,
        publicationScope: { kind: "bounded-subset", expectedTaskCount: 2 },
      }),
    /boundedSubset limitation/,
  );
  assert.doesNotThrow(() =>
    buildBuildWeekEvidenceReceipt({
      ...bounded,
      datasetVersion: "oracle-v1",
      limitationCodes: ["boundedSubset", "singleRun"],
      freshIsolatedStoreConfirmed: true,
      publicationScope: { kind: "bounded-subset", expectedTaskCount: 2 },
    }),
  );
  assert.throws(
    () =>
      buildBuildWeekEvidenceReceipt({
        ...syntheticSources({ limit: 2, usageModel: "gpt-5.6-sol" }),
        datasetVersion: "oracle-v1",
        limitationCodes: ["boundedSubset"],
        freshIsolatedStoreConfirmed: true,
        publicationScope: { kind: "bounded-subset", expectedTaskCount: 2 },
      }),
    /forbidden gpt-5\.6-sol/,
  );
});

test("receipt metadata rejects path and secret-bearing public identifiers", () => {
  const sources = syntheticSources();
  assert.throws(
    () =>
      buildBuildWeekEvidenceReceipt({
        ...sources,
        datasetVersion: "/home/private/dataset-v1",
        limitationCodes: [],
        freshIsolatedStoreConfirmed: true,
        publicationScope: { kind: "full", expectedTaskCount: 2 },
      }),
    /safe public identifier/,
  );
  const unsafe = syntheticResult({ id: "sk-private-secret-value" });
  assert.throws(
    () =>
      buildBuildWeekEvidenceReceipt({
        ...syntheticSources({ result: unsafe }),
        datasetVersion: "oracle-v1",
        limitationCodes: [],
        freshIsolatedStoreConfirmed: true,
        publicationScope: { kind: "full", expectedTaskCount: 2 },
      }),
    /secret or private-account material/,
  );
});

test("receipt generation requires an explicit fresh isolated store confirmation", () => {
  const sources = syntheticSources();
  assert.throws(
    () =>
      buildBuildWeekEvidenceReceipt({
        ...sources,
        datasetVersion: "oracle-v1",
        limitationCodes: [],
        freshIsolatedStoreConfirmed: false,
        publicationScope: { kind: "full", expectedTaskCount: 2 },
      } as unknown as Parameters<typeof buildBuildWeekEvidenceReceipt>[0]),
    /fresh isolated benchmark store confirmation is required/,
  );
});
