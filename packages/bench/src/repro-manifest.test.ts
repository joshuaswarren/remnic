import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import {
  BENCHMARK_REPRO_MANIFEST_FILENAME,
  buildBenchmarkReproManifest,
  writeBenchmarkReproManifest,
} from "./repro-manifest.ts";
import type { BenchmarkResult } from "./types.js";

function buildResult(): BenchmarkResult {
  return {
    meta: {
      id: "run-1",
      benchmark: "longmemeval",
      benchmarkTier: "published",
      version: "1.0.0",
      remnicVersion: "9.3.167",
      gitSha: "abc1234",
      timestamp: "2026-04-24T20:00:00.000Z",
      mode: "full",
      runCount: 5,
      seeds: [42, 43, 44, 45, 46],
    },
    config: {
      runtimeProfile: "real",
      systemProvider: {
        provider: "openai",
        model: "gemma4:31b",
        baseUrl: "https://ollama.com/v1",
      },
      judgeProvider: null,
      adapterMode: "direct",
      remnicConfig: {
        qmdCollection: "bench-hot",
        qmdColdCollection: "bench-cold",
        conversationIndexQmdCollection: "bench-conversations",
      },
    },
    cost: {
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      estimatedCostUsd: 0,
      totalLatencyMs: 0,
      meanQueryLatencyMs: 0,
    },
    results: {
      tasks: [],
      aggregates: {},
    },
    environment: {
      os: "darwin",
      nodeVersion: process.version,
      hardware: process.arch,
    },
  };
}

async function createTempRoot(prefix: string): Promise<string> {
  return mkdtemp(path.join(await realpath(os.tmpdir()), prefix));
}

test("buildBenchmarkReproManifest hashes datasets/results and redacts secret argv values", async () => {
  const root = await createTempRoot("remnic-repro-manifest-");
  const resultsDir = path.join(root, "results");
  const datasetDir = path.join(root, "dataset");
  await mkdir(resultsDir, { recursive: true });
  await mkdir(path.join(datasetDir, "nested"), { recursive: true });
  await writeFile(path.join(datasetDir, "answers.json"), JSON.stringify({ answer: 42 }), "utf8");
  await writeFile(path.join(datasetDir, "nested", "notes.txt"), "dataset note\n", "utf8");
  await symlink("answers.json", path.join(datasetDir, "answers-link.json"));

  const resultPath = path.join(resultsDir, "longmemeval.json");
  await writeFile(resultPath, `${JSON.stringify(buildResult(), null, 2)}\n`, "utf8");

  const manifest = await buildBenchmarkReproManifest(resultsDir, {
    resultPaths: [resultPath],
    selectedBenchmarks: ["longmemeval"],
    runtimeProfiles: ["real"],
    mode: "full",
    seed: 42,
    datasetDirs: { longmemeval: datasetDir },
    command: {
      cwd: root,
      argv: [
        "bench",
        "run",
        "fixtures/token-benchmark.json",
        "--system-api-key",
        "secret-value",
        "--judge-api-key=other-secret",
        "--max-tokens",
        "2048",
        "--output-token-limit=128",
        "--auth-token",
        "auth-secret",
        "next-positional",
      ],
      env: { OLLAMA_API_KEY: "secret-value", QMD_CONFIG_DIR: "/tmp/qmd" },
      envKeys: ["OLLAMA_API_KEY", "QMD_CONFIG_DIR"],
    },
    qmd: { configDir: "/tmp/qmd" },
  });

  assert.equal(manifest.run.mode, "full");
  assert.match(manifest.run.id, /^20[0-9]{2}-/);
  assert.deepEqual(manifest.run.runtimeProfiles, ["real"]);
  assert.deepEqual(manifest.run.selectedWorkItems, [
    { benchmark: "longmemeval", runtimeProfile: "real" },
  ]);
  assert.equal(manifest.run.seed, 42);
  assert.deepEqual(manifest.command.argv, [
    "bench",
    "run",
    "fixtures/token-benchmark.json",
    "--system-api-key",
    "[redacted]",
    "--judge-api-key=[redacted]",
    "--max-tokens",
    "2048",
    "--output-token-limit=128",
    "--auth-token",
    "[redacted]",
    "next-positional",
  ]);
  assert.deepEqual(manifest.command.envKeys, ["OLLAMA_API_KEY", "QMD_CONFIG_DIR"]);
  assert.equal(manifest.datasets[0]?.status, "hashed");
  assert.equal(manifest.datasets[0]?.fileCount, 3);
  assert.ok(manifest.datasets[0]?.sha256);
  assert.equal(manifest.results[0]?.benchmark, "longmemeval");
  assert.equal(manifest.results[0]?.seeds.length, 5);
  assert.deepEqual(manifest.qmd?.collections, [
    "bench-cold",
    "bench-conversations",
    "bench-hot",
  ]);
  assert.ok(/^[0-9a-f]{64}$/.test(manifest.artifactHash));
  assert.doesNotMatch(JSON.stringify(manifest), /secret-value|other-secret|auth-secret/);
});

test("writeBenchmarkReproManifest writes MANIFEST.json beside results", async () => {
  const root = await createTempRoot("remnic-repro-manifest-write-");
  const resultsDir = path.join(root, "results");
  await mkdir(resultsDir, { recursive: true });
  const resultPath = path.join(resultsDir, "longmemeval.json");
  await writeFile(resultPath, `${JSON.stringify(buildResult(), null, 2)}\n`, "utf8");

  const manifestPath = await writeBenchmarkReproManifest(resultsDir, {
    resultPaths: [resultPath],
    selectedBenchmarks: ["longmemeval"],
  });
  assert.equal(manifestPath, path.join(resultsDir, BENCHMARK_REPRO_MANIFEST_FILENAME));

  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    results: Array<{ benchmark: string }>;
  };
  assert.equal(manifest.results[0]?.benchmark, "longmemeval");
});

test("artifact hash ignores volatile host metadata but binds run id", async () => {
  const firstRoot = await createTempRoot("remnic-repro-manifest-stable-a-");
  const secondRoot = await createTempRoot("remnic-repro-manifest-stable-b-");
  const firstResultsDir = path.join(firstRoot, "results");
  const secondResultsDir = path.join(secondRoot, "results");
  await mkdir(firstResultsDir, { recursive: true });
  await mkdir(secondResultsDir, { recursive: true });

  const resultJson = `${JSON.stringify(buildResult(), null, 2)}\n`;
  const firstResultPath = path.join(firstResultsDir, "longmemeval.json");
  const secondResultPath = path.join(secondResultsDir, "longmemeval.json");
  await writeFile(firstResultPath, resultJson, "utf8");
  await writeFile(secondResultPath, resultJson, "utf8");

  const firstManifest = await buildBenchmarkReproManifest(firstResultsDir, {
    resultPaths: [firstResultPath],
    runId: "stable-run",
    selectedBenchmarks: ["longmemeval"],
    command: { cwd: firstRoot, argv: ["bench", "run", "longmemeval"] },
  });
  const secondManifest = await buildBenchmarkReproManifest(secondResultsDir, {
    resultPaths: [secondResultPath],
    runId: "stable-run",
    selectedBenchmarks: ["longmemeval"],
    command: { cwd: secondRoot, argv: ["bench", "run", "longmemeval"] },
  });
  const tamperedRunManifest = await buildBenchmarkReproManifest(firstResultsDir, {
    resultPaths: [firstResultPath],
    runId: "borrowed-run",
    selectedBenchmarks: ["longmemeval"],
    command: { cwd: firstRoot, argv: ["bench", "run", "longmemeval"] },
  });

  assert.notEqual(firstManifest.command.cwd, secondManifest.command.cwd);
  assert.equal(firstManifest.run.id, secondManifest.run.id);
  assert.equal(firstManifest.artifactHash, secondManifest.artifactHash);
  assert.notEqual(firstManifest.run.id, tamperedRunManifest.run.id);
  assert.notEqual(firstManifest.artifactHash, tamperedRunManifest.artifactHash);
});

test("buildBenchmarkReproManifest rejects symlinked dataset roots", async () => {
  const root = await createTempRoot("remnic-repro-manifest-root-link-");
  const resultsDir = path.join(root, "results");
  const datasetDir = path.join(root, "dataset");
  const linkedDatasetDir = path.join(root, "linked-dataset");
  await mkdir(resultsDir, { recursive: true });
  await mkdir(datasetDir, { recursive: true });
  await writeFile(path.join(datasetDir, "answers.json"), JSON.stringify({ answer: 42 }), "utf8");
  await symlink(datasetDir, linkedDatasetDir);
  const resultPath = path.join(resultsDir, "longmemeval.json");
  await writeFile(resultPath, `${JSON.stringify(buildResult(), null, 2)}\n`, "utf8");

  const manifest = await buildBenchmarkReproManifest(resultsDir, {
    resultPaths: [resultPath],
    selectedBenchmarks: ["longmemeval"],
    datasetDirs: { longmemeval: `${linkedDatasetDir}${path.sep}` },
  });

  assert.equal(manifest.datasets[0]?.status, "missing");
  assert.equal(manifest.datasets[0]?.fileCount, 0);
  assert.equal(manifest.datasets[0]?.sha256, undefined);
});

test("buildBenchmarkReproManifest rejects symlinked dataset ancestors", async () => {
  const root = await createTempRoot("remnic-repro-manifest-parent-link-");
  const resultsDir = path.join(root, "results");
  const parentDir = path.join(root, "parent");
  const datasetDir = path.join(parentDir, "dataset");
  const linkedParentDir = path.join(root, "linked-parent");
  await mkdir(resultsDir, { recursive: true });
  await mkdir(datasetDir, { recursive: true });
  await writeFile(path.join(datasetDir, "answers.json"), JSON.stringify({ answer: 42 }), "utf8");
  await symlink(parentDir, linkedParentDir);
  const resultPath = path.join(resultsDir, "longmemeval.json");
  await writeFile(resultPath, `${JSON.stringify(buildResult(), null, 2)}\n`, "utf8");

  const manifest = await buildBenchmarkReproManifest(resultsDir, {
    resultPaths: [resultPath],
    selectedBenchmarks: ["longmemeval"],
    datasetDirs: { longmemeval: path.join(linkedParentDir, "dataset") },
  });

  assert.equal(manifest.datasets[0]?.status, "missing");
  assert.equal(manifest.datasets[0]?.fileCount, 0);
  assert.equal(manifest.datasets[0]?.sha256, undefined);
});

test("buildBenchmarkReproManifest preserves explicitly empty result paths", async () => {
  const root = await createTempRoot("remnic-repro-manifest-empty-results-");
  const resultsDir = path.join(root, "results");
  await mkdir(resultsDir, { recursive: true });
  await writeFile(
    path.join(resultsDir, "longmemeval.json"),
    `${JSON.stringify(buildResult(), null, 2)}\n`,
    "utf8",
  );

  const manifest = await buildBenchmarkReproManifest(resultsDir, {
    resultPaths: [],
  });

  assert.deepEqual(manifest.results, []);
  assert.deepEqual(manifest.run.selectedBenchmarks, []);
});

test("buildBenchmarkReproManifest preserves uneven benchmark/profile work pairings", async () => {
  const root = await createTempRoot("remnic-repro-manifest-work-items-");
  const resultsDir = path.join(root, "results");
  await mkdir(resultsDir, { recursive: true });
  const resultPath = path.join(resultsDir, "longmemeval.json");
  await writeFile(resultPath, `${JSON.stringify(buildResult(), null, 2)}\n`, "utf8");

  const manifest = await buildBenchmarkReproManifest(resultsDir, {
    resultPaths: [resultPath],
    selectedBenchmarks: ["longmemeval", "locomo"],
    runtimeProfiles: ["real", "baseline"],
    selectedWorkItems: [
      { benchmark: "longmemeval", runtimeProfile: "real" },
      { benchmark: "locomo", runtimeProfile: "baseline" },
    ],
  });

  assert.deepEqual(manifest.run.selectedBenchmarks, ["longmemeval", "locomo"]);
  assert.deepEqual(manifest.run.runtimeProfiles, ["real", "baseline"]);
  assert.deepEqual(manifest.run.selectedWorkItems, [
    { benchmark: "longmemeval", runtimeProfile: "real" },
    { benchmark: "locomo", runtimeProfile: "baseline" },
  ]);
});
