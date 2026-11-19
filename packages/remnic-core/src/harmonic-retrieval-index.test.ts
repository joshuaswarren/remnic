import assert from "node:assert/strict";
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { getMemoryProjectionPath } from "./memory-projection-store.js";
import { openBetterSqlite3 } from "./runtime/better-sqlite.js";
import { recordAbstractionNode } from "./abstraction-nodes.js";
import { recordCueAnchor } from "./cue-anchors.js";
import { harmonicSearchIndexStats, readProjectedHarmonicGraph, searchHarmonicRetrieval, type HarmonicRetrievalResult } from "./harmonic-retrieval.js";
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

// Counts hot-corpus scans while `run` executes.
async function countCorpusScans<T>(run: () => Promise<T>): Promise<{ value: T; scans: number }> {
  const original = StorageManager.prototype.readAllMemories;
  let scans = 0;
  StorageManager.prototype.readAllMemories = function (this: StorageManager, ...args: unknown[]) {
    scans += 1;
    return Reflect.apply(original, this, args);
  };
  try {
    return { value: await run(), scans };
  } finally {
    StorageManager.prototype.readAllMemories = original;
  }
}

test("a scoped or pre-complete projection is not trusted and falls back to the corpus scan", async () => {
  const memoryDir = await mkdtemp(path.join(tmpdir(), "remnic-harmonic-index-"));
  try {
    const storage = new StorageManager(memoryDir);
    await storage.ensureDirectories();
    const source = await storage.writeMemory("fact", "scoped rebuild okapi source", { source: "test" });
    await nodeFor(memoryDir, "okapi-node", [source.id], "scoped rebuild okapi source");

    // First projection built with a scope that excludes the source: rebuiltAt is
    // fresh but memory_current does not hold it.
    await rebuildMemoryProjection({ memoryDir, storage, dryRun: false, updatedBefore: "2000-01-01T00:00:00.000Z" });
    const scoped = await countCorpusScans(() => search(memoryDir, "scoped rebuild okapi source"));
    assert.equal(scoped.value.some((r) => r.node.nodeId === "okapi-node"), true, "out-of-scope source must still resolve");
    assert.equal(scoped.scans > 0, true, "an incomplete index must fall back to the scan");

    // An unscoped rebuild is complete and takes the index path.
    await rebuildMemoryProjection({ memoryDir, storage, dryRun: false });
    const full = await countCorpusScans(() => search(memoryDir, "scoped rebuild okapi source"));
    assert.equal(full.value.some((r) => r.node.nodeId === "okapi-node"), true);
    assert.equal(full.scans, 0);

    // A projection written before the `complete` flag existed has no such key.
    const db = openBetterSqlite3(getMemoryProjectionPath(memoryDir));
    try {
      db.prepare("DELETE FROM meta WHERE key = 'complete'").run();
    } finally {
      db.close();
    }
    const legacy = await countCorpusScans(() => search(memoryDir, "scoped rebuild okapi source"));
    assert.equal(legacy.value.some((r) => r.node.nodeId === "okapi-node"), true);
    assert.equal(legacy.scans > 0, true, "a projection without the flag must fall back");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("a legacy memory whose id contains a slash still resolves through the projection", async () => {
  const memoryDir = await mkdtemp(path.join(tmpdir(), "remnic-harmonic-index-"));
  try {
    const storage = new StorageManager(memoryDir);
    await storage.ensureDirectories();
    const slashId = "legacy/slash-id";
    const day = new Date().toISOString().slice(0, 10);
    await mkdir(path.join(memoryDir, "facts", day), { recursive: true });
    await writeFile(
      path.join(memoryDir, "facts", day, "legacy-slash-file.md"),
      `---\nid: ${slashId}\ncategory: fact\ncreated: ${new Date().toISOString()}\nupdated: ${new Date().toISOString()}\nsource: test\nconfidence: 0.8\nconfidenceTier: implied\ntags: ["alpha"]\n---\n\nslash identifier narwhal source\n`,
      "utf-8",
    );
    await nodeFor(memoryDir, "slash-node", [slashId], "slash identifier narwhal source");
    const before = await search(memoryDir, "slash identifier narwhal source");
    assert.equal(before.some((r) => r.node.nodeId === "slash-node"), true, "the corpus scan keys by frontmatter id");
    await rebuildMemoryProjection({ memoryDir, storage, dryRun: false });
    const indexed = await countCorpusScans(() => search(memoryDir, "slash identifier narwhal source"));
    assert.deepEqual(indexed.value, before);
    assert.equal(indexed.scans, 0);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

function memoryFileText(id: string, body: string): string {
  const now = new Date().toISOString();
  return `---\nid: ${id}\ncategory: fact\ncreated: ${now}\nupdated: ${now}\nsource: test\nconfidence: 0.8\nconfidenceTier: implied\ntags: ["alpha"]\n---\n\n${body}\n`;
}

test("direct probes reject symlinked and artifact sources like the scan, and an old-dated post-rebuild source is still found", async () => {
  const memoryDir = await mkdtemp(path.join(tmpdir(), "remnic-harmonic-index-"));
  const outsideDir = await mkdtemp(path.join(tmpdir(), "remnic-harmonic-outside-"));
  try {
    const storage = new StorageManager(memoryDir);
    await storage.ensureDirectories();
    const day = new Date().toISOString().slice(0, 10);
    await mkdir(path.join(memoryDir, "facts", day), { recursive: true });
    await mkdir(path.join(memoryDir, "artifacts", day), { recursive: true });

    // A source file outside the namespace root, reachable through a symlink.
    await writeFile(path.join(outsideDir, "outside-sym.md"), memoryFileText("outside-sym", "symlink escape cue body"), "utf-8");
    await symlink(path.join(outsideDir, "outside-sym.md"), path.join(memoryDir, "facts", day, "outside-sym.md"));
    // An artifact: outside the recall surface the corpus scan reads.
    await writeFile(path.join(memoryDir, "artifacts", day, "art-1.md"), memoryFileText("art-1", "artifact leak cue body"), "utf-8");
    await nodeFor(memoryDir, "symlink-node", ["outside-sym"], "symlink escape cue");
    await nodeFor(memoryDir, "artifact-node", ["art-1"], "artifact leak cue");

    const scanSymlink = await search(memoryDir, "symlink escape cue");
    const scanArtifact = await search(memoryDir, "artifact leak cue");
    assert.deepEqual(scanSymlink, [], "the corpus scan must not follow the symlink");
    assert.deepEqual(scanArtifact, [], "the corpus scan must not read artifacts");

    await rebuildMemoryProjection({ memoryDir, storage, dryRun: false });
    const indexed = await countCorpusScans(async () => ({
      symlink: await search(memoryDir, "symlink escape cue"),
      artifact: await search(memoryDir, "artifact leak cue"),
    }));
    assert.deepEqual(indexed.value.symlink, scanSymlink);
    assert.deepEqual(indexed.value.artifact, scanArtifact);
    assert.equal(indexed.scans, 0, "this was the index path, not a fallback");

    // Written after the rebuild but filed under a date far outside the probe
    // window (an import that keeps its original created date).
    await mkdir(path.join(memoryDir, "facts", "2020-01-01"), { recursive: true });
    await writeFile(
      path.join(memoryDir, "facts", "2020-01-01", "imported-old.md"),
      memoryFileText("imported-old", "imported older marmot cue body"),
      "utf-8",
    );
    storage.invalidateMemoryCachesForTiers(["hot", "cold"]);
    await nodeFor(memoryDir, "imported-node", ["imported-old"], "imported older marmot cue");
    const old = await search(memoryDir, "imported older marmot cue");
    assert.equal(old.some((r) => r.node.nodeId === "imported-node" && r.node.sourceMemoryIds?.includes("imported-old")), true);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
  }
});

test("a dangling source id costs one path walk, then is remembered as absent", async () => {
  const memoryDir = await mkdtemp(path.join(tmpdir(), "remnic-harmonic-index-"));
  try {
    const storage = new StorageManager(memoryDir);
    await storage.ensureDirectories();
    const real = await storage.writeMemory("fact", "real source wombat body", { source: "test" });
    await nodeFor(memoryDir, "real-node", [real.id, "dangling-id"], "real source wombat");
    await rebuildMemoryProjection({ memoryDir, storage, dryRun: false });

    const original = StorageManager.prototype.collectActiveMemoryPaths;
    let walks = 0;
    StorageManager.prototype.collectActiveMemoryPaths = function (this: StorageManager, ...args: unknown[]) {
      walks += 1;
      return Reflect.apply(original, this, args);
    };
    try {
      const first = await search(memoryDir, "real source wombat");
      assert.equal(first.some((r) => r.node.nodeId === "real-node" && r.node.sourceMemoryIds?.includes(real.id)), true);
      assert.equal(walks, 1, "the unresolved id is looked up by one walk");
      await search(memoryDir, "real source wombat");
      assert.equal(walks, 1, "a confirmed-absent id is not walked again within the TTL");
    } finally {
      StorageManager.prototype.collectActiveMemoryPaths = original;
    }
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});


test("a separator-containing id written after the rebuild is still placed, by the scan", async () => {
  const memoryDir = await mkdtemp(path.join(tmpdir(), "remnic-harmonic-index-"));
  try {
    const storage = new StorageManager(memoryDir);
    await storage.ensureDirectories();
    await rebuildMemoryProjection({ memoryDir, storage, dryRun: false });
    const day = new Date().toISOString().slice(0, 10);
    await mkdir(path.join(memoryDir, "facts", day), { recursive: true });
    await writeFile(
      path.join(memoryDir, "facts", day, "capsule-import-file.md"),
      memoryFileText("capsule/import-id", "capsule import ocelot source body"),
      "utf-8",
    );
    storage.invalidateMemoryCachesForTiers(["hot", "cold"]);
    await nodeFor(memoryDir, "capsule-node", ["capsule/import-id"], "capsule import ocelot source");
    const results = await search(memoryDir, "capsule import ocelot source");
    assert.equal(results.some((r) => r.node.nodeId === "capsule-node" && r.node.sourceMemoryIds?.includes("capsule/import-id")), true);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("the cold path walk honors an aborted signal", async () => {
  const memoryDir = await mkdtemp(path.join(tmpdir(), "remnic-harmonic-index-"));
  try {
    const storage = new StorageManager(memoryDir);
    await storage.ensureDirectories();
    await mkdir(path.join(memoryDir, "cold", "facts", "2020-01-01"), { recursive: true });
    await writeFile(
      path.join(memoryDir, "cold", "facts", "2020-01-01", "cold-1.md"),
      memoryFileText("cold-1", "cold walk abort body"),
      "utf-8",
    );
    assert.equal((await storage.collectColdMemoryPaths()).length, 1);
    await assert.rejects(() => storage.collectColdMemoryPaths({ abortSignal: AbortSignal.abort() }));
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("indexed source resolution overlaps per-source file reads (#3450)", async (t) => {
  const memoryDir = await mkdtemp(path.join(tmpdir(), "remnic-harmonic-concurrency-"));
  try {
    const storage = new StorageManager(memoryDir);
    await storage.ensureDirectories();
    const sourceMemoryIds: string[] = [];
    for (let i = 0; i < 40; i++) {
      const { id } = await storage.writeMemory("fact", `concurrent source payload ${i}`, { source: "test" });
      sourceMemoryIds.push(id);
    }
    await recordAbstractionNode({
      memoryDir,
      node: {
        schemaVersion: 1,
        nodeId: "many-sources",
        recordedAt: "2026-11-19T00:00:00.000Z",
        sessionKey: "agent:index",
        kind: "topic",
        abstractionLevel: "meso",
        title: "stored title",
        summary: "stored summary",
        sourceMemoryIds,
      },
    });
    await rebuildMemoryProjection({ memoryDir, storage, dryRun: false });

    // Every recalled build resolves thousands of sources; when each read is
    // awaited in turn the build takes seconds on real disks (w91: ~19 s inside
    // harmonicRetrieval). With a small per-read delay, serial code keeps
    // maxInFlight at 1 while batched reads overlap.
    const originalRead = StorageManager.prototype.readMemoryByPath;
    let inFlight = 0;
    let maxInFlight = 0;
    t.mock.method(StorageManager.prototype, "readMemoryByPath", async function (
      this: StorageManager,
      ...args: Parameters<StorageManager["readMemoryByPath"]>
    ) {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      try {
        return await originalRead.call(this, ...args);
      } finally {
        inFlight -= 1;
      }
    });
    const graph = await readProjectedHarmonicGraph({ memoryDir, anchorsEnabled: false });
    assert.equal(maxInFlight > 1, true, `source reads ran one at a time (max in-flight ${maxInFlight})`);
    assert.deepEqual(graph.nodes[0]?.sourceMemoryIds?.slice().sort(), sourceMemoryIds.slice().sort());
  } finally {
    t.mock.restoreAll();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("cached graph searches share one scoring index across recalls (#3450)", async (t) => {
  const memoryDir = await mkdtemp(path.join(tmpdir(), "remnic-harmonic-index-reuse-"));
  try {
    const storage = new StorageManager(memoryDir);
    await storage.ensureDirectories();
    const a = await storage.writeMemory("fact", "shared index source payload", { source: "test" });
    await recordAbstractionNode({
      memoryDir,
      node: {
        schemaVersion: 1,
        nodeId: "shared-index-node",
        recordedAt: "2026-11-19T00:00:00.000Z",
        sessionKey: "agent:index",
        kind: "topic",
        abstractionLevel: "meso",
        title: "shared index source payload",
        summary: "shared index summary",
        sourceMemoryIds: [a.id],
      },
    });
    await rebuildMemoryProjection({ memoryDir, storage, dryRun: false });

    const run = () =>
      searchHarmonicRetrieval({
        memoryDir,
        query: "shared index source payload",
        maxResults: 5,
        anchorsEnabled: false,
        useGraphCache: true,
      });
    const first = await run();
    const buildsBefore = harmonicSearchIndexStats.builds;
    const second = await run();
    const third = await run();
    assert.equal(
      harmonicSearchIndexStats.builds,
      buildsBefore,
      "repeat searches over a cached graph must reuse the same scoring index (re-tokenizing every recall costs ~750 ms on a real corpus)",
    );
    assert.deepEqual(third, second);
    assert.deepEqual(second.map((r) => r.node.nodeId), first.map((r) => r.node.nodeId));
  } finally {
    t.mock.restoreAll();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("anchors sharing an anchorId across types keep their own cues (#3450)", async (t) => {
  const memoryDir = await mkdtemp(path.join(tmpdir(), "remnic-harmonic-dup-anchor-"));
  try {
    const storage = new StorageManager(memoryDir);
    await storage.ensureDirectories();
    const alpha = await storage.writeMemory("fact", "alpha source body", { source: "test" });
    const beta = await storage.writeMemory("fact", "beta source body", { source: "test" });
    await recordAbstractionNode({
      memoryDir,
      node: {
        schemaVersion: 1,
        nodeId: "dup-anchor-alpha",
        recordedAt: "2026-11-19T00:00:00.000Z",
        sessionKey: "agent:index",
        kind: "topic",
        abstractionLevel: "meso",
        title: "unmatched alpha title",
        summary: "unmatched alpha summary",
        sourceMemoryIds: [alpha.id],
      },
    });
    await recordAbstractionNode({
      memoryDir,
      node: {
        schemaVersion: 1,
        nodeId: "dup-anchor-beta",
        recordedAt: "2026-11-19T00:00:00.000Z",
        sessionKey: "agent:index",
        kind: "topic",
        abstractionLevel: "meso",
        title: "unmatched beta title",
        summary: "unmatched beta summary",
        sourceMemoryIds: [beta.id],
      },
    });
    // The anchor store dedups by (anchorType, anchorId), so one anchorId can
    // legitimately recur under a second type — each keeps its own cue.
    await recordCueAnchor({
      memoryDir,
      anchor: {
        schemaVersion: 1,
        anchorId: "shared-anchor-id",
        anchorType: "entity",
        anchorValue: "zebra wobble",
        normalizedCue: "zebra wobble",
        recordedAt: "2026-11-19T00:00:00.000Z",
        sessionKey: "agent:index",
        nodeRefs: ["dup-anchor-alpha"],
        sourceMemoryIdsByNodeRef: { "dup-anchor-alpha": [alpha.id] },
      },
    });
    await recordCueAnchor({
      memoryDir,
      anchor: {
        schemaVersion: 1,
        anchorId: "shared-anchor-id",
        anchorType: "file",
        anchorValue: "quartz tumble",
        normalizedCue: "quartz tumble",
        recordedAt: "2026-11-19T00:00:00.000Z",
        sessionKey: "agent:index",
        nodeRefs: ["dup-anchor-beta"],
        sourceMemoryIdsByNodeRef: { "dup-anchor-beta": [beta.id] },
      },
    });
    await rebuildMemoryProjection({ memoryDir, storage, dryRun: false });

    const zebra = await searchHarmonicRetrieval({
      memoryDir,
      query: "zebra wobble",
      maxResults: 5,
      anchorsEnabled: true,
      useGraphCache: true,
    });
    assert.deepEqual(zebra.map((r) => r.node.nodeId), ["dup-anchor-alpha"]);
    const quartz = await searchHarmonicRetrieval({
      memoryDir,
      query: "quartz tumble",
      maxResults: 5,
      anchorsEnabled: true,
      useGraphCache: true,
    });
    assert.deepEqual(quartz.map((r) => r.node.nodeId), ["dup-anchor-beta"]);
  } finally {
    t.mock.restoreAll();
    await rm(memoryDir, { recursive: true, force: true });
  }
});
