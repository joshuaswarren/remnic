import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { StorageManager } from "../src/storage.js";
import { TierMigrationExecutor } from "../src/tier-migration.js";
import type { MemoryFile } from "../src/types.js";

type QmdCallLog = {
  updates: string[]; updateDirs?: Array<{ collection: string; memoryDir: string }>;
  embeds: string[];
};

async function listMemoryFiles(root: string, id: string): Promise<string[]> {
  const hits: string[] = [];
  const walk = async (dir: string) => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && entry.name === `${id}.md`) {
        hits.push(full);
      }
    }
  };
  await walk(root);
  return hits;
}

async function createHotFactWithParityFields(storage: StorageManager): Promise<MemoryFile> {
  const id = await storage.writeMemory(
    "fact",
    "Tier migration parity body",
    {
      source: "tier-migration-test",
      tags: ["tier", "parity"],
      links: [{ targetId: "fact-anchor", linkType: "supports", strength: 0.92, reason: "regression" }],
      memoryKind: "note",
      intentGoal: "test",
      intentActionType: "validate",
      intentEntityTypes: ["memory"],
    },
  );
  const memory = await storage.getMemoryById(id);
  assert.ok(memory, "expected memory to exist after write");

  await storage.writeMemoryFrontmatter(memory!, {
    verificationState: "user_confirmed",
    lifecycleState: "active",
    importance: {
      score: 0.91,
      level: "high",
      reasons: ["durable policy signal"],
      keywords: ["tier", "migration"],
    },
  });

  const updated = await storage.getMemoryById(id);
  assert.ok(updated, "expected updated memory by id");
  return updated!;
}

function createQmdStub(logs: QmdCallLog) {
  return {
    async updateCollection(collection: string): Promise<void> {
      logs.updates.push(collection);
    },
    async embedCollection(collection: string): Promise<void> {
      logs.embeds.push(collection);
    },
  };
}

test("tier migration demotes hot memory and refreshes source and destination collections", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-tier-migrate-"));
  try {
    const storage = new StorageManager(memoryDir);
    const source = await createHotFactWithParityFields(storage);

    const logs: QmdCallLog = { updates: [], embeds: [] };
    const executor = new TierMigrationExecutor({
      storage,
      qmd: createQmdStub(logs),
      hotCollection: "openclaw-engram",
      coldCollection: "openclaw-engram-cold",
      autoEmbed: false,
    });

    const result = await executor.migrateMemory({
      memory: source,
      fromTier: "hot",
      toTier: "cold",
      reason: "value_below_demotion_threshold",
    });

    assert.equal(result.changed, true);
    assert.equal(result.toTier, "cold");
    assert.match(result.targetPath, /[\\/]cold[\\/]facts[\\/]/);

    const moved = await storage.readMemoryByPath(result.targetPath);
    assert.ok(moved, "expected moved memory to exist in cold tier");
    assert.equal(moved!.frontmatter.id, source.frontmatter.id);
    assert.deepEqual(moved!.frontmatter.links, source.frontmatter.links);
    assert.equal(moved!.frontmatter.verificationState, source.frontmatter.verificationState);
    assert.deepEqual(moved!.frontmatter.importance, source.frontmatter.importance);
    assert.equal(moved!.frontmatter.lifecycleState, source.frontmatter.lifecycleState);
    assert.equal(moved!.frontmatter.memoryKind, source.frontmatter.memoryKind);

    const oldPathMemory = await storage.readMemoryByPath(source.path);
    assert.equal(oldPathMemory, null, "expected source hot file to be removed after demotion");

    assert.deepEqual(logs.updates, ["openclaw-engram-cold", "openclaw-engram"]);
    assert.deepEqual(logs.embeds, []);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("tier migration promotes cold memory and refreshes source and destination collections", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-tier-promote-"));
  try {
    const storage = new StorageManager(memoryDir);
    const source = await createHotFactWithParityFields(storage);

    const logs: QmdCallLog = { updates: [], embeds: [] };
    const executor = new TierMigrationExecutor({
      storage,
      qmd: createQmdStub(logs),
      hotCollection: "openclaw-engram",
      coldCollection: "openclaw-engram-cold",
      autoEmbed: false,
    });

    const demoted = await executor.migrateMemory({
      memory: source,
      fromTier: "hot",
      toTier: "cold",
      reason: "setup_demotion",
    });
    const coldMemory = await storage.readMemoryByPath(demoted.targetPath);
    assert.ok(coldMemory, "expected cold memory for promotion setup");

    logs.updates = [];
    logs.embeds = [];
    const promoted = await executor.migrateMemory({
      memory: coldMemory!,
      fromTier: "cold",
      toTier: "hot",
      reason: "value_above_promotion_threshold",
    });

    assert.equal(promoted.changed, true);
    assert.equal(promoted.toTier, "hot");
    assert.doesNotMatch(promoted.targetPath, /[\\/]cold[\\/]/);

    const hotAgain = await storage.readMemoryByPath(promoted.targetPath);
    assert.ok(hotAgain, "expected promoted memory in hot path");
    assert.equal(hotAgain!.frontmatter.id, source.frontmatter.id);

    assert.deepEqual(logs.updates, ["openclaw-engram", "openclaw-engram-cold"]);
    assert.deepEqual(logs.embeds, []);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("tier migration reruns are idempotent and do not duplicate files", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-tier-idempotent-"));
  try {
    const storage = new StorageManager(memoryDir);
    const source = await createHotFactWithParityFields(storage);

    const logs: QmdCallLog = { updates: [], embeds: [] };
    const executor = new TierMigrationExecutor({
      storage,
      qmd: createQmdStub(logs),
      hotCollection: "openclaw-engram",
      coldCollection: "openclaw-engram-cold",
      autoEmbed: false,
    });

    const first = await executor.migrateMemory({
      memory: source,
      fromTier: "hot",
      toTier: "cold",
      reason: "first_move",
    });
    const second = await executor.migrateMemory({
      memory: source,
      fromTier: "hot",
      toTier: "cold",
      reason: "rerun",
    });

    assert.equal(first.changed, true);
    assert.equal(second.changed, false);
    assert.equal(second.targetPath, first.targetPath);

    const files = await listMemoryFiles(memoryDir, source.frontmatter.id);
    assert.equal(files.length, 1, `expected exactly one memory file after rerun, got: ${files.join(", ")}`);

    const journalRaw = await readFile(path.join(memoryDir, "state", "tier-migration-journal.jsonl"), "utf-8");
    const journalLines = journalRaw.trim().split("\n").filter(Boolean);
    assert.equal(journalLines.length, 2);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("tier migration keeps artifact memories on artifact-only paths", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-tier-artifacts-"));
  try {
    const storage = new StorageManager(memoryDir);
    const artifactId = await storage.writeArtifact("verbatim artifact body", {
      artifactType: "decision",
      tags: ["artifact"],
    });
    const artifactFiles = await listMemoryFiles(path.join(memoryDir, "artifacts"), artifactId);
    assert.equal(artifactFiles.length, 1, "expected one artifact file in hot tier");
    const hotArtifact = await storage.readMemoryByPath(artifactFiles[0]);
    assert.ok(hotArtifact, "expected artifact memory in hot tier");
    assert.match(hotArtifact!.path, /[\\/]artifacts[\\/]/);

    const logs: QmdCallLog = { updates: [], embeds: [] };
    const executor = new TierMigrationExecutor({
      storage,
      qmd: createQmdStub(logs),
      hotCollection: "openclaw-engram",
      coldCollection: "openclaw-engram-cold",
      autoEmbed: false,
    });

    const moved = await executor.migrateMemory({
      memory: hotArtifact!,
      fromTier: "hot",
      toTier: "cold",
      reason: "artifact_cold_tier",
    });

    assert.equal(moved.changed, true);
    assert.match(moved.targetPath, /[\\/]cold[\\/]artifacts[\\/]/);
    const coldArtifact = await storage.readMemoryByPath(moved.targetPath);
    assert.ok(coldArtifact, "expected artifact to stay in artifact path after migration");
    assert.equal(coldArtifact!.frontmatter.artifactType, "decision");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("tier migration autoEmbed embeds both destination and source collections", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-tier-autoembed-"));
  try {
    const storage = new StorageManager(memoryDir);
    const source = await createHotFactWithParityFields(storage);

    const logs: QmdCallLog = { updates: [], embeds: [] };
    const executor = new TierMigrationExecutor({
      storage,
      qmd: createQmdStub(logs),
      hotCollection: "openclaw-engram",
      coldCollection: "openclaw-engram-cold",
      autoEmbed: true,
    });

    await executor.migrateMemory({
      memory: source,
      fromTier: "hot",
      toTier: "cold",
      reason: "autoembed",
    });

    assert.deepEqual(logs.updates, ["openclaw-engram-cold", "openclaw-engram"]);
    assert.deepEqual(logs.embeds, ["openclaw-engram-cold", "openclaw-engram"]);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("tier migration avoids duplicate source update for global-update backends", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-tier-global-update-"));
  try {
    const storage = new StorageManager(memoryDir);
    const source = await createHotFactWithParityFields(storage);

    const logs: QmdCallLog = { updates: [], embeds: [] };
    const executor = new TierMigrationExecutor({
      storage,
      qmd: {
        ...createQmdStub(logs),
        updatesAllCollections: () => true,
      } as any,
      hotCollection: "openclaw-engram",
      coldCollection: "openclaw-engram-cold",
      autoEmbed: false,
    });

    await executor.migrateMemory({
      memory: source,
      fromTier: "hot",
      toTier: "cold",
      reason: "global-update",
    });

    assert.deepEqual(logs.updates, ["openclaw-engram-cold"]);
    assert.deepEqual(logs.embeds, []);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("tier migration refreshes scoped collections from their tier roots", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-tier-scoped-roots-"));
  try {
    const storage = new StorageManager(memoryDir);
    const source = await createHotFactWithParityFields(storage);

    const logs: QmdCallLog = { updates: [], updateDirs: [], embeds: [] };
    const executor = new TierMigrationExecutor({
      storage,
      qmd: {
        ...createQmdStub(logs),
        updateCollectionFromDir: async (collection: string, dir: string): Promise<void> => {
          logs.updateDirs!.push({ collection, memoryDir: dir });
        },
      } as any,
      hotCollection: "openclaw-engram",
      coldCollection: "openclaw-engram-cold",
      autoEmbed: false,
    });

    await executor.migrateMemory({
      memory: source,
      fromTier: "hot",
      toTier: "cold",
      reason: "scoped-roots",
    });

    assert.deepEqual(logs.updates, []);
    assert.deepEqual(logs.updateDirs, [
      { collection: "openclaw-engram-cold", memoryDir: path.join(memoryDir, "cold") },
      { collection: "openclaw-engram", memoryDir },
    ]);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});
