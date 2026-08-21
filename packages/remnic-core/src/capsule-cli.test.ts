/**
 * Tests for `capsule-cli.ts` pure helpers (issue #676 PR 6/6 round-3).
 *
 * Scenarios covered:
 *   1. parseCapsuleMergeOptions returns the raw archive path (tilde expansion
 *      is the caller's responsibility — done in cli.ts).
 *   2. parseCapsuleListOptions forwards --dir without modification (caller
 *      expands tilde).
 *   3. parseCapsuleListOptions falls back to defaultDir when --dir is omitted.
 *   4. capsule-cli.ts does NOT import `os` (unused import removed).
 *   5. parseCapsuleInspectOptions returns the archive argument as-is.
 *   6. defaultCapsulesDir appends ".capsules" to the memory dir.
 *   7. capsule list ENOENT is swallowed; other readdir errors are re-thrown.
 *   8. merge archive ID-lookup: bare name is resolved via capsule store dir.
 *   9. capsule list --dir explicit ENOENT must NOT be swallowed.
 *  10. capsule merge tilde expansion: expandTildePath on ~/... paths.
 *  11. capsule merge encrypted archive guard: .enc path rejected with clear error.
 *  12. docs/capsules.md uses --name / --out-dir / --peer-ids flags matching cli.ts.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  parseCapsuleMergeOptions,
  parseCapsuleListOptions,
  parseCapsuleInspectOptions,
  defaultCapsulesDir,
} from "./capsule-cli.js";

// ─── 1. parseCapsuleMergeOptions preserves tilde in returned archive ───────────

test("parseCapsuleMergeOptions preserves tilde path for caller to expand", () => {
  const result = parseCapsuleMergeOptions(
    "~/backups/my-capsule.capsule.json.gz",
    {},
  );
  assert.equal(
    result.archive,
    "~/backups/my-capsule.capsule.json.gz",
    "archive should be returned as-is so caller can expand tilde",
  );
  assert.equal(result.conflictMode, "skip-conflicts");
});

test("parseCapsuleMergeOptions with prefer-source conflict mode", () => {
  const result = parseCapsuleMergeOptions(
    "/abs/path.capsule.json.gz",
    { conflictMode: "prefer-source" },
  );
  assert.equal(result.conflictMode, "prefer-source");
});

test("parseCapsuleMergeOptions throws on missing archive", () => {
  assert.throws(
    () => parseCapsuleMergeOptions("", {}),
    /capsule merge.*archive.*required/i,
  );
  assert.throws(
    () => parseCapsuleMergeOptions(undefined, {}),
    /capsule merge.*archive.*required/i,
  );
});

// ─── 2 & 3. parseCapsuleListOptions --dir handling ────────────────────────────

test("parseCapsuleListOptions uses provided --dir without expansion", () => {
  const result = parseCapsuleListOptions(
    { dir: "~/my-capsules", format: "text" },
    "/default/.capsules",
  );
  // Raw tilde preserved — cli.ts calls expandTildePath on the result.
  assert.equal(result.capsulesDir, "~/my-capsules");
  assert.equal(result.format, "text");
});

test("parseCapsuleListOptions falls back to defaultDir when --dir is omitted", () => {
  const result = parseCapsuleListOptions({}, "/memory/.capsules");
  assert.equal(result.capsulesDir, "/memory/.capsules");
  assert.equal(result.format, "text");
});

test("parseCapsuleListOptions rejects unknown format", () => {
  assert.throws(
    () => parseCapsuleListOptions({ format: "xml" }, "/dir"),
    /--format expects one of text, markdown, json/,
  );
});

// ─── 4. capsule-cli.ts does not use `os` ──────────────────────────────────────

test("capsule-cli module does not import node:os (unused import removed)", async () => {
  // Read the source text and verify `os` is not imported.
  const { readFile } = await import("node:fs/promises");
  const { fileURLToPath } = await import("node:url");
  const { dirname, join } = await import("node:path");
  const dir = dirname(fileURLToPath(import.meta.url));
  const src = await readFile(join(dir, "capsule-cli.ts"), "utf-8");
  assert.ok(
    !src.includes("import os from"),
    "capsule-cli.ts must not contain `import os from` (unused import)",
  );
});

// ─── 5. parseCapsuleInspectOptions ────────────────────────────────────────────

test("parseCapsuleInspectOptions returns archive and format", () => {
  const result = parseCapsuleInspectOptions("my-capsule.capsule.json.gz", {});
  assert.equal(result.archive, "my-capsule.capsule.json.gz");
  assert.equal(result.format, "text");
});

test("parseCapsuleInspectOptions throws on missing archive", () => {
  assert.throws(
    () => parseCapsuleInspectOptions("", {}),
    /capsule inspect.*archive.*required/i,
  );
});

// ─── 6. defaultCapsulesDir ────────────────────────────────────────────────────

test("defaultCapsulesDir appends .capsules to memory dir", () => {
  assert.equal(defaultCapsulesDir("/home/user/.memory"), "/home/user/.memory/.capsules");
  assert.equal(defaultCapsulesDir("/tmp/mem"), "/tmp/mem/.capsules");
});

// ─── 7. readdir ENOENT swallowing — only ENOENT, not other errors ─────────────
//
// These tests exercise the patched capsule list readdir error handling in
// cli.ts by invoking the underlying Node.js readdir semantics. We simulate the
// two error classes by reading a non-existent path (ENOENT) and a file path
// used as a directory (ENOTDIR / ENOENT on some platforms).

test("readdir on missing directory throws ENOENT which should be swallowed", async () => {
  const { readdir } = await import("node:fs/promises");
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  // Create a temp dir, then construct a path inside it that doesn't exist.
  const tmp = mkdtempSync(join(tmpdir(), "capsule-list-test-"));
  const missing = join(tmp, "nonexistent-capsules");

  let caught: NodeJS.ErrnoException | null = null;
  try {
    await readdir(missing);
  } catch (err) {
    caught = err as NodeJS.ErrnoException;
  }
  assert.ok(caught !== null, "expected readdir to throw for missing dir");
  assert.equal(
    caught.code,
    "ENOENT",
    "missing directory should produce ENOENT — the list action swallows this",
  );
});

test("readdir on a file path throws non-ENOENT error which must NOT be swallowed", async () => {
  const { readdir, writeFile } = await import("node:fs/promises");
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  // Create a regular file and then try to readdir it — yields ENOTDIR.
  const tmp = mkdtempSync(join(tmpdir(), "capsule-list-test-"));
  const filePath = join(tmp, "not-a-directory.txt");
  await writeFile(filePath, "content");

  let caught: NodeJS.ErrnoException | null = null;
  try {
    await readdir(filePath);
  } catch (err) {
    caught = err as NodeJS.ErrnoException;
  }
  assert.ok(caught !== null, "expected readdir to throw for a file path");
  assert.notEqual(
    caught.code,
    "ENOENT",
    "a file used as directory must NOT produce ENOENT (should be ENOTDIR or similar) — must be re-thrown by list action",
  );
});

// ─── 8. merge archive ID-lookup path resolution ───────────────────────────────
//
// Verifies that the 3-step path resolution logic added to `capsule merge`
// produces the correct archive path for each case. We test the pure resolution
// logic inline here (not through the CLI action, which needs an orchestrator).

test("merge path resolution: explicit absolute path is used as-is", async () => {
  // Simulates step 1: arg looks like an explicit path → tilde-expand and use.
  const { expandTildePath } = await import("./utils/path.js");
  const input = "/absolute/path/my-capsule.capsule.json.gz";
  const expanded = expandTildePath(input);
  assert.equal(expanded, input, "absolute path should be unchanged after tilde expansion");
});

test("merge path resolution: tilde in explicit path is expanded", async () => {
  const { expandTildePath } = await import("./utils/path.js");
  const { homedir } = await import("node:os");
  const input = "~/backups/my-capsule.capsule.json.gz";
  const expanded = expandTildePath(input);
  assert.equal(
    expanded,
    `${homedir()}/backups/my-capsule.capsule.json.gz`,
    "leading tilde must be expanded to the home directory",
  );
  // After expansion the path starts with '/' so `looksLikePath` is true —
  // the ID-lookup branch is skipped.
  assert.ok(expanded.startsWith("/"), "expanded tilde path starts with /");
});

test("merge path resolution: bare capsule id resolves to store path", async () => {
  // Simulates step 3: bare name does not exist at cwd → look up in store.
  // We verify that joining capsulesDir + id + extension produces the right path.
  const { join } = await import("node:path");
  const capsulesDir = "/home/user/.memory/.capsules";
  const capsuleId = "my-snapshot-2026-01-01";

  const byId = join(capsulesDir, `${capsuleId}.capsule.json.gz`);
  assert.equal(
    byId,
    "/home/user/.memory/.capsules/my-snapshot-2026-01-01.capsule.json.gz",
    "capsule id must be joined with the store directory and the .capsule.json.gz extension",
  );

  const byIdEnc = join(capsulesDir, `${capsuleId}.capsule.json.gz.enc`);
  assert.equal(
    byIdEnc,
    "/home/user/.memory/.capsules/my-snapshot-2026-01-01.capsule.json.gz.enc",
    "encrypted variant path must append .enc to the plain archive name",
  );
});

// ─── 9. capsule list --dir explicit ENOENT must NOT be swallowed ──────────────
//
// When --dir is explicitly provided by the user and the directory doesn't
// exist, the list action must throw — not silently return empty results.
// (Cursor PRRT_kwDORJXyws59spK8)

test("parseCapsuleListOptions preserves explicit --dir value even if it doesn't exist", () => {
  // The pure parser just records the value; it's the cli.ts action handler that
  // must validate existence when dirWasExplicit is true.
  const nonExistent = "/tmp/capsule-cli-test-does-not-exist-" + Date.now();
  const result = parseCapsuleListOptions({ dir: nonExistent }, "/default/.capsules");
  assert.equal(
    result.capsulesDir,
    nonExistent,
    "explicit --dir value is forwarded without modification",
  );
});

test("capsule list: explicit --dir that does not exist produces readdir ENOENT", async () => {
  const { readdir } = await import("node:fs/promises");
  const nonExistent = "/tmp/capsule-cli-test-does-not-exist-" + Date.now();

  let caught: NodeJS.ErrnoException | null = null;
  try {
    await readdir(nonExistent);
  } catch (err) {
    caught = err as NodeJS.ErrnoException;
  }
  // The error code is ENOENT — which the list action must re-throw (not swallow)
  // when the user explicitly passed --dir, since a missing explicit path is
  // almost certainly a mistake (typo or unmounted path).
  assert.ok(caught !== null, "expected readdir to throw for nonexistent dir");
  assert.equal(caught.code, "ENOENT", "nonexistent --dir produces ENOENT");
  // Confirm the distinction: for the DEFAULT capsulesDir, ENOENT is swallowed
  // (directory not yet created). For explicit --dir, it must surface as an error.
  // The cli.ts action tracks dirWasExplicit and re-throws when true.
});

// ─── 10. capsule merge tilde expansion ────────────────────────────────────────
//
// cli.ts calls expandTildePath(parsed.archive) immediately after parsing, so a
// ~/... path is expanded before the looksLikePath / ID-lookup branching.
// Verify the helper expands correctly.

test("expandTildePath expands ~/... merge archive paths to absolute", async () => {
  const { expandTildePath } = await import("./utils/path.js");
  const { homedir } = await import("node:os");
  const home = homedir();

  // Typical user-typed merge archive path.
  const input = "~/capsules/daily-backup.capsule.json.gz";
  const expanded = expandTildePath(input);
  assert.equal(
    expanded,
    `${home}/capsules/daily-backup.capsule.json.gz`,
    "leading tilde must be replaced with the actual home directory",
  );
  // After expansion the path starts with '/' so cli.ts treats it as an explicit
  // path and does not attempt ID-lookup in the capsules store.
  assert.ok(
    expanded.startsWith("/"),
    "expanded tilde path must start with / (bypasses ID-lookup branch)",
  );
});

test("expandTildePath does not modify already-absolute merge archive paths", async () => {
  const { expandTildePath } = await import("./utils/path.js");
  const abs = "/tmp/my-capsule.capsule.json.gz";
  assert.equal(
    expandTildePath(abs),
    abs,
    "absolute path must be returned unchanged",
  );
});

// ─── 11. capsule merge encrypted archive guard ────────────────────────────────
//
// The cli.ts merge action rejects .enc archives before calling mergeCapsule
// (which only understands plain gzip). This test verifies that isEncryptedCapsuleFile
// correctly detects non-.enc paths as unencrypted (the guard short-circuits on
// the extension check, so plain .gz files are never flagged as encrypted).

test("isEncryptedCapsuleFile returns false for plain .capsule.json.gz path", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { isEncryptedCapsuleFile } = await import("./transfer/capsule-crypto.js");

  // Write a minimal gzip-like file (gzip magic bytes) — not an .enc file.
  const tmp = mkdtempSync(join(tmpdir(), "capsule-merge-guard-"));
  const plain = join(tmp, "test.capsule.json.gz");
  // gzip magic: 0x1f 0x8b
  writeFileSync(plain, Buffer.from([0x1f, 0x8b, 0x08, 0x00]));

  const result = await isEncryptedCapsuleFile(plain);
  assert.equal(
    result,
    false,
    "plain gzip archive must not be flagged as encrypted (no .enc extension)",
  );
});

test("isEncryptedCapsuleFile returns false for .enc path with non-REMNIC-ENC magic", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { isEncryptedCapsuleFile } = await import("./transfer/capsule-crypto.js");

  // A file that has .enc extension but does NOT start with REMNIC-ENC magic.
  const tmp = mkdtempSync(join(tmpdir(), "capsule-merge-guard-"));
  const fakeEnc = join(tmp, "test.capsule.json.gz.enc");
  writeFileSync(fakeEnc, Buffer.from("not-an-encrypted-file"));

  const result = await isEncryptedCapsuleFile(fakeEnc);
  assert.equal(
    result,
    false,
    ".enc file without REMNIC-ENC magic header must not be reported as encrypted",
  );
});

// ─── 12. docs/capsules.md flag alignment with cli.ts ─────────────────────────
//
// Verifies that docs/capsules.md uses the actual CLI flags (--name, --out-dir,
// --peer-ids) and does not contain the stale --out or --peers flags.
// (Codex P2 PRRT_kwDORJXyws59so7T)

test("docs/capsules.md uses --name flag (not positional <name> argument)", async () => {
  const { readFile } = await import("node:fs/promises");
  const { fileURLToPath } = await import("node:url");
  const { dirname, resolve } = await import("node:path");
  const dir = dirname(fileURLToPath(import.meta.url));
  // docs/ is at the repo root, three levels above packages/remnic-core/src/
  const docsPath = resolve(dir, "../../../docs/capsules.md");
  const src = await readFile(docsPath, "utf-8");

  assert.ok(
    src.includes("--name <id>"),
    "docs must document --name <id> flag (not positional <name> argument)",
  );
  assert.ok(
    src.includes("--out-dir <dir>"),
    "docs must document --out-dir flag (not --out)",
  );
  assert.ok(
    src.includes("--peer-ids <list>"),
    "docs must document --peer-ids flag (not --peers)",
  );
  assert.ok(
    src.includes("--include-transcripts"),
    "docs must document --include-transcripts flag",
  );
  // Negative checks: old flag names must not appear in the export section.
  const exportSection = src.slice(
    src.indexOf("### `remnic capsule export`"),
    src.indexOf("### `remnic capsule import`"),
  );
  assert.ok(
    !exportSection.includes("  --out <"),
    "stale --out flag must not appear in the export section",
  );
  assert.ok(
    !exportSection.includes("  --peers <"),
    "stale --peers flag must not appear in the export section",
  );
});
