
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { recordAbstractionNode, type AbstractionNode } from "./abstraction-nodes.js";
import { bumpMemoryCorpusVersionForDir } from "./memory-corpus-version.js";
import {
  clearHarmonicGraphCache,
  HarmonicGraphWaitDeadlineError,
  readProjectedHarmonicGraph,
  searchHarmonicRetrieval,
  setHarmonicGraphBuildTestHooks,
  settleHarmonicGraphBuilds,
} from "./harmonic-retrieval.js";
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
  const memoryDir = await mkdtemp(path.join(tmpdir(), "remnic-harmonic-wait-"));
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

const read = (memoryDir: string, waitBudgetMs?: number) =>
  readProjectedHarmonicGraph({ memoryDir, anchorsEnabled: true, useCache: true, waitBudgetMs });

test("a caller past the wait budget leaves; the build finishes and warms the cache", async (t: TestContext) => {
  await withDir(async (memoryDir, storage) => {
    const memory = await storage.writeMemory("fact", "bounded wait fact", { source: "test" });
    await recordAbstractionNode({ memoryDir, node: node("n1", "bounded wait fact", [memory.id]) });
    await read(memoryDir);
    bumpMemoryCorpusVersionForDir(memoryDir);

    setHarmonicGraphBuildTestHooks({ buildDelayMs: 250 });
    t.after(() => setHarmonicGraphBuildTestHooks(null));

    const started = Date.now();
    await assert.rejects(read(memoryDir, 50), HarmonicGraphWaitDeadlineError);
    assert.ok(Date.now() - started < 200, `caller returned after ${Date.now() - started}ms`);

    await settleHarmonicGraphBuilds();
    const graph = await read(memoryDir, 50);
    assert.equal(graph.nodes.length, 1);
  });
});

test("a caller abort still cancels an abandoned build", async (t: TestContext) => {
  await withDir(async (memoryDir, storage) => {
    const memory = await storage.writeMemory("fact", "abort kills build", { source: "test" });
    await recordAbstractionNode({ memoryDir, node: node("n1", "abort kills build", [memory.id]) });
    bumpMemoryCorpusVersionForDir(memoryDir);

    setHarmonicGraphBuildTestHooks({ buildDelayMs: 250 });
    t.after(() => setHarmonicGraphBuildTestHooks(null));

    const controller = new AbortController();
    const pending = readProjectedHarmonicGraph({
      memoryDir,
      anchorsEnabled: true,
      useCache: true,
      waitBudgetMs: 5_000,
      abortSignal: controller.signal,
    });
    controller.abort();
    await assert.rejects(pending, (err: Error) => err.name === "AbortError");
    const started = Date.now();
    await read(memoryDir, 5_000);
    assert.ok(Date.now() - started >= 200);
  });
});

test("searchHarmonicRetrieval fails open past the wait budget", async (t: TestContext) => {
  await withDir(async (memoryDir, storage) => {
    const memory = await storage.writeMemory("fact", "recall fails open", { source: "test" });
    await recordAbstractionNode({ memoryDir, node: node("n1", "recall fails open", [memory.id]) });
    bumpMemoryCorpusVersionForDir(memoryDir);

    setHarmonicGraphBuildTestHooks({ buildDelayMs: 250 });
    t.after(() => setHarmonicGraphBuildTestHooks(null));

    await assert.rejects(
      searchHarmonicRetrieval({
        memoryDir,
        query: "recall fails open",
        maxResults: 3,
        anchorsEnabled: true,
        useGraphCache: true,
        waitBudgetMs: 50,
      }),
      HarmonicGraphWaitDeadlineError,
    );

    await settleHarmonicGraphBuilds();
    const results = await searchHarmonicRetrieval({
      memoryDir,
      query: "recall fails open",
      maxResults: 3,
      anchorsEnabled: true,
      useGraphCache: true,
      waitBudgetMs: 50,
    });
    assert.deepEqual(results.map((result) => result.node.nodeId), ["n1"]);
  });
});
