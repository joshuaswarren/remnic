import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { recordAbstractionNode } from "./abstraction-nodes.js";
import { readProjectedHarmonicGraph } from "./harmonic-retrieval.js";
import { rebuildMemoryProjection } from "./maintenance/rebuild-memory-projection.js";
import { StorageManager } from "./storage.js";
import { readUnresolvedHarmonicSources } from "./harmonic-source-lookup.js";
import { bumpMemoryCorpusVersionForDir } from "./memory-corpus-version.js";

async function seed(memoryDir: string) {
  const storage = new StorageManager(memoryDir);
  await storage.ensureDirectories();
  const real = await storage.writeMemory("fact", "real harmonic source", { source: "test" });
  await recordAbstractionNode({ memoryDir, node: {
    schemaVersion: 1, nodeId: "source-lookup", recordedAt: new Date().toISOString(),
    sessionKey: "agent:test", kind: "topic", abstractionLevel: "meso",
    title: "source lookup", summary: "source lookup",
    sourceMemoryIds: [real.id, "missing-source", "hot-import", "cold/import"],
  } });
  await rebuildMemoryProjection({ memoryDir, storage, dryRun: false });
  return { storage, real };
}

async function importFile(memoryDir: string, tier: string, name: string, id: string) {
  const dir = path.join(memoryDir, tier, "facts", "2000-01-01");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, name),
    `---\nid: ${id}\ncategory: fact\ncreated: 2000-01-01T00:00:00.000Z\nupdated: 2000-01-01T00:00:00.000Z\nsource: test\nconfidence: 0.8\nconfidenceTier: implied\ntags: []\n---\n\nImported ${id} body.\n`);
}

test("old-dated imports with non-id filenames resolve in both tiers without a corpus parse (#3188)", async (t) => {
  const memoryDir = await mkdtemp(path.join(tmpdir(), "remnic-harmonic-lookup-"));
  try {
    const { real } = await seed(memoryDir);
    await importFile(memoryDir, "", "unrelated-hot-name.md", "hot-import");
    await importFile(memoryDir, "cold", "unrelated-cold-name.md", "cold/import");
    let scans = 0;
    t.mock.method(StorageManager.prototype, "readAllMemories", async () => { scans += 1; return []; });
    const graph = await readProjectedHarmonicGraph({ memoryDir, anchorsEnabled: false });
    assert.deepEqual(graph.nodes[0]?.sourceMemoryIds?.slice().sort(), [real.id, "hot-import", "cold/import"].sort());
    assert.equal(scans, 0, "unprojected legacy ids must not force the full frontmatter corpus scan");
  } finally {
    t.mock.restoreAll();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("confirmed missing sources survive a fresh process without another path walk (#3188)", async () => {
  const memoryDir = await mkdtemp(path.join(tmpdir(), "remnic-harmonic-durable-"));
  try {
    const { real } = await seed(memoryDir);
    const graph = await readProjectedHarmonicGraph({ memoryDir, anchorsEnabled: false });
    assert.deepEqual(graph.nodes[0]?.sourceMemoryIds, [real.id]);
    const script = `
      import { StorageManager } from ${JSON.stringify(new URL("./storage.ts", import.meta.url).href)};
      import { readProjectedHarmonicGraph } from ${JSON.stringify(new URL("./harmonic-retrieval.ts", import.meta.url).href)};
      StorageManager.prototype.collectActiveMemoryPaths = async () => { throw new Error("unexpected hot walk after restart"); };
      StorageManager.prototype.collectColdMemoryPaths = async () => { throw new Error("unexpected cold walk after restart"); };
      StorageManager.prototype.readAllMemories = async () => { throw new Error("unexpected corpus scan after restart"); };
      const graph = await readProjectedHarmonicGraph({ memoryDir: ${JSON.stringify(memoryDir)}, anchorsEnabled: false });
      if (graph.nodes[0]?.sourceMemoryIds?.join() !== ${JSON.stringify(real.id)}) throw new Error("source lost after restart");
    `;
    await promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script]);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

for (const invalidation of ["ttl", "rebuiltAt", "corpusVersion"]) {
  test(`durable misses invalidate on ${invalidation} without losing an imported source (#3188)`, async () => {
    const memoryDir = await mkdtemp(path.join(tmpdir(), "remnic-harmonic-epoch-"));
    try {
      const { storage } = await seed(memoryDir);
      const nowMs = Date.now();
      const options = {
        storage, rootReal: await realpath(memoryDir), rebuiltAt: new Date(nowMs).toISOString(),
        nowMs, sourceMemoryIds: ["restored-id"],
      };
      assert.equal((await readUnresolvedHarmonicSources(options)).size, 0);
      await importFile(memoryDir, "", "not-the-source-id.md", "restored-id");
      assert.equal((await readUnresolvedHarmonicSources(options)).size, 0, "the existing ten-minute miss window is preserved");
      if (invalidation === "ttl") options.nowMs += 10 * 60_000;
      if (invalidation === "rebuiltAt") options.rebuiltAt = new Date(nowMs + 1).toISOString();
      if (invalidation === "corpusVersion") bumpMemoryCorpusVersionForDir(memoryDir);
      const restored = await readUnresolvedHarmonicSources(options);
      assert.equal(restored.get("restored-id")?.content.trim(), "Imported restored-id body.");
    } finally {
      await rm(memoryDir, { recursive: true, force: true });
    }
  });
}

test("harmonic cold walk receives cancellation and cannot publish a partial absence cache (#3188)", async (t) => {
  const memoryDir = await mkdtemp(path.join(tmpdir(), "remnic-harmonic-cancel-"));
  try {
    await seed(memoryDir);
    await importFile(memoryDir, "cold", "cold-import.md", "cold/import");
    const controller = new AbortController();
    const original = StorageManager.prototype.collectColdMemoryPaths;
    t.mock.method(StorageManager.prototype, "collectColdMemoryPaths", function (
      this: StorageManager, options?: Parameters<StorageManager["collectColdMemoryPaths"]>[0],
    ) {
      assert.equal(options?.abortSignal, controller.signal);
      controller.abort();
      return original.call(this, options);
    });
    await assert.rejects(
      () => readProjectedHarmonicGraph({ memoryDir, anchorsEnabled: false, abortSignal: controller.signal }),
      { name: "AbortError" },
    );
    await assert.rejects(() => readFile(path.join(memoryDir, "state/harmonic-source-paths.json")), { code: "ENOENT" });
    t.mock.restoreAll();
    const graph = await readProjectedHarmonicGraph({ memoryDir, anchorsEnabled: false });
    assert.equal(graph.nodes[0]?.sourceMemoryIds?.includes("cold/import"), true);
  } finally {
    t.mock.restoreAll();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("an unreadable/unwritable path cache never suppresses an imported source (#3188)", async () => {
  const memoryDir = await mkdtemp(path.join(tmpdir(), "remnic-harmonic-cache-errors-"));
  try {
    await seed(memoryDir);
    await importFile(memoryDir, "", "not-id.md", "hot-import");
    const cachePath = path.join(memoryDir, "state/harmonic-source-paths.json");
    await mkdir(cachePath);
    const graph = await readProjectedHarmonicGraph({ memoryDir, anchorsEnabled: false });
    assert.equal(graph.nodes[0]?.sourceMemoryIds?.includes("hot-import"), true);
    await rm(cachePath, { recursive: true });
    await writeFile(cachePath, "{broken");
    const recovered = await readProjectedHarmonicGraph({ memoryDir, anchorsEnabled: false });
    assert.equal(recovered.nodes[0]?.sourceMemoryIds?.includes("hot-import"), true);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("an unresolved opaque id keeps the old scan candidate set for an edited projected file (#3188)", async () => {
  const memoryDir = await mkdtemp(path.join(tmpdir(), "remnic-harmonic-opaque-"));
  try {
    const { storage, real } = await seed(memoryDir);
    const memory = await storage.getMemoryById(real.id);
    assert.ok(memory);
    await writeFile(memory.path,
      `---\nid: cold/import\ncategory: fact\ncreated: 2000-01-01T00:00:00.000Z\nupdated: 2000-01-01T00:00:00.000Z\nsource: test\nconfidence: 0.8\nconfidenceTier: implied\ntags: []\n---\n\nEdited projected legacy source.\n`);
    const graph = await readProjectedHarmonicGraph({ memoryDir, anchorsEnabled: false });
    assert.deepEqual(graph.nodes[0]?.sourceMemoryIds, ["cold/import"]);
    assert.equal(graph.nodes[0]?.summary, "Edited projected legacy source.");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("cached import paths reread source status without another walk (#3188)", async (t) => {
  const memoryDir = await mkdtemp(path.join(tmpdir(), "remnic-harmonic-fresh-status-"));
  try {
    const { real } = await seed(memoryDir);
    await importFile(memoryDir, "", "not-id.md", "hot-import");
    const first = await readProjectedHarmonicGraph({ memoryDir, anchorsEnabled: false });
    assert.equal(first.nodes[0]?.sourceMemoryIds?.includes("hot-import"), true);
    const filePath = path.join(memoryDir, "facts/2000-01-01/not-id.md");
    await writeFile(filePath, (await readFile(filePath, "utf8")).replace("category: fact", "category: fact\nstatus: quarantined"));
    t.mock.method(StorageManager.prototype, "collectActiveMemoryPaths", async () => { throw new Error("unexpected hot walk"); });
    t.mock.method(StorageManager.prototype, "collectColdMemoryPaths", async () => { throw new Error("unexpected cold walk"); });
    t.mock.method(StorageManager.prototype, "readAllMemories", async () => { throw new Error("unexpected corpus parse"); });
    const second = await readProjectedHarmonicGraph({ memoryDir, anchorsEnabled: false });
    assert.deepEqual(second.nodes[0]?.sourceMemoryIds, [real.id]);
  } finally {
    t.mock.restoreAll();
    await rm(memoryDir, { recursive: true, force: true });
  }
});
