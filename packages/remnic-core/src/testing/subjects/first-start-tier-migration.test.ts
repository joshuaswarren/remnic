import assert from "node:assert/strict";

import { parseConfig } from "../../config.js";
import {
  type FirstStartMigrationResult,
  runFirstStartMigration,
} from "../../maintenance/first-start-migration.js";
import { StorageManager } from "../../storage.js";
import type { PluginConfig } from "../../types.js";
import { type LifecycleSubject, type MatrixRow, runLifecycleMatrix } from "../lifecycle-matrix.js";
import { cleanupDir, mkTempMemoryDir } from "../orchestrator-lite.js";

interface FirstStartTierMigrationState {
  dir: string;
  id: string;
  storage: StorageManager;
  config: PluginConfig;
  result?: FirstStartMigrationResult;
}

const subject: LifecycleSubject<FirstStartTierMigrationState> = {
  appliesTo(row: MatrixRow): boolean | string {
    return row.id === "restart-reload-recovery"
      ? true
      : "first-start tier migration applies only to startup recovery";
  },

  async setup(row: MatrixRow): Promise<FirstStartTierMigrationState> {
    const dir = await mkTempMemoryDir(`first-start-tier-${row.id}`);
    try {
      const storage = new StorageManager(dir);
      await storage.ensureDirectories();
      const { id } = await storage.writeMemory("fact", "old low-value fact", {
        confidence: 0.01,
        source: "test",
      });
      const memory = await storage.getMemoryById(id);
      assert.ok(memory);
      await storage.writeMemoryFrontmatter(memory, {
        created: "2020-01-01T00:00:00.000Z",
        updated: "2020-01-01T00:00:00.000Z",
      });
      const config = parseConfig({
        openaiApiKey: "sk-test",
        memoryDir: dir,
        workspaceDir: dir,
        qmdEnabled: false,
        lifecyclePolicyEnabled: true,
        qmdTierMigrationEnabled: true,
        qmdTierDemotionMinAgeDays: 1,
        qmdTierDemotionValueThreshold: 0.99,
      });
      return { dir, id, storage: new StorageManager(dir), config };
    } catch (error) {
      await cleanupDir(dir);
      throw error;
    }
  },

  async exercise(state: FirstStartTierMigrationState): Promise<void> {
    state.result = await runFirstStartMigration({ storage: state.storage, config: state.config });
  },

  async invariants(state: FirstStartTierMigrationState): Promise<void> {
    assert.equal(state.result?.demotedCount, 1);
    assert.ok((await state.storage.readAllColdMemories()).some((memory) => memory.frontmatter.id === state.id));
    assert.ok(!(await state.storage.readAllMemories()).some((memory) => memory.frontmatter.id === state.id));
  },

  async teardown(state: FirstStartTierMigrationState): Promise<void> {
    await cleanupDir(state.dir);
  },
};

runLifecycleMatrix("first-start-tier-migration", subject);
