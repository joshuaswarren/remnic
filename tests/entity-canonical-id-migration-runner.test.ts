import assert from "node:assert/strict";
import test from "node:test";
import { EntityCanonicalIdMigrationRunner } from "../packages/remnic-core/src/storage/entity-canonical-id-migration-runner.js";

test("entity migration runner waits for an in-flight migration during directory initialization", async () => {
  let releaseMigration!: () => void;
  let migrationDone = false;
  const migrationGate = new Promise<void>((resolve) => {
    releaseMigration = () => {
      migrationDone = true;
      resolve();
    };
  });
  let runCount = 0;
  let initializationDone = false;
  const runner = new EntityCanonicalIdMigrationRunner(
    () => true,
    async () => {
      runCount += 1;
      await migrationGate;
    },
  );

  const inFlight = runner.ensure();
  const initialization = runner.markDirectoriesInitialized().then(() => {
    initializationDone = true;
  });
  await Promise.resolve();
  assert.equal(migrationDone, false);
  assert.equal(initializationDone, false);
  releaseMigration();
  await initialization;
  await inFlight;
  assert.equal(migrationDone, true);
  assert.equal(initializationDone, true);
  assert.equal(runCount, 1);
});

test("entity migration runner rechecks after an in-process completion", async () => {
  let runCount = 0;
  const runner = new EntityCanonicalIdMigrationRunner(
    () => true,
    async () => {
      runCount += 1;
    },
  );

  await runner.markDirectoriesInitialized();
  await runner.ensure();
  assert.equal(runCount, 2);
});
