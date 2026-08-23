import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { loadBenchmarkResult, renderBenchmarkResultExport } from "./results-store.js";
import type { BenchmarkResult } from "./types.js";

test("loadBenchmarkResult upgrades legacy files missing newer required meta fields", async () => {
  await withResultFile(
    {
      ...validResult(),
      meta: {
        id: "run-minimal",
        benchmark: "sample",
        timestamp: "2026-05-21T00:00:00.000Z",
        mode: "quick",
      },
    },
    async (filePath) => {
      // Issue #2850: pre-validator artifacts upgrade with documented
      // defaults instead of being skipped.
      const loaded = await loadBenchmarkResult(filePath);
      assert.equal(loaded.meta.benchmarkTier, "custom");
      assert.equal(loaded.meta.version, "unknown");
      assert.equal(loaded.meta.remnicVersion, "unknown");
      assert.equal(loaded.meta.gitSha, "unknown");
      assert.deepEqual(loaded.meta.seeds, []);
    },
  );
});

test("loadBenchmarkResult still rejects files missing the legacy identity floor", async () => {
  await withResultFile(
    {
      ...validResult(),
      meta: { benchmark: "sample", timestamp: "2026-05-21T00:00:00.000Z" },
    },
    async (filePath) => {
      await assert.rejects(
        () => loadBenchmarkResult(filePath),
        /Invalid benchmark result file: .+ \(meta\.id must be a non-empty string\)/,
      );
    },
  );
});

test("loadBenchmarkResult upgrades legacy files missing cost fields to zero-cost", async () => {
  const result: Record<string, unknown> = { ...validResult() };
  result.cost = {
    inputTokens: 0,
    outputTokens: 0,
    estimatedCostUsd: 0,
    totalLatencyMs: 0,
    meanQueryLatencyMs: 0,
  };

  await withResultFile(result, async (filePath) => {
    // Absent cost accounting upgrades to zero, never to a guess.
    const loaded = await loadBenchmarkResult(filePath);
    assert.equal(loaded.cost.totalTokens, 0);
    assert.equal(loaded.cost.inputTokens, 0);
  });
});

test("loadBenchmarkResult accepts a complete BenchmarkResult payload", async () => {
  await withResultFile(validResult(), async (filePath) => {
    const loaded = await loadBenchmarkResult(filePath);
    assert.equal(loaded.meta.id, "run-valid");
    assert.equal(loaded.cost.totalTokens, 0);
  });
});

test("loadBenchmarkResult preserves OpenAI judge model and rubric provenance", async () => {
  const result = validResult();
  result.config.judgeProvider = {
    provider: "openai",
    model: "gpt-5.6",
    rubricVersion: "openai-responses-bench-v1",
  };
  await withResultFile(result, async (filePath) => {
    const loaded = await loadBenchmarkResult(filePath);
    assert.deepEqual(loaded.config.judgeProvider, result.config.judgeProvider);
  });
});
test("loadBenchmarkResult accepts task result with valid goldMemories array", async () => {
  const result = validResult();
  result.results.tasks[0].goldMemories = ["Fact statement A", "Fact statement B"];
  await withResultFile(result, async (filePath) => {
    const loaded = await loadBenchmarkResult(filePath);
    assert.deepEqual(loaded.results.tasks[0].goldMemories, ["Fact statement A", "Fact statement B"]);
  });
});

test("loadBenchmarkResult accepts task result with an empty goldMemories array", async () => {
  const result = validResult();
  result.results.tasks[0].goldMemories = [];
  await withResultFile(result, async (filePath) => {
    const loaded = await loadBenchmarkResult(filePath);
    assert.deepEqual(loaded.results.tasks[0].goldMemories, []);
  });
});

test("loadBenchmarkResult rejects task result with invalid goldMemories shape", async () => {
  const badShapes = ["not an array", 123, [123], [null], [{}], true];
  for (const badShape of badShapes) {
    const result = validResult();
    (result.results.tasks[0] as unknown as Record<string, unknown>).goldMemories = badShape;
    await withResultFile(result, async (filePath) => {
      await assert.rejects(
        () => loadBenchmarkResult(filePath),
        /Invalid benchmark result file/,
      );
    });
  }
});

test("loadBenchmarkResult preserves a valid versioned attribution witness", async () => {
  const result = validResult();
  const witness = validAttributionWitness();
  const task = result.results.tasks[0] as unknown as Record<string, unknown>;
  task.attributionWitness = witness;

  await withResultFile(result, async (filePath) => {
    const loaded = await loadBenchmarkResult(filePath);
    const loadedTask = loaded.results.tasks[0];
    assert.ok(loadedTask && "attributionWitness" in loadedTask);
    assert.deepEqual(loadedTask.attributionWitness, witness);
  });
});

test("loadBenchmarkResult accepts retrieval evidence beyond the QMD-only limit", async () => {
  const result = validResult();
  const witness = validAttributionWitness();
  const task = result.results.tasks[0] as unknown as Record<string, unknown>;
  task.attributionWitness = {
    ...witness,
    runtime: { ...witness.runtime, qmdMaxResults: 0 },
  };

  await withResultFile(result, async (filePath) => {
    const loaded = await loadBenchmarkResult(filePath);
    assert.ok(loaded.results.tasks[0]?.attributionWitness);
  });
});

test("loadBenchmarkResult rejects malformed persisted attribution witnesses", async () => {
  const valid = validAttributionWitness();
  const malformedWitnesses: unknown[] = [
    { ...valid, schemaVersion: 2 },
    {
      ...valid,
      runtime: { ...valid.runtime, qmdMaxResults: "ten" },
    },
    {
      ...valid,
      golds: [{
        goldMemory: "Gold fact",
        storeMemoryIds: [17],
        oracleMemoryIds: ["fact-gold"],
      }],
    },
    {
      ...valid,
      golds: [{
        goldMemory: "Gold fact",
        storeMemoryIds: ["fact-gold"],
        oracleMemoryIds: "fact-gold",
      }],
    },
    {
      ...valid,
      retrievals: [{
        sessionId: "session-1",
        appliedCap: -1,
        atCapMemoryIds: [],
        headroomMemoryIds: [],
      }],
    },
    {
      ...valid,
      retrievals: [{
        sessionId: "session-1",
        appliedCap: 1,
        atCapMemoryIds: ["fact-gold", "fact-extra"],
        headroomMemoryIds: [],
      }],
    },
    {
      ...valid,
      retrievals: [{
        sessionId: "session-1",
        appliedCap: 2,
        atCapMemoryIds: ["fact-first"],
        headroomMemoryIds: ["fact-gold"],
      }],
    },
    {
      ...valid,
      retrievals: [{
        sessionId: "session-1",
        appliedCap: 2,
        atCapMemoryIds: ["fact-first"],
        headroomMemoryIds: null,
      }],
    },
    { ...valid, retrievals: "not-an-array" },
  ];

  for (const malformedWitness of malformedWitnesses) {
    const result = validResult();
    const task = result.results.tasks[0] as unknown as Record<string, unknown>;
    task.attributionWitness = malformedWitness;
    await withResultFile(result, async (filePath) => {
      await assert.rejects(
        () => loadBenchmarkResult(filePath),
        /Invalid benchmark result file/,
      );
    });
  }
});


function validAttributionWitness() {
  return {
    schemaVersion: 1 as const,
    runtime: {
      qmdCollection: "remnic-bench-hot",
      qmdIndex: "remnic-bench-index",
      qmdMaxResults: 25,
      attributionThreshold: 0.6,
    },
    golds: [{
      goldMemory: "Gold fact",
      storeMemoryIds: ["fact-gold"],
      oracleMemoryIds: ["fact-gold", "fact-support"],
    }],
    retrievals: [{
      sessionId: "session-1",
      appliedCap: 1,
      atCapMemoryIds: ["fact-gold"],
      headroomMemoryIds: ["fact-support"],
    }],
  };
}

async function withResultFile(
  payload: unknown,
  callback: (filePath: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "remnic-bench-result-store-"));
  try {
    const filePath = path.join(dir, "result.json");
    await writeFile(filePath, `${JSON.stringify(payload)}\n`);
    await callback(filePath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function validResult(): BenchmarkResult {
  return {
    meta: {
      id: "run-valid",
      benchmark: "sample",
      benchmarkTier: "remnic",
      version: "1.0.0",
      remnicVersion: "1.1.12",
      gitSha: "abc123",
      timestamp: "2026-05-21T00:00:00.000Z",
      mode: "quick",
      runCount: 1,
      seeds: [0],
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
          taskId: "task-1",
          question: "question",
          expected: "expected",
          actual: "actual",
          scores: { exact_match: 1 },
          latencyMs: 0,
          tokens: { input: 0, output: 0 },
        },
      ],
      aggregates: { exact_match: { mean: 1, median: 1, stdDev: 0, min: 1, max: 1 } },
    },
    environment: {
      os: "darwin",
      nodeVersion: "v24.0.0",
      hardware: "arm64",
    },
  };
}
test("renderBenchmarkResultExport renders HTML and CSV without undefined numerics for upgraded mean-only legacy aggregate", async () => {
  const legacyArtifact = {
    meta: {
      id: "legacy-export-run",
      benchmark: "sample",
      timestamp: "2026-05-21T00:00:00.000Z",
      mode: "quick",
    },
    results: {
      tasks: [{ taskId: "task-1" }],
      aggregates: { accuracy: { mean: 0.85 } },
    },
  };

  await withResultFile(legacyArtifact, async (filePath) => {
    const loaded = await loadBenchmarkResult(filePath);
    assert.deepEqual(loaded.results.aggregates.accuracy, {
      mean: 0.85,
      median: 0.85,
      stdDev: 0,
      min: 0.85,
      max: 0.85,
    });

    const htmlOutput = renderBenchmarkResultExport(loaded, "html");
    assert.ok(typeof htmlOutput === "string" && htmlOutput.includes("0.85"));
    assert.ok(!htmlOutput.includes("undefined"));

    const csvOutput = renderBenchmarkResultExport(loaded, "csv");
    assert.ok(typeof csvOutput === "string" && csvOutput.includes("accuracy,0.85,0.85,0,0.85,0.85"));
    assert.ok(!csvOutput.includes("undefined"));
  });
});
