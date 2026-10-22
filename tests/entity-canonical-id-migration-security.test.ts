import assert from "node:assert/strict";
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildBriefing } from "../packages/remnic-core/src/briefing.js";
import { StorageManager } from "../packages/remnic-core/src/storage.js";
import {
  readMaybeEncryptedFile, SecureStoreDecryptError, SecureStoreLockedError, writeMaybeEncryptedFile,
} from "../packages/remnic-core/src/secure-store/secure-fs.js";
import { withHeldFileLock } from "../packages/remnic-core/src/utils/serialize-mutations.js";

const LOCAL = "# Local entity\n\n**Type:** person\n\nLocal content.\n";
const FOREIGN = "# Foreign entity\n\n**Type:** person\n\nFOREIGN-ENTITY-CONTENT\n";

async function fixture(namespaced = false) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-boundary-"));
  const root = namespaced ? path.join(dir, "namespaces", "private") : path.join(dir, "memory");
  const entities = path.join(root, "entities");
  const state = path.join(root, "state");
  await mkdir(entities, { recursive: true });
  await mkdir(state);
  const outside = path.join(dir, "other-store");
  await mkdir(outside);
  await writeFile(path.join(outside, "local.md"), FOREIGN);
  await writeFile(path.join(entities, "local.md"), LOCAL);
  return { dir, root, entities, state, outside, storage: new StorageManager(root) };
}

for (const namespaced of [false, true]) {
  for (const lockHeld of [false, true]) {
    test(`startup and reads reject foreign entity links (namespace=${namespaced}, lock=${lockHeld})`, async () => {
      const f = await fixture(namespaced);
      const acquired = Promise.withResolvers<void>();
      const released = Promise.withResolvers<void>();
      const holder = lockHeld ? withHeldFileLock(path.join(f.state, "entity-canonical-id-migration.lock"),
        { staleMs: 60_000, maxWaitMs: 60_000 }, async () => {
          acquired.resolve();
          await released.promise;
        }) : Promise.resolve();
      try {
        if (lockHeld) await acquired.promise;
        await symlink(path.join(f.outside, "local.md"), path.join(f.entities, "private.md"));
        await assert.rejects(f.storage.ensureDirectories({ waitForEntityMigration: false }), /symlink/i);
        assert.equal(await f.storage.readEntity("local"), LOCAL);
        await assert.rejects(f.storage.readEntity("private"));
        await assert.rejects(f.storage.readAllEntityFiles());
        const briefing = await buildBriefing({ storage: f.storage, maxFollowups: 0 });
        assert.equal(briefing.markdown.includes("FOREIGN-ENTITY-CONTENT"), false);
        await assert.rejects(f.storage.readAllEntityFiles());
      } finally {
        released.resolve();
        await holder;
        await f.storage.drainEntityCanonicalIdMigration();
        await rm(f.dir, { recursive: true, force: true });
      }
    });
  }
}

test("a canonical retry cannot follow a foreign symlink", async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.state, "entity-canonical-id-migration-v1.json"), JSON.stringify({
      version: 1, complete: false, mappings: { legacy: "canonical" },
    }));
    await symlink(path.join(f.outside, "local.md"), path.join(f.entities, "canonical.md"));
    await assert.rejects(f.storage.readEntity("legacy"));
    await assert.rejects(f.storage.readEntity("canonical"));
    await assert.rejects(f.storage.readAllEntityFiles());
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("entity reads reject a replaced parent directory", async () => {
  const f = await fixture();
  try {
    await rename(f.entities, `${f.entities}-original`);
    await symlink(f.outside, f.entities, "dir");
    await assert.rejects(f.storage.readEntity("local"), /unsafe entity directory/);
    await assert.rejects(f.storage.readAllEntityFiles(), /unsafe entity directory/);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("contained encrypted entity reads retain path AAD and error behavior", async () => {
  const f = await fixture();
  try {
    const file = path.join(f.entities, "encrypted.md");
    const key = Buffer.alloc(32, 7);
    await writeMaybeEncryptedFile(file, LOCAL, key, {}, f.root);
    assert.equal(await readMaybeEncryptedFile(file, key, f.root), LOCAL);
    await assert.rejects(readMaybeEncryptedFile(file, null, f.root), SecureStoreLockedError);
    await assert.rejects(readMaybeEncryptedFile(file, Buffer.alloc(32, 8), f.root), SecureStoreDecryptError);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("journal aliases preserve copy-window reads and distinct claimants", async () => {
  const f = await fixture();
  try {
    const journal = path.join(f.state, "entity-canonical-id-migration-v1.json");
    await writeFile(journal, JSON.stringify({
      version: 1, complete: false, mappings: { legacy: "intermediate", intermediate: "canonical" },
    }));
    await writeFile(path.join(f.entities, "legacy.md"), LOCAL);
    assert.equal(await f.storage.readEntity("canonical"), LOCAL);
    assert.equal(await f.storage.readEntity("intermediate"), LOCAL);
    await writeFile(path.join(f.entities, "canonical.md"), LOCAL);
    const once = await f.storage.readAllEntityFiles();
    assert.equal(once.filter((entity) => entity.name === "Local entity").length, 2);
    await writeFile(path.join(f.entities, "legacy.md"), "# Distinct claimant\n\n**Type:** person\n\nDifferent content.\n");
    const fresh = new StorageManager(f.root);
    StorageManager.clearAllStaticCaches();
    const distinct = await fresh.readAllEntityFiles();
    assert.deepEqual(distinct.map((entity) => entity.name).sort(), ["Distinct claimant", "Local entity", "Local entity"]);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});
