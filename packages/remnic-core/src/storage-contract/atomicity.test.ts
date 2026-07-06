/**
 * Issue #1533 — Phase A contract test: atomic write semantics.
 *
 * Rule 54 (CLAUDE.md): replace operations MUST write temp-then-rename, NEVER
 * delete-before-write. This test pins that invariant by making rename fail
 * (read-only target directory) and asserting the original file survives the
 * failed overwrite.
 *
 * The atomic write primitive lives in secure-fs (`writeMaybeEncryptedFile`)
 * and is consumed by StorageManager via `writeStorageSecureFile`. We test the
 * primitive directly here because it is the single atomicity seam every write
 * entry point depends on.
 */

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

    // No temp files left behind
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(dir);
    assert.deepEqual(entries.sort(), ["target.md"]);

    // Overwrite — still only the target, no leftover temp
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
  // Skip on root — chmod restrictions don't apply.
  if (process.getuid && process.getuid() === 0) {
    t.skip("chmod-based test is unreliable when running as root");
    return;
  }

  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-atomic-fail-"));
  try {
    const target = path.join(dir, "survivor.md");
    await writeMaybeEncryptedFile(target, "original", null, {}, dir);

    // Make the directory read-only so the rename into place fails.
    await chmod(dir, 0o500);
    try {
      await assert.rejects(
        () => writeMaybeEncryptedFile(target, "would-be-replacement", null, {}, dir),
        // rename (or temp write) fails — the exact error varies by platform
      );

      // THE CONTRACT: the original file must still be readable with its
      // original content. Delete-before-write would have destroyed it before
      // the failed rename.
      const survived = await readMaybeEncryptedFile(target, null, dir);
      assert.equal(survived, "original", "original file must survive a failed atomic replace");
    } finally {
      // Restore perms so cleanup works.
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
    const id = await storage.writeMemory("fact", "version one");
    const before = await storage.getMemoryById(id);
    assert.ok(before);
    assert.equal(before!.content, "version one");

    const updated = await storage.updateMemory(id, "version two");
    assert.equal(updated, true);

    const after = await storage.getMemoryById(id);
    assert.ok(after);
    assert.equal(after!.content, "version two");
    // The id is stable across the update (same file path, not a new memory)
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
