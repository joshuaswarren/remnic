import assert from "node:assert/strict";
import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { recordAbstractionNode } from "./abstraction-nodes.js";
import { searchHarmonicRetrieval } from "./harmonic-retrieval.js";
import { rebuildMemoryProjection } from "./maintenance/rebuild-memory-projection.js";
import { StorageManager } from "./storage.js";

test("indexed harmonic projection matches the corpus scan and still sees later sources", async () => {
  const memoryDir = await mkdtemp(path.join(tmpdir(), "remnic-harmonic-index-"));
  try {
    const storage = new StorageManager(memoryDir);
    await storage.ensureDirectories();
    const active = await storage.writeMemory("fact", "active harmonic source payload", { source: "test" });
    const archived = await storage.writeMemory("fact", "archived harmonic source payload", { source: "test" });
    await storage.updateMemoryFrontmatter(archived.id, { status: "archived" });
    await recordAbstractionNode({
      memoryDir,
      node: {
        schemaVersion: 1,
        nodeId: "mixed-sources",
        recordedAt: "2026-10-12T00:00:00.000Z",
        sessionKey: "agent:index",
        kind: "topic",
        abstractionLevel: "meso",
        title: "stored title",
        summary: "stored summary",
        sourceMemoryIds: [active.id, archived.id, "missing-source"],
      },
    });

    const beforeIndex = await searchHarmonicRetrieval({
      memoryDir,
      query: "active harmonic source payload",
      maxResults: 5,
      anchorsEnabled: false,
    });
    await rebuildMemoryProjection({ memoryDir, storage });
    const afterIndex = await searchHarmonicRetrieval({
      memoryDir,
      query: "active harmonic source payload",
      maxResults: 5,
      anchorsEnabled: false,
    });
    assert.deepEqual(afterIndex, beforeIndex);
    assert.deepEqual(afterIndex.map((result) => result.node.sourceMemoryIds), [[active.id]]);
    assert.equal(afterIndex[0]?.node.title.includes("active harmonic source payload"), true);

    const late = await storage.writeMemory("fact", "late harmonic source payload", { source: "test" });
    await recordAbstractionNode({
      memoryDir,
      node: {
        schemaVersion: 1,
        nodeId: "late-source",
        recordedAt: "2026-10-12T01:00:00.000Z",
        sessionKey: "agent:index",
        kind: "topic",
        abstractionLevel: "meso",
        title: "late title",
        summary: "late summary",
        sourceMemoryIds: [late.id],
      },
    });
    const lateResults = await searchHarmonicRetrieval({
      memoryDir,
      query: "late harmonic source payload",
      maxResults: 5,
      anchorsEnabled: false,
    });
    assert.equal(lateResults.some((result) => result.node.nodeId === "late-source" && result.node.sourceMemoryIds?.includes(late.id)), true);

    const coldMemory = (await storage.readAllMemories()).find((memory) => memory.frontmatter.id === active.id);
    if (!coldMemory) throw new Error("active source missing before cold move");
    const coldPath = path.join(memoryDir, "cold", path.relative(memoryDir, coldMemory.path));
    await mkdir(path.dirname(coldPath), { recursive: true });
    await rename(coldMemory.path, coldPath);
    storage.invalidateMemoryCachesForTiers(["hot", "cold"]);
    const coldResults = await searchHarmonicRetrieval({
      memoryDir,
      query: "active harmonic source payload",
      maxResults: 5,
      anchorsEnabled: false,
    });
    assert.equal(coldResults.some((result) => result.node.sourceMemoryIds?.includes(active.id)), true);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});
