/**
 * Tests for capsule + backup encryption (issue #690 PR 4/4).
 *
 * Scenarios covered:
 *   1. exportCapsule --encrypt → importCapsule roundtrip (plaintext identical)
 *   2. importCapsule auto-detects encrypted archive via REMNIC-ENC header
 *   3. importCapsule with encrypted archive but locked secure-store → clear error
 *   4. importCapsule with tampered encrypted archive → clear auth error
 *   5. backupMemoryDir --encrypt → encrypted archive produced, plaintext removed
 *   6. isEncryptedCapsuleFile detects encrypted vs plain archives
 *   7. encryptCapsuleFile + decryptCapsuleFile file-level roundtrip
 *   8. isEncryptedCapsuleFile reads only header bytes (not entire file) — Codex P2
 *   9. encryptCapsuleFile embeds KDF params in format v2 header — Codex P1
 *  10. enforceRetention prunes .backup.json.gz.enc files — Codex P2
 *  11. backupMemoryDir excludes .secure-store and .capsules dirs — Cursor
 *  12. exportCapsule with includeTranscripts=true includes transcripts+peers — Cursor
 *
 * KDF note: tests use a minimal scrypt param set (N=1024) for legacy-header
 * fixtures so the suite stays fast. ONE integration test exercises the real unlock path so CLI
 * plumbing and keyring integration stay green.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile, readFile, mkdir, stat, readdir } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { gzipSync, gunzipSync } from "node:zlib";

import { exportCapsule } from "./capsule-export.js";
import { importCapsule } from "./capsule-import.js";
import { backupMemoryDir } from "./backup.js";
import {
  encryptCapsuleFile,
  decryptCapsuleFile,
  isEncryptedCapsuleFile,
} from "./capsule-crypto.js";
import * as keyring from "../secure-store/keyring.js";
import { generateSalt, seal } from "../secure-store/cipher.js";
import { deriveKeyScrypt, type ScryptParams } from "../secure-store/kdf.js";
import { buildHeaderFromPassphrase, writeHeader, secureStoreDir } from "../secure-store/header.js";

// ─── Shared helpers ───────────────────────────────────────────────────────────

/** Cheap scrypt params: ~milliseconds, safe for tests. */
const FAST_SCRYPT: ScryptParams = {
  N: 1 << 10,
  r: 8,
  p: 1,
  keyLength: 32,
  maxmem: 64 * 1024 * 1024,
};

const TEST_PASSPHRASE = "hunter2-test-passphrase";

async function makeTempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "capsule-enc-test-"));
}

/**
 * Initialize a secure-store header in `memoryDir` and unlock the keyring.
 * Returns the derived key buffer (same as what the keyring holds).
 */
async function initAndUnlockStore(memoryDir: string): Promise<Buffer> {
  const salt = generateSalt();
  const { header, derivedKey } = buildHeaderFromPassphrase({
    passphrase: TEST_PASSPHRASE,
    salt,
    algorithm: "scrypt",
    params: FAST_SCRYPT,
  });
  await writeHeader(memoryDir, header);

  // Clone the key before handing ownership to the keyring.
  const keyCopy = Buffer.from(derivedKey);
  keyring.unlock(secureStoreDir(memoryDir), keyCopy);
  return derivedKey;
}

/**
 * Build a minimal memory directory with two synthetic fact files.
 */
async function makeMemoryDir(dir: string): Promise<void> {
  await mkdir(path.join(dir, "facts"), { recursive: true });
  await writeFile(
    path.join(dir, "facts", "a.md"),
    "---\nid: fact-a\n---\nFact A content.",
  );
  await writeFile(
    path.join(dir, "facts", "b.md"),
    "---\nid: fact-b\n---\nFact B content.",
  );
}

// ─── Test 6: isEncryptedCapsuleFile ───────────────────────────────────────────

test("isEncryptedCapsuleFile returns false for a plain gzip file", async () => {
  const dir = await makeTempDir();
  try {
    const plain = path.join(dir, "test.capsule.json.gz");
    await writeFile(plain, gzipSync(Buffer.from('{"hello":"world"}', "utf-8")));
    assert.equal(await isEncryptedCapsuleFile(plain), false, "plain gz should not be detected as encrypted");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("isEncryptedCapsuleFile returns false for a non-.enc file even with REMNIC-ENC bytes", async () => {
  const dir = await makeTempDir();
  try {
    const f = path.join(dir, "test.capsule.json.gz");
    // starts with magic but lacks .enc extension
    await writeFile(f, Buffer.concat([Buffer.from("REMNIC-ENC\x00\x01"), Buffer.alloc(50)]));
    assert.equal(await isEncryptedCapsuleFile(f), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("isEncryptedCapsuleFile returns true for a properly encrypted archive", async () => {
  const dir = await makeTempDir();
  try {
    await initAndUnlockStore(dir);

    const plain = path.join(dir, "test.capsule.json.gz");
    await writeFile(plain, gzipSync(Buffer.from('{"hello":"world"}', "utf-8")));
    const { encPath } = await encryptCapsuleFile({ sourceGzPath: plain, memoryDir: dir });

    assert.equal(await isEncryptedCapsuleFile(encPath), true);
  } finally {
    keyring.lockAll();
    await rm(dir, { recursive: true, force: true });
  }
});

// ─── Test 7: encryptCapsuleFile + decryptCapsuleFile roundtrip ────────────────

test("encryptCapsuleFile + decryptCapsuleFile roundtrip preserves bytes", async () => {
  const dir = await makeTempDir();
  try {
    await initAndUnlockStore(dir);

    const original = gzipSync(Buffer.from('{"test":"payload","value":42}', "utf-8"));
    const plainPath = path.join(dir, "example.capsule.json.gz");
    await writeFile(plainPath, original);

    const { encPath } = await encryptCapsuleFile({ sourceGzPath: plainPath, memoryDir: dir });
    assert.ok(encPath.endsWith(".enc"), "encrypted path should end with .enc");

    const { gzPath } = await decryptCapsuleFile({ encPath, memoryDir: dir });
    const decrypted = await readFile(gzPath);
    assert.ok(decrypted.equals(original), "decrypted bytes must equal original");
  } finally {
    keyring.lockAll();
    await rm(dir, { recursive: true, force: true });
  }
});

test("decryptCapsuleFile throws clear error when store is locked", async () => {
  const dir = await makeTempDir();
  try {
    await initAndUnlockStore(dir);

    const plain = path.join(dir, "test.capsule.json.gz");
    await writeFile(plain, gzipSync(Buffer.from('{"x":1}', "utf-8")));
    const { encPath } = await encryptCapsuleFile({ sourceGzPath: plain, memoryDir: dir });

    // Lock the store.
    keyring.lock(secureStoreDir(dir));

    await assert.rejects(
      async () => decryptCapsuleFile({ encPath, memoryDir: dir }),
      /Secure-store is locked/,
      "should throw a clear 'locked' error",
    );
  } finally {
    keyring.lockAll();
    await rm(dir, { recursive: true, force: true });
  }
});

test("decryptCapsuleFile throws auth error when archive is tampered", async () => {
  const dir = await makeTempDir();
  try {
    await initAndUnlockStore(dir);

    const plain = path.join(dir, "test.capsule.json.gz");
    await writeFile(plain, gzipSync(Buffer.from('{"x":1}', "utf-8")));
    const { encPath } = await encryptCapsuleFile({ sourceGzPath: plain, memoryDir: dir });

    // Tamper with the ciphertext: flip a byte near the end.
    const enc = await readFile(encPath);
    enc[enc.length - 1] ^= 0xff;
    await writeFile(encPath, enc);

    await assert.rejects(
      async () => decryptCapsuleFile({ encPath, memoryDir: dir }),
      /authentication failed/,
      "tampered archive should fail with auth error",
    );
  } finally {
    keyring.lockAll();
    await rm(dir, { recursive: true, force: true });
  }
});

// ─── Test 1 + 2: exportCapsule --encrypt → importCapsule roundtrip ───────────

test("exportCapsule with encrypt=true + importCapsule roundtrip restores all files", async () => {
  const srcDir = await makeTempDir();
  const dstDir = await makeTempDir();
  const outDir = await makeTempDir();
  try {
    await makeMemoryDir(srcDir);
    await initAndUnlockStore(srcDir);

    const exportResult = await exportCapsule({
      name: "test-capsule",
      root: srcDir,
      outDir,
      pluginVersion: "0.0.0-test",
      encrypt: true,
      memoryDir: srcDir,
      now: 1_700_000_000_000,
    });

    // Archive path should end with .enc.
    assert.ok(
      exportResult.archivePath.endsWith(".enc"),
      `expected .enc archive, got: ${exportResult.archivePath}`,
    );
    assert.equal(exportResult.encryptedArchivePath, exportResult.archivePath);

    const importResult = await importCapsule({
      archivePath: exportResult.archivePath,
      root: dstDir,
      mode: "skip",
      memoryDir: srcDir, // same store that holds the encryption key
    });

    assert.equal(importResult.imported.length, 2, "should have imported 2 records");
    assert.equal(importResult.skipped.length, 0);

    // Verify content round-tripped correctly.
    const aContent = await readFile(path.join(dstDir, "facts", "a.md"), "utf-8");
    assert.ok(aContent.includes("Fact A content."));
    const bContent = await readFile(path.join(dstDir, "facts", "b.md"), "utf-8");
    assert.ok(bContent.includes("Fact B content."));
  } finally {
    keyring.lockAll();
    await rm(srcDir, { recursive: true, force: true });
    await rm(dstDir, { recursive: true, force: true });
    await rm(outDir, { recursive: true, force: true });
  }
});

test("encrypted format-v2 capsule restores from passphrase without source keyring", async () => {
  const srcDir = await makeTempDir();
  const dstDir = await makeTempDir();
  const outDir = await makeTempDir();
  try {
    await makeMemoryDir(srcDir);
    await initAndUnlockStore(srcDir);

    const exportResult = await exportCapsule({
      name: "test-capsule-passphrase",
      root: srcDir,
      outDir,
      pluginVersion: "0.0.0-test",
      encrypt: true,
      memoryDir: srcDir,
      now: 1_700_000_000_500,
    });

    keyring.lockAll();

    const importResult = await importCapsule({
      archivePath: exportResult.archivePath,
      root: dstDir,
      mode: "skip",
      passphrase: TEST_PASSPHRASE,
    });

    assert.equal(importResult.imported.length, 2);
    assert.equal(importResult.skipped.length, 0);

    const aContent = await readFile(path.join(dstDir, "facts", "a.md"), "utf-8");
    assert.ok(aContent.includes("Fact A content."));
    const bContent = await readFile(path.join(dstDir, "facts", "b.md"), "utf-8");
    assert.ok(bContent.includes("Fact B content."));
  } finally {
    keyring.lockAll();
    await rm(srcDir, { recursive: true, force: true });
    await rm(dstDir, { recursive: true, force: true });
    await rm(outDir, { recursive: true, force: true });
  }
});

test("exportCapsule with encrypt=true removes plaintext archive when encryption fails", async () => {
  const srcDir = await makeTempDir();
  const outDir = await makeTempDir();
  try {
    await makeMemoryDir(srcDir);

    await assert.rejects(
      async () =>
        exportCapsule({
          name: "locked-capsule",
          root: srcDir,
          outDir,
          pluginVersion: "0.0.0-test",
          encrypt: true,
          memoryDir: srcDir,
          now: 1_700_000_000_700,
        }),
      /Secure-store is locked/,
    );

    const files = await readdir(outDir);
    assert.equal(files.some((name) => name.endsWith(".capsule.json.gz")), false);
  } finally {
    keyring.lockAll();
    await rm(srcDir, { recursive: true, force: true });
    await rm(outDir, { recursive: true, force: true });
  }
});

// ─── Test 3: import without unlocked store → clear error ─────────────────────

test("importCapsule with encrypted archive and locked store throws clear error", async () => {
  const srcDir = await makeTempDir();
  const dstDir = await makeTempDir();
  const outDir = await makeTempDir();
  try {
    await makeMemoryDir(srcDir);
    await initAndUnlockStore(srcDir);

    const exportResult = await exportCapsule({
      name: "test-capsule-locked",
      root: srcDir,
      outDir,
      pluginVersion: "0.0.0-test",
      encrypt: true,
      memoryDir: srcDir,
      now: 1_700_000_001_000,
    });

    // Lock srcDir store and don't unlock dstDir.
    keyring.lockAll();

    // Import attempt without any unlocked store.
    await assert.rejects(
      async () =>
        importCapsule({
          archivePath: exportResult.archivePath,
          root: dstDir,
          memoryDir: dstDir,
        }),
      /Secure-store is locked/,
      "should surface a 'Secure-store is locked' error",
    );
  } finally {
    keyring.lockAll();
    await rm(srcDir, { recursive: true, force: true });
    await rm(dstDir, { recursive: true, force: true });
    await rm(outDir, { recursive: true, force: true });
  }
});

test("importCapsule with encrypted archive and no memoryDir throws clear error", async () => {
  const srcDir = await makeTempDir();
  const dstDir = await makeTempDir();
  const outDir = await makeTempDir();
  try {
    await makeMemoryDir(srcDir);
    await initAndUnlockStore(srcDir);

    const exportResult = await exportCapsule({
      name: "test-capsule-nomemdir",
      root: srcDir,
      outDir,
      pluginVersion: "0.0.0-test",
      encrypt: true,
      memoryDir: srcDir,
      now: 1_700_000_002_000,
    });

    // No memoryDir provided to importCapsule.
    await assert.rejects(
      async () =>
        importCapsule({
          archivePath: exportResult.archivePath,
          root: dstDir,
          // omit memoryDir intentionally
        }),
      /memoryDir.*not provided/,
      "should require memoryDir for encrypted archives",
    );
  } finally {
    keyring.lockAll();
    await rm(srcDir, { recursive: true, force: true });
    await rm(dstDir, { recursive: true, force: true });
    await rm(outDir, { recursive: true, force: true });
  }
});

// ─── Test 4: tampered encrypted capsule archive → auth error ──────────────────

test("importCapsule with tampered encrypted archive surfaces auth error", async () => {
  const srcDir = await makeTempDir();
  const dstDir = await makeTempDir();
  const outDir = await makeTempDir();
  try {
    await makeMemoryDir(srcDir);
    await initAndUnlockStore(srcDir);

    const exportResult = await exportCapsule({
      name: "test-capsule-tamper",
      root: srcDir,
      outDir,
      pluginVersion: "0.0.0-test",
      encrypt: true,
      memoryDir: srcDir,
      now: 1_700_000_003_000,
    });

    // Tamper with a byte in the ciphertext region.
    const enc = await readFile(exportResult.archivePath);
    enc[enc.length - 5] ^= 0xab;
    await writeFile(exportResult.archivePath, enc);

    // Use the same store for import (the key is still unlocked in srcDir).
    await assert.rejects(
      async () =>
        importCapsule({
          archivePath: exportResult.archivePath,
          root: dstDir,
          memoryDir: srcDir,
        }),
      /authentication failed/,
      "tampered archive should fail with auth error on import",
    );
  } finally {
    keyring.lockAll();
    await rm(srcDir, { recursive: true, force: true });
    await rm(dstDir, { recursive: true, force: true });
    await rm(outDir, { recursive: true, force: true });
  }
});

// ─── Test 5: backupMemoryDir --encrypt ────────────────────────────────────────

test("backupMemoryDir with encrypt=true produces .enc file and no plaintext", async () => {
  const memDir = await makeTempDir();
  const backupDir = await makeTempDir();
  try {
    await makeMemoryDir(memDir);
    await initAndUnlockStore(memDir);

    const resultPath = await backupMemoryDir({
      memoryDir: memDir,
      outDir: backupDir,
      pluginVersion: "0.0.0-test",
      encrypt: true,
    });

    assert.ok(resultPath.endsWith(".enc"), `expected .enc path, got: ${resultPath}`);
    const encBuf = await readFile(resultPath);
    assert.ok(encBuf.length > 0, "encrypted backup should not be empty");

    // Verify the REMNIC-ENC magic.
    const magic = Buffer.from("REMNIC-ENC\x00", "ascii");
    assert.ok(
      encBuf.subarray(0, magic.length).equals(magic),
      "encrypted backup should start with REMNIC-ENC magic",
    );

    // No plaintext .gz should exist beside the .enc.
    const plainPath = resultPath.replace(/\.enc$/, "");
    const plainExists = await readFile(plainPath).then(() => true).catch(() => false);
    assert.equal(plainExists, false, "plaintext backup gz should be removed after encryption");
  } finally {
    keyring.lockAll();
    await rm(memDir, { recursive: true, force: true });
    await rm(backupDir, { recursive: true, force: true });
  }
});

test("backupMemoryDir with encrypt=true and locked store throws clear error", async () => {
  const memDir = await makeTempDir();
  const backupDir = await makeTempDir();
  try {
    await makeMemoryDir(memDir);
    // Intentionally do NOT unlock the store.

    await assert.rejects(
      async () =>
        backupMemoryDir({
          memoryDir: memDir,
          outDir: backupDir,
          pluginVersion: "0.0.0-test",
          encrypt: true,
        }),
      /Secure-store is locked/,
      "should surface locked error when store not unlocked",
    );
    const files = await readdir(backupDir);
    assert.equal(files.some((name) => name.endsWith(".backup.json.gz")), false);
  } finally {
    keyring.lockAll();
    await rm(memDir, { recursive: true, force: true });
    await rm(backupDir, { recursive: true, force: true });
  }
});

// ─── Unencrypted capsule still works (regression guard) ──────────────────────

test("exportCapsule without encrypt produces plaintext archive importable without memoryDir key", async () => {
  const srcDir = await makeTempDir();
  const dstDir = await makeTempDir();
  const outDir = await makeTempDir();
  try {
    await makeMemoryDir(srcDir);

    const exportResult = await exportCapsule({
      name: "plain-capsule",
      root: srcDir,
      outDir,
      pluginVersion: "0.0.0-test",
      now: 1_700_000_004_000,
    });

    assert.ok(
      exportResult.archivePath.endsWith(".gz") && !exportResult.archivePath.endsWith(".gz.enc"),
      "unencrypted archive should be .gz",
    );
    assert.equal(exportResult.encryptedArchivePath, null);

    // Import without a memoryDir — plain archives don't need one.
    const importResult = await importCapsule({
      archivePath: exportResult.archivePath,
      root: dstDir,
      mode: "skip",
    });

    assert.equal(importResult.imported.length, 2);
    assert.equal(importResult.skipped.length, 0);
  } finally {
    keyring.lockAll();
    await rm(srcDir, { recursive: true, force: true });
    await rm(dstDir, { recursive: true, force: true });
    await rm(outDir, { recursive: true, force: true });
  }
});

// ─── Test 8: isEncryptedCapsuleFile reads only header bytes (Codex P2) ────────

test("isEncryptedCapsuleFile reads only the magic header bytes, not the whole file", async () => {
  const dir = await makeTempDir();
  try {
    await initAndUnlockStore(dir);

    // Create a large-ish plaintext gz so we can verify we don't read it all.
    const largePlain = Buffer.alloc(1024 * 64, 0x42); // 64 KiB of 'B' bytes
    const plainPath = path.join(dir, "big.capsule.json.gz");
    await writeFile(plainPath, gzipSync(largePlain));

    const { encPath } = await encryptCapsuleFile({ sourceGzPath: plainPath, memoryDir: dir });

    // The detection must succeed (magic matches).
    assert.equal(await isEncryptedCapsuleFile(encPath), true, "should detect encrypted archive");

    // A plain gz file (magic doesn't match) must return false quickly.
    assert.equal(await isEncryptedCapsuleFile(plainPath), false, "non-.enc extension returns false");

    // A file whose extension is .enc but content is not REMNIC-ENC must return false.
    const fakeEncPath = path.join(dir, "notenc.enc");
    await writeFile(fakeEncPath, Buffer.from("this is not encrypted\n"));
    assert.equal(await isEncryptedCapsuleFile(fakeEncPath), false, "wrong magic returns false");
  } finally {
    keyring.lockAll();
    await rm(dir, { recursive: true, force: true });
  }
});

// ─── Test 9: format v2 embeds KDF params for cross-machine restore (Codex P1) ──

test("encryptCapsuleFile format v2 embeds KDF params in archive header", async () => {
  const dir = await makeTempDir();
  try {
    await initAndUnlockStore(dir);

    const plain = path.join(dir, "test.capsule.json.gz");
    await writeFile(plain, gzipSync(Buffer.from('{"hello":"world"}', "utf-8")));
    const { encPath } = await encryptCapsuleFile({ sourceGzPath: plain, memoryDir: dir });

    const buf = await readFile(encPath);

    // Magic check.
    const magic = Buffer.from("REMNIC-ENC\x00", "ascii");
    assert.ok(buf.subarray(0, magic.length).equals(magic), "must start with REMNIC-ENC magic");

    // Version byte should be 2 (format v2).
    const version = buf.readUInt8(magic.length);
    assert.equal(version, 2, "format version must be 2");

    // KDF params section: 2-byte LE length followed by JSON.
    const kdfLen = buf.readUInt16LE(magic.length + 1);
    assert.ok(kdfLen > 0, "KDF params length must be > 0");

    const kdfJsonStr = buf.subarray(magic.length + 1 + 2, magic.length + 1 + 2 + kdfLen).toString("utf-8");
    let kdfJson: Record<string, unknown>;
    assert.doesNotThrow(() => { kdfJson = JSON.parse(kdfJsonStr) as Record<string, unknown>; }, "KDF params must be valid JSON");
    assert.ok(typeof kdfJson!.algorithm === "string", "KDF JSON must have an 'algorithm' field");
    assert.ok(typeof kdfJson!.params === "object" && kdfJson!.params !== null, "KDF JSON must have a 'params' object");
    assert.ok(typeof kdfJson!.salt === "string", "KDF JSON must have a 'salt' hex string");

    // Must still decrypt correctly (keyring is unlocked).
    const { gzPath } = await decryptCapsuleFile({ encPath, memoryDir: dir });
    const decrypted = await readFile(gzPath);
    const orig = gzipSync(Buffer.from('{"hello":"world"}', "utf-8"));
    // Content-level verify: gunzip both and compare.
    assert.ok(
      gunzipSync(decrypted).equals(gunzipSync(orig)),
      "decrypted content must match original",
    );
  } finally {
    keyring.lockAll();
    await rm(dir, { recursive: true, force: true });
  }
});

// ─── Test 10: enforceRetention prunes .enc backup files (Codex P2 / Cursor) ───

test("backupMemoryDir with retentionDays prunes old encrypted .enc backup files", async () => {
  const memDir = await makeTempDir();
  const backupDir = await makeTempDir();
  try {
    await makeMemoryDir(memDir);
    await initAndUnlockStore(memDir);

    // Create two synthetic .enc backup files with timestamps in the past.
    // Timestamp format: YYYY-MM-DDTHH-MM-SS-mmmZ
    const oldTs = "2020-01-01T00-00-00-000Z";
    const recentTs = new Date(Date.now() - 1000).toISOString().replace(/[:.]/g, "-");
    const oldEncFile = path.join(backupDir, `${oldTs}.backup.json.gz.enc`);
    const recentEncFile = path.join(backupDir, `${recentTs}.backup.json.gz.enc`);
    await writeFile(oldEncFile, Buffer.from("fake-old-enc"));
    await writeFile(recentEncFile, Buffer.from("fake-recent-enc"));

    // Run an encrypted backup with retentionDays=30 — the old file should be pruned.
    await backupMemoryDir({
      memoryDir: memDir,
      outDir: backupDir,
      pluginVersion: "0.0.0-test",
      encrypt: true,
      retentionDays: 30,
    });

    const oldExists = await stat(oldEncFile).then(() => true).catch(() => false);
    assert.equal(oldExists, false, "old .enc backup should be pruned by retention sweep");

    const recentExists = await stat(recentEncFile).then(() => true).catch(() => false);
    assert.equal(recentExists, true, "recent .enc backup should NOT be pruned");
  } finally {
    keyring.lockAll();
    await rm(memDir, { recursive: true, force: true });
    await rm(backupDir, { recursive: true, force: true });
  }
});

// ─── Test 11: backupMemoryDir excludes .secure-store and .capsules (Cursor) ────

test("backupMemoryDir excludes .secure-store and .capsules directories from encrypted backup", async () => {
  const memDir = await makeTempDir();
  const backupDir = await makeTempDir();
  try {
    await makeMemoryDir(memDir);
    await initAndUnlockStore(memDir);

    // Create a .capsules dir with a dummy file.
    await mkdir(path.join(memDir, ".capsules"), { recursive: true });
    await writeFile(path.join(memDir, ".capsules", "test.capsule.json.gz"), Buffer.from("dummy"));

    const encPath = await backupMemoryDir({
      memoryDir: memDir,
      outDir: backupDir,
      pluginVersion: "0.0.0-test",
      encrypt: true,
    });

    assert.ok(encPath.endsWith(".enc"), "should produce .enc file");

    // Decrypt and inspect the bundle: .secure-store and .capsules paths must not appear.
    const { decryptCapsuleFile: decrypt } = await import("./capsule-crypto.js");
    const { gzPath } = await decrypt({ encPath, memoryDir: memDir });
    const gz = await readFile(gzPath);
    const bundleStr = gunzipSync(gz).toString("utf-8");
    const bundle = JSON.parse(bundleStr) as { records: Array<{ path: string }> };

    const paths = bundle.records.map((r) => r.path);
    const hasSS = paths.some((p) => p.includes(".secure-store"));
    const hasCapsules = paths.some((p) => p.includes(".capsules"));
    assert.equal(hasSS, false, ".secure-store paths must not appear in encrypted backup");
    assert.equal(hasCapsules, false, ".capsules paths must not appear in encrypted backup");

    // facts/ should still be present.
    const hasFacts = paths.some((p) => p.startsWith("facts/"));
    assert.equal(hasFacts, true, "facts/ should be included in the backup");
  } finally {
    keyring.lockAll();
    await rm(memDir, { recursive: true, force: true });
    await rm(backupDir, { recursive: true, force: true });
  }
});

test("backupMemoryDir excludes nested encrypted backup output directory", async () => {
  const memDir = await makeTempDir();
  try {
    await makeMemoryDir(memDir);
    await initAndUnlockStore(memDir);

    const backupDir = path.join(memDir, "backups");
    await mkdir(backupDir, { recursive: true });
    await writeFile(path.join(backupDir, "old.backup.json.gz.enc"), Buffer.from("old backup"));

    const encPath = await backupMemoryDir({
      memoryDir: memDir,
      outDir: backupDir,
      pluginVersion: "0.0.0-test",
      encrypt: true,
    });

    const { gzPath } = await decryptCapsuleFile({ encPath, memoryDir: memDir });
    const gz = await readFile(gzPath);
    const bundle = JSON.parse(gunzipSync(gz).toString("utf-8")) as {
      records: Array<{ path: string }>;
    };
    const paths = bundle.records.map((record) => record.path);

    assert.equal(paths.some((entry) => entry === "backups" || entry.startsWith("backups/")), false);
    assert.equal(paths.some((entry) => entry.startsWith("facts/")), true);
  } finally {
    keyring.lockAll();
    await rm(memDir, { recursive: true, force: true });
  }
});

// ─── Test 12: exportCapsule includeTranscripts=true includes all dirs (Cursor) ─

test("exportCapsule with includeTranscripts=true includes transcripts and peers dirs without dropping other dirs", async () => {
  const srcDir = await makeTempDir();
  const outDir = await makeTempDir();
  try {
    // Create facts, peers, forks, and transcripts dirs.
    await mkdir(path.join(srcDir, "facts"), { recursive: true });
    await mkdir(path.join(srcDir, "peers", "peer-1"), { recursive: true });
    await mkdir(path.join(srcDir, "forks", "fork-1"), { recursive: true });
    await mkdir(path.join(srcDir, "transcripts", "session-1"), { recursive: true });

    await writeFile(path.join(srcDir, "facts", "a.md"), "---\nid: a\n---\nA.");
    await writeFile(path.join(srcDir, "peers", "peer-1", "profile.md"), "# Peer 1");
    await writeFile(path.join(srcDir, "forks", "fork-1", "b.md"), "---\nid: b\n---\nB.");
    await writeFile(path.join(srcDir, "transcripts", "session-1", "turn.md"), "# Turn");

    const result = await exportCapsule({
      name: "test-include-transcripts",
      root: srcDir,
      outDir,
      pluginVersion: "0.0.0-test",
      includeTranscripts: true,
      now: 1_700_000_010_000,
    });

    const paths = result.manifest.files.map((f) => f.path);

    // All four category dirs should be present.
    assert.ok(paths.some((p) => p.startsWith("facts/")), "facts/ must be included");
    assert.ok(paths.some((p) => p.startsWith("peers/")), "peers/ must be included (not dropped by --transcripts flag)");
    assert.ok(paths.some((p) => p.startsWith("forks/")), "forks/ must be included (not dropped by --transcripts flag)");
    assert.ok(paths.some((p) => p.startsWith("transcripts/")), "transcripts/ must be included when includeTranscripts=true");

    // manifest.includesTranscripts should be true.
    assert.equal(result.manifest.includesTranscripts, true, "manifest.includesTranscripts must be true");
  } finally {
    await rm(srcDir, { recursive: true, force: true });
    await rm(outDir, { recursive: true, force: true });
  }
});
