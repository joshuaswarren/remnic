import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SmartBuffer } from "./buffer.js";
import { parseConfig } from "./config.js";
import { ExtractionDrain } from "./orchestration/extraction-drain.js";
import type { ExtractionRunResult } from "./orchestration/extraction-run.js";
import { StorageManager } from "./storage.js";
import type { BufferTurn } from "./types.js";

function makeTurn(sessionKey: string, content: string): BufferTurn {
  return {
    role: "user",
    content,
    timestamp: "2026-10-29T12:00:00.000Z",
    sessionKey,
  };
}

const DONE: ExtractionRunResult = {
  status: "completed",
  persistedCount: 0,
  durableOutputCount: 0,
};

const FAILED: ExtractionRunResult = {
  status: "skipped",
  reason: "synthetic part failure",
  retainedBuffer: true,
  persistedCount: 0,
  durableOutputCount: 0,
};

test("a repeatedly failing part still reaches the drop threshold across drain passes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-part-drop-"));
  try {
    const buffer = new SmartBuffer(parseConfig({}), new StorageManager(root));
    const parent = makeTurn("s1", "x".repeat(120));
    await buffer.addTurn("s1", parent);
    await buffer.flushPendingSave();

    const seenChunks: string[] = [];
    const droppedReasons: string[] = [];
    const drain = new ExtractionDrain({
      config: {
        extractionMinUserTurns: 1,
        extractionMinChars: 0,
        extractionMaxTurnChars: 60,
        extractionChunkDropAfterFailures: 3,
      },
      extractionWindowBudgetChars: () => 100,
      runExtraction: async (turns) => {
        seenChunks.push(turns.map((turn) => turn.content.length).join("+"));
        return turns[0]?.extractionPartOf?.part === 1 ? DONE : FAILED;
      },
      getStorage: async () => ({
        saveDroppedExtractionChunk: async (_bufferKey, reason) => {
          droppedReasons.push(reason);
          return "/recovery/part-parent.json";
        },
      }),
      buffer,
    });

    const turns = [parent];
    let lastResult: ExtractionRunResult | undefined;
    for (let pass = 0; pass < 4; pass += 1) {
      lastResult = await drain.run(turns, {
        bufferKey: "s1",
        clearBufferAfterExtraction: true,
        clearMatchingTurns: false,
        skipUserTurnThreshold: false,
        failOnExtractionFailure: false,
        forceExtractionAttempt: false,
      });
    }

    assert.ok(
      droppedReasons.length > 0,
      `the failing part must reach the drop threshold; passes ran ${seenChunks.length} chunks, last ${JSON.stringify(lastResult)}`
    );
    assert.ok(droppedReasons[0]?.includes("dropped after 3"), droppedReasons[0]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
