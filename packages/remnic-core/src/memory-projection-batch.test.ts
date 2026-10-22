import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { readProjectedMemoryStates } from "./memory-projection-batch.js";
import { getMemoryProjectionPath, readProjectedMemoryState } from "./memory-projection-store.js";
import { rebuildMemoryProjection } from "./maintenance/rebuild-memory-projection.js";
import { openBetterSqlite3 } from "./runtime/better-sqlite.js";
import { StorageManager } from "./storage.js";

test("projection batches return only requested rows and preserve completeness metadata", async () => {
  const memoryDir = await mkdtemp(path.join(tmpdir(), "remnic-projection-batch-"));
  try {
    assert.equal(readProjectedMemoryStates(memoryDir, ["missing"]), null);
    const storage = new StorageManager(memoryDir);
    await storage.ensureDirectories();
    const source = await storage.writeMemory("fact", "batch source payload", {
      source: "test", tags: ["zeta", "alpha"], entityRef: "person:narwhal", confidence: 0.9,
    });
    const excluded = await storage.writeMemory("fact", "unrequested source payload", { source: "test" });
    await rebuildMemoryProjection({ memoryDir, storage, dryRun: false });

    const batch = readProjectedMemoryStates(memoryDir, new Set([source.id, "missing"]));
    assert.ok(batch);
    assert.deepEqual([...batch.states.keys()], [source.id]);
    assert.equal(batch.states.has(excluded.id), false);
    assert.deepEqual(batch.states.get(source.id), readProjectedMemoryState(memoryDir, source.id));
    assert.deepEqual(batch.states.get(source.id)?.tags, ["alpha", "zeta"]);
    assert.equal(batch.states.get(source.id)?.preview, "batch source payload");
    assert.equal(batch.complete, true);
    assert.ok(Number.isFinite(Date.parse(batch.rebuiltAt ?? "")));
    assert.deepEqual(readProjectedMemoryStates(memoryDir, []), { ...batch, states: new Map() });

    const db = openBetterSqlite3(getMemoryProjectionPath(memoryDir));
    try {
      const stamp = db.prepare("SELECT value FROM meta WHERE key = 'rebuiltAt'").get() as { value: string };
      assert.equal(batch.rebuiltAt, stamp.value);
      db.prepare("UPDATE meta SET value = 'false' WHERE key = 'complete'").run();
      assert.equal(readProjectedMemoryStates(memoryDir, [source.id])?.complete, false);
      db.prepare("DELETE FROM meta WHERE key IN ('complete', 'rebuiltAt')").run();
      const legacy = readProjectedMemoryStates(memoryDir, [source.id]);
      assert.ok(legacy);
      assert.equal(legacy.complete, false);
      assert.equal(legacy.rebuiltAt, null);
      assert.deepEqual(legacy.states, batch.states);
      db.exec("DROP TABLE memory_current");
      assert.equal(readProjectedMemoryStates(memoryDir, [source.id]), null, "unreadable schema must fall back");
    } finally {
      db.close();
    }
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});
