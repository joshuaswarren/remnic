import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import {
  runTierMigrateCliCommand,
  runTierStatusCliCommand,
} from "../src/cli.js";
import { parseConfig } from "../src/config.js";
import { Orchestrator } from "../src/orchestrator.js";
import { StorageManager } from "../src/storage.js";
import type { SearchBackend } from "../src/search/port.js";
import type { TierMigrationStatusSnapshot } from "../src/recall-state.js";

test("runTierStatusCliCommand returns coordinator status payload", async () => {
  const expected: TierMigrationStatusSnapshot = {
    updatedAt: "2026-02-28T00:00:00.000Z",
    lastCycle: {
      trigger: "manual",
      scanned: 10,
      migrated: 3,
      promoted: 1,
      demoted: 2,
      limit: 5,
      dryRun: true,
    },
    totals: {
      cycles: 4,
      scanned: 42,
      migrated: 9,
      promoted: 3,
      demoted: 6,
      errors: 0,
    },
  };

  const result = await runTierStatusCliCommand({
    tierMigrationCoordinator: {
      getStatus() {
        return expected;
      },
    },
  });

  assert.deepEqual(result, expected);
});

test("runTierStatusCliCommand accepts the legacy getTierMigrationStatus adapter", async () => {
  const expected: TierMigrationStatusSnapshot = {
    updatedAt: "2026-03-01T00:00:00.000Z",
    lastCycle: {
      trigger: "manual",
      scanned: 4,
      migrated: 1,
      promoted: 0,
      demoted: 1,
      limit: 2,
      dryRun: false,
    },
    totals: {
      cycles: 2,
      scanned: 8,
      migrated: 3,
      promoted: 1,
      demoted: 2,
      errors: 0,
    },
  };

  const result = await runTierStatusCliCommand({
    getTierMigrationStatus() {
      return Promise.resolve(expected);
    },
  });

  assert.deepEqual(result, expected);
});

test("runTierMigrateCliCommand forwards dry-run and limit to coordinator runCycle", async () => {
  const calls: Array<{ dryRun?: boolean; limitOverride?: number; force?: boolean }> = [];
  const result = await runTierMigrateCliCommand(
    {
      tierMigrationCoordinator: {
        async runCycle(_storage, _trigger, options) {
          calls.push(options ?? {});
          return {
            trigger: "manual",
            scanned: 20,
            migrated: 2,
            promoted: 1,
            demoted: 1,
            limit: 7,
            dryRun: options?.dryRun === true,
          };
        },
      },
      // runCycle mock ignores the storage arg — stub satisfies the param type.
      storage: null as unknown as StorageManager,
    },
    { dryRun: true, limit: 7 },
  );

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { dryRun: true, limitOverride: 7, force: false });
  assert.equal(result.limit, 7);
  assert.equal(result.dryRun, true);
});

test("runTierMigrateCliCommand accepts the legacy runTierMigrationNow adapter", async () => {
  const calls: Array<{ dryRun?: boolean; limit?: number }> = [];
  const result = await runTierMigrateCliCommand(
    {
      runTierMigrationNow(options) {
        calls.push(options ?? {});
        return Promise.resolve({
          trigger: "manual",
          scanned: 12,
          migrated: 2,
          promoted: 1,
          demoted: 1,
          limit: 9,
          dryRun: options?.dryRun === true,
        });
      },
    },
    { dryRun: true, limit: 9 },
  );

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { dryRun: true, limit: 9 });
  assert.equal(result.limit, 9);
  assert.equal(result.dryRun, true);
});

test("orchestrator tier migration dry-run reports candidates without moving files", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-cli-tier-migrate-"));
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "engram-cli-tier-migrate-workspace-"));

  try {
    const config = parseConfig({
      openaiApiKey: "sk-test",
      memoryDir,
      workspaceDir,
      qmdEnabled: false,
      qmdTierMigrationEnabled: true,
      qmdTierDemotionMinAgeDays: 0,
      qmdTierDemotionValueThreshold: 1,
      qmdTierPromotionValueThreshold: 1,
    });
    const orchestrator = new Orchestrator(config);
    // Tier migration only invokes updateCollection/embedCollection on the QMD
    // backend; stub those so no real search index is required.
    orchestrator.qmd = {
      updateCollection: async () => {},
      embedCollection: async () => {},
    } as unknown as SearchBackend;

    const storage = orchestrator.storage;
    await storage.writeMemory("fact", "candidate for dry-run migration", { source: "test" });

    const summary = await runTierMigrateCliCommand(orchestrator, { dryRun: true, limit: 1 });
    const hot = await storage.readAllMemories();
    const cold = await new StorageManager(path.join(storage.dir, "cold")).readAllMemories();

    assert.equal(summary.trigger, "manual");
    assert.equal(summary.dryRun, true);
    assert.equal(summary.migrated, 1);
    assert.equal(hot.length, 1);
    assert.equal(cold.length, 0);

    const status = await runTierStatusCliCommand(orchestrator);
    assert.equal(status.lastCycle?.dryRun, true);
    assert.equal(status.lastCycle?.migrated, 1);
    assert.equal(status.totals.migrated, 0);
    assert.equal(status.totals.promoted, 0);
    assert.equal(status.totals.demoted, 0);
    assert.equal(status.totals.cycles >= 1, true);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
    await rm(workspaceDir, { recursive: true, force: true });
  }
});
