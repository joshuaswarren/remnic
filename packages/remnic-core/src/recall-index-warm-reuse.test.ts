import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { mock } from "node:test";

import { EngramAccessService } from "./access-service.js";
import { parseConfig } from "./config.js";
import type { CorpusReadOptions } from "./corpus-read-cancellation.js";
import {
  dropEntityMentionIndexCache,
  entityMentionFullRebuildsStarted,
  entityMentionIndexScopeKeys,
} from "./entity-mention-index-cache.js";
import { entityMentionEpoch } from "./entity-mention-epoch.js";
import { buildEntityRecallSection } from "./entity-retrieval.js";
import { Orchestrator } from "./orchestrator.js";
import { getRecallTimings } from "./recall-timings.js";
import { StorageManager } from "./storage.js";
import { cleanupDir } from "./testing/orchestrator-lite.js";
import type { MemoryFile } from "./types.js";

test.afterEach(() => {
  mock.restoreAll();
});

function makeConfig(memoryDir: string) {
  return parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
    qmdEnabled: false,
    embeddingFallbackEnabled: false,
    recallPlannerEnabled: false,
    sharedContextEnabled: false,
    initGateTimeoutMs: 1000,
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Controlled slow-read gate (issue #3529): every full-corpus index read pays a
 * fixed 2.2 s delay, so a warm recall that re-reads either index provably
 * exceeds the 2.0 s bound on its leg — timing stops being the signal and the
 * call counters below are the verdict.
 */
const SLOW_READ_MS = 2200;
const WARM_LEG_BOUND_MS = 2000;

function gateCorpusReads(t: test.TestContext) {
  const counts = { entityFiles: 0, memories: 0, persistedIndex: 0 };
  const origEntityFiles = StorageManager.prototype.readAllEntityFiles;
  t.mock.method(
    StorageManager.prototype,
    "readAllEntityFiles",
    async function (this: StorageManager, ...args: Parameters<StorageManager["readAllEntityFiles"]>) {
      counts.entityFiles += 1;
      await sleep(SLOW_READ_MS);
      return origEntityFiles.apply(this, args);
    },
  );
  // The public readAllMemories() fronts a version-keyed hot cache (#1902):
  // recall assembly calls it on every recall and legitimately reuses the
  // cached corpus. The reread boundary the issue pins is the disk scan
  // underneath, so the gate sits on _readAllMemoriesFromDisk — a hot-cache
  // hit never reaches it, a real rescan always does.
  const diskScanDescriptor = Object.getOwnPropertyDescriptor(
    StorageManager.prototype,
    "_readAllMemoriesFromDisk",
  );
  if (!diskScanDescriptor) {
    throw new Error("_readAllMemoriesFromDisk missing on StorageManager.prototype");
  }
  // SAFETY: the private disk-scan method exists on the prototype — the
  // descriptor check above verified it; the assertion names its signature.
  const origMemoriesDisk = diskScanDescriptor.value as (
    this: StorageManager,
    options?: CorpusReadOptions,
  ) => Promise<MemoryFile[]>;
  Reflect.set(
    StorageManager.prototype,
    "_readAllMemoriesFromDisk",
    async function (this: StorageManager, options?: CorpusReadOptions): Promise<MemoryFile[]> {
      counts.memories += 1;
      await sleep(SLOW_READ_MS);
      return origMemoriesDisk.call(this, options);
    },
  );
  t.after(() => {
    Reflect.set(StorageManager.prototype, "_readAllMemoriesFromDisk", origMemoriesDisk);
  });
  // The persisted mention index is read by a module-level helper (no
  // prototype seam, and fs/promises is frozen under ESM). Its parse step is
  // the observable boundary: a warm recall that rereads the index JSON must
  // parse a document carrying the index's version + entity fields.
  const origParse = JSON.parse;
  t.mock.method(JSON, "parse", (text: string, reviver?: Parameters<typeof JSON.parse>[1]) => {
    if (text.includes('"entityStatusVersion"') && text.includes('"entities"')) {
      counts.persistedIndex += 1;
    }
    return origParse(text, reviver);
  });
  return counts;
}

/** Extract a `## Header` section's text up to the next `## ` header. */
function section(context: string, header: string): string | null {
  const start = context.indexOf(`## ${header}`);
  if (start === -1) return null;
  const next = context.indexOf("\n## ", start + 1);
  return context.slice(start, next === -1 ? undefined : next).trim();
}

test("warm second recall reuses the knowledge and entity indexes with zero corpus rereads (#3529)", async (t) => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-recall-reuse-"));
  try {
    const seed = new StorageManager(memoryDir);
    const entityRef = await seed.writeEntity("Alice", "person", [
      "Alice leads the platform launch review.",
    ]);
    await seed.writeMemory("fact", "Alice leads the platform launch review.", {
      source: "test",
      entityRef,
    });

    const config = makeConfig(memoryDir);
    const orchestrator = new Orchestrator(config);
    const service = new EngramAccessService(orchestrator);
    const counts = gateCorpusReads(t);

    const cold = await service.recall({
      query: "What do you know about Alice?",
      sessionKey: "ki-reuse:session",
    });
    const coldCounts = { ...counts };
    assert.ok(
      coldCounts.entityFiles + coldCounts.memories + coldCounts.persistedIndex > 0,
      "sanity: the cold recall did corpus work the gate could observe",
    );
    const coldKi = section(cold.context, "Knowledge Index");
    const coldEntity = section(cold.context, "entity_answer_hints");
    assert.ok(coldKi?.includes("Alice"), "cold knowledge index carries the seeded entity");
    assert.ok(coldEntity, "cold entity hints section is present");

    const warm = await service.recall({
      query: "What do you know about Alice?",
      sessionKey: "ki-reuse:session",
    });

    // Equivalent index sections: the warm recall must serve the same index
    // content, not a degraded or empty variant.
    assert.equal(section(warm.context, "Knowledge Index"), coldKi);
    assert.equal(section(warm.context, "entity_answer_hints"), coldEntity);

    // Inside the reuse window neither index leg may re-read or rebuild its
    // full corpus view: KI must not rescan entity files, entity retrieval
    // must not rescan entity files, memories, or the persisted index.
    assert.equal(counts.entityFiles, coldCounts.entityFiles, "entity corpus reread on warm recall");
    assert.equal(counts.memories, coldCounts.memories, "memory corpus reread on warm recall");
    assert.equal(counts.persistedIndex, coldCounts.persistedIndex, "persisted mention index reread on warm recall");

    const warmRecord = getRecallTimings(config)[0];
    assert.ok(warmRecord, "warm recall timing record exists");
    const kiMs = warmRecord.timingsMs["ki"];
    const entityMs = warmRecord.timingsMs["entityRetrieval"];
    assert.ok(kiMs !== undefined && kiMs < WARM_LEG_BOUND_MS, `warm KI leg ${kiMs}ms must stay under ${WARM_LEG_BOUND_MS}ms`);
    assert.ok(entityMs !== undefined && entityMs < WARM_LEG_BOUND_MS, `warm entity leg ${entityMs}ms must stay under ${WARM_LEG_BOUND_MS}ms`);
  } finally {
    await cleanupDir(memoryDir);
  }
});

test("knowledge index cache serves different explicit limits from one corpus read (#3529)", async (t) => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-ki-limits-"));
  try {
    const seed = new StorageManager(memoryDir);
    for (const name of ["Alice", "Bob", "Carol"]) {
      await seed.writeEntity(name, "person", [`${name} fact`]);
    }
    const storage = new StorageManager(memoryDir);
    const config = makeConfig(memoryDir);
    const counts = gateCorpusReads(t);

    const wide = await storage.buildKnowledgeIndex(config, { maxEntities: 3, maxChars: 4000 });
    const narrow = await storage.buildKnowledgeIndex(config, { maxEntities: 1, maxChars: 4000 });

    // The explicit-limit path must reuse the built index rather than
    // bypassing the cache to reread the entity corpus.
    assert.equal(counts.entityFiles, 1, "explicit-limit calls must share one corpus read");
    assert.ok(narrow.result.length > 0 && narrow.result.length < wide.result.length);
    assert.equal((wide.result.match(/\| .+ \|/g) ?? []).length >= (narrow.result.match(/\| .+ \|/g) ?? []).length, true);
    // And the default-limits call reuses the same corpus view too.
    const defaults = await storage.buildKnowledgeIndex(config);
    assert.equal(counts.entityFiles, 1, "default-limits call must also reuse the index");
    assert.ok(defaults.result.includes("Alice") || defaults.result.includes("Bob") || defaults.result.includes("Carol"));
  } finally {
    await cleanupDir(memoryDir);
  }
});

test("a real entity mutation still invalidates the warm indexes (#3529)", async (t) => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-recall-mutate-"));
  try {
    const config = makeConfig(memoryDir);
    const orchestrator = new Orchestrator(config);
    const service = new EngramAccessService(orchestrator);
    const entityRef = await orchestrator.storage.writeEntity("Alice", "person", ["Alice fact"]);
    await orchestrator.storage.writeMemory("fact", "Alice leads the launch review.", {
      source: "test",
      entityRef,
    });
    const counts = gateCorpusReads(t);

    await service.recall({ query: "What do you know about Alice?", sessionKey: "ki-mutate:session" });
    const baseline = { ...counts };

    // A mutation through the orchestrator's own storage: the same write path
    // the daemon's remember/observe surface takes.
    await orchestrator.storage.writeEntity("Bob", "person", ["Bob owns the rollout"]);

    const afterMutation = await service.recall({
      query: "What do you know about Alice?",
      sessionKey: "ki-mutate:session",
    });
    assert.ok(
      counts.entityFiles > baseline.entityFiles,
      "an entity mutation must force a fresh corpus read for the index",
    );
    assert.ok(
      section(afterMutation.context, "Knowledge Index")?.includes("Bob"),
      "post-mutation recall sees the new entity",
    );
  } finally {
    await cleanupDir(memoryDir);
  }
});

test("a scoped no-match recall still reconciles a drifted mention epoch (#3529)", async () => {
  const defaultDir = await mkdtemp(path.join(os.tmpdir(), "remnic-scope-default-"));
  const teamDir = await mkdtemp(path.join(os.tmpdir(), "remnic-scope-team-"));
  try {
    const defaultStorage = new StorageManager(defaultDir);
    const teamStorage = new StorageManager(teamDir);
    const config = makeConfig(defaultDir);
    // The scoped path only engages when namespaces are enabled and a
    // namespaceStorage resolver is present.
    const scopedConfig = parseConfig({
      openaiApiKey: "sk-test",
      memoryDir: defaultDir,
      workspaceDir: path.join(defaultDir, "workspace"),
      namespacesEnabled: true,
      qmdEnabled: false,
      embeddingFallbackEnabled: false,
      recallPlannerEnabled: false,
      sharedContextEnabled: false,
      initGateTimeoutMs: 1000,
    });
    void config;
    const namespaceStorage = async (namespace: string) =>
      namespace === "team" ? teamStorage : defaultStorage;
    const recall = (query: string) =>
      buildEntityRecallSection({
        config: scopedConfig,
        storage: defaultStorage,
        namespaceStorage,
        recallNamespaces: ["default", "team"],
        query,
        recentTurns: 0,
        maxHints: 2,
        maxSupportingFacts: 2,
        maxRelatedEntities: 2,
        maxChars: 10_000,
        transcriptEntries: [],
      });

    const entityRef = await teamStorage.writeEntity("Alice", "person", [
      "Alice leads the platform launch review.",
    ]);
    await teamStorage.writeMemory("fact", "Alice leads the platform launch review.", {
      source: "test",
      entityRef,
    });

    // Cold scoped recall builds the slot once, then declines — the query
    // names no entity.
    const cold = await recall("lunch plans tomorrow?");
    const scopeKey = entityMentionIndexScopeKeys().find((key) => key.includes(teamDir));
    assert.ok(scopeKey, "a scoped mention slot must exist after the cold recall");
    assert.equal(entityMentionFullRebuildsStarted(scopeKey), 1, "one cold full build");

    // A linked memory write bumps the mention epoch while the entity
    // revision stays put — the stale-slot bypass must not skip the
    // resolver's scheduled reconciliation for that drift.
    const epochBefore = entityMentionEpoch.current(teamDir);
    await teamStorage.writeMemory("fact", "A project note links Alice's review to the roadmap.", {
      source: "test",
      entityRef,
    });
    assert.ok(
      entityMentionEpoch.current(teamDir) > epochBefore,
      "the memory write must advance the mention epoch",
    );

    const warm = await recall("lunch plans tomorrow?");
    assert.equal(warm, null, "still no entity hints for a no-match query");
    assert.equal(
      entityMentionFullRebuildsStarted(scopeKey),
      2,
      "the drifted epoch must reach the resolver so reconciliation is scheduled",
    );
  } finally {
    dropEntityMentionIndexCache();
    await cleanupDir(defaultDir);
    await cleanupDir(teamDir);
  }
});
