import assert from "node:assert/strict";
import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { getMemoryProjectionPath } from "./memory-projection-store.js";
import { openBetterSqlite3 } from "./runtime/better-sqlite.js";
import { recordAbstractionNode } from "./abstraction-nodes.js";
import { searchHarmonicRetrieval, type HarmonicRetrievalResult } from "./harmonic-retrieval.js";
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
    await rebuildMemoryProjection({ memoryDir, storage, dryRun: false });
    const originalReadAll = StorageManager.prototype.readAllMemories;
    let corpusScans = 0;
    StorageManager.prototype.readAllMemories = function (this: StorageManager, ...args: unknown[]) {
      corpusScans += 1;
      return Reflect.apply(originalReadAll, this, args);
    };
    let afterIndex: HarmonicRetrievalResult[];
    try {
      afterIndex = await searchHarmonicRetrieval({
        memoryDir,
        query: "active harmonic source payload",
        maxResults: 5,
        anchorsEnabled: false,
      });
    } finally {
      StorageManager.prototype.readAllMemories = originalReadAll;
    }
    assert.equal(corpusScans, 0, "an openable fresh index must not scan the hot corpus");
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

function setRebuiltAt(memoryDir: string, iso: string): void {
  const db = openBetterSqlite3(getMemoryProjectionPath(memoryDir));
  try {
    db.prepare("UPDATE meta SET value = ? WHERE key = 'rebuiltAt'").run(iso);
  } finally {
    db.close();
  }
}

async function nodeFor(memoryDir: string, nodeId: string, sourceMemoryIds: string[], title: string) {
  await recordAbstractionNode({
    memoryDir,
    node: {
      schemaVersion: 1,
      nodeId,
      recordedAt: "2026-10-12T00:00:00.000Z",
      sessionKey: "agent:index",
      kind: "topic",
      abstractionLevel: "meso",
      title,
      summary: title,
      sourceMemoryIds,
    },
  });
}

const search = (memoryDir: string, query: string) =>
  searchHarmonicRetrieval({ memoryDir, query, maxResults: 5, anchorsEnabled: false });

test("a source written after the rebuild stays found beyond two days, and unsafe or queue ids never resolve", async () => {
  const memoryDir = await mkdtemp(path.join(tmpdir(), "remnic-harmonic-index-"));
  try {
    const storage = new StorageManager(memoryDir);
    await storage.ensureDirectories();
    const base = await storage.writeMemory("fact", "baseline harmonic anchor", { source: "test" });
    await rebuildMemoryProjection({ memoryDir, storage, dryRun: false });

    // Written after the rebuild, then filed under a day three days back; the
    // index was rebuilt four days ago, so that day is inside the probe window.
    const late = await storage.writeMemory("fact", "aged unindexed zebra source", { source: "test" });
    const lateMemory = (await storage.readAllMemories()).find((m) => m.frontmatter.id === late.id);
    if (!lateMemory) throw new Error("late source missing");
    const day = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10);
    const agedPath = path.join(memoryDir, "facts", day, `${late.id}.md`);
    await mkdir(path.dirname(agedPath), { recursive: true });
    await rename(lateMemory.path, agedPath);
    storage.invalidateMemoryCachesForTiers(["hot", "cold"]);
    setRebuiltAt(memoryDir, new Date(Date.now() - 4 * 86_400_000).toISOString());
    await nodeFor(memoryDir, "aged-node", [late.id], "aged unindexed zebra source");
    const aged = await search(memoryDir, "aged unindexed zebra source");
    assert.equal(aged.some((r) => r.node.nodeId === "aged-node" && r.node.sourceMemoryIds?.includes(late.id)), true);

    // Path traversal ids and question-queue ids are dropped, exactly as the
    // corpus scan drops them.
    const questionId = await storage.writeQuestion("queued zebra question", "ctx", 1);
    await nodeFor(memoryDir, "unsafe-node", ["../facts/" + base.id, "../../etc/passwd"], "unsafe traversal cue");
    await nodeFor(memoryDir, "question-node", [questionId], "queue leak cue");
    setRebuiltAt(memoryDir, new Date().toISOString());
    for (const query of ["unsafe traversal cue", "queue leak cue"]) {
      assert.deepEqual(await search(memoryDir, query), [], query);
    }
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("an index older than a week falls back to the corpus scan and still finds an aged source", async () => {
  const memoryDir = await mkdtemp(path.join(tmpdir(), "remnic-harmonic-index-"));
  try {
    const storage = new StorageManager(memoryDir);
    await storage.ensureDirectories();
    const source = await storage.writeMemory("fact", "stale index quokka source", { source: "test" });
    await rebuildMemoryProjection({ memoryDir, storage, dryRun: false });
    setRebuiltAt(memoryDir, new Date(Date.now() - 30 * 86_400_000).toISOString());
    await nodeFor(memoryDir, "stale-node", [source.id], "stale index quokka source");
    const results = await search(memoryDir, "stale index quokka source");
    assert.equal(results.some((r) => r.node.nodeId === "stale-node"), true);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});
