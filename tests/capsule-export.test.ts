import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";

import { exportCapsule } from "../src/transfer/capsule-export.js";
import {
  CAPSULE_ID_PATTERN,
  ExportBundleV2Schema,
  parseExportBundle,
  parseExportManifest,
} from "../src/transfer/types.js";

interface FixtureFile {
  rel: string;
  content: string;
  mtime?: Date;
}

async function makeFixture(files: FixtureFile[]): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "capsule-export-"));
  for (const f of files) {
    const abs = path.join(root, ...f.rel.split("/"));
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, f.content, "utf-8");
    if (f.mtime) {
      await utimes(abs, f.mtime, f.mtime);
    }
  }
  return root;
}

function readArchive(absPath: string): Promise<Buffer> {
  return readFile(absPath);
}

test("exportCapsule writes a V2 manifest and gzipped bundle that round-trips", async () => {
  const root = await makeFixture([
    { rel: "profile.md", content: "# profile\n" },
    {
      rel: "facts/2026-04-25/fact-1.md",
      content: "---\nid: fact-1\n---\n\nbody-1\n",
    },
    {
      rel: "entities/acme.md",
      content: "# Acme\n",
    },
  ]);

  const result = await exportCapsule({
    name: "test-capsule",
    root,
    pluginVersion: "9.9.9",
    now: Date.parse("2026-04-26T00:00:00.000Z"),
  });

  assert.equal(result.manifest.schemaVersion, 2);
  assert.equal(result.manifest.format, "openclaw-engram-export");
  assert.equal(result.manifest.pluginVersion, "9.9.9");
  assert.equal(result.manifest.includesTranscripts, false);
  assert.equal(result.manifest.capsule.id, "test-capsule");
  assert.equal(result.manifest.capsule.parentCapsule, null);

  // 3 fixture files, all included.
  assert.equal(result.manifest.files.length, 3);
  assert.deepEqual(
    result.manifest.files.map((f) => f.path),
    [
      "entities/acme.md",
      "facts/2026-04-25/fact-1.md",
      "profile.md",
    ],
  );

  // Sidecar manifest.json mirrors the in-memory manifest.
  const sidecar = JSON.parse(await readFile(result.manifestPath, "utf-8"));
  assert.deepEqual(sidecar, result.manifest);

  // Archive: gunzip + parse + validate against V2 bundle schema.
  const gz = await readArchive(result.archivePath);
  const json = gunzipSync(gz).toString("utf-8");
  const bundle = ExportBundleV2Schema.parse(JSON.parse(json));
  assert.equal(bundle.records.length, 3);
  assert.deepEqual(
    bundle.records.map((r) => r.path),
    [
      "entities/acme.md",
      "facts/2026-04-25/fact-1.md",
      "profile.md",
    ],
  );
  // Records and manifest agree on file content via sha256.
  for (const rec of bundle.records) {
    const entry = bundle.manifest.files.find((f) => f.path === rec.path);
    assert.ok(entry, `manifest entry for ${rec.path}`);
    assert.equal(entry.bytes, Buffer.byteLength(rec.content, "utf-8"));
  }

  // parseExportBundle (V1/V2 dispatcher from PR 1/6) accepts the output.
  const parsed = parseExportBundle(JSON.parse(json));
  assert.equal(parsed.capsuleVersion, 2);
  assert.equal(parsed.capsule?.id, "test-capsule");
});

test("'since' filter excludes files older than the cutoff", async () => {
  const oldMtime = new Date("2026-01-01T00:00:00Z");
  const newMtime = new Date("2026-04-01T00:00:00Z");
  const root = await makeFixture([
    { rel: "facts/old.md", content: "old\n", mtime: oldMtime },
    { rel: "facts/new.md", content: "new\n", mtime: newMtime },
  ]);

  const result = await exportCapsule({
    name: "since-capsule",
    root,
    since: "2026-03-01T00:00:00.000Z",
  });

  assert.equal(result.manifest.files.length, 1);
  assert.equal(result.manifest.files[0].path, "facts/new.md");
});

test("'includeKinds' restricts top-level subdirectories", async () => {
  const root = await makeFixture([
    { rel: "profile.md", content: "p\n" },
    { rel: "facts/a.md", content: "a\n" },
    { rel: "entities/b.md", content: "b\n" },
    { rel: "corrections/c.md", content: "c\n" },
  ]);

  const result = await exportCapsule({
    name: "kinds-capsule",
    root,
    includeKinds: ["facts", "entities"],
  });

  assert.deepEqual(
    result.manifest.files.map((f) => f.path),
    ["entities/b.md", "facts/a.md"],
  );
  // root-level files (profile.md) excluded under an explicit allow-list.
  assert.ok(!result.manifest.files.some((f) => f.path === "profile.md"));
});

test("transcripts are excluded by default and opt-in via includeKinds", async () => {
  const root = await makeFixture([
    { rel: "facts/a.md", content: "a\n" },
    { rel: "transcripts/t.md", content: "t\n" },
  ]);

  const exclude = await exportCapsule({ name: "no-transcripts", root });
  assert.equal(exclude.manifest.includesTranscripts, false);
  assert.ok(!exclude.manifest.files.some((f) => f.path.startsWith("transcripts/")));

  const include = await exportCapsule({
    name: "with-transcripts",
    root,
    includeKinds: ["facts", "transcripts"],
  });
  assert.equal(include.manifest.includesTranscripts, true);
  assert.ok(include.manifest.files.some((f) => f.path === "transcripts/t.md"));
});

test("'peerIds' restricts the peers/ tree", async () => {
  const root = await makeFixture([
    { rel: "facts/a.md", content: "a\n" },
    { rel: "peers/alice/profile.md", content: "alice\n" },
    { rel: "peers/bob/profile.md", content: "bob\n" },
    { rel: "peers/carol/profile.md", content: "carol\n" },
  ]);

  const result = await exportCapsule({
    name: "peers-capsule",
    root,
    peerIds: ["alice", "carol"],
  });
  const peerPaths = result.manifest.files
    .filter((f) => f.path.startsWith("peers/"))
    .map((f) => f.path)
    .sort();
  assert.deepEqual(peerPaths, [
    "peers/alice/profile.md",
    "peers/carol/profile.md",
  ]);
  // bob is excluded.
  assert.ok(!result.manifest.files.some((f) => f.path.startsWith("peers/bob/")));
  // Non-peer kinds still flow through.
  assert.ok(result.manifest.files.some((f) => f.path === "facts/a.md"));
});

test("empty 'peerIds' array excludes the entire peers/ tree", async () => {
  const root = await makeFixture([
    { rel: "facts/a.md", content: "a\n" },
    { rel: "peers/alice/profile.md", content: "alice\n" },
  ]);

  const result = await exportCapsule({
    name: "no-peers",
    root,
    peerIds: [],
  });
  assert.ok(!result.manifest.files.some((f) => f.path.startsWith("peers/")));
  assert.ok(result.manifest.files.some((f) => f.path === "facts/a.md"));
});

test("empty result still produces a valid manifest + archive", async () => {
  const root = await makeFixture([
    { rel: "facts/a.md", content: "a\n" },
  ]);

  const result = await exportCapsule({
    name: "empty-capsule",
    root,
    // No top-level segment matches → all files filtered out.
    includeKinds: ["nonexistent"],
  });

  assert.equal(result.manifest.files.length, 0);
  const gz = await readArchive(result.archivePath);
  const bundle = ExportBundleV2Schema.parse(JSON.parse(gunzipSync(gz).toString("utf-8")));
  assert.equal(bundle.records.length, 0);
  // Manifest still parses through the V1/V2 dispatcher.
  const parsed = parseExportManifest(bundle.manifest);
  assert.equal(parsed.capsuleVersion, 2);
});

test("invalid name is rejected", async () => {
  const root = await makeFixture([{ rel: "a.md", content: "a\n" }]);
  await assert.rejects(
    exportCapsule({ name: "Invalid Name!", root }),
    /invalid capsule name/i,
  );
  // Confirm the regex test agrees.
  assert.equal(CAPSULE_ID_PATTERN.test("Invalid Name!"), false);
});

test("invalid 'since' is rejected", async () => {
  const root = await makeFixture([{ rel: "a.md", content: "a\n" }]);
  await assert.rejects(
    exportCapsule({ name: "bad-since", root, since: "not-a-date" }),
    /not a valid ISO/i,
  );
});

test("'since' rejects calendar-overflow dates (e.g. Feb 31)", async () => {
  const root = await makeFixture([{ rel: "a.md", content: "a\n" }]);
  // Each of these passes the regex but `Date.parse` silently normalizes to a
  // different calendar day. We must reject them rather than shifting the
  // user's intended cutoff window.
  for (const bad of [
    "2026-02-31",
    "2026-02-30",
    "2026-04-31",
    "2026-13-01",
    "2026-00-15",
    "2026-02-31T00:00:00Z",
    "2026-02-31T00:00:00-05:00",
  ]) {
    await assert.rejects(
      exportCapsule({ name: "bad-cal", root, since: bad }),
      /not a valid ISO/i,
      `expected ${bad} to be rejected`,
    );
  }
});

test("'since' accepts well-formed timestamps with offsets", async () => {
  const root = await makeFixture([
    {
      rel: "facts/a.md",
      content: "a\n",
      mtime: new Date("2026-04-01T00:00:00Z"),
    },
  ]);
  for (const good of [
    "2026-02-28",
    "2026-02-28T00:00:00Z",
    "2026-02-28T00:00:00.500Z",
    "2026-02-28T19:00:00-05:00",
    "2024-02-29", // leap year
  ]) {
    const result = await exportCapsule({
      name: "good-since",
      root,
      since: good,
    });
    // The "since" cutoff (Feb 28 2026, etc.) should not exclude an April 1 mtime.
    if (good.startsWith("2026-")) {
      assert.equal(result.manifest.files.length, 1, `expected file kept for ${good}`);
    }
  }
});

test("'since' rejects time-of-day forms without a timezone designator", async () => {
  const root = await makeFixture([{ rel: "a.md", content: "a\n" }]);
  // ECMAScript parses these as local time, which makes acceptance and the
  // resulting cutoff depend on the host's TZ. The strict regex requires an
  // explicit Z or ±HH:MM offset whenever a time component is present.
  for (const bad of [
    "2026-02-28T00:00:00",
    "2026-02-28T12:34",
    "2026-02-28T00:00:00.500",
  ]) {
    await assert.rejects(
      exportCapsule({ name: "bad-tz", root, since: bad }),
      /not a valid ISO/i,
      `expected ${bad} to be rejected`,
    );
  }
});

test("non-directory root is rejected", async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), "capsule-root-file-"));
  const filePath = path.join(tmp, "not-a-dir");
  await writeFile(filePath, "x", "utf-8");
  await assert.rejects(
    exportCapsule({ name: "bad-root", root: filePath }),
    /must be an existing directory/i,
  );
});

test("includeKinds entries with path separators are rejected", async () => {
  const root = await makeFixture([{ rel: "a/b.md", content: "a\n" }]);
  await assert.rejects(
    exportCapsule({ name: "bad-kind", root, includeKinds: ["facts/sub"] }),
    /top-level segment/i,
  );
});

test("peerIds entries with traversal segments are rejected", async () => {
  const root = await makeFixture([{ rel: "peers/a/p.md", content: "a\n" }]);
  await assert.rejects(
    exportCapsule({ name: "bad-peer", root, peerIds: [".."] }),
    /plain segment/i,
  );
});

test("capsule overrides flow into the manifest", async () => {
  const root = await makeFixture([{ rel: "a.md", content: "a\n" }]);
  const result = await exportCapsule({
    name: "override-capsule",
    root,
    capsule: {
      version: "1.2.3",
      description: "research bundle",
      parentCapsule: "parent-id",
      retrievalPolicy: {
        tierWeights: { bm25: 0.5, vector: 0.5 },
        directAnswerEnabled: true,
      },
      includes: {
        taxonomy: true,
        identityAnchors: false,
        peerProfiles: false,
        procedural: true,
      },
    },
  });
  assert.equal(result.manifest.capsule.version, "1.2.3");
  assert.equal(result.manifest.capsule.description, "research bundle");
  assert.equal(result.manifest.capsule.parentCapsule, "parent-id");
  assert.equal(result.manifest.capsule.retrievalPolicy.directAnswerEnabled, true);
  assert.equal(result.manifest.capsule.includes.taxonomy, true);
});

test("default outDir under root is excluded from the input scan (idempotent re-export)", async () => {
  const root = await makeFixture([
    { rel: "facts/a.md", content: "a\n" },
  ]);

  // First export — outDir defaults to <root>/.capsules and writes archive +
  // sidecar there. Without the outDir filter, the SECOND run would re-
  // package those artifacts as records under `.capsules/...`.
  const first = await exportCapsule({ name: "round-1", root });
  assert.equal(first.manifest.files.length, 1);
  assert.equal(first.manifest.files[0].path, "facts/a.md");

  const second = await exportCapsule({ name: "round-2", root });
  // Still only the original fixture file. No `.capsules/` entries leak in.
  assert.deepEqual(
    second.manifest.files.map((f) => f.path),
    ["facts/a.md"],
  );
  assert.ok(
    !second.manifest.files.some((f) => f.path.startsWith(".capsules/")),
    "default outDir contents must never appear in the manifest",
  );
});

test("explicit outDir under root is also excluded from the input scan", async () => {
  const root = await makeFixture([
    { rel: "facts/a.md", content: "a\n" },
  ]);
  const customOut = path.join(root, "exports", "nested");

  await exportCapsule({ name: "first", root, outDir: customOut });
  const second = await exportCapsule({
    name: "second",
    root,
    outDir: customOut,
  });

  assert.deepEqual(
    second.manifest.files.map((f) => f.path),
    ["facts/a.md"],
  );
  assert.ok(
    !second.manifest.files.some((f) => f.path.startsWith("exports/")),
    "files under the custom outDir must be excluded",
  );
});

test("outDir equal to root is rejected (avoids silent empty export)", async () => {
  const root = await makeFixture([{ rel: "facts/a.md", content: "a\n" }]);

  await assert.rejects(
    () => exportCapsule({ name: "self", root, outDir: root }),
    /'outDir' must not equal 'root'/,
    "exportCapsule must throw when outDir resolves to the same path as root",
  );
});

test("outDir resolving to root via '.' segments is also rejected", async () => {
  const root = await makeFixture([{ rel: "facts/a.md", content: "a\n" }]);
  // outDir is logically the same directory as root but written with a trailing
  // "/." — `path.resolve` normalizes both to the same absolute path, so the
  // equality check must catch this case too.
  await assert.rejects(
    () => exportCapsule({ name: "self", root, outDir: path.join(root, ".") }),
    /'outDir' must not equal 'root'/,
    "outDir written as `<root>/.` must still be rejected",
  );
});

test("outDir name starting with '..' is treated as in-tree (not parent-traversal)", async () => {
  // Codex P2 (#731): the prior outside-root check used `rel.startsWith("..")`,
  // which incorrectly classified valid in-tree directory names like
  // `..capsules` as parent-traversal and skipped excluding them. The boundary
  // check (`rel === ".."` or starts with `".." + path.sep`) correctly treats
  // `..capsules` as in-tree and excludes its subtree from re-export.
  const root = await makeFixture([{ rel: "facts/a.md", content: "a\n" }]);
  const dotsDir = path.join(root, "..capsules");

  // First export — writes archive + sidecar into the literal `..capsules`
  // subdir. The directory name resolves under root (no traversal).
  await exportCapsule({ name: "first", root, outDir: dotsDir });

  const second = await exportCapsule({
    name: "second",
    root,
    outDir: dotsDir,
  });
  // The first run's archive + manifest must not appear in the second manifest.
  for (const f of second.manifest.files) {
    assert.ok(
      !f.path.startsWith("..capsules/"),
      `..capsules contents must be excluded, got: ${f.path}`,
    );
  }
});

test("outDir outside root does not affect inclusion", async () => {
  const root = await makeFixture([
    { rel: "facts/a.md", content: "a\n" },
    { rel: "exports/note.md", content: "n\n" },
  ]);
  const outsideOut = await mkdtemp(path.join(tmpdir(), "capsule-outside-"));

  const result = await exportCapsule({
    name: "outside",
    root,
    outDir: outsideOut,
  });
  // exports/note.md is NOT the outDir; it must still be included.
  assert.deepEqual(
    result.manifest.files.map((f) => f.path).sort(),
    ["exports/note.md", "facts/a.md"],
  );
});

test("outDir named '..capsules' (valid in-tree dir) is still excluded", async () => {
  // Boundary check: `rel.startsWith("..")` would falsely treat `<root>/..capsules`
  // as outside the root. Use `rel === ".."` or `rel.startsWith(".." + sep)`
  // so valid in-tree names like `..capsules` are still excluded on re-export.
  const root = await makeFixture([{ rel: "facts/a.md", content: "a\n" }]);
  const trickyOut = path.join(root, "..capsules");

  await exportCapsule({ name: "first", root, outDir: trickyOut });
  const second = await exportCapsule({
    name: "second",
    root,
    outDir: trickyOut,
  });
  assert.deepEqual(
    second.manifest.files.map((f) => f.path),
    ["facts/a.md"],
    "files under '..capsules' (an in-tree dir) must be excluded on re-export",
  );
  assert.ok(
    !second.manifest.files.some((f) => f.path.startsWith("..capsules/")),
    "the in-tree '..capsules' subtree must not leak into the manifest",
  );
});

test("default-excluded directories (.git, node_modules) are skipped", async () => {
  const root = await makeFixture([
    { rel: "facts/a.md", content: "a\n" },
    { rel: ".git/HEAD", content: "ref\n" },
    { rel: "node_modules/dep/index.js", content: "x\n" },
  ]);
  const result = await exportCapsule({ name: "no-junk", root });
  assert.ok(result.manifest.files.every((f) => !f.path.startsWith(".git/")));
  assert.ok(result.manifest.files.every((f) => !f.path.startsWith("node_modules/")));
  assert.ok(result.manifest.files.some((f) => f.path === "facts/a.md"));
});
