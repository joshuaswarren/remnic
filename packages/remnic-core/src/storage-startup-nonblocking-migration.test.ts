import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { StorageManager } from "./storage.js";
import { EntityCanonicalIdMigrationRunner } from "./storage/entity-canonical-id-migration-runner.js";
import { sleep } from "./utils/sleep.js";

// Issue #3139 (Q2 briefing 60s ceiling): the CLI briefing path awaits
// orchestrator.initialize(), which awaited storage.ensureDirectories(), which
// awaited the entity canonical-id migration lock/replay (up to a 300s bounded
// wait on a busy lock). Startup READ readiness must not sit behind that
// migration; writes must. These tests pin the boundary with the real on-disk
// migration lock and a real temp corpus — no orchestrator stubs. Every wait is
// bounded so a regression fails fast instead of stalling the run.

const MIGRATION_LOCK_FILE = path.join("state", "entity-canonical-id-migration.lock");
const MIGRATION_JOURNAL_FILE = path.join("state", "entity-canonical-id-migration-v1.json");
const READINESS_BUDGET_MS = 500;
const BARRIER_PROBE_MS = 250;

async function withMemoryDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-startup-migration-"));
  try {
    await run(dir);
  } finally {
    StorageManager.clearAllStaticCaches();
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Hold the migration's own cross-process lock (the exact file
 * migrateLegacyEntityCanonicalIds acquires via withHeldFileLock: poll 50ms,
 * stale 60s — a hold for the lifetime of one test). Returns the release.
 */
async function gateMigration(dir: string): Promise<() => Promise<void>> {
  const lockPath = path.join(dir, MIGRATION_LOCK_FILE);
  await mkdir(path.dirname(lockPath), { recursive: true });
  await writeFile(lockPath, `${process.pid} startup-migration-test ${new Date().toISOString()}\n`);
  return () => unlink(lockPath);
}

async function journalComplete(dir: string): Promise<boolean> {
  try {
    const state = JSON.parse(await readFile(path.join(dir, MIGRATION_JOURNAL_FILE), "utf8")) as {
      complete?: boolean;
    };
    return state.complete === true;
  } catch {
    return false;
  }
}

test("startup read readiness can defer the entity canonical-id migration", async () => {
  await withMemoryDir(async (dir) => {
    const storage = new StorageManager(dir);
    const releaseGate = await gateMigration(dir);
    const readiness = storage.ensureDirectories({ awaitEntityCanonicalMigration: false });
    // Regression: on the awaited path this call sits behind the held lock and
    // only surfaces after the 300s bounded wait. The startup option must
    // settle while the lock is still held — asserted against a bounded race
    // so main fails behaviorally in ~500ms instead of stalling the job.
    let failure: unknown;
    try {
      const outcome = await Promise.race([readiness, sleep(READINESS_BUDGET_MS).then(() => "timeout")]);
      assert.notEqual(outcome, "timeout", "startup read readiness must not wait for the gated migration");
      assert.equal(existsSync(path.join(dir, "entities")), true);
      assert.equal(
        existsSync(path.join(dir, MIGRATION_LOCK_FILE)),
        true,
        "the deferred startup must not take the migration lock",
      );
      assert.equal(
        existsSync(path.join(dir, MIGRATION_JOURNAL_FILE)),
        false,
        "the deferred startup must not run the migration",
      );
    } catch (err) {
      failure = err;
    } finally {
      await releaseGate();
    }
    // The write-side ensure still runs the migration and awaits it.
    await readiness;
    await storage.ensureDirectories();
    if (failure !== undefined) throw failure;
    assert.equal(await journalComplete(dir), true);
    // Normal entity writes still work after the deferred migration settles.
    await storage.writeEntity("Alice", "person", ["Alice works on Remnic"]);
  });
});

test("default ensureDirectories still waits behind a held migration lock", async () => {
  await withMemoryDir(async (dir) => {
    const storage = new StorageManager(dir);
    const releaseGate = await gateMigration(dir);
    let settled = false;
    let setupError: unknown;
    const gatedSetup = storage.ensureDirectories().then(
      () => {
        settled = true;
      },
      (err: unknown) => {
        setupError = err;
        settled = true;
      },
    );
    let failure: unknown;
    try {
      await sleep(BARRIER_PROBE_MS);
      assert.equal(settled, false, "default ensureDirectories must not resolve while the migration lock is held");
    } catch (err) {
      failure = err;
    } finally {
      await releaseGate();
    }
    await gatedSetup;
    assert.equal(setupError, undefined);
    if (failure !== undefined) throw failure;
    assert.equal(await journalComplete(dir), true);
  });
});

test("deferred startup still refuses unsafe entity entries before serving reads", async () => {
  const outside = await mkdtemp(path.join(os.tmpdir(), "remnic-startup-migration-outside-"));
  try {
    await withMemoryDir(async (dir) => {
      const storage = new StorageManager(dir);
      await mkdir(path.join(dir, "entities"), { recursive: true });
      await symlink(path.join(outside, "leaked.md"), path.join(dir, "entities", "leaked.md"));
      await assert.rejects(
        () => storage.ensureDirectories({ awaitEntityCanonicalMigration: false }),
        /Refusing entity canonical-id migration through symlink/,
      );
    });
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
});

test("entity writes queue behind the migration they trigger", async () => {
  await withMemoryDir(async (dir) => {
    const storage = new StorageManager(dir);
    const releaseGate = await gateMigration(dir);
    const readiness = storage.ensureDirectories({ awaitEntityCanonicalMigration: false });
    const { promise: written, resolve: writeSettled } = Promise.withResolvers<void>();
    let writeError: unknown;
    let failure: unknown;
    try {
      const outcome = await Promise.race([readiness, sleep(READINESS_BUDGET_MS).then(() => "timeout")]);
      assert.notEqual(outcome, "timeout", "startup read readiness must not wait for the gated migration");
      // A real entity write must queue behind the migration it triggers — the
      // deferred startup opens READ readiness only.
      storage.writeEntity("Alice", "person", ["Alice works on Remnic"]).then(
        () => writeSettled(),
        (err: unknown) => {
          writeError = err;
          writeSettled();
        },
      );
      const writeProbe = await Promise.race([written, sleep(BARRIER_PROBE_MS).then(() => "pending")]);
      assert.equal(writeProbe, "pending", "entity writes must queue behind the migration they trigger");
    } catch (err) {
      failure = err;
    } finally {
      await releaseGate();
    }
    await readiness;
    await storage.ensureDirectories();
    if (failure === undefined) {
      const settled = await Promise.race([written, sleep(10_000).then(() => "deadline")]);
      assert.notEqual(settled, "deadline", "entity write must complete once the gate releases");
      assert.equal(writeError, undefined);
      const entries = await readdir(path.join(dir, "entities"));
      assert.equal(entries.some((name) => name.endsWith(".md")), true, "entity file must land after the migration settles");
    }
    if (failure !== undefined) throw failure;
  });
});

test("lazy startup mark defers the migration and preserves the unlock trigger", async () => {
  let runs = 0;
  let fail = true;
  const runner = new EntityCanonicalIdMigrationRunner(
    () => true,
    async () => {
      runs += 1;
      if (fail) throw new Error("injected migration failure");
    },
    async () => "static-fingerprint",
  );
  // Before startup marks directories initialized, an unlock-side trigger must
  // stay a no-op (a store that never got past setup must not migrate).
  await runner.triggerAfterUnlock();
  assert.equal(runs, 0);

  // The lazy mark records the bookkeeping WITHOUT starting the migration —
  // no background flight, so no read-only process is held alive by it.
  await runner.markDirectoriesInitialized(false);
  await sleep(BARRIER_PROBE_MS);
  assert.equal(runs, 0, "the lazy startup mark must not start the migration");

  // The unlock trigger still runs the migration, and its failure reaches the
  // caller (the unlock path owns the catch), so nothing is swallowed.
  await assert.rejects(() => runner.triggerAfterUnlock(), /injected migration failure/);
  assert.equal(runs, 1);

  // Single flight: the failed run cleared, the next trigger re-runs and a
  // stable-fingerprint completion is not replayed.
  fail = false;
  await runner.triggerAfterUnlock();
  await runner.triggerAfterUnlock();
  assert.equal(runs, 2);
});
