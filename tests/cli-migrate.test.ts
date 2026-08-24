import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import {
  runMigrateNormalizeFrontmatterCliCommand,
  runMigrateRechunkCliCommand,
  runMigrateReextractCliCommand,
  runMigrateRescoreImportanceCliCommand,
} from "@remnic/core/cli";
import { StorageManager } from "@remnic/core/storage";

function buildMigrateOrchestrator(storage: StorageManager) {
  return {
    config: { defaultNamespace: "default" },
    async getStorage() {
      return storage;
    },
  };
}

function longChunkCandidate(): string {
  return Array.from({ length: 120 }, (_, idx) => `Sentence ${idx + 1} adds deterministic chunking coverage.`).join(" ");
}

test("migrate normalize-frontmatter defaults to dry-run", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "engram-cli-migrate-normalize-"));
  try {
    const storage = new StorageManager(dir);
    await storage.writeMemory("fact", "Normalize this frontmatter.", { source: "test" });

    const report = await runMigrateNormalizeFrontmatterCliCommand(buildMigrateOrchestrator(storage), { limit: 10 });
    assert.equal(report.action, "normalize-frontmatter");
    assert.equal(report.dryRun, true);
    assert.equal(report.scanned >= 1, true);
    assert.equal(report.changed, report.scanned);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("migrate rescore-importance writes recalculated scores", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "engram-cli-migrate-importance-"));
  try {
    const storage = new StorageManager(dir);
    const { id: id } = await storage.writeMemory("fact", "hello", { source: "test" });
    const before = await storage.getMemoryById(id);
    assert.equal(before?.frontmatter.importance, undefined);

    const report = await runMigrateRescoreImportanceCliCommand(buildMigrateOrchestrator(storage), {
      write: true,
      limit: 10,
    });
    assert.equal(report.action, "rescore-importance");
    assert.equal(report.dryRun, false);
    assert.equal(report.changed >= 1, true);

    const after = await storage.getMemoryById(id);
    assert.equal(Boolean(after?.frontmatter.importance), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("migrate rechunk writes chunk files for long parent content", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "engram-cli-migrate-rechunk-"));
  try {
    const storage = new StorageManager(dir);
    const { id: parentId } = await storage.writeMemory("fact", longChunkCandidate(), { source: "test" });

    const report = await runMigrateRechunkCliCommand(buildMigrateOrchestrator(storage), {
      write: true,
      limit: 10,
    });
    assert.equal(report.action, "rechunk");
    assert.equal(report.dryRun, false);
    assert.equal(report.changed >= 1, true);

    const chunks = await storage.getChunksForParent(parentId);
    assert.equal(chunks.length > 1, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("migrate rechunk skips archived parents to avoid orphan active chunks", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "engram-cli-migrate-rechunk-archived-"));
  try {
    const storage = new StorageManager(dir);
    const { id: parentId } = await storage.writeMemory("fact", longChunkCandidate(), { source: "test" });
    const parent = await storage.getMemoryById(parentId);
    assert.ok(parent);
    await storage.archiveMemory(parent!);

    const report = await runMigrateRechunkCliCommand(buildMigrateOrchestrator(storage), {
      write: true,
      limit: 10,
    });
    assert.equal(report.scanned, 0);
    assert.equal(report.changed, 0);
    assert.equal(report.dryRun, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("migrate reextract enforces explicit model and queues bounded jobs", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "engram-cli-migrate-reextract-"));
  try {
    const storage = new StorageManager(dir);
    await storage.writeMemory("fact", "Memory one", { source: "test" });
    await storage.writeMemory("fact", "Memory two", { source: "test" });
    await storage.writeMemory("fact", "Memory three", { source: "test" });

    await assert.rejects(
      runMigrateReextractCliCommand(buildMigrateOrchestrator(storage), {
        model: "",
        write: true,
      }),
      /missing --model/,
    );

    const report = await runMigrateReextractCliCommand(buildMigrateOrchestrator(storage), {
      model: "gpt-5-mini",
      write: true,
      limit: 2,
    });
    assert.equal(report.action, "reextract");
    assert.equal(report.dryRun, false);
    assert.equal(report.queued, 2);
    assert.equal(report.model, "gpt-5-mini");

    const jobs = await storage.readReextractJobs(10);
    assert.equal(jobs.length, 2);
    assert.equal(jobs.every((job) => job.model === "gpt-5-mini"), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("migrate reextract applies limit after filtering out chunk memories", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "engram-cli-migrate-reextract-limit-"));
  try {
    const storage = new StorageManager(dir);
    const { id: parentId } = await storage.writeMemory("fact", longChunkCandidate(), { source: "test" });
    await runMigrateRechunkCliCommand(buildMigrateOrchestrator(storage), { write: true, limit: 10 });

    const report = await runMigrateReextractCliCommand(buildMigrateOrchestrator(storage), {
      model: "gpt-5-mini",
      write: true,
      limit: 1,
    });

    assert.equal(report.queued, 1);
    const jobs = await storage.readReextractJobs(10);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0]?.memoryId, parentId);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("migrate rechunk does not invalidate existing chunks before replacement writes", async () => {
  const parent = {
    path: "/tmp/fact-parent.md",
    frontmatter: {
      id: "fact-parent",
      category: "fact",
      created: "2026-02-28T00:00:00.000Z",
      updated: "2026-02-28T00:00:00.000Z",
      source: "test",
      confidence: 0.9,
      confidenceTier: "high",
      tags: [],
    },
    content: longChunkCandidate(),
  } as any;

  const existingChunk = {
    path: "/tmp/fact-parent-chunk-0.md",
    frontmatter: {
      id: "fact-parent-chunk-0",
      category: "fact",
      created: "2026-02-28T00:00:00.000Z",
      updated: "2026-02-28T00:00:00.000Z",
      source: "chunking",
      confidence: 0.9,
      confidenceTier: "high",
      tags: [],
      parentId: "fact-parent",
      chunkIndex: 0,
      chunkTotal: 1,
    },
    content: "old content",
  } as any;

  let invalidateCalls = 0;
  let updateCalls = 0;
  let writeCalls = 0;
  const storage = {
    async readAllMemories() {
      return [parent];
    },
    async readArchivedMemories() {
      return [];
    },
    async writeMemoryFrontmatter() {
      return true;
    },
    async getChunksForParent() {
      return [existingChunk];
    },
    async updateMemory() {
      updateCalls += 1;
      return true;
    },
    async updateMemoryFrontmatter() {
      return true;
    },
    async writeChunk() {
      writeCalls += 1;
      throw new Error("simulated write failure");
    },
    async invalidateMemory() {
      invalidateCalls += 1;
      return true;
    },
    async appendReextractJobs() {
      return 0;
    },
  };

  await assert.rejects(
    runMigrateRechunkCliCommand(
      {
        config: { defaultNamespace: "default" },
        async getStorage() {
          return storage as any;
        },
      },
      { write: true, limit: 10 },
    ),
    /simulated write failure/,
  );
  assert.equal(updateCalls >= 1, true);
  assert.equal(writeCalls >= 1, true);
  assert.equal(invalidateCalls, 0);
});

test("migrate rechunk removes orphan chunks when parent no longer needs chunking", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "engram-cli-migrate-rechunk-orphan-"));
  try {
    const storage = new StorageManager(dir);
    const { id: parentId } = await storage.writeMemory("fact", "short content", { source: "test" });
    await storage.writeChunk(parentId, 0, 1, "fact", "stale chunk", { source: "test" });
    assert.equal((await storage.getChunksForParent(parentId)).length, 1);

    const report = await runMigrateRechunkCliCommand(buildMigrateOrchestrator(storage), {
      write: true,
      limit: 10,
    });
    assert.equal(report.changed >= 1, true);
    assert.equal((await storage.getChunksForParent(parentId)).length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("migrate rechunk updates existing chunk content instead of restoring stale content", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "engram-cli-migrate-rechunk-content-"));
  try {
    const storage = new StorageManager(dir);
    const { id: parentId } = await storage.writeMemory("fact", longChunkCandidate(), { source: "test" });
    await storage.writeChunk(parentId, 0, 1, "fact", "stale chunk content", { source: "test" });

    await runMigrateRechunkCliCommand(buildMigrateOrchestrator(storage), {
      write: true,
      limit: 10,
    });

    const firstChunk = (await storage.getChunksForParent(parentId)).find((chunk) => chunk.frontmatter.chunkIndex === 0);
    assert.ok(firstChunk);
    assert.notEqual(firstChunk?.content.trim(), "stale chunk content");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
