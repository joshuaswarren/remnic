/**
 * Per-session buffer persistence (storage layer).
 *
 * The legacy buffer persistence rewrote the WHOLE state/buffer.json — every
 * session's turns — on every buffer save, which on long-running daemons meant
 * serializing 100+ MB per observe. These tests pin the replacement contract:
 *
 *   - one file per session under `<memoryDir>/state/buffer/`,
 *   - incremental `saveBufferSession` / `deleteBufferSession` for the hot path,
 *   - whole-state `saveBuffer` as a full reconcile (used at correctness
 *     boundaries and by legacy callers),
 *   - one-time migration from the legacy single-file format, safe when a crash
 *     lands mid-migration (per-session file wins over the legacy snapshot),
 *   - per-session writes do NOT run the heavyweight `ensureDirectories()`
 *     pass (the realpath/lstat storm) — they mkdir only what the write needs.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { StorageManager } from "./storage.js";
import type { BufferEntryState, BufferState } from "./types.js";

async function tempRoot(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
}

function makeEntry(turnContent: string, extractionCount = 0): BufferEntryState {
  return {
    turns: [
      {
        role: "user",
        content: turnContent,
        timestamp: "2026-10-29T12:00:00.000Z",
        sessionKey: "session-a",
      },
    ],
    lastExtractionAt: extractionCount > 0 ? "2026-10-29T12:01:00.000Z" : null,
    extractionCount,
  };
}

test("saveBufferSession writes one file per session and loadBuffer reads it back", async () => {
  const root = await tempRoot("bufio-sessions");
  try {
    const storage = new StorageManager(root);
    await storage.saveBufferSession("session-a", makeEntry("alpha fact"));

    const bufferDir = path.join(root, "state", "buffer");
    const names = await readdir(bufferDir);
    assert.equal(names.length, 1, `expected exactly one session file, got ${names.join(",")}`);

    const state = await storage.loadBuffer();
    assert.equal(state.entries?.["session-a"]?.turns.length, 1);
    assert.equal(state.entries?.["session-a"]?.turns[0]?.content, "alpha fact");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("saving session B leaves session A's file byte-identical", async () => {
  const root = await tempRoot("bufio-isolation");
  try {
    const storage = new StorageManager(root);
    await storage.saveBufferSession("session-a", makeEntry("alpha fact"));
    const dir = path.join(root, "state", "buffer");
    const [aName] = await readdir(dir);
    const before = await readFile(path.join(dir, aName));
    const beforeStat = await stat(path.join(dir, aName));

    await storage.saveBufferSession("session-b", makeEntry("beta fact"));
    const after = await readFile(path.join(dir, aName));
    const afterStat = await stat(path.join(dir, aName));
    assert.deepEqual(after, before, "session A file content changed when session B was saved");
    assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs, "session A file was rewritten when session B was saved");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("deleteBufferSession removes the file and loadBuffer drops the session", async () => {
  const root = await tempRoot("bufio-delete");
  try {
    const storage = new StorageManager(root);
    await storage.saveBufferSession("session-a", makeEntry("alpha fact"));
    await storage.deleteBufferSession("session-a");
    const state = await storage.loadBuffer();
    assert.equal(state.entries?.["session-a"], undefined);
    // Deleting an absent session is a no-op, not a throw (idempotent cleanup).
    await storage.deleteBufferSession("session-a");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy state/buffer.json migrates to per-session files exactly once", async () => {
  const root = await tempRoot("bufio-migrate");
  try {
    const stateDir = path.join(root, "state");
    await mkdir(stateDir, { recursive: true });
    const legacy: BufferState = {
      turns: [{ role: "user", content: "default turn", timestamp: "2026-10-29T12:00:00.000Z", sessionKey: "default" }],
      lastExtractionAt: null,
      extractionCount: 2,
      entries: {
        default: {
          turns: [{ role: "user", content: "default turn", timestamp: "2026-10-29T12:00:00.000Z", sessionKey: "default" }],
          lastExtractionAt: null,
          extractionCount: 2,
        },
        "session-a": makeEntry("alpha fact"),
      },
    };
    await writeFile(path.join(stateDir, "buffer.json"), JSON.stringify(legacy), "utf8");

    const storage = new StorageManager(root);
    const loaded = await storage.loadBuffer();
    assert.equal(loaded.entries?.["session-a"]?.turns[0]?.content, "alpha fact");
    assert.equal(loaded.entries?.default?.extractionCount, 2);

    // Migration is materialized: per-session files exist, the legacy file is gone.
    const names = await readdir(path.join(stateDir, "buffer"));
    assert.equal(names.filter((n) => n.endsWith(".json")).length, 2, "expected one file per legacy entry");
    await assert.rejects(stat(path.join(stateDir, "buffer.json")), { code: "ENOENT" });

    // Second load reads purely from the per-session files.
    const reloaded = await storage.loadBuffer();
    assert.equal(reloaded.entries?.["session-a"]?.turns[0]?.content, "alpha fact");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("crash mid-migration: existing per-session file wins over the legacy snapshot", async () => {
  const root = await tempRoot("bufio-migrate-crash");
  try {
    const stateDir = path.join(root, "state");
    await mkdir(path.join(stateDir, "buffer"), { recursive: true });
    // Session A was already migrated (with a NEWER turn) before the crash;
    // the legacy file still holds the older snapshot for both sessions.
    await storage_writeSession(stateDir, "session-a", makeEntry("alpha fact NEW"));
    const legacy: BufferState = {
      turns: [],
      lastExtractionAt: null,
      extractionCount: 0,
      entries: {
        "session-a": makeEntry("alpha fact OLD"),
        "session-b": makeEntry("beta fact"),
      },
    };
    await writeFile(path.join(stateDir, "buffer.json"), JSON.stringify(legacy), "utf8");

    const storage = new StorageManager(root);
    const loaded = await storage.loadBuffer();
    assert.equal(loaded.entries?.["session-a"]?.turns[0]?.content, "alpha fact NEW");
    assert.equal(loaded.entries?.["session-b"]?.turns[0]?.content, "beta fact");
    await assert.rejects(stat(path.join(stateDir, "buffer.json")), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function storage_writeSession(stateDir: string, key: string, entry: BufferEntryState): Promise<void> {
  // Written directly (pre-migration crash simulation) using the same file naming
  // the storage layer derives; the storage instance is created after setup.
  const encoded = encodeURIComponent(key);
  await writeFile(
    path.join(stateDir, "buffer", `${encoded}.json`),
    JSON.stringify({ key, ...entry }),
    "utf8",
  );
}

test("whole-state saveBuffer reconciles per-session files (writes, deletes stale)", async () => {
  const root = await tempRoot("bufio-reconcile");
  try {
    const storage = new StorageManager(root);
    await storage.saveBufferSession("session-a", makeEntry("alpha fact"));
    await storage.saveBufferSession("session-gone", makeEntry("stale fact"));

    await storage.saveBuffer({
      turns: [],
      lastExtractionAt: null,
      extractionCount: 0,
      entries: { "session-a": makeEntry("alpha fact v2") },
    });

    const state = await storage.loadBuffer();
    assert.equal(state.entries?.["session-a"]?.turns[0]?.content, "alpha fact v2");
    assert.equal(state.entries?.["session-gone"], undefined, "stale session file survived a whole-state reconcile");
    const names = await readdir(path.join(root, "state", "buffer"));
    // Reconcile materializes the "default" entry too (legacy semantics: the
    // top-level state IS the default session), so expect exactly those two.
    assert.deepEqual(
      names.filter((n) => n.endsWith(".json")).sort(),
      [`${encodeURIComponent("session-a")}.json`, "default.json"].sort(),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a corrupt per-session file is skipped; the rest of the buffer loads", async () => {
  const root = await tempRoot("bufio-corrupt-file");
  try {
    const storage = new StorageManager(root);
    await storage.saveBufferSession("session-a", makeEntry("alpha fact"));
    await storage.saveBufferSession("session-b", makeEntry("beta fact"));
    const dir = path.join(root, "state", "buffer");
    const names = (await readdir(dir)).filter((n) => n.includes(encodeURIComponent("session-b")));
    await writeFile(path.join(dir, names[0]), "{not json", "utf8");

    const state = await storage.loadBuffer();
    assert.equal(state.entries?.["session-a"]?.turns[0]?.content, "alpha fact");
    assert.equal(state.entries?.["session-b"], undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a corrupt session file is replaced by the legacy snapshot during migration", async () => {
  const root = await tempRoot("bufio-corrupt-plus-legacy");
  try {
    const stateDir = path.join(root, "state");
    await mkdir(path.join(stateDir, "buffer"), { recursive: true });
    await writeFile(
      path.join(stateDir, "buffer", `${encodeURIComponent("session-a")}.json`),
      "{not json",
      "utf8",
    );
    const legacy: BufferState = {
      turns: [],
      lastExtractionAt: null,
      extractionCount: 0,
      entries: { "session-a": makeEntry("alpha fact") },
    };
    await writeFile(path.join(stateDir, "buffer.json"), JSON.stringify(legacy), "utf8");

    const storage = new StorageManager(root);
    const loaded = await storage.loadBuffer();
    assert.equal(loaded.entries?.["session-a"]?.turns[0]?.content, "alpha fact");
    await assert.rejects(stat(path.join(stateDir, "buffer.json")), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("corrupt legacy buffer.json with no session files still throws (reset path preserved)", async () => {
  const root = await tempRoot("bufio-corrupt-legacy");
  try {
    const stateDir = path.join(root, "state");
    await mkdir(stateDir, { recursive: true });
    await writeFile(path.join(stateDir, "buffer.json"), "{not json", "utf8");
    const storage = new StorageManager(root);
    await assert.rejects(() => storage.loadBuffer());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("per-session save does not run the heavyweight ensureDirectories pass", async () => {
  const root = await tempRoot("bufio-light-save");
  try {
    const storage = new StorageManager(root);
    await storage.saveBufferSession("session-a", makeEntry("alpha fact"));
    // ensureDirectories() materializes facts/, entities/, questions/, ... — a
    // per-session buffer write must only need state/buffer/.
    assert.equal(await exists(path.join(root, "entities")), false, "entities dir created by a buffer session save");
    assert.equal(await exists(path.join(root, "questions")), false, "questions dir created by a buffer session save");
    const state = await storage.loadBuffer();
    assert.equal(state.entries?.["session-a"]?.turns[0]?.content, "alpha fact");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

test("session file names round-trip awkward buffer keys", async () => {
  const root = await tempRoot("bufio-awkward-keys");
  try {
    const storage = new StorageManager(root);
    const keys = ["default", "agent:main:abc123", "weird /slash/key", "__proto__", "unicode-ключ-🔑"];
    for (const [i, key] of keys.entries()) {
      await storage.saveBufferSession(key, makeEntry(`fact-${i}`));
    }
    const state = await storage.loadBuffer();
    for (const [i, key] of keys.entries()) {
      assert.equal(state.entries?.[key]?.turns[0]?.content, `fact-${i}`, `key ${key} did not round-trip`);
    }
    const names = await readdir(path.join(root, "state", "buffer"));
    assert.equal(names.filter((n) => n.endsWith(".json")).length, keys.length, "two keys collided into one file");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
