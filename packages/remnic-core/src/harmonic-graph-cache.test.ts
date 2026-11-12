import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { recordAbstractionNode, upsertAbstractionNodes, type AbstractionNode } from "./abstraction-nodes.js";
import { pruneOrphanCueAnchors, recordCueAnchor, upsertCueAnchors, type CueAnchor } from "./cue-anchors.js";
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
    assert.throws(() => graph.nodes.push(node("x", "x", [])), TypeError);
  });
});

test("cached node records are deep frozen, so a caller cannot change later reads", async () => {
  await withDir(async (memoryDir, storage) => {
    const memory = await storage.writeMemory("fact", "zeta deep frozen fact", { source: "test" });
    await recordAbstractionNode({ memoryDir, node: node("n1", "zeta deep frozen fact", [memory.id]) });
    const graph = await read(memoryDir);
    const cached = graph.nodes[0]!;
    assert.throws(() => { cached.title = "changed"; }, TypeError);
    assert.throws(() => cached.sourceMemoryIds?.push("x"), TypeError);
    assert.equal((await read(memoryDir)).nodes[0]!.title, "zeta deep frozen fact");
  });
});

test("an aborted signal rejects even when the graph is cached", async () => {
  await withDir(async (memoryDir, storage) => {
    const memory = await storage.writeMemory("fact", "eta abort fact", { source: "test" });
    await recordAbstractionNode({ memoryDir, node: node("n1", "eta abort fact", [memory.id]) });
    await read(memoryDir);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      readProjectedHarmonicGraph({ memoryDir, anchorsEnabled: true, useCache: true, abortSignal: controller.signal }),
    );
  });
});

function anchor(anchorId: string, nodeRef: string, memoryId: string): CueAnchor {
  return {
    schemaVersion: 1,
    anchorId,
    anchorType: "entity",
    anchorValue: anchorId,
    normalizedCue: anchorId,
    recordedAt: new Date().toISOString(),
    sessionKey: "agent:test",
    nodeRefs: [nodeRef],
    sourceMemoryIdsByNodeRef: { [nodeRef]: [memoryId] },
  };
}

// Each case seeds node n1 (source m1) and, for the anchor cases, anchor a1, fills the cache, then runs ONE
// store write with no memory write after it. The next read must miss and show the new count; with the
// graph version bump removed these fail because the corpus sentinels never move.
async function seedForWrite(memoryDir: string, storage: StorageManager) {
  const m1 = await storage.writeMemory("fact", "seed one", { source: "test" });
  const m2 = await storage.writeMemory("fact", "seed two", { source: "test" });
  await recordAbstractionNode({ memoryDir, node: node("n1", "seed one", [m1.id]) });
  await recordAbstractionNode({ memoryDir, node: node("n2", "seed two", [m2.id]) });
  await recordCueAnchor({ memoryDir, anchor: anchor("a1", "n1", m1.id) });
  return { m1, m2 };
}

async function counts(memoryDir: string) {
  const graph = await read(memoryDir);
  return { nodes: graph.nodes.length, anchors: graph.anchors.length };
}

const storeWrites: Array<{
  name: string;
  write: (memoryDir: string, ids: { m1: string; m2: string }) => Promise<void>;
  expected: { nodes: number; anchors: number };
}> = [
  {
    name: "recordAbstractionNode",
    write: async (memoryDir, ids) => { await recordAbstractionNode({ memoryDir, node: node("n3", "seed three", [ids.m1]) }); },
    expected: { nodes: 3, anchors: 1 },
  },
  {
    name: "upsertAbstractionNodes",
    write: async (memoryDir, ids) => { await upsertAbstractionNodes({ memoryDir, nodes: [node("n3", "seed three", [ids.m1])] }); },
    expected: { nodes: 3, anchors: 1 },
  },
  {
    name: "recordCueAnchor",
    write: async (memoryDir, ids) => { await recordCueAnchor({ memoryDir, anchor: anchor("a2", "n2", ids.m2) }); },
    expected: { nodes: 2, anchors: 2 },
  },
  {
    name: "upsertCueAnchors",
    write: async (memoryDir, ids) => { await upsertCueAnchors({ memoryDir, anchors: [anchor("a2", "n2", ids.m2)] }); },
    expected: { nodes: 2, anchors: 2 },
  },
];

for (const { name, write, expected } of storeWrites) {
  test(`${name} alone invalidates the cached graph`, async () => {
    await withDir(async (memoryDir, storage) => {
      const { m1, m2 } = await seedForWrite(memoryDir, storage);
      assert.deepEqual(await counts(memoryDir), { nodes: 2, anchors: 1 });
      const hitsBefore = harmonicGraphCacheStats.hits;
      assert.deepEqual(await counts(memoryDir), { nodes: 2, anchors: 1 });
      assert.equal(harmonicGraphCacheStats.hits, hitsBefore + 1);

      await write(memoryDir, { m1: m1.id, m2: m2.id });
      const missesBefore = harmonicGraphCacheStats.misses;
      assert.deepEqual(await counts(memoryDir), expected);
      assert.equal(harmonicGraphCacheStats.misses, missesBefore + 1);
    });
  });
}

test("pruneOrphanCueAnchors alone invalidates the cached graph", async () => {
  await withDir(async (memoryDir, storage) => {
    const { m2 } = await seedForWrite(memoryDir, storage);
    await recordCueAnchor({ memoryDir, anchor: anchor("a2", "n2", m2.id) });
    assert.deepEqual(await counts(memoryDir), { nodes: 2, anchors: 2 });
    // n2's file goes away behind the cache's back, which makes a2 an orphan. Only the prune below bumps.
    await rm(path.join(memoryDir, "state", "abstraction-nodes", "nodes", new Date().toISOString().slice(0, 10), "n2.json"), { force: true });
    assert.deepEqual(await counts(memoryDir), { nodes: 2, anchors: 2 });
    assert.equal(await pruneOrphanCueAnchors({ memoryDir }), 1);
    assert.deepEqual(await counts(memoryDir), { nodes: 1, anchors: 1 });
  });
});

test("an entry older than the TTL is rebuilt", async (t) => {
  await withDir(async (memoryDir, storage) => {
    const memory = await storage.writeMemory("fact", "zeta ttl fact", { source: "test" });
    const nodeFile = await recordAbstractionNode({ memoryDir, node: node("n1", "zeta ttl fact", [memory.id]) });
    const start = Date.now();
    const clock = t.mock.method(Date, "now", () => start);
    assert.equal((await read(memoryDir)).nodes.length, 1);
    await rm(nodeFile, { force: true });
    clock.mock.mockImplementation(() => start + 29_000);
    assert.equal((await read(memoryDir)).nodes.length, 1, "still cached inside the TTL");
    clock.mock.mockImplementation(() => start + 31_000);
    assert.equal((await read(memoryDir)).nodes.length, 0, "rebuilt past the TTL");
  });
});
