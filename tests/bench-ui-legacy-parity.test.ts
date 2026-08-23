import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { summarizeBenchmarkResult } from "../packages/bench-ui/src/results.js";
import { loadBenchmarkResult } from "../packages/bench/src/results-store.js";
import type { BenchResultSummary } from "../packages/bench-ui/src/bench-data.js";

/**
 * Issue #2850 parity gate: a legacy artifact upgraded by the
 * `@remnic/bench` compatibility adapter must summarize exactly as the
 * pre-#2800 bench-ui parser summarized the raw artifact.
 *
 * The only permitted differences are the documented canonical-required
 * numeric defaults (absent cost fields and task latencies upgrade to 0
 * where the old parser surfaced null); every other field must be
 * strictly identical.
 */
function applyDocumentedCoercions(summary: BenchResultSummary): BenchResultSummary {
  const coerced: BenchResultSummary = {
    ...summary,
    // Canonical cost fields are numbers; absent legacy values upgrade to 0.
    totalTokens: summary.totalTokens ?? 0,
    inputTokens: summary.inputTokens ?? 0,
    outputTokens: summary.outputTokens ?? 0,
    estimatedCostUsd: summary.estimatedCostUsd ?? 0,
    totalLatencyMs: summary.totalLatencyMs ?? 0,
    meanQueryLatencyMs: summary.meanQueryLatencyMs ?? 0,
    taskSummaries: summary.taskSummaries.map((task) => ({
      ...task,
      // Canonical task latencyMs is a number; absent upgrades to 0.
      latencyMs: task.latencyMs ?? 0,
    })),
    // Mean-only legacy aggregates normalize median/min/max to mean and stdDev to 0.
    aggregateMetrics: summary.aggregateMetrics.map((agg) => ({
      ...agg,
      median: agg.median ?? agg.mean,
      stdDev: agg.stdDev ?? 0,
      min: agg.min ?? agg.mean,
      max: agg.max ?? agg.mean,
    })),
  };
  return coerced;
}

const legacyArtifacts: Array<{ name: string; id: string; artifact: Record<string, unknown> }> = [
  {
    name: "minimal pre-#2800 shape",
    id: "latest-run",
    artifact: {
      meta: {
        id: "latest-run",
        benchmark: "longmemeval",
        timestamp: "2026-04-18T10:00:00.000Z",
        mode: "quick",
      },
      cost: { totalLatencyMs: 1234, meanQueryLatencyMs: 617 },
      results: {
        tasks: [{ taskId: "task-1" }, { notATask: true }],
        aggregates: {
          accuracy: { mean: 0.75 },
          f1: { mean: 0.63 },
        },
      },
    },
  },
  {
    name: "pre-provenance shape",
    id: "run-old",
    artifact: {
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
    },
  },
  {
    name: "meta-floor-only shape",
    id: "floor-run",
    artifact: {
      meta: { id: "floor-run", benchmark: "sample", timestamp: "2026-01-01T00:00:00.000Z" },
    },
  },
];

test("legacy artifacts summarize identically to the pre-#2800 UI after the compatibility upgrade", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-ui-legacy-parity-"));
  try {
    for (const { name, id, artifact } of legacyArtifacts) {
      const filePath = path.join(dir, `${id}.json`);
      await writeFile(filePath, JSON.stringify(artifact), "utf8");

      const oldUiSummary = summarizeBenchmarkResult(artifact, filePath);
      assert.ok(oldUiSummary, `old UI parser must accept the ${name}`);

      const upgraded = await loadBenchmarkResult(filePath);
      const upgradedSummary = summarizeBenchmarkResult(upgraded, filePath);
      assert.ok(upgradedSummary, `upgraded ${name} must summarize`);

      assert.deepEqual(
        upgradedSummary,
        applyDocumentedCoercions(oldUiSummary),
        `summary parity failed for the ${name}`,
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("artifacts the old UI skipped as malformed stay rejected with a reason", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-ui-legacy-malformed-"));
  try {
    const ambiguous = {
      meta: { id: "x", benchmark: "y", timestamp: "t", mode: "eval" },
    };
    const filePath = path.join(dir, "ambiguous.json");
    await writeFile(filePath, JSON.stringify(ambiguous), "utf8");

    // Old UI accepted "eval" for display; the canonical contract does
    // not, so the adapter rejects it with the field named.
    await assert.rejects(
      () => loadBenchmarkResult(filePath),
      /Invalid benchmark result file: .+ \(meta\.mode must be "quick" or "full" when present\)/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("summarizeBenchmarkResult uses persisted custom canaryFloor (0.08 vs 0.05 case)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-ui-floor-parity-"));
  try {
    const artifact = {
      meta: {
        id: "custom-floor-run",
        benchmark: "longmemeval",
        timestamp: "2026-04-18T10:00:00.000Z",
        mode: "quick",
        canaryScore: 0.08,
        canaryFloor: 0.05,
      },
      results: {
        tasks: [{ taskId: "task-1" }],
        aggregates: { accuracy: { mean: 0.75 } },
      },
    };

    const filePath = path.join(dir, "custom-floor-run.json");
    await writeFile(filePath, JSON.stringify(artifact), "utf8");

    const loaded = await loadBenchmarkResult(filePath);
    assert.equal(loaded.meta.canaryFloor, 0.05);

    const summary = summarizeBenchmarkResult(loaded);
    assert.equal(summary.integrity.canaryFloor, 0.05);
    assert.equal(summary.integrity.canaryScore, 0.08);
    assert.equal(summary.integrity.canaryUnderFloor, false);

    // Contrast with default floor 0.1 when canaryFloor is absent.
    const defaultFloorArtifact = {
      ...artifact,
      meta: {
        ...artifact.meta,
        id: "default-floor-run",
        canaryFloor: undefined,
      },
    };
    const defaultFilePath = path.join(dir, "default-floor-run.json");
    await writeFile(defaultFilePath, JSON.stringify(defaultFloorArtifact), "utf8");

    const defaultLoaded = await loadBenchmarkResult(defaultFilePath);
    assert.equal(defaultLoaded.meta.canaryFloor, undefined);

    const defaultSummary = summarizeBenchmarkResult(defaultLoaded);
    assert.equal(defaultSummary.integrity.canaryFloor, 0.1);
    assert.equal(defaultSummary.integrity.canaryScore, 0.08);
    assert.equal(defaultSummary.integrity.canaryUnderFloor, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
