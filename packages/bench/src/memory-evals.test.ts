import assert from "node:assert/strict";
import test from "node:test";

import {
  MEMORY_EVAL_DIMENSIONS,
  MEMORY_EVAL_PUBLIC_LINE,
  getMemoryEvalDimension,
  listMemoryEvalBenchmarkIds,
  listMemoryEvalDimensions,
  type MemoryEvalDimensionId,
} from "./memory-evals.ts";
import { listBenchmarks } from "./registry.ts";

const EXPECTED_DIMENSION_IDS: readonly MemoryEvalDimensionId[] = [
  "repeated_context_reduction",
  "unnecessary_clarification_reduction",
  "retrieval_correctness",
  "stale_memory_harm",
  "scope_respect",
  "ask_when_needed",
  "act_when_enough_context",
  "personalization_quality",
];

test("memory eval contract covers the user-aware agent questions", () => {
  assert.equal(
    MEMORY_EVAL_PUBLIC_LINE,
    "Agent memory without evals is vibes with a database.",
  );
  assert.deepEqual(
    listMemoryEvalDimensions().map((dimension) => dimension.id),
    EXPECTED_DIMENSION_IDS,
  );
});

test("memory eval dimensions have unique ids, metrics, and quick benchmarks", () => {
  const ids = MEMORY_EVAL_DIMENSIONS.map((dimension) => dimension.id);
  assert.equal(new Set(ids).size, ids.length);

  for (const dimension of MEMORY_EVAL_DIMENSIONS) {
    assert.match(dimension.question, /\?$/);
    assert.ok(dimension.metrics.length > 0, `${dimension.id} has metrics`);
    assert.ok(
      dimension.quickBenchmarkIds.length > 0,
      `${dimension.id} has quick benchmark coverage`,
    );
    assert.ok(
      dimension.fullModeGuidance.length > 20,
      `${dimension.id} has full-mode guidance`,
    );
  }
});

test("memory eval benchmark list is unique and stable", () => {
  assert.deepEqual(listMemoryEvalBenchmarkIds(), [
    "assistant-morning-brief",
    "assistant-next-best-action",
    "assistant-synthesis",
    "buffer-surprise-trigger",
    "coding-recall",
    "contradiction-detection",
    "longmemeval",
    "memoryagentbench",
    "personamem",
    "retention-aged-dataset",
    "retrieval-direct-answer",
    "retrieval-personalization",
    "retrieval-temporal",
  ]);
});

test("memory eval benchmark ids reference registered benchmarks", () => {
  const registeredIds = new Set(listBenchmarks().map((benchmark) => benchmark.id));
  for (const benchmarkId of listMemoryEvalBenchmarkIds()) {
    assert.ok(
      registeredIds.has(benchmarkId),
      `expected ${benchmarkId} to be a registered benchmark`,
    );
  }
});

test("unknown memory eval dimension throws explicitly", () => {
  assert.throws(
    () => getMemoryEvalDimension("missing" as MemoryEvalDimensionId),
    /Unknown memory eval dimension: missing/,
  );
});
