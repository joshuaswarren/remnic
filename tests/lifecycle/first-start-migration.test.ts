/**
 * Unit + integration tests for `runFirstStartMigration`
 * (issue #686 retention-completion).
 *
 * Verifies:
 *   - Skips when lifecyclePolicyEnabled is false
 *   - Skips when qmdTierMigrationEnabled is false
 *   - Skips when the `.lifecycle-init-done` marker already exists
 *   - Runs a rate-limited demotion sweep (cap=50) on first call
 *   - Writes the marker AFTER mutations succeed
 *   - Is resumable: second call sees the marker and skips
 *   - dryRun=true reports candidates without mutating or writing marker
 */

import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { access, mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";

import {
  runFirstStartMigration,
  FIRST_START_DEMOTION_CAP,
  LIFECYCLE_INIT_DONE_MARKER,
} from "../../packages/remnic-core/src/maintenance/first-start-migration.js";
import { StorageManager } from "../../packages/remnic-core/src/storage.js";
import { parseConfig } from "../../packages/remnic-core/src/config.js";

// ── Config helpers ─────────────────────────────────────────────────────────

function makeConfig(memoryDir: string, overrides: Record<string, unknown> = {}) {
  return parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir: memoryDir,
    qmdEnabled: false,
    transcriptEnabled: false,
    hourlySummariesEnabled: false,
    identityEnabled: false,
    identityContinuityEnabled: false,
    sharedContextEnabled: false,
    captureMode: "implicit",
    lifecyclePolicyEnabled: true,
    qmdTierMigrationEnabled: true,
    qmdTierDemotionMinAgeDays: 14,
    qmdTierDemotionValueThreshold: 0.35,
    qmdTierPromotionValueThreshold: 0.7,
    ...overrides,
  });
}

function makeQmdStub(logs: string[]) {
  return {
    updateCollection: async (collection: string) => {
      logs.push(collection);
    },
    embedCollection: async () => {},
  };
}

// ── Skip conditions ────────────────────────────────────────────────────────

test("first-start migration: skips when lifecyclePolicyEnabled=false", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-fsm-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();
    const config = makeConfig(dir, { lifecyclePolicyEnabled: false });

    const result = await runFirstStartMigration({ storage, config });
    assert.equal(result.skipped, true);
    assert.match(result.skipReason ?? "", /lifecyclePolicyEnabled/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("first-start migration: skips when qmdTierMigrationEnabled=false", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-fsm-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();
    const config = makeConfig(dir, { qmdTierMigrationEnabled: false });

    const result = await runFirstStartMigration({ storage, config });
    assert.equal(result.skipped, true);
    assert.match(result.skipReason ?? "", /qmdTierMigrationEnabled/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("first-start migration: skips when marker already exists", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-fsm-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();
    const config = makeConfig(dir);

    // Pre-write marker
    const markerDir = path.join(dir, "state");
    await mkdir(markerDir, { recursive: true });
    await writeFile(path.join(markerDir, LIFECYCLE_INIT_DONE_MARKER), JSON.stringify({ createdAt: new Date().toISOString() }), "utf-8");

    const result = await runFirstStartMigration({ storage, config });
    assert.equal(result.skipped, true);
    assert.match(result.skipReason ?? "", /marker/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── dryRun semantics ───────────────────────────────────────────────────────

test("first-start migration: dryRun=true does not write marker", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-fsm-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();
    const config = makeConfig(dir);

    const result = await runFirstStartMigration({ storage, config, dryRun: true });
    assert.equal(result.skipped, false);
    assert.equal(result.dryRun, true);
    assert.equal(result.demotedCount, 0);

    // Marker must NOT have been written
    const markerP = path.join(dir, "state", LIFECYCLE_INIT_DONE_MARKER);
    await assert.rejects(() => access(markerP), "marker should not exist after dryRun");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── Marker lifecycle ───────────────────────────────────────────────────────

test("first-start migration: writes marker after successful run", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-fsm-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();
    const config = makeConfig(dir);
    const now = new Date("2026-04-27T00:00:00.000Z");

    const result = await runFirstStartMigration({ storage, config, now: () => now });
    assert.equal(result.skipped, false);
    assert.equal(result.dryRun, false);

    // Marker must now exist
    const markerPath = path.join(dir, "state", LIFECYCLE_INIT_DONE_MARKER);
    const markerRaw = await readFile(markerPath, "utf-8");
    const marker = JSON.parse(markerRaw) as { createdAt: string };
    assert.equal(marker.createdAt, now.toISOString());
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("first-start migration: resumable — second run skips", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-fsm-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();
    const config = makeConfig(dir);

    await runFirstStartMigration({ storage, config });
    const second = await runFirstStartMigration({ storage, config });
    assert.equal(second.skipped, true);
    assert.match(second.skipReason ?? "", /marker/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── Demotion sweep ─────────────────────────────────────────────────────────

test("first-start migration: candidateCount=0 when no hot memories qualify", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-fsm-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();
    // Write a very fresh memory — should not qualify for demotion
    await storage.writeMemory("fact", "Freshly written fact.", { source: "test" });
    const config = makeConfig(dir);

    const result = await runFirstStartMigration({ storage, config });
    // Fresh memory (today) should not meet demotionMinAgeDays=14 threshold
    assert.equal(result.demotedCount, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("first-start migration: empty corpus writes marker even when QMD refresh fails", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-fsm-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();
    const config = makeConfig(dir);

    const result = await runFirstStartMigration({
      storage,
      config,
      qmd: {
        updateCollection: async () => {
          throw new Error("qmd unavailable");
        },
        embedCollection: async () => {},
      } as any,
    });

    assert.equal(result.candidateCount, 0);
    assert.equal(result.failureCount, 0);

    const markerPath = path.join(dir, "state", LIFECYCLE_INIT_DONE_MARKER);
    await access(markerPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("first-start migration: respects demotionCap", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-fsm-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();
    const config = makeConfig(dir, {
      // Very aggressive demotion: any memory older than 1 day with low value
      qmdTierDemotionMinAgeDays: 1,
      qmdTierDemotionValueThreshold: 0.99, // nearly everything qualifies
    });

    // Write 5 memories that should be very old and have low confidence
    for (let i = 0; i < 5; i++) {
      await storage.writeMemory("fact", `Fact ${i} to demote.`, { source: "test" });
    }
    // Backdate them all
    const allMemories = await storage.readAllMemories();
    for (const m of allMemories) {
      await storage.writeMemoryFrontmatter(m, {
        updated: "2020-01-01T00:00:00.000Z",
        created: "2020-01-01T00:00:00.000Z",
        confidence: 0.01,
      });
    }

    // Cap at 2 — only 2 should be demoted
    const result = await runFirstStartMigration({ storage, config, demotionCap: 2 });
    assert.ok(result.demotedCount <= 2, `demotedCount ${result.demotedCount} must not exceed cap 2`);
    assert.equal(result.cappedAt, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("first-start migration: journals demotions and updates cold QMD collection", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-fsm-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();
    const config = makeConfig(dir, {
      qmdTierDemotionMinAgeDays: 1,
      qmdTierDemotionValueThreshold: 0.99,
      qmdCollection: "hot-test",
      qmdColdCollection: "cold-test",
    });

    const id = await storage.writeMemory("fact", "Old low-value fact.", { source: "test" });
    const memory = await storage.getMemoryById(id);
    assert.ok(memory, "expected memory to exist");
    await storage.writeMemoryFrontmatter(memory, {
      updated: "2020-01-01T00:00:00.000Z",
      created: "2020-01-01T00:00:00.000Z",
      confidence: 0.01,
    });

    const qmdUpdates: string[] = [];
    const result = await runFirstStartMigration({
      storage,
      config,
      qmd: makeQmdStub(qmdUpdates) as any,
    });

    assert.equal(result.demotedCount, 1);
    assert.deepEqual(qmdUpdates, ["cold-test", "hot-test"]);

    const journalPath = path.join(dir, "state", "tier-migration-journal.jsonl");
    const journalRaw = await readFile(journalPath, "utf-8");
    assert.match(journalRaw, /first-start-lifecycle-migration/);
    assert.match(journalRaw, new RegExp(id));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("first-start migration: retries QMD refresh after a successful move throws", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-fsm-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();
    const config = makeConfig(dir, {
      qmdTierDemotionMinAgeDays: 1,
      qmdTierDemotionValueThreshold: 0.99,
      qmdCollection: "hot-test",
      qmdColdCollection: "cold-test",
    });

    const id = await storage.writeMemory("fact", "Old low-value fact.", { source: "test" });
    const memory = await storage.getMemoryById(id);
    assert.ok(memory, "expected memory to exist");
    await storage.writeMemoryFrontmatter(memory, {
      updated: "2020-01-01T00:00:00.000Z",
      created: "2020-01-01T00:00:00.000Z",
      confidence: 0.01,
    });

    const qmdUpdates: string[] = [];
    let shouldThrow = true;
    const result = await runFirstStartMigration({
      storage,
      config,
      qmd: {
        updateCollection: async (collection: string) => {
          qmdUpdates.push(collection);
          if (shouldThrow) {
            shouldThrow = false;
            throw new Error("qmd unavailable after move");
          }
        },
        embedCollection: async () => {},
      } as any,
    });

    assert.equal(result.demotedCount, 1);
    assert.equal(result.failureCount, 0);
    assert.deepEqual(qmdUpdates, ["cold-test", "cold-test"]);

    const markerPath = path.join(dir, "state", LIFECYCLE_INIT_DONE_MARKER);
    await access(markerPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("first-start migration: counts completed disk demotion when no QMD exists", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-fsm-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();
    const config = makeConfig(dir, {
      qmdTierDemotionMinAgeDays: 1,
      qmdTierDemotionValueThreshold: 0.99,
    });

    const id = await storage.writeMemory("fact", "Old low-value fact.", { source: "test" });
    const memory = await storage.getMemoryById(id);
    assert.ok(memory, "expected memory to exist");
    await storage.writeMemoryFrontmatter(memory, {
      updated: "2020-01-01T00:00:00.000Z",
      created: "2020-01-01T00:00:00.000Z",
      confidence: 0.01,
    });

    const migrateMemoryToTier = storage.migrateMemoryToTier.bind(storage);
    storage.migrateMemoryToTier = (async (...args: Parameters<StorageManager["migrateMemoryToTier"]>) => {
      await migrateMemoryToTier(...args);
      throw new Error("late disk bookkeeping failure");
    }) as StorageManager["migrateMemoryToTier"];

    const result = await runFirstStartMigration({ storage, config });

    assert.equal(result.demotedCount, 1);
    assert.equal(result.failureCount, 0);
    await access(path.join(dir, "state", LIFECYCLE_INIT_DONE_MARKER));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("first-start migration: late QMD retry success writes marker", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-fsm-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();
    const config = makeConfig(dir, {
      qmdTierDemotionMinAgeDays: 1,
      qmdTierDemotionValueThreshold: 0.99,
      qmdColdCollection: "cold-test",
    });

    const id = await storage.writeMemory("fact", "Old low-value fact.", { source: "test" });
    const memory = await storage.getMemoryById(id);
    assert.ok(memory, "expected memory to exist");
    await storage.writeMemoryFrontmatter(memory, {
      updated: "2020-01-01T00:00:00.000Z",
      created: "2020-01-01T00:00:00.000Z",
      confidence: 0.01,
    });

    let attempts = 0;
    const result = await runFirstStartMigration({
      storage,
      config,
      qmd: {
        updateCollection: async () => {
          attempts += 1;
          if (attempts < 3) throw new Error("qmd unavailable");
        },
        embedCollection: async () => {},
      } as any,
    });

    assert.equal(result.demotedCount, 1);
    assert.equal(result.failureCount, 0);
    await access(path.join(dir, "state", LIFECYCLE_INIT_DONE_MARKER));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("first-start migration: pending QMD retry uses strict refresh when available", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-fsm-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();
    const config = makeConfig(dir, {
      qmdTierDemotionMinAgeDays: 1,
      qmdTierDemotionValueThreshold: 0.99,
      qmdColdCollection: "cold-test",
    });

    const id = await storage.writeMemory("fact", "Old low-value fact.", { source: "test" });
    const memory = await storage.getMemoryById(id);
    assert.ok(memory, "expected memory to exist");
    await storage.writeMemoryFrontmatter(memory, {
      updated: "2020-01-01T00:00:00.000Z",
      created: "2020-01-01T00:00:00.000Z",
      confidence: 0.01,
    });

    let ordinaryAttempts = 0;
    let strictAttempts = 0;
    const result = await runFirstStartMigration({
      storage,
      config,
      qmd: {
        updateCollection: async () => {
          ordinaryAttempts += 1;
          throw new Error("ordinary refresh failed");
        },
        updateCollectionStrict: async (collection: string) => {
          assert.equal(collection, "cold-test");
          strictAttempts += 1;
          if (strictAttempts < 2) throw new Error("strict refresh failed");
        },
        embedCollection: async () => {},
      } as any,
    });

    assert.equal(result.demotedCount, 1);
    assert.equal(result.failureCount, 0);
    assert.equal(ordinaryAttempts, 1);
    assert.equal(strictAttempts, 2);
    await access(path.join(dir, "state", LIFECYCLE_INIT_DONE_MARKER));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("first-start migration: QMD pending marker for another collection blocks init marker without clearing it", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-fsm-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();
    const config = makeConfig(dir, {
      qmdColdCollection: "current-cold",
    });
    const stateDir = path.join(dir, "state");
    await mkdir(stateDir, { recursive: true });
    await writeFile(
      path.join(stateDir, ".lifecycle-qmd-refresh-pending"),
      JSON.stringify({ createdAt: "2026-04-01T00:00:00.000Z", collection: "old-cold" }),
      "utf-8",
    );

    let refreshAttempts = 0;
    const result = await runFirstStartMigration({
      storage,
      config,
      qmd: {
        updateCollection: async () => {
          refreshAttempts += 1;
          throw new Error("stale marker should not retry");
        },
        updateCollectionStrict: async () => {
          refreshAttempts += 1;
          throw new Error("stale marker should not retry");
        },
        embedCollection: async () => {},
      } as any,
    });

    assert.equal(result.failureCount, 1);
    assert.equal(refreshAttempts, 0);
    await assert.rejects(() => access(path.join(dir, "state", LIFECYCLE_INIT_DONE_MARKER)));
    await access(path.join(stateDir, ".lifecycle-qmd-refresh-pending"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("first-start migration: cold orphan does not mask failed demotion while source remains hot", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-fsm-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();
    const config = makeConfig(dir, {
      qmdTierDemotionMinAgeDays: 1,
      qmdTierDemotionValueThreshold: 0.99,
    });

    const id = await storage.writeMemory("fact", "Old low-value fact.", { source: "test" });
    const memory = await storage.getMemoryById(id);
    assert.ok(memory, "expected memory to exist");
    await storage.writeMemoryFrontmatter(memory, {
      updated: "2020-01-01T00:00:00.000Z",
      created: "2020-01-01T00:00:00.000Z",
      confidence: 0.01,
    });
    const currentMemory = await storage.getMemoryById(id);
    assert.ok(currentMemory, "expected updated memory to exist");
    const orphanPath = storage.buildTierMemoryPath(currentMemory, "cold");
    await mkdir(path.dirname(orphanPath), { recursive: true });
    await writeFile(orphanPath, "orphan from prior failed run", "utf-8");

    storage.migrateMemoryToTier = (async () => {
      throw new Error("move failed before deleting source");
    }) as StorageManager["migrateMemoryToTier"];

    const result = await runFirstStartMigration({ storage, config });

    assert.equal(result.demotedCount, 0);
    assert.equal(result.failureCount, 1);
    await access(currentMemory.path);
    await assert.rejects(() => access(path.join(dir, "state", LIFECYCLE_INIT_DONE_MARKER)));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("first-start migration: retries QMD refresh in-run when pending marker write fails", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-fsm-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();
    const config = makeConfig(dir, {
      qmdTierDemotionMinAgeDays: 1,
      qmdTierDemotionValueThreshold: 0.99,
      qmdColdCollection: "cold-test",
    });

    const id = await storage.writeMemory("fact", "Old low-value fact.", { source: "test" });
    const memory = await storage.getMemoryById(id);
    assert.ok(memory, "expected memory to exist");
    await storage.writeMemoryFrontmatter(memory, {
      updated: "2020-01-01T00:00:00.000Z",
      created: "2020-01-01T00:00:00.000Z",
      confidence: 0.01,
    });

    const pendingMarkerPath = path.join(dir, "state", ".lifecycle-qmd-refresh-pending");
    await mkdir(pendingMarkerPath, { recursive: true });

    let attempts = 0;
    const result = await runFirstStartMigration({
      storage,
      config,
      qmd: {
        updateCollection: async () => {
          attempts += 1;
          if (attempts < 3) throw new Error("qmd unavailable");
        },
        embedCollection: async () => {},
      } as any,
    });

    assert.equal(attempts, 3);
    assert.equal(result.demotedCount, 1);
    assert.equal(result.failureCount, 0);
    await access(path.join(dir, "state", LIFECYCLE_INIT_DONE_MARKER));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("first-start migration: abort signal stops demotions before writing marker", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-fsm-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();
    const config = makeConfig(dir, {
      qmdTierDemotionMinAgeDays: 1,
      qmdTierDemotionValueThreshold: 0.99,
      qmdCollection: "hot-test",
      qmdColdCollection: "cold-test",
    });

    for (let i = 0; i < 2; i++) {
      const id = await storage.writeMemory("fact", `Old low-value fact ${i}.`, { source: "test" });
      const memory = await storage.getMemoryById(id);
      assert.ok(memory, "expected memory to exist");
      await storage.writeMemoryFrontmatter(memory, {
        updated: "2020-01-01T00:00:00.000Z",
        created: "2020-01-01T00:00:00.000Z",
        confidence: 0.01,
      });
    }

    const controller = new AbortController();
    const result = await runFirstStartMigration({
      storage,
      config,
      qmd: {
        updateCollection: async () => {
          controller.abort();
        },
        embedCollection: async () => {},
      } as any,
      signal: controller.signal,
    });

    assert.equal(result.skipped, false);
    assert.equal(result.candidateCount, 2);
    assert.equal(result.demotedCount, 1);

    const markerPath = path.join(dir, "state", LIFECYCLE_INIT_DONE_MARKER);
    await assert.rejects(() => access(markerPath), "marker should not exist after abort");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("first-start migration: FIRST_START_DEMOTION_CAP constant is 50", () => {
  assert.equal(FIRST_START_DEMOTION_CAP, 50);
});
