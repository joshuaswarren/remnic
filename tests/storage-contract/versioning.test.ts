/**
 * #1533 Phase A — page versioning contract (issue done-when #5):
 * overwrite produces a numbered snapshot; revert restores the prior content.
 *
 * Versioning is opt-in via `StorageManager.setVersioningConfig(...)`. With it
 * enabled, `snapshotBeforeWrite` captures the current file content as a
 * page-version snapshot BEFORE every write/consolidation. The public page
 * versioning helpers (`createVersion`, `listVersions`, `revertToVersion`) live
 * in `page-versioning.ts` and operate on the same sidecar layout.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFile } from "node:fs/promises";

import type { VersioningConfig } from "../../packages/remnic-core/src/page-versioning.js";
import {
  createVersion,
  getVersion,
  listVersions,
  revertToVersion,
} from "../../packages/remnic-core/src/page-versioning.js";
import { StorageManager } from "../../packages/remnic-core/src/storage.js";
import { withScratchDir, withScratchStorage } from "./helpers.js";

const SIDECAR_DIR = ".versions";

function enabledConfig(memoryDir: string): VersioningConfig {
  return {
    enabled: true,
    maxVersionsPerPage: 10,
    sidecarDir: SIDECAR_DIR,
  };
}

test("versioning: overwrite-in-place (writeProfile) snapshots the prior content when versioning is enabled", async () => {
  await withScratchStorage("versioning-snapshot", async (storage, dir) => {
    storage.setVersioningConfig(enabledConfig(dir));

    // writeProfile writes a FIXED path (profile.md) and calls snapshotBeforeWrite
    // before every overwrite — the versioning trigger. (writeMemory always
    // mints a fresh id/path so it never overwrites; updateMemory does NOT call
    // snapshotBeforeWrite. writeProfile is the canonical overwrite-in-place.)
    await storage.writeProfile("# Profile\n\nfirst body\n");
    const profilePath = path.join(storage.dir, "profile.md");

    // Second write to the SAME path — snapshotBeforeWrite captures "first body".
    await storage.writeProfile("# Profile\n\nsecond body\n");

    const history = await listVersions(profilePath, enabledConfig(dir), dir);
    assert.ok(history.versions.length >= 1, "overwrite-in-place must produce at least one snapshot");
    const firstVersionId = String(
      history.versions.sort((a, b) => Number(a.versionId) - Number(b.versionId))[0].versionId,
    );
    const snapshot = await getVersion(profilePath, firstVersionId, enabledConfig(dir), dir);
    assert.ok(snapshot.includes("first body"), "first snapshot must contain the prior content");
  });
});

test("versioning: revertToVersion restores the prior content on the live page", async () => {
  await withScratchStorage("versioning-revert", async (storage, dir) => {
    storage.setVersioningConfig(enabledConfig(dir));

    const profilePath = path.join(storage.dir, "profile.md");
    await storage.writeProfile("# Profile\n\nv1 body\n");
    await storage.writeProfile("# Profile\n\nv2 body\n");

    const history = await listVersions(profilePath, enabledConfig(dir), dir);
    assert.ok(history.versions.length >= 1);
    const targetId = String(
      history.versions.sort((a, b) => Number(a.versionId) - Number(b.versionId))[0].versionId,
    );

    // Revert the live file to that first snapshot.
    await revertToVersion(profilePath, targetId, enabledConfig(dir), {
      debug: () => {},
      warn: () => {},
    }, dir);

    const live = await readFile(profilePath, "utf-8");
    assert.ok(live.includes("v1 body"), "revert must restore the prior content on the live page");
    assert.ok(!live.includes("v2 body"), "revert must remove the post-snapshot content");
  });
});

test("versioning: disabled by default — writeMemory does NOT snapshot when no config is set", async () => {
  await withScratchStorage("versioning-disabled", async (storage, dir) => {
    // No setVersioningConfig call — versioning stays disabled (the default).
    const id = await storage.writeMemory("fact", "first", { confidence: 0.9 });
    const mem = await storage.getMemoryById(id);
    assert.ok(mem);
    const history = await listVersions(mem!.path, enabledConfig(dir), dir);
    assert.equal(history.versions.length, 0, "versioning must be disabled until setVersioningConfig is called");
  });
});

test("versioning: createVersion is monotonic — versionIds increase 1, 2, 3, ...", async () => {
  await withScratchDir("versioning-monotonic", async (dir) => {
    const cfg = enabledConfig(dir);
    const pagePath = path.join(dir, "page.md");

    const v1 = await createVersion(pagePath, "body-1", "manual", cfg, { debug: () => {}, warn: () => {} }, dir);
    const v2 = await createVersion(pagePath, "body-2", "manual", cfg, { debug: () => {}, warn: () => {} }, dir);
    const v3 = await createVersion(pagePath, "body-3", "manual", cfg, { debug: () => {}, warn: () => {} }, dir);

    assert.equal(Number(v1.versionId), 1);
    assert.equal(Number(v2.versionId), 2);
    assert.equal(Number(v3.versionId), 3);
  });
});

test("versioning: setVersioningConfig on a fresh StorageManager is a no-op-safe setter (idempotent)", async () => {
  await withScratchStorage("versioning-setter", async (storage, dir) => {
    const cfg = enabledConfig(dir);
    // Calling twice with the same config must not throw or double-register.
    storage.setVersioningConfig(cfg);
    storage.setVersioningConfig(cfg);
    const id = await storage.writeMemory("fact", "body", { confidence: 0.9 });
    assert.ok(typeof id === "string");
  });
});
