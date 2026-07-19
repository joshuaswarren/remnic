import assert from "node:assert/strict";
import test from "node:test";
import { lstat, mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ensureContainedSpillDir, listContainedSpillFiles } from "./path-containment.js";

test("ensureContainedSpillDir creates and accepts a real (absent then present) directory", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-spill-real-dir-"));
  try {
    const spillDir = path.join(root, "state", "ledger.jsonl.pending.d");
    // Absent: created recursively.
    await ensureContainedSpillDir(spillDir);
    assert.equal((await stat(spillDir)).isDirectory(), true, "spill dir created as a real directory");
    // A file may be written into it.
    await writeFile(path.join(spillDir, "a.jsonl"), "row\n", "utf8");
    // Idempotent: an already-present real directory is accepted unchanged.
    await ensureContainedSpillDir(spillDir);
    assert.deepEqual(await readdir(spillDir), ["a.jsonl"], "existing contents preserved");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ensureContainedSpillDir refuses a symlinked spill directory before any write", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-spill-symlink-dir-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "remnic-spill-symlink-outside-"));
  try {
    const spillDir = path.join(root, "ledger.jsonl.pending.d");
    await symlink(outside, spillDir);
    await assert.rejects(
      () => ensureContainedSpillDir(spillDir),
      /symlinked or non-directory/,
      "a symlinked spill directory must be refused",
    );
    assert.equal((await lstat(spillDir)).isSymbolicLink(), true, "symlink left intact");
    assert.deepEqual(await readdir(outside), [], "nothing written through the symlink");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("ensureContainedSpillDir refuses a non-directory path at the spill location", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-spill-nondir-"));
  try {
    // A regular file sitting where the spill directory should be.
    const spillDir = path.join(root, "ledger.jsonl.pending.d");
    await writeFile(spillDir, "not a dir\n", "utf8");
    await assert.rejects(
      () => ensureContainedSpillDir(spillDir),
      /symlinked or non-directory|EEXIST|ENOTDIR/,
      "a non-directory spill location must be refused",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("listContainedSpillFiles and ensureContainedSpillDir enforce the same symlink guard", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-spill-parity-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "remnic-spill-parity-outside-"));
  try {
    await writeFile(path.join(outside, "leak.jsonl"), "leak\n", "utf8");
    const spillDir = path.join(root, "ledger.jsonl.pending.d");
    await symlink(outside, spillDir);
    // Read side skips a symlinked dir (returns []); write side refuses it.
    assert.deepEqual(await listContainedSpillFiles(spillDir), [], "read side skips symlinked dir");
    await assert.rejects(() => ensureContainedSpillDir(spillDir), /symlinked or non-directory/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
