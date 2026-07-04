/**
 * #1533 Phase A — atomicity contract (rule 54): replace operations are
 * temp-write + rename, NEVER delete-before-write. The entire storage surface
 * routes writes through `writeMaybeEncryptedFile` (secure-store/secure-fs.ts),
 * which writes to a temp path then renames over the target. If the rename
 * fails, the original file MUST survive.
 *
 * We test the primitive directly (it is the contract every StorageManager
 * write sits on) AND a representative StorageManager.updateMemory call against
 * a locked parent dir.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";

import { writeMaybeEncryptedFile } from "../../packages/remnic-core/src/secure-store/secure-fs.js";
import { withScratchDir, withScratchStorage, setDirReadOnly, setDirReadWrite, PERM_FAULT_INJECTION_AVAILABLE } from "./helpers.js";

const SKIP_ATOMIC = !PERM_FAULT_INJECTION_AVAILABLE;

test("atomic-write (rule 54): writeMaybeEncryptedFile is temp-then-rename — original survives when the write is rejected before the replace", { skip: SKIP_ATOMIC }, async () => {
  await withScratchDir("atomic-primitive", async (dir) => {
    const target = path.join(dir, "mem.md");
    const original = "original body — must survive";
    await writeFile(target, original, "utf-8");

    // Lock the parent dir read-only: the temp file cannot be created inside
    // it, so the atomic write throws at temp CREATION — BEFORE any replace
    // could touch the target. This covers the pre-replace failure phase of
    // rule 54 (no delete-before-write).
    //
    // The post-temp RENAME-failure phase is guaranteed by rename's atomic
    // semantics — a failed rename is a no-op on the target, and the temp is
    // cleaned up in writeMaybeEncryptedFile's catch (secure-fs.ts). Proving it
    // by injection needs --experimental-test-module-mock (not enabled in this
    // suite) or a production test seam, which is outside Phase A's test-only
    // scope; the contract holds by construction there.
    setDirReadOnly(dir);
    try {
      await assert.rejects(
        () => writeMaybeEncryptedFile(target, "new body", null, {}, dir),
        (err: unknown) => err instanceof Error,
        "writeMaybeEncryptedFile must throw when the parent dir rejects temp creation",
      );

      // The invariant: original content byte-identical (no delete-before-write).
      const after = await readFile(target, "utf-8");
      assert.equal(after, original, "rule 54 violated: original file altered by a failed write");
    } finally {
      setDirReadWrite(dir);
    }
  });
});

test("atomic-write (rule 54): successful replace leaves no temp file behind", async () => {
  await withScratchDir("atomic-no-leak", async (dir) => {
    const target = path.join(dir, "mem.md");
    await mkdir(dir, { recursive: true });

    await writeMaybeEncryptedFile(target, "v1", null, {}, dir);
    await writeMaybeEncryptedFile(target, "v2", null, {}, dir);

    const after = await readFile(target, "utf-8");
    assert.equal(after, "v2");
    // The temp path shape is `<target>.tmp-<pid>-<ts>` — assert none linger.
    const entries = await readdir(dir);
    const tmpLeak = entries.filter((e) => e.includes(".tmp-"));
    assert.deepEqual(tmpLeak, [], `temp file leaked after atomic rename: ${tmpLeak.join(", ")}`);
  });
});

test("atomic-write (rule 54): StorageManager.updateMemory against a locked parent dir leaves the original file intact", { skip: SKIP_ATOMIC }, async () => {
  await withScratchStorage("atomic-update-memory", async (storage, dir) => {
    const id = await storage.writeMemory("fact", "original fact body", { confidence: 0.9 });
    const mem = await storage.getMemoryById(id);
    assert.ok(mem);
    const target = mem!.path;
    const parent = path.dirname(target);

    // Lock the parent dir so updateMemory's atomic replace cannot land a temp
    // file. updateMemory must throw AND the original content must survive.
    setDirReadOnly(parent);
    try {
      await assert.rejects(
        () => storage.updateMemory(id, "amended body"),
        (err: unknown) => err instanceof Error,
      );
      const after = await readFile(target, "utf-8");
      assert.ok(after.includes("original fact body"), "rule 54: original content altered by failed updateMemory");
    } finally {
      setDirReadWrite(parent);
    }
  });
});

test("atomic-write (rule 54): fresh write to a locked dir throws and writes nothing", { skip: SKIP_ATOMIC }, async () => {
  await withScratchStorage("atomic-fresh-write", async (storage) => {
    // Lock the facts/<today> dir before the write so the temp file cannot land.
    const today = new Date().toISOString().slice(0, 10);
    const factsToday = path.join(storage.dir, "facts", today);
    await mkdir(factsToday, { recursive: true });
    setDirReadOnly(factsToday);
    try {
      await assert.rejects(
        () => storage.writeMemory("fact", "must not persist", { confidence: 0.9 }),
        (err: unknown) => err instanceof Error,
      );
      const all = await storage.readAllMemories();
      assert.equal(all.length, 0, "a failed atomic write must not leave a half-written memory");
    } finally {
      setDirReadWrite(factsToday);
    }
  });
});
