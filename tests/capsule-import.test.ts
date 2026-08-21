import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";

import { exportCapsule } from "../packages/remnic-core/src/transfer/capsule-export.js";
import {
  importCapsule,
  type ImportCapsuleResult,
  type ImportCapsuleMode,
} from "../packages/remnic-core/src/transfer/capsule-import.js";
import { listVersions } from "../packages/remnic-core/src/page-versioning.js";
import {
  withEntityCanonicalMutationLock,
} from "../packages/remnic-core/src/storage/entity-canonical-id-lock.js";
import {
  ExportBundleV1Schema,
  type ExportBundleV1,
  type ExportBundleV2,
} from "../packages/remnic-core/src/transfer/types.js";

interface FixtureFile {
  rel: string;
  content: string;
}

async function makeMemoryDir(files: FixtureFile[]): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "capsule-import-src-"));
  for (const f of files) {
    const abs = path.join(root, ...f.rel.split("/"));
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, f.content, "utf-8");
  }
  return root;
}

async function makeEmptyMemoryDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "capsule-import-dst-"));
}

async function exportTo(
  files: FixtureFile[],
  name: string,
  capsuleOverrides?: Parameters<typeof exportCapsule>[0]["capsule"],
): Promise<{ archivePath: string; sourceRoot: string }> {
  const sourceRoot = await makeMemoryDir(files);
  const result = await exportCapsule({
    name,
    root: sourceRoot,
    pluginVersion: "9.9.9",
    now: Date.parse("2026-04-26T00:00:00.000Z"),
    capsule: capsuleOverrides,
  });
  return { archivePath: result.archivePath, sourceRoot };
}

async function listMemoryFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string, prefix: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const next = path.join(dir, e.name);
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) {
        // Skip the state/ metadata dir (version sentinels, buffers) — it holds
        // no memory records, and out-of-band writers now bump a corpus-version
        // sentinel there for cache coherence (issue #1902).
        if (prefix === "" && e.name === "state") continue;
        await walk(next, rel);
      } else if (e.isFile()) {
        out.push(rel);
      }
    }
  }
  await walk(root, "");
  return out.sort();
}

// ---------------------------------------------------------------------------
// Round-trip: export → import preserves all memories
// ---------------------------------------------------------------------------

test("round-trip: export then import preserves all memories", async () => {
  const fixtures: FixtureFile[] = [
    { rel: "profile.md", content: "# profile\n" },
    {
      rel: "facts/2026-04-25/fact-1.md",
      content: "---\nid: fact-1\n---\n\nbody-1\n",
    },
    { rel: "entities/acme.md", content: "# Acme\n" },
  ];
  const { archivePath } = await exportTo(fixtures, "round-trip");

  const dst = await makeEmptyMemoryDir();
  const result = await importCapsule({ archivePath, root: dst });

  assert.equal(result.imported.length, 3);
  assert.equal(result.skipped.length, 0);
  assert.equal(result.manifest.capsule.id, "round-trip");

  // Every fixture file landed at its original posix path with byte-equal content.
  for (const f of fixtures) {
    const abs = path.join(dst, ...f.rel.split("/"));
    const got = await readFile(abs, "utf-8");
    assert.equal(got, f.content, `content mismatch for ${f.rel}`);
  }

  // Imported list is sorted by sourcePath for determinism.
  assert.deepEqual(
    result.imported.map((r) => r.sourcePath),
    ["entities/acme.md", "facts/2026-04-25/fact-1.md", "profile.md"],
  );
  assert.ok(result.imported.every((r) => !r.snapshotted && !r.rewroteId));
});

// ---------------------------------------------------------------------------
// skip mode: leaves existing files alone
// ---------------------------------------------------------------------------

test("skip mode (default) skips files that already exist", async () => {
  const { archivePath } = await exportTo(
    [
      { rel: "facts/a.md", content: "---\nid: a\n---\nbody-a\n" },
      { rel: "facts/b.md", content: "---\nid: b\n---\nbody-b\n" },
    ],
    "skip-cap",
  );

  const dst = await makeEmptyMemoryDir();
  // Pre-populate one of the target paths with a different content so we can
  // assert the file is not touched.
  const aAbs = path.join(dst, "facts", "a.md");
  await mkdir(path.dirname(aAbs), { recursive: true });
  await writeFile(aAbs, "preexisting-a\n", "utf-8");

  const result = await importCapsule({ archivePath, root: dst });

  assert.equal(result.imported.length, 1);
  assert.equal(result.imported[0].sourcePath, "facts/b.md");
  assert.equal(result.skipped.length, 1);
  assert.deepEqual(result.skipped[0], { path: "facts/a.md", reason: "exists" });

  const aGot = await readFile(aAbs, "utf-8");
  assert.equal(aGot, "preexisting-a\n", "skip mode must not overwrite");
});

test("skip mode is the default when 'mode' is omitted", async () => {
  const { archivePath } = await exportTo(
    [{ rel: "facts/a.md", content: "x\n" }],
    "skip-default",
  );
  const dst = await makeEmptyMemoryDir();
  await mkdir(path.join(dst, "facts"), { recursive: true });
  await writeFile(path.join(dst, "facts", "a.md"), "preexisting\n", "utf-8");

  const result = await importCapsule({ archivePath, root: dst });
  assert.equal(result.imported.length, 0);
  assert.equal(result.skipped.length, 1);
});

// ---------------------------------------------------------------------------
// overwrite mode: replaces, snapshots prior version
// ---------------------------------------------------------------------------

test("overwrite mode replaces existing files and snapshots prior content", async () => {
  const { archivePath } = await exportTo(
    [{ rel: "facts/a.md", content: "new-a\n" }],
    "overwrite-cap",
  );
  const dst = await makeEmptyMemoryDir();
  const aAbs = path.join(dst, "facts", "a.md");
  await mkdir(path.dirname(aAbs), { recursive: true });
  await writeFile(aAbs, "old-a\n", "utf-8");

  const result = await importCapsule({
    archivePath,
    root: dst,
    mode: "overwrite",
    versioning: {
      enabled: true,
      maxVersionsPerPage: 10,
      sidecarDir: ".versions",
    },
  });

  assert.equal(result.imported.length, 1);
  assert.equal(result.skipped.length, 0);
  assert.equal(result.imported[0].snapshotted, true);

  // New content is in place.
  assert.equal(await readFile(aAbs, "utf-8"), "new-a\n");

  // Page-versioning sidecar holds the prior content as a snapshot, with a
  // capsule-tagged note. Verify by listing versions through the canonical
  // page-versioning API rather than hand-rolling the sidecar layout.
  const history = await listVersions(
    aAbs,
    { enabled: true, maxVersionsPerPage: 10, sidecarDir: ".versions" },
    dst,
  );
  assert.equal(history.versions.length, 1, "expected one snapshot");
  const snap = history.versions[0];
  assert.equal(snap.trigger, "manual");
  assert.match(snap.note ?? "", /capsule-import: overwrite-cap/);

  // Snapshot file contains the OLD content.
  const snapPath = path.join(
    dst,
    ".versions",
    "facts__a",
    `${snap.versionId}.md`,
  );
  assert.equal(await readFile(snapPath, "utf-8"), "old-a\n");
});

test("overwrite mode without versioning config still replaces but does not snapshot", async () => {
  const { archivePath } = await exportTo(
    [{ rel: "facts/a.md", content: "new-a\n" }],
    "overwrite-noversion",
  );
  const dst = await makeEmptyMemoryDir();
  const aAbs = path.join(dst, "facts", "a.md");
  await mkdir(path.dirname(aAbs), { recursive: true });
  await writeFile(aAbs, "old-a\n", "utf-8");

  const result = await importCapsule({
    archivePath,
    root: dst,
    mode: "overwrite",
  });
  assert.equal(result.imported.length, 1);
  assert.equal(result.imported[0].snapshotted, false);
  assert.equal(await readFile(aAbs, "utf-8"), "new-a\n");
  // No .versions sidecar should have been created.
  const versionsDir = path.join(dst, ".versions");
  await assert.rejects(stat(versionsDir));
});

test("overwrite mode writes new files unchanged when no prior content exists", async () => {
  const { archivePath } = await exportTo(
    [{ rel: "facts/new.md", content: "fresh\n" }],
    "overwrite-fresh",
  );
  const dst = await makeEmptyMemoryDir();
  const result = await importCapsule({
    archivePath,
    root: dst,
    mode: "overwrite",
    versioning: {
      enabled: true,
      maxVersionsPerPage: 10,
      sidecarDir: ".versions",
    },
  });
  assert.equal(result.imported.length, 1);
  assert.equal(result.imported[0].snapshotted, false, "no prior content → no snapshot");
});

// ---------------------------------------------------------------------------
// fork mode: rebases under forks/<capsule-id>/ and rewrites frontmatter id
// ---------------------------------------------------------------------------

test("fork mode rebases records under forks/<capsule-id>/ and rewrites frontmatter id", async () => {
  const { archivePath } = await exportTo(
    [
      {
        rel: "facts/preferences.md",
        content: "---\nid: pref-001\nimportance: 5\n---\n\nbody\n",
      },
      { rel: "transcripts/raw.md", content: "no-frontmatter\n" },
    ],
    "fork-cap",
  );
  const dst = await makeEmptyMemoryDir();

  const result = await importCapsule({
    archivePath,
    root: dst,
    mode: "fork",
    now: 1_700_000_000_000,
  });

  // `exportCapsule` excludes `transcripts/` by default (opt-in only), so
  // only the `facts/` file lands in the archive. The transcript fixture is
  // intentionally left in the source tree above to confirm it is *not*
  // exported and therefore not forked.
  const writtenPaths = await listMemoryFiles(dst);
  assert.deepEqual(writtenPaths, [
    "forks/fork-cap/facts/preferences.md",
  ]);

  // The original tree is untouched (no facts/ at the root of dst).
  assert.ok(
    !writtenPaths.some((p) => p === "facts/preferences.md"),
    "fork mode must not touch the original path",
  );

  // Frontmatter `id:` field was rewritten on the file that had one.
  const forkedPref = await readFile(
    path.join(dst, "forks", "fork-cap", "facts", "preferences.md"),
    "utf-8",
  );
  assert.match(forkedPref, /^---\nid: pref-001-fork-fork-cap-[0-9a-f]{8}\nimportance: 5\n---/);
  // Body is preserved.
  assert.match(forkedPref, /\nbody\n$/);

  // Imported metadata reflects per-record fork outcomes.
  const prefImport = result.imported.find((r) => r.sourcePath === "facts/preferences.md");
  const transImport = result.imported.find((r) => r.sourcePath === "transcripts/raw.md");
  assert.equal(prefImport?.rewroteId, true);
  // Transcript was excluded from the export; no record for it in the bundle.
  assert.equal(transImport, undefined);
});

test("fork mode generates new IDs that do not collide with the original", async () => {
  const { archivePath } = await exportTo(
    [
      {
        rel: "facts/a.md",
        content: "---\nid: original-id\n---\nbody\n",
      },
    ],
    "fork-collision",
  );
  const dst = await makeEmptyMemoryDir();

  // Pre-place a file with the ORIGINAL frontmatter id at the original path.
  // Fork mode must not touch it, and the forked file's id must differ.
  const origAbs = path.join(dst, "facts", "a.md");
  await mkdir(path.dirname(origAbs), { recursive: true });
  await writeFile(origAbs, "---\nid: original-id\n---\nbody\n", "utf-8");

  const result = await importCapsule({
    archivePath,
    root: dst,
    mode: "fork",
    now: 1_700_000_000_000,
  });
  assert.equal(result.imported.length, 1);
  assert.equal(result.imported[0].rewroteId, true);

  // Original file was not modified.
  assert.equal(
    await readFile(origAbs, "utf-8"),
    "---\nid: original-id\n---\nbody\n",
  );

  const forkedAbs = path.join(dst, "forks", "fork-collision", "facts", "a.md");
  const forked = await readFile(forkedAbs, "utf-8");
  // The forked id must not equal the original id.
  const idMatch = /^id: (.+)$/m.exec(forked);
  assert.ok(idMatch, "forked file must contain an id line");
  assert.notEqual(idMatch[1], "original-id");
});

test("fork mode is deterministic when 'now' is provided", async () => {
  const { archivePath: archive1 } = await exportTo(
    [{ rel: "facts/a.md", content: "---\nid: x\n---\n" }],
    "fork-det",
  );
  const dst1 = await makeEmptyMemoryDir();
  const dst2 = await makeEmptyMemoryDir();

  await importCapsule({ archivePath: archive1, root: dst1, mode: "fork", now: 42 });
  await importCapsule({ archivePath: archive1, root: dst2, mode: "fork", now: 42 });

  const a1 = await readFile(
    path.join(dst1, "forks", "fork-det", "facts", "a.md"),
    "utf-8",
  );
  const a2 = await readFile(
    path.join(dst2, "forks", "fork-det", "facts", "a.md"),
    "utf-8",
  );
  assert.equal(a1, a2, "deterministic 'now' must produce byte-identical fork output");
});

// ---------------------------------------------------------------------------
// Corruption: bad checksum is rejected with a clear error
// ---------------------------------------------------------------------------

test("corrupted archive (sha256 mismatch) is rejected with a clear error", async () => {
  const { archivePath } = await exportTo(
    [{ rel: "facts/a.md", content: "ok-content\n" }],
    "corrupt-cap",
  );
  // Decode → tamper with a record's content → re-encode without updating
  // the manifest sha256. The importer must catch this before any disk write.
  const { gunzipSync } = await import("node:zlib");
  const raw = await readFile(archivePath);
  const json = gunzipSync(raw).toString("utf-8");
  const bundle = JSON.parse(json) as ExportBundleV2;
  bundle.records[0].content = "tampered-content\n";
  const tamperedPath = archivePath + ".bad.json.gz";
  await writeFile(tamperedPath, gzipSync(Buffer.from(JSON.stringify(bundle), "utf-8")));

  const dst = await makeEmptyMemoryDir();
  await assert.rejects(
    importCapsule({ archivePath: tamperedPath, root: dst }),
    /checksum mismatch/i,
  );
  // Importantly: NO files were written to dst.
  const after = await listMemoryFiles(dst);
  assert.deepEqual(after, [], "checksum failure must not leave partial writes");
});

test("manifest entry without record is rejected", async () => {
  const { archivePath } = await exportTo(
    [
      { rel: "facts/a.md", content: "a\n" },
      { rel: "facts/b.md", content: "b\n" },
    ],
    "missing-rec",
  );
  const raw = await readFile(archivePath);
  const json = (await import("node:zlib")).gunzipSync(raw).toString("utf-8");
  const bundle = JSON.parse(json) as ExportBundleV2;
  // Drop one record; manifest still references it.
  bundle.records = bundle.records.filter((r) => r.path !== "facts/a.md");
  const tamperedPath = archivePath + ".missing.json.gz";
  await writeFile(
    tamperedPath,
    gzipSync(Buffer.from(JSON.stringify(bundle), "utf-8")),
  );

  const dst = await makeEmptyMemoryDir();
  await assert.rejects(
    importCapsule({ archivePath: tamperedPath, root: dst }),
    /manifest entry without record|checksum mismatch/i,
  );
});

test("record without manifest entry is rejected", async () => {
  const { archivePath } = await exportTo(
    [{ rel: "facts/a.md", content: "a\n" }],
    "extra-rec",
  );
  const raw = await readFile(archivePath);
  const json = (await import("node:zlib")).gunzipSync(raw).toString("utf-8");
  const bundle = JSON.parse(json) as ExportBundleV2;
  // Add a record the manifest does not list.
  bundle.records.push({ path: "facts/extra.md", content: "extra\n" });
  const tamperedPath = archivePath + ".extra.json.gz";
  await writeFile(
    tamperedPath,
    gzipSync(Buffer.from(JSON.stringify(bundle), "utf-8")),
  );

  const dst = await makeEmptyMemoryDir();
  await assert.rejects(
    importCapsule({ archivePath: tamperedPath, root: dst }),
    /record without manifest entry|checksum mismatch/i,
  );
});

test("V1 archive is rejected (capsule import is V2-only)", async () => {
  // Hand-build a V1 bundle (no capsule block) and confirm the importer
  // refuses it. PR 1/6 ships the V1 schema; we re-use it here for fidelity.
  const v1: ExportBundleV1 = {
    manifest: {
      format: "openclaw-engram-export",
      schemaVersion: 1,
      createdAt: "2026-04-26T00:00:00.000Z",
      pluginVersion: "9.9.9",
      includesTranscripts: false,
      files: [
        {
          path: "facts/a.md",
          sha256:
            // sha256("a\n")
            "87428fc522803d31065e7bce3cf03fe475096631e5e07bbd7a0fde60c4cf25c7",
          bytes: 2,
        },
      ],
    },
    records: [{ path: "facts/a.md", content: "a\n" }],
  };
  // Sanity: hand-built V1 still parses through the V1 schema.
  ExportBundleV1Schema.parse(v1);

  const tmp = await mkdtemp(path.join(tmpdir(), "capsule-v1-"));
  const archivePath = path.join(tmp, "v1.capsule.json.gz");
  await writeFile(archivePath, gzipSync(Buffer.from(JSON.stringify(v1), "utf-8")));

  const dst = await makeEmptyMemoryDir();
  await assert.rejects(
    importCapsule({ archivePath, root: dst }),
    /V2 capsule archives|V1/,
  );
});

test("non-gzip archive is rejected", async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), "capsule-not-gz-"));
  const archivePath = path.join(tmp, "not.gz");
  await writeFile(archivePath, Buffer.from("not gzip data"));
  const dst = await makeEmptyMemoryDir();
  await assert.rejects(importCapsule({ archivePath, root: dst }));
});

test("non-JSON gzip payload is rejected with a clear error", async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), "capsule-not-json-"));
  const archivePath = path.join(tmp, "bad.json.gz");
  await writeFile(archivePath, gzipSync(Buffer.from("not json", "utf-8")));
  const dst = await makeEmptyMemoryDir();
  await assert.rejects(
    importCapsule({ archivePath, root: dst }),
    /not valid JSON/i,
  );
});

test("non-directory root is rejected", async () => {
  const { archivePath } = await exportTo(
    [{ rel: "facts/a.md", content: "a\n" }],
    "bad-root",
  );
  const tmp = await mkdtemp(path.join(tmpdir(), "capsule-import-bad-"));
  const filePath = path.join(tmp, "not-a-dir");
  await writeFile(filePath, "x", "utf-8");
  await assert.rejects(
    importCapsule({ archivePath, root: filePath }),
    /must be an existing directory/i,
  );
});

test("path traversal in record paths is rejected", async () => {
  // Construct a hand-built V2 bundle that contains a `../escape.md` record.
  // The exporter never emits this, but a hostile/hand-edited archive could.
  const tmp = await mkdtemp(path.join(tmpdir(), "capsule-traversal-"));
  const archivePath = path.join(tmp, "traversal.capsule.json.gz");
  const content = "evil\n";
  const bytes = Buffer.byteLength(content, "utf-8");
  const sha256 = (await import("node:crypto"))
    .createHash("sha256")
    .update(Buffer.from(content, "utf-8"))
    .digest("hex");

  const bundle = {
    manifest: {
      format: "openclaw-engram-export" as const,
      schemaVersion: 2 as const,
      createdAt: "2026-04-26T00:00:00.000Z",
      pluginVersion: "9.9.9",
      includesTranscripts: false,
      files: [{ path: "../escape.md", sha256, bytes }],
      capsule: {
        id: "evil-cap",
        version: "0.1.0",
        schemaVersion: "taxonomy-v1",
        parentCapsule: null,
        description: "",
        retrievalPolicy: { tierWeights: {}, directAnswerEnabled: false },
        includes: { taxonomy: false, identityAnchors: false, peerProfiles: false, procedural: false },
      },
    },
    records: [{ path: "../escape.md", content }],
  };
  await writeFile(
    archivePath,
    gzipSync(Buffer.from(JSON.stringify(bundle), "utf-8")),
  );

  const dst = await makeEmptyMemoryDir();
  await assert.rejects(
    importCapsule({ archivePath, root: dst }),
    /escapes target root/i,
  );
});

// ---------------------------------------------------------------------------
// Duplicate normalized target paths are rejected before any write
// ---------------------------------------------------------------------------

test("manifest with two entries that normalize to the same target path is rejected before any write", async () => {
  // Build a hand-crafted V2 bundle where two records have different `path`
  // values that `path.join` normalises to the same absolute target:
  //   "subdir/file.md"   →  <root>/subdir/file.md
  //   "subdir/./file.md" →  <root>/subdir/file.md  (path.join collapses the .)
  //
  // The importer must catch this in phase 1 before writing anything to disk
  // (Codex P1 thread on PR #741, line 188).
  const { createHash } = await import("node:crypto");
  function sha256hex(s: string): string {
    return createHash("sha256").update(Buffer.from(s, "utf-8")).digest("hex");
  }

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
        id: "dup-path-cap",
        version: "0.1.0",
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

  const tmp = await mkdtemp(path.join(tmpdir(), "capsule-dup-path-"));
  const archivePath = path.join(tmp, "dup-path.capsule.json.gz");
  await writeFile(archivePath, gzipSync(Buffer.from(JSON.stringify(bundle), "utf-8")));

  const dst = await makeEmptyMemoryDir();
  await assert.rejects(
    importCapsule({ archivePath, root: dst }),
    /two entries that resolve to the same target path/i,
  );

  // No files must have been written to dst.
  const written = await listMemoryFiles(dst);
  assert.deepEqual(written, [], "duplicate-path rejection must not leave partial writes");
});

// ---------------------------------------------------------------------------
// Coverage: mode is selected once and applied uniformly
// ---------------------------------------------------------------------------

test("imported records are returned sorted by sourcePath regardless of bundle order", async () => {
  const { archivePath: archivePath } = await exportTo(
    [
      { rel: "z.md", content: "z\n" },
      { rel: "a.md", content: "a\n" },
      { rel: "m.md", content: "m\n" },
    ],
    "sort-cap",
  );
  const dst = await makeEmptyMemoryDir();
  const result = await importCapsule({ archivePath, root: dst });
  assert.deepEqual(
    result.imported.map((r) => r.sourcePath),
    ["a.md", "m.md", "z.md"],
  );
});

// Type-only sanity: ImportCapsuleMode covers exactly the documented values.
const _allModes: ImportCapsuleMode[] = ["skip", "overwrite", "fork"];
void _allModes;

// ---------------------------------------------------------------------------
// Thread 1 (#741 line 467): CRLF line endings preserved during frontmatter rewrite
// ---------------------------------------------------------------------------

test("fork mode preserves CRLF line endings when rewriting frontmatter id", async () => {
  // Build a CRLF file manually and inject it into a hand-crafted bundle so
  // the importer's CRLF-preservation logic (Cursor thread #741 line 467) is
  // exercised.  `exportCapsule` normalises to LF, so we bypass it here.
  const crlfContent = "---\r\nid: crlf-id\r\nimportance: 3\r\n---\r\n\r\nbody text\r\n";
  const { sha256String } = await import(
    "../packages/remnic-core/src/transfer/fs-utils.js"
  );
  const { sha256, bytes } = sha256String(crlfContent);

  const bundle = {
    manifest: {
      format: "openclaw-engram-export" as const,
      schemaVersion: 2 as const,
      createdAt: "2026-04-26T00:00:00.000Z",
      pluginVersion: "9.9.9",
      includesTranscripts: false,
      files: [{ path: "facts/crlf.md", sha256, bytes }],
      capsule: {
        id: "crlf-cap",
        version: "0.1.0",
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
    records: [{ path: "facts/crlf.md", content: crlfContent }],
  };

  const { gzipSync } = await import("node:zlib");
  const tmp = await mkdtemp(path.join(tmpdir(), "capsule-crlf-"));
  const archivePath = path.join(tmp, "crlf.capsule.json.gz");
  await writeFile(archivePath, gzipSync(Buffer.from(JSON.stringify(bundle), "utf-8")));

  const dst = await makeEmptyMemoryDir();
  const result = await importCapsule({
    archivePath,
    root: dst,
    mode: "fork",
    now: 9999,
  });

  assert.equal(result.imported.length, 1);
  assert.equal(result.imported[0].rewroteId, true);

  const written = await readFile(
    path.join(dst, "forks", "crlf-cap", "facts", "crlf.md"),
    "utf-8",
  );

  // The opening `---` delimiter must use CRLF, not LF.
  assert.ok(
    written.startsWith("---\r\n"),
    `expected CRLF after opening ---, got: ${JSON.stringify(written.slice(0, 10))}`,
  );
  // The body line endings must also be CRLF.
  assert.ok(
    written.includes("importance: 3\r\n"),
    "CRLF line endings must be preserved in frontmatter body",
  );
  // The id line was rewritten.
  assert.ok(!written.includes("id: crlf-id\r\n"), "original id must be replaced");
  assert.match(written, /^id: crlf-id-fork-crlf-cap-[0-9a-f]{8}\r\n/m);
  // Body text preserved with CRLF.
  assert.ok(written.includes("\r\nbody text\r\n"), "body CRLF must be preserved");
});

// ---------------------------------------------------------------------------
// Thread 2 (#741 line 247): fork-mode path escape via parent-traversal in
// the original record path is caught by the containment check.
// ---------------------------------------------------------------------------

test("fork mode rejects a record whose original path traverses out of the fork namespace", async () => {
  // A manifest path of `../../escape.md` in fork mode computes a targetRel of
  // `forks/<id>/../../escape.md`, which path.join normalises to `escape.md`
  // (still inside root if only two levels), or if deep enough the suffix
  // escapes the root entirely.  We use enough `../` to definitely escape.
  const content = "evil\n";
  const { sha256String } = await import(
    "../packages/remnic-core/src/transfer/fs-utils.js"
  );
  const { sha256, bytes } = sha256String(content);

  // Three levels of `../` ensures the target ends up above rootReal regardless
  // of how deep rootReal itself is, because path.join collapses the segments:
  //   path.join('/tmp/dst', 'forks/cap-id/../../../escape.md')
  //   → path.join('/tmp/dst', '../escape.md')
  //   → '/tmp/escape.md'  (outside dst)
  const escapingPath = "../../../escape.md";
  const bundle = {
    manifest: {
      format: "openclaw-engram-export" as const,
      schemaVersion: 2 as const,
      createdAt: "2026-04-26T00:00:00.000Z",
      pluginVersion: "9.9.9",
      includesTranscripts: false,
      files: [{ path: escapingPath, sha256, bytes }],
      capsule: {
        id: "escape-cap",
        version: "0.1.0",
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
    records: [{ path: escapingPath, content }],
  };

  const { gzipSync } = await import("node:zlib");
  const tmp = await mkdtemp(path.join(tmpdir(), "capsule-fork-escape-"));
  const archivePath = path.join(tmp, "escape.capsule.json.gz");
  await writeFile(archivePath, gzipSync(Buffer.from(JSON.stringify(bundle), "utf-8")));

  const dst = await makeEmptyMemoryDir();
  await assert.rejects(
    importCapsule({ archivePath, root: dst, mode: "fork" }),
    /escapes target root/i,
  );
  // Nothing should have been written.
  const written = await listMemoryFiles(dst);
  assert.deepEqual(written, [], "escaping fork path must not leave partial writes");
});

// ---------------------------------------------------------------------------
// Thread 3 (#741 line 264): symlinked subdirectory bypass is caught by
// the realpath-aware containment check.
// ---------------------------------------------------------------------------

test("import rejects a record that would write through a symlinked subdirectory pointing outside root", async () => {
  // Create a source capsule with a normal record at `subdir/secret.md`.
  const { archivePath } = await exportTo(
    [{ rel: "subdir/secret.md", content: "should not land outside\n" }],
    "symlink-cap",
  );

  // Create the destination root.
  const dst = await makeEmptyMemoryDir();

  // Create a real directory adjacent to `dst` (the "outside" target).
  const outside = await mkdtemp(path.join(tmpdir(), "capsule-outside-"));

  // Plant a symlink at dst/subdir → outside, so that any write to
  // dst/subdir/secret.md would actually land in outside/secret.md.
  const symlinkPath = path.join(dst, "subdir");
  await symlink(outside, symlinkPath, "dir");

  await assert.rejects(
    importCapsule({ archivePath, root: dst }),
    /escapes target root via symlink/i,
  );

  // Confirm the outside directory is empty (no partial write occurred).
  const outsideFiles = await listMemoryFiles(outside);
  assert.deepEqual(outsideFiles, [], "symlink bypass must not write outside the root");
});

// ---------------------------------------------------------------------------
// Additional coverage for reviewer feedback
// ---------------------------------------------------------------------------

test("fork mode skips files that already exist at the computed fork path", async () => {
  const { archivePath } = await exportTo(
    [{ rel: "facts/a.md", content: "---\nid: orig\n---\nbody\n" }],
    "fork-skip",
  );
  const dst = await makeEmptyMemoryDir();

  // First import: lands at forks/fork-skip/facts/a.md
  const r1 = await importCapsule({ archivePath, root: dst, mode: "fork", now: 1 });
  assert.equal(r1.imported.length, 1);
  assert.equal(r1.skipped.length, 0);

  // Read what was written so we can assert it's unchanged on the second import.
  const forkPath = path.join(dst, "forks", "fork-skip", "facts", "a.md");
  const afterFirst = await readFile(forkPath, "utf-8");

  // Second import of the same archive: the fork path already exists.
  const r2 = await importCapsule({ archivePath, root: dst, mode: "fork", now: 2 });
  assert.equal(r2.imported.length, 0);
  assert.equal(r2.skipped.length, 1);
  assert.deepEqual(r2.skipped[0], { path: "facts/a.md", reason: "exists" });

  // The file on disk must be byte-identical to what the first import wrote.
  const afterSecond = await readFile(forkPath, "utf-8");
  assert.equal(afterSecond, afterFirst, "fork skip-on-exist must not modify the existing file");
});

test("unknown mode string is rejected before any file is written", async () => {
  const { archivePath } = await exportTo(
    [{ rel: "facts/a.md", content: "a\n" }],
    "bad-mode",
  );
  const dst = await makeEmptyMemoryDir();
  await assert.rejects(
    // @ts-expect-error — intentionally passing invalid mode to test runtime guard
    importCapsule({ archivePath, root: dst, mode: "invalid-mode" }),
    /unknown mode/i,
  );
  // No files should have been written.
  const files = await listMemoryFiles(dst);
  assert.deepEqual(files, []);
});

// ---------------------------------------------------------------------------
// Codex P1 round 4 (#741 line 260): target file that is itself a symlink
// is rejected even when parent directories are real.
// Two sub-cases:
//   (a) symlink target is outside root — previously caught by assertRealpathInsideRoot;
//       new lstat check catches it first.
//   (b) symlink target is INSIDE root — assertRealpathInsideRoot would pass but
//       a write would silently redirect to the symlink's destination, altering a
//       different memory file. The new lstat check must catch this too.
// ---------------------------------------------------------------------------

test("import rejects a record whose target path is a symlink pointing outside root", async () => {
  // Build a normal capsule with one record at `facts/secret.md`.
  const { archivePath } = await exportTo(
    [{ rel: "facts/secret.md", content: "should not follow symlink\n" }],
    "file-symlink-outside-cap",
  );

  const dst = await makeEmptyMemoryDir();

  // Create a real file adjacent to `dst` (the "outside" target).
  const outside = await mkdtemp(path.join(tmpdir(), "capsule-file-outside-"));
  const outsideFile = path.join(outside, "victim.md");
  await writeFile(outsideFile, "original content\n", "utf-8");

  // Plant a symlink at the exact target path: dst/facts/secret.md → outsideFile.
  // Parent directory is real; only the file itself is a symlink.
  const factsDir = path.join(dst, "facts");
  await mkdir(factsDir, { recursive: true });
  await symlink(outsideFile, path.join(factsDir, "secret.md"));

  await assert.rejects(
    importCapsule({ archivePath, root: dst }),
    /target is a symlink|escapes target root/i,
  );

  // The outside file must be untouched.
  const afterContent = await readFile(outsideFile, "utf-8");
  assert.equal(afterContent, "original content\n", "symlink-outside write must not occur");
});

test("import rejects a record whose target path is a symlink pointing inside root (intra-root redirect)", async () => {
  // Scenario: dst/facts/secret.md is a symlink → dst/other/existing.md (both
  // inside root). assertRealpathInsideRoot passes because the resolved path is
  // inside root, but the write would silently overwrite `other/existing.md`.
  // The lstat-based target-file check must reject this up-front (Codex P1
  // round 4, line 260).
  const { archivePath } = await exportTo(
    [{ rel: "facts/secret.md", content: "intra-root redirect\n" }],
    "file-symlink-intra-cap",
  );

  const dst = await makeEmptyMemoryDir();

  // Create both dirs and the "victim" inside root.
  const factsDir = path.join(dst, "facts");
  const otherDir = path.join(dst, "other");
  await mkdir(factsDir, { recursive: true });
  await mkdir(otherDir, { recursive: true });
  const victimFile = path.join(otherDir, "existing.md");
  await writeFile(victimFile, "victim content\n", "utf-8");

  // Plant symlink: dst/facts/secret.md → dst/other/existing.md (both inside root).
  await symlink(victimFile, path.join(factsDir, "secret.md"));

  await assert.rejects(
    importCapsule({ archivePath, root: dst }),
    /target is a symlink/i,
  );

  // The victim file must be untouched.
  const afterContent = await readFile(victimFile, "utf-8");
  assert.equal(afterContent, "victim content\n", "intra-root symlink write must not occur");
});

// ---------------------------------------------------------------------------
// Codex P2 round 4 (#741 line 283): case-folded duplicate detection catches
// case-only collisions on case-insensitive filesystems.
// ---------------------------------------------------------------------------

test("manifest with two entries that differ only in case is rejected before any write", async () => {
  // On case-insensitive filesystems (macOS default, Windows), `subdir/File.md`
  // and `subdir/file.md` refer to the same inode.  The dedup check must fold
  // case when building its key so both variants are caught regardless of the
  // filesystem's actual case-sensitivity setting (Codex P2 #741 round 4).
  const { createHash } = await import("node:crypto");
  function sha256hex(s: string): string {
    return createHash("sha256").update(Buffer.from(s, "utf-8")).digest("hex");
  }

  const content1 = "lowercase entry\n";
  const content2 = "uppercase entry\n";

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
        version: "0.1.0",
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

  const tmp = await mkdtemp(path.join(tmpdir(), "capsule-case-dup-"));
  const archivePath = path.join(tmp, "case-dup.capsule.json.gz");
  await writeFile(archivePath, gzipSync(Buffer.from(JSON.stringify(bundle), "utf-8")));

  const dst = await makeEmptyMemoryDir();
  await assert.rejects(
    importCapsule({ archivePath, root: dst }),
    /two entries that resolve to the same target path/i,
  );

  // No files must have been written to dst.
  const written = await listMemoryFiles(dst);
  assert.deepEqual(written, [], "case-fold duplicate rejection must not leave partial writes");
});

// ---------------------------------------------------------------------------
// Codex P1 round 5 (#741 line 244): Windows-style backslash path guard
// ---------------------------------------------------------------------------

async function makeWindowsPathBundle(recordPath: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  const content = "evil\n";
  const sha256 = createHash("sha256")
    .update(Buffer.from(content, "utf-8"))
    .digest("hex");
  const bytes = Buffer.byteLength(content, "utf-8");

  const bundle = {
    manifest: {
      format: "openclaw-engram-export" as const,
      schemaVersion: 2 as const,
      createdAt: "2026-04-26T00:00:00.000Z",
      pluginVersion: "9.9.9",
      includesTranscripts: false,
      files: [{ path: recordPath, sha256, bytes }],
      capsule: {
        id: "win-path-cap",
        version: "0.1.0",
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
    records: [{ path: recordPath, content }],
  };

  const { gzipSync } = await import("node:zlib");
  const tmp = await mkdtemp(path.join(tmpdir(), "capsule-win-path-"));
  const archivePath = path.join(tmp, "win.capsule.json.gz");
  await writeFile(
    archivePath,
    gzipSync(Buffer.from(JSON.stringify(bundle), "utf-8")),
  );
  return archivePath;
}

test("Windows-style backslash path is rejected — simple backslash traversal", async () => {
  // `..\\escape.md` contains a backslash and must be rejected before any
  // write (Codex P1 #741 round 5, line 244).
  const archivePath = await makeWindowsPathBundle("..\\escape.md");
  const dst = await makeEmptyMemoryDir();
  await assert.rejects(
    importCapsule({ archivePath, root: dst }),
    /backslash separators|escapes target root/i,
  );
  const written = await listMemoryFiles(dst);
  assert.deepEqual(written, [], "backslash-path rejection must not leave partial writes");
});

test("Windows-style backslash path is rejected — compound backslash traversal", async () => {
  // `subdir\\..\\..\\escape.md` is another form of parent traversal using
  // Windows separators; must also be caught (Codex P1 #741 round 5, line 244).
  const archivePath = await makeWindowsPathBundle("subdir\\..\\..\\escape.md");
  const dst = await makeEmptyMemoryDir();
  await assert.rejects(
    importCapsule({ archivePath, root: dst }),
    /backslash separators|escapes target root/i,
  );
  const written = await listMemoryFiles(dst);
  assert.deepEqual(written, [], "compound backslash-path rejection must not leave partial writes");
});

test("posix-normalized path starting with '..' is rejected", async () => {
  // `subdir/../../escape.md` — no single segment equals `..` when the
  // normalised result starts with `..`, so the posix.normalize check must catch
  // it (Codex P1 #741 round 5, line 244).  Note that the existing segment-level
  // check already catches this because `..` IS a segment here; this test
  // confirms the posixNormalized guard works as a belt-and-suspenders check.
  const archivePath = await makeWindowsPathBundle("subdir/../../escape.md");
  const dst = await makeEmptyMemoryDir();
  await assert.rejects(
    importCapsule({ archivePath, root: dst }),
    /escapes target root/i,
  );
  const written = await listMemoryFiles(dst);
  assert.deepEqual(written, [], "normalized traversal rejection must not leave partial writes");
});

// ---------------------------------------------------------------------------
// Codex P1 round 5 (#741 line 443): symlinked root is rejected up-front
// ---------------------------------------------------------------------------

test("symlinked root is rejected — importCapsule must refuse a root that is a symlink", async () => {
  // Create a real directory as the eventual target of the symlink.
  const realDir = await mkdtemp(path.join(tmpdir(), "capsule-real-root-"));
  // Create a symlink that points to the real directory.
  const symlinkRoot = path.join(
    await mkdtemp(path.join(tmpdir(), "capsule-symlink-holder-")),
    "symlinked-root",
  );
  await symlink(realDir, symlinkRoot, "dir");

  const { archivePath } = await exportTo(
    [{ rel: "facts/a.md", content: "should not land\n" }],
    "symlink-root-cap",
  );

  // importCapsule must reject the symlinked root before any write.
  await assert.rejects(
    importCapsule({ archivePath, root: symlinkRoot }),
    /must not be a symlink/i,
  );

  // The real directory must be empty (no files were written through the symlink).
  const files = await listMemoryFiles(realDir);
  assert.deepEqual(files, [], "symlinked root rejection must not write to the resolved target");
});

test("symlinked root pointing to a sensitive path is rejected", async () => {
  // Simulate an attacker supplying /tmp/import-target → /etc (or any real dir
  // on this machine).  We use a tmpdir rather than /etc to keep the test
  // portable, but the security property is the same: the root being a symlink
  // must be rejected regardless of where it points.
  const sensitiveDir = await mkdtemp(path.join(tmpdir(), "capsule-sensitive-"));
  const symlinkRoot = path.join(
    await mkdtemp(path.join(tmpdir(), "capsule-symlink-holder2-")),
    "symlinked-sensitive",
  );
  await symlink(sensitiveDir, symlinkRoot, "dir");

  const { archivePath } = await exportTo(
    [{ rel: "facts/a.md", content: "should not land\n" }],
    "symlink-root-sensitive-cap",
  );

  await assert.rejects(
    importCapsule({ archivePath, root: symlinkRoot }),
    /must not be a symlink/i,
  );

  // sensitiveDir must remain empty.
  const files = await listMemoryFiles(sensitiveDir);
  assert.deepEqual(files, [], "writes must not reach the symlink target");
});

// ---------------------------------------------------------------------------
// Issue #2213: the target's migration journal is a write boundary for imports
// ---------------------------------------------------------------------------

test("import canonicalizes a legacy entityRef through the target's migration journal", async () => {
  const { archivePath } = await exportTo(
    [{
      rel: "facts/2026-04-25/fact-legacy-ref.md",
      content: "---\nid: fact-legacy-ref\nentityRef: automation-nightly-ingest\n---\n\nbody\n",
    }],
    "legacy-ref",
  );

  const dst = await makeEmptyMemoryDir();
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

  const result = await importCapsule({ archivePath, root: dst });
  assert.equal(result.imported.length, 1);
  const written = await readFile(path.join(dst, "facts", "2026-04-25", "fact-legacy-ref.md"), "utf-8");
  assert.match(written, /entityRef: automation-cron-job-nightly-ingest/);
  assert.doesNotMatch(written, /entityRef: automation-nightly-ingest/);
  // Body and unrelated frontmatter stay byte-identical.
  assert.match(written, /id: fact-legacy-ref/);
  assert.match(written, /body\n$/);
});

test("entity page imports wait for the target canonical mutation lock", async () => {
  const entityRel = "entities/capsule-import-lock-target.md";
  const originalEntity = "original import entity bytes\n";
  const importedEntity = "imported entity bytes\n";
  const { archivePath, sourceRoot } = await exportTo(
    [{ rel: entityRel, content: importedEntity }],
    "entity-lock-import",
  );
  const targetRoot = await makeMemoryDir([{ rel: entityRel, content: originalEntity }]);
  const controlRoot = await makeMemoryDir([{ rel: entityRel, content: originalEntity }]);
  const entityPath = path.join(targetRoot, entityRel);
  let importPromise: Promise<ImportCapsuleResult> | undefined;

  try {
    await mkdir(path.join(targetRoot, "state"), { recursive: true });
    let importFinished = false;

    await withEntityCanonicalMutationLock(path.join(targetRoot, "state"), async () => {
      importPromise = importCapsule({
        archivePath,
        root: targetRoot,
        mode: "overwrite",
      });
      void importPromise.then(
        () => {
          importFinished = true;
        },
        () => undefined,
      );

      const controlResult = await importCapsule({
        archivePath,
        root: controlRoot,
        mode: "overwrite",
      });
      assert.equal(controlResult.imported.length, 1);
      assert.equal(
        importFinished,
        false,
        "the target import must not finish while its entity mutation lock is held",
      );
      assert.equal(
        await readFile(entityPath, "utf-8"),
        originalEntity,
        "the target entity write must not enter while its canonical mutation lock is held",
      );
    });

    assert.ok(importPromise);
    const result = await importPromise;
    assert.equal(result.imported.length, 1);
    assert.equal(await readFile(entityPath, "utf-8"), importedEntity);
  } finally {
    await importPromise?.catch(() => undefined);
    await Promise.all([
      rm(sourceRoot, { recursive: true, force: true }),
      rm(targetRoot, { recursive: true, force: true }),
      rm(controlRoot, { recursive: true, force: true }),
    ]);
  }
});
