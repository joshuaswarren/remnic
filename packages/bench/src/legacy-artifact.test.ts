import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { loadBenchmarkResult } from "./results-store.js";
import { assertIntegrityMetaPresent } from "./integrity/types.js";
import {
  LEGACY_ARTIFACT_SHAPE_VERSION,
  recognizeLegacyBenchmarkArtifact,
} from "./legacy-artifact.js";
import type { BenchmarkResult } from "./types.js";

async function withResultFile(
  payload: unknown,
  callback: (filePath: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "remnic-bench-legacy-artifact-"));
  try {
    const filePath = path.join(dir, "result.json");
    await writeFile(filePath, `${JSON.stringify(payload)}\n`);
    await callback(filePath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Legacy shape 1, "minimal" variant: exactly what the pre-#2800 bench-ui
 * parser accepted in the loosest fixture — meta floor plus partial cost,
 * taskId-only task rows, and mean-only aggregates.
 */
function minimalLegacyArtifact(): Record<string, unknown> {
  return {
    meta: {
      id: "latest-run",
      benchmark: "longmemeval",
      timestamp: "2026-04-18T10:00:00.000Z",
      mode: "quick",
    },
    cost: {
      totalLatencyMs: 1234,
      meanQueryLatencyMs: 617,
    },
    results: {
      tasks: [{ taskId: "task-1" }, { notATask: true }],
      aggregates: {
        accuracy: { mean: 0.75 },
        f1: { mean: 0.63 },
      },
    },
  };
}

/**
 * Legacy shape 1, "pre-provenance" variant: structurally complete except
 * the newer required meta provenance (tier, version, remnicVersion,
 * gitSha, seeds) and environment.
 */
function preProvenanceLegacyArtifact(): Record<string, unknown> {
  return {
    meta: {
      id: "run-old",
      benchmark: "ama-bench",
      timestamp: "2026-03-01T00:00:00.000Z",
      mode: "full",
      runCount: 3,
    },
    config: {
      systemProvider: { provider: "openai", model: "gpt-5.4" },
      judgeProvider: null,
      adapterMode: "standalone",
      remnicConfig: { assistantRubricId: "assistant-v1" },
    },
    cost: {
      totalTokens: 100,
      inputTokens: 60,
      outputTokens: 40,
      estimatedCostUsd: 0.01,
      totalLatencyMs: 500,
      meanQueryLatencyMs: 250,
    },
    results: {
      tasks: [
        {
          taskId: "a-task",
          question: "q1",
          expected: "e1",
          actual: "a1",
          scores: { accuracy: 0.61 },
          latencyMs: 200,
          tokens: { input: 50, output: 36 },
        },
      ],
      aggregates: {
        accuracy: { mean: 0.61, median: 0.61, stdDev: 0, min: 0.61, max: 0.61 },
      },
    },
  };
}

function canonicalResult(): BenchmarkResult {
  return {
    meta: {
      id: "run-canonical",
      benchmark: "sample",
      benchmarkTier: "remnic",
      version: "1.0.0",
      remnicVersion: "9.0.0",
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
      totalTokens: 10,
      inputTokens: 6,
      outputTokens: 4,
      estimatedCostUsd: 0.001,
      totalLatencyMs: 100,
      meanQueryLatencyMs: 50,
    },
    results: {
      tasks: [
        {
          taskId: "task-1",
          question: "question",
          expected: "expected",
          actual: "actual",
          scores: { exact_match: 1 },
          latencyMs: 5,
          tokens: { input: 1, output: 1 },
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

function modernArtifactMissingResults(): Record<string, unknown> {
  const { results: _results, ...rest } = canonicalResult();
  return {
    ...rest,
    meta: {
      ...rest.meta,
      splitType: "holdout",
      qrelsSealedHash: "aa",
      judgePromptHash: "bb",
      datasetHash: "cc",
    },
  };
}

test("recognizeLegacyBenchmarkArtifact upgrades the minimal pre-#2800 shape with documented defaults", () => {
  const recognition = recognizeLegacyBenchmarkArtifact(minimalLegacyArtifact());

  assert.equal(recognition.ok, true);
  if (!recognition.ok) return;
  assert.equal(recognition.shapeVersion, LEGACY_ARTIFACT_SHAPE_VERSION);

  const { meta, config, cost, results, environment } = recognition.result;

  // Preserved identity fields.
  assert.equal(meta.id, "latest-run");
  assert.equal(meta.benchmark, "longmemeval");
  assert.equal(meta.timestamp, "2026-04-18T10:00:00.000Z");
  assert.equal(meta.mode, "quick");

  // Documented defaults.
  assert.equal(meta.benchmarkTier, "custom");
  assert.equal(meta.version, "unknown");
  assert.equal(meta.remnicVersion, "unknown");
  assert.equal(meta.gitSha, "unknown");
  assert.deepEqual(meta.seeds, []);
  // runCount absent -> task count (1 recognizable row, 1 skipped row).
  assert.equal(meta.runCount, 1);

  // Provider/adapter defaults from the old UI.
  assert.equal(config.systemProvider, null);
  assert.equal(config.judgeProvider, null);
  assert.equal(config.adapterMode, "unknown");
  assert.deepEqual(config.remnicConfig, {});

  // Cost: present fields preserved, absent fields zero.
  assert.deepEqual(cost, {
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    estimatedCostUsd: 0,
    totalLatencyMs: 1234,
    meanQueryLatencyMs: 617,
  });

  // Tasks: recognizable rows upgraded with display defaults, row without
  // taskId skipped exactly as the pre-#2800 UI skipped it.
  assert.deepEqual(results.tasks, [
    {
      taskId: "task-1",
      question: "",
      expected: "",
      actual: "",
      scores: {},
      latencyMs: 0,
      tokens: { input: 0, output: 0 },
    },
  ]);

  // Aggregates normalized to single-sample MetricAggregate.
  assert.deepEqual(results.aggregates, {
    accuracy: { mean: 0.75, median: 0.75, stdDev: 0, min: 0.75, max: 0.75 },
    f1: { mean: 0.63, median: 0.63, stdDev: 0, min: 0.63, max: 0.63 },
  });

  // Environment unknown, not invented.
  assert.deepEqual(environment, { os: "unknown", nodeVersion: "unknown" });

  // Integrity provenance stays absent: no fabricated seals, split, canary.
  for (const key of ["splitType", "qrelsSealedHash", "judgePromptHash", "datasetHash", "canaryScore"]) {
    assert.equal(key in meta, false, `${key} must stay absent on a legacy upgrade`);
  }
});

test("recognizeLegacyBenchmarkArtifact preserves present values in the pre-provenance shape", () => {
  const recognition = recognizeLegacyBenchmarkArtifact(preProvenanceLegacyArtifact());

  assert.equal(recognition.ok, true);
  if (!recognition.ok) return;
  const { meta, config, cost, results, environment } = recognition.result;

  assert.equal(meta.runCount, 3);
  assert.equal(meta.mode, "full");
  assert.equal(config.systemProvider?.model, "gpt-5.4");
  assert.equal(config.judgeProvider, null);
  assert.equal(config.adapterMode, "standalone");
  assert.deepEqual(config.remnicConfig, { assistantRubricId: "assistant-v1" });
  assert.equal(cost.totalTokens, 100);
  assert.equal(results.tasks[0]?.question, "q1");
  assert.equal(results.tasks[0]?.scores.accuracy, 0.61);
  assert.deepEqual(results.aggregates.accuracy, {
    mean: 0.61,
    median: 0.61,
    stdDev: 0,
    min: 0.61,
    max: 0.61,
  });
  assert.deepEqual(environment, { os: "unknown", nodeVersion: "unknown" });
});

test("recognizeLegacyBenchmarkArtifact upgrades the meta-floor-only shape", () => {
  const recognition = recognizeLegacyBenchmarkArtifact({
    meta: { id: "floor-run", benchmark: "sample", timestamp: "2026-01-01T00:00:00.000Z" },
  });

  assert.equal(recognition.ok, true);
  if (!recognition.ok) return;
  const result = recognition.result;
  assert.equal(result.meta.mode, "quick");
  assert.equal(result.meta.runCount, 0);
  assert.deepEqual(result.results, { tasks: [], aggregates: {} });
  assert.deepEqual(result.cost, {
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    estimatedCostUsd: 0,
    totalLatencyMs: 0,
    meanQueryLatencyMs: 0,
  });
});

test("recognizeLegacyBenchmarkArtifact rejects malformed and ambiguous shapes with a reason", () => {
  const rejections: Array<[unknown, RegExp]> = [
    [{}, /meta with non-empty id/],
    [{ meta: { id: "x", benchmark: "y" } }, /meta\.timestamp must be a non-empty string/],
    [{ meta: { id: "", benchmark: "y", timestamp: "t" } }, /meta\.id must be a non-empty string/],
    [
      { ...minimalLegacyArtifact(), meta: { ...(minimalLegacyArtifact().meta as Record<string, unknown>), mode: "eval" } },
      /meta\.mode must be "quick" or "full"/,
    ],
    [
      { ...minimalLegacyArtifact(), meta: { ...(minimalLegacyArtifact().meta as Record<string, unknown>), benchmarkTier: "internal" } },
      /meta\.benchmarkTier must be "published", "remnic", or "custom"/,
    ],
    [
      {
        ...minimalLegacyArtifact(),
        config: { systemProvider: { model: "gpt-5.4" } },
      },
      /config\.systemProvider must be a provider config/,
    ],
    [
      {
        ...minimalLegacyArtifact(),
        results: { tasks: [{ taskId: "t1", scores: { score: "high" } }] },
      },
      /results\.tasks\[0\]\.scores must map metric names to finite numbers/,
    ],
    [
      {
        ...minimalLegacyArtifact(),
        cost: { totalTokens: "many" },
      },
      /cost\.totalTokens must be a finite number/,
    ],
    [
      {
        ...minimalLegacyArtifact(),
        results: {
          tasks: [{ taskId: "t1" }, { taskId: "t2" }],
          aggregates: { accuracy: { mean: 0.75 } },
        },
      },
      /missing required multi-sample fields/,
    ],
    [
      {
        ...minimalLegacyArtifact(),
        results: {
          tasks: [{ taskId: "t1" }],
          aggregates: { accuracy: { mean: 0.5, median: "bad" } },
        },
      },
      /results\.aggregates\.accuracy\.median must be a finite number when present/,
    ],
    [
      {
        ...minimalLegacyArtifact(),
        meta: {
          ...(minimalLegacyArtifact().meta as Record<string, unknown>),
          failureReason: 404,
        },
      },
      /meta\.failureReason must be a string when present/,
    ],
  ];

  for (const [artifact, pattern] of rejections) {
    const recognition = recognizeLegacyBenchmarkArtifact(artifact);
    assert.equal(recognition.ok, false, `expected rejection for ${JSON.stringify(artifact)}`);
    if (recognition.ok) continue;
    assert.match(recognition.reason, pattern);
  }
});

test("recognizeLegacyBenchmarkArtifact rejects mean-only aggregates when no task proves one sample", () => {
  const cases: Array<[unknown, RegExp]> = [
    [
      {
        ...minimalLegacyArtifact(),
        results: {
          aggregates: { accuracy: { mean: 0.75 } },
        },
      },
      /results\.aggregates\.accuracy missing required fields.*exactly one recognized task/,
    ],
    [
      {
        ...minimalLegacyArtifact(),
        results: {
          tasks: [{ notATask: true }, { taskId: "   " }],
          aggregates: { accuracy: { mean: 0.75 } },
        },
      },
      /results\.aggregates\.accuracy missing required fields.*exactly one recognized task/,
    ],
  ];

  for (const [artifact, pattern] of cases) {
    const recognition = recognizeLegacyBenchmarkArtifact(artifact);
    assert.equal(recognition.ok, false, `expected rejection for ${JSON.stringify(artifact)}`);
    if (recognition.ok) continue;
    assert.match(recognition.reason, pattern);
  }
});

test("recognizeLegacyBenchmarkArtifact upgrades mean-only aggregates when one task proves single-sample semantics", () => {
  const recognition = recognizeLegacyBenchmarkArtifact({
    ...minimalLegacyArtifact(),
    results: {
      tasks: [{ taskId: "only" }],
      aggregates: { accuracy: { mean: 0.5 } },
    },
  });

  assert.equal(recognition.ok, true);
  if (!recognition.ok) return;
  assert.deepEqual(recognition.result.results.aggregates.accuracy, {
    mean: 0.5,
    median: 0.5,
    stdDev: 0,
    min: 0.5,
    max: 0.5,
  });
});

test("recognizeLegacyBenchmarkArtifact keeps complete aggregates when no tasks are present", () => {
  const recognition = recognizeLegacyBenchmarkArtifact({
    ...minimalLegacyArtifact(),
    results: {
      aggregates: {
        accuracy: { mean: 0.4, median: 0.4, stdDev: 0.1, min: 0.2, max: 0.6 },
      },
    },
  });

  assert.equal(recognition.ok, true);
  if (!recognition.ok) return;
  assert.deepEqual(recognition.result.results.aggregates.accuracy, {
    mean: 0.4,
    median: 0.4,
    stdDev: 0.1,
    min: 0.2,
    max: 0.6,
  });
});

test("loadBenchmarkResult rejects aggregate-only mean-only legacy artifacts", async () => {
  await withResultFile(
    {
      ...minimalLegacyArtifact(),
      results: { aggregates: { accuracy: { mean: 0.75 } } },
    },
    async (filePath) => {
      await assert.rejects(
        () => loadBenchmarkResult(filePath),
        /missing required fields.*exactly one recognized task/,
      );
    },
  );
});

test("loadBenchmarkResult loads legacy artifacts through the canonical-first entry", async () => {
  await withResultFile(minimalLegacyArtifact(), async (filePath) => {
    const loaded = await loadBenchmarkResult(filePath);
    assert.equal(loaded.meta.id, "latest-run");
    assert.equal(loaded.meta.gitSha, "unknown");
    assert.equal(loaded.meta.runCount, 1);
    assert.equal(loaded.results.tasks.length, 1);
  });

  await withResultFile(preProvenanceLegacyArtifact(), async (filePath) => {
    const loaded = await loadBenchmarkResult(filePath);
    assert.equal(loaded.meta.id, "run-old");
    assert.equal(loaded.config.systemProvider?.provider, "openai");
  });
});

test("loadBenchmarkResult returns canonical artifacts unchanged", async () => {
  const canonical = canonicalResult();
  await withResultFile(canonical, async (filePath) => {
    const loaded = await loadBenchmarkResult(filePath);
    assert.deepEqual(loaded, canonical);
  });
});

test("loadBenchmarkResult rejects legacy-looking artifacts that fail canonical re-validation", async () => {
  // A witness that the canonical validator rejects must not slip through
  // the legacy upgrade even though every upgraded field is well-formed.
  const artifact = {
    ...minimalLegacyArtifact(),
    results: {
      tasks: [
        {
          taskId: "task-1",
          attributionWitness: { schemaVersion: 2, runtime: {}, golds: [], retrievals: [] },
        },
      ],
      aggregates: {},
    },
  };

  await withResultFile(artifact, async (filePath) => {
    await assert.rejects(
      () => loadBenchmarkResult(filePath),
      /Invalid benchmark result file: .+ \(legacy artifact failed canonical re-validation\)/,
    );
  });
});

test("loadBenchmarkResult surfaces the legacy rejection reason for malformed files", async () => {
  await withResultFile({ meta: { id: "x", benchmark: "y", timestamp: "t", mode: "eval" } }, async (filePath) => {
    await assert.rejects(
      () => loadBenchmarkResult(filePath),
      /Invalid benchmark result file: .+ \(meta\.mode must be "quick" or "full" when present\)/,
    );
  });
});
test("recognizeLegacyBenchmarkArtifact preserves meta.canaryFloor when present", () => {
  const recognition = recognizeLegacyBenchmarkArtifact({
    meta: {
      id: "run-floor",
      benchmark: "ama-bench",
      timestamp: "2026-03-01T00:00:00.000Z",
      canaryScore: 0.08,
      canaryFloor: 0.05,
    },
  });

  assert.equal(recognition.ok, true);
  if (!recognition.ok) return;
  assert.equal(recognition.result.meta.canaryFloor, 0.05);
  assert.equal(recognition.result.meta.canaryScore, 0.08);
});

test("upgraded legacy results stay classified as missing-integrity for publishing", async () => {
  await withResultFile(preProvenanceLegacyArtifact(), async (filePath) => {
    const loaded = await loadBenchmarkResult(filePath);
    assert.equal(loaded.meta.splitType, undefined);
    assert.equal(loaded.meta.qrelsSealedHash, undefined);
    assert.equal(loaded.meta.datasetHash, undefined);
    assert.throws(
      () => assertIntegrityMetaPresent(loaded.meta),
      /integrity/i,
    );
  });
});

test("loadBenchmarkResult rejects a canonical artifact with a non-string failureReason", async () => {
  const artifact = {
    ...canonicalResult(),
    meta: { ...canonicalResult().meta, failureReason: 404 },
  };
  await withResultFile(artifact, async (filePath) => {
    await assert.rejects(
      () => loadBenchmarkResult(filePath),
      /Invalid benchmark result file: /,
    );
  });
});

test("recognizeLegacyBenchmarkArtifact rejects a modern artifact missing results", () => {
  const recognition = recognizeLegacyBenchmarkArtifact(modernArtifactMissingResults());
  assert.equal(recognition.ok, false);
  if (recognition.ok) return;
  assert.match(recognition.reason, /missing results is not a legacy artifact/);
});

test("recognizeLegacyBenchmarkArtifact rejects integrity-marked artifacts without the legacy shape", () => {
  const recognition = recognizeLegacyBenchmarkArtifact({
    meta: {
      id: "run-sealed",
      benchmark: "locomo",
      timestamp: "2026-05-21T00:00:00.000Z",
      splitType: "holdout",
      qrelsSealedHash: "aa",
    },
  });
  assert.equal(recognition.ok, false);
  if (recognition.ok) return;
  assert.match(recognition.reason, /modern provenance\/integrity markers present/);
});

test("loadBenchmarkResult rejects a modern artifact missing results instead of fabricating tasks", async () => {
  await withResultFile(modernArtifactMissingResults(), async (filePath) => {
    await assert.rejects(
      () => loadBenchmarkResult(filePath),
      /missing results is not a legacy artifact/,
    );
  });
});


