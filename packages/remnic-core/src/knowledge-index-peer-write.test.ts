import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parseConfig } from "./config.js";
import { StorageManager } from "./storage.js";

test("the knowledge index reflects an entity written by another manager for the same directory", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-ki-peer-"));
  try {
    const config = parseConfig({ openaiApiKey: "sk-test", memoryDir });
    const limits = { maxEntities: 20, maxChars: 4000 };
    const reader = new StorageManager(memoryDir);
    const writer = new StorageManager(memoryDir);

    await writer.writeEntity("Alice", "person", ["Alice works on the launch."]);
    const before = await reader.buildKnowledgeIndex(config, limits);
    assert.match(before.result, /\bAlice\b/);
    assert.doesNotMatch(before.result, /\bBob\b/);
    const revision = reader.getEntityMutationVersion();

    await writer.writeEntity("Bob", "person", ["Bob works on the launch."]);
    assert.ok(reader.getEntityMutationVersion() > revision, "reader sees the shared entity revision advance");
    const fresh = await new StorageManager(memoryDir).buildKnowledgeIndex(config, limits);
    assert.match(fresh.result, /\bBob\b/, "a fresh reader confirms the write reached the same directory");

    const warm = await reader.buildKnowledgeIndex(config, limits);
    assert.match(warm.result, /\bBob\b/, `the warmed reader must see the peer write (cached=${warm.cached})`);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});
