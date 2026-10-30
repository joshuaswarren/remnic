import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SmartBuffer } from "./buffer.js";
import { parseConfig } from "./config.js";
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
