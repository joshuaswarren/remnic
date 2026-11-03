/**
 * Corpus path walk: correctness at corpus scale.
 *
 * The walk collects the `*.md` paths under every category root. It resolves
 * containment once (the memory root) and takes the entry TYPE from the
 * directory listing, so a symlinked category directory, symlinked entry or
 * symlinked file is still skipped while the walk spends one syscall per file
 * instead of two. This test pins the collected path set over a synthetic
 * corpus with nested partitions, Finder junk, a symlinked-out category dir and
 * a symlinked entry, so the syscall reduction cannot change what is collected.
 *
 * The cost of a scan is measured by scripts/bench-corpus-scans.ts.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { StorageManager } from "../packages/remnic-core/src/storage.js";
import { makeSyntheticCorpus } from "./synthetic-corpus.js";

test("the corpus walk collects every in-store memory and nothing else", async () => {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "engram-walk-cost-"));
  const outsideDir = await mkdtemp(path.join(os.tmpdir(), "engram-walk-out-"));
  try {
    await makeSyntheticCorpus({
      rootDir: baseDir,
      days: 3,
      filesPerCategory: 40,
      categories: ["facts", "decisions"],
      coldFiles: 10,
      entityCount: 5,
    });
    // Finder junk and AppleDouble sidecars are not memories.
    await writeFile(path.join(baseDir, "facts", ".DS_Store"), "junk", "utf-8");
    await writeFile(path.join(baseDir, "facts", "._leaked.md"), "junk", "utf-8");
    // A nested partition must still be reached.
    await mkdir(path.join(baseDir, "facts", "2026-01-28", "nested"), { recursive: true });
    await writeFile(path.join(baseDir, "facts", "2026-01-28", "nested", "deep.md"), "---\nid: deep\n---\nbody\n", "utf-8");
    const storage = new StorageManager(baseDir);
    await storage.ensureDirectories();
    // Out-of-store files reachable only through symlinks (planted after
    // ensureDirectories, which refuses a symlinked category root).
    await writeFile(path.join(outsideDir, "leaked.md"), "---\nid: leaked\n---\nbody\n", "utf-8");
    await symlink(outsideDir, path.join(baseDir, "preferences"), "dir");
    await symlink(outsideDir, path.join(baseDir, "facts", "escape"), "dir");
    StorageManager.clearAllStaticCaches();
    storage.invalidateAllMemoriesCacheForDir();

    const paths = await storage.collectActiveMemoryPaths({ propagateReadErrors: true });
    const relative = paths.map((filePath) => path.relative(baseDir, filePath).split(path.sep).join("/"));
    assert.equal(relative.filter((rel) => rel.startsWith("facts/")).length, 40 + 1, "every fact plus the nested memory");
    assert.equal(relative.filter((rel) => rel.startsWith("decisions/")).length, 40, "every decision");
    assert.ok(relative.includes("facts/2026-01-28/nested/deep.md"), "nested partitions are reached");
    assert.ok(!relative.some((rel) => rel.includes("leaked")), "a symlinked-out file never leaks");
    assert.ok(!relative.some((rel) => rel.includes("escape")), "a symlinked-out entry never leaks");
    assert.ok(!relative.some((rel) => rel.endsWith(".DS_Store")), "Finder junk is ignored");
    assert.ok(!relative.some((rel) => path.basename(rel).startsWith("._")), "AppleDouble files are ignored");
  } finally {
    StorageManager.clearAllStaticCaches();
    await rm(baseDir, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
  }
});
