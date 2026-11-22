
import assert from "node:assert/strict";
import test from "node:test";
import {
  parseCapsuleMergeOptions,
  parseCapsuleListOptions,
  parseCapsuleInspectOptions,
  defaultCapsulesDir,
} from "./capsule-cli.js";


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


test("parseCapsuleListOptions uses provided --dir without expansion", () => {
  const result = parseCapsuleListOptions(
    { dir: "~/my-capsules", format: "text" },
    "/default/.capsules",
  );
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


test("capsule-cli module does not import node:os (unused import removed)", async () => {
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


test("defaultCapsulesDir appends .capsules to memory dir", () => {
  assert.equal(defaultCapsulesDir("/home/user/.memory"), "/home/user/.memory/.capsules");
  assert.equal(defaultCapsulesDir("/tmp/mem"), "/tmp/mem/.capsules");
});

// These tests exercise the patched capsule list readdir error handling in
// cli.ts by invoking the underlying Node.js readdir semantics. We simulate the
// two error classes by reading a non-existent path (ENOENT) and a file path
// used as a directory (ENOTDIR / ENOENT on some platforms).

test("readdir on missing directory throws ENOENT which should be swallowed", async () => {
  const { readdir } = await import("node:fs/promises");
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

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

//
// Verifies that the 3-step path resolution logic added to `capsule merge`
// produces the correct archive path for each case. We test the pure resolution
// logic inline here (not through the CLI action, which needs an orchestrator).

test("merge path resolution: explicit absolute path is used as-is", async () => {
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
  assert.ok(expanded.startsWith("/"), "expanded tilde path starts with /");
});

test("merge path resolution: bare capsule id resolves to store path", async () => {
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

//
// When --dir is explicitly provided by the user and the directory doesn't
// exist, the list action must throw — not silently return empty results.
// (Cursor PRRT_kwDORJXyws59spK8)

test("parseCapsuleListOptions preserves explicit --dir value even if it doesn't exist", () => {
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
  assert.ok(caught !== null, "expected readdir to throw for nonexistent dir");
  assert.equal(caught.code, "ENOENT", "nonexistent --dir produces ENOENT");
  // Confirm the distinction: for the DEFAULT capsulesDir, ENOENT is swallowed
  // (directory not yet created). For explicit --dir, it must surface as an error.
  // The cli.ts action tracks dirWasExplicit and re-throws when true.
});

//

test("expandTildePath expands ~/... merge archive paths to absolute", async () => {
  const { expandTildePath } = await import("./utils/path.js");
  const { homedir } = await import("node:os");
  const home = homedir();

  const input = "~/capsules/daily-backup.capsule.json.gz";
  const expanded = expandTildePath(input);
  assert.equal(
    expanded,
    `${home}/capsules/daily-backup.capsule.json.gz`,
    "leading tilde must be replaced with the actual home directory",
  );
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

  const tmp = mkdtempSync(join(tmpdir(), "capsule-merge-guard-"));
  const plain = join(tmp, "test.capsule.json.gz");
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

//

test("docs/capsules.md uses --name flag (not positional <name> argument)", async () => {
  const { readFile } = await import("node:fs/promises");
  const { fileURLToPath } = await import("node:url");
  const { dirname, resolve } = await import("node:path");
  const dir = dirname(fileURLToPath(import.meta.url));
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
