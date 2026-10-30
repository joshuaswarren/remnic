import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { StorageManager } from "./storage.js";
import type { BufferTurn } from "./types.js";

function makeTurn(content: string): BufferTurn {
  return { role: "user", content, timestamp: "2026-10-29T00:00:00.000Z", sessionKey: "s1" };
}

test("dropped-chunk recovery files never overwrite each other, even within one millisecond", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-dropped-chunks-"));
  const realNow = Date.now;
  try {
    Date.now = () => 1_793_000_000_000;
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();
    const first = await storage.saveDroppedExtractionChunk("same-key", "first", [makeTurn("one")]);
    const second = await storage.saveDroppedExtractionChunk("same-key", "second", [makeTurn("two")]);

    assert.notEqual(first, second);
    const files = await readdir(path.dirname(first));
    assert.equal(files.length, 2, "both safety copies exist");
  } finally {
    Date.now = realNow;
    await rm(dir, { recursive: true, force: true });
  }
});
