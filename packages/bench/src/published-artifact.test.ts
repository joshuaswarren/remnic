import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { BenchmarkResult } from "./types.ts";
import {
  BENCHMARK_ARTIFACT_SCHEMA_VERSION,
  PUBLISHED_BENCHMARK_ARTIFACT_IDS,
  buildBenchmarkArtifact,
  buildBenchmarkArtifactFilename,
  hashBenchmarkArtifact,
  loadBenchmarkArtifact,
  parseBenchmarkArtifact,
  serializeBenchmarkArtifact,
  writeBenchmarkArtifact,
} from "./published-artifact.ts";

function sampleResult(overrides: Partial<BenchmarkResult> = {}): BenchmarkResult {
  return {
    meta: {
      id: "run-1",
      benchmark: "longmemeval",
      benchmarkTier: "published",
      version: "2.0.0",
      remnicVersion: "9.3.90",
      gitSha: "abc1234",
      timestamp: "2026-04-20T12:00:00.000Z",
      mode: "quick",
      runCount: 1,
      seeds: [42],
    },
    config: {
      systemProvider: null,
      judgeProvider: null,
      adapterMode: "direct",
      remnicConfig: {},
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
      tasks: [
        {
          taskId: "t1",
          question: "q1",
          expected: "a1",
          actual: "a1",
          scores: { f1: 1, contains_answer: 1, llm_judge: 1 },
          latencyMs: 10,
          tokens: { input: 1, output: 1 },
          details: { category: "multi_hop" },
        },
        {
          taskId: "t2",
          question: "q2",
          expected: "a2",
          actual: "a3",
          scores: { f1: 0.5, contains_answer: 0, llm_judge: 0 },
          latencyMs: 12,
          tokens: { input: 1, output: 1 },
        },
      ],
      aggregates: {
        f1: { mean: 0.75, median: 0.75, stdDev: 0.25, min: 0.5, max: 1 },
        contains_answer: {
          mean: 0.5,
          median: 0.5,
          stdDev: 0.5,
          min: 0,
          max: 1,
        },
        llm_judge: { mean: 0.5, median: 0.5, stdDev: 0.5, min: 0, max: 1 },
      },
    },
    environment: { os: "linux", nodeVersion: "v22.12.0", hardware: "x64" },
    ...overrides,
  };
}

function sampleArtifactPayload(): Record<string, unknown> {
  return {
    schemaVersion: BENCHMARK_ARTIFACT_SCHEMA_VERSION,
    benchmarkId: "longmemeval",
    datasetVersion: "v1",
    system: { name: "remnic", version: "1.0.0", gitSha: "abc" },
    model: "m",
    seed: 0,
    metrics: {},
    perTaskScores: [{ taskId: "t1", scores: { f1: 1 }, category: "multi_hop" }],
    startedAt: "2026-04-20T12:00:00Z",
    finishedAt: "2026-04-20T12:00:00Z",
    durationMs: 0,
    env: { node: "v22", os: "linux", arch: "x64" },
    note: "limit=1",
  };
}

test("buildBenchmarkArtifact extracts means + per-task scores", () => {
  const artifact = buildBenchmarkArtifact({
    benchmarkId: "longmemeval",
    datasetVersion: "longmemeval-s-2025-01-15",
    model: "gpt-4o-mini",
    seed: 42,
    startedAt: "2026-04-20T12:00:00.000Z",
    finishedAt: "2026-04-20T12:05:00.000Z",
    result: sampleResult(),
  });

  assert.equal(artifact.schemaVersion, BENCHMARK_ARTIFACT_SCHEMA_VERSION);
  assert.equal(artifact.benchmarkId, "longmemeval");
  assert.equal(artifact.datasetVersion, "longmemeval-s-2025-01-15");
  assert.equal(artifact.model, "gpt-4o-mini");
  assert.equal(artifact.seed, 42);
  assert.equal(artifact.system.name, "remnic");
  assert.equal(artifact.system.version, "9.3.90");
  assert.equal(artifact.system.gitSha, "abc1234");
  assert.equal(artifact.env.node, "v22.12.0");
  assert.equal(artifact.env.os, "linux");
  assert.equal(artifact.env.arch, "x64");
  assert.equal(artifact.durationMs, 5 * 60 * 1000);
  assert.equal(artifact.metrics.f1, 0.75);
  assert.equal(artifact.metrics.contains_answer, 0.5);
  assert.equal(artifact.metrics.llm_judge, 0.5);
  assert.equal(artifact.perTaskScores.length, 2);
  assert.equal(artifact.perTaskScores[0]?.taskId, "t1");
  assert.equal(artifact.perTaskScores[0]?.scores.f1, 1);
});

test("buildBenchmarkArtifact attaches category via categoryFor", () => {
  const artifact = buildBenchmarkArtifact({
    benchmarkId: "locomo",
    datasetVersion: "locomo-10",
    model: "gpt-4o-mini",
    seed: 7,
    startedAt: "2026-04-20T12:00:00.000Z",
    finishedAt: "2026-04-20T12:01:00.000Z",
    result: sampleResult(),
    categoryFor: (task) =>
      (task.details?.category as string | undefined) ?? undefined,
  });

  assert.equal(artifact.perTaskScores[0]?.category, "multi_hop");
  assert.equal(artifact.perTaskScores[1]?.category, undefined);
});

test("buildBenchmarkArtifact durationMs clamps to 0 for identical timestamps", () => {
  const artifact = buildBenchmarkArtifact({
    benchmarkId: "longmemeval",
    datasetVersion: "v1",
    model: "gpt-4o-mini",
    seed: 1,
    startedAt: "2026-04-20T12:00:00.000Z",
    finishedAt: "2026-04-20T12:00:00.000Z",
    result: sampleResult(),
  });
  assert.equal(artifact.durationMs, 0);
});

test("buildBenchmarkArtifact drops arch when hardware absent", () => {
  const artifact = buildBenchmarkArtifact({
    benchmarkId: "longmemeval",
    datasetVersion: "v1",
    model: "gpt-4o-mini",
    seed: 1,
    startedAt: "2026-04-20T12:00:00.000Z",
    finishedAt: "2026-04-20T12:01:00.000Z",
    result: sampleResult({
      environment: { os: "linux", nodeVersion: "v22.12.0" },
    }),
  });
  assert.equal(artifact.env.arch, undefined);
  assert.ok(!Object.prototype.hasOwnProperty.call(artifact.env, "arch"));
});

test("buildBenchmarkArtifactFilename formats <date>-<bench>-<model>-<sha>.json", () => {
  const filename = buildBenchmarkArtifactFilename({
    schemaVersion: BENCHMARK_ARTIFACT_SCHEMA_VERSION,
    benchmarkId: "longmemeval",
    datasetVersion: "v1",
    system: { name: "remnic", version: "9.3.90", gitSha: "abc1234ab" },
    model: "gpt-4o-mini",
    seed: 1,
    metrics: {},
    perTaskScores: [],
    startedAt: "2026-04-20T12:00:00.000Z",
    finishedAt: "2026-04-20T12:01:00.000Z",
    durationMs: 0,
    env: { node: "v22", os: "linux" },
  });
  assert.equal(filename, "2026-04-20-longmemeval-gpt-4o-mini-abc1234.json");
});

test("buildBenchmarkArtifactFilename sanitizes model slashes and uppercase", () => {
  const filename = buildBenchmarkArtifactFilename({
    schemaVersion: BENCHMARK_ARTIFACT_SCHEMA_VERSION,
    benchmarkId: "locomo",
    datasetVersion: "v1",
    system: { name: "remnic", version: "9.3.90", gitSha: "" },
    model: "Org/Llama-3.1:8B",
    seed: 1,
    metrics: {},
    perTaskScores: [],
    startedAt: "2026-04-20T12:00:00.000Z",
    finishedAt: "2026-04-20T12:01:00.000Z",
    durationMs: 0,
    env: { node: "v22", os: "linux" },
  });
  // Slashes and colons sanitized; sha falls back to "unknown".
  assert.equal(filename, "2026-04-20-locomo-org_llama-3.1_8b-unknown.json");
});

test("serialize + parse round-trip preserves artifact", () => {
  const artifact = buildBenchmarkArtifact({
    benchmarkId: "longmemeval",
    datasetVersion: "v1",
    model: "gpt-4o-mini",
    seed: 42,
    startedAt: "2026-04-20T12:00:00.000Z",
    finishedAt: "2026-04-20T12:05:00.000Z",
    result: sampleResult(),
    note: "limit=100",
  });
  const raw = serializeBenchmarkArtifact(artifact);
  const reparsed = parseBenchmarkArtifact(raw);
  assert.deepEqual(reparsed, artifact);
});

test("serialize + parse accepts every published benchmark artifact id", () => {
  for (const benchmarkId of PUBLISHED_BENCHMARK_ARTIFACT_IDS) {
    const artifact = buildBenchmarkArtifact({
      benchmarkId,
      datasetVersion: "v1",
      model: "gpt-5.5",
      seed: 42,
      startedAt: "2026-04-20T12:00:00.000Z",
      finishedAt: "2026-04-20T12:05:00.000Z",
      result: sampleResult({
        meta: {
          ...sampleResult().meta,
          benchmark: benchmarkId,
        },
      }),
    });
    const raw = serializeBenchmarkArtifact(artifact);
    assert.equal(parseBenchmarkArtifact(raw).benchmarkId, benchmarkId);
  }
});

test("serializeBenchmarkArtifact yields stable hash regardless of key insertion order", () => {
  const base = buildBenchmarkArtifact({
    benchmarkId: "longmemeval",
    datasetVersion: "v1",
    model: "gpt-4o-mini",
    seed: 42,
    startedAt: "2026-04-20T12:00:00.000Z",
    finishedAt: "2026-04-20T12:05:00.000Z",
    result: sampleResult(),
  });
  const shuffled = {
    ...base,
    // Reorder top-level keys via a fresh object literal in different sequence.
    env: {
      os: base.env.os,
      node: base.env.node,
      ...(base.env.arch !== undefined ? { arch: base.env.arch } : {}),
    },
    system: {
      gitSha: base.system.gitSha,
      version: base.system.version,
      name: base.system.name,
    },
  };
  assert.equal(hashBenchmarkArtifact(base), hashBenchmarkArtifact(shuffled));
});

test("parseBenchmarkArtifact rejects unknown schemaVersion", () => {
  const raw = JSON.stringify({
    schemaVersion: 999,
    benchmarkId: "longmemeval",
    datasetVersion: "v1",
    system: { name: "remnic", version: "1.0.0", gitSha: "abc" },
    model: "m",
    seed: 0,
    metrics: {},
    perTaskScores: [],
    startedAt: "2026-04-20T12:00:00Z",
    finishedAt: "2026-04-20T12:00:00Z",
    durationMs: 0,
    env: { node: "v22", os: "linux" },
  });
  assert.throws(
    () => parseBenchmarkArtifact(raw),
    /schemaVersion 999 is not supported/,
  );
});

test("parseBenchmarkArtifact rejects invalid benchmarkId", () => {
  const raw = JSON.stringify({
    schemaVersion: BENCHMARK_ARTIFACT_SCHEMA_VERSION,
    benchmarkId: "not-a-benchmark",
    datasetVersion: "v1",
    system: { name: "remnic", version: "1.0.0", gitSha: "abc" },
    model: "m",
    seed: 0,
    metrics: {},
    perTaskScores: [],
    startedAt: "2026-04-20T12:00:00Z",
    finishedAt: "2026-04-20T12:00:00Z",
    durationMs: 0,
    env: { node: "v22", os: "linux" },
  });
  assert.throws(
    () => parseBenchmarkArtifact(raw),
    /benchmarkId must be one of/,
  );
});

test("parseBenchmarkArtifact rejects non-number metric value", () => {
  const raw = JSON.stringify({
    schemaVersion: BENCHMARK_ARTIFACT_SCHEMA_VERSION,
    benchmarkId: "longmemeval",
    datasetVersion: "v1",
    system: { name: "remnic", version: "1.0.0", gitSha: "abc" },
    model: "m",
    seed: 0,
    metrics: { f1: "high" },
    perTaskScores: [],
    startedAt: "2026-04-20T12:00:00Z",
    finishedAt: "2026-04-20T12:00:00Z",
    durationMs: 0,
    env: { node: "v22", os: "linux" },
  });
  assert.throws(() => parseBenchmarkArtifact(raw), /metrics\.f1/);
});

test("parseBenchmarkArtifact rejects non-array perTaskScores", () => {
  const raw = JSON.stringify({
    schemaVersion: BENCHMARK_ARTIFACT_SCHEMA_VERSION,
    benchmarkId: "longmemeval",
    datasetVersion: "v1",
    system: { name: "remnic", version: "1.0.0", gitSha: "abc" },
    model: "m",
    seed: 0,
    metrics: {},
    perTaskScores: {},
    startedAt: "2026-04-20T12:00:00Z",
    finishedAt: "2026-04-20T12:00:00Z",
    durationMs: 0,
    env: { node: "v22", os: "linux" },
  });
  assert.throws(() => parseBenchmarkArtifact(raw), /perTaskScores must be an array/);
});

test("parseBenchmarkArtifact rejects non-object top-level payload", () => {
  assert.throws(() => parseBenchmarkArtifact("null"), /must be an object/);
  assert.throws(() => parseBenchmarkArtifact("42"), /must be an object/);
  assert.throws(() => parseBenchmarkArtifact("[]"), /must be an object/);
});

test("parseBenchmarkArtifact rejects non-ISO startedAt", () => {
  const raw = JSON.stringify({
    schemaVersion: BENCHMARK_ARTIFACT_SCHEMA_VERSION,
    benchmarkId: "longmemeval",
    datasetVersion: "v1",
    system: { name: "remnic", version: "1.0.0", gitSha: "abc" },
    model: "m",
    seed: 0,
    metrics: {},
    perTaskScores: [],
    startedAt: "not-a-date",
    finishedAt: "2026-04-20T12:00:00Z",
    durationMs: 0,
    env: { node: "v22", os: "linux" },
  });
  assert.throws(
    () => parseBenchmarkArtifact(raw),
    /"startedAt" "not-a-date" is not a parseable ISO-8601/,
  );
});

test("parseBenchmarkArtifact rejects non-ISO finishedAt", () => {
  const raw = JSON.stringify({
    schemaVersion: BENCHMARK_ARTIFACT_SCHEMA_VERSION,
    benchmarkId: "locomo",
    datasetVersion: "v1",
    system: { name: "remnic", version: "1.0.0", gitSha: "abc" },
    model: "m",
    seed: 0,
    metrics: {},
    perTaskScores: [],
    startedAt: "2026-04-20T12:00:00Z",
    finishedAt: "nope",
    durationMs: 0,
    env: { node: "v22", os: "linux" },
  });
  assert.throws(
    () => parseBenchmarkArtifact(raw),
    /"finishedAt" "nope" is not a parseable ISO-8601/,
  );
});

test("parseBenchmarkArtifact rejects non-finite metric value", () => {
  // `JSON.parse('{"f1":1e309}')` surfaces `Infinity`, which is what
  // we want to reject alongside non-number types.
  const rawBase = JSON.stringify({
    schemaVersion: BENCHMARK_ARTIFACT_SCHEMA_VERSION,
    benchmarkId: "longmemeval",
    datasetVersion: "v1",
    system: { name: "remnic", version: "1.0.0", gitSha: "abc" },
    model: "m",
    seed: 0,
    metrics: {},
    perTaskScores: [],
    startedAt: "2026-04-20T12:00:00Z",
    finishedAt: "2026-04-20T12:00:00Z",
    durationMs: 0,
    env: { node: "v22", os: "linux" },
  });
  const raw = rawBase.replace('"metrics":{}', '"metrics":{"f1":1e309}');
  assert.throws(
    () => parseBenchmarkArtifact(raw),
    /metrics\.f1 must be a finite number/,
  );
});

test("parseBenchmarkArtifact rejects non-finite per-task score", () => {
  const rawBase = JSON.stringify({
    schemaVersion: BENCHMARK_ARTIFACT_SCHEMA_VERSION,
    benchmarkId: "longmemeval",
    datasetVersion: "v1",
    system: { name: "remnic", version: "1.0.0", gitSha: "abc" },
    model: "m",
    seed: 0,
    metrics: {},
    perTaskScores: [{ taskId: "t1", scores: { f1: 1 } }],
    startedAt: "2026-04-20T12:00:00Z",
    finishedAt: "2026-04-20T12:00:00Z",
    durationMs: 0,
    env: { node: "v22", os: "linux" },
  });
  const raw = rawBase.replace('"f1":1', '"f1":1e309');
  assert.throws(
    () => parseBenchmarkArtifact(raw),
    /perTaskScores\[0\]\.scores\.f1 must be a finite number/,
  );
});

test("parseBenchmarkArtifact rejects malformed optional string fields", () => {
  const withBadArch = sampleArtifactPayload();
  (withBadArch.env as Record<string, unknown>).arch = {};
  assert.throws(
    () => parseBenchmarkArtifact(JSON.stringify(withBadArch)),
    /field "env\.arch" must be a string when provided/,
  );

  const withBadNote = sampleArtifactPayload();
  withBadNote.note = 42;
  assert.throws(
    () => parseBenchmarkArtifact(JSON.stringify(withBadNote)),
    /field "note" must be a string when provided/,
  );

  const withBadCategory = sampleArtifactPayload();
  ((withBadCategory.perTaskScores as Array<Record<string, unknown>>)[0]!).category = 42;
  assert.throws(
    () => parseBenchmarkArtifact(JSON.stringify(withBadCategory)),
    /field "perTaskScores\[0\]\.category" must be a string when provided/,
  );
});

test("writeBenchmarkArtifact writes canonical JSON to disk with stable sha", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "remnic-artifact-"));
  try {
    const artifact = buildBenchmarkArtifact({
      benchmarkId: "locomo",
      datasetVersion: "locomo-10",
      model: "gpt-4o-mini",
      seed: 42,
      startedAt: "2026-04-20T12:00:00.000Z",
      finishedAt: "2026-04-20T12:05:00.000Z",
      result: sampleResult(),
    });
    const written = await writeBenchmarkArtifact(artifact, dir);
    assert.equal(written.filename, "2026-04-20-locomo-gpt-4o-mini-abc1234.json");
    assert.equal(written.sha256, hashBenchmarkArtifact(artifact));
    const raw = await readFile(written.path, "utf8");
    const reparsed = parseBenchmarkArtifact(raw);
    assert.deepEqual(reparsed, artifact);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadBenchmarkArtifact reads, parses, and re-hashes", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "remnic-artifact-load-"));
  try {
    const artifact = buildBenchmarkArtifact({
      benchmarkId: "longmemeval",
      datasetVersion: "v1",
      model: "gpt-4o-mini",
      seed: 1,
      startedAt: "2026-04-20T12:00:00.000Z",
      finishedAt: "2026-04-20T12:01:00.000Z",
      result: sampleResult(),
    });
    const written = await writeBenchmarkArtifact(artifact, dir);
    const loaded = await loadBenchmarkArtifact(written.path);
    assert.deepEqual(loaded.artifact, artifact);
    assert.equal(loaded.sha256, written.sha256);
    assert.equal(loaded.bytes, written.bytes);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("buildBenchmarkArtifact rejects non-finite per-task scores", () => {
  assert.throws(
    () =>
      buildBenchmarkArtifact({
        benchmarkId: "longmemeval",
        datasetVersion: "v1",
        model: "gpt-4o-mini",
        seed: 1,
        startedAt: "2026-04-20T12:00:00.000Z",
        finishedAt: "2026-04-20T12:01:00.000Z",
        result: sampleResult({
          results: {
            tasks: [
              {
                taskId: "t1",
                question: "q",
                expected: "a",
                actual: "a",
                scores: { f1: Number.NaN },
                latencyMs: 0,
                tokens: { input: 0, output: 0 },
              },
            ],
            aggregates: {},
          },
        }),
      }),
    /perTaskScores\[0\] "t1" scores\.f1 must be a finite number/,
  );
});

test("buildBenchmarkArtifact rejects invalid startedAt/finishedAt timestamps", () => {
  assert.throws(
    () =>
      buildBenchmarkArtifact({
        benchmarkId: "longmemeval",
        datasetVersion: "v1",
        model: "gpt-4o-mini",
        seed: 1,
        startedAt: "not-a-date",
        finishedAt: "2026-04-20T12:00:00.000Z",
        result: sampleResult(),
      }),
    /startedAt "not-a-date" is not a valid ISO-8601 timestamp/,
  );
  assert.throws(
    () =>
      buildBenchmarkArtifact({
        benchmarkId: "longmemeval",
        datasetVersion: "v1",
        model: "gpt-4o-mini",
        seed: 1,
        startedAt: "2026-04-20T12:00:00.000Z",
        finishedAt: "garbage",
        result: sampleResult(),
      }),
    /finishedAt "garbage" is not a valid ISO-8601 timestamp/,
  );
});

test("buildBenchmarkArtifactFilename sanitizes the git SHA segment", () => {
  const filename = buildBenchmarkArtifactFilename({
    schemaVersion: BENCHMARK_ARTIFACT_SCHEMA_VERSION,
    benchmarkId: "longmemeval",
    datasetVersion: "v1",
    system: { name: "remnic", version: "9.3.90", gitSha: "../../evil" },
    model: "gpt-4o-mini",
    seed: 1,
    metrics: {},
    perTaskScores: [],
    startedAt: "2026-04-20T12:00:00.000Z",
    finishedAt: "2026-04-20T12:01:00.000Z",
    durationMs: 0,
    env: { node: "v22", os: "linux" },
  });
  // Slashes + `..` from `../../evil` must not appear in the sha segment
  // (sanitizeSegment only allows [a-z0-9._-]).
  assert.doesNotMatch(filename, /\//);
  // `..` (without sanitization) would look like an upward path walk; the
  // only dots allowed should be the `.json` suffix and any legitimate
  // semver dots in the model segment.
  const shaSegment = filename.slice(0, -".json".length).split("-").pop() ?? "";
  assert.doesNotMatch(shaSegment, /\.\./);
  assert.ok(filename.endsWith(".json"));
});

test("writeBenchmarkArtifact resolved path stays inside outputDir", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "remnic-artifact-guard-"));
  try {
    // Build an artifact whose model + system.gitSha contain
    // path-traversal characters. `sanitizeSegment` strips them, so this
    // write succeeds and stays inside `dir`. Test verifies the
    // resolved path is a direct child of the output directory.
    const artifact = buildBenchmarkArtifact({
      benchmarkId: "longmemeval",
      datasetVersion: "v1",
      model: "../evil",
      seed: 1,
      startedAt: "2026-04-20T12:00:00.000Z",
      finishedAt: "2026-04-20T12:01:00.000Z",
      result: sampleResult({
        meta: {
          id: "run-evil",
          benchmark: "longmemeval",
          benchmarkTier: "published",
          version: "2.0.0",
          remnicVersion: "9.3.90",
          gitSha: "../../pwn",
          timestamp: "2026-04-20T12:00:00.000Z",
          mode: "quick",
          runCount: 1,
          seeds: [1],
        },
      }),
    });
    const written = await writeBenchmarkArtifact(artifact, dir);
    const rel = path.relative(path.resolve(dir), written.path);
    assert.doesNotMatch(rel, /\.\./);
    assert.equal(path.dirname(written.path), path.resolve(dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("schemaVersion bump guard: constant matches declared type", () => {
  // If this fails, someone bumped BENCHMARK_ARTIFACT_SCHEMA_VERSION without
  // updating the interface's literal type. Keep them in lock-step so
  // TypeScript enforces downstream migration when consumers re-declare it.
  const value: typeof BENCHMARK_ARTIFACT_SCHEMA_VERSION = 1;
  assert.equal(value, BENCHMARK_ARTIFACT_SCHEMA_VERSION);
});
