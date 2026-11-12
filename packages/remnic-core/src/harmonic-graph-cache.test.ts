import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { recordAbstractionNode, type AbstractionNode } from "./abstraction-nodes.js";
import {
  clearHarmonicGraphCache,
  harmonicGraphCacheStats,
  readProjectedHarmonicGraph,
  searchHarmonicRetrieval,
} from "./harmonic-retrieval.js";
import { bumpMemoryCorpusVersionForDir } from "./memory-corpus-version.js";
import { StorageManager } from "./storage.js";

function node(nodeId: string, title: string, sourceMemoryIds: string[]): AbstractionNode {
  return {
    schemaVersion: 1,
    nodeId,
    recordedAt: new Date().toISOString(),
    sessionKey: "agent:test",
    kind: "topic",
    abstractionLevel: "meso",
    title,
    summary: title,
    sourceMemoryIds,
  };
}

async function withDir(run: (memoryDir: string, storage: StorageManager) => Promise<void>) {
  const memoryDir = await mkdtemp(path.join(tmpdir(), "remnic-harmonic-cache-"));
  clearHarmonicGraphCache();
  try {
    const storage = new StorageManager(memoryDir);
    await storage.ensureDirectories();
    await run(memoryDir, storage);
  } finally {
    clearHarmonicGraphCache();
    await rm(memoryDir, { recursive: true, force: true });
  }
}

const read = (memoryDir: string, extra: { nowMs?: number } = {}) =>
  readProjectedHarmonicGraph({ memoryDir, anchorsEnabled: true, useCache: true, ...extra });

test("a second cached read does no file reads", async () => {
  await withDir(async (memoryDir, storage) => {
    const first = await storage.writeMemory("fact", "cache source one", { source: "test" });
    const nodeFile = await recordAbstractionNode({ memoryDir, node: node("n1", "cache source one", [first.id]) });
    const before = { ...harmonicGraphCacheStats };
    const a = await read(memoryDir);
    assert.equal(a.nodes.length, 1);
    assert.equal(harmonicGraphCacheStats.misses, before.misses + 1);
    // Remove every file the projection reads. A real read would now return nothing.
    await rm(nodeFile, { force: true });
    await rm((await storage.getMemoryById(first.id))!.path, { force: true });
    const b = await read(memoryDir);
    assert.equal(harmonicGraphCacheStats.hits, before.hits + 1);
    assert.equal(b, a);
    assert.equal(b.nodes.length, 1);
  });
});

test("a recall after a new memory is saved sees it", async () => {
  await withDir(async (memoryDir, storage) => {
    const first = await storage.writeMemory("fact", "alpha harmonic", { source: "test" });
    await recordAbstractionNode({ memoryDir, node: node("n1", "alpha harmonic", [first.id]) });
    const hits = () => harmonicGraphCacheStats.hits;
    const query = { memoryDir, query: "bravo cache", maxResults: 3, anchorsEnabled: true, useGraphCache: true };
    assert.equal((await searchHarmonicRetrieval(query)).length, 0);
    const h = hits();
    assert.equal((await searchHarmonicRetrieval(query)).length, 0);
    assert.equal(hits(), h + 1);

    const second = await storage.writeMemory("fact", "bravo cache", { source: "test" });
    await recordAbstractionNode({ memoryDir, node: node("n2", "bravo cache", [second.id]) });
    const results = await searchHarmonicRetrieval(query);
    assert.deepEqual(results.map((result) => result.node.nodeId), ["n2"]);
  });
});

test("an out-of-band corpus bump invalidates, so a source that leaves the active set drops out", async () => {
  await withDir(async (memoryDir, storage) => {
    const memory = await storage.writeMemory("fact", "gamma status fact", { source: "test" });
    await recordAbstractionNode({ memoryDir, node: node("n1", "gamma status fact", [memory.id]) });
    assert.equal((await read(memoryDir)).nodes.length, 1);
    const memoryPath = (await storage.getMemoryById(memory.id))!.path;
    await writeFile(
      memoryPath,
      (await readFile(memoryPath, "utf8")).replace("category: fact", "category: fact\nstatus: quarantined"),
    );
    // The documented out-of-band bump: the same call review and governance writers make.
    bumpMemoryCorpusVersionForDir(memoryDir);
    assert.equal((await read(memoryDir)).nodes.length, 0);
  });
});

test("an explicit nowMs bypasses the cache", async () => {
  await withDir(async (memoryDir, storage) => {
    const memory = await storage.writeMemory("fact", "delta bypass fact", { source: "test" });
    const nodeFile = await recordAbstractionNode({ memoryDir, node: node("n1", "delta bypass fact", [memory.id]) });
    assert.equal((await read(memoryDir)).nodes.length, 1);
    await rm(nodeFile, { force: true });
    assert.equal((await read(memoryDir, { nowMs: Date.now() })).nodes.length, 0);
  });
});

test("cached arrays are frozen", async () => {
  await withDir(async (memoryDir, storage) => {
    const memory = await storage.writeMemory("fact", "epsilon frozen fact", { source: "test" });
    await recordAbstractionNode({ memoryDir, node: node("n1", "epsilon frozen fact", [memory.id]) });
    const graph = await read(memoryDir);
    assert.throws(() => (graph.nodes as AbstractionNode[]).push(node("x", "x", [])), TypeError);
  });
});
