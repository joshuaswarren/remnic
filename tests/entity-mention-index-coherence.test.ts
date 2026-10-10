import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { chmodSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
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
  await settleEntityMentionIndex().catch(() => undefined);
  await Promise.all([
    rm(memoryDir, { recursive: true, force: true, maxRetries: 5 }),
    rm(workspaceDir, { recursive: true, force: true, maxRetries: 5 }),
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
  let releaseReads: () => void = () => {};
  try {
    await storage.writeEntity("Cedar Lattice", "project", ["Cedar Lattice tracks harbor lights."]);
    assert.match((await recall(config, storage, "Who is Cedar Lattice?")) ?? "", /Cedar Lattice/);
    const readsGate = new Promise<void>((resolve) => {
      releaseReads = resolve;
    });
    storage.readAllMemories = async (...args) => {
      memoryReads += 1;
      await readsGate;
      return originalReadAllMemories(...args);
    };
    storage.readAllEntityFiles = async (...args) => {
      entityReads += 1;
      return originalReadAllEntityFiles(...args);
    };
    await storage.writeEntity("Quartz Beacon", "project", ["Quartz Beacon marks the north channel."]);
    const section = await Promise.race([
      recall(config, storage, "Who is Quartz Beacon?"),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("recall waited on a fact scan")), 1000);
      }),
    ]);
    assert.match(section ?? "", /Quartz Beacon/);
    assert.match(section ?? "", /north channel/);
    assert.equal(entityReads > 0, true);
    for (let attempt = 0; attempt < 20 && memoryReads === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(memoryReads, 1);
    releaseReads();
  } finally {
    releaseReads();
    storage.readAllMemories = originalReadAllMemories;
    storage.readAllEntityFiles = originalReadAllEntityFiles;
    await removeHarness(memoryDir, workspaceDir);
  }
});

test("a memory written before its entity file is linked after reconcile", async () => {
  const { memoryDir, workspaceDir, config, storage } = await buildHarness("engram-entity-epoch-dangle");
  try {
    const canonical = await storage.writeEntity("Quartz Beacon", "project", [
      "Quartz Beacon marks the north channel.",
    ]);
    const entityNames = await readdir(path.join(memoryDir, "entities"));
    assert.equal(entityNames.length, 1);
    await unlink(path.join(memoryDir, "entities", entityNames[0] ?? ""));
    await storage.writeMemory("fact", "Quartz Beacon keeps the marker phrase amber-dangle-441.", {
      entityRef: canonical,
    });
    await recall(config, storage, "Who is Quartz Beacon?");
    const scopeKey = scopeKeyFor(storage.dir);
    await settleEntityMentionIndex(scopeKey);
    await storage.writeEntity("Quartz Beacon", "project", ["Quartz Beacon marks the north channel."]);
    const observed = await recall(config, storage, "Who is Quartz Beacon?");
    assert.match(observed ?? "", /Quartz Beacon/);
    await settleEntityMentionIndex(scopeKey);
    const settled = await recall(config, storage, "Who is Quartz Beacon?");
    assert.match(settled ?? "", /amber-dangle-441/);
  } finally {
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

const skipReadonlyEpoch =
  (typeof process.getuid === "function" && process.getuid() === 0) || process.platform === "win32";

test("a failed epoch append still advances while the sentinel file is readable", { skip: skipReadonlyEpoch }, async () => {
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

test("a peer append after a failed bump still moves the mention epoch", { skip: skipReadonlyEpoch }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "engram-entity-epoch-peer-"));
  const file = path.join(dir, "state", ".entity-mention-epoch.log");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, "xxxxx");
  chmodSync(file, 0o444);
  try {
    assert.equal(entityMentionEpoch.current(dir), 5);
    entityMentionEpoch.bump(dir);
    assert.equal(entityMentionEpoch.current(dir), 6);
    chmodSync(file, 0o644);
    await writeFile(file, "xxxxxx");
    assert.equal(entityMentionEpoch.current(dir), 7);
    assert.equal(entityMentionEpoch.current(dir), 7);
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

test("a frontmatter content replacement moves the mention epoch", async () => {
  const { memoryDir, workspaceDir, config, storage } = await buildHarness("engram-entity-epoch-body");
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
    const epoch = entityMentionEpoch.current(storage.dir);
    const wrote = await storage.writeMemoryFrontmatter(
      { ...written.memory, content: "Cedar Lattice keeps the marker phrase violet-edit-441." },
      { updated: "2026-10-10T02:00:00.000Z" },
    );
    assert.equal(wrote, true);
    assert.notEqual(entityMentionEpoch.current(storage.dir), epoch);
    const observed = await recall(config, storage, "Who is Cedar Lattice?");
    assert.equal(typeof observed, "string");
    await settleEntityMentionIndex(scopeKey);
    const settled = await recall(config, storage, "Who is Cedar Lattice?");
    assert.match(settled ?? "", /violet-edit-441/);
    const after = entityMentionEpoch.current(storage.dir);
    const refreshed = await storage.getMemoryById(written.id);
    assert.ok(refreshed);
    const heat = await storage.writeMemoryFrontmatter(refreshed, {
      heatScore: 0.2,
      decayScore: 0.1,
      lastValidatedAt: "2026-10-10T03:00:00.000Z",
    });
    assert.equal(heat, true);
    assert.equal(entityMentionEpoch.current(storage.dir), after);
  } finally {
    await removeHarness(memoryDir, workspaceDir);
  }
});

test("overlapping mention-epoch bumps do not chain full rebuilds", async () => {
  const { memoryDir, workspaceDir } = await buildHarness("engram-entity-epoch-chain");
  try {
    let epoch = 0;
    let builds = 0;
    const scopeKey = entityMentionScopeKey(undefined, [{ dir: memoryDir }], "chain");
    const identity = () => ({ mentionEpoch: String(epoch), entityMutation: "0" });
    const buildFull = async (): Promise<{ generation: number }> => {
      builds += 1;
      if (builds > 6) throw new Error(`rebuild chain exceeded 6 (${builds})`);
      if (builds > 1) epoch += 1;
      return { generation: builds };
    };
    const resolve = () =>
      resolveEntityMentionIndex({
        scopeKey,
        currentIdentity: identity,
        buildFull,
        rebuildEntities: async (previous) => previous,
      });
    const waitForBuilds = async (target: number) => {
      for (let attempt = 0; attempt < 40; attempt += 1) {
        if (builds >= target) return;
        await new Promise((resolveTimer) => setTimeout(resolveTimer, 5));
      }
    };
    await resolve();
    assert.equal(builds, 1);
    epoch += 1;
    await resolve();
    await waitForBuilds(3);
    assert.equal(builds, 3);
    await resolve();
    await waitForBuilds(5);
    assert.equal(builds, 5);
  } finally {
    dropEntityMentionIndexCache();
    await removeHarness(memoryDir, workspaceDir);
  }
});

test("a recall during a stable rebuild does not schedule a follow-up", async () => {
  const { memoryDir, workspaceDir } = await buildHarness("engram-entity-epoch-stable-reader");
  try {
    let epoch = 0;
    let builds = 0;
    const scopeKey = entityMentionScopeKey(undefined, [{ dir: memoryDir }], "stable-reader");
    const identity = () => ({ mentionEpoch: String(epoch), entityMutation: "0" });
    let releaseBuild: () => void = () => {};
    let enteredBuild: () => void = () => {};
    const gate = new Promise<void>((resolveGate) => {
      releaseBuild = resolveGate;
    });
    const wait = new Promise<void>((resolveEntered) => {
      enteredBuild = resolveEntered;
    });
    const buildFull = async (): Promise<{ generation: number }> => {
      builds += 1;
      if (builds === 2) {
        enteredBuild();
        await gate;
      }
      return { generation: builds };
    };
    const resolve = () =>
      resolveEntityMentionIndex({
        scopeKey,
        currentIdentity: identity,
        buildFull,
        rebuildEntities: async (previous) => previous,
      });
    await resolve();
    assert.equal(builds, 1);
    epoch += 1;
    const background = resolve();
    await wait;
    assert.equal(builds, 2);
    await resolve();
    await resolve();
    releaseBuild();
    await background;
    await settleEntityMentionIndex(scopeKey);
    assert.equal(builds, 2);
    assert.equal(entityMentionFullRebuildsStarted(scopeKey), 2);
  } finally {
    dropEntityMentionIndexCache();
    await removeHarness(memoryDir, workspaceDir);
  }
});

test("a recall during the follow-up scan does not start another rebuild", async () => {
  const { memoryDir, workspaceDir } = await buildHarness("engram-entity-epoch-refill");
  try {
    let epoch = 0;
    let builds = 0;
    const scopeKey = entityMentionScopeKey(undefined, [{ dir: memoryDir }], "refill");
    const identity = () => ({ mentionEpoch: String(epoch), entityMutation: "0" });
    let releaseBuild2: () => void = () => {};
    let enteredBuild2: () => void = () => {};
    let releaseBuild3: () => void = () => {};
    let enteredBuild3: () => void = () => {};
    const gate2 = new Promise<void>((resolveGate) => {
      releaseBuild2 = resolveGate;
    });
    const wait2 = new Promise<void>((resolveEntered) => {
      enteredBuild2 = resolveEntered;
    });
    const gate3 = new Promise<void>((resolveGate) => {
      releaseBuild3 = resolveGate;
    });
    const wait3 = new Promise<void>((resolveEntered) => {
      enteredBuild3 = resolveEntered;
    });
    const buildFull = async (): Promise<{ generation: number }> => {
      builds += 1;
      if (builds > 6) throw new Error(`rebuild chain exceeded 6 (${builds})`);
      if (builds === 2) {
        enteredBuild2();
        await gate2;
        epoch += 1;
      } else if (builds === 3) {
        enteredBuild3();
        await gate3;
        epoch += 1;
      }
      return { generation: builds };
    };
    const resolve = () =>
      resolveEntityMentionIndex({
        scopeKey,
        currentIdentity: identity,
        buildFull,
        rebuildEntities: async (previous) => previous,
      });
    await resolve();
    assert.equal(builds, 1);
    epoch += 1;
    await resolve();
    await wait2;
    assert.equal(builds, 2);
    releaseBuild2();
    await wait3;
    assert.equal(builds, 3);
    epoch += 1;
    await resolve();
    releaseBuild3();
    await new Promise((resolveTimer) => setImmediate(resolveTimer));
    assert.equal(builds, 3);
    assert.equal(entityMentionFullRebuildsStarted(scopeKey), 3);
  } finally {
    dropEntityMentionIndexCache();
    await removeHarness(memoryDir, workspaceDir);
  }
});

test("an access flush that canonicalizes entityRef moves the mention epoch", async () => {
  const { memoryDir, workspaceDir, storage } = await buildHarness("engram-entity-epoch-access-ref");
  try {
    const written = await storage.writeMemory("fact", "Cedar Lattice tracks harbor lights from the pier.", {
      entityRef: "legacy-harbor-ref",
    });
    const epoch = entityMentionEpoch.current(storage.dir);
    await writeFile(
      path.join(memoryDir, "state", "entity-canonical-id-migration-v1.json"),
      JSON.stringify({ version: 1, mappings: { "legacy-harbor-ref": "canonical-harbor-ref" } }),
    );
    const updated = await storage.flushAccessTracking([
      {
        memoryId: written.id,
        newCount: 2,
        lastAccessed: "2026-10-10T00:00:00.000Z",
      },
    ]);
    assert.equal(updated, 1);
    assert.ok(entityMentionEpoch.current(storage.dir) > epoch);
    const refreshed = await storage.getMemoryById(written.id);
    assert.equal(refreshed?.frontmatter.entityRef, "canonical-harbor-ref");
  } finally {
    await removeHarness(memoryDir, workspaceDir);
  }
});

test("concurrent entity rebuilds share one scan", async () => {
  const { memoryDir, workspaceDir } = await buildHarness("engram-entity-epoch-coalesce");
  type MentionProbe = { generation: number };
  try {
    let mutation = 0;
    const identity = () => ({ mentionEpoch: "1", entityMutation: String(mutation) });
    const scopeKey = entityMentionScopeKey(undefined, [{ dir: memoryDir }], "coalesce");
    await resolveEntityMentionIndex<MentionProbe>({
      scopeKey,
      currentIdentity: identity,
      buildFull: async () => ({ generation: 0 }),
      rebuildEntities: async (previous) => previous,
    });
    mutation = 1;
    let waiting = 0;
    let maxWaiting = 0;
    let releaseScan: () => void = () => {};
    let markEntered: () => void = () => {};
    const scanGate = new Promise<void>((resolve) => {
      releaseScan = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    const rebuildEntities = async (previous: MentionProbe): Promise<MentionProbe> => {
      waiting += 1;
      maxWaiting = Math.max(maxWaiting, waiting);
      markEntered();
      await scanGate;
      waiting -= 1;
      return { generation: previous.generation + 1 };
    };
    const load = () =>
      resolveEntityMentionIndex<MentionProbe>({
        scopeKey,
        currentIdentity: identity,
        buildFull: async () => {
          throw new Error("coalesced entity rebuild must not full-scan");
        },
        rebuildEntities,
      });
    const first = load();
    await entered;
    const second = load();
    releaseScan();
    const [left, right] = await Promise.all([first, second]);
    assert.equal(maxWaiting, 1);
    assert.deepEqual(left, { generation: 1 });
    assert.deepEqual(right, { generation: 1 });
  } finally {
    dropEntityMentionIndexCache();
    await removeHarness(memoryDir, workspaceDir);
  }
});

test("an aborted caller stops waiting on a shared entity rebuild", async () => {
  const { memoryDir, workspaceDir } = await buildHarness("engram-entity-epoch-abort");
  type MentionProbe = { generation: number };
  let releaseScan: () => void = () => {};
  try {
    let mutation = 0;
    const identity = () => ({ mentionEpoch: "1", entityMutation: String(mutation) });
    const scopeKey = entityMentionScopeKey(undefined, [{ dir: memoryDir }], "abort-wait");
    await resolveEntityMentionIndex<MentionProbe>({
      scopeKey,
      currentIdentity: identity,
      buildFull: async () => ({ generation: 0 }),
      rebuildEntities: async (previous) => previous,
    });
    mutation = 1;
    let waiting = 0;
    const scanGate = new Promise<void>((resolve) => {
      releaseScan = resolve;
    });
    let markEntered: () => void = () => {};
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    const rebuildEntities = async (previous: MentionProbe): Promise<MentionProbe> => {
      waiting += 1;
      markEntered();
      await scanGate;
      waiting -= 1;
      return { generation: previous.generation + 1 };
    };
    const load = (signal: AbortSignal) =>
      resolveEntityMentionIndex<MentionProbe>({
        scopeKey,
        currentIdentity: identity,
        abortSignal: signal,
        buildFull: async () => {
          throw new Error("aborted entity rebuild must not full-scan");
        },
        rebuildEntities,
      });
    const rejectsSoon = async (pending: Promise<unknown>) => {
      const result = await Promise.race([
        pending.then(
          () => "resolved" as const,
          (err: unknown) => err
        ),
        new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 100)),
      ]);
      assert.equal(result instanceof Error && result.name === "AbortError", true);
    };
    const ownerSignal = new AbortController();
    const waiterSignal = new AbortController();
    const owner = load(ownerSignal.signal);
    await entered;
    const waiter = load(waiterSignal.signal);
    waiterSignal.abort();
    await rejectsSoon(waiter);
    assert.equal(waiting, 1);
    ownerSignal.abort();
    await rejectsSoon(owner);
    assert.equal(waiting, 1);
    releaseScan();
    await new Promise((resolveTimer) => setImmediate(resolveTimer));
    let extra = 0;
    const settled = await resolveEntityMentionIndex<MentionProbe>({
      scopeKey,
      currentIdentity: identity,
      buildFull: async () => {
        throw new Error("settled entity rebuild must not full-scan");
      },
      rebuildEntities: async (previous) => {
        extra += 1;
        return previous;
      },
    });
    assert.equal(extra, 0);
    assert.equal(waiting, 0);
    assert.deepEqual(settled, { generation: 1 });
  } finally {
    releaseScan();
    dropEntityMentionIndexCache();
    await removeHarness(memoryDir, workspaceDir);
  }
});

test("a cache clear during the first build does not publish that index", async () => {
  const { memoryDir, workspaceDir } = await buildHarness("engram-entity-epoch-clear-build");
  try {
    const scopeKey = entityMentionScopeKey(undefined, [{ dir: memoryDir }], "clear-build");
    let builds = 0;
    let releaseScan: () => void = () => {};
    let markEntered: () => void = () => {};
    const scanGate = new Promise<void>((resolve) => {
      releaseScan = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    const load = () =>
      resolveEntityMentionIndex({
        scopeKey,
        currentIdentity: () => quietIdentity,
        buildFull: async () => {
          builds += 1;
          if (builds === 1) {
            markEntered();
            await scanGate;
          }
          return { generation: builds };
        },
        rebuildEntities: async (previous) => previous,
      });
    const pending = load();
    await entered;
    dropEntityMentionIndexCache();
    releaseScan();
    assert.deepEqual(await pending, { generation: 1 });
    assert.equal(entityMentionIndexScopeKeys().includes(scopeKey), false);
    assert.deepEqual(await load(), { generation: 2 });
    assert.equal(builds, 2);
    assert.equal(entityMentionIndexScopeKeys().includes(scopeKey), true);
  } finally {
    dropEntityMentionIndexCache();
    await removeHarness(memoryDir, workspaceDir);
  }
});

test("an entity write during rebuild is retried on the next recall", async () => {
  const { memoryDir, workspaceDir } = await buildHarness("engram-entity-epoch-overlap");
  type MentionProbe = { generation: number };
  try {
    let mutation = 0;
    const identity = () => ({ mentionEpoch: "1", entityMutation: String(mutation) });
    const scopeKey = entityMentionScopeKey(undefined, [{ dir: memoryDir }], "rev");
    let rebuilds = 0;
    const refuseFullScan = async (): Promise<MentionProbe> => {
      throw new Error("entity overlap must not full-scan");
    };
    await resolveEntityMentionIndex<MentionProbe>({
      scopeKey,
      currentIdentity: identity,
      buildFull: async () => ({ generation: 0 }),
      rebuildEntities: async (previous) => previous,
    });
    mutation = 1;
    await resolveEntityMentionIndex<MentionProbe>({
      scopeKey,
      currentIdentity: identity,
      buildFull: refuseFullScan,
      rebuildEntities: async (previous) => {
        rebuilds += 1;
        mutation = 2;
        return { ...previous, generation: 1 };
      },
    });
    assert.equal(rebuilds, 1);
    await resolveEntityMentionIndex<MentionProbe>({
      scopeKey,
      currentIdentity: identity,
      buildFull: refuseFullScan,
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

test("a stale entityRef snapshot does not suppress the mention epoch", async () => {
  const { memoryDir, workspaceDir, storage } = await buildHarness("engram-entity-epoch-stale-ref");
  try {
    const canonicalA = await storage.writeEntity("Cedar Lattice", "project", [
      "Cedar Lattice tracks harbor lights.",
    ]);
    const canonicalB = await storage.writeEntity("North Pier", "place", ["North Pier holds the channel light."]);
    const written = await storage.writeMemory("fact", "Cedar Lattice tracks harbor lights from the pier.", {
      entityRef: canonicalA,
    });
    const fresh = await storage.readMemoryByPath(written.memory.path);
    assert.ok(fresh);
    await storage.writeMemoryFrontmatter(fresh, { entityRef: canonicalB });
    const epoch = entityMentionEpoch.current(storage.dir);
    const wrote = await storage.writeMemoryFrontmatter(written.memory, {
      heatScore: 0.42,
      decayScore: 0.07,
      lastValidatedAt: "2026-10-10T00:00:00.000Z",
    });
    assert.equal(wrote, true);
    assert.ok(entityMentionEpoch.current(storage.dir) > epoch);
    const persisted = await storage.readMemoryByPath(written.memory.path);
    assert.equal(persisted?.frontmatter.entityRef, canonicalA);
    assert.equal(persisted?.frontmatter.heatScore, 0.42);
  } finally {
    await removeHarness(memoryDir, workspaceDir);
  }
});

test("a metadata patch rechecks entityRef under the path lock", async () => {
  const { memoryDir, workspaceDir, storage } = await buildHarness("engram-entity-epoch-lock-race");
  try {
    const canonicalA = await storage.writeEntity("Cedar Lattice", "project", [
      "Cedar Lattice tracks harbor lights.",
    ]);
    const canonicalB = await storage.writeEntity("North Pier", "place", ["North Pier holds the channel light."]);
    const written = await storage.writeMemory("fact", "Cedar Lattice tracks harbor lights from the pier.", {
      entityRef: canonicalA,
    });
    const fresh = await storage.readMemoryByPath(written.memory.path);
    assert.ok(fresh);
    const seam = storage as unknown as {
      withTombstoneBlockedCaptureWriteLock: (
        task: () => Promise<unknown>,
        identity?: readonly string[],
      ) => Promise<unknown>;
    };
    const original = seam.withTombstoneBlockedCaptureWriteLock.bind(storage);
    let flipped = false;
    seam.withTombstoneBlockedCaptureWriteLock = async (task, identity) =>
      original(async () => {
        if (!flipped) {
          flipped = true;
          const raw = await readFile(written.memory.path, "utf8");
          await writeFile(written.memory.path, raw.replaceAll(canonicalA, canonicalB));
        }
        return task();
      }, identity);
    const epoch = entityMentionEpoch.current(storage.dir);
    const wrote = await storage.writeMemoryFrontmatter(fresh, {
      heatScore: 0.42,
      decayScore: 0.07,
      lastValidatedAt: "2026-10-10T03:00:00.000Z",
    });
    assert.equal(wrote, true);
    assert.equal(flipped, true);
    assert.ok(entityMentionEpoch.current(storage.dir) > epoch);
    const persisted = await storage.readMemoryByPath(written.memory.path);
    assert.equal(persisted?.frontmatter.heatScore, 0.42);
  } finally {
    await removeHarness(memoryDir, workspaceDir);
  }
});

test("archive and supersede status stamps do not move the mention epoch", async () => {
  const { memoryDir, workspaceDir, storage } = await buildHarness("engram-entity-epoch-status");
  try {
    const canonical = await storage.writeEntity("Cedar Lattice", "project", [
      "Cedar Lattice tracks harbor lights.",
    ]);
    const archived = await storage.writeMemory("fact", "Cedar Lattice tracks harbor lights from the pier.", {
      entityRef: canonical,
    });
    const epochAfterWrite = entityMentionEpoch.current(storage.dir);
    assert.equal(await storage.archiveMemories([archived.id], "summary-epoch"), 1);
    assert.equal(entityMentionEpoch.current(storage.dir), epochAfterWrite);
    const archivedFile = await storage.readMemoryByPath(archived.memory.path);
    assert.equal(archivedFile?.frontmatter.status, "archived");

    const oldMemory = await storage.writeMemory("fact", "The original supporting claim.", { source: "test" });
    const replacement = await storage.writeMemory("fact", "The replacement supporting claim.", { source: "test" });
    assert.equal(await storage.supersedeMemory(oldMemory.id, replacement.id, "newer replaces older"), true);
    const epochAfterSupersede = entityMentionEpoch.current(storage.dir);
    assert.ok(epochAfterSupersede > epochAfterWrite);
    assert.equal(
      await storage.supersedeMemory(oldMemory.id, replacement.id, "newer replaces older", undefined, {
        acceptExactReplay: true,
      }),
      true,
    );
    assert.equal(entityMentionEpoch.current(storage.dir), epochAfterSupersede);
  } finally {
    await removeHarness(memoryDir, workspaceDir);
  }
});

test("a held frontmatter write moves the epoch when repair rewrites entityRef", async () => {
  const { memoryDir, workspaceDir, storage } = await buildHarness("engram-entity-epoch-repair");
  try {
    const canonical = await storage.writeEntity("Cedar Lattice", "project", [
      "Cedar Lattice tracks harbor lights.",
    ]);
    const written = await storage.writeMemory("fact", "Cedar Lattice tracks harbor lights from the pier.", {
      entityRef: canonical,
    });
    const seam = storage as unknown as {
      entityRefRepair: {
        repair: (
          filePath: string,
          updated: { entityRef?: string },
          rawMergedRef: string,
          refIds: ReadonlySet<string> | null,
          content: string,
          opts: { onFailRestore?: unknown },
        ) => Promise<void>;
      };
    };
    const original = seam.entityRefRepair.repair.bind(seam.entityRefRepair);
    seam.entityRefRepair.repair = async (filePath, updated, rawMergedRef, refIds, content, opts) => {
      await original(filePath, updated, rawMergedRef, refIds, content, opts);
      updated.entityRef = "entity-rewritten-by-repair";
    };
    const epoch = entityMentionEpoch.current(storage.dir);
    assert.equal(
      await storage.writeMemoryFrontmatter(written.memory, {
        heatScore: 0.33,
        lastValidatedAt: "2026-10-10T02:00:00.000Z",
      }),
      true,
    );
    assert.ok(entityMentionEpoch.current(storage.dir) > epoch);
  } finally {
    await removeHarness(memoryDir, workspaceDir);
  }
});

test("a read-only cache flush can leave the mention epoch in place", async () => {
  const { memoryDir, workspaceDir, storage } = await buildHarness("engram-entity-epoch-cache-flush");
  try {
    await storage.writeMemory("fact", "Cedar Lattice tracks harbor lights from the pier.", {});
    const epoch = entityMentionEpoch.current(storage.dir);
    storage.invalidateAllMemoriesCacheForDir({ indexedText: false });
    assert.equal(entityMentionEpoch.current(storage.dir), epoch);
    storage.invalidateAllMemoriesCacheForDir();
    assert.ok(entityMentionEpoch.current(storage.dir) > epoch);
  } finally {
    await removeHarness(memoryDir, workspaceDir);
  }
});

test("archive and supersede repairs move the mention epoch when entityRef changes", async () => {
  const { memoryDir, workspaceDir, storage } = await buildHarness("engram-entity-epoch-repair-status");
  try {
    const canonical = await storage.writeEntity("Cedar Lattice", "project", [
      "Cedar Lattice tracks harbor lights.",
    ]);
    const archived = await storage.writeMemory("fact", "Cedar Lattice tracks harbor lights from the pier.", {
      entityRef: canonical,
    });
    const seam = storage as unknown as {
      entityRefRepair: {
        repair: (
          filePath: string,
          updated: { entityRef?: string },
          rawMergedRef: string,
          refIds: Readonly<Record<string, string>>,
          content: string,
          opts: { onFailRestore?: unknown },
        ) => Promise<void>;
      };
    };
    const original = seam.entityRefRepair.repair.bind(seam.entityRefRepair);
    seam.entityRefRepair.repair = async (filePath, updated, rawMergedRef, refIds, content, opts) => {
      await original(filePath, updated, rawMergedRef, refIds, content, opts);
      updated.entityRef = "entity-rewritten-by-repair";
    };
    const epoch = entityMentionEpoch.current(storage.dir);
    assert.equal(await storage.archiveMemories([archived.id], "summary-repair"), 1);
    assert.ok(entityMentionEpoch.current(storage.dir) > epoch);

    const oldMemory = await storage.writeMemory("fact", "The original supporting claim.", {
      entityRef: canonical,
      source: "test",
    });
    const replacement = await storage.writeMemory("fact", "The replacement supporting claim.", {
      entityRef: canonical,
      source: "test",
    });
    seam.entityRefRepair.repair = original;
    assert.equal(await storage.supersedeMemory(oldMemory.id, replacement.id, "newer replaces older"), true);
    seam.entityRefRepair.repair = async (filePath, updated, rawMergedRef, refIds, content, opts) => {
      await original(filePath, updated, rawMergedRef, refIds, content, opts);
      updated.entityRef = "entity-rewritten-on-replay";
    };
    const afterSupersede = entityMentionEpoch.current(storage.dir);
    assert.equal(
      await storage.supersedeMemory(oldMemory.id, replacement.id, "newer replaces older", undefined, {
        acceptExactReplay: true,
      }),
      true,
    );
    assert.ok(entityMentionEpoch.current(storage.dir) > afterSupersede);
  } finally {
    await removeHarness(memoryDir, workspaceDir);
  }
});
