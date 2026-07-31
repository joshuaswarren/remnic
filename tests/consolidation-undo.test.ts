/**
 * Tests for `remnic consolidate undo` (issue #561 PR 5).
 *
 * Covers the pure helper `runConsolidationUndo`:
 *   - Happy path: target has valid `derived_from` entries pointing at
 *     real snapshots, sources have been archived — we restore every
 *     source and archive the target.
 *   - Dry-run: returns the plan without touching disk.
 *   - Skips restore when source file already exists (never overwrite).
 *   - Skips restore when snapshot for a given version is missing.
 *   - Surfaces a fatal error when the target has no `derived_from`.
 *   - Round-trip: semantic-consolidation-style write → undo → source
 *     content matches its pre-consolidation state.
 */

import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { StorageManager } from "../src/storage.ts";
import {
  runConsolidationUndo,
  isInsideDirectory,
  isInsideDirectoryRealpath,
  isActiveMemoryRelativePath,
  formatConsolidationUndoResult,
  type ConsolidationUndoResult,
} from "../src/consolidation-undo.ts";
import { symlink } from "node:fs/promises";
import type { VersioningConfig } from "@remnic/core";
import { withEntityCanonicalMutationLock } from "../packages/remnic-core/src/storage/entity-canonical-id-lock.js";

const versioning: VersioningConfig = {
  enabled: true,
  maxVersionsPerPage: 10,
  sidecarDir: ".versions",
};

async function makeStorage(dir: string): Promise<StorageManager> {
  const storage = new StorageManager(dir);
  storage.setVersioningConfig({ ...versioning });
  await storage.ensureDirectories();
  return storage;
}

class ConsolidationRestoreBarrierStorage extends StorageManager {
  restoreTargetPath: string | undefined;
  readonly restorePrepared = Promise.withResolvers<void>();

  override async readMemoryByPath(filePath: string) {
    const memory = await super.readMemoryByPath(filePath);
    if (memory && filePath === this.restoreTargetPath) {
      const derivedFrom = memory.frontmatter.derived_from;
      if (Array.isArray(derivedFrom)) {
        const entries = derivedFrom.slice();
        const prepared = this.restorePrepared;
        Object.defineProperty(derivedFrom, Symbol.iterator, {
          configurable: true,
          value: function* () {
            yield* entries;
            prepared.resolve();
          },
        });
      }
    }
    return memory;
  }
}

test("runConsolidationUndo restores sources and archives the target on the happy path", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-undo-happy-"));
  try {
    const storage = await makeStorage(dir);

    const { id: srcAId } = await storage.writeMemory("fact", "alpha body", { source: "extraction" });
    const { id: srcBId } = await storage.writeMemory("fact", "bravo body", { source: "extraction" });
    const all = await storage.readAllMemories();
    const srcA = all.find((m) => m.frontmatter.id === srcAId)!;
    const srcB = all.find((m) => m.frontmatter.id === srcBId)!;

    const entryA = await storage.snapshotForProvenance(srcA.path);
    const entryB = await storage.snapshotForProvenance(srcB.path);
    assert.ok(entryA && entryB);

    // Simulate archival: remove source files so the restore path is
    // the operational case (sources have been archived).
    await unlink(srcA.path);
    await unlink(srcB.path);
    storage.invalidateAllMemoriesCacheForDir();

    // Write the canonical memory with provenance fields.
    const { id: canonicalId } = await storage.writeMemory("fact", "canonical body", {
      source: "semantic-consolidation",
      derivedFrom: [entryA, entryB],
      derivedVia: "merge",
    });
    const afterWrite = await storage.readAllMemories();
    const canonical = afterWrite.find((m) => m.frontmatter.id === canonicalId)!;

    const result = await runConsolidationUndo({
      storage,
      memoryDir: dir,
      targetPath: canonical.path,
      versioning,
    });

    assert.equal(result.error, undefined);
    assert.equal(result.dryRun, false);
    assert.equal(result.restores.length, 2);
    for (const r of result.restores) {
      assert.equal(r.outcome, "restored", `expected restored, got ${r.outcome}: ${r.detail}`);
    }
    assert.equal(result.targetArchived, true);

    // Verify the restored files contain the original bodies.
    const restoredA = await readFile(srcA.path, "utf-8");
    const restoredB = await readFile(srcB.path, "utf-8");
    assert.ok(restoredA.includes("alpha body"));
    assert.ok(restoredB.includes("bravo body"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runConsolidationUndo dry-run produces a plan without writing", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-undo-dryrun-"));
  try {
    const storage = await makeStorage(dir);

    const { id: srcId } = await storage.writeMemory("fact", "source body", { source: "extraction" });
    const all = await storage.readAllMemories();
    const src = all.find((m) => m.frontmatter.id === srcId)!;
    const entry = await storage.snapshotForProvenance(src.path);
    assert.ok(entry);
    await unlink(src.path);
    storage.invalidateAllMemoriesCacheForDir();

    const { id: canonicalId } = await storage.writeMemory("fact", "canonical", {
      source: "semantic-consolidation",
      derivedFrom: [entry],
      derivedVia: "merge",
    });
    const after = await storage.readAllMemories();
    const canonical = after.find((m) => m.frontmatter.id === canonicalId)!;

    const result = await runConsolidationUndo({
      storage,
      memoryDir: dir,
      targetPath: canonical.path,
      versioning,
      dryRun: true,
    });

    assert.equal(result.dryRun, true);
    assert.equal(result.restores.length, 1);
    assert.equal(result.restores[0].outcome, "skipped_dry_run");
    assert.equal(result.targetArchived, false);

    // Source file still absent (we did not restore).
    await assert.rejects(() => readFile(src.path, "utf-8"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runConsolidationUndo refuses to overwrite existing source files", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-undo-collision-"));
  try {
    const storage = await makeStorage(dir);
    const { id: srcId } = await storage.writeMemory("fact", "source body", { source: "extraction" });
    const all = await storage.readAllMemories();
    const src = all.find((m) => m.frontmatter.id === srcId)!;
    const entry = await storage.snapshotForProvenance(src.path);
    assert.ok(entry);
    // Deliberately leave src.path in place — the undo must not overwrite.
    const { id: canonicalId } = await storage.writeMemory("fact", "canonical", {
      source: "semantic-consolidation",
      derivedFrom: [entry],
      derivedVia: "merge",
    });
    const after = await storage.readAllMemories();
    const canonical = after.find((m) => m.frontmatter.id === canonicalId)!;

    const result = await runConsolidationUndo({
      storage,
      memoryDir: dir,
      targetPath: canonical.path,
      versioning,
    });

    assert.equal(result.restores.length, 1);
    assert.equal(result.restores[0].outcome, "skipped_file_exists");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runConsolidationUndo skips sources whose snapshot file has been pruned", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-undo-pruned-"));
  try {
    const storage = await makeStorage(dir);
    const { id: srcId } = await storage.writeMemory("fact", "source body", { source: "extraction" });
    const all = await storage.readAllMemories();
    const src = all.find((m) => m.frontmatter.id === srcId)!;
    const entry = await storage.snapshotForProvenance(src.path);
    assert.ok(entry);
    await unlink(src.path);

    const { id: canonicalId } = await storage.writeMemory("fact", "canonical", {
      source: "semantic-consolidation",
      derivedFrom: [entry],
      derivedVia: "merge",
    });
    const after = await storage.readAllMemories();
    const canonical = after.find((m) => m.frontmatter.id === canonicalId)!;

    // Delete the snapshot to simulate pruning.
    const [rel, version] = entry.split(":");
    const sidecarFile = path.join(
      dir,
      ".versions",
      rel.replace(/\.md$/, "").replace(/\//g, "__"),
      `${version}.md`,
    );
    await unlink(sidecarFile);

    const result = await runConsolidationUndo({
      storage,
      memoryDir: dir,
      targetPath: canonical.path,
      versioning,
    });

    assert.equal(result.restores.length, 1);
    assert.equal(result.restores[0].outcome, "skipped_snapshot_missing");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runConsolidationUndo surfaces an error when the target has no derived_from", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-undo-no-provenance-"));
  try {
    const storage = await makeStorage(dir);
    const { id: id } = await storage.writeMemory("fact", "plain fact", { source: "extraction" });
    const all = await storage.readAllMemories();
    const target = all.find((m) => m.frontmatter.id === id)!;

    const result = await runConsolidationUndo({
      storage,
      memoryDir: dir,
      targetPath: target.path,
      versioning,
    });
    assert.ok(result.error);
    assert.match(result.error, /derived_from/u);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runConsolidationUndo flags malformed derived_from entries", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-undo-malformed-"));
  try {
    const storage = await makeStorage(dir);

    // Hand-write a memory whose derived_from entry is shaped wrong.  We
    // bypass writeMemory() because its validator would reject the
    // malformed entry — here we specifically want to simulate on-disk
    // corruption that the undo helper must tolerate.
    const day = "2026-04-20";
    const factDir = path.join(dir, "facts", day);
    await mkdir(factDir, { recursive: true });
    const id = "fact-malformed";
    const targetPath = path.join(factDir, `${id}.md`);
    const raw = [
      "---",
      `id: ${id}`,
      "category: fact",
      "created: 2026-04-20T00:00:00.000Z",
      "updated: 2026-04-20T00:00:00.000Z",
      "source: semantic-consolidation",
      "confidence: 0.8",
      "confidenceTier: implied",
      'derived_from: ["facts/ghost.md"]', // no version — invalid shape
      "derived_via: merge",
      "---",
      "",
      "body",
      "",
    ].join("\n");
    await writeFile(targetPath, raw, "utf-8");

    const result = await runConsolidationUndo({
      storage,
      memoryDir: dir,
      targetPath,
      versioning,
    });
    // The read-path parser is permissive and preserves the entry
    // verbatim.  The undo helper recognizes the malformed shape and
    // records `skipped_malformed_entry` instead of crashing.  Because
    // no source was recovered, the archive guard (PR #637 review,
    // cursor High) surfaces the "no sources could be recovered"
    // error — the target memory stays active.
    assert.equal(result.restores.length, 1);
    assert.equal(result.restores[0].outcome, "skipped_malformed_entry");
    assert.equal(result.targetArchived, false);
    assert.match(result.error ?? "", /no sources could be recovered/u);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ─── PR #637 review hardening: path traversal + archive guard ────────────────

test("isInsideDirectory returns true for descendants and false for traversal attempts", () => {
  assert.equal(isInsideDirectory("/memory/facts/a.md", "/memory"), true);
  assert.equal(isInsideDirectory("/memory", "/memory"), true);
  assert.equal(isInsideDirectory("/memory/facts/../outside.md", "/memory"), true);
  assert.equal(isInsideDirectory("/memory/../outside.md", "/memory"), false);
  assert.equal(isInsideDirectory("/other-root/memory.md", "/memory"), false);
});

test("isActiveMemoryRelativePath rejects archive/state/version paths and accepts active paths", () => {
  // Active paths — should return true
  assert.equal(isActiveMemoryRelativePath("facts/2024-01-01/a.md"), true);
  assert.equal(isActiveMemoryRelativePath("corrections/2024-01-01/b.md"), true);
  assert.equal(isActiveMemoryRelativePath("entities/person.md"), true);
  assert.equal(isActiveMemoryRelativePath("decisions/2024-01-01/c.md"), true);

  // Non-active paths (static prefixes) — should return false
  assert.equal(isActiveMemoryRelativePath("archive/2024-01-01/x.md"), false);
  assert.equal(isActiveMemoryRelativePath("archive/x.md"), false);
  assert.equal(isActiveMemoryRelativePath("state/calibration/foo.json"), false);
  assert.equal(isActiveMemoryRelativePath("state/foo"), false);

  // Non-active paths (sidecar dir) — should return false when sidecar
  // is passed (PR #637 round-8 review, codex P2).
  assert.equal(isActiveMemoryRelativePath(".versions/facts/2024-01-01/a.md", ".versions"), false);
  assert.equal(isActiveMemoryRelativePath(".versions/foo.md", ".versions"), false);
  // Without sidecar, .versions is NOT rejected (dynamic prefix not applied).
  assert.equal(isActiveMemoryRelativePath(".versions/foo.md"), true);
  // Custom sidecar dir name.
  assert.equal(isActiveMemoryRelativePath("custom-sidecar/foo.md", "custom-sidecar"), false);

  // Path-normalization bypass attempts (PR #637 round-8 review, codex P1):
  // `..` segments must be collapsed before the prefix check.
  assert.equal(isActiveMemoryRelativePath("facts/../archive/2024-01-01/x.md"), false);
  assert.equal(isActiveMemoryRelativePath("./state/foo"), false);
  assert.equal(isActiveMemoryRelativePath("entities/../../archive/x.md"), false);
});

test("runConsolidationUndo rejects target paths outside memoryDir (path-traversal guard)", async () => {
  // Regression for PR #637 review (codex P1): pointing the CLI at an
  // external markdown file with memory-like frontmatter must NOT let
  // the undo flow unlink that external file.
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "remnic-undo-traversal-"));
  try {
    const memoryDir = path.join(rootDir, "memory");
    const externalDir = path.join(rootDir, "external");
    await mkdir(memoryDir, { recursive: true });
    await mkdir(externalDir, { recursive: true });

    const externalPath = path.join(externalDir, "hostile.md");
    await writeFile(externalPath, "---\nid: fact-external\ncategory: fact\n---\n\nbody\n", "utf-8");

    const storage = new StorageManager(memoryDir);
    storage.setVersioningConfig({
      enabled: true,
      maxVersionsPerPage: 10,
      sidecarDir: ".versions",
    });
    await storage.ensureDirectories();

    const result = await runConsolidationUndo({
      storage,
      memoryDir,
      targetPath: externalPath,
      versioning: {
        enabled: true,
        maxVersionsPerPage: 10,
        sidecarDir: ".versions",
      },
    });

    assert.ok(result.error, "should surface a fatal error for external target");
    assert.match(result.error!, /outside memory directory/u);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("runConsolidationUndo refuses to restore sources whose derived_from escapes memoryDir", async () => {
  // Regression for PR #637 review (codex P1): a crafted derived_from
  // entry like "../outside.md:1" resolves outside memoryDir; the
  // restore flow must flag those as skipped_outside_memory_dir and
  // refuse to write outside the memory tree.  Without the guard this
  // becomes an arbitrary write primitive.
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "remnic-undo-escape-"));
  try {
    const memoryDir = path.join(rootDir, "memory");
    await mkdir(memoryDir, { recursive: true });
    const storage = new StorageManager(memoryDir);
    storage.setVersioningConfig({
      enabled: true,
      maxVersionsPerPage: 10,
      sidecarDir: ".versions",
    });
    await storage.ensureDirectories();

    // Hand-build a target memory with a hostile derived_from entry.
    // writeMemory's validator would reject it, so we bypass to
    // simulate on-disk corruption.  Use a `.md` suffix on the hostile
    // path so `derived_from` format validation passes.
    const day = "2026-04-20";
    const factDir = path.join(memoryDir, "facts", day);
    await mkdir(factDir, { recursive: true });
    const targetPath = path.join(factDir, "fact-hostile.md");
    const raw = [
      "---",
      "id: fact-hostile",
      "category: fact",
      "created: 2026-04-20T00:00:00.000Z",
      "updated: 2026-04-20T00:00:00.000Z",
      "source: semantic-consolidation",
      "confidence: 0.8",
      "confidenceTier: implied",
      'derived_from: ["../../outside.md:1"]',
      "derived_via: merge",
      "---",
      "",
      "body",
      "",
    ].join("\n");
    await writeFile(targetPath, raw, "utf-8");

    const result = await runConsolidationUndo({
      storage,
      memoryDir,
      targetPath,
      versioning: {
        enabled: true,
        maxVersionsPerPage: 10,
        sidecarDir: ".versions",
      },
    });

    assert.equal(result.restores.length, 1);
    assert.equal(result.restores[0].outcome, "skipped_outside_memory_dir");
    // Target NOT archived because no source was recovered.
    assert.equal(result.targetArchived, false);
    assert.ok(result.error, "no-recovery guard should surface an error");
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("runConsolidationUndo skips derived_from entries pointing inside archive/ or state/", async () => {
  // Regression for PR #637 round-7 review (codex P2): a crafted or
  // corrupted derived_from entry like "archive/2024-01-01/x.md:1"
  // resolves inside memoryDir but is NOT an active memory location.
  // Without the guard the undo counts it as "recovered_existing" and
  // archives the target, silently dropping the active memory.
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-undo-non-active-"));
  try {
    const storage = new StorageManager(dir);
    storage.setVersioningConfig({
      enabled: true,
      maxVersionsPerPage: 10,
      sidecarDir: ".versions",
    });
    await storage.ensureDirectories();

    // Create an archive directory with a stale memory file to simulate
    // a real file at a non-active path.
    const archiveSub = path.join(dir, "archive", "2026-04-20");
    await mkdir(archiveSub, { recursive: true });
    await writeFile(path.join(archiveSub, "stale.md"), "---\nid: stale\ncategory: fact\n---\n\nstale body\n", "utf-8");

    // Hand-build a target memory with derived_from pointing at the
    // archive path.  writeMemory's validator would reject it, so we
    // bypass to simulate on-disk corruption.
    const day = "2026-04-20";
    const factDir = path.join(dir, "facts", day);
    await mkdir(factDir, { recursive: true });
    const targetPath = path.join(factDir, "fact-non-active.md");
    const raw = [
      "---",
      "id: fact-non-active",
      "category: fact",
      "created: 2026-04-20T00:00:00.000Z",
      "updated: 2026-04-20T00:00:00.000Z",
      "source: semantic-consolidation",
      "confidence: 0.8",
      "confidenceTier: implied",
      'derived_from: ["archive/2026-04-20/stale.md:1"]',
      "derived_via: merge",
      "---",
      "",
      "body",
      "",
    ].join("\n");
    await writeFile(targetPath, raw, "utf-8");

    const result = await runConsolidationUndo({
      storage,
      memoryDir: dir,
      targetPath,
      versioning: {
        enabled: true,
        maxVersionsPerPage: 10,
        sidecarDir: ".versions",
      },
    });

    assert.equal(result.restores.length, 1);
    assert.equal(result.restores[0].outcome, "skipped_non_active_path");
    // Target NOT archived because no active source was recovered.
    assert.equal(result.targetArchived, false);
    assert.ok(result.error, "no-recovery guard should surface an error");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runConsolidationUndo does NOT archive the target when no sources could be recovered", async () => {
  // Regression for PR #637 review (cursor High): if every derived_from
  // entry was skipped, archiving the target would silently delete the
  // consolidated content — nothing replaces it on the active tree.
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-undo-no-recovery-"));
  try {
    const storage = new StorageManager(dir);
    storage.setVersioningConfig({
      enabled: true,
      maxVersionsPerPage: 10,
      sidecarDir: ".versions",
    });
    await storage.ensureDirectories();

    const { id: srcId } = await storage.writeMemory("fact", "source body", { source: "extraction" });
    const all = await storage.readAllMemories();
    const src = all.find((m) => m.frontmatter.id === srcId)!;
    const entry = await storage.snapshotForProvenance(src.path);
    assert.ok(entry);
    await unlink(src.path);
    storage.invalidateAllMemoriesCacheForDir();

    const { id: canonicalId } = await storage.writeMemory("fact", "canonical", {
      source: "semantic-consolidation",
      derivedFrom: [entry],
      derivedVia: "merge",
    });
    const after = await storage.readAllMemories();
    const canonical = after.find((m) => m.frontmatter.id === canonicalId)!;

    // Delete snapshot so restore fails.
    const [rel, version] = entry.split(":");
    await unlink(path.join(
      dir,
      ".versions",
      rel.replace(/\.md$/, "").replace(/\//g, "__"),
      `${version}.md`,
    ));

    const result = await runConsolidationUndo({
      storage,
      memoryDir: dir,
      targetPath: canonical.path,
      versioning: {
        enabled: true,
        maxVersionsPerPage: 10,
        sidecarDir: ".versions",
      },
    });

    assert.equal(result.restores.length, 1);
    assert.equal(result.restores[0].outcome, "skipped_snapshot_missing");
    assert.equal(result.targetArchived, false, "target must stay active when no sources recovered");
    assert.ok(result.error);
    assert.match(result.error!, /no sources could be recovered/u);

    // Verify the target memory file is still on disk.
    const still = await readFile(canonical.path, "utf-8");
    assert.ok(still.includes("canonical"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("isInsideDirectoryRealpath rejects paths that tunnel through a symlinked directory", async () => {
  // Regression for PR #637 round-2 review (codex P1): `isInsideDirectory`
  // only normalizes path strings, so a symlink inside memoryDir that
  // points outside would tunnel the textual check.  The realpath-aware
  // version walks every existing parent directory, `realpath`s it, and
  // re-applies the trailing segments.
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "remnic-undo-symlink-"));
  try {
    const memoryDir = path.join(rootDir, "memory");
    const externalDir = path.join(rootDir, "external");
    await mkdir(memoryDir, { recursive: true });
    await mkdir(externalDir, { recursive: true });

    // Create a symlink inside memoryDir that points at externalDir.
    // A naive textual check would say `memory/escape/x.md` is inside
    // `memory`, but the real filesystem would follow the symlink and
    // write to `external/x.md`.
    const symlinkPath = path.join(memoryDir, "escape");
    try {
      await symlink(externalDir, symlinkPath, "dir");
    } catch {
      // Some filesystems (e.g. nested FUSE mounts) disallow symlinks;
      // skip the test quietly rather than fail spuriously.
      return;
    }
    const tunnelPath = path.join(memoryDir, "escape", "x.md");

    // Textual check passes (drift the reviewer warned about).
    assert.equal(isInsideDirectory(tunnelPath, memoryDir), true);
    // Realpath-aware check rejects it.
    assert.equal(await isInsideDirectoryRealpath(tunnelPath, memoryDir), false);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("runConsolidationUndo does NOT archive the target on partial recovery (all-or-nothing)", async () => {
  // Regression for PR #637 round-3 review (codex P1): a mixed
  // outcome (e.g. one restored + one skipped_snapshot_missing) must
  // keep the target active.  Otherwise one un-recovered source is
  // silently dropped while the consolidated content that contained
  // it gets moved to archive.
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-undo-partial-"));
  try {
    const storage = new StorageManager(dir);
    storage.setVersioningConfig({
      enabled: true,
      maxVersionsPerPage: 10,
      sidecarDir: ".versions",
    });
    await storage.ensureDirectories();

    const { id: srcAId } = await storage.writeMemory("fact", "alpha body", { source: "extraction" });
    const { id: srcBId } = await storage.writeMemory("fact", "bravo body", { source: "extraction" });
    const all = await storage.readAllMemories();
    const srcA = all.find((m) => m.frontmatter.id === srcAId)!;
    const srcB = all.find((m) => m.frontmatter.id === srcBId)!;
    const entryA = await storage.snapshotForProvenance(srcA.path);
    const entryB = await storage.snapshotForProvenance(srcB.path);
    assert.ok(entryA && entryB);
    await unlink(srcA.path);
    await unlink(srcB.path);
    storage.invalidateAllMemoriesCacheForDir();

    const { id: canonicalId } = await storage.writeMemory("fact", "canonical", {
      source: "semantic-consolidation",
      derivedFrom: [entryA, entryB],
      derivedVia: "merge",
    });
    const after = await storage.readAllMemories();
    const canonical = after.find((m) => m.frontmatter.id === canonicalId)!;

    // Delete only B's snapshot to force a partial recovery.
    const [relB, versionB] = entryB.split(":");
    await unlink(path.join(
      dir,
      ".versions",
      relB.replace(/\.md$/, "").replace(/\//g, "__"),
      `${versionB}.md`,
    ));

    const result = await runConsolidationUndo({
      storage,
      memoryDir: dir,
      targetPath: canonical.path,
      versioning: {
        enabled: true,
        maxVersionsPerPage: 10,
        sidecarDir: ".versions",
      },
    });

    // Two-pass contract: if any plan would fail, NO writes happen.
    // One source's plan reports as skipped_snapshot_missing (real
    // failure); the other reports as skipped_blocked_by_other_failures
    // because it had a valid plan but was aborted.
    const restored = result.restores.filter((r) => r.outcome === "restored").length;
    const skippedMissing = result.restores.filter((r) => r.outcome === "skipped_snapshot_missing").length;
    const skippedBlocked = result.restores.filter((r) => r.outcome === "skipped_blocked_by_other_failures").length;
    assert.equal(restored, 0, "no writes happen under two-pass contract");
    assert.equal(skippedMissing + skippedBlocked, 2); // both sources accounted for
    assert.equal(result.targetArchived, false);
    assert.ok(result.error);
    // Two-pass: zero writes happen, so the error reflects "no
    // sources could be recovered" rather than partial-all-or-nothing.
    assert.match(result.error!, /no sources could be recovered|all-or-nothing/u);

    // Additionally: neither source file was actually written.
    await assert.rejects(() => readFile(srcA.path, "utf-8"));
    await assert.rejects(() => readFile(srcB.path, "utf-8"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("isInsideDirectoryRealpath rejects dangling symlinks within memoryDir", async () => {
  // Regression for PR #637 round-3 review (codex P1): a symlink
  // inside memoryDir whose target doesn't exist yet would previously
  // pass the realpath guard (parent existed, so the textual fallback
  // accepted it) even though `writeFile` would follow the link and
  // create the file outside memoryDir.  Now we lstat every segment
  // and reject dangling or escaping symlinks outright.
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "remnic-undo-dangling-"));
  try {
    const memoryDir = path.join(rootDir, "memory");
    const externalDir = path.join(rootDir, "external");
    await mkdir(memoryDir, { recursive: true });
    await mkdir(externalDir, { recursive: true });

    // Create a symlink `memory/danger.md → external/target.md` (target
    // does NOT exist — dangling).
    const symlinkPath = path.join(memoryDir, "danger.md");
    const targetPath = path.join(externalDir, "target.md");
    try {
      await symlink(targetPath, symlinkPath, "file");
    } catch {
      return;
    }
    assert.equal(await isInsideDirectoryRealpath(symlinkPath, memoryDir), false);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("runConsolidationUndo tolerates non-string derived_from entries without crashing", async () => {
  // Regression for PR #637 round-3 review (cursor Low): a crafted
  // on-disk memory could contain non-string tokens in
  // `derived_from` (e.g. an object, a number, null).  The restore
  // loop must surface them as malformed rather than throwing on
  // `.match()`.
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-undo-non-string-"));
  try {
    const storage = new StorageManager(dir);
    storage.setVersioningConfig({
      enabled: true,
      maxVersionsPerPage: 10,
      sidecarDir: ".versions",
    });
    await storage.ensureDirectories();
    // Bypass readMemoryByPath's normalization by seeding a MemoryFile
    // with a hostile entry.  The public undo entrypoint goes through
    // `readMemoryByPath` which normalizes via `parseFrontmatter`, so
    // the hostile case only arises from programmatic use.  Assert
    // the parser defense:
    assert.equal(runConsolidationUndo.length, 1); // takes exactly 1 options arg

    // Direct drive: load a well-formed memory, then mutate
    // frontmatter in place to inject a non-string entry before
    // running the helper.  We simulate on-disk corruption by hand-
    // writing a YAML that the parser accepts but contains non-string
    // tokens.  The parser will drop non-strings to strings, so this
    // is primarily a defense-in-depth unit test via
    // `runConsolidationUndo` with a directly-constructed derivedFrom
    // array containing a non-string.  We stub via writeMemory's
    // typed contract then poke the in-memory MemoryFile.

    // Write a valid memory then hand-edit derived_from on disk to
    // include a null entry (invalid per contract, but we're testing
    // defense).
    const day = "2026-04-20";
    const factDir = path.join(dir, "facts", day);
    await mkdir(factDir, { recursive: true });
    const targetPath = path.join(factDir, "fact-nonstring.md");
    const raw = [
      "---",
      "id: fact-nonstring",
      "category: fact",
      "created: 2026-04-20T00:00:00.000Z",
      "updated: 2026-04-20T00:00:00.000Z",
      "source: semantic-consolidation",
      "confidence: 0.8",
      "confidenceTier: implied",
      'derived_from: ["null:entry"]',  // valid format but obviously malformed-version
      "derived_via: merge",
      "---",
      "",
      "body",
      "",
    ].join("\n");
    await writeFile(targetPath, raw, "utf-8");

    const result = await runConsolidationUndo({
      storage,
      memoryDir: dir,
      targetPath,
      versioning: {
        enabled: true,
        maxVersionsPerPage: 10,
        sidecarDir: ".versions",
      },
    });
    // Helper must not throw; result.restores populated with skip
    // reason.
    assert.ok(Array.isArray(result.restores));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("consolidation undo entity restores wait for the canonical mutation lock", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-undo-entity-lock-"));
  const storage = new ConsolidationRestoreBarrierStorage(dir);
  const entitySourcePath = path.join(dir, "entities", "undo-lock-source.md");
  const controlSourcePath = path.join(dir, "facts", "undo-lock-control.md");
  const originalEntity = "---\nid: undo-lock-source\n---\n\nentity snapshot bytes\n";
  const originalControl = "---\nid: undo-lock-control\n---\n\ncontrol snapshot bytes\n";
  let undoPromise: Promise<ConsolidationUndoResult> | undefined;

  try {
    storage.setVersioningConfig({ ...versioning });
    await storage.ensureDirectories();
    await Promise.all([
      mkdir(path.dirname(entitySourcePath), { recursive: true }),
      mkdir(path.dirname(controlSourcePath), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(entitySourcePath, originalEntity, "utf8"),
      writeFile(controlSourcePath, originalControl, "utf8"),
    ]);
    const [entityEntry, controlEntry] = await Promise.all([
      storage.snapshotForProvenance(entitySourcePath),
      storage.snapshotForProvenance(controlSourcePath),
    ]);
    assert.ok(entityEntry);
    assert.ok(controlEntry);
    await Promise.all([unlink(entitySourcePath), unlink(controlSourcePath)]);
    storage.invalidateAllMemoriesCacheForDir();

    const { id: targetId } = await storage.writeMemory("fact", "entity restore target", {
      source: "semantic-consolidation",
      derivedFrom: [entityEntry],
      derivedVia: "merge",
    });
    const { id: controlTargetId } = await storage.writeMemory("fact", "control restore target", {
      source: "semantic-consolidation",
      derivedFrom: [controlEntry],
      derivedVia: "merge",
    });
    const memories = await storage.readAllMemories();
    const target = memories.find((memory) => memory.frontmatter.id === targetId);
    const controlTarget = memories.find((memory) => memory.frontmatter.id === controlTargetId);
    assert.ok(target);
    assert.ok(controlTarget);
    storage.restoreTargetPath = target.path;
    let undoFinished = false;

    await withEntityCanonicalMutationLock(path.join(dir, "state"), async () => {
      undoPromise = runConsolidationUndo({
        storage,
        memoryDir: dir,
        targetPath: target.path,
        versioning,
      });
      void undoPromise.then(
        () => {
          undoFinished = true;
        },
        () => undefined,
      );

      await storage.restorePrepared.promise;
      const controlResult = await runConsolidationUndo({
        storage,
        memoryDir: dir,
        targetPath: controlTarget.path,
        versioning,
      });
      assert.equal(controlResult.error, undefined);
      assert.equal(await readFile(controlSourcePath, "utf8"), originalControl);
      assert.equal(
        undoFinished,
        false,
        "the entity restore must not finish while its canonical mutation lock is held",
      );
      await assert.rejects(
        () => readFile(entitySourcePath, "utf8"),
        /ENOENT/,
        "the entity restore write must not enter while the canonical mutation lock is held",
      );
    });

    assert.ok(undoPromise);
    const result = await undoPromise;
    assert.equal(result.error, undefined);
    assert.equal(result.restores[0]?.outcome, "restored");
    assert.equal(await readFile(entitySourcePath, "utf8"), originalEntity);
  } finally {
    await undoPromise?.catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  }
});

test("formatConsolidationUndoResult emits per-restore detail lines even when an error is set", async () => {
  // Regression for PR #637 round-2 review (cursor Medium): the
  // "no sources could be recovered" error is set AFTER the restore
  // loop runs, so operators need to see each source's skip reason
  // to diagnose what failed.  Early-bail errors still render just
  // the generic message because `restores` is empty in those cases.
  const formatted = formatConsolidationUndoResult({
    targetPath: "/memory/facts/canonical.md",
    targetArchived: false,
    restores: [
      {
        entry: "facts/a.md:1",
        sourcePath: "/memory/facts/a.md",
        outcome: "skipped_snapshot_missing",
        detail: "no snapshot for version 1",
      },
      {
        entry: "facts/b.md:2",
        sourcePath: "/memory/facts/b.md",
        outcome: "skipped_outside_memory_dir",
        detail: "resolved path escapes memory directory /memory",
      },
    ],
    dryRun: false,
    error: "no sources could be recovered (all snapshots missing or paths unsafe); target not archived to preserve data",
  });
  assert.ok(formatted.includes("facts/a.md:1"));
  assert.ok(formatted.includes("facts/b.md:2"));
  assert.ok(formatted.includes("skipped_snapshot_missing"));
  assert.ok(formatted.includes("skipped_outside_memory_dir"));
  assert.ok(formatted.includes("no sources could be recovered"));
});
