// #3188: park only harmonic's source read and observe real QMD publication.

import assert from "node:assert/strict";
import path from "node:path";
import type { TestContext } from "node:test";
import test from "node:test";

import { recordAbstractionNode } from "./abstraction-nodes.js";
import { parseConfig } from "./config.js";
import { rebuildMemoryProjection } from "./maintenance/rebuild-memory-projection.js";
import { Orchestrator } from "./orchestrator.js";
import {
  RecallSectionCoordinator,
  type RecallSectionAppendOptions,
  type RecallSectionBuckets,
} from "./orchestration/recall-section-coordinator.js";
import { getRecallTimings } from "./recall-timings.js";
import type { RecallInternalCoordinator } from "./orchestration/recall-internal.js";
import { StorageManager } from "./storage.js";
import type { SearchBackend } from "./search/port.js";
import { cleanupDir, eventually, mkTempMemoryDir } from "./testing/orchestrator-lite.js";
import type { MemoryFile, PluginConfig, QmdSearchResult } from "./types.js";

const RECALL_PROMPT = "how does the atlas source lookup behave?";

/**
 * Complete typed SearchBackend stub (no casts): answers availability and
 * returns one settled QMD candidate from `search`; every other read surface
 * is empty. Mirrors the recall-hardening backend-stub shape.
 */
function settledQmdBackend(result: QmdSearchResult): SearchBackend {
  return {
    async probe() {
      return true;
    },
    isAvailable() {
      return true;
    },
    debugStatus() {
      return "backend=settled-qmd-stub";
    },
    async search() {
      return [result];
    },
    async searchGlobal() {
      return [];
    },
    async bm25Search() {
      return [];
    },
    async vectorSearch() {
      return [];
    },
    async hybridSearch() {
      return [];
    },
    async update() {},
    async updateCollection() {},
    async embed() {},
    async embedCollection() {},
    async ensureCollection() {
      return "present";
    },
  };
}

interface OrderingHarness {
  memoryDir: string;
  orchestrator: Orchestrator;
  config: PluginConfig;
  qmdMemory: MemoryFile;
  harmonicSource: MemoryFile;
  /** Releases the parked harmonic source read (idempotent). */
  releaseHarmonicRead: () => void;
  /** Section ids in append order, via the section coordinator prototype. */
  appendedSectionIds: string[];
  /** How often the harmonic source read was asked for (and parked). */
  harmonicReadCalls: { count: number };
  recall: () => Promise<string>;
}

/**
 * Seed two active memories — one returned as the settled QMD candidate, one
 * projected into a real abstraction-node store row — then boot the real
 * orchestrator over them. The projection rebuild keeps the harmonic read on
 * the indexed exact-path branch, so intercepting that one
 * `StorageManager.readMemoryByPath` call parks harmonic and nothing else.
 */
async function makeOrderingHarness(
  t: TestContext,
  mode: "park" | "fail",
): Promise<OrderingHarness> {
  const memoryDir = await mkTempMemoryDir("recall-harmonic-order-");
  const storage = new StorageManager(memoryDir);
  await storage.ensureDirectories();

  const { memory: qmdMemory } = await storage.writeMemory(
    "fact",
    "the atlas qmd sentinel confirms deployment cadence",
    { source: "test" },
  );
  const { memory: harmonicSource } = await storage.writeMemory(
    "fact",
    "atlas harmonic source lookup body",
    { source: "test" },
  );
  await recordAbstractionNode({
    memoryDir,
    node: {
      schemaVersion: 1,
      nodeId: "ordering-under-qmd",
      recordedAt: new Date().toISOString(),
      sessionKey: "agent:test",
      kind: "topic",
      abstractionLevel: "meso",
      title: "atlas source lookup",
      summary: "atlas source lookup",
      sourceMemoryIds: [harmonicSource.frontmatter.id],
    },
  });
  await rebuildMemoryProjection({ memoryDir, storage, dryRun: false });

  // Defaults only — the ordering fix must not move any budget, and the
  // default candidate/namespace sets stay untouched.
  const config = parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
    qmdEnabled: true,
    embeddingFallbackEnabled: false,
    recallPlannerEnabled: false,
    sharedContextEnabled: false,
    harmonicRetrievalEnabled: true,
    queryAwareIndexingEnabled: false,
    parallelRetrievalEnabled: false,
    initGateTimeoutMs: 1000,
  });

  const orchestrator = new Orchestrator(config);
  orchestrator.qmd = settledQmdBackend({
    docid: qmdMemory.frontmatter.id,
    path: qmdMemory.path,
    score: 0.9,
    snippet: qmdMemory.content,
  });

  const appendedSectionIds: string[] = [];
  const originalAppend = RecallSectionCoordinator.prototype.appendRecallSection;
  t.mock.method(
    RecallSectionCoordinator.prototype,
    "appendRecallSection",
    function recordAppendedSection(
      this: RecallSectionCoordinator,
      sectionBuckets: RecallSectionBuckets,
      sectionId: string,
      content: string,
      options?: RecallSectionAppendOptions,
    ): boolean {
      appendedSectionIds.push(sectionId);
      return originalAppend.call(this, sectionBuckets, sectionId, content, options);
    },
  );

  const harmonicGate = Promise.withResolvers<void>();
  const harmonicReadCalls = { count: 0 };
  const originalRead = StorageManager.prototype.readMemoryByPath;
  const harmonicSourcePath = path.resolve(harmonicSource.path);
  t.mock.method(
    StorageManager.prototype,
    "readMemoryByPath",
    function interceptHarmonicSourceRead(
      this: StorageManager,
      filePath: string,
    ): Promise<MemoryFile | null> {
      if (path.resolve(filePath) !== harmonicSourcePath) {
        return originalRead.call(this, filePath);
      }
      if (mode === "fail") {
        return Promise.reject(new Error("synthetic harmonic source read failure"));
      }
      harmonicReadCalls.count += 1;
      return harmonicGate.promise.then(() => originalRead.call(this, filePath));
    },
  );

  // Invoke the existing private delegate without booting background services.
  const recallSeam = orchestrator as unknown as Pick<RecallInternalCoordinator, "recallInternal">
    & Pick<RecallSectionCoordinator, "isRecallSectionEnabled">;
  t.mock.method(recallSeam, "isRecallSectionEnabled", (id: string) =>
    id === "memories" || id === "harmonic-retrieval");

  return {
    memoryDir,
    orchestrator,
    config,
    qmdMemory,
    harmonicSource,
    releaseHarmonicRead: () => harmonicGate.resolve(),
    appendedSectionIds,
    harmonicReadCalls,
    recall: () => recallSeam.recallInternal(RECALL_PROMPT, "agent:test", { mode: "full" }),
  };
}

test("settled QMD publishes while the harmonic read is still parked; harmonic renders after release", async (t) => {
  const harness = await makeOrderingHarness(t, "park");
  const { memoryDir, orchestrator, config, appendedSectionIds, harmonicReadCalls } =
    harness;
  let recallPromise: Promise<string> | undefined;
  try {
    // The move must not touch any deadline: pin the configured defaults.
    assert.equal(config.recallOuterTimeoutMs, 75_000);
    assert.equal(config.recallCoreDeadlineMs, 75_000);
    assert.equal(config.recallEnrichmentDeadlineMs, 60_000);

    recallPromise = harness.recall();

    // The harmonic read starts during phase 1 and is now parked.
    await eventually(
      async () => (harmonicReadCalls.count > 0 ? true : null),
      "harmonic source read reached the parked seam",
    );

    // The fix: the settled QMD candidate is formatted and published while
    // harmonic is still parked. Under the pre-fix order the assembly blocked
    // on harmonic first, so this probe could never succeed.
    await eventually(
      async () => (appendedSectionIds.includes("memories") ? true : null),
      "QMD memories section published while harmonic is parked",
    );
    assert.equal(
      appendedSectionIds.includes("harmonic-retrieval"),
      false,
      "harmonic must not append before its read is released",
    );

    harness.releaseHarmonicRead();
    const context = await recallPromise;

    // Harmonic still publishes afterward, with its candidate content, and
    // QMD publication strictly precedes the harmonic append.
    assert.ok(
      appendedSectionIds.includes("harmonic-retrieval"),
      "harmonic section must append after the read is released",
    );
    assert.ok(
      appendedSectionIds.lastIndexOf("memories") <
        appendedSectionIds.indexOf("harmonic-retrieval"),
      `QMD publication must precede the harmonic append, got: ${appendedSectionIds.join(",")}`,
    );
    assert.ok(context.includes(harness.qmdMemory.content), "QMD candidate must render");
    assert.ok(
      context.includes("## Harmonic Retrieval"),
      `harmonic section must render, got: ${context.slice(0, 600)}`,
    );
    assert.ok(
      context.includes(harness.harmonicSource.content),
      "harmonic candidate content must render",
    );

    // Budget parity: harmonic completed inside the untouched shared
    // enrichment budget. A cancelled/timed-out harmonic drops its timing
    // entry (timeout strings do not sanitize to numbers), so a numeric
    // harmonicRetrieval timing proves the move neither shortened nor spent
    // the budget ahead of QMD.
    const record = getRecallTimings(config).find(
      (candidate) => candidate.timingsMs.harmonicRetrieval !== undefined,
    );
    assert.ok(record, "harmonic must complete within the shared enrichment budget");
    assert.ok(record.timingsMs.qmd !== undefined, "QMD timing must be recorded");
  } finally {
    harness.releaseHarmonicRead();
    await recallPromise?.catch(() => undefined);
    await orchestrator.destroy();
    await cleanupDir(memoryDir);
  }
});

test("a failed harmonic source read degrades without taking QMD publication down", async (t) => {
  const harness = await makeOrderingHarness(t, "fail");
  const { memoryDir, orchestrator, qmdMemory, appendedSectionIds } = harness;
  try {
    const context = await harness.recall();

    assert.ok(
      appendedSectionIds.includes("memories"),
      "QMD must still publish when the harmonic read fails",
    );
    assert.equal(
      appendedSectionIds.includes("harmonic-retrieval"),
      false,
      "a failed harmonic read must append no harmonic section",
    );
    assert.ok(context.includes(qmdMemory.content), "QMD candidate must render");
    assert.ok(
      !context.includes("## Harmonic Retrieval"),
      "no harmonic section may render after a failed read",
    );
  } finally {
    harness.releaseHarmonicRead();
    await orchestrator.destroy();
    await cleanupDir(memoryDir);
  }
});
