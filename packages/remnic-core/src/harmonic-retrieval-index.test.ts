import assert from "node:assert/strict";
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
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

