import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { link, mkdtemp, open, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  BUILD_WEEK_LONGMEMEVAL_DATASET_VERSION,
  BUILD_WEEK_LONGMEMEVAL_FULL_TASK_COUNT,
  BUILD_WEEK_LONGMEMEVAL_PAYLOAD_SHA256,
  BUILD_WEEK_LONGMEMEVAL_TASK_ID_SET_SHA256,
  BUILD_WEEK_MEMCORRECT_DATASET_VERSION,
  BUILD_WEEK_MEMCORRECT_FULL_TASK_COUNT,
  BUILD_WEEK_MEMCORRECT_PAYLOAD_SHA256,
  buildBuildWeekEvidenceReceipt,
  serializeBuildWeekEvidenceReceipt,
  writeBuildWeekEvidenceReceipt,
} from "./build-week-evidence-receipt.ts";
import { LONGMEMEVAL_CANONICAL_TASK_IDS } from "./longmemeval-canonical-task-ids.test-fixture.ts";
import { buildBenchmarkArtifact, serializeBenchmarkArtifact } from "./published-artifact.ts";
import {
  computeBenchmarkReproDatasetInventoryHash,
  computeBenchmarkReproManifestArtifactHash,
  type BenchmarkReproManifest,
  type BenchmarkReproManifestDataset,
} from "./repro-manifest.js";
import type { BenchmarkResult } from "./types.js";
import { corpusHash, generateMemCorrectCorpus } from "./benchmarks/remnic/memcorrect/generator.js";

const DATASET_HASH = BUILD_WEEK_LONGMEMEVAL_PAYLOAD_SHA256;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function rehashManifest(manifest: BenchmarkReproManifest): void {
  const { artifactHash: _artifactHash, ...withoutArtifactHash } = manifest;
  manifest.artifactHash = computeBenchmarkReproManifestArtifactHash(withoutArtifactHash);
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

function syntheticMemCorrectResult(): BenchmarkResult {
  const result = syntheticResult({
    benchmark: "memcorrect-v1",
    benchmarkTier: "remnic",
    version: "1.0.0",
    seeds: [0xc077e7],
    datasetHash: BUILD_WEEK_MEMCORRECT_PAYLOAD_SHA256,
  });
  result.config.adapterMode = "remnic-native";
  result.config.benchmarkOptions = {
    personaCount: 5,
    factsPerPersona: 8,
    maintenanceCycles: 5,
    uptakeLatencyCap: 8,
    judgeTelemetry: {
      calls: 80,
      inputTokens: 1000,
      outputTokens: 100,
      latencyMs: 2000,
    },
  };
  result.cost.judgeModelCalls = 80;
  result.results.tasks = Array.from({ length: BUILD_WEEK_MEMCORRECT_FULL_TASK_COUNT }, (_, index) => ({
    taskId: `memcorrect-${0xc077e7}-${index.toString(16)}`,
    question: `private correction question ${index}`,
    expected: `private corrected value ${index}`,
    actual: `private recalled value ${index}`,
    scores: {
      uptake_at_next: 1,
      uptake_latency: 1,
      uptake_latency_censored: 1,
      non_resurrection: 1,
      false_apply: 1,
      judge_correction_acceptance: 1,
      judge_stale_harm_avoidance: 1,
      ...(index === 0 ? { scope_precision: 1 } : {}),
      ...(index === 1 ? { reassertion: 1 } : {}),
    },
    latencyMs: 1000,
    tokens: { input: 25, output: 5 },
  }));
  result.results.aggregates = {
    uptake_at_next: { mean: 1, median: 1, stdDev: 0, min: 1, max: 1 },
    uptake_latency: { mean: 1, median: 1, stdDev: 0, min: 1, max: 1 },
    uptake_latency_censored: { mean: 1, median: 1, stdDev: 0, min: 1, max: 1 },
    non_resurrection: { mean: 1, median: 1, stdDev: 0, min: 1, max: 1 },
    false_apply: { mean: 1, median: 1, stdDev: 0, min: 1, max: 1 },
    judge_correction_acceptance: { mean: 1, median: 1, stdDev: 0, min: 1, max: 1 },
    judge_stale_harm_avoidance: { mean: 1, median: 1, stdDev: 0, min: 1, max: 1 },
    scope_precision: { mean: 1, median: 1, stdDev: 0, min: 1, max: 1 },
    reassertion: { mean: 1, median: 1, stdDev: 0, min: 1, max: 1 },
  };
  return result;
}

function syntheticCanonicalLongMemEvalResult(): BenchmarkResult {
  const result = syntheticResult({ version: "2.0.0", datasetHash: BUILD_WEEK_LONGMEMEVAL_PAYLOAD_SHA256 });
  result.results.tasks = LONGMEMEVAL_CANONICAL_TASK_IDS.map((taskId, index) => ({
    taskId,
    question: `private question ${index}`,
    expected: `private expected answer ${index}`,
    actual: `private generated answer ${index}`,
    scores: {
      contains_answer: index % 2,
      f1: index % 2,
      judge_accuracy: index % 2,
      llm_judge: index % 2,
      search_hits: 1,
    },
    latencyMs: 1000,
    tokens: { input: 50, output: 25 },
    ...(index === 0 ? { details: { recall: "private recalled production text" } } : {}),
  }));
  result.results.aggregates = {
    contains_answer: { mean: 0.5, median: 0.5, stdDev: 0.5, min: 0, max: 1 },
    f1: { mean: 0.5, median: 0.5, stdDev: 0.5, min: 0, max: 1 },
    judge_accuracy: { mean: 0.5, median: 0.5, stdDev: 0.5, min: 0, max: 1 },
    llm_judge: { mean: 0.5, median: 0.5, stdDev: 0.5, min: 0, max: 1 },
    search_hits: { mean: 1, median: 1, stdDev: 0, min: 1, max: 1 },
  };
  return result;
}

test("pinned Build Week MemCorrect identity matches the deterministic full corpus", () => {
  const corpus = generateMemCorrectCorpus({
    personaCount: 5,
    factsPerPersona: 8,
    seed: 0xc077e7,
    nowIso: "2026-07-05T00:00:00.000Z",
    maintenanceCycles: 5,
    uptakeLatencyCap: 8,
  });
  assert.equal(corpus.scenarios.length, BUILD_WEEK_MEMCORRECT_FULL_TASK_COUNT);
  assert.equal(corpusHash(corpus), BUILD_WEEK_MEMCORRECT_PAYLOAD_SHA256);
  assert.deepEqual(
    corpus.scenarios.map((scenario) => scenario.id),
    Array.from(
      { length: BUILD_WEEK_MEMCORRECT_FULL_TASK_COUNT },
      (_, index) => `memcorrect-${0xc077e7}-${index.toString(16)}`,
    ),
  );
});

test("pinned LongMemEval task identity hash matches its public ID fixture", () => {
  assert.equal(LONGMEMEVAL_CANONICAL_TASK_IDS.length, BUILD_WEEK_LONGMEMEVAL_FULL_TASK_COUNT);
  assert.equal(new Set(LONGMEMEVAL_CANONICAL_TASK_IDS).size, BUILD_WEEK_LONGMEMEVAL_FULL_TASK_COUNT);
  assert.equal(
    sha256(JSON.stringify([...LONGMEMEVAL_CANONICAL_TASK_IDS].sort())),
    BUILD_WEEK_LONGMEMEVAL_TASK_ID_SET_SHA256,
  );
});

function syntheticSources(args: {
  result?: BenchmarkResult;
  limit?: number;
  usageModel?: string;
} = {}): { resultJson: string; manifestJson: string; publicArtifactJson?: string } {
  const result = args.result ?? syntheticResult();
  const resultJson = `${JSON.stringify(result, null, 2)}\n`;
  const fileDatasetFiles: BenchmarkReproManifestDataset["files"] = [
    {
      path: result.meta.benchmark === "longmemeval" && result.meta.version === "2.0.0"
        ? "longmemeval_oracle.json"
        : "private-dataset.json",
      kind: "file",
      sizeBytes: 1234,
      sha256: DATASET_HASH,
    },
  ];
  const manifest: BenchmarkReproManifest = {
    schemaVersion: 1,
    generatedAt: "2026-07-16T21:00:00.000Z",
    run: {
      id: "synthetic-run-id",
      mode: "full",
      selectedBenchmarks: [result.meta.benchmark],
      runtimeProfiles: ["real"],
      selectedWorkItems: [{ benchmark: result.meta.benchmark, runtimeProfile: "real" }],
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
    datasets: result.meta.benchmark === "memcorrect-v1"
      ? [{ benchmark: "memcorrect-v1", status: "not-provided", fileCount: 0, totalBytes: 0, files: [] }]
      : [
          {
            benchmark: result.meta.benchmark,
            status: "hashed",
            path: "/home/private/bench-datasets/longmemeval",
            realpath: "/home/private/bench-datasets/longmemeval",
            fileCount: 1,
            totalBytes: 1234,
            sha256: computeBenchmarkReproDatasetInventoryHash(fileDatasetFiles),
            files: fileDatasetFiles,
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
    artifactHash: "",
  };
  rehashManifest(manifest);
  const publicArtifactJson =
    result.meta.benchmark === "longmemeval" &&
    result.meta.version === "2.0.0" &&
    result.results.tasks.length === BUILD_WEEK_LONGMEMEVAL_FULL_TASK_COUNT
      ? serializeBenchmarkArtifact(
          buildBenchmarkArtifact({
            benchmarkId: "longmemeval",
            datasetVersion: BUILD_WEEK_LONGMEMEVAL_DATASET_VERSION,
            model: result.config.systemProvider!.model,
            seed: result.meta.seeds[0]!,
            startedAt: "2026-07-16T20:00:00.000Z",
            finishedAt: "2026-07-16T21:00:00.000Z",
            result,
            tier: "frontier",
          }),
        )
      : undefined;
  return {
    resultJson,
    manifestJson: `${JSON.stringify(manifest, null, 2)}\n`,
    ...(publicArtifactJson ? { publicArtifactJson } : {}),
  };
}

test("buildBuildWeekEvidenceReceipt emits deterministic aggregate-only evidence", () => {
  const sources = syntheticSources({ result: syntheticCanonicalLongMemEvalResult() });
  const options = {
    ...sources,
    datasetVersion: BUILD_WEEK_LONGMEMEVAL_DATASET_VERSION,
    limitationCodes: ["singleRun", "estimatedAccounting", "modelJudged"] as const,
    freshIsolatedStoreConfirmed: true as const,
    publicationScope: { kind: "full", expectedTaskCount: BUILD_WEEK_LONGMEMEVAL_FULL_TASK_COUNT } as const,
  };
  const first = buildBuildWeekEvidenceReceipt(options);
  const second = buildBuildWeekEvidenceReceipt(options);
  assert.deepEqual(first, second);
  assert.equal(serializeBuildWeekEvidenceReceipt(first), serializeBuildWeekEvidenceReceipt(second));
  assert.equal(first.benchmark.taskCount, BUILD_WEEK_LONGMEMEVAL_FULL_TASK_COUNT);
  assert.equal(first.benchmark.failureCount, 0);
  assert.equal(first.dataset.source, "file-manifest");
  assert.equal(first.estimatedUsage.calls, 6);
  assert.equal(first.estimatedUsage.totalTokens, 1100);
  assert.equal(first.estimatedUsage.localBudgetUnits, 42.5);
  assert.equal(first.integrity.resultSha256, sha256(sources.resultJson));
  assert.equal(first.integrity.manifestSha256, sha256(sources.manifestJson));
  assert.equal(first.integrity.publicArtifactSha256, sha256(sources.publicArtifactJson!));
  assert.deepEqual(first.provenance.providers, [
    { role: "system", provider: "codex-cli", model: "gpt-5.6-luna", reasoningEffort: "medium", serviceTier: null },
    { role: "internal", provider: "codex-cli", model: "gpt-5.6-luna", reasoningEffort: "medium", serviceTier: null },
    { role: "judge", provider: "codex-cli", model: "gpt-5.6-terra", reasoningEffort: "high", serviceTier: null },
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

  assert.throws(() => buildFull(syntheticSources({ result: syntheticResult({ status: "partial" }) })), /canonical complete status/);
  assert.throws(
    () => buildFull(syntheticSources({ result: syntheticResult({ status: "invalid" as "complete" }) })),
    /canonical complete status/,
  );
  assert.throws(() => buildFull(syntheticSources({ result: syntheticResult({ mode: "quick" }) })), /full-mode/);
  assert.throws(() => buildFull(syntheticSources({ limit: 2 })), /limited manifest/);
  assert.throws(() => buildFull(syntheticSources(), 3), /task count 2 does not match expected 3/);

  const failed = syntheticResult();
  failed.results.tasks[0]!.details = { error: "private backend failure" };
  assert.throws(() => buildFull(syntheticSources({ result: failed })), /task\(s\) contain failure markers/);

  const sources = syntheticSources();
  const manifest = JSON.parse(sources.manifestJson) as BenchmarkReproManifest;
  manifest.results[0]!.sha256 = "e".repeat(64);
  rehashManifest(manifest);
  assert.throws(
    () => buildFull({ ...sources, manifestJson: JSON.stringify(manifest) }),
    /result hash does not match/,
  );
});

test("canonical successful results may omit status and derive LongMem payload hash from one manifest file", () => {
  const result = syntheticCanonicalLongMemEvalResult();
  delete result.meta.status;
  delete result.meta.datasetHash;
  const sources = syntheticSources({ result });
  const manifest = JSON.parse(sources.manifestJson) as BenchmarkReproManifest;
  const dataset = manifest.datasets[0]!;
  dataset.files[0]!.path = "longmemeval_oracle.json";
  dataset.sha256 = computeBenchmarkReproDatasetInventoryHash(dataset.files);
  rehashManifest(manifest);

  const receipt = buildBuildWeekEvidenceReceipt({
    resultJson: sources.resultJson,
    manifestJson: JSON.stringify(manifest),
    publicArtifactJson: sources.publicArtifactJson,
    datasetVersion: BUILD_WEEK_LONGMEMEVAL_DATASET_VERSION,
    limitationCodes: ["singleRun", "estimatedAccounting", "modelJudged"],
    freshIsolatedStoreConfirmed: true,
    publicationScope: { kind: "full", expectedTaskCount: BUILD_WEEK_LONGMEMEVAL_FULL_TASK_COUNT },
  });
  assert.equal(receipt.benchmark.status, "complete");
  assert.equal(receipt.dataset.payloadSha256, DATASET_HASH);
  assert.equal(receipt.dataset.manifestSha256, dataset.sha256);
});

test("full LongMemEval receipts bind the canonical corpus identity", () => {
  const build = (result: BenchmarkResult, datasetVersion: string = BUILD_WEEK_LONGMEMEVAL_DATASET_VERSION) =>
    buildBuildWeekEvidenceReceipt({
      ...syntheticSources({ result }),
      datasetVersion,
      limitationCodes: ["singleRun", "estimatedAccounting", "modelJudged"],
      freshIsolatedStoreConfirmed: true,
      publicationScope: { kind: "full", expectedTaskCount: BUILD_WEEK_LONGMEMEVAL_FULL_TASK_COUNT },
    });

  assert.doesNotThrow(() => build(syntheticCanonicalLongMemEvalResult()));

  const wrongVersion = syntheticCanonicalLongMemEvalResult();
  wrongVersion.meta.version = "oracle-v1";
  assert.throws(() => build(wrongVersion), /benchmark version must be 2\.0\.0/);

  assert.throws(
    () => build(syntheticCanonicalLongMemEvalResult(), "longmemeval-oracle-unpinned"),
    /datasetVersion must be longmemeval-oracle/,
  );

  const wrongPayload = syntheticCanonicalLongMemEvalResult();
  wrongPayload.meta.datasetHash = "f".repeat(64);
  assert.throws(() => build(wrongPayload), /canonical dataset payload file|pinned full corpus/);

  const tooShort = syntheticCanonicalLongMemEvalResult();
  tooShort.results.tasks.pop();
  assert.throws(() => build(tooShort), /does not match expected 500/);

  const duplicateTask = syntheticCanonicalLongMemEvalResult();
  duplicateTask.results.tasks[1]!.taskId = duplicateTask.results.tasks[0]!.taskId;
  assert.throws(() => build(duplicateTask), /500 unique task identities/);

  const fabricatedMetrics = syntheticCanonicalLongMemEvalResult();
  for (const task of fabricatedMetrics.results.tasks) task.scores = { fabricated_metric: 1 };
  fabricatedMetrics.results.aggregates = {
    fabricated_metric: { mean: 1, median: 1, stdDev: 0, min: 1, max: 1 },
  };
  assert.throws(() => build(fabricatedMetrics), /metric schema does not match the pinned benchmark metrics/);

  const arbitraryInventoryResult = syntheticCanonicalLongMemEvalResult();
  const arbitraryInventorySources = syntheticSources({ result: arbitraryInventoryResult });
  const arbitraryInventoryManifest = JSON.parse(arbitraryInventorySources.manifestJson) as BenchmarkReproManifest;
  const arbitraryDataset = arbitraryInventoryManifest.datasets[0]!;
  arbitraryDataset.files = [
    { path: "part-1.json", kind: "file", sizeBytes: 600, sha256: "a".repeat(64) },
    { path: "part-2.json", kind: "file", sizeBytes: 634, sha256: "b".repeat(64) },
  ];
  arbitraryDataset.fileCount = 2;
  arbitraryDataset.totalBytes = 1234;
  arbitraryDataset.sha256 = computeBenchmarkReproDatasetInventoryHash(arbitraryDataset.files);
  rehashManifest(arbitraryInventoryManifest);
  assert.throws(
    () => buildBuildWeekEvidenceReceipt({
      resultJson: arbitraryInventorySources.resultJson,
      manifestJson: JSON.stringify(arbitraryInventoryManifest),
      datasetVersion: BUILD_WEEK_LONGMEMEVAL_DATASET_VERSION,
      limitationCodes: ["singleRun"],
      freshIsolatedStoreConfirmed: true,
      publicationScope: { kind: "full", expectedTaskCount: BUILD_WEEK_LONGMEMEVAL_FULL_TASK_COUNT },
    }),
    /pinned canonical dataset file inventory/,
  );
});

test("LongMem payload fallback rejects ambiguous, linked, or inconsistent dataset inventories", () => {
  const build = (mutate: (manifest: BenchmarkReproManifest) => void) => {
    const result = syntheticResult();
    delete result.meta.status;
    delete result.meta.datasetHash;
    const sources = syntheticSources({ result });
    const manifest = JSON.parse(sources.manifestJson) as BenchmarkReproManifest;
    manifest.datasets[0]!.files[0]!.path = "longmemeval_oracle.json";
    mutate(manifest);
    manifest.datasets[0]!.sha256 = computeBenchmarkReproDatasetInventoryHash(manifest.datasets[0]!.files);
    rehashManifest(manifest);
    return () => buildBuildWeekEvidenceReceipt({
      resultJson: sources.resultJson,
      manifestJson: JSON.stringify(manifest),
      datasetVersion: "longmemeval-oracle",
      limitationCodes: ["singleRun"],
      freshIsolatedStoreConfirmed: true,
      publicationScope: { kind: "full", expectedTaskCount: 2 },
    });
  };

  assert.throws(build((manifest) => {
    const dataset = manifest.datasets[0]!;
    dataset.files.push({ path: "extra.json", kind: "file", sizeBytes: 1, sha256: "f".repeat(64) });
    dataset.fileCount = 2;
    dataset.totalBytes = 1235;
  }), /one canonical regular dataset payload file/);
  assert.throws(build((manifest) => {
    const file = manifest.datasets[0]!.files[0]!;
    file.kind = "symlink";
    file.target = "longmemeval_oracle.json";
  }), /one canonical regular dataset payload file/);
  assert.throws(build((manifest) => {
    manifest.datasets[0]!.totalBytes = 1235;
  }), /inventory total/);
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
      limitationCodes: ["boundedSubset", "singleRun", "estimatedAccounting", "modelJudged"],
      freshIsolatedStoreConfirmed: true,
      publicationScope: { kind: "bounded-subset", expectedTaskCount: 2 },
    }),
  );
  assert.throws(
    () =>
      buildBuildWeekEvidenceReceipt({
        ...syntheticSources({ limit: 2, usageModel: "gpt-5.6-sol" }),
        datasetVersion: "oracle-v1",
        limitationCodes: ["boundedSubset", "singleRun", "estimatedAccounting", "modelJudged"],
        freshIsolatedStoreConfirmed: true,
        publicationScope: { kind: "bounded-subset", expectedTaskCount: 2 },
      }),
    /forbidden gpt-5\.6-sol/,
  );
});

test("receipt limitations are required by the recorded run", () => {
  const build = (result: BenchmarkResult, limitationCodes: Parameters<typeof buildBuildWeekEvidenceReceipt>[0]["limitationCodes"]) =>
    buildBuildWeekEvidenceReceipt({
      ...syntheticSources({ result, limit: 2 }),
      datasetVersion: "oracle-v1",
      limitationCodes,
      freshIsolatedStoreConfirmed: true,
      publicationScope: { kind: "bounded-subset", expectedTaskCount: 2 },
    });

  assert.throws(
    () => build(syntheticResult(), ["boundedSubset", "singleRun", "modelJudged"]),
    /estimatedAccounting limitation/,
  );
  assert.throws(
    () => build(syntheticResult(), ["boundedSubset", "singleRun", "estimatedAccounting"]),
    /modelJudged limitation/,
  );
  assert.throws(
    () => build(syntheticResult(), ["boundedSubset", "estimatedAccounting", "modelJudged"]),
    /singleRun limitation/,
  );

  const repeated = syntheticResult();
  repeated.meta.runCount = 2;
  assert.throws(
    () => build(repeated, ["boundedSubset", "singleRun", "estimatedAccounting", "modelJudged"]),
    /singleRun limitation is only valid when runCount is 1/,
  );
});

test("every configured provider is backed by positive Codex CLI run usage", () => {
  const limitationCodes = ["boundedSubset", "singleRun", "estimatedAccounting", "modelJudged"] as const;
  const nonCodex = syntheticResult();
  nonCodex.config.systemProvider!.provider = "openai";
  assert.throws(
    () => buildBuildWeekEvidenceReceipt({
      ...syntheticSources({ result: nonCodex, limit: 2 }),
      datasetVersion: "oracle-v1",
      limitationCodes,
      freshIsolatedStoreConfirmed: true,
      publicationScope: { kind: "bounded-subset", expectedTaskCount: 2 },
    }),
    /require Codex CLI providers/,
  );

  const sources = syntheticSources({ limit: 2 });
  const manifest = JSON.parse(sources.manifestJson) as BenchmarkReproManifest;
  const runUsage = manifest.codexCredit!.run!;
  runUsage.models[0]!.calls = 0;
  runUsage.calls = 2;
  rehashManifest(manifest);
  assert.throws(
    () => buildBuildWeekEvidenceReceipt({
      resultJson: sources.resultJson,
      manifestJson: JSON.stringify(manifest),
      datasetVersion: "oracle-v1",
      limitationCodes,
      freshIsolatedStoreConfirmed: true,
      publicationScope: { kind: "bounded-subset", expectedTaskCount: 2 },
    }),
    /does not bind configured model gpt-5\.6-luna/,
  );

  const malformedSources = syntheticSources({ limit: 2 });
  const malformedManifest = JSON.parse(malformedSources.manifestJson) as BenchmarkReproManifest;
  malformedManifest.codexCredit!.run!.models[0]!.calls = -1;
  malformedManifest.codexCredit!.run!.models[1]!.calls = 7;
  rehashManifest(malformedManifest);
  assert.throws(
    () => buildBuildWeekEvidenceReceipt({
      resultJson: malformedSources.resultJson,
      manifestJson: JSON.stringify(malformedManifest),
      datasetVersion: "oracle-v1",
      limitationCodes,
      freshIsolatedStoreConfirmed: true,
      publicationScope: { kind: "bounded-subset", expectedTaskCount: 2 },
    }),
    /run usage model gpt-5\.6-luna calls must be a finite non-negative number/,
  );
});

test("full LongMemEval receipt rejects a public artifact that diverges from the private result", () => {
  const result = syntheticCanonicalLongMemEvalResult();
  const sources = syntheticSources({ result });
  const artifact = JSON.parse(sources.publicArtifactJson!) as {
    perTaskScores: Array<{ scores: Record<string, number> }>;
  };
  artifact.perTaskScores[0]!.scores.f1 = 0.25;
  assert.throws(
    () => buildBuildWeekEvidenceReceipt({
      resultJson: sources.resultJson,
      manifestJson: sources.manifestJson,
      publicArtifactJson: JSON.stringify(artifact),
      datasetVersion: BUILD_WEEK_LONGMEMEVAL_DATASET_VERSION,
      limitationCodes: ["singleRun", "estimatedAccounting", "modelJudged"],
      freshIsolatedStoreConfirmed: true,
      publicationScope: { kind: "full", expectedTaskCount: BUILD_WEEK_LONGMEMEVAL_FULL_TASK_COUNT },
    }),
    /public artifact task 0 score f1 does not match/,
  );
});

test("full MemCorrect receipts bind the pinned generated corpus without copying task content", () => {
  const sources = syntheticSources({ result: syntheticMemCorrectResult() });
  const receipt = buildBuildWeekEvidenceReceipt({
    ...sources,
    datasetVersion: BUILD_WEEK_MEMCORRECT_DATASET_VERSION,
    limitationCodes: ["singleRun", "estimatedAccounting", "modelJudged"],
    freshIsolatedStoreConfirmed: true,
    publicationScope: { kind: "full", expectedTaskCount: BUILD_WEEK_MEMCORRECT_FULL_TASK_COUNT },
  });

  assert.equal(receipt.benchmark.id, "memcorrect-v1");
  assert.equal(receipt.benchmark.taskCount, BUILD_WEEK_MEMCORRECT_FULL_TASK_COUNT);
  assert.equal(receipt.dataset.source, "generated-corpus");
  assert.equal(receipt.dataset.version, BUILD_WEEK_MEMCORRECT_DATASET_VERSION);
  assert.equal(receipt.dataset.payloadSha256, BUILD_WEEK_MEMCORRECT_PAYLOAD_SHA256);
  assert.match(receipt.dataset.manifestSha256, /^[0-9a-f]{64}$/);
  assert.equal(receipt.dataset.fileCount, 0);
  assert.equal(receipt.dataset.totalBytes, 0);
  const serialized = serializeBuildWeekEvidenceReceipt(receipt);
  assert.equal(serialized.includes("private correction question"), false);
  assert.equal(serialized.includes("private corrected value"), false);
  assert.equal(serialized.includes("memcorrect-12613607-0"), false);
});

test("MemCorrect receipts reject missing, fabricated, or mismatched generated-corpus provenance", () => {
  const build = (
    sources: ReturnType<typeof syntheticSources>,
    datasetVersion: string = BUILD_WEEK_MEMCORRECT_DATASET_VERSION,
  ) =>
    buildBuildWeekEvidenceReceipt({
      ...sources,
      datasetVersion,
      limitationCodes: ["singleRun", "modelJudged"],
      freshIsolatedStoreConfirmed: true,
      publicationScope: { kind: "full", expectedTaskCount: BUILD_WEEK_MEMCORRECT_FULL_TASK_COUNT },
    });

  const wrongHash = syntheticMemCorrectResult();
  wrongHash.meta.datasetHash = "f".repeat(64);
  assert.throws(() => build(syntheticSources({ result: wrongHash })), /pinned full-corpus payload hash/);

  const wrongSeed = syntheticMemCorrectResult();
  wrongSeed.meta.seeds = [123];
  assert.throws(() => build(syntheticSources({ result: wrongSeed })), /pinned seed/);

  const wrongOptions = syntheticMemCorrectResult();
  (wrongOptions.config.benchmarkOptions as Record<string, unknown>).factsPerPersona = 7;
  assert.throws(() => build(syntheticSources({ result: wrongOptions })), /factsPerPersona/);

  const wrongTaskIdentity = syntheticMemCorrectResult();
  wrongTaskIdentity.results.tasks[0]!.taskId = "memcorrect-12613607-fabricated";
  assert.throws(() => build(syntheticSources({ result: wrongTaskIdentity })), /task identities/);

  const missingDataset = syntheticSources({ result: syntheticMemCorrectResult() });
  const missingManifest = JSON.parse(missingDataset.manifestJson) as BenchmarkReproManifest;
  missingManifest.datasets = [];
  rehashManifest(missingManifest);
  assert.throws(
    () => build({ ...missingDataset, manifestJson: JSON.stringify(missingManifest) }),
    /exactly one MemCorrect generated-corpus dataset entry/,
  );

  const fabricatedFileDataset = syntheticSources({ result: syntheticMemCorrectResult() });
  const fabricatedManifest = JSON.parse(fabricatedFileDataset.manifestJson) as BenchmarkReproManifest;
  fabricatedManifest.datasets[0] = {
    benchmark: "memcorrect-v1",
    status: "hashed",
    fileCount: 1,
    totalBytes: 1,
    sha256: BUILD_WEEK_MEMCORRECT_PAYLOAD_SHA256,
    files: [{ path: "fabricated.json", kind: "file", sizeBytes: 1, sha256: BUILD_WEEK_MEMCORRECT_PAYLOAD_SHA256 }],
  };
  rehashManifest(fabricatedManifest);
  assert.throws(
    () => build({ ...fabricatedFileDataset, manifestJson: JSON.stringify(fabricatedManifest) }),
    /generated corpus without file-backed provenance/,
  );

  assert.throws(
    () => build(syntheticSources({ result: syntheticMemCorrectResult() }), "memcorrect-v1-unpinned"),
    /datasetVersion must be/,
  );
});

test("MemCorrect receipts reject non-full coverage, failed tasks, wrong adapter, and incomplete judge telemetry", () => {
  const build = (
    result: BenchmarkResult,
    expectedTaskCount: number = BUILD_WEEK_MEMCORRECT_FULL_TASK_COUNT,
  ) =>
    buildBuildWeekEvidenceReceipt({
      ...syntheticSources({ result }),
      datasetVersion: BUILD_WEEK_MEMCORRECT_DATASET_VERSION,
      limitationCodes: ["singleRun", "modelJudged"],
      freshIsolatedStoreConfirmed: true,
      publicationScope: { kind: "full", expectedTaskCount },
    });

  assert.throws(() => build(syntheticMemCorrectResult(), 39), /task count 40 does not match expected 39/);

  const failed = syntheticMemCorrectResult();
  failed.results.tasks[0]!.details = {
    benchmarkFailure: { kind: "trial_execution_failure", message: "private failure" },
  };
  assert.throws(() => build(failed), /task\(s\) contain failure markers/);

  const quick = syntheticMemCorrectResult();
  quick.meta.mode = "quick";
  assert.throws(() => build(quick), /full-mode/);

  const partial = syntheticMemCorrectResult();
  partial.meta.status = "partial";
  assert.throws(() => build(partial), /canonical complete status/);

  const wrongAdapter = syntheticMemCorrectResult();
  wrongAdapter.config.adapterMode = "prompt-only-baseline";
  assert.throws(() => build(wrongAdapter), /adapterMode remnic-native/);

  const missingJudgeCall = syntheticMemCorrectResult();
  missingJudgeCall.cost.judgeModelCalls = 79;
  assert.throws(() => build(missingJudgeCall), /two specialized judge calls per task/);
});

test("file-backed benchmark receipts still reject non-hashed dataset manifests", () => {
  const sources = syntheticSources();
  const manifest = JSON.parse(sources.manifestJson) as BenchmarkReproManifest;
  manifest.datasets[0] = {
    benchmark: "longmemeval",
    status: "not-provided",
    fileCount: 0,
    totalBytes: 0,
    files: [],
  };
  rehashManifest(manifest);
  assert.throws(
    () =>
      buildBuildWeekEvidenceReceipt({
        ...sources,
        manifestJson: JSON.stringify(manifest),
        datasetVersion: "longmemeval-oracle-v1",
        limitationCodes: ["singleRun"],
        freshIsolatedStoreConfirmed: true,
        publicationScope: { kind: "full", expectedTaskCount: 2 },
      }),
    /hashed dataset entry/,
  );
});

test("receipt rejects a tampered manifest artifact hash", () => {
  const sources = syntheticSources({ limit: 2 });
  const manifest = JSON.parse(sources.manifestJson) as BenchmarkReproManifest;
  manifest.run.runtimeProfiles = ["tampered"];
  assert.throws(
    () =>
      buildBuildWeekEvidenceReceipt({
        ...sources,
        manifestJson: JSON.stringify(manifest),
        datasetVersion: "longmemeval-oracle-v1",
        limitationCodes: ["boundedSubset", "singleRun", "estimatedAccounting", "modelJudged"],
        freshIsolatedStoreConfirmed: true,
        publicationScope: { kind: "bounded-subset", expectedTaskCount: 2 },
      }),
    /artifactHash does not match/,
  );
});

test("receipt metadata rejects path and secret-bearing public identifiers", () => {
  const sources = syntheticSources({ limit: 2 });
  assert.throws(
    () =>
      buildBuildWeekEvidenceReceipt({
        ...sources,
        datasetVersion: "/home/private/dataset-v1",
        limitationCodes: ["boundedSubset", "singleRun", "estimatedAccounting", "modelJudged"],
        freshIsolatedStoreConfirmed: true,
        publicationScope: { kind: "bounded-subset", expectedTaskCount: 2 },
      }),
    /safe public identifier/,
  );
  const unsafe = syntheticResult({ id: "sk-private-secret-value" });
  assert.throws(
    () =>
      buildBuildWeekEvidenceReceipt({
        ...syntheticSources({ result: unsafe, limit: 2 }),
        datasetVersion: "oracle-v1",
        limitationCodes: ["boundedSubset", "singleRun", "estimatedAccounting", "modelJudged"],
        freshIsolatedStoreConfirmed: true,
        publicationScope: { kind: "bounded-subset", expectedTaskCount: 2 },
      }),
    /secret or private-account material/,
  );

  const pathLike = syntheticResult({ id: "staging/../../secrets" });
  assert.throws(
    () =>
      buildBuildWeekEvidenceReceipt({
        ...syntheticSources({ result: pathLike, limit: 2 }),
        datasetVersion: "oracle-v1",
        limitationCodes: ["boundedSubset", "singleRun", "estimatedAccounting", "modelJudged"],
        freshIsolatedStoreConfirmed: true,
        publicationScope: { kind: "bounded-subset", expectedTaskCount: 2 },
      }),
    /compact public identifier/,
  );

  const unsafeReasoningEffort = syntheticResult();
  unsafeReasoningEffort.config.systemProvider!.reasoningEffort = "/home/private/reasoning" as "medium";
  assert.throws(
    () =>
      buildBuildWeekEvidenceReceipt({
        ...syntheticSources({ result: unsafeReasoningEffort, limit: 2 }),
        datasetVersion: "oracle-v1",
        limitationCodes: ["boundedSubset"],
        freshIsolatedStoreConfirmed: true,
        publicationScope: { kind: "bounded-subset", expectedTaskCount: 2 },
      }),
    /reasoningEffort must be one of/,
  );
});

test("receipt rejects recorded aggregates that do not match task scores", () => {
  const stale = syntheticResult();
  stale.results.aggregates.exact_match!.mean = 1;
  assert.throws(
    () =>
      buildBuildWeekEvidenceReceipt({
        ...syntheticSources({ result: stale, limit: 2 }),
        datasetVersion: "oracle-v1",
        limitationCodes: ["boundedSubset", "singleRun", "estimatedAccounting", "modelJudged"],
        freshIsolatedStoreConfirmed: true,
        publicationScope: { kind: "bounded-subset", expectedTaskCount: 2 },
      }),
    /aggregate exact_match\.mean does not match task scores/,
  );

  const missingTaskMetric = syntheticResult();
  missingTaskMetric.results.tasks[1]!.scores = {};
  missingTaskMetric.results.aggregates.exact_match = {
    mean: 1,
    median: 1,
    stdDev: 0,
    min: 1,
    max: 1,
  };
  assert.throws(
    () =>
      buildBuildWeekEvidenceReceipt({
        ...syntheticSources({ result: missingTaskMetric, limit: 2 }),
        datasetVersion: "oracle-v1",
        limitationCodes: ["boundedSubset", "singleRun", "estimatedAccounting", "modelJudged"],
        freshIsolatedStoreConfirmed: true,
        publicationScope: { kind: "bounded-subset", expectedTaskCount: 2 },
      }),
    /task 1 metric names do not match the complete aggregate metric set/,
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

test("receipt writer is create-only and rejects paths that could replace existing files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "remnic-build-week-receipt-"));
  try {
    const sources = syntheticSources({ limit: 2 });
    const resultPath = join(directory, "result.json");
    const manifestPath = join(directory, "MANIFEST.json");
    const symlinkPath = join(directory, "receipt-link.json");
    const hardLinkPath = join(directory, "receipt-hard-link.json");
    const harmlessTargetPath = join(directory, "harmless-target.txt");
    const replaceableSymlinkPath = join(directory, "replaceable-receipt-link.json");
    const existingOutputPath = join(directory, "existing-receipt.json");
    const newOutputPath = join(directory, "new-receipt.json");
    await Promise.all([
      writeFile(resultPath, sources.resultJson),
      writeFile(manifestPath, sources.manifestJson),
      writeFile(harmlessTargetPath, "leave this file unchanged"),
      writeFile(existingOutputPath, "leave this existing output unchanged"),
    ]);

    const write = (outputPath: string) =>
      writeBuildWeekEvidenceReceipt({
        resultPath,
        manifestPath,
        outputPath,
        datasetVersion: "longmemeval-oracle-v1",
        limitationCodes: ["boundedSubset", "singleRun", "estimatedAccounting", "modelJudged"],
        freshIsolatedStoreConfirmed: true,
        publicationScope: { kind: "bounded-subset", expectedTaskCount: 2 },
      });

    await assert.rejects(write(resultPath), /must not alias/);
    assert.equal(await readFile(resultPath, "utf8"), sources.resultJson);

    await symlink(manifestPath, symlinkPath);
    await assert.rejects(write(symlinkPath), /must not alias/);
    assert.equal(await readFile(manifestPath, "utf8"), sources.manifestJson);

    await link(resultPath, hardLinkPath);
    await assert.rejects(write(hardLinkPath), /must not share identity/);
    assert.equal(await readFile(resultPath, "utf8"), sources.resultJson);

    await symlink(harmlessTargetPath, replaceableSymlinkPath);
    await assert.rejects(write(replaceableSymlinkPath), /EEXIST/);
    assert.equal(await readFile(harmlessTargetPath, "utf8"), "leave this file unchanged");

    await assert.rejects(write(existingOutputPath), /EEXIST/);
    assert.equal(await readFile(existingOutputPath, "utf8"), "leave this existing output unchanged");

    const receipt = await write(newOutputPath);
    assert.deepEqual(JSON.parse(await readFile(newOutputPath, "utf8")), receipt);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("receipt writer removes a partial create-only output after sync failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "remnic-build-week-receipt-failure-"));
  const probePath = join(directory, "probe.json");
  const outputPath = join(directory, "receipt.json");
  try {
    const sources = syntheticSources({ limit: 2 });
    const resultPath = join(directory, "result.json");
    const manifestPath = join(directory, "MANIFEST.json");
    await Promise.all([
      writeFile(resultPath, sources.resultJson),
      writeFile(manifestPath, sources.manifestJson),
    ]);
    const write = () =>
      writeBuildWeekEvidenceReceipt({
        resultPath,
        manifestPath,
        outputPath,
        datasetVersion: "longmemeval-oracle-v1",
        limitationCodes: ["boundedSubset", "singleRun", "estimatedAccounting", "modelJudged"],
        freshIsolatedStoreConfirmed: true,
        publicationScope: { kind: "bounded-subset", expectedTaskCount: 2 },
      });

    const probe = await open(probePath, "wx");
    const fileHandlePrototype = Object.getPrototypeOf(probe) as {
      sync: typeof probe.sync;
    };
    const originalSync = fileHandlePrototype.sync;
    await probe.close();
    await rm(probePath);
    fileHandlePrototype.sync = async () => {
      throw new Error("forced receipt sync failure");
    };
    try {
      await assert.rejects(write(), /forced receipt sync failure/);
    } finally {
      fileHandlePrototype.sync = originalSync;
    }

    await assert.rejects(readFile(outputPath), { code: "ENOENT" });
    const receipt = await write();
    assert.deepEqual(JSON.parse(await readFile(outputPath, "utf8")), receipt);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("receipt writer does not strand an empty output when initial file identity lookup fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "remnic-build-week-receipt-stat-failure-"));
  const probePath = join(directory, "probe.json");
  const outputPath = join(directory, "receipt.json");
  try {
    const sources = syntheticSources({ limit: 2 });
    const resultPath = join(directory, "result.json");
    const manifestPath = join(directory, "MANIFEST.json");
    await Promise.all([
      writeFile(resultPath, sources.resultJson),
      writeFile(manifestPath, sources.manifestJson),
    ]);

    const probe = await open(probePath, "wx");
    const fileHandlePrototype = Object.getPrototypeOf(probe) as {
      stat: typeof probe.stat;
    };
    const originalStat = fileHandlePrototype.stat;
    await probe.close();
    await rm(probePath);
    let failedOnce = false;
    fileHandlePrototype.stat = (async function (this: typeof probe, ...args: Parameters<typeof probe.stat>) {
      if (!failedOnce) {
        failedOnce = true;
        throw new Error("forced initial receipt fstat failure");
      }
      return originalStat.apply(this, args);
    }) as typeof probe.stat;
    let receipt;
    try {
      receipt = await writeBuildWeekEvidenceReceipt({
        resultPath,
        manifestPath,
        outputPath,
        datasetVersion: "longmemeval-oracle-v1",
        limitationCodes: ["boundedSubset", "singleRun", "estimatedAccounting", "modelJudged"],
        freshIsolatedStoreConfirmed: true,
        publicationScope: { kind: "bounded-subset", expectedTaskCount: 2 },
      });
    } finally {
      fileHandlePrototype.stat = originalStat;
    }

    assert.equal(failedOnce, true);
    assert.deepEqual(JSON.parse(await readFile(outputPath, "utf8")), receipt);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("receipt writer rejects a success-path output swap without removing the replacement", async () => {
  const directory = await mkdtemp(join(tmpdir(), "remnic-build-week-receipt-output-swap-"));
  const probePath = join(directory, "probe.json");
  const outputPath = join(directory, "receipt.json");
  const displacedPath = join(directory, "displaced-receipt.json");
  try {
    const sources = syntheticSources({ limit: 2 });
    const resultPath = join(directory, "result.json");
    const manifestPath = join(directory, "MANIFEST.json");
    await Promise.all([
      writeFile(resultPath, sources.resultJson),
      writeFile(manifestPath, sources.manifestJson),
    ]);

    const probe = await open(probePath, "wx");
    const fileHandlePrototype = Object.getPrototypeOf(probe) as {
      sync: typeof probe.sync;
    };
    const originalSync = fileHandlePrototype.sync;
    await probe.close();
    await rm(probePath);
    fileHandlePrototype.sync = async function () {
      await originalSync.call(this);
      await rename(outputPath, displacedPath);
      await writeFile(outputPath, "replacement must survive");
    };
    try {
      await assert.rejects(
        writeBuildWeekEvidenceReceipt({
          resultPath,
          manifestPath,
          outputPath,
          datasetVersion: "longmemeval-oracle-v1",
          limitationCodes: ["boundedSubset", "singleRun", "estimatedAccounting", "modelJudged"],
          freshIsolatedStoreConfirmed: true,
          publicationScope: { kind: "bounded-subset", expectedTaskCount: 2 },
        }),
        /partial output could not be removed safely/,
      );
    } finally {
      fileHandlePrototype.sync = originalSync;
    }

    assert.equal(await readFile(outputPath, "utf8"), "replacement must survive");
    assert.match(await readFile(displacedPath, "utf8"), /"schemaVersion": 1/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
