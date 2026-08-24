/**
 * End-to-end Phase A runner tests (issue #2333): executable benchmark +
 * numeric gate, evaluated exactly as the issue states.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { BenchmarkResult, ResolvedRunBenchmarkOptions } from "../../../types.ts";
import {
  extractionSpanModeDefinition,
  runExtractionSpanModeBenchmark,
} from "./runner.ts";
import { SPAN_BENCH_FIXTURE, SPAN_BENCH_SMOKE_FIXTURE } from "./fixture.ts";

const FULL_CONVERSATIONS = SPAN_BENCH_FIXTURE.length;
const FULL_GOLD_FACTS = SPAN_BENCH_FIXTURE.reduce((total, conversation) => total + conversation.facts.length, 0);

function options(overrides?: Partial<ResolvedRunBenchmarkOptions>): ResolvedRunBenchmarkOptions {
  const system = {
    async reset() {},
    async store() {},
    async recall() {
      return "";
    },
    async search() {
      return [];
    },
    async getStats() {
      return { count: 0, totalMessages: 0, totalSummaryNodes: 0, maxDepth: 0 };
    },
    async destroy() {},
  } satisfies ResolvedRunBenchmarkOptions["system"];
  return {
    benchmark: extractionSpanModeDefinition,
    mode: "quick",
    system,
    ...overrides,
  };
}

function gateTask(result: BenchmarkResult) {
  const task = result.results.tasks.find((candidate) => candidate.taskId === "span-phase-gate");
  assert.ok(task, "runner must emit a span-phase-gate task");
  return task;
}

test("runner measures both modes and evaluates the gate on the measured numbers", async () => {
  const result = await runExtractionSpanModeBenchmark(options({ seed: 0, mode: "full" }));

  const modeTasks = result.results.tasks.filter((task) => task.taskId.includes(":"));
  assert.equal(modeTasks.length, FULL_CONVERSATIONS * 2);

  const comparison = gateTask(result).details?.comparison as Record<string, any>;
  assert.equal(comparison.model, "deterministic-fake-provider (synthetic; no real model runs)");
  assert.equal(comparison.seed, 0);

  // Gate verdict is internally consistent with the reported measurements.
  assert.equal(comparison.gate.verdict.pass, comparison.gate.verdict.failed.length === 0);
  assert.equal(
    comparison.gate.verdict.conditions.wallClockReduction,
    comparison.wallClockReductionPct >= 20,
  );
  assert.equal(
    comparison.gate.verdict.conditions.judgeQuality,
    comparison.judgeScoreDropPoints < 2,
  );
  assert.equal(
    comparison.gate.verdict.conditions.fallbackRate,
    comparison.fallbackRatePct < 15,
  );
  // Wall-clock reduction must equal the measured token reduction (same
  // decode constant both modes) — the cost model is not independent noise.
  assert.ok(Math.abs(comparison.wallClockReductionPct - comparison.outputTokenReductionPct) < 1e-9);

  // Memory entry counts match between modes (same model, same facts).
  assert.equal(
    comparison.perConversation.memoryEntriesCurrent,
    comparison.perConversation.memoryEntriesSpan,
  );
  assert.equal(comparison.spanAttempts, FULL_GOLD_FACTS);
});

test("same seed reproduces byte-identical gate measurements", async () => {
  const first = await runExtractionSpanModeBenchmark(options({ seed: 42 }));
  const second = await runExtractionSpanModeBenchmark(options({ seed: 42 }));
  assert.deepEqual(gateTask(first).details?.comparison, gateTask(second).details?.comparison);
});

test("quick mode runs the smoke slice; limit applies and validates", async () => {
  const quick = await runExtractionSpanModeBenchmark(options({ mode: "quick" }));
  assert.equal(
    quick.results.tasks.filter((task) => task.taskId.includes(":")).length,
    SPAN_BENCH_SMOKE_FIXTURE.length * 2,
  );
  const limited = await runExtractionSpanModeBenchmark(options({ mode: "full", limit: 1 }));
  assert.equal(
    limited.results.tasks.filter((task) => task.taskId.includes(":")).length,
    2,
  );
  await assert.rejects(runExtractionSpanModeBenchmark(options({ mode: "full", limit: 0 })));
});

test("cost ledger sums both modes' modeled output tokens", async () => {
  const result = await runExtractionSpanModeBenchmark(options({ mode: "full" }));
  const modeTasks = result.results.tasks.filter((task) => task.taskId.includes(":"));
  const summed = modeTasks.reduce((total, task) => total + task.tokens.output, 0);
  assert.equal(result.cost.outputTokens, summed);
  assert.equal(result.cost.inputTokens, 0);
});

test("meanQueryLatencyMs excludes the span-phase-gate bookkeeping task", async () => {
  const result = await runExtractionSpanModeBenchmark(options({ mode: "full" }));
  const measured = result.results.tasks.filter((task) => task.taskId !== "span-phase-gate");
  assert.ok(measured.length > 0);
  assert.ok(result.results.tasks.length > measured.length);
  assert.equal(result.cost.meanQueryLatencyMs, result.cost.totalLatencyMs / measured.length);
  assert.notEqual(result.cost.meanQueryLatencyMs, result.cost.totalLatencyMs / result.results.tasks.length);
});
