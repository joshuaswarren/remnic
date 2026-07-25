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
  const runner = new EntityCanonicalIdMigrationRunner(
    () => true,
    async () => {
      runCount += 1;
      await migrationGate;
    },
  );

  const inFlight = runner.ensure();
  const initialization = runner.markDirectoriesInitialized();
  await Promise.resolve();
  assert.equal(migrationDone, false);

  releaseMigration();
  await initialization;
  await inFlight;
  assert.equal(migrationDone, true);
  assert.equal(runCount, 1);
});
