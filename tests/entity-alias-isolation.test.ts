import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { StorageManager, normalizeEntityName } from "../packages/remnic-core/src/storage.js";

async function makeStoreWithAliases(
  aliases: unknown,
): Promise<{ dir: string; storage: StorageManager }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "engram-alias-"));
  await mkdir(path.join(dir, "config"), { recursive: true });
  await writeFile(path.join(dir, "config", "aliases.json"), JSON.stringify(aliases), "utf-8");
  const storage = new StorageManager(dir);
  await storage.loadAliases();
  return { dir, storage };
}

test("alias tables are isolated per StorageManager instance (#1534)", async () => {
  const a = await makeStoreWithAliases({ bobby: "robert-smith" });
  const b = await makeStoreWithAliases({ bobby: "bob-jones" });
  try {
    assert.equal(a.storage.normalizeEntityName("Bobby", "person"), "person-robert-smith");
    assert.equal(b.storage.normalizeEntityName("Bobby", "person"), "person-bob-jones");
    // Re-check A after B loaded: the previous module-global table failed here
    // because whichever store loaded last rewrote every store's aliases.
    assert.equal(a.storage.normalizeEntityName("Bobby", "person"), "person-robert-smith");
  } finally {
    await rm(a.dir, { recursive: true, force: true });
    await rm(b.dir, { recursive: true, force: true });
  }
});

test("free normalizeEntityName has no ambient alias state", async () => {
  const a = await makeStoreWithAliases({ bobby: "robert-smith" });
  try {
    // Without an aliases argument, user aliases never apply.
    assert.equal(normalizeEntityName("Bobby", "person"), "person-bobby");
    // Passing a store's table applies that store's aliases.
    assert.equal(
      normalizeEntityName("Bobby", "person", a.storage.entityAliases),
      "person-robert-smith",
    );
    // Built-in structural aliases still apply with no user table.
    assert.equal(normalizeEntityName("open-claw", "tool"), "tool-openclaw");
    // User aliases take precedence over built-ins.
    assert.equal(normalizeEntityName("open-claw", "tool", { "open-claw": "claw" }), "tool-claw");
  } finally {
    await rm(a.dir, { recursive: true, force: true });
  }
});

test("inherited object keys are not treated as aliases", () => {
  // "constructor"/"tostring" are inherited keys on plain objects; a truthiness
  // lookup without Object.hasOwn resolved them to functions and corrupted the
  // canonical id.
  assert.equal(normalizeEntityName("Constructor", "person", {}), "person-constructor");
  assert.equal(normalizeEntityName("Constructor", "person"), "person-constructor");
  assert.equal(normalizeEntityName("toString", "person", {}), "person-tostring");
});

test("loadAliases drops non-string and empty alias values", async () => {
  const store = await makeStoreWithAliases({ num: 5, empty: "", blank: "   ", ok: "kept" });
  try {
    assert.equal(store.storage.normalizeEntityName("num", "person"), "person-num");
    assert.equal(store.storage.normalizeEntityName("empty", "person"), "person-empty");
    assert.equal(store.storage.normalizeEntityName("blank", "person"), "person-blank");
    assert.equal(store.storage.normalizeEntityName("ok", "person"), "person-kept");
  } finally {
    await rm(store.dir, { recursive: true, force: true });
  }
});

test("construction loads aliases — no explicit loadAliases() call required", async () => {
  // Router-created and ad-hoc StorageManagers (namespace router, operator
  // toolkit, cold storage, ...) never call loadAliases(); the constructor
  // must load the store's own table.
  const dir = await mkdtemp(path.join(os.tmpdir(), "engram-alias-"));
  try {
    await mkdir(path.join(dir, "config"), { recursive: true });
    await writeFile(
      path.join(dir, "config", "aliases.json"),
      JSON.stringify({ bobby: "robert-smith" }),
      "utf-8",
    );
    const storage = new StorageManager(dir);
    assert.equal(storage.normalizeEntityName("Bobby", "person"), "person-robert-smith");
    assert.equal(storage.entityAliases.bobby, "robert-smith");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("reloading re-derives the table — stale aliases never survive a changed file", async () => {
  const store = await makeStoreWithAliases({ bobby: "robert-smith" });
  try {
    assert.equal(store.storage.normalizeEntityName("Bobby", "person"), "person-robert-smith");

    // File becomes an invalid payload: previous table must clear, not linger.
    await writeFile(path.join(store.dir, "config", "aliases.json"), "[]", "utf-8");
    await store.storage.loadAliases();
    assert.equal(store.storage.normalizeEntityName("Bobby", "person"), "person-bobby");

    // File restored with a different mapping: new table applies.
    await writeFile(
      path.join(store.dir, "config", "aliases.json"),
      JSON.stringify({ bobby: "bob-jones" }),
      "utf-8",
    );
    await store.storage.loadAliases();
    assert.equal(store.storage.normalizeEntityName("Bobby", "person"), "person-bob-jones");

    // File removed entirely: back to built-in-only behavior.
    await rm(path.join(store.dir, "config", "aliases.json"), { force: true });
    await store.storage.loadAliases();
    assert.equal(store.storage.normalizeEntityName("Bobby", "person"), "person-bobby");
  } finally {
    await rm(store.dir, { recursive: true, force: true });
  }
});

test("loadAliases tolerates non-object payloads and missing files", async () => {
  for (const payload of ["null", "[1,2]", '"str"']) {
    const dir = await mkdtemp(path.join(os.tmpdir(), "engram-alias-"));
    try {
      await mkdir(path.join(dir, "config"), { recursive: true });
      await writeFile(path.join(dir, "config", "aliases.json"), payload, "utf-8");
      const storage = new StorageManager(dir);
      await storage.loadAliases();
      assert.equal(storage.normalizeEntityName("bobby", "person"), "person-bobby");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  const dir = await mkdtemp(path.join(os.tmpdir(), "engram-alias-"));
  try {
    const storage = new StorageManager(dir);
    await storage.loadAliases();
    assert.equal(storage.normalizeEntityName("open-claw", "tool"), "tool-openclaw");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
