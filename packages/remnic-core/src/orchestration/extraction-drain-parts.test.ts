import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SmartBuffer } from "../buffer.js";
import { parseConfig } from "../config.js";
import { StorageManager } from "../storage.js";
import type { BufferTurn } from "../types.js";
import { ExtractionDrain, type DrainRunOptions } from "./extraction-drain.js";
import type { ExtractionRunResult } from "./extraction-run.js";

function makeTurn(content: string, overrides: Partial<BufferTurn> = {}): BufferTurn {
  return { role: "user", content, timestamp: "2026-11-17T12:00:00.000Z", sessionKey: "s1", ...overrides };
}

const DONE: ExtractionRunResult = { status: "completed", persistedCount: 1, durableOutputCount: 1 };
const DEFERRED: ExtractionRunResult = {
  status: "skipped",
  reason: "breaker_open",
  retainedBuffer: true,
  failureClass: "provider_retryable",
  persistedCount: 0,
  durableOutputCount: 0,
};
const TRUNCATED: ExtractionRunResult = {
  status: "skipped",
  reason: "empty_extraction_result",
  retainedBuffer: true,
  failureClass: "output_truncated",
  persistedCount: 0,
  durableOutputCount: 0,
};
const FAILED: ExtractionRunResult = {
  status: "skipped",
  reason: "empty_extraction_result",
  retainedBuffer: true,
  failureClass: "parse_empty",
  persistedCount: 0,
  durableOutputCount: 0,
};

interface DrainOptions {
  turns: BufferTurn[];
  results: ExtractionRunResult[];
  runs?: number;
  budgetChars?: number;
  maxTurnChars?: number;
  dropAfter?: number;
  saveCopies?: { reason: string; contents: string }[];
}

/** A real buffer on real storage, drained with a stub runExtraction that
 *  clears like the coordinator does for a `clearMatchingTurns` drain. */
async function withDrain(opts: DrainOptions): Promise<{
  calls: BufferTurn[][];
  buffer: SmartBuffer;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-parts-drain-"));
  const calls: BufferTurn[][] = [];
  const buffer = new SmartBuffer(
    parseConfig({ memoryDir: root, bufferMaxTurnsPerSession: 2000 }),
    new StorageManager(root),
  );
  try {
    for (const entry of opts.turns) await buffer.addTurn("s1", entry);
    await buffer.flushPendingSave();
    const drain = new ExtractionDrain({
      config: {
        extractionMinUserTurns: 1,
        extractionMinChars: 0,
        extractionMaxTurnChars: opts.maxTurnChars ?? 60,
        extractionChunkDropAfterFailures: opts.dropAfter ?? 3,
      },
      extractionWindowBudgetChars: () => opts.budgetChars ?? 100,
      measureRenderedTurns: (turns) => turns.reduce((total, seen) => total + seen.content.length, 0),
      runExtraction: async (turns, options) => {
        calls.push([...turns]);
        const result = opts.results.shift() ?? DONE;
        if (result.status === "completed") {
          await buffer.clearAfterExtraction(
            "s1",
            turns,
            options?.clearMatchingTurns === true ? { allowNonPrefix: true } : undefined,
          );
        }
        return result;
      },
      getStorage: async () => ({
        saveDroppedExtractionChunk: async (_bufferKey: string, reason: string, turns: readonly BufferTurn[]) => {
          opts.saveCopies?.push({ reason, contents: turns.map((seen) => seen.content).join("") });
          return `/recovery/${turns.length}.json`;
        },
      }),
      buffer: {
        dropExtractionChunk: (bufferKey, turns, dropOptions) =>
          buffer.dropExtractionChunk(bufferKey, turns, dropOptions),
      },
    });
    const options: DrainRunOptions = {
      bufferKey: "s1",
      clearBufferAfterExtraction: true,
      clearMatchingTurns: true,
      skipUserTurnThreshold: false,
      failOnExtractionFailure: false,
      forceExtractionAttempt: false,
    };
    for (let runIndex = 0; runIndex < (opts.runs ?? 1); runIndex += 1) {
      await drain.run(opts.turns, options);
    }
    return { calls, buffer };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function allExtractedText(calls: readonly BufferTurn[][]): string {
  return calls.flat().map((seen) => seen.content).join("");
}

test("an oversized turn drains as ordered parts and the parent clears once", async () => {
  // 150 chars at a 60-char part budget -> 3 parts; the 100-char call budget
  // packs one part per chunk, so every part is a separate extraction call.
  const parent = makeTurn(`${"a".repeat(50)}. ${"b".repeat(50)}. ${"c".repeat(45)}`);
  const { calls, buffer } = await withDrain({ turns: [parent], results: [DONE, DONE, DONE] });
  assert.equal(calls.length, 2, "the parts pack greedily into budget-fitting chunks");
  assert.deepEqual(
    calls.flat().map((seen) => seen.extractionPartOf),
    [
      { part: 1, of: 3 },
      { part: 2, of: 3 },
      { part: 3, of: 3 },
    ],
    "each part copy carries its in-flight marker",
  );
  assert.equal(allExtractedText(calls), parent.content, "every part extracted — verbatim coverage, nothing dropped");
  assert.deepEqual(buffer.getTurns("s1"), [], "the parent clears when its last part drains");
});

test("parts keep sentence boundaries and carry no marker text in content", async () => {
  const parent = makeTurn(`${"a".repeat(50)}. ${"b".repeat(50)}. ${"c".repeat(45)}`);
  const { calls } = await withDrain({ turns: [parent], results: [DONE, DONE, DONE] });
  const parts = calls.flat();
  for (const part of parts) {
    assert.ok(part.content.trimEnd().endsWith(".") || part === parts.at(-1), `part ends on a sentence edge: ${part.content}`);
    assert.ok(!part.content.includes("extractionPartOf"), "no marker text is spliced into content");
    assert.ok(!part.content.includes("part"), "no ordinal text is spliced into content");
  }
});

test("the parent stays buffered until every part drains", async () => {
  const parent = makeTurn(`${"a".repeat(50)}. ${"b".repeat(50)}. ${"c".repeat(45)}`);
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-parts-retry-"));
  const buffer = new SmartBuffer(
    parseConfig({ memoryDir: root, bufferMaxTurnsPerSession: 2000 }),
    new StorageManager(root),
  );
  try {
    await buffer.addTurn("s1", parent);
    await buffer.flushPendingSave();
    const results = [DEFERRED, DONE, DONE, DONE];
    const drain = new ExtractionDrain({
      config: {
        extractionMinUserTurns: 1,
        extractionMinChars: 0,
        extractionMaxTurnChars: 60,
        extractionChunkDropAfterFailures: 3,
      },
      extractionWindowBudgetChars: () => 100,
      measureRenderedTurns: (turns) => turns.reduce((total, seen) => total + seen.content.length, 0),
      runExtraction: async (turns, options) => {
        const result = results.shift() ?? DONE;
        if (result.status === "completed") {
          await buffer.clearAfterExtraction(
            "s1",
            turns,
            options?.clearMatchingTurns === true ? { allowNonPrefix: true } : undefined,
          );
        }
        return result;
      },
      getStorage: async () => ({ saveDroppedExtractionChunk: async () => "/recovery/x.json" }),
      buffer: {
        dropExtractionChunk: (bufferKey, turns, dropOptions) =>
          buffer.dropExtractionChunk(bufferKey, turns, dropOptions),
      },
    });
    const options: DrainRunOptions = {
      bufferKey: "s1",
      clearBufferAfterExtraction: true,
      clearMatchingTurns: true,
      skipUserTurnThreshold: false,
      failOnExtractionFailure: false,
      forceExtractionAttempt: false,
    };
    await drain.run([parent], options);
    assert.deepEqual(
      buffer.getTurns("s1").map((seen) => seen.content),
      [parent.content],
      "the deferred first part leaves the whole parent buffered",
    );
    await drain.run([parent], options);
    assert.deepEqual(buffer.getTurns("s1"), [], "the retry drains all parts and clears the parent");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a turn past the part limit clamps, and the parent leaves through a recovery copy", async () => {
  // 600 chars at a 60-char part budget needs 10 parts; the cap emits 8.
  const parent = makeTurn(Array.from({ length: 10 }, (_v, i) => `${String(i)}${"x".repeat(58)}.`).join(" "));
  const saveCopies: { reason: string; contents: string }[] = [];
  const { calls, buffer } = await withDrain({
    turns: [parent],
    results: Array.from({ length: 8 }, () => DONE),
    budgetChars: 80,
    saveCopies,
  });
  const partMarkers = calls.flat().map((seen) => seen.extractionPartOf?.part);
  assert.deepEqual(partMarkers, [1, 2, 3, 4, 5, 6, 7, 8], "exactly the capped eight parts extract");
  assert.equal(saveCopies.length, 1, "the clamped parent leaves via the recovery-copy path");
  assert.equal(saveCopies[0]?.contents, parent.content, "the recovery copy holds the FULL parent, not slices");
  assert.deepEqual(buffer.getTurns("s1"), [], "the buffer releases the clamped turn");
});

test("a part chunk that keeps failing drops the parent with its full content", async () => {
  const parent = makeTurn(`${"a".repeat(50)}. ${"b".repeat(50)}. ${"c".repeat(45)}`);
  const saveCopies: { reason: string; contents: string }[] = [];
  const { buffer } = await withDrain({
    turns: [parent],
    results: [FAILED, FAILED],
    dropAfter: 2,
    runs: 2,
    saveCopies,
  });
  assert.equal(saveCopies.length, 1, "one recovery copy for the dropped parent");
  assert.equal(saveCopies[0]?.contents, parent.content, "the copy preserves the full parent content");
  assert.deepEqual(buffer.getTurns("s1"), [], "the parent is dropped, not the unmatched slice copies");
});

test("an oversized turn inside a fitting window still splits", async () => {
  // A 150-char turn under a 12k-style call budget would previously lose its
  // tail to the per-turn render clamp; the split keeps every byte.
  const parent = makeTurn(`${"a".repeat(50)}. ${"b".repeat(50)}. ${"c".repeat(45)}`);
  const small = makeTurn("short note", { timestamp: "2026-11-17T12:00:01.000Z" });
  const { calls, buffer } = await withDrain({
    turns: [parent, small],
    results: [DONE, DONE, DONE, DONE],
    budgetChars: 12000,
  });
  const text = allExtractedText(calls);
  assert.ok(text.includes(parent.content), "the split turn is fully extracted");
  assert.ok(text.includes(small.content), "the sibling turn is extracted");
  assert.deepEqual(buffer.getTurns("s1"), [], "the whole window drains");
});

test("a window of exact duplicates that is also oversized extracts every copy's content", async () => {
  // Dedupe cannot fan representatives out into parts, so the oversized window
  // takes the split path and each buffered identity still clears.
  const content = `${"a".repeat(50)}. ${"b".repeat(50)}. ${"c".repeat(45)}`;
  const first = makeTurn(content);
  const duplicate = makeTurn(content, { timestamp: "2026-11-17T12:00:02.000Z" });
  const { buffer } = await withDrain({
    turns: [first, duplicate],
    results: Array.from({ length: 8 }, () => DONE),
  });
  assert.deepEqual(buffer.getTurns("s1"), [], "both buffered identities drain");
});

test("output_truncated never counts toward chunk drops: the run layer already long-parks", async () => {
  // finish_reason=length retries at the same ceiling can never complete, so
  // the run layer long-parks the fingerprint on the first failure. The drain
  // keeps the chunk like a provider failure — it must not count toward a drop.
  // Two 60-char turns at a 100-char budget force the multi-chunk path, where
  // settleVerdict counts failures; the single-run path skips it entirely.
  const first = makeTurn("a".repeat(60));
  const second = makeTurn("b".repeat(60));
  const saveCopies: { reason: string; contents: string }[] = [];
  const { buffer, calls } = await withDrain({
    turns: [first, second],
    results: [TRUNCATED, TRUNCATED, TRUNCATED],
    runs: 3,
    dropAfter: 2,
    saveCopies,
  });
  assert.equal(calls.length, 3, "each run attempts the truncated chunk and returns");
  assert.deepEqual(
    buffer.getTurns("s1").map((seen) => seen.content),
    [first.content, second.content],
    "three truncated runs keep the chunk buffered",
  );
  assert.equal(saveCopies.length, 0, "no recovery copy — nothing was dropped");
});
