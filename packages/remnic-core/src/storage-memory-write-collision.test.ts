import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { StorageManager } from "./storage.js";

test("concurrent memory writes remain readable when generated IDs collide", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-memory-write-collision-"));
  const originalNow = Date.now;
  const originalRandom = Math.random;
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();
    let randomCall = 0;
    Date.now = () => 1_700_000_000_000;
    Math.random = () => {
      const call = randomCall;
      randomCall += 1;
      return call === 45 ? 0.01 : (call + 1) / 100;
    };
    try {
      await Promise.all(
        Array.from({ length: 46 }, (_, index) =>
          storage.writeMemory("fact", `write collision candidate ${index}`, { source: "test" }),
        ),
      );
    } finally {
      Date.now = originalNow;
      Math.random = originalRandom;
    }

    const memories = (await storage.readAllMemories()).filter((memory) =>
      memory.content.startsWith("write collision candidate "),
    );
    assert.equal(memories.length, 46);
  } finally {
    Date.now = originalNow;
    Math.random = originalRandom;
    StorageManager.clearAllStaticCaches();
    await rm(dir, { recursive: true, force: true });
  }
});
