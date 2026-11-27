
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { writeMaybeEncryptedFile, readMaybeEncryptedFile } from "../secure-store/secure-fs.js";

test("atomicity: writeMaybeEncryptedFile writes temp-then-rename (no temp files left behind on success)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-atomic-"));
  try {
    const target = path.join(dir, "target.md");
    await writeMaybeEncryptedFile(target, "first content", null, {}, dir);

    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(dir);
    assert.deepEqual(entries.sort(), ["target.md"]);

    await writeMaybeEncryptedFile(target, "second content", null, {}, dir);
    const entries2 = await readdir(dir);
    assert.deepEqual(entries2.sort(), ["target.md"]);

    const read = await readMaybeEncryptedFile(target, null, dir);
    assert.equal(read, "second content");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("atomicity: a failed rename leaves the original file intact (never delete-before-write)", async (t) => {
  if (process.getuid && process.getuid() === 0) {
    t.skip("chmod-based test is unreliable when running as root");
    return;
  }

  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-atomic-fail-"));
  try {
    const target = path.join(dir, "survivor.md");
    await writeMaybeEncryptedFile(target, "original", null, {}, dir);

    await chmod(dir, 0o500);
    try {
      await assert.rejects(
        () => writeMaybeEncryptedFile(target, "would-be-replacement", null, {}, dir),
        // rename (or temp write) fails — the exact error varies by platform
      );

      const survived = await readMaybeEncryptedFile(target, null, dir);
      assert.equal(survived, "original", "original file must survive a failed atomic replace");
    } finally {
      await chmod(dir, 0o700);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("atomicity: StorageManager.updateMemory preserves the original on overwrite success", async (t) => {
  const { StorageManager } = await import("../storage.js");
  const { makeStorage } = await import("./harness.js");
  const { storage, cleanup } = await makeStorage();
  try {
    const { id: id } = await storage.writeMemory("fact", "version one");
    const before = await storage.getMemoryById(id);
    assert.ok(before);
    assert.equal(before!.content, "version one");

    const updated = await storage.updateMemory(id, "version two");
    assert.equal(updated, true);

    const after = await storage.getMemoryById(id);
    assert.ok(after);
    assert.equal(after!.content, "version two");
    assert.equal(after!.frontmatter.id, id);
  } finally {
    await cleanup();
  }
});

test("atomicity: mkdir is implicit — writeMaybeEncryptedFile creates parent dirs", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-atomic-mkdir-"));
  try {
    const target = path.join(dir, "nested", "deep", "file.md");
    await writeMaybeEncryptedFile(target, "content", null, {}, dir);
    const read = await readMaybeEncryptedFile(target, null, dir);
    assert.equal(read, "content");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
