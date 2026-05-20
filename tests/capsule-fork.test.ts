/**
 * Tests for capsule fork semantics — issue #676 PR 4/6.
 *
 * Coverage:
 *  1. fork creates lineage breadcrumb with correct parent metadata
 *  2. fork on existing fork-id is rejected (before any write)
 *  3. lineage chain across two forks (A→B→C) is queryable
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { exportCapsule } from "../packages/remnic-core/src/transfer/capsule-export.js";
import {
  forkCapsule,
  readForkLineage,
  type ForkLineage,
} from "../packages/remnic-core/src/transfer/capsule-fork.js";
import { CapsuleParentSchema } from "../packages/remnic-core/src/transfer/types.js";
import { parseCapsuleForkArgs } from "../packages/remnic-cli/src/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface FixtureFile {
  rel: string;
  content: string;
}

async function makeMemoryDir(files: FixtureFile[]): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "capsule-fork-src-"));
  for (const f of files) {
    const abs = path.join(root, ...f.rel.split("/"));
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, f.content, "utf-8");
  }
  return root;
}

async function makeEmptyDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "capsule-fork-dst-"));
}

/** Export a set of files as a named capsule archive and return the archivePath. */
async function exportFixture(
  files: FixtureFile[],
  name: string,
  capsuleVersion?: string,
): Promise<{ archivePath: string; sourceRoot: string }> {
  const sourceRoot = await makeMemoryDir(files);
  const result = await exportCapsule({
    name,
    root: sourceRoot,
    pluginVersion: "9.9.9",
    now: Date.parse("2026-04-26T00:00:00.000Z"),
    capsule: capsuleVersion ? { version: capsuleVersion } : undefined,
  });
  return { archivePath: result.archivePath, sourceRoot };
}

async function listAll(dir: string): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  const out: string[] = [];
  async function walk(d: string, prefix: string): Promise<void> {
    const entries = await readdir(d, { withFileTypes: true });
    for (const e of entries) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(path.join(d, e.name), rel);
      else out.push(rel);
    }
  }
  await walk(dir, "");
  return out.sort();
}

// ---------------------------------------------------------------------------
// Test 1: fork creates lineage breadcrumb with correct parent metadata
// ---------------------------------------------------------------------------

test("forkCapsule: creates lineage breadcrumb with correct parent metadata", async () => {
  const files: FixtureFile[] = [
    { rel: "facts/2026-04-25/fact-a.md", content: "---\nid: fact-a\n---\n\nbody-a\n" },
    { rel: "entities/acme.md", content: "# Acme\n" },
  ];

  const { archivePath } = await exportFixture(files, "parent-capsule", "1.2.0");
  const targetRoot = await makeEmptyDir();

  const result = await forkCapsule({
    sourceArchive: archivePath,
    targetRoot,
    forkId: "my-fork",
    now: 42,
  });

  // --- lineage shape ---
  const { lineage, lineagePath } = result;
  assert.equal(lineage.forkId, "my-fork");
  assert.equal(lineage.parent.capsuleId, "parent-capsule");
  assert.equal(lineage.parent.version, "1.2.0");
  assert.equal(lineage.parent.forkRoot, "forks/parent-capsule");
  assert.equal(lineage.importedRecords, 2);
  assert.equal(lineage.skippedRecords, 0);
  // forkedAt is an ISO-8601 string
  assert.match(lineage.forkedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);

  // --- breadcrumb file exists and is valid JSON ---
  const raw = await readFile(lineagePath, "utf-8");
  const parsed: ForkLineage = JSON.parse(raw);
  assert.equal(parsed.forkId, "my-fork");
  assert.equal(parsed.parent.capsuleId, "parent-capsule");
  assert.equal(parsed.parent.version, "1.2.0");

  // --- lineagePath is inside forks/<forkId>/ ---
  const rel = path.relative(targetRoot, lineagePath);
  assert.equal(rel, path.join("forks", "my-fork", "lineage.json"));

  // --- imported records land under forks/<capsuleId>/ ---
  const allFiles = await listAll(targetRoot);
  assert.ok(
    allFiles.some((f) => f.startsWith("forks/parent-capsule/facts/")),
    "imported records should be under forks/parent-capsule/",
  );
  assert.ok(
    allFiles.includes("forks/my-fork/lineage.json"),
    "lineage breadcrumb should be at forks/my-fork/lineage.json",
  );
});

// ---------------------------------------------------------------------------
// Test 2: fork-on-existing-fork-id is rejected
// ---------------------------------------------------------------------------

test("forkCapsule: rejects duplicate forkId before any write", async () => {
  const files: FixtureFile[] = [
    { rel: "facts/a.md", content: "---\nid: a\n---\n\nbody\n" },
  ];

  const { archivePath } = await exportFixture(files, "source-cap");
  const targetRoot = await makeEmptyDir();

  // First fork succeeds.
  await forkCapsule({
    sourceArchive: archivePath,
    targetRoot,
    forkId: "dup-fork",
    now: 1,
  });

  // Second fork with the same forkId must throw BEFORE writing.
  await assert.rejects(
    () => forkCapsule({ sourceArchive: archivePath, targetRoot, forkId: "dup-fork", now: 2 }),
    (err: Error) => {
      assert.ok(
        err.message.includes("dup-fork") && err.message.includes("already in use"),
        `Expected "already in use" error, got: ${err.message}`,
      );
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// Test 3: lineage chain across two forks (A→B→C) is queryable
// ---------------------------------------------------------------------------

test("forkCapsule: lineage chain A→B→C is queryable via readForkLineage", async () => {
  // Capsule A (the root archive)
  const filesA: FixtureFile[] = [
    { rel: "facts/a.md", content: "---\nid: a\n---\n\nroot fact\n" },
  ];
  const { archivePath: archiveA } = await exportFixture(filesA, "capsule-a", "1.0.0");

  // Fork A → B: import A into targetB as fork "fork-b"
  const targetB = await makeEmptyDir();
  const forkBResult = await forkCapsule({
    sourceArchive: archiveA,
    targetRoot: targetB,
    forkId: "fork-b",
    now: 100,
  });

  // Verify B's lineage points to A.
  const lineageB = await readForkLineage(targetB, "fork-b");
  assert.ok(lineageB !== null, "lineage for fork-b must exist");
  assert.equal(lineageB!.forkId, "fork-b");
  assert.equal(lineageB!.parent.capsuleId, "capsule-a");
  assert.equal(lineageB!.parent.version, "1.0.0");
  assert.equal(lineageB!.parent.forkRoot, "forks/capsule-a");

  // Now export B's fork tree as capsule-b so we can fork it again.
  // We export from targetB (which now contains forks/capsule-a/ and forks/fork-b/).
  const exportBResult = await exportCapsule({
    name: "capsule-b",
    root: targetB,
    pluginVersion: "9.9.9",
    now: Date.parse("2026-04-26T00:00:00.000Z"),
    capsule: {
      version: "2.0.0",
      parent: {
        capsuleId: "capsule-a",
        version: "1.0.0",
        forkRoot: "forks/capsule-a",
      },
      parentCapsule: "capsule-a",
    },
  });

  // Fork B → C: import capsule-b archive into targetC as fork "fork-c"
  const targetC = await makeEmptyDir();
  await forkCapsule({
    sourceArchive: exportBResult.archivePath,
    targetRoot: targetC,
    forkId: "fork-c",
    now: 200,
  });

  // Verify C's lineage points to B.
  const lineageC = await readForkLineage(targetC, "fork-c");
  assert.ok(lineageC !== null, "lineage for fork-c must exist");
  assert.equal(lineageC!.forkId, "fork-c");
  assert.equal(lineageC!.parent.capsuleId, "capsule-b");
  assert.equal(lineageC!.parent.version, "2.0.0");
  assert.equal(lineageC!.parent.forkRoot, "forks/capsule-b");

  // The full chain is: A ← B (lineage in targetB) ← C (lineage in targetC).
  // We can reconstruct the chain by reading lineages:
  //   lineageC.parent.capsuleId === "capsule-b" (which we know is a fork of "capsule-a")
  //   lineageB.parent.capsuleId === "capsule-a"
  assert.equal(lineageC!.parent.capsuleId, "capsule-b");
  assert.equal(lineageB!.parent.capsuleId, "capsule-a");
});

// ---------------------------------------------------------------------------
// Test 4: forkId validation rejects invalid ids
// ---------------------------------------------------------------------------

test("forkCapsule: rejects invalid forkId values", async () => {
  const files: FixtureFile[] = [
    { rel: "facts/a.md", content: "---\nid: a\n---\nbody\n" },
  ];
  const { archivePath } = await exportFixture(files, "validate-cap");
  const targetRoot = await makeEmptyDir();

  const invalid = [
    "",            // empty
    "-leading",    // leading dash
    "trailing-",   // trailing dash
    "a--b",        // consecutive dashes
    "has space",   // space
    "A".repeat(65), // too long
  ];

  for (const id of invalid) {
    await assert.rejects(
      () => forkCapsule({ sourceArchive: archivePath, targetRoot, forkId: id }),
      (err: Error) => {
        assert.ok(err instanceof Error, "must throw an Error");
        return true;
      },
      `forkId "${id}" should be rejected`,
    );
  }
});

// ---------------------------------------------------------------------------
// Test 5: readForkLineage returns null for non-existent fork
// ---------------------------------------------------------------------------

test("readForkLineage: returns null when breadcrumb does not exist", async () => {
  const dir = await makeEmptyDir();
  const result = await readForkLineage(dir, "nonexistent-fork");
  assert.equal(result, null);
});

// ---------------------------------------------------------------------------
// Test 6: CapsuleBlock parent field is set in export and survives round-trip
// ---------------------------------------------------------------------------

test("exportCapsule: parent field survives JSON round-trip", async () => {
  const files: FixtureFile[] = [
    { rel: "facts/a.md", content: "body\n" },
  ];
  const sourceRoot = await makeMemoryDir(files);
  const result = await exportCapsule({
    name: "fork-with-parent",
    root: sourceRoot,
    pluginVersion: "9.9.9",
    now: Date.parse("2026-04-26T00:00:00.000Z"),
    capsule: {
      parent: {
        capsuleId: "upstream-cap",
        version: "3.0.0",
        forkRoot: "forks/upstream-cap",
      },
      parentCapsule: "upstream-cap",
    },
  });

  // Re-read manifest from sidecar.
  const manifestRaw = await readFile(
    path.join(path.dirname(result.archivePath), "fork-with-parent.manifest.json"),
    "utf-8",
  );
  const manifest = JSON.parse(manifestRaw);

  assert.ok(manifest.capsule.parent !== null, "parent should not be null");
  assert.equal(manifest.capsule.parent.capsuleId, "upstream-cap");
  assert.equal(manifest.capsule.parent.version, "3.0.0");
  assert.equal(manifest.capsule.parent.forkRoot, "forks/upstream-cap");
  assert.equal(manifest.capsule.parentCapsule, "upstream-cap");
});

// ---------------------------------------------------------------------------
// Test 7: readForkLineage rejects path-traversal forkId payloads
// ---------------------------------------------------------------------------
//
// Codex P2 #751: a malicious value like `../../../../tmp` would resolve
// outside the configured memory root via path.join. readForkLineage must
// validate forkId with the same constraints as forkCapsule and return null
// for any value that does not satisfy CAPSULE_ID_PATTERN.

test("readForkLineage: rejects path-traversal forkId values", async () => {
  const dir = await makeEmptyDir();

  const maliciousIds = [
    "../../../../tmp",
    "../escape",
    "/abs/path",
    "with/slash",
    "with\\backslash",
    "..",
    ".",
    "",
    " ",
    "a/b/c",
  ];

  for (const id of maliciousIds) {
    const result = await readForkLineage(dir, id);
    assert.equal(result, null, `readForkLineage must return null for "${id}"`);
  }
});

// ---------------------------------------------------------------------------
// Test 8: readForkLineage rejects oversized forkId values
// ---------------------------------------------------------------------------

test("readForkLineage: rejects forkId values longer than 64 chars", async () => {
  const dir = await makeEmptyDir();
  const result = await readForkLineage(dir, "a".repeat(65));
  assert.equal(result, null);
});

// ---------------------------------------------------------------------------
// Test 9: parseCapsuleForkArgs — flag-value separation (Codex P2 #751)
// ---------------------------------------------------------------------------
//
// A naïve `filter((a) => !a.startsWith("--"))` keeps flag values in the
// positional list. If `<source-archive>` is omitted the target dir value
// `/path` becomes `sourceArchive`, silently bypassing the required-arg check.
// parseCapsuleForkArgs must skip value-taking flag pairs correctly.

test("parseCapsuleForkArgs: parses canonical argv correctly", () => {
  const result = parseCapsuleForkArgs([
    "archive.capsule.json.gz",
    "--target",
    "/tmp/root",
    "--fork-id",
    "my-fork",
  ]);
  assert.ok(!("error" in result), `expected success, got error: ${"error" in result ? result.error : ""}`);
  if (!("error" in result)) {
    assert.equal(result.sourceArchive, "archive.capsule.json.gz");
    assert.equal(result.targetRoot, "/tmp/root");
    assert.equal(result.forkId, "my-fork");
  }
});

test("parseCapsuleForkArgs: flags before positional still parsed correctly", () => {
  const result = parseCapsuleForkArgs([
    "--target",
    "/tmp/root",
    "--fork-id",
    "my-fork",
    "archive.capsule.json.gz",
  ]);
  assert.ok(!("error" in result));
  if (!("error" in result)) {
    assert.equal(result.sourceArchive, "archive.capsule.json.gz");
    assert.equal(result.targetRoot, "/tmp/root");
    assert.equal(result.forkId, "my-fork");
  }
});

test("parseCapsuleForkArgs: flag value NOT treated as positional when archive is missing", () => {
  // The key regression: `--target /path archive-omitted` must produce an
  // error, not silently set sourceArchive to "/path".
  const result = parseCapsuleForkArgs(["--target", "/tmp/root", "--fork-id", "my-fork"]);
  assert.ok("error" in result, "should return an error when source archive is omitted");
  assert.ok(
    result.error.includes("source archive") || result.error.includes("capsule fork"),
    `error message should mention source archive, got: ${result.error}`,
  );
});

test("parseCapsuleForkArgs: missing --target returns error", () => {
  const result = parseCapsuleForkArgs(["archive.capsule.json.gz", "--fork-id", "my-fork"]);
  assert.ok("error" in result);
  assert.ok(result.error.includes("--target"), `expected --target in error, got: ${result.error}`);
});

test("parseCapsuleForkArgs: missing --fork-id returns error", () => {
  const result = parseCapsuleForkArgs(["archive.capsule.json.gz", "--target", "/tmp/root"]);
  assert.ok("error" in result);
  assert.ok(result.error.includes("--fork-id"), `expected --fork-id in error, got: ${result.error}`);
});

// ---------------------------------------------------------------------------
// Test 14: forkCapsule rejects symlinked targetRoot (Cursor medium #751 round 3)
// ---------------------------------------------------------------------------

test("forkCapsule: rejects symlinked targetRoot before any write", async () => {
  const realRoot = await makeEmptyDir();
  const symlinkParent = await makeEmptyDir();
  const symlinkPath = path.join(symlinkParent, "linked-root");
  await symlink(realRoot, symlinkPath, "dir");

  const files: FixtureFile[] = [
    { rel: "facts/a.md", content: "---\nid: a\n---\nbody\n" },
  ];
  const { archivePath } = await exportFixture(files, "sym-root-test");

  await assert.rejects(
    () => forkCapsule({ sourceArchive: archivePath, targetRoot: symlinkPath, forkId: "sym-fork" }),
    (err: Error) => {
      // Shared helper in fs-utils.ts produces: "<caller>: path must not be a symlink — ..."
      assert.ok(
        err.message.includes("symlink") && err.message.includes("forkCapsule"),
        `Expected symlink-rejection error from forkCapsule, got: ${err.message}`,
      );
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// Test 15: forkCapsule rejects forkId when a FILE (not just a dir) exists at the path
// ---------------------------------------------------------------------------
//
// Codex P2 round 2: previously the duplicate check only treated a directory
// at `forks/<forkId>` as occupied. A stray file there would slip past and
// importCapsule would still write under forks/<sourceCapsule>/, then the
// breadcrumb mkdir/writeFile would fail leaving a partial fork import.

test("forkCapsule: rejects forkId when a regular file exists at forks/<forkId>", async () => {
  const targetRoot = await makeEmptyDir();
  // Plant a file (not a dir) at forks/file-fork
  await mkdir(path.join(targetRoot, "forks"), { recursive: true });
  await writeFile(path.join(targetRoot, "forks", "file-fork"), "not a dir", "utf-8");

  const files: FixtureFile[] = [
    { rel: "facts/a.md", content: "---\nid: a\n---\nbody\n" },
  ];
  const { archivePath } = await exportFixture(files, "file-collision");

  await assert.rejects(
    () => forkCapsule({ sourceArchive: archivePath, targetRoot, forkId: "file-fork" }),
    (err: Error) => {
      assert.ok(
        err.message.includes("file-fork") && err.message.includes("already in use"),
        `Expected "already in use" error, got: ${err.message}`,
      );
      return true;
    },
  );

  // Verify NO partial state — no records under forks/file-collision/.
  const allFiles = await listAll(targetRoot);
  for (const f of allFiles) {
    assert.ok(
      !f.startsWith("forks/file-collision/"),
      `forkCapsule must not have written under forks/file-collision/ — found: ${f}`,
    );
  }
});

// ---------------------------------------------------------------------------
// Test 16: readForkLineage rejects symlinked forks/<forkId>/ that escapes root
// ---------------------------------------------------------------------------
//
// Cursor medium #751 round 2: lexical containment is insufficient — a symlink
// at `forks/<forkId>` pointing outside the root could let readForkLineage
// read `lineage.json` from anywhere. Verify the symlink-safe containment
// check rejects this.

test("readForkLineage: rejects symlinked fork dir that escapes targetRoot", async () => {
  const targetRoot = await makeEmptyDir();
  const escape = await makeEmptyDir();
  // Plant a lineage.json in the escape dir (could be any sensitive content)
  await writeFile(path.join(escape, "lineage.json"), JSON.stringify({
    forkId: "escape", forkedAt: "2026-01-01T00:00:00Z",
    parent: { capsuleId: "x", version: "0.0.0", forkRoot: "forks/x" },
    importedRecords: 0, skippedRecords: 0,
  }), "utf-8");

  // Create forks/<forkId>/ as a symlink to the escape dir.
  await mkdir(path.join(targetRoot, "forks"), { recursive: true });
  await symlink(escape, path.join(targetRoot, "forks", "evil-fork"), "dir");

  // The lineage helper must NOT follow the symlink and must return null.
  const result = await readForkLineage(targetRoot, "evil-fork");
  assert.equal(
    result,
    null,
    "readForkLineage must reject symlinked fork dirs that escape targetRoot",
  );
});

// ---------------------------------------------------------------------------
// Test 17: buildCapsuleBlock syncs parentCapsule from parent.capsuleId
// ---------------------------------------------------------------------------

test("exportCapsule: parentCapsule is auto-derived from parent.capsuleId when only parent provided", async () => {
  const sourceRoot = await makeMemoryDir([
    { rel: "facts/a.md", content: "body\n" },
  ]);
  const result = await exportCapsule({
    name: "auto-sync",
    root: sourceRoot,
    pluginVersion: "9.9.9",
    now: Date.parse("2026-04-26T00:00:00.000Z"),
    capsule: {
      // ONLY parent — no parentCapsule. The legacy field MUST be derived.
      parent: {
        capsuleId: "upstream-id",
        version: "1.0.0",
        forkRoot: "forks/upstream-id",
      },
    },
  });

  assert.equal(
    result.manifest.capsule.parentCapsule,
    "upstream-id",
    "parentCapsule should be auto-derived from parent.capsuleId",
  );
  assert.equal(result.manifest.capsule.parent?.capsuleId, "upstream-id");
});

test("exportCapsule: explicit parentCapsule override still wins over parent.capsuleId", async () => {
  const sourceRoot = await makeMemoryDir([
    { rel: "facts/a.md", content: "body\n" },
  ]);
  const result = await exportCapsule({
    name: "explicit-override",
    root: sourceRoot,
    pluginVersion: "9.9.9",
    now: Date.parse("2026-04-26T00:00:00.000Z"),
    capsule: {
      parent: {
        capsuleId: "structured-id",
        version: "1.0.0",
        forkRoot: "forks/structured-id",
      },
      // Caller deliberately diverges from structured field for migration scenario.
      parentCapsule: "legacy-id",
    },
  });

  assert.equal(result.manifest.capsule.parentCapsule, "legacy-id");
  assert.equal(result.manifest.capsule.parent?.capsuleId, "structured-id");
});

// ---------------------------------------------------------------------------
// Test 20: forkCapsule rejects symlinked forks/ directory escaping root
// ---------------------------------------------------------------------------
//
// Codex P1 review #751: forkCapsule writes `forks/<forkId>/lineage.json` via
// mkdir+writeFile. If `targetRoot/forks` is a symlink to an external directory
// (and the archive has zero records, bypassing per-record path checks),
// the lineage write would escape the root sandbox. The fix adds a
// assertRealpathInsideRoot check before mkdir/writeFile.

test("forkCapsule: rejects symlinked forks/ directory that escapes targetRoot before lineage write", async () => {
  // Export a zero-record capsule so importCapsule does no per-record checks.
  const { archivePath } = await exportFixture([], "zero-rec");

  const realRoot = await makeEmptyDir();
  const escape = await makeEmptyDir();

  // Make `forks/` itself a symlink pointing to the escape dir. This way the
  // path `forks/safe-fork` does NOT exist yet (bypassing the duplicate-forkId
  // check at step 3), but once mkdir tries to create it the symlink will
  // redirect writes into `escape/`. The assertRealpathInsideRoot guard must
  // catch this before any mkdir/writeFile.
  await symlink(escape, path.join(realRoot, "forks"), "dir");

  await assert.rejects(
    () =>
      forkCapsule({
        sourceArchive: archivePath,
        targetRoot: realRoot,
        forkId: "safe-fork",
        now: Date.parse("2026-04-26T00:00:00.000Z"),
      }),
    (err: Error) => {
      assert.ok(
        err.message.includes("symlink") || err.message.includes("escapes"),
        `Expected symlink-escape rejection, got: ${err.message}`,
      );
      return true;
    },
  );
});

test("CapsuleParentSchema: rejects traversal-style forkRoot values", () => {
  const invalidForkRoots = [
    "../parent",
    "forks/../parent",
    "forks/./parent",
    "./forks/parent",
    "forks//parent",
    "forks/parent/",
    "forks\\parent",
    "/forks/parent",
  ];

  for (const forkRoot of invalidForkRoots) {
    const parsed = CapsuleParentSchema.safeParse({
      capsuleId: "parent",
      version: "1.0.0",
      forkRoot,
    });
    assert.equal(parsed.success, false, `forkRoot should be rejected: ${forkRoot}`);
  }
});
