/**
 * Issue #1533 — Phase A contract test: page versioning snapshots.
 *
 * When versioning is enabled, overwriting a FIXED-PATH file produces a numbered
 * snapshot in the `.versions/` sidecar. Revert restores a prior version.
 * This pins the versioning contract the consolidation/provenance paths rely on.
 *
 * NOTE: `writeMemory` generates a unique path per id, so the first write to a
 * path never has pre-existing content to snapshot. The versioning integration
 * is exercised through `writeProfile` — a fixed-path write that calls
 * `snapshotBeforeWrite` before overwriting. The direct `createVersion`/
 * `revertToVersion` API is tested separately.
 */

import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createVersion,
  listVersions,
  revertToVersion,
  getVersion,
  pruneVersions,
  removeVersion,
  type VersioningConfig,
} from "../page-versioning.js";
import { StorageManager } from "../storage.js";
import { resetStaticCaches } from "./harness.js";

const VERSIONING_CONFIG: VersioningConfig = {
  enabled: true,
  maxVersionsPerPage: 10,
  sidecarDir: ".versions",
};

test("versioning: overwrite of a fixed-path file (writeProfile) produces a numbered snapshot", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-ver-snapshot-"));
  try {
    resetStaticCaches();
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();
    storage.setVersioningConfig(VERSIONING_CONFIG);

    const profilePath = path.join(dir, "profile.md");
    await storage.writeProfile("first version of profile");

    // Overwrite the same fixed path → snapshotBeforeWrite fires
    await storage.writeProfile("second version of profile");

    const versions = await listVersions(profilePath, VERSIONING_CONFIG);
    assert.ok(
      versions.versions.length >= 1,
      "at least one snapshot must exist after overwriting a fixed-path file",
    );
    assert.equal(versions.versions[0].trigger, "consolidation");
  } finally {
    resetStaticCaches();
    await rm(dir, { recursive: true, force: true });
  }
});

test("versioning: snapshot captures the PRE-overwrite content", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-ver-pre-"));
  try {
    resetStaticCaches();
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();
    storage.setVersioningConfig(VERSIONING_CONFIG);

    const profilePath = path.join(dir, "profile.md");
    await storage.writeProfile("ORIGINAL PROFILE");
    await storage.writeProfile("REPLACEMENT PROFILE");

    const versions = await listVersions(profilePath, VERSIONING_CONFIG);
    assert.ok(versions.versions.length >= 1);

    // Read the snapshot — it must contain the ORIGINAL, not the replacement
    const snapshot = await getVersion(profilePath, versions.versions[0].versionId, VERSIONING_CONFIG);
    assert.ok(snapshot, "snapshot content must be readable");
    assert.ok(
      snapshot!.includes("ORIGINAL PROFILE"),
      "the snapshot must contain the pre-overwrite content",
    );
    assert.ok(
      !snapshot!.includes("REPLACEMENT"),
      "the snapshot must NOT contain the replacement content",
    );

    // The live file has the replacement
    const live = await readFile(profilePath, "utf-8");
    assert.ok(live.includes("REPLACEMENT PROFILE"));
  } finally {
    resetStaticCaches();
    await rm(dir, { recursive: true, force: true });
  }
});

test("versioning: disabled by default — no snapshots created", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-ver-disabled-"));
  try {
    resetStaticCaches();
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();
    // Do NOT call setVersioningConfig — default is disabled
    await storage.writeProfile("v1");
    await storage.writeProfile("v2");

    const profilePath = path.join(dir, "profile.md");
    const versions = await listVersions(profilePath, VERSIONING_CONFIG);
    assert.equal(versions.versions.length, 0, "no snapshots when versioning was disabled at write time");
  } finally {
    resetStaticCaches();
    await rm(dir, { recursive: true, force: true });
  }
});

test("versioning: createVersion → revertToVersion round-trip restores content", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-ver-revert-"));
  try {
    const filePath = path.join(dir, "doc.md");
    await writeFile(filePath, "alpha", "utf-8");

    await createVersion(filePath, "alpha", "manual", VERSIONING_CONFIG);
    await writeFile(filePath, "beta", "utf-8");
    await createVersion(filePath, "beta", "manual", VERSIONING_CONFIG);

    const versions = await listVersions(filePath, VERSIONING_CONFIG);
    assert.ok(versions.versions.length >= 2);

    const firstVersionId = versions.versions[0].versionId;
    await revertToVersion(filePath, firstVersionId, VERSIONING_CONFIG);

    const restored = await readFile(filePath, "utf-8");
    assert.equal(restored, "alpha", "revert must restore the version-1 content");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("versioning: a final prune counts only COMMITTED snapshots — a staged writer's entry is never traded away (round N+15 B)", async () => {
  // Two concurrent merges stage their pre-merge snapshots (deferPrune)
  // before either compare-and-swap commits. Writer A commits and finalizes
  // the prune while writer B is still pending: counting B's uncommitted
  // snapshot would remove one MORE valid rollback point than the cap
  // requires, and B's later abort would leave history short of the cap.
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-ver-pending-"));
  try {
    const pagePath = path.join(dir, "facts", "deploy-notes.md");
    await mkdir(path.dirname(pagePath), { recursive: true });
    const config: VersioningConfig = {
      enabled: true,
      maxVersionsPerPage: 3,
      sidecarDir: ".versions",
    };
    for (let index = 1; index <= 3; index += 1) {
      await writeFile(pagePath, `body v${index}`, "utf8");
      await createVersion(pagePath, `body v${index}`, "write", config, undefined, undefined, dir);
    }
    const stagedA = await createVersion(pagePath, "body v3", "semantic-merge", config, undefined, undefined, dir, { deferPrune: true });
    const stagedB = await createVersion(pagePath, "body v3", "semantic-merge", config, undefined, undefined, dir, { deferPrune: true });

    // Writer A's guarded write commits and finalizes; writer B is still pending.
    await pruneVersions(pagePath, config, undefined, dir, { committedVersionId: stagedA.versionId });

    const history = await listVersions(pagePath, config, dir);
    assert.deepEqual(
      history.versions.map((version) => version.versionId),
      ["2", "3", stagedA.versionId, stagedB.versionId],
      "exactly ONE committed rollback point (v1) removed; both staged entries stay",
    );
    assert.equal(
      history.versions.find((version) => version.versionId === stagedB.versionId)?.pending,
      true,
      "writer B's staged entry is untouched and still pending",
    );
    assert.equal(
      history.versions.find((version) => version.versionId === stagedA.versionId)?.pending,
      undefined,
      "writer A's finalize marked its own entry committed",
    );
    assert.equal(
      await getVersion(pagePath, "2", config, dir),
      "body v2",
      "v2 survives as a rollback point",
    );
    await assert.rejects(
      getVersion(pagePath, "1", config, dir),
      /not found/,
      "v1 is the one rollback point removed",
    );

    // Writer B's attempt then aborts (lost compare-and-swap): its entry
    // leaves history without taking any committed rollback point with it.
    await removeVersion(pagePath, stagedB.versionId, config, undefined, dir);
    const after = await listVersions(pagePath, config, dir);
    assert.deepEqual(
      after.versions.map((version) => version.versionId),
      ["2", "3", stagedA.versionId],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
