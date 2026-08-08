import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { clearMemoryCache } from "./memory-cache.js";
import { StorageManager } from "./storage.js";

async function writeFactFile(storage: StorageManager, body: string): Promise<{ id: string; filePath: string }> {
  const today = new Date().toISOString().slice(0, 10);
  const id = `fact-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const factsDir = path.join(storage.dir, "facts", today);
  const filePath = path.join(factsDir, `${id}.md`);
  const now = new Date().toISOString();
  await mkdir(factsDir, { recursive: true });
  await writeFile(
    filePath,
    [
      "---",
      `id: ${id}`,
      "category: fact",
      `created: ${now}`,
      `updated: ${now}`,
      "source: extraction",
      "confidence: 0.8",
      "confidenceTier: high",
      "tags: []",
      "---",
      "",
      body,
      "",
    ].join("\n"),
    "utf-8",
  );
  clearMemoryCache(storage.dir);
  return { id, filePath };
}

test("dependency supersession fields survive serialize and parse", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-dependency-frontmatter-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();
    const { id, filePath } = await writeFactFile(storage, "A dependent claim.");

    await storage.updateMemoryFrontmatter(id, {
      supersessionCause: "dependency",
      invalidatedBy: "fact-support-1",
    });

    const raw = await readFile(filePath, "utf-8");
    assert.match(raw, /\nsupersessionCause: dependency\n/);
    assert.match(raw, /\ninvalidatedBy: fact-support-1\n/);

    const memory = (await storage.readAllMemories()).find(
      (candidate) => candidate.frontmatter.id === id,
    );
    assert.ok(memory);
    assert.equal(memory.frontmatter.supersessionCause, "dependency");
    assert.equal(memory.frontmatter.invalidatedBy, "fact-support-1");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("legacy memory omits dependency supersession fields", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-dependency-legacy-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();
    const { id } = await writeFactFile(storage, "A legacy claim.");

    const memory = (await storage.readAllMemories()).find(
      (candidate) => candidate.frontmatter.id === id,
    );
    assert.ok(memory);
    assert.equal(memory.frontmatter.supersessionCause, undefined);
    assert.equal(memory.frontmatter.invalidatedBy, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
