import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolvePersistedMemoryRelativePath } from "./orchestration/orchestrator-helpers.js";
import { MEMORY_ID_PATTERN } from "./recall-handles.js";
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

test("concurrent artifact writes remain readable when generated IDs collide", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-artifact-write-collision-"));
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
    let ids: string[];
    try {
      ids = await Promise.all(
        Array.from({ length: 46 }, (_, index) =>
          storage.writeArtifact(`artifact collision candidate ${index}`),
        ),
      );
    } finally {
      Date.now = originalNow;
      Math.random = originalRandom;
    }

    assert.ok(ids.every((id) => MEMORY_ID_PATTERN.test(id)));
    const artifacts = (await storage.searchArtifacts("artifact collision candidate", 100)).filter(
      (artifact) => artifact.content.startsWith("artifact collision candidate "),
    );
    assert.equal(artifacts.length, 46);
  } finally {
    Date.now = originalNow;
    Math.random = originalRandom;
    StorageManager.clearAllStaticCaches();
    await rm(dir, { recursive: true, force: true });
  }
});

test("fresh memory IDs resolve to their persisted dated path before path indexing", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-memory-write-path-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();
    const written = await storage.writeMemory("fact", "fresh memory path candidate", {
      source: "test",
    });
    const relativePath = resolvePersistedMemoryRelativePath({
      memoryId: written.id,
      pathById: new Map(),
      category: "fact",
    });
    const persisted = await readFile(path.join(dir, relativePath), "utf8");
    assert.equal(path.resolve(dir, relativePath), path.resolve(written.memory.path));
    assert.match(persisted, /fresh memory path candidate/);
    assert.ok(MEMORY_ID_PATTERN.test(written.id));
  } finally {
    StorageManager.clearAllStaticCaches();
    await rm(dir, { recursive: true, force: true });
  }
});
