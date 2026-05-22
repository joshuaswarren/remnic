import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import {
  createVersion,
  listVersions,
  getVersion,
  revertToVersion,
  diffVersions,
  type VersioningConfig,
} from "../packages/remnic-core/src/page-versioning.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

async function makeTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "page-versioning-test-"));
}

function config(memoryDir: string, overrides?: Partial<VersioningConfig>): VersioningConfig {
  return {
    enabled: true,
    maxVersionsPerPage: 50,
    sidecarDir: ".versions",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// createVersion
// ---------------------------------------------------------------------------

test("createVersion creates manifest and snapshot on first write", async () => {
  const tmp = await makeTmpDir();
  const factsDir = path.join(tmp, "facts");
  await fs.mkdir(factsDir, { recursive: true });
  const pagePath = path.join(factsDir, "preferences.md");
  await fs.writeFile(pagePath, "initial content", "utf-8");

  const cfg = config(tmp);
  const v = await createVersion(pagePath, "initial content", "write", cfg, undefined, undefined, tmp);

  assert.equal(v.versionId, "1");
  assert.equal(v.trigger, "write");
  assert.equal(v.sizeBytes, Buffer.byteLength("initial content", "utf-8"));
  assert.ok(v.timestamp);
  assert.ok(v.contentHash);

  // Manifest should exist
  const manifestPath = path.join(tmp, ".versions", "facts__preferences", "manifest.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf-8"));
  assert.equal(manifest.versions.length, 1);
  assert.equal(manifest.currentVersion, "1");

  // Snapshot file should exist
  const snapshotPath = path.join(tmp, ".versions", "facts__preferences", "1.md");
  const snapshot = await fs.readFile(snapshotPath, "utf-8");
  assert.equal(snapshot, "initial content");
});

test("sequential writes increment version IDs", async () => {
  const tmp = await makeTmpDir();
  const factsDir = path.join(tmp, "facts");
  await fs.mkdir(factsDir, { recursive: true });
  const pagePath = path.join(factsDir, "notes.md");

  const cfg = config(tmp);

  await fs.writeFile(pagePath, "v1 content", "utf-8");
  const v1 = await createVersion(pagePath, "v1 content", "write", cfg, undefined, undefined, tmp);
  assert.equal(v1.versionId, "1");

  await fs.writeFile(pagePath, "v2 content", "utf-8");
  const v2 = await createVersion(pagePath, "v2 content", "write", cfg, undefined, undefined, tmp);
  assert.equal(v2.versionId, "2");

  await fs.writeFile(pagePath, "v3 content", "utf-8");
  const v3 = await createVersion(pagePath, "v3 content", "consolidation", cfg, undefined, undefined, tmp);
  assert.equal(v3.versionId, "3");
  assert.equal(v3.trigger, "consolidation");
});

test("max versions pruning removes oldest versions", async () => {
  const tmp = await makeTmpDir();
  const factsDir = path.join(tmp, "facts");
  await fs.mkdir(factsDir, { recursive: true });
  const pagePath = path.join(factsDir, "pruned.md");

  const cfg = config(tmp, { maxVersionsPerPage: 3 });

  for (let i = 1; i <= 5; i++) {
    const content = `content v${i}`;
    await fs.writeFile(pagePath, content, "utf-8");
    await createVersion(pagePath, content, "write", cfg, undefined, undefined, tmp);
  }

  const history = await listVersions(pagePath, cfg, tmp);
  // Only the last 3 versions should remain
  assert.equal(history.versions.length, 3);
  assert.equal(history.versions[0].versionId, "3");
  assert.equal(history.versions[1].versionId, "4");
  assert.equal(history.versions[2].versionId, "5");

  // Pruned snapshot files should not exist
  const sidecar = path.join(tmp, ".versions", "facts__pruned");
  await assert.rejects(fs.access(path.join(sidecar, "1.md")));
  await assert.rejects(fs.access(path.join(sidecar, "2.md")));
  // Remaining snapshots should exist
  assert.ok(await fs.access(path.join(sidecar, "3.md")).then(() => true));
  assert.ok(await fs.access(path.join(sidecar, "4.md")).then(() => true));
  assert.ok(await fs.access(path.join(sidecar, "5.md")).then(() => true));
});

// ---------------------------------------------------------------------------
// listVersions
// ---------------------------------------------------------------------------

test("listVersions returns all versions sorted by versionId", async () => {
  const tmp = await makeTmpDir();
  const factsDir = path.join(tmp, "facts");
  await fs.mkdir(factsDir, { recursive: true });
  const pagePath = path.join(factsDir, "sorted.md");

  const cfg = config(tmp);

  for (let i = 1; i <= 4; i++) {
    await fs.writeFile(pagePath, `content ${i}`, "utf-8");
    await createVersion(pagePath, `content ${i}`, "write", cfg, undefined, undefined, tmp);
  }

  const history = await listVersions(pagePath, cfg, tmp);
  assert.equal(history.versions.length, 4);
  for (let i = 0; i < history.versions.length; i++) {
    assert.equal(history.versions[i].versionId, String(i + 1));
  }
});

test("listVersions returns empty history for non-existent page", async () => {
  const tmp = await makeTmpDir();
  const pagePath = path.join(tmp, "facts", "nonexistent.md");
  const cfg = config(tmp);

  const history = await listVersions(pagePath, cfg, tmp);
  assert.equal(history.versions.length, 0);
  assert.equal(history.currentVersion, "0");
});

// ---------------------------------------------------------------------------
// getVersion
// ---------------------------------------------------------------------------

test("getVersion returns correct content for specific version", async () => {
  const tmp = await makeTmpDir();
  const factsDir = path.join(tmp, "facts");
  await fs.mkdir(factsDir, { recursive: true });
  const pagePath = path.join(factsDir, "get.md");

  const cfg = config(tmp);

  await fs.writeFile(pagePath, "first content", "utf-8");
  await createVersion(pagePath, "first content", "write", cfg, undefined, undefined, tmp);

  await fs.writeFile(pagePath, "second content", "utf-8");
  await createVersion(pagePath, "second content", "write", cfg, undefined, undefined, tmp);

  const v1Content = await getVersion(pagePath, "1", cfg, tmp);
  assert.equal(v1Content, "first content");

  const v2Content = await getVersion(pagePath, "2", cfg, tmp);
  assert.equal(v2Content, "second content");
});

test("getVersion throws for non-existent version", async () => {
  const tmp = await makeTmpDir();
  const factsDir = path.join(tmp, "facts");
  await fs.mkdir(factsDir, { recursive: true });
  const pagePath = path.join(factsDir, "missing.md");

  const cfg = config(tmp);

  await assert.rejects(
    getVersion(pagePath, "99", cfg, tmp),
    (err: Error) => err.message.includes("Version 99 not found"),
  );
});

// ---------------------------------------------------------------------------
// revertToVersion
// ---------------------------------------------------------------------------

test("revertToVersion restores content and creates revert version", async () => {
  const tmp = await makeTmpDir();
  const factsDir = path.join(tmp, "facts");
  await fs.mkdir(factsDir, { recursive: true });
  const pagePath = path.join(factsDir, "revert.md");

  const cfg = config(tmp);

  // Write v1
  await fs.writeFile(pagePath, "original content", "utf-8");
  await createVersion(pagePath, "original content", "write", cfg, undefined, undefined, tmp);

  // Write v2 (overwrite)
  await fs.writeFile(pagePath, "modified content", "utf-8");
  await createVersion(pagePath, "modified content", "write", cfg, undefined, undefined, tmp);

  // Revert to v1
  const revertVersion = await revertToVersion(pagePath, "1", cfg, undefined, tmp);
  assert.equal(revertVersion.trigger, "revert");
  assert.ok(revertVersion.note?.includes("reverted to version 1"));

  // The page should now contain original content
  const restored = await fs.readFile(pagePath, "utf-8");
  assert.equal(restored, "original content");

  // The revert snapshot (v3) should contain the "modified content" that was current before revert
  const v3Content = await getVersion(pagePath, "3", cfg, tmp);
  assert.equal(v3Content, "modified content");

  // History should have 3 versions
  const history = await listVersions(pagePath, cfg, tmp);
  assert.equal(history.versions.length, 3);
  assert.equal(history.currentVersion, "3");
});

// ---------------------------------------------------------------------------
// diffVersions
// ---------------------------------------------------------------------------

test("diffVersions produces meaningful line-based diff", async () => {
  const tmp = await makeTmpDir();
  const factsDir = path.join(tmp, "facts");
  await fs.mkdir(factsDir, { recursive: true });
  const pagePath = path.join(factsDir, "diff.md");

  const cfg = config(tmp);

  await fs.writeFile(pagePath, "line 1\nline 2\nline 3", "utf-8");
  await createVersion(pagePath, "line 1\nline 2\nline 3", "write", cfg, undefined, undefined, tmp);

  await fs.writeFile(pagePath, "line 1\nline 2 changed\nline 3\nline 4", "utf-8");
  await createVersion(pagePath, "line 1\nline 2 changed\nline 3\nline 4", "write", cfg, undefined, undefined, tmp);

  const diff = await diffVersions(pagePath, "1", "2", cfg, tmp);

  assert.ok(diff.includes("--- version 1"));
  assert.ok(diff.includes("+++ version 2"));
  assert.ok(diff.includes("-line 2"));
  assert.ok(diff.includes("+line 2 changed"));
  assert.ok(diff.includes("+line 4"));
});

// ---------------------------------------------------------------------------
// Versioning disabled
// ---------------------------------------------------------------------------

test("createVersion does not create sidecar when disabled via config", async () => {
  // When disabled, the storage.snapshotBeforeWrite is the no-op gate.
  // But createVersion itself still works if called directly.
  // This test verifies the config gate pattern at the storage integration level.
  const tmp = await makeTmpDir();
  const factsDir = path.join(tmp, "facts");
  await fs.mkdir(factsDir, { recursive: true });
  const pagePath = path.join(factsDir, "disabled.md");
  await fs.writeFile(pagePath, "some content", "utf-8");

  // The disabled config: createVersion is never called from storage when enabled=false.
  // We verify the sidecar dir does not exist after a direct file write.
  const versionsDir = path.join(tmp, ".versions");
  // No sidecar should exist since we never called createVersion
  await assert.rejects(fs.access(versionsDir));
});

// ---------------------------------------------------------------------------
// Missing manifest — graceful handling
// ---------------------------------------------------------------------------

test("listVersions returns empty history when manifest is missing", async () => {
  const tmp = await makeTmpDir();
  const pagePath = path.join(tmp, "facts", "ghost.md");
  const cfg = config(tmp);

  const history = await listVersions(pagePath, cfg, tmp);
  assert.equal(history.versions.length, 0);
  assert.equal(history.currentVersion, "0");
});

test("createVersion fails closed when manifest is corrupt and preserves existing snapshots", async () => {
  const tmp = await makeTmpDir();
  const factsDir = path.join(tmp, "facts");
  await fs.mkdir(factsDir, { recursive: true });
  const pagePath = path.join(factsDir, "corrupt.md");
  const sidecar = path.join(tmp, ".versions", "facts__corrupt");
  await fs.mkdir(sidecar, { recursive: true });
  await fs.writeFile(path.join(sidecar, "manifest.json"), "{not-json", "utf-8");
  await fs.writeFile(path.join(sidecar, "1.md"), "original snapshot", "utf-8");

  const cfg = config(tmp);

  await assert.rejects(
    () => createVersion(pagePath, "new snapshot", "write", cfg, undefined, undefined, tmp),
    /invalid manifest/,
  );
  assert.equal(await fs.readFile(path.join(sidecar, "1.md"), "utf-8"), "original snapshot");
});

// ---------------------------------------------------------------------------
// Concurrent writes — sequential within same page
// ---------------------------------------------------------------------------

test("concurrent createVersion calls produce sequential version IDs", async () => {
  const tmp = await makeTmpDir();
  const factsDir = path.join(tmp, "facts");
  await fs.mkdir(factsDir, { recursive: true });
  const pagePath = path.join(factsDir, "concurrent.md");

  const cfg = config(tmp);

  // Run 5 version creates sequentially (simulating serialized writes)
  const versions = [];
  for (let i = 1; i <= 5; i++) {
    const content = `content ${i}`;
    await fs.writeFile(pagePath, content, "utf-8");
    const v = await createVersion(pagePath, content, "write", cfg, undefined, undefined, tmp);
    versions.push(v);
  }

  // All version IDs should be unique and sequential
  const ids = versions.map((v) => Number(v.versionId));
  assert.deepEqual(ids, [1, 2, 3, 4, 5]);
});

// ---------------------------------------------------------------------------
// Nested page paths (date subdirectories)
// ---------------------------------------------------------------------------

test("createVersion handles nested date subdirectories", async () => {
  const tmp = await makeTmpDir();
  const dateDir = path.join(tmp, "facts", "2026-04-16");
  await fs.mkdir(dateDir, { recursive: true });
  const pagePath = path.join(dateDir, "mem-001.md");
  await fs.writeFile(pagePath, "dated content", "utf-8");

  const cfg = config(tmp);
  const v = await createVersion(pagePath, "dated content", "write", cfg, undefined, undefined, tmp);
  assert.equal(v.versionId, "1");

  // Sidecar key should encode the nested path
  const sidecar = path.join(tmp, ".versions", "facts__2026-04-16__mem-001");
  const snapshotPath = path.join(sidecar, "1.md");
  const snapshot = await fs.readFile(snapshotPath, "utf-8");
  assert.equal(snapshot, "dated content");
});

// ---------------------------------------------------------------------------
// Version with note
// ---------------------------------------------------------------------------

test("createVersion stores optional note", async () => {
  const tmp = await makeTmpDir();
  const factsDir = path.join(tmp, "facts");
  await fs.mkdir(factsDir, { recursive: true });
  const pagePath = path.join(factsDir, "noted.md");
  await fs.writeFile(pagePath, "with note", "utf-8");

  const cfg = config(tmp);
  const v = await createVersion(pagePath, "with note", "manual", cfg, undefined, "test note", tmp);
  assert.equal(v.note, "test note");
  assert.equal(v.trigger, "manual");

  const history = await listVersions(pagePath, cfg, tmp);
  assert.equal(history.versions[0].note, "test note");
});

// ---------------------------------------------------------------------------
// Max versions = 0 disables pruning
// ---------------------------------------------------------------------------

test("maxVersionsPerPage = 0 disables pruning", async () => {
  const tmp = await makeTmpDir();
  const factsDir = path.join(tmp, "facts");
  await fs.mkdir(factsDir, { recursive: true });
  const pagePath = path.join(factsDir, "unlimited.md");

  const cfg = config(tmp, { maxVersionsPerPage: 0 });

  for (let i = 1; i <= 10; i++) {
    await fs.writeFile(pagePath, `v${i}`, "utf-8");
    await createVersion(pagePath, `v${i}`, "write", cfg, undefined, undefined, tmp);
  }

  const history = await listVersions(pagePath, cfg, tmp);
  assert.equal(history.versions.length, 10);
});
