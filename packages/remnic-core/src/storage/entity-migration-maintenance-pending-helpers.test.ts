import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  clearMaintenancePending,
  drainMaintenanceSettlements,
  ENTITY_MIGRATION_MAINTENANCE_PENDING_PREFIX,
  listMaintenancePending,
  settleMaintenancePending,
  trackMaintenanceSettlement,
  writeMaintenancePending,
} from "./entity-migration-maintenance-pending.js";

async function withStateDir(run: (stateDir: string) => Promise<void>): Promise<void> {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "remnic-3286-marker-unit-"));
  try {
    await run(stateDir);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
}

test("each arm writes its own marker, and listing ignores in-progress temp files", async () => {
  await withStateDir(async (stateDir) => {
    assert.deepEqual(await listMaintenancePending(path.join(stateDir, "missing")), [], "an absent state dir owes nothing");
    const first = await writeMaintenancePending(stateDir);
    const second = await writeMaintenancePending(stateDir);
    assert.notEqual(first, second, "concurrent arms never share a file");
    await writeFile(path.join(stateDir, `${ENTITY_MIGRATION_MAINTENANCE_PENDING_PREFIX}.crashed.tmp`), "partial");
    await writeFile(path.join(stateDir, "entity-canonical-id-migration-v1.json"), "{}");
    assert.deepEqual((await listMaintenancePending(stateDir)).sort(), [first, second].sort());
  });
});

test("clearing named markers never deletes one armed by another run, and tolerates an already-gone name", async () => {
  await withStateDir(async (stateDir) => {
    const mine = await writeMaintenancePending(stateDir);
    const concurrent = await writeMaintenancePending(stateDir);
    await clearMaintenancePending(stateDir, [mine, "entity-canonical-id-maintenance.pending.already-gone"]);
    assert.deepEqual(await listMaintenancePending(stateDir), [concurrent], "the concurrent run's marker survives");
    await clearMaintenancePending(stateDir, [concurrent]);
    assert.deepEqual(await readdir(stateDir), []);
  });
});

test("settling clears on served or no answer, keeps on a refusal or a not-served promise, and propagates a rejection", async () => {
  await withStateDir(async (stateDir) => {
    const cases: Array<[string, boolean | Promise<boolean> | void, boolean]> = [
      ["true", true, true],
      ["nothing", undefined, true],
      ["resolved true", Promise.resolve(true), true],
      ["false", false, false],
      ["resolved false", Promise.resolve(false), false],
    ];
    for (const [label, outcome, clears] of cases) {
      const marker = await writeMaintenancePending(stateDir);
      await settleMaintenancePending(stateDir, [marker], outcome);
      assert.equal((await listMaintenancePending(stateDir)).length, clears ? 0 : 1, label);
      await clearMaintenancePending(stateDir, await listMaintenancePending(stateDir));
    }
    const marker = await writeMaintenancePending(stateDir);
    await assert.rejects(settleMaintenancePending(stateDir, [marker], Promise.reject(new Error("pass failed"))), /pass failed/);
    assert.deepEqual(await listMaintenancePending(stateDir), [marker], "a rejected request keeps the marker");
  });
});

test("tracked settlements can be drained and forgotten once done", async () => {
  await withStateDir(async (stateDir) => {
    const release = Promise.withResolvers<void>();
    let finished = false;
    trackMaintenanceSettlement(
      stateDir,
      release.promise.then(() => {
        finished = true;
      }),
    );
    const drained = drainMaintenanceSettlements(stateDir);
    assert.equal(finished, false);
    release.resolve();
    await drained;
    assert.equal(finished, true);
    await drainMaintenanceSettlements(stateDir);
  });
});
