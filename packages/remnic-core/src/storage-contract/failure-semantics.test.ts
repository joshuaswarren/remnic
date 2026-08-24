/**
 * Issue #1533 — Phase A contract test: failure semantics.
 *
 * Rule 34: reads distinguish empty-dir from unreadable-dir — `{ok:false}` vs
 * `[]`. Where the current surface already does this, we pin it; where it
 * doesn't, we record the gap (for the silent-failures issue) rather than
 * change behavior here.
 *
 * Also pins containment: a FILE where a directory is expected is skipped via
 * lstat().isDirectory(), not existsSync() (rule 24).
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { StorageManager } from "../storage.js";
import { makeStorage } from "./harness.js";

test("failure-semantics: readAllMemories on a fresh (empty) dir returns [] not null", async () => {
  const { storage, cleanup } = await makeStorage();
  try {
    const result = await storage.readAllMemories();
    assert.ok(Array.isArray(result), "readAllMemories must return an array");
    assert.equal(result.length, 0, "empty store must return an empty array");
  } finally {
    await cleanup();
  }
});
test("failure-semantics: readArchivedMemories surfaces archive readdir errors", async () => {
  const { storage, baseDir, cleanup } = await makeStorage();
  try {
    await writeFile(path.join(baseDir, "archive"), "archive is not a directory", "utf-8");
    await assert.rejects(
      storage.readArchivedMemories(),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOTDIR",
    );
  } finally {
    await cleanup();
  }
});

test("failure-semantics: getMemoryById on empty store returns null (not throw)", async () => {
  const { storage, cleanup } = await makeStorage();
  try {
    const result = await storage.getMemoryById("anything");
    assert.equal(result, null);
  } finally {
    await cleanup();
  }
});

test("failure-semantics: selected memory snapshots reject a changed member", async () => {
  const { storage, cleanup } = await makeStorage();
  try {
    const first = await storage.writeMemory("preference", "First source");
    const second = await storage.writeMemory("preference", "Second source");
    const firstSnapshot = await storage.readMemoryByPath(first.memory.path);
    const secondSnapshot = await storage.readMemoryByPath(second.memory.path);
    assert.ok(firstSnapshot);
    assert.ok(secondSnapshot);
    assert.equal(await storage.updateMemory(second.id, "Changed source"), true);

    assert.equal(await storage.readMemorySnapshotsIfUnchanged([firstSnapshot, secondSnapshot]), null);
    assert.deepEqual(
      (await storage.readMemorySnapshotsIfUnchanged([firstSnapshot]))?.map((memory) => memory.frontmatter.id),
      [first.id]
    );
  } finally {
    await cleanup();
  }
});

test("failure-semantics: selected memory snapshots block member writes until every read completes", async () => {
  const { storage, cleanup } = await makeStorage();
  const secondReadStarted = Promise.withResolvers<void>();
  const releaseSecondRead = Promise.withResolvers<void>();
  try {
    const first = await storage.writeMemory("preference", "First source");
    const second = await storage.writeMemory("preference", "Second source");
    const firstSnapshot = await storage.readMemoryByPath(first.memory.path);
    const secondSnapshot = await storage.readMemoryByPath(second.memory.path);
    assert.ok(firstSnapshot);
    assert.ok(secondSnapshot);
    const readMemoryByPath = storage.readMemoryByPath.bind(storage);
    let pauseSecond = true;
    storage.readMemoryByPath = async (filePath) => {
      const memory = await readMemoryByPath(filePath);
      if (pauseSecond && filePath === second.memory.path) {
        pauseSecond = false;
        secondReadStarted.resolve();
        await releaseSecondRead.promise;
      }
      return memory;
    };

    const snapshotPromise = storage.readMemorySnapshotsIfUnchanged([firstSnapshot, secondSnapshot]);
    await secondReadStarted.promise;
    let writeSettled = false;
    const writePromise = storage.updateMemory(first.id, "Changed source").finally(() => {
      writeSettled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(writeSettled, false);

    releaseSecondRead.resolve();
    assert.deepEqual(
      (await snapshotPromise)?.map((memory) => memory.frontmatter.id),
      [first.id, second.id]
    );
    assert.equal(await writePromise, true);
  } finally {
    releaseSecondRead.resolve();
    await cleanup();
  }
});

test("failure-semantics: selected memory snapshot tasks hold every member lock", async () => {
  const { storage, cleanup } = await makeStorage();
  const taskStarted = Promise.withResolvers<void>();
  const releaseTask = Promise.withResolvers<void>();
  try {
    const first = await storage.writeMemory("preference", "First source");
    const second = await storage.writeMemory("preference", "Second source");
    const firstSnapshot = await storage.readMemoryByPath(first.memory.path);
    const secondSnapshot = await storage.readMemoryByPath(second.memory.path);
    assert.ok(firstSnapshot);
    assert.ok(secondSnapshot);

    const snapshotTask = storage.withMemorySnapshotsIfUnchanged(
      [firstSnapshot, secondSnapshot],
      async (memories) => {
        taskStarted.resolve();
        await releaseTask.promise;
        return memories.map((memory) => memory.frontmatter.id);
      },
    );
    await taskStarted.promise;
    let writeSettled = false;
    const writePromise = storage.updateMemoryIfUnchanged(firstSnapshot, "Changed source").finally(() => {
      writeSettled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(writeSettled, false);

    releaseTask.resolve();
    assert.deepEqual(await snapshotTask, [first.id, second.id]);
    assert.ok(await writePromise);
  } finally {
    releaseTask.resolve();
    await cleanup();
  }
});

test("failure-semantics: readMemoryByPath on a non-existent file returns null (not throw)", async () => {
  const { storage, baseDir, cleanup } = await makeStorage();
  try {
    const result = await storage.readMemoryByPath(path.join(baseDir, "facts", "2026-01-01", "nope.md"));
    assert.equal(result, null);
  } finally {
    await cleanup();
  }
});

test("failure-semantics: readMemoryByPath on a malformed markdown file returns null", async () => {
  const { storage, baseDir, cleanup } = await makeStorage();
  try {
    const dir = path.join(baseDir, "facts", "2026-01-01");
    await mkdir(dir, { recursive: true });
    const filePath = path.join(dir, "garbage.md");
    await writeFile(filePath, "this has no frontmatter at all\njust random text", "utf-8");

    const result = await storage.readMemoryByPath(filePath);
    assert.equal(result, null, "malformed file (no frontmatter, not entity) must return null");
  } finally {
    await cleanup();
  }
});

test("failure-semantics: a FILE where a category directory is expected does not crash readAllMemories", async () => {
  // Create a FILE named "facts" (not a directory) at the base dir, then scan.
  // collectActiveMemoryPaths uses lstat().isDirectory() (not existsSync) so a
  // file-as-directory entry is skipped without crashing (rule 24 containment).
  // We do NOT call ensureDirectories — it would try to mkdir facts/<today> and
  // fail on the file. The scan path must be robust independently of dir creation.
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "remnic-fail-file-as-dir-"));
  try {
    StorageManager.clearAllStaticCaches();
    await writeFile(path.join(baseDir, "facts"), "I am a file not a directory", "utf-8");
    const storage = new StorageManager(baseDir);

    const result = await storage.readAllMemories();
    assert.ok(Array.isArray(result));
    assert.equal(result.length, 0, "a file-as-directory must not produce spurious memories");
  } finally {
    StorageManager.clearAllStaticCaches();
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("failure-semantics: invalidateMemory on a missing memory returns false (not throw)", async () => {
  const { storage, cleanup } = await makeStorage();
  try {
    const result = await storage.invalidateMemory("totally-missing-id-99999");
    assert.equal(result, false);
  } finally {
    await cleanup();
  }
});

test("failure-semantics: ensureDirectories is idempotent (safe to call multiple times)", async () => {
  const { storage, cleanup } = await makeStorage();
  try {
    await storage.ensureDirectories();
    await storage.ensureDirectories();
    await storage.ensureDirectories();
  } finally {
    await cleanup();
  }
});
