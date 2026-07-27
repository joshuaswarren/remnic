import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";

import { exportCapsule } from "../../packages/remnic-core/src/transfer/capsule-export.js";
import { mergeCapsule } from "../../packages/remnic-core/src/transfer/capsule-merge.js";
import { listVersions } from "../../packages/remnic-core/src/page-versioning.js";
import { sha256String } from "../../packages/remnic-core/src/transfer/fs-utils.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface FixtureFile {
  rel: string;
  content: string;
}

async function makeMemoryDir(files: FixtureFile[]): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "capsule-merge-src-"));
  for (const f of files) {
    const abs = path.join(root, ...f.rel.split("/"));
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, f.content, "utf-8");
  }
  return root;
}

async function makeTargetDir(
  preexisting?: FixtureFile[],
): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "capsule-merge-dst-"));
  if (preexisting) {
    for (const f of preexisting) {
      const abs = path.join(root, ...f.rel.split("/"));
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, f.content, "utf-8");
    }
  }
  return root;
}

async function exportFixtures(
  files: FixtureFile[],
  name: string,
): Promise<string> {
  const src = await makeMemoryDir(files);
  const result = await exportCapsule({
    name,
    root: src,
    pluginVersion: "9.9.9",
    now: Date.parse("2026-04-26T00:00:00.000Z"),
  });
  return result.archivePath;
}

async function listFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string, prefix: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const next = path.join(dir, e.name);
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(next, rel);
      else if (e.isFile()) out.push(rel);
    }
  }
  await walk(root, "");
  return out.sort();
}

function sha256hex(s: string): string {
  return createHash("sha256").update(Buffer.from(s, "utf-8")).digest("hex");
}

/**
 * Build a minimal hand-crafted V2 bundle (bypasses exportCapsule so we can
 * control exact content for conflict scenarios).
 */
function makeBundle(
  capsuleId: string,
  records: Array<{ path: string; content: string }>,
): Buffer {
  const files = records.map((r) => ({
    path: r.path,
    sha256: sha256hex(r.content),
    bytes: Buffer.byteLength(r.content, "utf-8"),
  }));
  const bundle = {
    manifest: {
      format: "openclaw-engram-export" as const,
      schemaVersion: 2 as const,
      createdAt: "2026-04-26T00:00:00.000Z",
      pluginVersion: "9.9.9",
      includesTranscripts: false,
      files,
      capsule: {
        id: capsuleId,
        version: "1.0.0",
        schemaVersion: "taxonomy-v1",
        parentCapsule: null,
        description: "test capsule",
        retrievalPolicy: { tierWeights: {}, directAnswerEnabled: true },
        includes: {
          taxonomy: false,
          identityAnchors: false,
          peerProfiles: false,
          procedural: false,
        },
      },
    },
    records,
  };
  return gzipSync(Buffer.from(JSON.stringify(bundle), "utf-8"));
}

async function writeBundleArchive(
  buf: Buffer,
  label: string,
): Promise<string> {
  const tmp = await mkdtemp(path.join(tmpdir(), `capsule-merge-${label}-`));
  const archivePath = path.join(tmp, `${label}.capsule.json.gz`);
  await writeFile(archivePath, buf);
  return archivePath;
}

// ---------------------------------------------------------------------------
// 1. Non-conflicting merge equals union of both trees
// ---------------------------------------------------------------------------

test("non-conflicting merge: result is the union of archive and target", async () => {
  // Archive has facts/a.md and facts/b.md.
  // Target already has facts/c.md (not in archive).
  // All three should be present in target after merge.

  const archivePath = await exportFixtures(
    [
      { rel: "facts/a.md", content: "---\nid: a\n---\nbody-a\n" },
      { rel: "facts/b.md", content: "---\nid: b\n---\nbody-b\n" },
    ],
    "union-cap",
  );

  const dst = await makeTargetDir([
    { rel: "facts/c.md", content: "---\nid: c\n---\nbody-c\n" },
  ]);

  const result = await mergeCapsule({ sourceArchive: archivePath, targetRoot: dst });

  assert.equal(result.merged.length, 2, "both archive files should be written");
  assert.equal(result.skipped.length, 0);
  assert.equal(result.conflicts.length, 0);

  const files = await listFiles(dst);
  assert.ok(files.includes("facts/a.md"), "facts/a.md should be present");
  assert.ok(files.includes("facts/b.md"), "facts/b.md should be present");
  assert.ok(files.includes("facts/c.md"), "facts/c.md should still be present");

  // Verify archive content landed correctly.
  const aContent = await readFile(path.join(dst, "facts", "a.md"), "utf-8");
  assert.equal(aContent, "---\nid: a\n---\nbody-a\n");

  // Local-only file is untouched.
  const cContent = await readFile(path.join(dst, "facts", "c.md"), "utf-8");
  assert.equal(cContent, "---\nid: c\n---\nbody-c\n");

  // merged list is sorted by sourcePath.
  assert.deepEqual(
    result.merged.map((r) => r.sourcePath),
    ["facts/a.md", "facts/b.md"],
  );
});

test("non-conflicting merge: empty target receives all archive files", async () => {
  const archivePath = await exportFixtures(
    [
      { rel: "profile.md", content: "# profile\n" },
      { rel: "facts/x.md", content: "x\n" },
    ],
    "empty-dst-cap",
  );
  const dst = await makeTargetDir();

  const result = await mergeCapsule({ sourceArchive: archivePath, targetRoot: dst });

  assert.equal(result.merged.length, 2);
  assert.equal(result.skipped.length, 0);
  assert.equal(result.conflicts.length, 0);
  assert.equal(result.manifest.capsule.id, "empty-dst-cap");
});

// ---------------------------------------------------------------------------
// 2. skip-conflicts mode preserves local for conflicts
// ---------------------------------------------------------------------------

test("skip-conflicts mode: keeps local copy for conflicts, writes non-conflicting entries", async () => {
  // Archive: facts/a.md (different content from local), facts/b.md (new).
  // Target: facts/a.md (pre-existing with different content).
  const archiveBuf = makeBundle("skip-cap", [
    { path: "facts/a.md", content: "archive-a-content\n" },
    { path: "facts/b.md", content: "archive-b-content\n" },
  ]);
  const archivePath = await writeBundleArchive(archiveBuf, "skip-conflicts");

  const dst = await makeTargetDir([
    { rel: "facts/a.md", content: "local-a-content\n" },
  ]);

  const result = await mergeCapsule({
    sourceArchive: archivePath,
    targetRoot: dst,
    conflictMode: "skip-conflicts",
  });

  // facts/a.md is a conflict → skipped; facts/b.md is new → merged.
  assert.equal(result.merged.length, 1);
  assert.equal(result.merged[0].sourcePath, "facts/b.md");
  assert.equal(result.skipped.length, 1);
  assert.deepEqual(result.skipped[0], { path: "facts/a.md", reason: "conflict" });
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0].path, "facts/a.md");

  // Local file is preserved.
  const aContent = await readFile(path.join(dst, "facts", "a.md"), "utf-8");
  assert.equal(aContent, "local-a-content\n", "skip-conflicts must not overwrite local");

  // New file is present.
  const bContent = await readFile(path.join(dst, "facts", "b.md"), "utf-8");
  assert.equal(bContent, "archive-b-content\n");
});

test("skip-conflicts is the default mode when conflictMode is omitted", async () => {
  const archiveBuf = makeBundle("skip-default-cap", [
    { path: "facts/a.md", content: "from-archive\n" },
  ]);
  const archivePath = await writeBundleArchive(archiveBuf, "skip-default");

  const dst = await makeTargetDir([
    { rel: "facts/a.md", content: "local-version\n" },
  ]);

  // No conflictMode specified — should default to skip-conflicts.
  const result = await mergeCapsule({ sourceArchive: archivePath, targetRoot: dst });

  assert.equal(result.conflicts.length, 1);
  assert.equal(result.skipped.length, 1);
  assert.deepEqual(result.skipped[0], { path: "facts/a.md", reason: "conflict" });

  const content = await readFile(path.join(dst, "facts", "a.md"), "utf-8");
  assert.equal(content, "local-version\n", "default mode must not overwrite");
});

// ---------------------------------------------------------------------------
// 3. prefer-source overwrites local
// ---------------------------------------------------------------------------

test("prefer-source mode: overwrites local with archive content", async () => {
  const archiveBuf = makeBundle("prefer-src-cap", [
    { path: "facts/a.md", content: "archive-wins\n" },
  ]);
  const archivePath = await writeBundleArchive(archiveBuf, "prefer-source");

  const dst = await makeTargetDir([
    { rel: "facts/a.md", content: "local-loses\n" },
  ]);

  const result = await mergeCapsule({
    sourceArchive: archivePath,
    targetRoot: dst,
    conflictMode: "prefer-source",
  });

  assert.equal(result.merged.length, 1);
  assert.equal(result.skipped.length, 0);
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.merged[0].sourcePath, "facts/a.md");
  assert.equal(result.merged[0].snapshotted, false, "no versioning config → no snapshot");

  const content = await readFile(path.join(dst, "facts", "a.md"), "utf-8");
  assert.equal(content, "archive-wins\n");
});

test("prefer-source with versioning: snapshots local before overwriting", async () => {
  const archiveBuf = makeBundle("prefer-src-snap-cap", [
    { path: "facts/snap.md", content: "new-from-archive\n" },
  ]);
  const archivePath = await writeBundleArchive(archiveBuf, "prefer-source-snap");

  const dst = await makeTargetDir([
    { rel: "facts/snap.md", content: "old-local-content\n" },
  ]);

  const versioning = {
    enabled: true,
    maxVersionsPerPage: 10,
    sidecarDir: ".versions",
  };

  const result = await mergeCapsule({
    sourceArchive: archivePath,
    targetRoot: dst,
    conflictMode: "prefer-source",
    versioning,
  });

  assert.equal(result.merged.length, 1);
  assert.equal(result.merged[0].snapshotted, true);

  // New content is in place.
  const content = await readFile(path.join(dst, "facts", "snap.md"), "utf-8");
  assert.equal(content, "new-from-archive\n");

  // Page-versioning sidecar holds the prior (old) content.
  const history = await listVersions(
    path.join(dst, "facts", "snap.md"),
    versioning,
    dst,
  );
  assert.equal(history.versions.length, 1, "expected one snapshot");
  const snap = history.versions[0];
  assert.equal(snap.trigger, "manual");
  assert.match(snap.note ?? "", /capsule-merge: prefer-src-snap-cap/);

  const snapFile = path.join(
    dst,
    ".versions",
    "facts__snap",
    `${snap.versionId}.md`,
  );
  const snapContent = await readFile(snapFile, "utf-8");
  assert.equal(snapContent, "old-local-content\n");
});

// ---------------------------------------------------------------------------
// 4. prefer-local skips archive entries that conflict
// ---------------------------------------------------------------------------

test("prefer-local mode: skips archive entries for conflicts, keeps local", async () => {
  const archiveBuf = makeBundle("prefer-local-cap", [
    { path: "facts/a.md", content: "archive-version\n" },
    { path: "facts/b.md", content: "only-in-archive\n" },
  ]);
  const archivePath = await writeBundleArchive(archiveBuf, "prefer-local");

  const dst = await makeTargetDir([
    { rel: "facts/a.md", content: "local-version\n" },
  ]);

  const result = await mergeCapsule({
    sourceArchive: archivePath,
    targetRoot: dst,
    conflictMode: "prefer-local",
  });

  // facts/a.md conflicts → skipped (prefer-local keeps local).
  // facts/b.md is new → merged.
  assert.equal(result.merged.length, 1);
  assert.equal(result.merged[0].sourcePath, "facts/b.md");
  assert.equal(result.skipped.length, 1);
  assert.deepEqual(result.skipped[0], { path: "facts/a.md", reason: "conflict" });
  assert.equal(result.conflicts.length, 1);

  const aContent = await readFile(path.join(dst, "facts", "a.md"), "utf-8");
  assert.equal(aContent, "local-version\n", "prefer-local must not overwrite");

  const bContent = await readFile(path.join(dst, "facts", "b.md"), "utf-8");
  assert.equal(bContent, "only-in-archive\n");
});

// ---------------------------------------------------------------------------
// 5. Reject invalid conflictMode
// ---------------------------------------------------------------------------

test("invalid conflictMode is rejected before any write", async () => {
  const archiveBuf = makeBundle("bad-mode-cap", [
    { path: "facts/a.md", content: "a\n" },
  ]);
  const archivePath = await writeBundleArchive(archiveBuf, "bad-mode");

  const dst = await makeTargetDir();

  await assert.rejects(
    // @ts-expect-error — intentionally passing invalid conflictMode for runtime guard test
    mergeCapsule({ sourceArchive: archivePath, targetRoot: dst, conflictMode: "do-whatever" }),
    /unknown conflictMode/i,
  );

  // No files written.
  const files = await listFiles(dst);
  assert.deepEqual(files, []);
});

// ---------------------------------------------------------------------------
// 6. Identical files are skipped (not re-written)
// ---------------------------------------------------------------------------

test("identical files (same content hash) are skipped with reason 'identical'", async () => {
  const content = "---\nid: same\n---\nidentical body\n";
  const archiveBuf = makeBundle("identical-cap", [
    { path: "facts/same.md", content },
  ]);
  const archivePath = await writeBundleArchive(archiveBuf, "identical");

  // Target already has the same file with identical content.
  const dst = await makeTargetDir([{ rel: "facts/same.md", content }]);

  const result = await mergeCapsule({ sourceArchive: archivePath, targetRoot: dst });

  assert.equal(result.merged.length, 0);
  assert.equal(result.skipped.length, 1);
  assert.deepEqual(result.skipped[0], { path: "facts/same.md", reason: "identical" });
  assert.equal(result.conflicts.length, 0, "identical files are not conflicts");
});

// ---------------------------------------------------------------------------
// 7. conflicts list is populated for ALL modes (not just prefer-source)
// ---------------------------------------------------------------------------

test("conflicts list is populated regardless of mode", async () => {
  const archiveBuf = makeBundle("conflict-list-cap", [
    { path: "facts/a.md", content: "archive-a\n" },
    { path: "facts/b.md", content: "archive-b\n" },
  ]);
  const archivePath = await writeBundleArchive(archiveBuf, "conflict-list");

  const dst = await makeTargetDir([
    { rel: "facts/a.md", content: "local-a\n" },
    { rel: "facts/b.md", content: "local-b\n" },
  ]);

  for (const mode of ["skip-conflicts", "prefer-local"] as const) {
    const dstCopy = await makeTargetDir([
      { rel: "facts/a.md", content: "local-a\n" },
      { rel: "facts/b.md", content: "local-b\n" },
    ]);
    const result = await mergeCapsule({
      sourceArchive: archivePath,
      targetRoot: dstCopy,
      conflictMode: mode,
    });
    assert.equal(
      result.conflicts.length,
      2,
      `mode=${mode} should report 2 conflicts`,
    );
  }

  // prefer-source should also list them.
  const result3 = await mergeCapsule({
    sourceArchive: archivePath,
    targetRoot: dst,
    conflictMode: "prefer-source",
  });
  assert.equal(result3.conflicts.length, 2);
});

// ---------------------------------------------------------------------------
// 8. V1 archive is rejected
// ---------------------------------------------------------------------------

test("V1 archive is rejected (merge requires V2)", async () => {
  const v1Bundle = {
    manifest: {
      format: "openclaw-engram-export" as const,
      schemaVersion: 1 as const,
      createdAt: "2026-04-26T00:00:00.000Z",
      pluginVersion: "9.9.9",
      includesTranscripts: false,
      files: [
        {
          path: "facts/a.md",
          sha256: sha256String("a\n").sha256,
          bytes: 2,
        },
      ],
    },
    records: [{ path: "facts/a.md", content: "a\n" }],
  };
  const tmp = await mkdtemp(path.join(tmpdir(), "capsule-merge-v1-"));
  const archivePath = path.join(tmp, "v1.capsule.json.gz");
  await writeFile(archivePath, gzipSync(Buffer.from(JSON.stringify(v1Bundle), "utf-8")));

  const dst = await makeTargetDir();
  await assert.rejects(
    mergeCapsule({ sourceArchive: archivePath, targetRoot: dst }),
    /V2 capsule archives|V1/i,
  );
});

// ---------------------------------------------------------------------------
// 9. Checksum mismatch aborts before any write
// ---------------------------------------------------------------------------

test("corrupted archive (sha256 mismatch) is rejected before any write", async () => {
  const archivePath = await exportFixtures(
    [{ rel: "facts/a.md", content: "good\n" }],
    "corrupt-merge-cap",
  );

  // Decode → tamper → re-encode.
  const { gunzipSync } = await import("node:zlib");
  const raw = await readFile(archivePath);
  const bundle = JSON.parse(gunzipSync(raw).toString("utf-8")) as {
    records: Array<{ path: string; content: string }>;
  };
  bundle.records[0].content = "tampered\n";
  const tamperedPath = archivePath + ".tampered.json.gz";
  await writeFile(tamperedPath, gzipSync(Buffer.from(JSON.stringify(bundle), "utf-8")));

  const dst = await makeTargetDir();
  await assert.rejects(
    mergeCapsule({ sourceArchive: tamperedPath, targetRoot: dst }),
    /checksum mismatch/i,
  );
  assert.deepEqual(await listFiles(dst), []);
});

// ---------------------------------------------------------------------------
// 10. Non-directory targetRoot is rejected
// ---------------------------------------------------------------------------

test("non-directory targetRoot is rejected", async () => {
  const archiveBuf = makeBundle("bad-root-cap", [{ path: "facts/a.md", content: "a\n" }]);
  const archivePath = await writeBundleArchive(archiveBuf, "bad-root");

  const tmp = await mkdtemp(path.join(tmpdir(), "capsule-merge-bad-root-"));
  const filePath = path.join(tmp, "not-a-dir");
  await writeFile(filePath, "x", "utf-8");

  await assert.rejects(
    mergeCapsule({ sourceArchive: archivePath, targetRoot: filePath }),
    /must be an existing directory/i,
  );
});

// ---------------------------------------------------------------------------
// 11. Path-traversal in record paths is rejected
// ---------------------------------------------------------------------------

test("path traversal in record paths is rejected before any write", async () => {
  const content = "evil\n";
  const buf = makeBundle("traverse-cap", [{ path: "../escape.md", content }]);
  const archivePath = await writeBundleArchive(buf, "traverse");

  const dst = await makeTargetDir();
  await assert.rejects(
    mergeCapsule({ sourceArchive: archivePath, targetRoot: dst }),
    /escapes target root/i,
  );
  assert.deepEqual(await listFiles(dst), []);
});

// ---------------------------------------------------------------------------
// 12. Output lists are sorted for determinism
// ---------------------------------------------------------------------------

test("merged and skipped lists are sorted by path regardless of bundle order", async () => {
  // Archive: z.md, a.md, m.md (deliberately non-sorted in bundle).
  const buf = makeBundle("sort-cap", [
    { path: "z.md", content: "z\n" },
    { path: "a.md", content: "a\n" },
    { path: "m.md", content: "m\n" },
  ]);
  const archivePath = await writeBundleArchive(buf, "sort");
  const dst = await makeTargetDir();

  const result = await mergeCapsule({ sourceArchive: archivePath, targetRoot: dst });

  assert.deepEqual(
    result.merged.map((r) => r.sourcePath),
    ["a.md", "m.md", "z.md"],
  );
});

// ---------------------------------------------------------------------------
// 13. Symlinked targetRoot is rejected
// ---------------------------------------------------------------------------

test("symlinked targetRoot is rejected", async () => {
  const realDir = await mkdtemp(path.join(tmpdir(), "capsule-merge-real-"));
  const holder = await mkdtemp(path.join(tmpdir(), "capsule-merge-holder-"));
  const symlinkRoot = path.join(holder, "symlinked-root");
  await symlink(realDir, symlinkRoot, "dir");

  const archiveBuf = makeBundle("symlink-root-cap", [
    { path: "facts/a.md", content: "a\n" },
  ]);
  const archivePath = await writeBundleArchive(archiveBuf, "symlink-root");

  await assert.rejects(
    mergeCapsule({ sourceArchive: archivePath, targetRoot: symlinkRoot }),
    /must not be a symlink/i,
  );

  assert.deepEqual(await listFiles(realDir), []);
});

// ---------------------------------------------------------------------------
// 14. Normalized-path collisions are rejected before any write
// (Codex P2 thread on PR #748 — mirrors capsule-import.ts hardening.)
// ---------------------------------------------------------------------------

test("manifest with two entries that normalize to the same target path is rejected before any write", async () => {
  // `subdir/file.md` and `subdir/./file.md` both resolve to <root>/subdir/file.md
  // after path.join normalisation. Without the dedup guard:
  //   - skip-conflicts/prefer-local would misclassify the second entry as a
  //     local conflict against the first entry's freshly written content;
  //   - prefer-source would silently overwrite the first with the second.
  // Reject in phase 1 before any write.
  const content1 = "first entry\n";
  const content2 = "second entry\n";

  const bundle = {
    manifest: {
      format: "openclaw-engram-export" as const,
      schemaVersion: 2 as const,
      createdAt: "2026-04-26T00:00:00.000Z",
      pluginVersion: "9.9.9",
      includesTranscripts: false,
      files: [
        {
          path: "subdir/file.md",
          sha256: sha256hex(content1),
          bytes: Buffer.byteLength(content1, "utf-8"),
        },
        {
          path: "subdir/./file.md",
          sha256: sha256hex(content2),
          bytes: Buffer.byteLength(content2, "utf-8"),
        },
      ],
      capsule: {
        id: "dup-norm-cap",
        version: "1.0.0",
        schemaVersion: "taxonomy-v1",
        parentCapsule: null,
        description: "",
        retrievalPolicy: { tierWeights: {}, directAnswerEnabled: false },
        includes: {
          taxonomy: false,
          identityAnchors: false,
          peerProfiles: false,
          procedural: false,
        },
      },
    },
    records: [
      { path: "subdir/file.md", content: content1 },
      { path: "subdir/./file.md", content: content2 },
    ],
  };
  const archivePath = await writeBundleArchive(
    gzipSync(Buffer.from(JSON.stringify(bundle), "utf-8")),
    "dup-norm",
  );
  const dst = await makeTargetDir();

  await assert.rejects(
    mergeCapsule({ sourceArchive: archivePath, targetRoot: dst }),
    /two entries that resolve to the same target path/i,
  );

  assert.deepEqual(await listFiles(dst), [], "must not leave partial writes");
});

test("manifest with two entries that differ only in case is rejected before any write", async () => {
  // On case-insensitive filesystems (macOS default, Windows), `subdir/File.md`
  // and `subdir/file.md` refer to the same inode. The dedup check folds case
  // so both variants are caught regardless of the host's case-sensitivity.
  const content1 = "lowercase\n";
  const content2 = "uppercase\n";

  const bundle = {
    manifest: {
      format: "openclaw-engram-export" as const,
      schemaVersion: 2 as const,
      createdAt: "2026-04-26T00:00:00.000Z",
      pluginVersion: "9.9.9",
      includesTranscripts: false,
      files: [
        {
          path: "subdir/file.md",
          sha256: sha256hex(content1),
          bytes: Buffer.byteLength(content1, "utf-8"),
        },
        {
          path: "subdir/File.md",
          sha256: sha256hex(content2),
          bytes: Buffer.byteLength(content2, "utf-8"),
        },
      ],
      capsule: {
        id: "case-dup-cap",
        version: "1.0.0",
        schemaVersion: "taxonomy-v1",
        parentCapsule: null,
        description: "",
        retrievalPolicy: { tierWeights: {}, directAnswerEnabled: false },
        includes: {
          taxonomy: false,
          identityAnchors: false,
          peerProfiles: false,
          procedural: false,
        },
      },
    },
    records: [
      { path: "subdir/file.md", content: content1 },
      { path: "subdir/File.md", content: content2 },
    ],
  };
  const archivePath = await writeBundleArchive(
    gzipSync(Buffer.from(JSON.stringify(bundle), "utf-8")),
    "case-dup",
  );
  const dst = await makeTargetDir();

  await assert.rejects(
    mergeCapsule({ sourceArchive: archivePath, targetRoot: dst }),
    /two entries that resolve to the same target path/i,
  );

  assert.deepEqual(await listFiles(dst), [], "must not leave partial writes");
});

// ---------------------------------------------------------------------------
// 15. conflicts.archiveSha256 and localSha256 are accurate
// ---------------------------------------------------------------------------

test("conflict record contains accurate sha256 values for both sides", async () => {
  const archiveContent = "from-archive\n";
  const localContent = "from-local\n";

  const buf = makeBundle("sha-cap", [
    { path: "facts/a.md", content: archiveContent },
  ]);
  const archivePath = await writeBundleArchive(buf, "sha256-check");
  const dst = await makeTargetDir([{ rel: "facts/a.md", content: localContent }]);

  const result = await mergeCapsule({
    sourceArchive: archivePath,
    targetRoot: dst,
    conflictMode: "skip-conflicts",
  });

  assert.equal(result.conflicts.length, 1);
  const c = result.conflicts[0];
  assert.equal(c.archiveSha256, sha256String(archiveContent).sha256);
  assert.equal(c.localSha256, sha256String(localContent).sha256);
});

// ---------------------------------------------------------------------------
// Issue #2213: the target's migration journal is a write boundary for merges
// ---------------------------------------------------------------------------

test("merge canonicalizes a legacy entityRef and re-merge stays identical-skip", async () => {
  const archivePath = await exportFixtures(
    [{
      rel: "facts/2026-04-25/fact-legacy-ref.md",
      content: "---\nid: fact-legacy-ref\nentityRef: automation-nightly-ingest\n---\n\nbody\n",
    }],
    "legacy-ref-merge",
  );

  const dst = await makeTargetDir();
  await mkdir(path.join(dst, "state"), { recursive: true });
  await writeFile(
    path.join(dst, "state", "entity-canonical-id-migration-v1.json"),
    JSON.stringify({
      version: 1,
      complete: true,
      mappings: { "automation-nightly-ingest": "automation-cron-job-nightly-ingest" },
    }),
    "utf-8",
  );

  const first = await mergeCapsule({ sourceArchive: archivePath, targetRoot: dst });
  assert.equal(first.merged.length, 1);
  const written = await readFile(path.join(dst, "facts", "2026-04-25", "fact-legacy-ref.md"), "utf-8");
  assert.match(written, /entityRef: automation-cron-job-nightly-ingest/);
  assert.doesNotMatch(written, /entityRef: automation-nightly-ingest/);

  // Re-merging the same capsule must recognize the canonicalized local copy
  // as identical, not surface a phantom conflict.
  const second = await mergeCapsule({ sourceArchive: archivePath, targetRoot: dst });
  assert.equal(second.merged.length, 0);
  assert.equal(second.conflicts.length, 0);
  assert.deepEqual(
    second.skipped.map((s) => s.reason),
    ["identical"],
  );
});
