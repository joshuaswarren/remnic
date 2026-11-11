import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { StorageManager } from "../storage.js";

/**
 * COS-388c Finding C2: ordinary entity reads must not follow a symlink at
 * `entities/<id>.md` to content outside the memory dir. List skips the
 * same entry. A normal entity file still reads.
 */
test("readEntity refuses entities/evil.md symlink outside the memory dir (C2)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-c2-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-c2-out-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories({ waitForEntityMigration: false });
    const id = await storage.writeEntity("Alice", "person", ["Normal entity inside the store."]);

    await writeFile(path.join(outside, "secret.md"), "OUTSIDE_SECRET_CONTENT\n");
    await symlink(path.join(outside, "secret.md"), path.join(dir, "entities", "evil.md"));

    const evil = await storage.readEntity("evil");
    assert.equal(
      evil.includes("OUTSIDE_SECRET_CONTENT"),
      false,
      "entity read must not return the outside symlink target",
    );
    assert.equal(evil, "", "symlinked entity id is treated as absent, not as escaped content");

    const alice = await storage.readEntity(id);
    assert.match(alice, /Normal entity inside the store/);

    const names = await storage.listEntityNames();
    assert.equal(names.includes("evil"), false, "list must skip the symlinked entity entry");
    assert.ok(names.includes(id), "normal entity remains listable");
  } finally {
    StorageManager.clearAllStaticCaches();
    await rm(dir, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
