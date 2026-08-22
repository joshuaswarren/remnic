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
import { mkdtemp, mkdir, rm, readFile, writeFile, chmod, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
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

// ── Final round (A): publish-before-cleanup ordering ────────────────────────
// An aborted merge's removeVersion, a cap prune, and a fresh stage all used to
// unlink/drop snapshot state BEFORE the manifest publication that records it.
// When the publication then failed (transient I/O, full disk), the on-disk
// manifest kept referencing a now-missing snapshot — a dangling reference that
// getVersion/revert fail on and prune never cleans. The invariant under test:
// after ANY publication failure, every manifest entry's snapshot stays
// readable, and the manifest either reflects the mutation or does not — never
// half of it.

test("versioning: a failed manifest publication during abort cleanup never leaves a dangling snapshot reference (final A)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-ver-dangling-"));
  try {
    const pagePath = path.join(dir, "facts", "dangling-notes.md");
    await mkdir(path.dirname(pagePath), { recursive: true });
    const config: VersioningConfig = {
      enabled: true,
      maxVersionsPerPage: 10,
      sidecarDir: ".versions",
    };
    await writeFile(pagePath, "body v1", "utf8");
    await createVersion(pagePath, "body v1", "write", config, undefined, undefined, dir);
    const staged = await createVersion(
      pagePath,
      "body v1",
      "semantic-merge",
      config,
      undefined,
      undefined,
      dir,
      { deferPrune: true },
    );
    await writeFile(pagePath, "body merged", "utf8");

    // Transient publication failure: the manifest file itself is read-only,
    // so a non-atomic overwrite fails while snapshot unlinks (directory
    // permission) still succeed — the exact pre-fix dangling shape.
    const manifestFile = path.join(
      dir,
      ".versions",
      sidecarKey(path.relative(dir, pagePath)),
      "manifest.json",
    );
    await chmod(manifestFile, 0o444);
    let removalCompleted = false;
    try {
      await removeVersion(pagePath, staged.versionId, config, undefined, dir);
      removalCompleted = true;
    } catch {
      // a surfaced publication failure is the safe outcome
    } finally {
      await chmod(manifestFile, 0o644);
    }

    const history = await listVersions(pagePath, config, dir);
    const stillListed = history.versions.some(
      (version) => version.versionId === staged.versionId,
    );
    assert.notEqual(
      removalCompleted,
      stillListed,
      "the removal either completed (entry gone) or failed (entry stays) — never half-applied",
    );
    for (const version of history.versions) {
      await assert.doesNotReject(
        () => getVersion(pagePath, version.versionId, config, dir),
        `snapshot ${version.versionId} listed in the manifest must stay readable (no dangling reference)`,
      );
    }
    JSON.parse(await readFile(manifestFile, "utf-8"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("versioning: a failed manifest publication during a cap prune never leaves dangling references (final A)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-ver-prune-dangling-"));
  try {
    const pagePath = path.join(dir, "facts", "prune-notes.md");
    await mkdir(path.dirname(pagePath), { recursive: true });
    const config: VersioningConfig = {
      enabled: true,
      maxVersionsPerPage: 2,
      sidecarDir: ".versions",
    };
    for (let index = 1; index <= 2; index += 1) {
      await writeFile(pagePath, `body v${index}`, "utf8");
      await createVersion(pagePath, `body v${index}`, "write", config, undefined, undefined, dir);
    }
    const manifestFile = path.join(
      dir,
      ".versions",
      sidecarKey(path.relative(dir, pagePath)),
      "manifest.json",
    );
    await chmod(manifestFile, 0o444);
    let stageCompleted = false;
    try {
      await writeFile(pagePath, "body v3", "utf8");
      await createVersion(pagePath, "body v3", "write", config, undefined, undefined, dir);
      stageCompleted = true;
    } catch {
      // a surfaced publication failure is the safe outcome
    } finally {
      await chmod(manifestFile, 0o644);
    }

    const history = await listVersions(pagePath, config, dir);
    if (!stageCompleted) {
      assert.deepEqual(
        history.versions.map((version) => version.versionId),
        ["1", "2"],
        "a failed stage leaves the manifest exactly as it was",
      );
    }
    for (const version of history.versions) {
      await assert.doesNotReject(
        () => getVersion(pagePath, version.versionId, config, dir),
        `snapshot ${version.versionId} listed in the manifest must stay readable (no dangling reference)`,
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── Final round (B): ownership revalidation before destructive writes ───────
// The lock's mtime heartbeat is a timer; a section paused past the 30s stale
// window (CPU-bound pause, suspended process) cannot heartbeat, so a peer can
// break the lock and commit its own mutation. Every destructive write must
// revalidate ownership immediately before it lands and abort on loss — the
// same pattern the graph JSONL lock adopted (GraphWriteLockSection).

function fakeManifestEntries(count: number): string {
  const versions = Array.from({ length: count }, (_, index) => ({
    versionId: String(index + 1),
    timestamp: "2026-08-22T00:00:00.000Z",
    contentHash: `hash-${index + 1}`,
    sizeBytes: 10,
    trigger: "write",
  }));
  return `${JSON.stringify(
    { pagePath: "facts/notes.md", versions, currentVersion: String(count) },
    null,
    2,
  )}\n`;
}

test("versioning: removeVersion whose manifest lock was stale-broken aborts instead of clobbering the peer's committed manifest (final B)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-ver-locklost-"));
  try {
    const pagePath = path.join(dir, "facts", "locklost-notes.md");
    await mkdir(path.dirname(pagePath), { recursive: true });
    const config: VersioningConfig = {
      enabled: true,
      maxVersionsPerPage: 10,
      sidecarDir: ".versions",
    };
    const sidecarPageDir = path.join(dir, ".versions", sidecarKey(path.relative(dir, pagePath)));
    const manifestFile = path.join(sidecarPageDir, "manifest.json");
    const lockPath = `${manifestFile}.lock`;
    await mkdir(sidecarPageDir, { recursive: true });
    // Our process's stale-but-current view: two versions.
    await writeFile(manifestFile, fakeManifestEntries(2), "utf8");
    await writeFile(path.join(sidecarPageDir, "1.md"), "body v1", "utf8");
    await writeFile(path.join(sidecarPageDir, "2.md"), "body v2", "utf8");

    // The peer: stale-breaks our lock mid-section, takes ownership, and
    // commits a newer mutation (version 3) under its own lock.
    const breakAsPeer = (async () => {
      while (!existsSync(lockPath)) await new Promise<void>((resolve) => setImmediate(resolve));
      await unlink(lockPath).catch(() => undefined);
      await writeFile(lockPath, `${process.pid} peer-${randomUUID()} ${new Date().toISOString()}\n`, "utf8");
      await writeFile(path.join(sidecarPageDir, "3.md"), "body v3", "utf8");
      await writeFile(manifestFile, fakeManifestEntries(3), "utf8");
    })();

    let aborted = false;
    try {
      await removeVersion(pagePath, "2", config, undefined, dir);
    } catch (err) {
      aborted = err instanceof Error && /lost mid-section/.test(err.message);
    }
    await breakAsPeer;
    assert.equal(aborted, true, "a removal whose lock was stale-broken must abort, not publish");

    const history = await listVersions(pagePath, config, dir);
    assert.deepEqual(
      history.versions.map((version) => version.versionId),
      ["1", "2", "3"],
      "the peer's committed version 3 survives — the stale writer never rewrote the manifest",
    );
    for (const version of history.versions) {
      await assert.doesNotReject(
        () => getVersion(pagePath, version.versionId, config, dir),
        `peer-committed snapshot ${version.versionId} must stay readable`,
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("versioning: pruneVersions and createVersion whose manifest lock was stale-broken abort instead of publishing (final B)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-ver-locklost2-"));
  try {
    const pagePath = path.join(dir, "facts", "locklost2-notes.md");
    await mkdir(path.dirname(pagePath), { recursive: true });
    const config: VersioningConfig = {
      enabled: true,
      maxVersionsPerPage: 2,
      sidecarDir: ".versions",
    };
    const sidecarPageDir = path.join(dir, ".versions", sidecarKey(path.relative(dir, pagePath)));
    const manifestFile = path.join(sidecarPageDir, "manifest.json");
    const lockPath = `${manifestFile}.lock`;
    await mkdir(sidecarPageDir, { recursive: true });
    await writeFile(manifestFile, fakeManifestEntries(3), "utf8");
    for (let index = 1; index <= 3; index += 1) {
      await writeFile(path.join(sidecarPageDir, `${index}.md`), `body v${index}`, "utf8");
    }

    const breakAsPeer = (async () => {
      while (!existsSync(lockPath)) await new Promise<void>((resolve) => setImmediate(resolve));
      await unlink(lockPath).catch(() => undefined);
      await writeFile(lockPath, `${process.pid} peer-${randomUUID()} ${new Date().toISOString()}\n`, "utf8");
    })();

    // The prune (over-cap by one) must refuse to publish on a broken lock.
    let pruneAborted = false;
    try {
      await pruneVersions(pagePath, config, undefined, dir);
    } catch (err) {
      pruneAborted = err instanceof Error && /lost mid-section/.test(err.message);
    }
    await breakAsPeer;
    assert.equal(pruneAborted, true, "a prune whose lock was stale-broken must abort, not publish");

    let history = await listVersions(pagePath, config, dir);
    assert.deepEqual(
      history.versions.map((version) => version.versionId),
      ["1", "2", "3"],
      "the peer's manifest is untouched by the refused prune",
    );
    // The fake peer never releases its lock; clear it so the stage below
    // acquires fresh and the SECOND break lands mid-section, not as a busy
    // 10s acquire timeout against a live-looking peer.
    await unlink(lockPath).catch(() => undefined);

    // Same contract for staging a new version.
    const breakAsPeer2 = (async () => {
      while (!existsSync(lockPath)) await new Promise<void>((resolve) => setImmediate(resolve));
      await unlink(lockPath).catch(() => undefined);
      await writeFile(lockPath, `${process.pid} peer-${randomUUID()} ${new Date().toISOString()}\n`, "utf8");
    })();
    let stageAborted = false;
    try {
      await createVersion(pagePath, "body v4", "write", config, undefined, undefined, dir);
    } catch (err) {
      stageAborted = err instanceof Error && /lost mid-section/.test(err.message);
    }
    await breakAsPeer2;
    assert.equal(stageAborted, true, "a stage whose lock was stale-broken must abort, not write");

    history = await listVersions(pagePath, config, dir);
    assert.deepEqual(
      history.versions.map((version) => version.versionId),
      ["1", "2", "3"],
      "the peer's manifest is untouched by the refused stage",
    );
    assert.equal(
      existsSync(path.join(sidecarPageDir, "4.md")),
      false,
      "the refused stage must not leave a snapshot file behind",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
