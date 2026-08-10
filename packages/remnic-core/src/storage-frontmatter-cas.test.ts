import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { StorageManager } from "./storage.js";

async function withStorage(run: (storage: StorageManager) => Promise<void>): Promise<void> {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-frontmatter-cas-"));
  try {
    await run(new StorageManager(memoryDir));
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
}

test("writeMemoryFrontmatterIfUnchanged rejects a semantic concurrent change", async () => {
  await withStorage(async (storage) => {
    const created = await storage.writeMemory("fact", "The source snapshot must remain stable.", { source: "test" });
    const expected = await storage.getMemoryById(created.id);
    assert.ok(expected);

    assert.equal(await storage.writeMemoryFrontmatter(expected, { status: "archived" }), true);
    assert.equal(
      await storage.writeMemoryFrontmatterIfUnchanged(expected, {
        importance: { score: 0.9, level: "high", reasons: ["test"], keywords: [] },
      }),
      false,
    );

    const current = await storage.getMemoryById(created.id);
    assert.ok(current);
    assert.equal(current.frontmatter.status, "archived");
    assert.notEqual(current.frontmatter.importance?.score, 0.9);
  });
});

test("writeMemoryFrontmatterIfUnchanged preserves access-only updates", async () => {
  await withStorage(async (storage) => {
    const created = await storage.writeMemory("fact", "Access telemetry is not semantic content.", { source: "test" });
    const expected = await storage.getMemoryById(created.id);
    assert.ok(expected);

    const lastAccessed = "2026-08-10T00:00:00.000Z";
    assert.equal(await storage.writeMemoryFrontmatter(expected, { accessCount: 3, lastAccessed }), true);
    assert.equal(
      await storage.writeMemoryFrontmatterIfUnchanged(expected, {
        importance: { score: 0.8, level: "high", reasons: ["test"], keywords: [] },
      }),
      true,
    );

    const current = await storage.getMemoryById(created.id);
    assert.ok(current);
    assert.equal(current.frontmatter.importance?.score, 0.8);
    assert.equal(current.frontmatter.accessCount, 3);
    assert.equal(current.frontmatter.lastAccessed, lastAccessed);
  });
});
