/**
 * Tests for the `remnic secure-store {init,unlock,lock,status}` CLI
 * handlers (issue #690 PR 2/4).
 *
 * These tests drive the pure handler functions directly with an
 * injected passphrase reader and low-cost KDF parameter sets so
 * the suite stays fast on CI.
 */

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { PassThrough } from "node:stream";

import {
  HEADER_FILENAME,
  MIN_PASSPHRASE_LENGTH,
  SECURE_STORE_DIR_NAME,
  buildHeader,
  createPassphraseReader,
  generateSalt,
  headerPath,
  keyring,
  parseHeader,
  readHeader,
  runSecureStoreDisable,
  runSecureStoreInit,
  runSecureStoreLock,
  runSecureStoreMigrate,
  runSecureStoreStatus,
  runSecureStoreUnlock,
  isEncryptedFile,
  readMaybeEncryptedFile,
  secureStoreDir,
  serializeHeader,
  validateHeader,
  verifyKey,
  writeHeader,
} from "../src/secure-store/index.js";
import {
  buildHeaderFromPassphrase,
  deriveKeyFromHeader,
} from "../packages/remnic-core/src/secure-store/header.js";
import { buildMetadata } from "../packages/remnic-core/src/secure-store/metadata.js";
import type {
  Argon2idParams,
  ScryptParams,
} from "../packages/remnic-core/src/secure-store/kdf.js";

// Low-cost scrypt params: still RFC 7914 valid (N power of 2),
// derives in <5 ms. Used everywhere the test doesn't specifically
// exercise default params.
const FAST_SCRYPT: ScryptParams = {
  N: 1 << 10, // 2^10 = 1024
  r: 1,
  p: 1,
  keyLength: 32,
  maxmem: 32 * 1024 * 1024,
};

const FAST_ARGON2ID: Argon2idParams = {
  memoryKiB: 8,
  iterations: 1,
  parallelism: 1,
  keyLength: 32,
};

const TEST_PASSPHRASE = "correct horse battery staple";
const WRONG_PASSPHRASE = "wrong horse battery staple";

function tmpDir(prefix: string): string {
  return path.join(
    os.tmpdir(),
    `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
}

function staticPassphraseReader(...sequence: string[]): {
  reader: (prompt: string, options?: { confirm?: boolean }) => Promise<string>;
  callCount: () => number;
} {
  let i = 0;
  const reader = async (
    _prompt: string,
    options?: { confirm?: boolean },
  ): Promise<string> => {
    const value = sequence[i++];
    if (value === undefined) {
      throw new Error(`passphrase reader called more times than sequence length (${sequence.length})`);
    }
    if (options?.confirm) {
      const confirm = sequence[i++];
      if (confirm === undefined) {
        throw new Error("passphrase reader: missing confirm value in sequence");
      }
      if (confirm !== value) {
        throw new Error("passphrases did not match");
      }
    }
    return value;
  };
  return { reader, callCount: () => i };
}

async function withTmpMemoryDir(
  body: (memoryDir: string, keyringId: string) => Promise<void>,
): Promise<void> {
  const memoryDir = tmpDir("secure-store-cli");
  const keyringId = memoryDir; // unique per test
  await mkdir(memoryDir, { recursive: true });
  try {
    await body(memoryDir, keyringId);
  } finally {
    keyring.lock(keyringId);
    await rm(memoryDir, { recursive: true, force: true });
  }
}

// ─── status before init ──────────────────────────────────────────────

test("status before init reports not-initialized + locked", async () => {
  await withTmpMemoryDir(async (memoryDir, keyringId) => {
    const report = await runSecureStoreStatus({ memoryDir, keyringId });
    assert.equal(report.initialized, false);
    assert.equal(report.locked, true);
    assert.equal(report.unlockedAt, null);
    assert.equal(report.kdf, null);
    assert.equal(report.createdAt, null);
    assert.equal(
      report.headerPath,
      path.join(memoryDir, SECURE_STORE_DIR_NAME, HEADER_FILENAME),
    );
  });
});

// ─── init creates header with valid KDF metadata ─────────────────────

test("init writes a header with the chosen scrypt params and a sealed verifier", async () => {
  await withTmpMemoryDir(async (memoryDir, keyringId) => {
    const { reader } = staticPassphraseReader(TEST_PASSPHRASE, TEST_PASSPHRASE);
    const report = await runSecureStoreInit({
      memoryDir,
      keyringId,
      readPassphrase: reader,
      algorithm: "scrypt",
      params: FAST_SCRYPT,
      note: "test-init",
    });
    assert.equal(report.ok, true);
    assert.equal(report.kdf.algorithm, "scrypt");
    if (report.kdf.algorithm === "scrypt") {
      assert.equal(report.kdf.params.N, FAST_SCRYPT.N);
      assert.equal(report.kdf.params.r, FAST_SCRYPT.r);
    }
    assert.match(report.headerPath, /\.secure-store\/header\.json$/);
    // Header file landed on disk and round-trips through parse.
    const raw = await readFile(report.headerPath, "utf8");
    const header = parseHeader(raw);
    assert.equal(header.metadata.note, "test-init");
    // Init does NOT auto-unlock.
    const status = keyring.status(keyringId);
    assert.equal(status.unlocked, false);
  });
});

test("init defaults new stores to argon2id", async () => {
  await withTmpMemoryDir(async (memoryDir, keyringId) => {
    const { reader } = staticPassphraseReader(TEST_PASSPHRASE, TEST_PASSPHRASE);
    const report = await runSecureStoreInit({
      memoryDir,
      keyringId,
      readPassphrase: reader,
      params: FAST_ARGON2ID,
    });
    assert.equal(report.ok, true);
    assert.equal(report.kdf.algorithm, "argon2id");
    if (report.kdf.algorithm === "argon2id") {
      assert.equal(report.kdf.params.memoryKiB, FAST_ARGON2ID.memoryKiB);
      assert.equal(report.kdf.params.iterations, FAST_ARGON2ID.iterations);
      assert.equal(report.kdf.params.parallelism, FAST_ARGON2ID.parallelism);
    }
  });
});

test("init refuses to overwrite an existing header", async () => {
  await withTmpMemoryDir(async (memoryDir, keyringId) => {
    const first = staticPassphraseReader(TEST_PASSPHRASE, TEST_PASSPHRASE);
    await runSecureStoreInit({
      memoryDir,
      keyringId,
      readPassphrase: first.reader,
      algorithm: "scrypt",
      params: FAST_SCRYPT,
    });
    const second = staticPassphraseReader(TEST_PASSPHRASE, TEST_PASSPHRASE);
    await assert.rejects(
      runSecureStoreInit({
        memoryDir,
        keyringId,
        readPassphrase: second.reader,
        algorithm: "scrypt",
        params: FAST_SCRYPT,
      }),
      /already exists/,
    );
    // Bonus: passphrase reader should never have been called for the
    // second attempt — early existence-check rejects before KDF.
    assert.equal(second.callCount(), 0);
  });
});

test("init rejects passphrases shorter than the minimum length", async () => {
  await withTmpMemoryDir(async (memoryDir, keyringId) => {
    const short = "a".repeat(MIN_PASSPHRASE_LENGTH - 1);
    const { reader } = staticPassphraseReader(short, short);
    await assert.rejects(
      runSecureStoreInit({
        memoryDir,
        keyringId,
        readPassphrase: reader,
        algorithm: "scrypt",
        params: FAST_SCRYPT,
      }),
      /at least .* characters/,
    );
    // Header must NOT have been written.
    const exists = await readFile(headerPath(memoryDir), "utf8").catch(() => null);
    assert.equal(exists, null);
  });
});

test("init surfaces a passphrase-mismatch error from the reader", async () => {
  await withTmpMemoryDir(async (memoryDir, keyringId) => {
    const { reader } = staticPassphraseReader(TEST_PASSPHRASE, "different one");
    await assert.rejects(
      runSecureStoreInit({
        memoryDir,
        keyringId,
        readPassphrase: reader,
        algorithm: "scrypt",
        params: FAST_SCRYPT,
      }),
      /did not match/,
    );
  });
});

// ─── unlock ──────────────────────────────────────────────────────────

test("unlock with the correct passphrase registers the key in the keyring", async () => {
  await withTmpMemoryDir(async (memoryDir, keyringId) => {
    const init = staticPassphraseReader(TEST_PASSPHRASE, TEST_PASSPHRASE);
    await runSecureStoreInit({
      memoryDir,
      keyringId,
      readPassphrase: init.reader,
      algorithm: "scrypt",
      params: FAST_SCRYPT,
    });
    assert.equal(keyring.status(keyringId).unlocked, false);

    const unlock = staticPassphraseReader(TEST_PASSPHRASE);
    const report = await runSecureStoreUnlock({
      memoryDir,
      keyringId,
      readPassphrase: unlock.reader,
    });
    assert.equal(report.ok, true);
    if (report.ok) {
      assert.equal(report.algorithm, "scrypt");
      assert.match(report.unlockedAt, /^\d{4}-\d{2}-\d{2}T/);
    }
    const ks = keyring.status(keyringId);
    assert.equal(ks.unlocked, true);
    assert.notEqual(ks.unlockedAt, null);
  });
});

test("unlock with the wrong passphrase fails cleanly and leaves the keyring locked", async () => {
  await withTmpMemoryDir(async (memoryDir, keyringId) => {
    const init = staticPassphraseReader(TEST_PASSPHRASE, TEST_PASSPHRASE);
    await runSecureStoreInit({
      memoryDir,
      keyringId,
      readPassphrase: init.reader,
      algorithm: "scrypt",
      params: FAST_SCRYPT,
    });

    const unlock = staticPassphraseReader(WRONG_PASSPHRASE);
    const report = await runSecureStoreUnlock({
      memoryDir,
      keyringId,
      readPassphrase: unlock.reader,
    });
    assert.equal(report.ok, false);
    if (!report.ok) {
      assert.equal(report.reason, "wrong-passphrase");
    }
    assert.equal(keyring.status(keyringId).unlocked, false);
  });
});

test("unlock against a non-initialized memoryDir reports not-initialized", async () => {
  await withTmpMemoryDir(async (memoryDir, keyringId) => {
    const { reader } = staticPassphraseReader(TEST_PASSPHRASE);
    const report = await runSecureStoreUnlock({
      memoryDir,
      keyringId,
      readPassphrase: reader,
    });
    assert.equal(report.ok, false);
    if (!report.ok) {
      assert.equal(report.reason, "not-initialized");
    }
  });
});

// ─── lock ────────────────────────────────────────────────────────────

test("lock clears the in-memory key and is idempotent", async () => {
  await withTmpMemoryDir(async (memoryDir, keyringId) => {
    const init = staticPassphraseReader(TEST_PASSPHRASE, TEST_PASSPHRASE);
    await runSecureStoreInit({
      memoryDir,
      keyringId,
      readPassphrase: init.reader,
      algorithm: "scrypt",
      params: FAST_SCRYPT,
    });
    const unlock = staticPassphraseReader(TEST_PASSPHRASE);
    await runSecureStoreUnlock({
      memoryDir,
      keyringId,
      readPassphrase: unlock.reader,
    });
    assert.equal(keyring.status(keyringId).unlocked, true);

    const first = runSecureStoreLock({ memoryDir, keyringId });
    assert.deepEqual(first, { ok: true, cleared: true });
    assert.equal(keyring.status(keyringId).unlocked, false);

    // Idempotent: a second lock succeeds with `cleared: false`.
    const second = runSecureStoreLock({ memoryDir, keyringId });
    assert.deepEqual(second, { ok: true, cleared: false });
  });
});

// ─── migrate ────────────────────────────────────────────────────────

test("migrate encrypts plaintext storage files and is idempotent", async () => {
  await withTmpMemoryDir(async (memoryDir, keyringId) => {
    const init = staticPassphraseReader(TEST_PASSPHRASE, TEST_PASSPHRASE);
    await runSecureStoreInit({
      memoryDir,
      keyringId,
      readPassphrase: init.reader,
      algorithm: "scrypt",
      params: FAST_SCRYPT,
    });
    const unlock = staticPassphraseReader(TEST_PASSPHRASE);
    await runSecureStoreUnlock({
      memoryDir,
      keyringId,
      readPassphrase: unlock.reader,
    });

    const filePath = path.join(memoryDir, "facts", "2026-04-28", "fact-a.md");
    const original = "---\nid: fact-a\ncategory: fact\n---\nprivate fact";
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, original, "utf8");

    const first = await runSecureStoreMigrate({ memoryDir, keyringId });
    assert.equal(first.ok, true);
    assert.equal(first.encrypted, 1);
    assert.equal(first.skipped, 0);
    assert.equal(first.errors.length, 0);
    assert.equal(isEncryptedFile(await readFile(filePath)), true);
    assert.equal(
      await readMaybeEncryptedFile(filePath, keyring.getKey(keyringId), memoryDir),
      original,
    );

    const second = await runSecureStoreMigrate({ memoryDir, keyringId });
    assert.equal(second.ok, true);
    assert.equal(second.encrypted, 0);
    assert.equal(second.skipped, 1);
    assert.equal(second.errors.length, 0);
  });
});

test("migrate fails clearly when the secure-store is not initialized", async () => {
  await withTmpMemoryDir(async (memoryDir, keyringId) => {
    const report = await runSecureStoreMigrate({ memoryDir, keyringId });
    assert.deepEqual(report, {
      ok: false,
      reason: "not-initialized",
      encrypted: 0,
      skipped: 0,
      errors: [],
    });
  });
});

test("migrate fails clearly when the secure-store is locked", async () => {
  await withTmpMemoryDir(async (memoryDir, keyringId) => {
    const init = staticPassphraseReader(TEST_PASSPHRASE, TEST_PASSPHRASE);
    await runSecureStoreInit({
      memoryDir,
      keyringId,
      readPassphrase: init.reader,
      algorithm: "scrypt",
      params: FAST_SCRYPT,
    });
    const report = await runSecureStoreMigrate({ memoryDir, keyringId });
    assert.deepEqual(report, {
      ok: false,
      reason: "locked",
      encrypted: 0,
      skipped: 0,
      errors: [],
    });
  });
});

test("disable decrypts encrypted files and leaves the header in place", async () => {
  await withTmpMemoryDir(async (memoryDir, keyringId) => {
    const init = staticPassphraseReader(TEST_PASSPHRASE, TEST_PASSPHRASE);
    await runSecureStoreInit({
      memoryDir,
      keyringId,
      readPassphrase: init.reader,
      algorithm: "scrypt",
      params: FAST_SCRYPT,
    });
    await runSecureStoreUnlock({
      memoryDir,
      keyringId,
      readPassphrase: staticPassphraseReader(TEST_PASSPHRASE).reader,
    });

    const filePath = path.join(memoryDir, "facts", "2026-04-28", "fact-a.md");
    const original = "---\nid: fact-a\ncategory: fact\n---\nprivate fact";
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, original, "utf8");
    await runSecureStoreMigrate({ memoryDir, keyringId });
    assert.equal(isEncryptedFile(await readFile(filePath)), true);

    const report = await runSecureStoreDisable({ memoryDir, keyringId });
    assert.equal(report.ok, true);
    assert.equal(report.decrypted, 1);
    assert.equal(report.skipped, 0);
    assert.equal(report.errors.length, 0);
    assert.equal(await readFile(filePath, "utf8"), original);
    assert.equal(isEncryptedFile(await readFile(filePath)), false);
    assert.notEqual(await readHeader(memoryDir), null);

    const second = await runSecureStoreDisable({ memoryDir, keyringId });
    assert.equal(second.ok, true);
    assert.equal(second.decrypted, 0);
    assert.equal(second.skipped, 1);
    assert.equal(second.errors.length, 0);
  });
});

test("disable fails clearly when the secure-store is not initialized", async () => {
  await withTmpMemoryDir(async (memoryDir, keyringId) => {
    const report = await runSecureStoreDisable({ memoryDir, keyringId });
    assert.deepEqual(report, {
      ok: false,
      reason: "not-initialized",
      decrypted: 0,
      skipped: 0,
      errors: [],
    });
  });
});

test("disable fails clearly when the secure-store is locked", async () => {
  await withTmpMemoryDir(async (memoryDir, keyringId) => {
    const init = staticPassphraseReader(TEST_PASSPHRASE, TEST_PASSPHRASE);
    await runSecureStoreInit({
      memoryDir,
      keyringId,
      readPassphrase: init.reader,
      algorithm: "scrypt",
      params: FAST_SCRYPT,
    });
    const report = await runSecureStoreDisable({ memoryDir, keyringId });
    assert.deepEqual(report, {
      ok: false,
      reason: "locked",
      decrypted: 0,
      skipped: 0,
      errors: [],
    });
  });
});

test("cli.ts registers the secure-store migrate subcommand", async () => {
  const cliSource = await readFile(
    path.resolve(
      import.meta.dirname,
      "..",
      "packages",
      "remnic-core",
      "src",
      "cli.ts",
    ),
    "utf8",
  );
  assert.match(cliSource, /\.command\("migrate"\)/);
  assert.match(cliSource, /runSecureStoreMigrate/);
  assert.match(cliSource, /renderMigrateReport/);
});

test("cli.ts registers the secure-store disable and decrypt subcommands", async () => {
  const cliSource = await readFile(
    path.resolve(
      import.meta.dirname,
      "..",
      "packages",
      "remnic-core",
      "src",
      "cli.ts",
    ),
    "utf8",
  );
  assert.match(cliSource, /\.command\("disable"\)/);
  assert.match(cliSource, /\.command\("decrypt"\)/);
  assert.match(cliSource, /runSecureStoreDisable/);
  assert.match(cliSource, /renderDisableReport/);
});

// ─── status (initialized) ────────────────────────────────────────────

test("status after init reports initialized + locked + KDF params", async () => {
  await withTmpMemoryDir(async (memoryDir, keyringId) => {
    const init = staticPassphraseReader(TEST_PASSPHRASE, TEST_PASSPHRASE);
    await runSecureStoreInit({
      memoryDir,
      keyringId,
      readPassphrase: init.reader,
      algorithm: "scrypt",
      params: FAST_SCRYPT,
    });
    const report = await runSecureStoreStatus({ memoryDir, keyringId });
    assert.equal(report.initialized, true);
    assert.equal(report.locked, true);
    assert.equal(report.unlockedAt, null);
    assert.ok(report.kdf);
    assert.equal(report.kdf!.algorithm, "scrypt");
    assert.match(report.createdAt!, /^\d{4}-\d{2}-\d{2}T/);
  });
});

test("status after unlock reports unlocked + last-unlock timestamp", async () => {
  await withTmpMemoryDir(async (memoryDir, keyringId) => {
    const init = staticPassphraseReader(TEST_PASSPHRASE, TEST_PASSPHRASE);
    await runSecureStoreInit({
      memoryDir,
      keyringId,
      readPassphrase: init.reader,
      algorithm: "scrypt",
      params: FAST_SCRYPT,
    });
    const unlock = staticPassphraseReader(TEST_PASSPHRASE);
    await runSecureStoreUnlock({
      memoryDir,
      keyringId,
      readPassphrase: unlock.reader,
    });
    const report = await runSecureStoreStatus({ memoryDir, keyringId });
    assert.equal(report.initialized, true);
    assert.equal(report.locked, false);
    assert.notEqual(report.unlockedAt, null);
    assert.match(report.unlockedAt!, /^\d{4}-\d{2}-\d{2}T/);
  });
});

// ─── header round-trip ───────────────────────────────────────────────

test("header serializes + parses via the public surface", async () => {
  const salt = generateSalt();
  const built = buildHeaderFromPassphrase({
    passphrase: TEST_PASSPHRASE,
    salt,
    algorithm: "scrypt",
    params: FAST_SCRYPT,
  });
  validateHeader(built.header);
  const json = serializeHeader(built.header);
  const parsed = parseHeader(json);
  assert.deepEqual(parsed.metadata.kdf, built.header.metadata.kdf);
  assert.equal(parsed.verifier, built.header.verifier);
  assert.equal(parsed.createdAt, built.header.createdAt);
  // Re-derive the key from the parsed header and verify the verifier opens.
  const reDerived = deriveKeyFromHeader(parsed, TEST_PASSPHRASE);
  assert.equal(verifyKey(parsed, reDerived), true);
  built.derivedKey.fill(0);
  reDerived.fill(0);
});

test("verifyKey rejects a key derived from the wrong passphrase", () => {
  const salt = generateSalt();
  const metadata = buildMetadata({ algorithm: "scrypt", salt, params: FAST_SCRYPT });
  // Build the header under TEST_PASSPHRASE, then attempt to verify
  // with a key derived from WRONG_PASSPHRASE.
  const built = buildHeaderFromPassphrase({
    passphrase: TEST_PASSPHRASE,
    salt,
    algorithm: "scrypt",
    params: FAST_SCRYPT,
  });
  const wrong = deriveKeyFromHeader(
    { ...built.header, metadata },
    WRONG_PASSPHRASE,
  );
  assert.equal(verifyKey(built.header, wrong), false);
  built.derivedKey.fill(0);
  wrong.fill(0);
});

// ─── writeHeader atomicity / refusal ──────────────────────────────────

test("writeHeader refuses to overwrite and never deletes the existing file", async () => {
  await withTmpMemoryDir(async (memoryDir) => {
    const salt = generateSalt();
    const built = buildHeaderFromPassphrase({
      passphrase: TEST_PASSPHRASE,
      salt,
      algorithm: "scrypt",
      params: FAST_SCRYPT,
    });
    const written = await writeHeader(memoryDir, built.header);
    const before = await readFile(written, "utf8");
    // Build a different header under a different passphrase; expect refusal.
    const built2 = buildHeaderFromPassphrase({
      passphrase: "another passphrase value",
      salt: generateSalt(),
      algorithm: "scrypt",
      params: FAST_SCRYPT,
    });
    await assert.rejects(writeHeader(memoryDir, built2.header), /Refusing to overwrite/);
    const after = await readFile(written, "utf8");
    assert.equal(after, before);
    built.derivedKey.fill(0);
    built2.derivedKey.fill(0);
  });
});

// ─── parseHeader strictness ───────────────────────────────────────────

test("parseHeader rejects malformed JSON, wrong format string, and tampered verifier", () => {
  // Invalid JSON.
  assert.throws(() => parseHeader("{not json"), /not valid JSON/);
  // Wrong format string.
  const ok = buildHeader({
    metadata: buildMetadata({ algorithm: "scrypt", salt: generateSalt(), params: FAST_SCRYPT }),
    derivedKey: Buffer.alloc(32, 0xab),
  });
  const json = serializeHeader(ok);
  const tampered = JSON.parse(json) as Record<string, unknown>;
  tampered.format = "remnic.something-else";
  assert.throws(() => parseHeader(JSON.stringify(tampered)), /unexpected header format/);
  // Non-hex verifier.
  const tampered2 = JSON.parse(json) as Record<string, unknown>;
  tampered2.verifier = "not-hex!!";
  assert.throws(() => parseHeader(JSON.stringify(tampered2)), /hex/i);
});

// ─── readHeader returns null for missing dirs ─────────────────────────

test("readHeader returns null when no header exists", async () => {
  await withTmpMemoryDir(async (memoryDir) => {
    const result = await readHeader(memoryDir);
    assert.equal(result, null);
  });
});

test("secureStoreDir + headerPath honor memoryDir", () => {
  const root = "/tmp/example";
  assert.equal(secureStoreDir(root), path.join(root, SECURE_STORE_DIR_NAME));
  assert.equal(headerPath(root), path.join(root, SECURE_STORE_DIR_NAME, HEADER_FILENAME));
});

// ─── pre-existing tampered header on disk is rejected by readHeader ──

test("readHeader rejects a tampered header file", async () => {
  await withTmpMemoryDir(async (memoryDir) => {
    const dir = secureStoreDir(memoryDir);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, HEADER_FILENAME), "not json", "utf8");
    await assert.rejects(readHeader(memoryDir), /not valid JSON/);
  });
});

// ─── concurrent writeHeader: exactly one wins ────────────────────────

// ─── passphrase reader: piped (non-TTY) input round-trips ────────────

test("createPassphraseReader: piped non-TTY input returns the supplied line", async () => {
  // Codex P1 on PR #737: a previous version of `readPlainLine`
  // could resolve the promise with "" because rl.close() emits
  // synchronously and the close handler raced the line handler.
  // This test asserts a piped passphrase survives intact.
  const input = new PassThrough();
  const output = new PassThrough();
  const errorStream = new PassThrough();
  // Drain output / errorStream so writes don't backpressure the test.
  output.on("data", () => {});
  errorStream.on("data", () => {});
  const reader = createPassphraseReader({ input, output, errorStream });
  const promise = reader("Enter passphrase: ");
  input.write("supplied-secret\n");
  input.end();
  const result = await promise;
  assert.equal(result, "supplied-secret");
});

test("createPassphraseReader: confirm mode preserves both lines on piped non-TTY input", async () => {
  // Cursor medium on PR #737: a fresh readline per call breaks
  // confirm-mode because the first interface consumes the entire
  // prebuffered stream. With the queued line reader, both lines
  // survive intact even when written together before the first read.
  const input = new PassThrough();
  const output = new PassThrough();
  const errorStream = new PassThrough();
  output.on("data", () => {});
  errorStream.on("data", () => {});
  const reader = createPassphraseReader({ input, output, errorStream });
  const promise = reader("Enter passphrase: ", { confirm: true });
  // Both lines arrive in a single contiguous write — the worst case
  // for the previous bug. Even after `end()` the queue should hand
  // out both lines in order.
  input.write("matching-secret\nmatching-secret\n");
  input.end();
  const result = await promise;
  assert.equal(result, "matching-secret");
});

test("createPassphraseReader: confirm mode mismatches throw a clear error", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const errorStream = new PassThrough();
  output.on("data", () => {});
  errorStream.on("data", () => {});
  const reader = createPassphraseReader({ input, output, errorStream });
  const promise = reader("Enter passphrase: ", { confirm: true });
  input.write("first-line\n");
  input.write("different-confirm\n");
  input.end();
  await assert.rejects(promise, /did not match/);
});

test("createPassphraseReader: empty stream resolves to empty string (status-only path)", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const errorStream = new PassThrough();
  output.on("data", () => {});
  errorStream.on("data", () => {});
  const reader = createPassphraseReader({ input, output, errorStream });
  const promise = reader("Enter passphrase: ");
  input.end();
  const result = await promise;
  assert.equal(result, "");
});

test("concurrent writeHeader calls — exactly one succeeds, the rest get EEXIST", async () => {
  // Codex P1 on PR #737: the previous read-then-write existence check
  // was a check-then-act race. With the `wx` flag, the OS guarantees
  // exactly one writer succeeds even when multiple inits are in
  // flight simultaneously.
  await withTmpMemoryDir(async (memoryDir) => {
    const builds = Array.from({ length: 5 }, () =>
      buildHeaderFromPassphrase({
        passphrase: TEST_PASSPHRASE,
        salt: generateSalt(),
        algorithm: "scrypt",
        params: FAST_SCRYPT,
      }),
    );
    const results = await Promise.allSettled(
      builds.map((b) => writeHeader(memoryDir, b.header)),
    );
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    assert.equal(fulfilled.length, 1, "exactly one writer should succeed");
    assert.equal(rejected.length, builds.length - 1);
    for (const r of rejected) {
      assert.match(
        (r as PromiseRejectedResult).reason.message,
        /Refusing to overwrite/,
      );
    }
    for (const b of builds) b.derivedKey.fill(0);
  });
});
