/**
 * Lifecycle matrix subject for the amortized entity migration-completion
 * cache. Exercises the helper only through StorageManager.readEntity — never
 * a direct cache test double.
 */
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { StorageManager } from "../../storage.js";
import { type LifecycleSubject, type MatrixRow, runLifecycleMatrix } from "../lifecycle-matrix.js";
import { mkTempMemoryDir } from "../orchestrator-lite.js";

interface CompletionCacheState {
  dir: string;
  previousId: string;
  reader: StorageManager;
  warmMiss: string;
  afterAlias?: string;
  afterRestart?: string;
}

const subject: LifecycleSubject<CompletionCacheState> = {
  async setup(row: MatrixRow): Promise<CompletionCacheState> {
    const dir = await mkTempMemoryDir(`entity-mig-complete-${row.id}`);
    try {
      const seed = new StorageManager(dir);
      const previousId = await seed.writeEntity("Café", "project", ["Synthetic legacy fact."]);
      await seed.ensureDirectories();
      const reader = new StorageManager(dir);
      await reader.ensureDirectories({ waitForEntityMigration: false });
      return { dir, previousId, reader, warmMiss: "" };
    } catch (error) {
      await rm(dir, { recursive: true, force: true });
      throw error;
    }
  },

  async exercise(state: CompletionCacheState, row: MatrixRow): Promise<void> {
    // Warm the amortized completion verdict on a miss (key + fingerprint path).
    state.warmMiss = await state.reader.readEntity("project-missing");

    await mkdir(path.join(state.dir, "config"), { recursive: true });
    await writeFile(path.join(state.dir, "config", "aliases.json"), JSON.stringify({ café: "coffee" }));
    await state.reader.loadAliases();
    const canonical = state.reader.normalizeEntityName("Café", "project");
    assert.notEqual(canonical, state.previousId, `${row.id}: alias must move the canonical id`);
    state.afterAlias = await state.reader.readEntity(canonical);

    if (row.dimensions.restart) {
      const restarted = new StorageManager(state.dir);
      await restarted.ensureDirectories({ waitForEntityMigration: false });
      await restarted.loadAliases();
      state.afterRestart = await restarted.readEntity(restarted.normalizeEntityName("Café", "project"));
    }

    if (row.dimensions.dedupeOrReplay) {
      // Second miss with stable inputs must stay a cheap empty miss (no throw).
      assert.equal(await state.reader.readEntity("project-missing-again"), "");
    }
  },

  async invariants(state: CompletionCacheState, row: MatrixRow): Promise<void> {
    assert.equal(state.warmMiss, "", `${row.id}: warm miss must return empty`);
    assert.match(
      state.afterAlias ?? "",
      /Synthetic legacy fact/,
      `${row.id}: alias drift must not hide the entity behind a stale completion cache`,
    );
    if (row.dimensions.restart) {
      assert.match(
        state.afterRestart ?? "",
        /Synthetic legacy fact/,
        `${row.id}: restarted reader must still resolve the alias-moved entity`,
      );
    }
  },

  async teardown(state: CompletionCacheState): Promise<void> {
    StorageManager.clearAllStaticCaches();
    await rm(state.dir, { recursive: true, force: true });
  },
};

runLifecycleMatrix("entity-migration-completion-cache", subject);
