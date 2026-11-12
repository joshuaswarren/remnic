import assert from "node:assert/strict";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { recordAbstractionNode, upsertAbstractionNodes, type AbstractionNode } from "./abstraction-nodes.js";
import { pruneOrphanCueAnchors, recordCueAnchor, upsertCueAnchors, type CueAnchor } from "./cue-anchors.js";
import {
  clearHarmonicGraphCache,
  harmonicGraphCacheStats,
  type ProjectedHarmonicGraph,
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

// Recall waits for the graph build, so a cache miss costs every recall that lands on it. Production: a
// 2106 node, 9174 anchor graph rebuilt in 5 s standalone, 7 s inside the daemon, and 17 to 32 s when two
// recalls overlapped and each ran its own build.
test("concurrent reads on a cold cache share one build", async () => {
  await withDir(async (memoryDir, storage) => {
    const memory = await storage.writeMemory("fact", "theta shared fact", { source: "test" });
    await recordAbstractionNode({ memoryDir, node: node("n1", "theta shared fact", [memory.id]) });
    const before = { ...harmonicGraphCacheStats };
    const [a, b, c] = await Promise.all([read(memoryDir), read(memoryDir), read(memoryDir)]);
    assert.equal(harmonicGraphCacheStats.misses, before.misses + 1, "one build, not one per caller");
    assert.equal(a, b);
    assert.equal(b, c);
  });
});

test("a caller that aborts leaves the shared build for the others", async () => {
  await withDir(async (memoryDir, storage) => {
    const memory = await storage.writeMemory("fact", "iota abort fact", { source: "test" });
    await recordAbstractionNode({ memoryDir, node: node("n1", "iota abort fact", [memory.id]) });
    const controller = new AbortController();
    const aborted = readProjectedHarmonicGraph({ memoryDir, anchorsEnabled: true, useCache: true, abortSignal: controller.signal });
    const other = read(memoryDir);
    controller.abort();
    await assert.rejects(aborted);
    assert.equal((await other).nodes.length, 1);
  });
});

// Unreadable node store: a file where the nodes directory belongs is not ENOENT, so the strict listing throws
// (a corrupt node file would not: readAbstractionNodes skips those on purpose).
async function breakNodeStore(memoryDir: string) {
  const nodesDir = path.join(memoryDir, "state", "abstraction-nodes", "nodes");
  const parked = `${nodesDir}.parked`;
  await rename(nodesDir, parked);
  await writeFile(nodesDir, "not a directory");
  return async () => {
    await rm(nodesDir, { force: true });
    await rename(parked, nodesDir);
  };
}

test("callers that joined a failing build all reject, and the next read retries and succeeds", async () => {
  await withDir(async (memoryDir, storage) => {
    const memory = await storage.writeMemory("fact", "mu retry fact", { source: "test" });
    await recordAbstractionNode({ memoryDir, node: node("n1", "mu retry fact", [memory.id]) });
    const restore = await breakNodeStore(memoryDir);
    const missesBefore = harmonicGraphCacheStats.misses;
    const outcomes = await Promise.allSettled([read(memoryDir), read(memoryDir), read(memoryDir)]);
    assert.deepEqual(outcomes.map((outcome) => outcome.status), ["rejected", "rejected", "rejected"]);
    assert.equal(harmonicGraphCacheStats.misses, missesBefore + 1, "the three callers shared one failing build");
    await restore();
    assert.equal((await read(memoryDir)).nodes.length, 1);
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

interface BuildHold {
  release: () => void;
  reached: Promise<void>;
  calls: number;
  signal?: AbortSignal;
}

/**
 * Hold the first build inside its source-memory read so a second read can land while it runs. The held call
 * records the build's own abort signal; builds started after it are not held.
 */
function holdFirstBuild(t: TestContext): BuildHold {
  const original = StorageManager.prototype.readAllMemories;
  let release = () => {};
  const opened = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reachedHold = () => {};
  const reached = new Promise<void>((resolve) => {
    reachedHold = resolve;
  });
  const hold: BuildHold = { release, reached, calls: 0 };
  t.mock.method(StorageManager.prototype, "readAllMemories", async function (this: StorageManager, ...args: Parameters<typeof original>) {
    hold.calls++;
    if (hold.calls === 1) {
      hold.signal = args[0]?.abortSignal;
      reachedHold();
      await opened;
    }
    return original.apply(this, args);
  });
  return hold;
}

/** Fail the test instead of hanging when a promise that must settle does not. */
function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error(`${what} did not settle in ${ms} ms`)), ms).unref()),
  ]);
}

test("the shared build aborts once every joined caller has aborted, and the next read starts a fresh one", async (t) => {
  await withDir(async (memoryDir, storage) => {
    const memory = await storage.writeMemory("fact", "nu abort fact", { source: "test" });
    await recordAbstractionNode({ memoryDir, node: node("n1", "nu abort fact", [memory.id]) });
    const hold = holdFirstBuild(t);
    const first = new AbortController();
    const second = new AbortController();
    const options = { memoryDir, anchorsEnabled: true, useCache: true };
    const a = readProjectedHarmonicGraph({ ...options, abortSignal: first.signal });
    const b = readProjectedHarmonicGraph({ ...options, abortSignal: second.signal });
    await within(hold.reached, 2000, "build start");
    assert.equal(hold.calls, 1, "one build for both callers");
    first.abort();
    await assert.rejects(within(a, 1000, "first caller"), { name: "AbortError" });
    assert.equal(hold.signal?.aborted, false, "one caller is still waiting, so the build keeps running");
    second.abort();
    await assert.rejects(within(b, 1000, "second caller"), { name: "AbortError" });
    assert.equal(hold.signal?.aborted, true, "no caller is left, so the build is cancelled");
    const missesBefore = harmonicGraphCacheStats.misses;
    const next = read(memoryDir);
    assert.equal(harmonicGraphCacheStats.misses, missesBefore + 1, "the next read does not join the cancelled build");
    assert.equal((await within(next, 5000, "next read")).nodes.length, 1);
    hold.release();
  });
});

test("a read after a stamp change does not join the build that started on the old stamp", async (t) => {
  await withDir(async (memoryDir, storage) => {
    const first = await storage.writeMemory("fact", "xi stamp fact one", { source: "test" });
    await recordAbstractionNode({ memoryDir, node: node("n1", "xi stamp fact one", [first.id]) });
    const hold = holdFirstBuild(t);
    const missesBefore = harmonicGraphCacheStats.misses;
    const stale = read(memoryDir);
    await within(hold.reached, 2000, "old build start");
    const second = await storage.writeMemory("fact", "xi stamp fact two", { source: "test" });
    await recordAbstractionNode({ memoryDir, node: node("n2", "xi stamp fact two", [second.id]) });
    try {
      const fresh = read(memoryDir);
      assert.equal(harmonicGraphCacheStats.misses, missesBefore + 2, "the second read started its own build");
      assert.equal((await within(fresh, 5000, "fresh read")).nodes.length, 2, "and it sees the write");
    } finally {
      hold.release();
    }
    await stale;
  });
});

test("a joined caller that aborts rejects at once, while the build it joined is still running", async (t) => {
  await withDir(async (memoryDir, storage) => {
    const memory = await storage.writeMemory("fact", "omicron join fact", { source: "test" });
    await recordAbstractionNode({ memoryDir, node: node("n1", "omicron join fact", [memory.id]) });
    const hold = holdFirstBuild(t);
    const owner = read(memoryDir);
    const controller = new AbortController();
    const joiner = readProjectedHarmonicGraph({ memoryDir, anchorsEnabled: true, useCache: true, abortSignal: controller.signal });
    controller.abort();
    try {
      await assert.rejects(within(joiner, 1000, "aborted joiner"), { name: "AbortError" });
    } finally {
      hold.release();
    }
    assert.equal((await owner).nodes.length, 1, "the owner is not affected");
  });
});

test("clearing the cache drops a running build: the next read starts its own and the old build stores nothing", async (t) => {
  await withDir(async (memoryDir, storage) => {
    const memory = await storage.writeMemory("fact", "pi clear fact", { source: "test" });
    await recordAbstractionNode({ memoryDir, node: node("n1", "pi clear fact", [memory.id]) });
    const hold = holdFirstBuild(t);
    const missesBefore = harmonicGraphCacheStats.misses;
    const old = read(memoryDir);
    await within(hold.reached, 2000, "old build start");
    clearHarmonicGraphCache();
    let kept: ProjectedHarmonicGraph;
    try {
      const fresh = read(memoryDir);
      assert.equal(harmonicGraphCacheStats.misses, missesBefore + 2, "the read after the clear did not join the old build");
      kept = await within(fresh, 5000, "fresh read");
    } finally {
      hold.release();
    }
    await old;
    assert.equal(await read(memoryDir), kept, "the finished old build did not overwrite the newer cache entry");
  });
});
