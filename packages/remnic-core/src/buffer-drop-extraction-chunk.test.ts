import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SmartBuffer } from "./buffer.js";
import { parseConfig } from "./config.js";
import { StorageManager } from "./storage.js";
import type { BufferTurn } from "./types.js";
import { ExtractionDrain } from "./orchestration/extraction-drain.js";
import type { ExtractionRunResult } from "./orchestration/extraction-run.js";

function makeTurn(sessionKey: string, content: string): BufferTurn {
  return {
    role: "user",
    content,
    timestamp: "2026-10-29T12:00:00.000Z",
    sessionKey,
  };
}

/** A real buffer on real storage; `restart()` is what a process restart would load from disk. */
async function withBuffer(run: (buffer: SmartBuffer, restart: () => Promise<SmartBuffer>) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-drop-chunk-"));
  try {
    const buffer = new SmartBuffer(parseConfig({}), new StorageManager(root));
    await run(buffer, async () => {
      const reloaded = new SmartBuffer(parseConfig({}), new StorageManager(root));
      await reloaded.load();
      return reloaded;
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("dropExtractionChunk removes the matched prefix and the drop survives a restart", async () => {
  await withBuffer(async (buffer, restart) => {
    const turns = [makeTurn("s1", "turn one"), makeTurn("s1", "turn two"), makeTurn("s1", "turn three")];
    for (const turn of turns) await buffer.addTurn("s1", turn);
    await buffer.flushPendingSave();

    const dropped = await buffer.dropExtractionChunk("s1", turns.slice(0, 2));

    assert.equal(dropped, 2);
    assert.deepEqual(buffer.getTurns("s1").map((turn) => turn.content), ["turn three"]);
    assert.deepEqual((await restart()).getTurns("s1").map((turn) => turn.content), ["turn three"], "what a restart loads");
    // A drop is not an extraction: the extraction bookkeeping stays untouched.
    assert.equal(buffer.getExtractionCount("s1"), 0);
  });
});

test("dropExtractionChunk returns zero without dropping when turns no longer match", async () => {
  await withBuffer(async (buffer, restart) => {
    await buffer.addTurn("s1", makeTurn("s1", "kept turn"));
    await buffer.flushPendingSave();

    const dropped = await buffer.dropExtractionChunk("s1", [makeTurn("s1", "already extracted elsewhere")]);

    assert.equal(dropped, 0);
    assert.equal(buffer.getTurns("s1").length, 1);
    assert.equal((await restart()).getTurns("s1").length, 1, "the kept turn is still there after a restart");
  });
});

test("dropExtractionChunk drops the whole matched window and a restart finds the buffer empty", async () => {
  await withBuffer(async (buffer, restart) => {
    const turns = [makeTurn("s1", "only turn")];
    await buffer.addTurn("s1", turns[0]!);
    await buffer.flushPendingSave();

    const dropped = await buffer.dropExtractionChunk("s1", turns);

    assert.equal(dropped, 1);
    assert.equal(buffer.getTurns("s1").length, 0);
    assert.equal((await restart()).getTurns("s1").length, 0);
  });
});

const FAILED: ExtractionRunResult = { status: "skipped", reason: "empty_extraction_result", retainedBuffer: true, failureClass: "parse_empty", persistedCount: 0, durableOutputCount: 0 };
const DONE: ExtractionRunResult = { status: "completed", persistedCount: 1, durableOutputCount: 1 };

/** w7K's probe on #3266: a pinned capture sits before a native group drained with clearMatchingTurns. */
async function drainBehindPinnedCapture(buffer: SmartBuffer, results: ExtractionRunResult[], dropAfter: number): Promise<ExtractionRunResult> {
  const pinned: BufferTurn = { ...makeTurn("s1", "pinned capture"), acceptedCapture: true };
  const native = [makeTurn("s1", "a".repeat(60)), makeTurn("s1", "b".repeat(60))];
  for (const turn of [pinned, ...native]) await buffer.addTurn("s1", turn);
  await buffer.flushPendingSave();
  const drain = new ExtractionDrain({
    config: { extractionMinUserTurns: 1, extractionMinChars: 0, extractionMaxTurnChars: 100_000, extractionChunkDropAfterFailures: dropAfter },
    extractionWindowBudgetChars: () => 100,
    runExtraction: async (turns, options) => {
      const result = results.shift() ?? DONE;
      // A successful run clears its chunk the way the coordinator does for a native group: by identity.
      if (result.status === "completed") await buffer.clearAfterExtraction("s1", turns, options?.clearMatchingTurns === true ? { allowNonPrefix: true } : undefined);
      return result;
    },
    getStorage: async () => ({ saveDroppedExtractionChunk: async () => "/recovery/copy.json" }),
    buffer,
    extractionQueueCoordinator: { beginPreemptable: () => {} },
  });
  return await drain.run(native, {
    bufferKey: "s1",
    clearBufferAfterExtraction: true,
    clearMatchingTurns: true,
    skipUserTurnThreshold: false,
    failOnExtractionFailure: false,
    forceExtractionAttempt: false,
  });
}

test("a dropped chunk behind a pinned capture is removed by identity, like a successful clear (w7K)", async () => {
  await withBuffer(async (buffer, restart) => {
    const result = await drainBehindPinnedCapture(buffer, [FAILED, DONE], 1);

    assert.equal(result.status, "completed");
    assert.deepEqual(buffer.getTurns("s1").map((turn) => turn.content), ["pinned capture"], "the failed turn is gone, the pinned capture stays");
    assert.deepEqual((await restart()).getTurns("s1").map((turn) => turn.content), ["pinned capture"], "and a restart agrees");
  });
});

test("a failed chunk made only of deferred-retained turns can be dropped, and a restart agrees (Codex P2)", async () => {
  await withBuffer(async (buffer, restart) => {
    const retained = [makeTurn("s1", "retained one"), makeTurn("s1", "retained two")];
    const live = makeTurn("s1", "live turn");
    await buffer.retainDeferredTurns("s1", retained);
    await buffer.addTurn("s1", live);
    await buffer.flushPendingSave();

    // The window a trigger snapshot sees is the retained turns followed by the live ones; the first chunk is retained-only.
    const dropped = await buffer.dropExtractionChunk("s1", retained);

    assert.equal(dropped, 2);
    assert.deepEqual(buffer.getRetainedDeferredTurns("s1"), []);
    assert.deepEqual(buffer.getTurns("s1").map((turn) => turn.content), ["live turn"]);
    const reloaded = await restart();
    assert.deepEqual(reloaded.getRetainedDeferredTurns("s1"), [], "retained turns stay dropped after a restart");
    assert.deepEqual(reloaded.getTurns("s1").map((turn) => turn.content), ["live turn"]);
  });
});

test("a chunk that spans retained and live turns drops both", async () => {
  await withBuffer(async (buffer, restart) => {
    const retained = [makeTurn("s1", "retained one")];
    const live = [makeTurn("s1", "live one"), makeTurn("s1", "live two")];
    await buffer.retainDeferredTurns("s1", retained);
    for (const turn of live) await buffer.addTurn("s1", turn);
    await buffer.flushPendingSave();

    const dropped = await buffer.dropExtractionChunk("s1", [...retained, live[0]!]);

    assert.equal(dropped, 2);
    assert.deepEqual((await restart()).getTurns("s1").map((turn) => turn.content), ["live two"]);
  });
});
