/**
 * Capsule import/merge cache coherence — issue #1902 (Codex P1).
 *
 * importCapsule() and mergeCapsule() write memory files directly with
 * `writeFile`, bypassing StorageManager's mutation methods. With the
 * version-keyed hot-memories result cache active, a StorageManager whose cache
 * is already warm in the same process would keep serving the pre-import corpus
 * until an unrelated mutation or restart. Both paths must bump the corpus
 * version sentinel after writing so the next readAllMemories() rescans.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { StorageManager } from "../storage.js";
import { exportCapsule } from "./capsule-export.js";
import { importCapsule } from "./capsule-import.js";
import { mergeCapsule } from "./capsule-merge.js";

async function tmp(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

async function writeFact(dir: string, id: string, body: string): Promise<void> {
  await mkdir(path.join(dir, "facts"), { recursive: true });
  await writeFile(path.join(dir, "facts", `${id}.md`), `---\nid: ${id}\n---\n${body}`);
}

test("importCapsule bumps the corpus sentinel so a warm cache surfaces imported records (#1902)", async () => {
  const srcDir = await tmp("cap-src-");
  const dstDir = await tmp("cap-dst-");
  const outDir = await tmp("cap-out-");
  try {
    // Source capsule holds a fact the destination does not yet have.
    await writeFact(srcDir, "fact-imported", "Imported fact content.");
    const exported = await exportCapsule({
      name: "coherence-capsule",
      root: srcDir,
      outDir,
      pluginVersion: "0.0.0-test",
      now: 1_700_000_000_000,
    });

    // Destination starts with one local fact; warm the hot-memories cache.
    await writeFact(dstDir, "fact-local", "Local fact content.");
    const storage = new StorageManager(dstDir);
    const before = await storage.readAllMemories();
    assert.equal(before.length, 1, "warm cache should hold only the local fact");
    assert.ok(before.some((m) => m.frontmatter.id === "fact-local"));

    // Import writes fact-imported directly to disk (out-of-band).
    const result = await importCapsule({
      archivePath: exported.archivePath,
      root: dstDir,
      mode: "skip",
    });
    assert.equal(result.imported.length, 1, "capsule should import one record");

    // The SAME warmed StorageManager must now surface the imported fact —
    // proving the out-of-band write bumped the corpus sentinel and the cache
    // rescanned rather than serving the stale pre-import corpus.
    const after = await storage.readAllMemories();
    const ids = after.map((m) => m.frontmatter.id).sort();
    assert.deepEqual(ids, ["fact-imported", "fact-local"], "imported fact must be visible after import");
  } finally {
    await rm(srcDir, { recursive: true, force: true });
    await rm(dstDir, { recursive: true, force: true });
    await rm(outDir, { recursive: true, force: true });
  }
});

test("mergeCapsule bumps the corpus sentinel so a warm cache surfaces merged records (#1902)", async () => {
  const srcDir = await tmp("cap-src-");
  const dstDir = await tmp("cap-dst-");
  const outDir = await tmp("cap-out-");
  try {
    await writeFact(srcDir, "fact-merged", "Merged fact content.");
    const exported = await exportCapsule({
      name: "coherence-capsule-merge",
      root: srcDir,
      outDir,
      pluginVersion: "0.0.0-test",
      now: 1_700_000_000_100,
    });

    await writeFact(dstDir, "fact-local", "Local fact content.");
    const storage = new StorageManager(dstDir);
    const before = await storage.readAllMemories();
    assert.equal(before.length, 1, "warm cache should hold only the local fact");

    const result = await mergeCapsule({
      sourceArchive: exported.archivePath,
      targetRoot: dstDir,
      conflictMode: "skip-conflicts",
    });
    assert.equal(result.merged.length, 1, "merge should write one record");

    const after = await storage.readAllMemories();
    const ids = after.map((m) => m.frontmatter.id).sort();
    assert.deepEqual(ids, ["fact-local", "fact-merged"], "merged fact must be visible after merge");
  } finally {
    await rm(srcDir, { recursive: true, force: true });
    await rm(dstDir, { recursive: true, force: true });
    await rm(outDir, { recursive: true, force: true });
  }
});
