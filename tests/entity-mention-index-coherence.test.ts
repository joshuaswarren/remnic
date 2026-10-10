import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { chmodSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { parseConfig } from "@remnic/core/config";
import { buildEntityRecallSection } from "@remnic/core/entity-retrieval";
import { StorageManager } from "@remnic/core/storage";
import type { PluginConfig } from "@remnic/core/types";
import { entityMentionEpoch } from "../packages/remnic-core/src/entity-mention-epoch.js";
import {
  dropEntityMentionIndexCache,
  entityMentionFullRebuildsStarted,
  entityMentionIndexScopeKeys,
  entityMentionScopeKey,
  resolveEntityMentionIndex,
  settleEntityMentionIndex,
} from "../packages/remnic-core/src/entity-mention-index-cache.js";

async function buildHarness(prefix: string) {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), `${prefix}-memory-`));
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), `${prefix}-workspace-`));
  const config = parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir,
    qmdEnabled: false,
    sharedContextEnabled: false,
    hourlySummariesEnabled: false,
    transcriptEnabled: true,
    nativeKnowledge: {
      enabled: false,
      includeFiles: [],
      maxChunkChars: 400,
      maxResults: 5,
      maxChars: 1600,
      stateDir: "state/native-knowledge",
      obsidianVaults: [],
    },
  });
  const storage = new StorageManager(memoryDir, config.entitySchemas);
  await storage.ensureDirectories();
  return { memoryDir, workspaceDir, config, storage };
}

function scopeKeyFor(dir: string): string {
  const resolved = path.resolve(dir);
  const keys = entityMentionIndexScopeKeys().filter((key) => key.includes(resolved));
  assert.equal(keys.length, 1);
  return keys[0] ?? "";
}

async function recall(config: PluginConfig, storage: StorageManager, query: string) {
  return buildEntityRecallSection({
    config,
    storage,
    query,
    recentTurns: 6,
    maxHints: 2,
    maxSupportingFacts: 6,
    maxRelatedEntities: 3,
    maxChars: 2400,
    transcriptEntries: [],
  });
}

async function removeHarness(memoryDir: string, workspaceDir: string) {
  await Promise.all([
    rm(memoryDir, { recursive: true, force: true }),
    rm(workspaceDir, { recursive: true, force: true }),
  ]);
}

test("a wrapped frontmatter writer does not recurse on metadata-only patches", async () => {
  const { memoryDir, workspaceDir, storage } = await buildHarness("engram-entity-epoch-wrap");
  const original = storage.writeMemoryFrontmatter.bind(storage);
  let calls = 0;
  try {
    const written = await storage.writeMemory(
      "fact",
      "Cedar Lattice tracks harbor lights from the pier.",
      {},
    );
    const epoch = entityMentionEpoch.current(storage.dir);
    storage.writeMemoryFrontmatter = async (memory, patch, lifecycle) => {
      calls += 1;
      if (calls > 2) throw new Error(`writeMemoryFrontmatter reentered ${calls} times`);
      return original(memory, patch, lifecycle);
    };
    const wrote = await storage.writeMemoryFrontmatter(written.memory, {
      heatScore: 0.42,
      decayScore: 0.07,
      lastValidatedAt: "2026-10-10T00:00:00.000Z",
    });
    assert.equal(wrote, true);
    assert.equal(calls, 1);
    assert.equal(entityMentionEpoch.current(storage.dir), epoch);
  } finally {
    storage.writeMemoryFrontmatter = original;
    await removeHarness(memoryDir, workspaceDir);
  }
});

test("metadata-only frontmatter does not rebuild the entity mention index", async () => {
  const { memoryDir, workspaceDir, config, storage } = await buildHarness("engram-entity-epoch-metadata");
  const originalReadAllMemories = storage.readAllMemories.bind(storage);
  let memoryReads = 0;
  try {
    const canonical = await storage.writeEntity("Cedar Lattice", "project", [
      "Cedar Lattice tracks harbor lights.",
    ]);
    const written = await storage.writeMemory(
      "fact",
      "Cedar Lattice tracks harbor lights from the pier.",
      { entityRef: canonical },
    );
    const first = await recall(config, storage, "Who is Cedar Lattice?");
    assert.match(first ?? "", /Cedar Lattice/);
    const scopeKey = scopeKeyFor(storage.dir);
    const rebuilds = entityMentionFullRebuildsStarted(scopeKey);
    const epoch = entityMentionEpoch.current(storage.dir);
    const corpus = storage.getMemoryCorpusVersion();
    storage.readAllMemories = async (...args) => {
      memoryReads += 1;
      return originalReadAllMemories(...args);
    };
    const wrote = await storage.writeMemoryFrontmatter(written.memory, {
      heatScore: 0.42,
      decayScore: 0.07,
      lastValidatedAt: "2026-10-10T00:00:00.000Z",
      lifecycleState: "active",
    });
    assert.equal(wrote, true);
    assert.equal(entityMentionEpoch.current(storage.dir), epoch);
    assert.notEqual(storage.getMemoryCorpusVersion(), corpus);
    const second = await recall(config, storage, "Who is Cedar Lattice?");
    assert.match(second ?? "", /Cedar Lattice/);
    assert.equal(memoryReads, 0);
    assert.equal(entityMentionFullRebuildsStarted(scopeKey), rebuilds);
  } finally {
    storage.readAllMemories = originalReadAllMemories;
    await removeHarness(memoryDir, workspaceDir);
  }
});

test("a new entity file is retrievable on the next recall without a fact scan", async () => {
  const { memoryDir, workspaceDir, config, storage } = await buildHarness("engram-entity-epoch-new-entity");
  const originalReadAllMemories = storage.readAllMemories.bind(storage);
  const originalReadAllEntityFiles = storage.readAllEntityFiles.bind(storage);
  let memoryReads = 0;
  let entityReads = 0;
  try {
    await storage.writeEntity("Cedar Lattice", "project", ["Cedar Lattice tracks harbor lights."]);
    assert.match((await recall(config, storage, "Who is Cedar Lattice?")) ?? "", /Cedar Lattice/);
    storage.readAllMemories = async (...args) => {
      memoryReads += 1;
      return originalReadAllMemories(...args);
    };
    storage.readAllEntityFiles = async (...args) => {
      entityReads += 1;
      return originalReadAllEntityFiles(...args);
    };
    await storage.writeEntity("Quartz Beacon", "project", ["Quartz Beacon marks the north channel."]);
    const section = await recall(config, storage, "Who is Quartz Beacon?");
    assert.match(section ?? "", /Quartz Beacon/);
    assert.match(section ?? "", /north channel/);
    assert.equal(memoryReads, 0);
    assert.equal(entityReads > 0, true);
  } finally {
    storage.readAllMemories = originalReadAllMemories;
    storage.readAllEntityFiles = originalReadAllEntityFiles;
    await removeHarness(memoryDir, workspaceDir);
  }
});

test("after a write sequence the settled index matches a full rebuild", async () => {
  const { memoryDir, workspaceDir, config, storage } = await buildHarness("engram-entity-epoch-settle");
  const originalReadAllMemories = storage.readAllMemories.bind(storage);
  let releaseScan: () => void = () => {};
  let scanGate = new Promise<void>((resolve) => {
    releaseScan = resolve;
  });
  try {
    const canonical = await storage.writeEntity("Cedar Lattice", "project", [
      "Cedar Lattice tracks harbor lights.",
    ]);
    const written = await storage.writeMemory(
      "fact",
      "Cedar Lattice tracks harbor lights from the pier.",
      { entityRef: canonical },
    );
    assert.match((await recall(config, storage, "Who is Cedar Lattice?")) ?? "", /Cedar Lattice/);
    const scopeKey = scopeKeyFor(storage.dir);
    storage.readAllMemories = async (...args) => {
      await scanGate;
      return originalReadAllMemories(...args);
    };
    const epochBefore = entityMentionEpoch.current(storage.dir);
    await storage.writeMemoryFrontmatter(written.memory, {
      heatScore: 0.11,
      decayScore: 0.02,
      lastValidatedAt: "2026-10-10T01:00:00.000Z",
      lifecycleState: "validated",
    });
    assert.equal(entityMentionEpoch.current(storage.dir), epochBefore);
    await storage.writeMemory(
      "fact",
      "Cedar Lattice keeps the marker phrase violet-harbor-441.",
      { entityRef: canonical },
    );
    assert.notEqual(entityMentionEpoch.current(storage.dir), epochBefore);
    await storage.addEntityRelationship(canonical, { target: "North Pier", label: "supports" });
    const pending = recall(config, storage, "Who is Cedar Lattice?");
    const raced = await Promise.race([
      pending.then((section) => ({ kind: "done" as const, section })),
      new Promise<{ kind: "timeout"; section?: undefined }>((resolve) => {
        setTimeout(() => resolve({ kind: "timeout" }), 1000);
      }),
    ]);
    assert.equal(raced.kind, "done");
    assert.match(raced.section ?? "", /North Pier/);
    assert.doesNotMatch(raced.section ?? "", /violet-harbor-441/);
    releaseScan();
    await settleEntityMentionIndex(scopeKey);
    const settled = await recall(config, storage, "Who is Cedar Lattice?");
    assert.match(settled ?? "", /violet-harbor-441/);
    assert.match(settled ?? "", /North Pier/);
    dropEntityMentionIndexCache(scopeKey);
    const rebuilt = await recall(config, storage, "Who is Cedar Lattice?");
    assert.equal(settled, rebuilt);
  } finally {
    releaseScan();
    storage.readAllMemories = originalReadAllMemories;
    await removeHarness(memoryDir, workspaceDir);
  }
});

const quietIdentity = { mentionEpoch: "0", entityMutation: "0" };

test("a newer mention-index revision evicts the previous one for the same store", async () => {
  const { memoryDir, workspaceDir } = await buildHarness("engram-entity-epoch-family");
  try {
    const storage = {
      dir: memoryDir,
      hotCacheKeyId: () => "key-a",
      entityAliases: { cedar: "project-cedar" },
      getEntityMutationVersion: () => 0,
    };
    const revised = { ...storage, hotCacheKeyId: () => "key-b" };
    const otherNamespace = entityMentionScopeKey(["other"], [storage], "rev-1");
    const first = entityMentionScopeKey(["home"], [storage], "rev-1");
    const second = entityMentionScopeKey(["home"], [revised], "rev-2");
    const build = async (label: string) => ({ label });
    await resolveEntityMentionIndex({
      scopeKey: first,
      currentIdentity: () => quietIdentity,
      buildFull: () => build("first"),
      rebuildEntities: async (previous) => previous,
    });
    await resolveEntityMentionIndex({
      scopeKey: otherNamespace,
      currentIdentity: () => quietIdentity,
      buildFull: () => build("other"),
      rebuildEntities: async (previous) => previous,
    });
    await resolveEntityMentionIndex({
      scopeKey: second,
      currentIdentity: () => quietIdentity,
      buildFull: () => build("second"),
      rebuildEntities: async (previous) => previous,
    });
    const keys = entityMentionIndexScopeKeys().filter((key) => key.includes(memoryDir));
    assert.deepEqual(keys.sort(), [otherNamespace, second].sort());
  } finally {
    dropEntityMentionIndexCache();
    await removeHarness(memoryDir, workspaceDir);
  }
});

test("clearAllStaticCaches drops the entity mention index", async () => {
  const { memoryDir, workspaceDir } = await buildHarness("engram-entity-epoch-reset");
  try {
    const scopeKey = entityMentionScopeKey(undefined, [{ dir: memoryDir }], "rev");
    let builds = 0;
    const load = () =>
      resolveEntityMentionIndex({
        scopeKey,
        currentIdentity: () => quietIdentity,
        buildFull: async () => {
          builds += 1;
          return { builds };
        },
        rebuildEntities: async (previous) => previous,
      });
    assert.deepEqual(await load(), { builds: 1 });
    assert.deepEqual(await load(), { builds: 1 });
    StorageManager.clearAllStaticCaches();
    assert.deepEqual(entityMentionIndexScopeKeys().filter((key) => key.includes(memoryDir)), []);
    assert.deepEqual(await load(), { builds: 2 });
  } finally {
    dropEntityMentionIndexCache();
    await removeHarness(memoryDir, workspaceDir);
  }
});

test("a failed epoch append still advances while the sentinel file is readable", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "engram-entity-epoch-readonly-"));
  const file = path.join(dir, "state", ".entity-mention-epoch.log");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, "xxxxx");
  chmodSync(file, 0o444);
  try {
    assert.equal(entityMentionEpoch.current(dir), 5);
    entityMentionEpoch.bump(dir);
    assert.equal(entityMentionEpoch.current(dir), 6);
    entityMentionEpoch.bump(dir);
    assert.equal(entityMentionEpoch.current(dir), 7);
    chmodSync(file, 0o644);
    entityMentionEpoch.bump(dir);
    assert.equal(entityMentionEpoch.current(dir), 8);
  } finally {
    chmodSync(file, 0o644);
    await rm(dir, { recursive: true, force: true });
  }
});

test("access-count flushes do not move the mention epoch", async () => {
  const { memoryDir, workspaceDir, storage } = await buildHarness("engram-entity-epoch-access");
  try {
    const written = await storage.writeMemory("fact", "Cedar Lattice tracks harbor lights from the pier.", {});
    const epoch = entityMentionEpoch.current(storage.dir);
    const corpus = storage.getMemoryCorpusVersion();
    const updated = await storage.flushAccessTracking([
      {
        memoryId: written.id,
        newCount: 4,
        lastAccessed: "2026-10-10T00:00:00.000Z",
      },
    ]);
    assert.equal(updated, 1);
    assert.equal(entityMentionEpoch.current(storage.dir), epoch);
    assert.ok(storage.getMemoryCorpusVersion() > corpus);
  } finally {
    await removeHarness(memoryDir, workspaceDir);
  }
});

test("an entity write during rebuild is retried on the next recall", async () => {
  const { memoryDir, workspaceDir } = await buildHarness("engram-entity-epoch-overlap");
  try {
    let mutation = 0;
    const identity = () => ({ mentionEpoch: "1", entityMutation: String(mutation) });
    const scopeKey = entityMentionScopeKey(undefined, [{ dir: memoryDir }], "rev");
    let rebuilds = 0;
    await resolveEntityMentionIndex({
      scopeKey,
      currentIdentity: identity,
      buildFull: async () => ({ generation: 0 }),
      rebuildEntities: async (previous) => previous,
    });
    mutation = 1;
    await resolveEntityMentionIndex({
      scopeKey,
      currentIdentity: identity,
      buildFull: async () => {
        throw new Error("entity overlap must not full-scan");
      },
      rebuildEntities: async (previous) => {
        rebuilds += 1;
        mutation = 2;
        return { ...previous, generation: 1 };
      },
    });
    assert.equal(rebuilds, 1);
    await resolveEntityMentionIndex({
      scopeKey,
      currentIdentity: identity,
      buildFull: async () => {
        throw new Error("entity overlap must not full-scan");
      },
      rebuildEntities: async (previous) => {
        rebuilds += 1;
        return { ...previous, generation: 2 };
      },
    });
    assert.equal(rebuilds, 2);
  } finally {
    dropEntityMentionIndexCache();
    await removeHarness(memoryDir, workspaceDir);
  }
});
