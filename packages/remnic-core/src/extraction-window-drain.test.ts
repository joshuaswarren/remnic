import test from "node:test";
import assert from "node:assert/strict";
import {
  chunkExtractionWindow,
  classifyDrainResult,
  extractionWindowBudgetChars,
  mergeDrainResults,
  splitOversizedTurns,
} from "./extraction-window-drain.js";
import type { ExtractionRunResult } from "./orchestration/extraction-run.js";
import type { BufferTurn } from "./types.js";

function makeTurn(content: string, sessionKey = "s1"): BufferTurn {
  return { role: "user", content, timestamp: "2026-10-29T00:00:00.000Z", sessionKey };
}

function skippedResult(reason: string): ExtractionRunResult {
  return { status: "skipped", reason, persistedCount: 0, durableOutputCount: 0 };
}

test("chunkExtractionWindow returns a single chunk when the window fits the budget", () => {
  const turns = [makeTurn("a".repeat(10)), makeTurn("b".repeat(10))];
  const chunks = chunkExtractionWindow(turns, 100);
  assert.equal(chunks.length, 1);
  assert.deepEqual(chunks[0], turns);
});

test("chunkExtractionWindow splits an oversized window into budget-fitting chunks in order", () => {
  const turns = [
    makeTurn("a".repeat(60)),
    makeTurn("b".repeat(60)),
    makeTurn("c".repeat(60)),
    makeTurn("d".repeat(60)),
  ];
  const chunks = chunkExtractionWindow(turns, 100);
  assert.equal(chunks.length, 4);
  for (const chunk of chunks) {
    assert.ok(chunk.every((turn) => turn.content.length <= 100));
  }
  assert.deepEqual(
    chunks.flat().map((turn) => turn.content[0]),
    ["a", "b", "c", "d"],
  );
  assert.deepEqual(chunks.flat(), turns);
});

test("chunkExtractionWindow gives a single oversized turn its own chunk", () => {
  const turns = [makeTurn("x".repeat(250)), makeTurn("y".repeat(10))];
  const chunks = chunkExtractionWindow(turns, 100);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0]?.length, 1);
  assert.equal(chunks[1]?.length, 1);
});

test("chunkExtractionWindow treats a non-positive budget as no chunking", () => {
  const turns = [makeTurn("a".repeat(500)), makeTurn("b".repeat(500))];
  assert.equal(chunkExtractionWindow(turns, 0).length, 1);
  assert.equal(chunkExtractionWindow(turns, Number.POSITIVE_INFINITY).length, 1);
});

test("chunkExtractionWindow returns no chunks for an empty window", () => {
  assert.deepEqual(chunkExtractionWindow([], 100), []);
});

test("classifyDrainResult treats completed runs and benign skips as drained", () => {
  assert.equal(classifyDrainResult({ status: "completed", persistedCount: 1, durableOutputCount: 2 }), "drained");
  assert.equal(classifyDrainResult(skippedResult("below_threshold")), "drained");
  assert.equal(classifyDrainResult(skippedResult("cron_session")), "drained");
  assert.equal(classifyDrainResult(skippedResult("empty_normalized_turns")), "drained");
  assert.equal(classifyDrainResult(skippedResult("processed_fingerprint")), "drained");
});

test("classifyDrainResult reports breaker/backoff skips as deferred", () => {
  assert.equal(classifyDrainResult(skippedResult("provider_circuit_open")), "deferred");
  assert.equal(classifyDrainResult(skippedResult("extraction_backoff")), "deferred");
});

test("classifyDrainResult reports empty extraction results as failed", () => {
  assert.equal(
    classifyDrainResult({ ...skippedResult("empty_extraction_result"), retainedBuffer: true }),
    "failed",
    "an empty result that kept the window for retry is a chunk failure",
  );
  assert.equal(
    classifyDrainResult(skippedResult("empty_extraction_result")),
    "drained",
    "an empty result that cleared its turns extracted fine and found nothing durable",
  );
});

test("mergeDrainResults sums counts, completes when any chunk completes, keeps the last skip reason", () => {
  const first = skippedResult("empty_extraction_result");
  const second: ExtractionRunResult = { status: "completed", persistedCount: 3, durableOutputCount: 4 };
  // A completed chunk means the drain made durable progress.
  const merged = mergeDrainResults(mergeDrainResults(null, first), second);
  assert.equal(merged.status, "completed");
  assert.equal(merged.persistedCount, 3);
  assert.equal(merged.durableOutputCount, 4);
  // All chunks skipped: the aggregate stays skipped with the last reason.
  const mergedFailed = mergeDrainResults(
    mergeDrainResults(null, skippedResult("provider_circuit_open")),
    first,
  );
  assert.equal(mergedFailed.status, "skipped");
  assert.equal(mergedFailed.reason, "empty_extraction_result");
  assert.equal(mergedFailed.persistedCount, 0);
});

test("extractionWindowBudgetChars applies the learned local window only when the local model extracts", () => {
  const registry = { calculateContextSizes: () => ({ maxInputChars: 12_000 }) };
  const base = { registry, model: "local-model", maxContext: undefined };

  assert.equal(extractionWindowBudgetChars({ ...base, localExtractionActive: true }), 12_000);
  assert.equal(
    extractionWindowBudgetChars({ ...base, localExtractionActive: false }),
    Number.POSITIVE_INFINITY,
    "gateway or disabled local LLM: the local window does not describe the extractor",
  );
  assert.equal(
    extractionWindowBudgetChars({ ...base, registry: undefined, localExtractionActive: true }),
    Number.POSITIVE_INFINITY,
    "no registry (legacy host or test double): no budget",
  );
});

test("splitOversizedTurns leaves a fitting turn untouched", () => {
  const turns = [makeTurn("short")];
  const plan = splitOversizedTurns(turns, 100);
  assert.deepEqual(plan.turns, turns);
  assert.equal(plan.partParents.size, 0);
});

test("splitOversizedTurns splits an oversized turn into marked parts covering all content", () => {
  const parent = makeTurn(
    "First sentence here. Second sentence also here. Third sentence keeps going. Fourth is the tail.",
  );
  const plan = splitOversizedTurns([parent], 40);
  assert.ok(plan.turns.length > 1, "expected several parts");
  for (const [index, part] of plan.turns.entries()) {
    assert.deepEqual(part.extractionPartOf, { part: index + 1, of: plan.turns.length });
    assert.ok(part.content.length <= 40, `part ${index} over budget`);
    assert.equal(plan.partParents.get(part), parent);
  }
  const joined = plan.turns.map((part) => part.content).join("");
  assert.equal(joined, parent.content, "every part extracted — nothing dropped");
});

test("splitOversizedTurns never splices marker text into the content", () => {
  const parent = makeTurn("Alpha part one. Beta part two. Gamma part three. Delta part four.");
  const plan = splitOversizedTurns([parent], 30);
  for (const part of plan.turns) {
    assert.ok(parent.content.includes(part.content), "part text must be verbatim slices");
  }
});

test("splitOversizedTurns clamps at the max part count and reports the clamp", () => {
  const parent = makeTurn("one. two. three. four. five. six. seven. eight. nine. ten.");
  const plan = splitOversizedTurns([parent], 8, 4);
  assert.ok(plan.turns.length <= 4);
  assert.equal(plan.clamped, true);
});

test("extractionWindowBudgetChars applies the configured call cap below the model budget", () => {
  const registry = {
    calculateContextSizes: () => ({ maxInputChars: 28800 }),
  };
  const budget = extractionWindowBudgetChars({
    registry,
    localExtractionActive: true,
    model: "m",
    maxContext: 12288,
    callMaxChars: 12000,
  });
  assert.equal(budget, 12000);
});

test("extractionWindowBudgetChars keeps the smaller registry budget", () => {
  const registry = {
    calculateContextSizes: () => ({ maxInputChars: 8000 }),
  };
  const budget = extractionWindowBudgetChars({
    registry,
    localExtractionActive: true,
    model: "m",
    maxContext: 12288,
    callMaxChars: 12000,
  });
  assert.equal(budget, 8000);
});
