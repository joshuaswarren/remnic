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
  recordStrandedCommit,
  sidecarKey,
  type VersioningConfig,
} from "../page-versioning.js";
import { finalizeMergedVersionPrune } from "../orchestration/semantic-merge-commit-effects.js";
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

test("versioning: a failed finalization is reconciled by the next successful one — history stays within maxVersionsPerPage (round N+22)", async () => {
  // A finalization whose merge had ALREADY committed can fail transiently
  // (manifest lock timeout, unreadable manifest). Pre-fix, the catch only
  // logged: the staged entry stayed `pending` forever, pruneExcessVersions
  // excludes pending entries, and every such failure stranded one
  // unprunable snapshot beyond the cap. The next successful finalization
  // must reconcile the stranded entry so the prune bounds history again.
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-ver-strand-"));
  try {
    const pagePath = path.join(dir, "facts", "strand-notes.md");
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

    // Merge 1: stage the rollback snapshot, commit the merged body, then the
    // finalizing prune FAILS — here via a transiently unreadable manifest
    // (the lock-timeout production shape: pruneVersions throws, the catch is
    // best-effort, the entry stays pending).
    const staged1 = await createVersion(
      pagePath,
      "body v3",
      "semantic-merge",
      config,
      undefined,
      undefined,
      dir,
      { deferPrune: true },
    );
    await writeFile(pagePath, "body merged 1", "utf8");
    const manifestFile = path.join(
      dir,
      ".versions",
      sidecarKey(path.relative(dir, pagePath)),
      "manifest.json",
    );
    const goodManifest = await readFile(manifestFile, "utf-8");
    await writeFile(manifestFile, "{ transiently not json", "utf-8");
    await finalizeMergedVersionPrune(pagePath, config, dir, "fact-strand", staged1.versionId);
    await writeFile(manifestFile, goodManifest, "utf-8");

    const stranded = await listVersions(pagePath, config, dir);
    assert.equal(
      stranded.versions.find((version) => version.versionId === staged1.versionId)?.pending,
      true,
      "the failed finalization left the committed merge's snapshot pending",
    );

    // Merge 2: stage, commit, and finalize SUCCESSFULLY. It must clear its
    // own flag AND reconcile merge 1's stranded entry, so the committed set
    // {v1, v2, v3, staged1, staged2} prunes back to the cap.
    const staged2 = await createVersion(
      pagePath,
      "body merged 1",
      "semantic-merge",
      config,
      undefined,
      undefined,
      dir,
      { deferPrune: true },
    );
    await writeFile(pagePath, "body merged 2", "utf8");
    await finalizeMergedVersionPrune(pagePath, config, dir, "fact-strand", staged2.versionId);

    const history = await listVersions(pagePath, config, dir);
    assert.ok(
      history.versions.length <= config.maxVersionsPerPage,
      `total snapshot count must stay within maxVersionsPerPage=${config.maxVersionsPerPage} (got ${history.versions.length}: ${history.versions.map((v) => v.versionId).join(",")})`,
    );
    assert.deepEqual(
      history.versions.map((version) => version.versionId),
      ["3", staged1.versionId, staged2.versionId],
      "the two oldest committed rollback points are pruned; both merged snapshots stay",
    );
    assert.equal(
      history.versions.filter((version) => version.pending === true).length,
      0,
      "no entry remains pending after the reconciling finalization",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("versioning: stale stranded-commit ids — gone or already-committed entries — are no-ops (round N+22)", async () => {
  // The marker is append-only and never rewritten, so it accumulates ids
  // whose entry was later removed (aborted writer's id reused path) or
  // already cleared by an earlier reconciliation. Reading them must neither
  // throw, clear a still-pending concurrent writer's entry, nor remove any
  // extra committed snapshot.
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-ver-stale-"));
  try {
    const pagePath = path.join(dir, "facts", "stale-notes.md");
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
    // A still-pending concurrent writer plus stale marker ids: one for an
    // entry that does not exist (999) and one for an already-committed
    // entry ("1"). Neither resolves to a clearable pending entry, and the
    // still-pending writer's entry has NO marker record — only a writer's
    // OWN failed finalization can record its id — so reconciliation must
    // leave it pending and touch nothing else.
    const pendingWriter = await createVersion(
      pagePath,
      "body v3",
      "semantic-merge",
      config,
      undefined,
      undefined,
      dir,
      { deferPrune: true },
    );
    await recordStrandedCommit(pagePath, config, "999", undefined, dir);
    await recordStrandedCommit(pagePath, config, "1", undefined, dir);
    await recordStrandedCommit(pagePath, config, "999", undefined, dir);

    await pruneVersions(pagePath, config, undefined, dir);

    const history = await listVersions(pagePath, config, dir);
    assert.equal(
      history.versions.find((version) => version.versionId === pendingWriter.versionId)?.pending,
      true,
      "a still-pending writer's entry is never cleared by marker reconciliation — its id can only be recorded by its OWN failed finalization, never by a stale line",
    );
    assert.deepEqual(
      history.versions.map((version) => version.versionId),
      ["1", "2", "3", pendingWriter.versionId],
      "committed history is untouched by unresolvable marker ids",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
