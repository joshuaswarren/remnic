import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { StorageManager } from "../src/storage.js";
import { parseConfig } from "../src/config.js";

test("buildKnowledgeIndex applies per-call overrides without stale cache leakage", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "engram-ki-"));
  try {
    const storage = new StorageManager(tempDir);
    await storage.ensureDirectories();
    await storage.writeEntity("Alice", "person", ["A1", "A2", "A3", "A4"]);
    await storage.writeEntity("Project Phoenix", "project", ["P1", "P2"]);
    await storage.writeEntity("Acme Corp", "company", ["C1"]);

    const cfg = parseConfig({
      openaiApiKey: "sk-test",
      knowledgeIndexEnabled: true,
      knowledgeIndexMaxEntities: 3,
      knowledgeIndexMaxChars: 4000,
    });

    const defaultResult = await storage.buildKnowledgeIndex(cfg);
    assert.equal(defaultResult.cached, false);
    assert.match(defaultResult.result, /## Knowledge Index/);

    const constrained = await storage.buildKnowledgeIndex(cfg, {
      maxEntities: 1,
      maxChars: 4000,
    });
    const rowCount = constrained.result
      .split("\n")
      .filter((line) => line.startsWith("| ") && !line.includes("Entity | Type"))
      .length;
    assert.equal(rowCount, 1);

    const cachedAgain = await storage.buildKnowledgeIndex(cfg);
    assert.equal(cachedAgain.cached, true);
    assert.equal(cachedAgain.result, defaultResult.result);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
