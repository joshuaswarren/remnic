import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { WriteQuarantineStore } from "./write-quarantine.js";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "remnic-quarantine-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function isInside(root: string, child: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(child));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

test("quarantine writes a record under state/quarantine and list() returns it", async () => {
  await withTempDir(async (dir) => {
    const store = new WriteQuarantineStore(dir);
    const written = await store.quarantine({
      operation: "memory_store",
      principal: "alice",
      attemptedNamespace: "victim-secret",
      payload: { content: "hello" },
    });

    assert.ok(isInside(path.join(dir, "state", "quarantine"), written));

    const records = await store.list();
    assert.equal(records.length, 1);
    assert.equal(records[0]?.operation, "memory_store");
    assert.equal(records[0]?.principal, "alice");
    assert.equal(records[0]?.attemptedNamespace, "victim-secret");
    assert.deepEqual(records[0]?.payload, { content: "hello" });
  });
});

test("principal with path-traversal characters stays contained in the root", async () => {
  await withTempDir(async (dir) => {
    const store = new WriteQuarantineStore(dir);
    const written = await store.quarantine({
      operation: "observe",
      principal: "../../etc",
      attemptedNamespace: "default",
      payload: { messages: [] },
    });

    assert.ok(isInside(store.root, written), `escaped root: ${written}`);

    // The principal is preserved verbatim in the record even though the
    // on-disk segment is encoded.
    const records = await store.list();
    assert.equal(records.length, 1);
    assert.equal(records[0]?.principal, "../../etc");
  });
});

test("count reflects entries across principals", async () => {
  await withTempDir(async (dir) => {
    const store = new WriteQuarantineStore(dir);
    await store.quarantine({ operation: "memory_store", principal: "alice", attemptedNamespace: "ns", payload: 1 });
    await store.quarantine({ operation: "observe", principal: "bob", attemptedNamespace: "ns", payload: 2 });
    assert.equal(await store.count(), 2);
  });
});

test("maxEntriesPerPrincipal caps a principal bucket", async () => {
  await withTempDir(async (dir) => {
    const store = new WriteQuarantineStore(dir, { maxEntriesPerPrincipal: 2, maxAgeMs: 60 * 60 * 1000 });
    for (let i = 0; i < 5; i++) {
      await store.quarantine({ operation: "memory_store", principal: "alice", attemptedNamespace: "ns", payload: i });
      await store.quarantine({ operation: "memory_store", principal: "bob", attemptedNamespace: "ns", payload: i });
    }
    const records = await store.list();
    // The cap is per principal, not global: two survive for each.
    assert.equal(records.length, 4);
    assert.equal(records.filter((r) => r.principal === "alice").length, 2);
    assert.equal(records.filter((r) => r.principal === "bob").length, 2);
  });
});

test("age cap drops records older than maxAgeMs", async () => {
  await withTempDir(async (dir) => {
    const store = new WriteQuarantineStore(dir, { maxEntriesPerPrincipal: 1000, maxAgeMs: 1_000 });
    const oldPath = await store.quarantine({
      operation: "memory_store",
      principal: "alice",
      attemptedNamespace: "ns",
      payload: "old",
    });
    // Backdate the first record an hour into the past.
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
    await utimes(oldPath, hourAgo, hourAgo);

    // A fresh write into the same bucket triggers the prune.
    await store.quarantine({
      operation: "memory_store",
      principal: "alice",
      attemptedNamespace: "ns",
      payload: "new",
    });

    const records = await store.list();
    assert.equal(records.length, 1);
    assert.equal(records[0]?.payload, "new");
  });
});

test("list() skips malformed and wrong-shape JSON files", async () => {
  await withTempDir(async (dir) => {
    const store = new WriteQuarantineStore(dir);
    await store.quarantine({ operation: "memory_store", principal: "alice", attemptedNamespace: "ns", payload: "ok" });

    // Drop a corrupt file and a valid-JSON-but-wrong-shape file beside the good
    // record in the principal bucket.
    const quarantineRoot = path.join(dir, "state", "quarantine");
    const [principalName] = await readdir(quarantineRoot);
    const principalDir = path.join(quarantineRoot, principalName ?? "");
    await writeFile(path.join(principalDir, "corrupt.json"), "{ not json", "utf8");
    await writeFile(path.join(principalDir, "wrong-shape.json"), "{}", "utf8");

    const records = await store.list();
    assert.equal(records.length, 1);
    assert.equal(records[0]?.payload, "ok");
    assert.equal(await store.count(), 1);
  });
});

test("constructor rejects invalid retention caps", () => {
  assert.throws(() => new WriteQuarantineStore("/tmp/x", { maxEntriesPerPrincipal: 0, maxAgeMs: 1000 }));
  assert.throws(() => new WriteQuarantineStore("/tmp/x", { maxEntriesPerPrincipal: 1.5, maxAgeMs: 1000 }));
  assert.throws(() => new WriteQuarantineStore("/tmp/x", { maxEntriesPerPrincipal: 10, maxAgeMs: Number.NaN }));
  assert.throws(() => new WriteQuarantineStore("/tmp/x", { maxEntriesPerPrincipal: 10, maxAgeMs: 0 }));
});

test("expired records are dropped on read even without a follow-up write", async () => {
  await withTempDir(async (dir) => {
    const store = new WriteQuarantineStore(dir, { maxEntriesPerPrincipal: 1000, maxAgeMs: 1_000 });
    const only = await store.quarantine({
      operation: "memory_store",
      principal: "alice",
      attemptedNamespace: "ns",
      payload: "old",
    });
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
    await utimes(only, hourAgo, hourAgo);

    // No further write; list()/count() must expire it and delete the file.
    assert.equal(await store.count(), 0);
    assert.deepEqual(await store.list(), []);
  });
});

test("a symlinked state directory is not followed outside the memory dir", async () => {
  await withTempDir(async (dir) => {
    const external = await mkdtemp(path.join(tmpdir(), "remnic-quarantine-ext-"));
    try {
      // Replace <memoryDir>/state with a symlink to an external directory.
      await symlink(external, path.join(dir, "state"), "dir");
      const store = new WriteQuarantineStore(dir);

      await assert.rejects(
        store.quarantine({ operation: "memory_store", principal: "alice", attemptedNamespace: "ns", payload: "x" })
      );
      // Nothing was written into the external directory.
      assert.deepEqual(await readdir(external), []);
    } finally {
      await rm(external, { recursive: true, force: true });
    }
  });
});

test("list() surfaces a symlink-escaping root instead of reporting empty", async () => {
  await withTempDir(async (dir) => {
    const external = await mkdtemp(path.join(tmpdir(), "remnic-quarantine-ext-"));
    try {
      // A symlinked `state` that escapes the memory dir must not read back as
      // an empty (all-clear) store — the inspection failure has to surface.
      await symlink(external, path.join(dir, "state"), "dir");
      const store = new WriteQuarantineStore(dir);
      await assert.rejects(store.list());
      await assert.rejects(store.count());
    } finally {
      await rm(external, { recursive: true, force: true });
    }
  });
});
