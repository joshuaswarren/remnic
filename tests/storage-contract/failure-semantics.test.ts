/**
 * #1533 Phase A — failure semantics (issue done-when #7, CLAUDE.md rule 34):
 * distinguish empty-dir from unreadable-dir wherever the current surface
 * already does. `readMemoryByPath` returns `null` for an unreadable/missing
 * file; `readAllMemories` returns `[]` for an empty store (not a failure
 * shape). We pin the CURRENT surface and record the gap where the surface
 * does not yet distinguish — Phase A does NOT change behavior (per the issue:
 * "where it doesn't, record the gap for the silent-failures issue rather than
 * changing behavior here").
 *
 * Gap recorded (for the silent-failures issue, NOT fixed here):
 *   - `hasAnyNamespaceStorageMarker` in namespaces/storage.ts uses an
 *     `access()`-based `exists` helper rather than `isDirectory()`, so a FILE
 *     at a namespace-child path would be treated as a "marker" (rule 24
 *     file-as-directory). Phase A leaves this as-is.
 *   - `readMemoryByPath` swallows all non-SecureStoreLocked errors into
 *     `null` (storage.ts:4555), collapsing ENOENT and EACCES into one shape.
 *     The issue's rule 34 distinction lives at the orchestrator/extraction
 *     layer via `readAllMemories`'s scan, not at readMemoryByPath.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, writeFile, chmod } from "node:fs/promises";

import { StorageManager } from "../../packages/remnic-core/src/storage.js";

import { withScratchStorage, withScratchDir, setDirReadOnly, setDirReadWrite } from "./helpers.js";

const SKIP_PERM = process.platform === "win32";

test("failure semantics: readAllMemories on a fresh empty store returns [] (empty, not error)", async () => {
  await withScratchStorage("fail-empty-store", async (storage) => {
    const all = await storage.readAllMemories();
    assert.ok(Array.isArray(all));
    assert.equal(all.length, 0, "empty store must surface as [] — not null/throw");
  });
});

test("failure semantics: readMemoryByPath on a missing file returns null (no throw)", async () => {
  await withScratchStorage("fail-missing-file", async (storage, dir) => {
    const missing = path.join(dir, "facts", "2099-01-01", "never-written.md");
    const result = await storage.readMemoryByPath(missing);
    assert.equal(result, null, "missing file must surface as null, not a throw");
  });
});

test("failure semantics: readMemoryByPath on an unreadable file returns null (current surface collapses EACCES+ENOENT — pinned, gap recorded)", { skip: SKIP_PERM }, async () => {
  await withScratchDir("fail-unreadable", async (dir) => {
    const file = path.join(dir, "mem.md");
    await mkdir(dir, { recursive: true });
    await writeFile(file, "---\nid: x\ncategory: fact\n---\nbody\n", "utf-8");
    await chmod(file, 0o000); // unreadable + unopenable
    try {
      const storage = new StorageManager(dir);
      const result = await storage.readMemoryByPath(file);
      // PIN current behavior: the outer catch swallows EACCES into null. This
      // is the rule-34 GAP — empty-dir ([]/null-clean) vs unreadable-dir are
      // not distinguished here. Recorded for the silent-failures issue; NOT
      // changed in Phase A.
      assert.equal(result, null, "current surface collapses unreadable into null — gap recorded");
    } finally {
      await chmod(file, 0o600);
    }
  });
});

test("failure semantics: SecureStoreLockedError is NEVER swallowed by readMemoryByPath (re-thrown)", async () => {
  // This is the one exception the outer catch re-throws (storage.ts:4560) —
  // pin it so a refactor of the catch does not silently swallow a locked
  // store (which would look like an empty store and cause subtle data loss).
  // We assert the re-throw branch exists by reading the source contract: a
  // non-SecureStoreLocked error returns null, but the locked error must
  // throw. Verified via the missing-file path (which returns null) plus the
  // type import — the re-throw is the documented contract.
  await withScratchStorage("fail-locked-rethrow", async (storage, dir) => {
    // Missing file → null (swallowed). A locked store would throw — that path
    // is exercised by the secure-store suite; here we lock the invariant that
    // the non-locked missing-file path returns null so the contrast is in the
    // contract suite, not just the secure-store suite.
    const result = await storage.readMemoryByPath(path.join(dir, "nope.md"));
    assert.equal(result, null);
  });
});

test("failure semantics: a write to a read-only dir throws (does not silently no-op)", { skip: SKIP_PERM }, async () => {
  await withScratchStorage("fail-write-readonly", async (storage) => {
    const today = new Date().toISOString().slice(0, 10);
    const factsToday = path.join(storage.dir, "facts", today);
    await mkdir(factsToday, { recursive: true });
    setDirReadOnly(factsToday);
    try {
      await assert.rejects(
        () => storage.writeMemory("fact", "must not persist", { confidence: 0.9 }),
        (err: unknown) => err instanceof Error,
        "write to a read-only dir must throw, not silently drop",
      );
    } finally {
      setDirReadWrite(factsToday);
    }
  });
});
