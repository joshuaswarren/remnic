
import assert from "node:assert/strict";
import { mkdir, mkdtemp, open as openFile, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  ENVELOPE_HEADER_SIZE,
  ENVELOPE_LAYOUT,
  ENVELOPE_SALT_LENGTH,
  ENVELOPE_VERSION,
  IV_LENGTH,
  generateSalt,
  open,
  parseEnvelope,
  seal,
} from "./cipher.js";
import { renderInitReport, renderLockReport, renderStatusReport, renderUnlockReport } from "./cli-renderer.js";
import {
  HEADER_FORMAT,
  HEADER_FORMAT_VERSION,
  buildHeaderFromPassphrase,
  parseHeader,
  validateHeader,
} from "./header.js";
import {
  type Argon2idParams,
  DEFAULT_ARGON2ID_PARAMS,
  DEFAULT_SCRYPT_PARAMS,
  KDF_KEY_LENGTH,
  KDF_SALT_LENGTH,
  type ScryptParams,
  constantTimeEqual,
  deriveKey,
  deriveKeyArgon2id,
  deriveKeyScrypt,
  validateArgon2idParams,
  validateScryptParams,
} from "./kdf.js";
import {
  METADATA_FORMAT,
  METADATA_FORMAT_VERSION,
  buildMetadata,
  decodeMetadataSalt,
  parseMetadata,
  serializeMetadata,
  validateMetadata,
} from "./metadata.js";
import { createPassphraseReader } from "./passphrase-reader.js";
import {
  FILE_FORMAT_FLAGS,
  FILE_FORMAT_VERSION,
  MAGIC_BYTES,
  SecureStoreDecryptError,
  decryptFileBody,
  decryptMemoryDirToPlaintext,
  encryptFileBody,
  filePathAad,
  isEncryptedFile,
  migrateMemoryDirToEncrypted,
  probeEncryptedRegularFileHeader,
  readMaybeEncryptedFile,
  readMaybeEncryptedFileFromChunks,
} from "./secure-fs.js";

const FAST_SCRYPT: ScryptParams = {
  N: 1 << 10,
  r: 8,
  p: 1,
  keyLength: 32,
  maxmem: 64 * 1024 * 1024,
};

const FAST_ARGON2ID: Argon2idParams = {
  memoryKiB: 8,
  iterations: 1,
  parallelism: 1,
  keyLength: 32,
};


test("deriveKeyScrypt is deterministic for the same passphrase + salt + params", () => {
  const salt = Buffer.alloc(KDF_SALT_LENGTH, 0x42);
  const k1 = deriveKeyScrypt("correct horse battery staple", salt, FAST_SCRYPT);
  const k2 = deriveKeyScrypt("correct horse battery staple", salt, FAST_SCRYPT);
  assert.equal(k1.length, KDF_KEY_LENGTH);
  assert.equal(k2.length, KDF_KEY_LENGTH);
  assert.ok(k1.equals(k2), "same inputs must yield same key");
});

test("deriveKeyScrypt produces different keys for different passphrases", () => {
  const salt = Buffer.alloc(KDF_SALT_LENGTH, 0x42);
  const k1 = deriveKeyScrypt("passphrase-a", salt, FAST_SCRYPT);
  const k2 = deriveKeyScrypt("passphrase-b", salt, FAST_SCRYPT);
  assert.equal(k1.equals(k2), false);
});

test("deriveKeyScrypt produces different keys for different salts", () => {
  const saltA = Buffer.alloc(KDF_SALT_LENGTH, 0x01);
  const saltB = Buffer.alloc(KDF_SALT_LENGTH, 0x02);
  const k1 = deriveKeyScrypt("same passphrase", saltA, FAST_SCRYPT);
  const k2 = deriveKeyScrypt("same passphrase", saltB, FAST_SCRYPT);
  assert.equal(k1.equals(k2), false);
});

test("deriveKeyScrypt with default OWASP-acceptable params produces a 32-byte key", () => {
  const salt = Buffer.alloc(KDF_SALT_LENGTH, 0x99);
  const key = deriveKeyScrypt("default-params-smoke-test", salt);
  assert.equal(key.length, KDF_KEY_LENGTH);
  assert.equal(DEFAULT_SCRYPT_PARAMS.keyLength, 32);
  assert.equal(DEFAULT_SCRYPT_PARAMS.N, 1 << 17);
});

test("secure-store CLI renderers describe process-local unlock scope, not daemon state", () => {
  const init = renderInitReport({
    ok: true,
    headerPath: "/tmp/memory/.secure-store/header.json",
    createdAt: "2026-05-21T00:00:00.000Z",
    kdf: {
      algorithm: "scrypt",
      params: FAST_SCRYPT,
      salt: Buffer.alloc(KDF_SALT_LENGTH, 0x11).toString("hex"),
    },
  });
  assert.match(init, /current Remnic process/);
  assert.doesNotMatch(init, /running daemon/);

  assert.match(
    renderUnlockReport({
      ok: true,
      unlockedAt: "2026-05-21T00:00:01.000Z",
      algorithm: "scrypt",
    }),
    /unlocked in this process/
  );
  assert.match(renderLockReport({ ok: true, cleared: true }), /this process's in-memory keyring/);
  assert.match(
    renderStatusReport({
      initialized: true,
      headerPath: "/tmp/memory/.secure-store/header.json",
      locked: false,
      unlockedAt: "2026-05-21T00:00:01.000Z",
      createdAt: "2026-05-21T00:00:00.000Z",
      kdf: {
        algorithm: "scrypt",
        params: FAST_SCRYPT,
        salt: Buffer.alloc(KDF_SALT_LENGTH, 0x22).toString("hex"),
      },
    }),
    /lockedInThisProcess: no/
  );
});

test("deriveKeyScrypt rejects empty passphrase", () => {
  const salt = Buffer.alloc(KDF_SALT_LENGTH, 0);
  assert.throws(() => deriveKeyScrypt("", salt, FAST_SCRYPT), /passphrase/);
});

test("deriveKeyScrypt rejects too-short salt", () => {
  assert.throws(() => deriveKeyScrypt("pw", Buffer.alloc(4, 0), FAST_SCRYPT), /salt/);
});

test("deriveKey('scrypt') dispatches to scryptSync", () => {
  const salt = Buffer.alloc(KDF_SALT_LENGTH, 0x42);
  const viaWrapper = deriveKey("scrypt", "pw", salt, FAST_SCRYPT);
  const direct = deriveKeyScrypt("pw", salt, FAST_SCRYPT);
  assert.ok(viaWrapper.equals(direct));
});

test("deriveKeyArgon2id is deterministic for the same passphrase + salt + params", () => {
  const salt = Buffer.alloc(KDF_SALT_LENGTH, 0x24);
  const k1 = deriveKeyArgon2id("correct horse battery staple", salt, FAST_ARGON2ID);
  const k2 = deriveKeyArgon2id("correct horse battery staple", salt, FAST_ARGON2ID);
  assert.equal(k1.length, KDF_KEY_LENGTH);
  assert.equal(k2.length, KDF_KEY_LENGTH);
  assert.ok(k1.equals(k2), "same inputs must yield same key");
});

test("deriveKeyArgon2id produces different keys for different passphrases", () => {
  const salt = Buffer.alloc(KDF_SALT_LENGTH, 0x24);
  const k1 = deriveKeyArgon2id("passphrase-a", salt, FAST_ARGON2ID);
  const k2 = deriveKeyArgon2id("passphrase-b", salt, FAST_ARGON2ID);
  assert.equal(k1.equals(k2), false);
});

test("deriveKey('argon2id') dispatches to Argon2id", () => {
  const salt = Buffer.alloc(KDF_SALT_LENGTH, 0x24);
  const viaWrapper = deriveKey("argon2id", "pw", salt, FAST_ARGON2ID);
  const direct = deriveKeyArgon2id("pw", salt, FAST_ARGON2ID);
  assert.ok(viaWrapper.equals(direct));
  assert.equal(DEFAULT_ARGON2ID_PARAMS.memoryKiB, 64 * 1024);
  assert.equal(DEFAULT_ARGON2ID_PARAMS.iterations, 3);
  assert.equal(DEFAULT_ARGON2ID_PARAMS.parallelism, 4);
});

test("validateArgon2idParams rejects invalid values", () => {
  assert.throws(() => validateArgon2idParams({ ...FAST_ARGON2ID, memoryKiB: 0 }), /memoryKiB/);
  assert.throws(() => validateArgon2idParams({ ...FAST_ARGON2ID, iterations: 0 }), /iterations/);
  assert.throws(() => validateArgon2idParams({ ...FAST_ARGON2ID, parallelism: 0 }), /parallelism/);
  assert.throws(() => validateArgon2idParams({ ...FAST_ARGON2ID, keyLength: 16 }), /keyLength/);
});

test("validateScryptParams rejects non-power-of-2 N", () => {
  assert.throws(() => validateScryptParams({ ...FAST_SCRYPT, N: 1000 }), /power of 2/);
});

test("validateScryptParams rejects N < 2", () => {
  assert.throws(() => validateScryptParams({ ...FAST_SCRYPT, N: 1 }), /N/);
});

test("constantTimeEqual returns true for equal buffers", () => {
  const a = Buffer.from([1, 2, 3, 4]);
  const b = Buffer.from([1, 2, 3, 4]);
  assert.equal(constantTimeEqual(a, b), true);
});

test("constantTimeEqual returns false for different buffers", () => {
  const a = Buffer.from([1, 2, 3, 4]);
  const b = Buffer.from([1, 2, 3, 5]);
  assert.equal(constantTimeEqual(a, b), false);
});

test("constantTimeEqual returns false for different-length buffers", () => {
  const a = Buffer.from([1, 2, 3]);
  const b = Buffer.from([1, 2, 3, 4]);
  assert.equal(constantTimeEqual(a, b), false);
});


test("seal/open round-trip on a small payload", () => {
  const salt = generateSalt();
  const key = deriveKeyScrypt("pw", salt, FAST_SCRYPT);
  const plaintext = Buffer.from("hello, secure-store!");
  const sealed = seal(key, salt, plaintext);
  const opened = open(key, sealed);
  assert.ok(opened.equals(plaintext));
});

test("seal/open round-trip on a large payload (1 MiB)", () => {
  const salt = generateSalt();
  const key = deriveKeyScrypt("pw", salt, FAST_SCRYPT);
  const plaintext = Buffer.alloc(1024 * 1024);
  for (let i = 0; i < plaintext.length; i++) {
    plaintext[i] = i & 0xff;
  }
  const sealed = seal(key, salt, plaintext);
  const opened = open(key, sealed);
  assert.equal(opened.length, plaintext.length);
  assert.ok(opened.equals(plaintext));
});

test("seal/open round-trip on an empty payload", () => {
  const salt = generateSalt();
  const key = deriveKeyScrypt("pw", salt, FAST_SCRYPT);
  const sealed = seal(key, salt, Buffer.alloc(0));
  const opened = open(key, sealed);
  assert.equal(opened.length, 0);
});

test("decryptFileBody reports truncated envelopes as structural errors", () => {
  const truncated = Buffer.concat([
    MAGIC_BYTES,
    Buffer.from([FILE_FORMAT_VERSION, FILE_FORMAT_FLAGS]),
    Buffer.alloc(ENVELOPE_HEADER_SIZE - 1),
  ]);
  assert.throws(
    () => decryptFileBody(truncated, Buffer.alloc(KDF_KEY_LENGTH, 0x11)),
    (error) => {
      assert.ok(error instanceof Error);
      assert.equal(error instanceof SecureStoreDecryptError, false);
      assert.match(error.message, /envelope too short/);
      return true;
    }
  );
});

test("seal produces a different ciphertext for the same plaintext (random IV)", () => {
  const salt = generateSalt();
  const key = deriveKeyScrypt("pw", salt, FAST_SCRYPT);
  const plaintext = Buffer.from("same plaintext, twice");
  const a = seal(key, salt, plaintext);
  const b = seal(key, salt, plaintext);
  assert.equal(a.equals(b), false, "fresh IV must produce fresh ciphertext");
  assert.ok(open(key, a).equals(plaintext));
  assert.ok(open(key, b).equals(plaintext));
});

test("seal envelope layout matches the documented format", () => {
  const salt = Buffer.alloc(ENVELOPE_SALT_LENGTH, 0xaa);
  const key = deriveKeyScrypt("pw", salt, FAST_SCRYPT);
  const sealed = seal(key, salt, Buffer.from("payload"));
  assert.equal(sealed[ENVELOPE_LAYOUT.version], ENVELOPE_VERSION);
  const saltSlice = sealed.subarray(ENVELOPE_LAYOUT.salt, ENVELOPE_LAYOUT.salt + ENVELOPE_SALT_LENGTH);
  assert.ok(saltSlice.equals(salt));
  assert.equal(sealed.length, ENVELOPE_HEADER_SIZE + 7);
});

test("open fails on wrong passphrase (auth-tag mismatch)", () => {
  const salt = generateSalt();
  const goodKey = deriveKeyScrypt("right-passphrase", salt, FAST_SCRYPT);
  const badKey = deriveKeyScrypt("WRONG-passphrase", salt, FAST_SCRYPT);
  const sealed = seal(goodKey, salt, Buffer.from("secret"));
  assert.throws(() => open(badKey, sealed));
});

test("open fails when ciphertext is tampered", () => {
  const salt = generateSalt();
  const key = deriveKeyScrypt("pw", salt, FAST_SCRYPT);
  const sealed = seal(key, salt, Buffer.from("the quick brown fox"));
  const tampered = Buffer.from(sealed);
  tampered[ENVELOPE_LAYOUT.ciphertext] ^= 0x01;
  assert.throws(() => open(key, tampered));
});

test("open fails when the auth tag is tampered", () => {
  const salt = generateSalt();
  const key = deriveKeyScrypt("pw", salt, FAST_SCRYPT);
  const sealed = seal(key, salt, Buffer.from("payload"));
  const tampered = Buffer.from(sealed);
  tampered[ENVELOPE_LAYOUT.authTag] ^= 0xff;
  assert.throws(() => open(key, tampered));
});

test("open fails when the IV is tampered", () => {
  const salt = generateSalt();
  const key = deriveKeyScrypt("pw", salt, FAST_SCRYPT);
  const sealed = seal(key, salt, Buffer.from("payload"));
  const tampered = Buffer.from(sealed);
  tampered[ENVELOPE_LAYOUT.iv] ^= 0xff;
  assert.throws(() => open(key, tampered));
});

test("open fails on truncated envelope", () => {
  const salt = generateSalt();
  const key = deriveKeyScrypt("pw", salt, FAST_SCRYPT);
  const sealed = seal(key, salt, Buffer.from("payload"));
  const truncated = sealed.subarray(0, ENVELOPE_HEADER_SIZE - 4);
  assert.throws(() => open(key, truncated), /envelope too short|envelope/);
});

test("open fails on unsupported envelope version", () => {
  const salt = generateSalt();
  const key = deriveKeyScrypt("pw", salt, FAST_SCRYPT);
  const sealed = seal(key, salt, Buffer.from("payload"));
  const tampered = Buffer.from(sealed);
  tampered[ENVELOPE_LAYOUT.version] = 99;
  assert.throws(() => open(key, tampered), /version/i);
});

test("seal/open round-trip with AAD", () => {
  const salt = generateSalt();
  const key = deriveKeyScrypt("pw", salt, FAST_SCRYPT);
  const aad = Buffer.from("/memories/2026-04-25.md");
  const plaintext = Buffer.from("hello with aad");
  const sealed = seal(key, salt, plaintext, { aad });
  const opened = open(key, sealed, { aad });
  assert.ok(opened.equals(plaintext));
});

test("open fails when AAD is mismatched", () => {
  const salt = generateSalt();
  const key = deriveKeyScrypt("pw", salt, FAST_SCRYPT);
  const sealed = seal(key, salt, Buffer.from("hello"), {
    aad: Buffer.from("path-A"),
  });
  assert.throws(() => open(key, sealed, { aad: Buffer.from("path-B") }));
});

test("seal rejects key of wrong length", () => {
  const salt = generateSalt();
  assert.throws(() => seal(Buffer.alloc(16), salt, Buffer.from("x")), /AES-256-GCM/);
});

test("seal rejects salt of wrong length", () => {
  const key = deriveKeyScrypt("pw", Buffer.alloc(KDF_SALT_LENGTH, 0), FAST_SCRYPT);
  assert.throws(() => seal(key, Buffer.alloc(8), Buffer.from("x")), /salt/);
});

test("parseEnvelope round-trips the documented fields", () => {
  const salt = Buffer.alloc(ENVELOPE_SALT_LENGTH, 0x33);
  const key = deriveKeyScrypt("pw", salt, FAST_SCRYPT);
  const iv = Buffer.alloc(IV_LENGTH, 0x55);
  const sealed = seal(key, salt, Buffer.from("hello"), { iv });
  const parsed = parseEnvelope(sealed);
  assert.equal(parsed.version, ENVELOPE_VERSION);
  assert.ok(parsed.salt.equals(salt));
  assert.ok(parsed.iv.equals(iv));
});

test("generateSalt returns a 16-byte buffer", () => {
  const s1 = generateSalt();
  const s2 = generateSalt();
  assert.equal(s1.length, ENVELOPE_SALT_LENGTH);
  assert.equal(s1.equals(s2), false);
});


test("buildMetadata + serialize + parse round-trip (scrypt)", () => {
  const salt = Buffer.alloc(KDF_SALT_LENGTH, 0xab);
  const meta = buildMetadata({
    algorithm: "scrypt",
    salt,
    createdAt: "2026-04-25T12:00:00.000Z",
    note: "test fixture",
  });
  const json = serializeMetadata(meta);
  const parsed = parseMetadata(json);
  assert.deepEqual(parsed, meta);
  assert.equal(parsed.format, METADATA_FORMAT);
  assert.equal(parsed.formatVersion, METADATA_FORMAT_VERSION);
  assert.equal(parsed.kdf.algorithm, "scrypt");
  assert.equal(parsed.note, "test fixture");
  assert.ok(decodeMetadataSalt(parsed).equals(salt));
});

test("buildMetadata + serialize + parse round-trip (argon2id)", () => {
  const salt = Buffer.alloc(KDF_SALT_LENGTH, 0xcd);
  const meta = buildMetadata({
    algorithm: "argon2id",
    salt,
    createdAt: "2026-04-25T12:00:00.000Z",
  });
  const parsed = parseMetadata(serializeMetadata(meta));
  assert.equal(parsed.kdf.algorithm, "argon2id");
  if (parsed.kdf.algorithm === "argon2id") {
    assert.equal(parsed.kdf.params.memoryKiB, DEFAULT_ARGON2ID_PARAMS.memoryKiB);
    assert.equal(parsed.kdf.params.iterations, DEFAULT_ARGON2ID_PARAMS.iterations);
  }
});

test("buildMetadata defaults createdAt to a parseable ISO string when omitted", () => {
  const salt = Buffer.alloc(KDF_SALT_LENGTH, 0);
  const meta = buildMetadata({ algorithm: "scrypt", salt });
  assert.ok(typeof meta.createdAt === "string");
  const date = new Date(meta.createdAt);
  assert.equal(Number.isNaN(date.getTime()), false);
});

test("buildMetadata rejects salt of wrong length", () => {
  assert.throws(() => buildMetadata({ algorithm: "scrypt", salt: Buffer.alloc(8) }), /salt/);
});

test("parseMetadata rejects non-JSON input", () => {
  assert.throws(() => parseMetadata("not json {"), /JSON/);
});

test("parseMetadata rejects wrong format identifier", () => {
  const bad = JSON.stringify({
    format: "something.else",
    formatVersion: 1,
    kdf: {
      algorithm: "scrypt",
      params: DEFAULT_SCRYPT_PARAMS,
      salt: "00".repeat(KDF_SALT_LENGTH),
    },
    createdAt: "2026-04-25T00:00:00.000Z",
  });
  assert.throws(() => parseMetadata(bad), /format/);
});

test("parseMetadata rejects unsupported formatVersion", () => {
  const bad = JSON.stringify({
    format: METADATA_FORMAT,
    formatVersion: 999,
    kdf: {
      algorithm: "scrypt",
      params: DEFAULT_SCRYPT_PARAMS,
      salt: "00".repeat(KDF_SALT_LENGTH),
    },
    createdAt: "2026-04-25T00:00:00.000Z",
  });
  assert.throws(() => parseMetadata(bad), /formatVersion/);
});

test("parseMetadata rejects salt with wrong byte length", () => {
  const bad = JSON.stringify({
    format: METADATA_FORMAT,
    formatVersion: METADATA_FORMAT_VERSION,
    kdf: {
      algorithm: "scrypt",
      params: DEFAULT_SCRYPT_PARAMS,
      salt: "00".repeat(8), // 8 bytes — too short.
    },
    createdAt: "2026-04-25T00:00:00.000Z",
  });
  assert.throws(() => parseMetadata(bad), /salt|expected/);
});

test("parseMetadata rejects non-hex salt", () => {
  const bad = JSON.stringify({
    format: METADATA_FORMAT,
    formatVersion: METADATA_FORMAT_VERSION,
    kdf: {
      algorithm: "scrypt",
      params: DEFAULT_SCRYPT_PARAMS,
      salt: "zz".repeat(KDF_SALT_LENGTH),
    },
    createdAt: "2026-04-25T00:00:00.000Z",
  });
  assert.throws(() => parseMetadata(bad), /hex/);
});

test("parseMetadata rejects unknown KDF algorithm", () => {
  const bad = JSON.stringify({
    format: METADATA_FORMAT,
    formatVersion: METADATA_FORMAT_VERSION,
    kdf: {
      algorithm: "rot13",
      params: { foo: 1 },
      salt: "00".repeat(KDF_SALT_LENGTH),
    },
    createdAt: "2026-04-25T00:00:00.000Z",
  });
  assert.throws(() => parseMetadata(bad), /algorithm/);
});

test("validateMetadata rejects non-power-of-2 N", () => {
  const meta = buildMetadata({
    algorithm: "scrypt",
    salt: Buffer.alloc(KDF_SALT_LENGTH, 0),
  });
  if (meta.kdf.algorithm === "scrypt") {
    meta.kdf.params.N = 1000;
  }
  assert.throws(() => validateMetadata(meta), /power of 2/);
});

test("serializeMetadata produces stable top-level key order", () => {
  const salt = Buffer.alloc(KDF_SALT_LENGTH, 0x77);
  const meta = buildMetadata({
    algorithm: "scrypt",
    salt,
    createdAt: "2026-04-25T00:00:00.000Z",
  });
  const json = serializeMetadata(meta);
  const formatIdx = json.indexOf('"format"');
  const formatVersionIdx = json.indexOf('"formatVersion"');
  const kdfIdx = json.indexOf('"kdf"');
  const createdAtIdx = json.indexOf('"createdAt"');
  assert.ok(
    formatIdx >= 0 && formatIdx < formatVersionIdx && formatVersionIdx < kdfIdx && kdfIdx < createdAtIdx,
    `unexpected top-level key order in: ${json}`
  );
});


test("end-to-end: build metadata → derive key → seal → open round-trip", () => {
  const salt = generateSalt();
  const meta = buildMetadata({
    algorithm: "scrypt",
    salt,
    createdAt: "2026-04-25T00:00:00.000Z",
  });
  const reparsed = parseMetadata(serializeMetadata(meta));
  const recoveredSalt = decodeMetadataSalt(reparsed);
  assert.ok(recoveredSalt.equals(salt));
  const key = deriveKeyScrypt("user-passphrase", recoveredSalt, FAST_SCRYPT);
  const sealed = seal(key, recoveredSalt, Buffer.from("end-to-end"));
  const opened = open(key, sealed);
  assert.equal(opened.toString("utf8"), "end-to-end");
});

test("secure-store migration keeps namespaced file AAD readable through memory root", async () => {
  const memoryDir = await mkdtemp(path.join(tmpdir(), "remnic-secure-store-aad-"));
  try {
    const filePath = path.join(memoryDir, "namespaces", "project-a", "facts", "note.md");
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, "namespaced fact", "utf8");

    const key = deriveKeyScrypt("namespace-aad", Buffer.alloc(KDF_SALT_LENGTH, 0x44), FAST_SCRYPT);
    const migrated = await migrateMemoryDirToEncrypted(memoryDir, key);

    assert.equal(migrated.encrypted, 1);
    assert.deepEqual(migrated.errors, []);
    assert.equal(await readMaybeEncryptedFile(filePath, key, memoryDir), "namespaced fact");

    const decrypted = await decryptMemoryDirToPlaintext(memoryDir, key);
    assert.equal(decrypted.decrypted, 1);
    assert.deepEqual(decrypted.errors, []);
    assert.equal(await readFile(filePath, "utf8"), "namespaced fact");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("secure-store migration encrypts per-session buffer state files", async () => {
  const memoryDir = await mkdtemp(path.join(tmpdir(), "remnic-secure-store-buffer-session-"));
  try {
    const sessionPath = path.join(memoryDir, "state", "buffer", "session-a.json");
    await mkdir(path.dirname(sessionPath), { recursive: true });
    await writeFile(sessionPath, JSON.stringify({ key: "session-a", turns: [] }), "utf8");

    const key = deriveKeyScrypt("buffer-session", Buffer.alloc(KDF_SALT_LENGTH, 0x66), FAST_SCRYPT);
    const migrated = await migrateMemoryDirToEncrypted(memoryDir, key);

    assert.equal(migrated.encrypted, 1);
    assert.deepEqual(migrated.errors, []);
    assert.equal(isEncryptedFile(await readFile(sessionPath)), true);
    assert.equal(
      await readMaybeEncryptedFile(sessionPath, key, memoryDir),
      JSON.stringify({ key: "session-a", turns: [] }),
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("secure-store migration treats missing memory roots as empty", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "remnic-secure-store-missing-root-"));
  try {
    const missingMemoryDir = path.join(tempRoot, "missing-memory");
    const key = deriveKeyScrypt("missing-root", Buffer.alloc(KDF_SALT_LENGTH, 0x55), FAST_SCRYPT);

    const migrated = await migrateMemoryDirToEncrypted(missingMemoryDir, key);
    assert.deepEqual(migrated, { encrypted: 0, skipped: 0, errors: [] });

    const decrypted = await decryptMemoryDirToPlaintext(missingMemoryDir, key);
    assert.deepEqual(decrypted, { decrypted: 0, skipped: 0, errors: [] });
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("secure-store migration scans the normalized root for symlink dot-dot paths", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "remnic-secure-store-root-dotdot-"));
  try {
    const baseDir = path.join(tempRoot, "base");
    const outsideParent = path.join(tempRoot, "outside-parent");
    const outsideTarget = path.join(outsideParent, "target");
    const memoryLink = path.join(baseDir, "memory-link");
    const traversalRoot = `${memoryLink}${path.sep}..`;
    const insideFilePath = path.join(baseDir, "facts", "note.md");
    const outsideFilePath = path.join(outsideParent, "facts", "note.md");
    await mkdir(path.dirname(insideFilePath), { recursive: true });
    await mkdir(path.dirname(outsideFilePath), { recursive: true });
    await mkdir(outsideTarget, { recursive: true });
    await writeFile(insideFilePath, "inside fact", "utf8");
    await writeFile(outsideFilePath, "outside fact", "utf8");
    await symlink(outsideTarget, memoryLink, "dir");

    const key = deriveKeyScrypt("dotdot-root-symlink", Buffer.alloc(KDF_SALT_LENGTH, 0x56), FAST_SCRYPT);
    const migrated = await migrateMemoryDirToEncrypted(traversalRoot, key);

    assert.equal(migrated.encrypted, 1);
    assert.equal(isEncryptedFile(await readFile(insideFilePath)), true);
    assert.equal(await readFile(outsideFilePath, "utf8"), "outside fact");

    const decrypted = await decryptMemoryDirToPlaintext(traversalRoot, key);
    assert.equal(decrypted.decrypted, 1);
    assert.equal(await readFile(insideFilePath, "utf8"), "inside fact");
    assert.equal(await readFile(outsideFilePath, "utf8"), "outside fact");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("secure-store migration rejects symlinked memory roots without rewriting the target", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "remnic-secure-store-root-symlink-"));
  try {
    const outsideDir = path.join(tempRoot, "outside");
    const memoryDir = path.join(tempRoot, "memory-link");
    const filePath = path.join(outsideDir, "facts", "note.md");
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, "outside fact", "utf8");
    await symlink(outsideDir, memoryDir, "dir");

    const key = deriveKeyScrypt("root-symlink", Buffer.alloc(KDF_SALT_LENGTH, 0x66), FAST_SCRYPT);
    await assert.rejects(
      () => migrateMemoryDirToEncrypted(`${memoryDir}${path.sep}`, key),
      /root must not be a symlink/
    );
    await assert.rejects(
      () => migrateMemoryDirToEncrypted(`${memoryDir}${path.sep}.`, key),
      /root must not be a symlink/
    );

    assert.equal(await readFile(filePath, "utf8"), "outside fact");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("secure-store plaintext migration rejects symlinked memory roots without rewriting the target", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "remnic-secure-store-decrypt-root-symlink-"));
  try {
    const outsideDir = path.join(tempRoot, "outside");
    const memoryDir = path.join(tempRoot, "memory-link");
    const realFilePath = path.join(outsideDir, "facts", "note.md");
    const linkedFilePath = path.join(memoryDir, "facts", "note.md");
    await mkdir(path.dirname(realFilePath), { recursive: true });
    await symlink(outsideDir, memoryDir, "dir");

    const key = deriveKeyScrypt("decrypt-root-symlink", Buffer.alloc(KDF_SALT_LENGTH, 0x77), FAST_SCRYPT);
    await writeFile(
      realFilePath,
      encryptFileBody("outside encrypted fact", key, filePathAad(linkedFilePath, memoryDir))
    );

    await assert.rejects(
      () => decryptMemoryDirToPlaintext(`${memoryDir}${path.sep}`, key),
      /root must not be a symlink/
    );
    await assert.rejects(
      () => decryptMemoryDirToPlaintext(`${memoryDir}${path.sep}.`, key),
      /root must not be a symlink/
    );

    const stillEncrypted = await readFile(realFilePath);
    assert.equal(isEncryptedFile(stillEncrypted), true);
    assert.equal(
      decryptFileBody(stillEncrypted, key, filePathAad(linkedFilePath, memoryDir)).toString("utf8"),
      "outside encrypted fact"
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("secure-store can recover namespaced files encrypted with legacy namespace AAD", async () => {
  const memoryDir = await mkdtemp(path.join(tmpdir(), "remnic-secure-store-legacy-aad-"));
  try {
    const namespaceRoot = path.join(memoryDir, "namespaces", "project-a");
    const filePath = path.join(namespaceRoot, "facts", "note.md");
    await mkdir(path.dirname(filePath), { recursive: true });

    const key = deriveKeyScrypt("legacy-namespace-aad", Buffer.alloc(KDF_SALT_LENGTH, 0x55), FAST_SCRYPT);
    const legacyEncrypted = encryptFileBody("legacy namespaced fact", key, filePathAad(filePath, namespaceRoot));
    await writeFile(filePath, legacyEncrypted);

    assert.equal(await readMaybeEncryptedFile(filePath, key, memoryDir), "legacy namespaced fact");

    const decrypted = await decryptMemoryDirToPlaintext(memoryDir, key);
    assert.equal(decrypted.decrypted, 1);
    assert.deepEqual(decrypted.errors, []);
    assert.equal(await readFile(filePath, "utf8"), "legacy namespaced fact");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("tampered envelope salt fails decryption (codex P1 — header AAD)", () => {
  const salt = generateSalt();
  const key = deriveKeyScrypt("passphrase", salt, FAST_SCRYPT);
  const envelope = Buffer.from(seal(key, salt, Buffer.from("secret")));
  envelope[5] = envelope[5] ^ 0xff;
  assert.throws(() => open(key, envelope), /auth|tag|decrypt|unable/i);
});

test("metadata rejects keyLength != 32 (codex P2 — match cipher AES-256)", () => {
  const meta = buildMetadata({
    algorithm: "scrypt",
    salt: generateSalt(),
    createdAt: "2026-04-25T00:00:00.000Z",
  }) as { kdf: { params: { keyLength: number } } };
  meta.kdf.params.keyLength = 16;
  assert.throws(
    () => validateMetadata(meta as unknown as Parameters<typeof validateMetadata>[0]),
    /keyLength must be 32/
  );
});


test("parseHeader rejects odd-length verifier hex (thread 6 — even-length guard)", () => {
  const salt = Buffer.alloc(KDF_SALT_LENGTH, 0x11);
  const { header } = buildHeaderFromPassphrase({
    passphrase: "test-pass",
    salt,
    algorithm: "scrypt",
    params: { N: 1 << 10, r: 8, p: 1, keyLength: 32, maxmem: 64 * 1024 * 1024 },
  });
  const badJson = JSON.stringify({
    format: HEADER_FORMAT,
    formatVersion: HEADER_FORMAT_VERSION,
    metadata: JSON.parse(JSON.stringify(header.metadata)),
    verifier: header.verifier.slice(0, -1), // odd length
    createdAt: header.createdAt,
  });
  assert.throws(() => parseHeader(badJson), /even length|even/i);
});

test("validateHeader rejects odd-length verifier hex (thread 6 — even-length guard)", () => {
  const salt = Buffer.alloc(KDF_SALT_LENGTH, 0x22);
  const { header } = buildHeaderFromPassphrase({
    passphrase: "test-pass-2",
    salt,
    algorithm: "scrypt",
    params: { N: 1 << 10, r: 8, p: 1, keyLength: 32, maxmem: 64 * 1024 * 1024 },
  });
  const bad = { ...header, verifier: header.verifier.slice(0, -1) }; // odd length
  assert.throws(() => validateHeader(bad), /even length|even/i);
});

test("parseHeader rejects non-hex characters in verifier (thread 6)", () => {
  const salt = Buffer.alloc(KDF_SALT_LENGTH, 0x33);
  const { header } = buildHeaderFromPassphrase({
    passphrase: "test-pass-3",
    salt,
    algorithm: "scrypt",
    params: { N: 1 << 10, r: 8, p: 1, keyLength: 32, maxmem: 64 * 1024 * 1024 },
  });
  const badJson = JSON.stringify({
    format: HEADER_FORMAT,
    formatVersion: HEADER_FORMAT_VERSION,
    metadata: JSON.parse(JSON.stringify(header.metadata)),
    verifier: `zz${header.verifier.slice(2)}`, // non-hex prefix
    createdAt: header.createdAt,
  });
  assert.throws(() => parseHeader(badJson), /hex/i);
});


test("non-TTY prompt is written to errorStream, not output (thread 5)", async () => {
  const inputStream = new PassThrough();
  inputStream.end("test-passphrase\n");

  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  const fakeOutput = new PassThrough();
  fakeOutput.on("data", (d: Buffer) => stdoutChunks.push(d.toString()));

  const fakeError = new PassThrough();
  fakeError.on("data", (d: Buffer) => stderrChunks.push(d.toString()));

  const reader = createPassphraseReader({
    input: inputStream,
    output: fakeOutput,
    errorStream: fakeError,
  });

  const passphrase = await reader("Enter passphrase: ");

  assert.equal(passphrase, "test-passphrase");
  const stderr = stderrChunks.join("");
  const stdout = stdoutChunks.join("");
  assert.ok(stderr.includes("Enter passphrase: "), `expected prompt on stderr but got: ${JSON.stringify(stderr)}`);
  assert.ok(
    !stdout.includes("Enter passphrase: "),
    `prompt must not appear on stdout but got: ${JSON.stringify(stdout)}`
  );
});


test("backspace removes full non-BMP (emoji) code point atomically (thread 7)", async () => {
  const inputStream = new PassThrough() as PassThrough & {
    isTTY: boolean;
    isRaw: boolean;
    setRawMode(raw: boolean): void;
  };
  inputStream.isTTY = true;
  inputStream.isRaw = false;
  inputStream.setRawMode = (_: boolean): void => {};

  const outputChunks: Buffer[] = [];
  const fakeOutput = new PassThrough();
  fakeOutput.on("data", (d: Buffer) => outputChunks.push(d));

  const reader = createPassphraseReader({
    input: inputStream,
    output: fakeOutput,
  });

  const readPromise = reader("Passphrase: ");

  const aBytes = Buffer.from("a", "utf8");
  const emojiBytes = Buffer.from("\u{1F511}", "utf8"); // 4 bytes in UTF-8
  const delByte = Buffer.from([0x7f]);
  const enterByte = Buffer.from([0x0d]);

  inputStream.push(aBytes);
  inputStream.push(emojiBytes);
  inputStream.push(delByte);
  inputStream.push(enterByte);

  const result = await readPromise;

  assert.equal(result, "a", `expected 'a' after backspace removed the emoji, but got: ${JSON.stringify(result)}`);
});

test("backspace on BMP character removes exactly one character (thread 7 — regression)", async () => {
  const inputStream = new PassThrough() as PassThrough & {
    isTTY: boolean;
    isRaw: boolean;
    setRawMode(raw: boolean): void;
  };
  inputStream.isTTY = true;
  inputStream.isRaw = false;
  inputStream.setRawMode = (_: boolean): void => {};

  const fakeOutput = new PassThrough();

  const reader = createPassphraseReader({
    input: inputStream,
    output: fakeOutput,
  });

  const readPromise = reader("Passphrase: ");

  inputStream.push(Buffer.from("abc", "utf8"));
  inputStream.push(Buffer.from([0x7f]));
  inputStream.push(Buffer.from([0x7f]));
  inputStream.push(Buffer.from([0x0d]));

  const result = await readPromise;

  assert.equal(result, "a");
});

test("secure-store migration encrypts memory category dirs but leaves the questions queue plaintext", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "remnic-secure-store-questions-"));
  try {
    const memoryDir = path.join(tempRoot, "memory");
    const decisionPath = path.join(memoryDir, "decisions", "2026-02-22", "decision-1.md");
    const questionPath = path.join(memoryDir, "questions", "q-1.md");
    await mkdir(path.dirname(decisionPath), { recursive: true });
    await mkdir(path.dirname(questionPath), { recursive: true });
    await writeFile(decisionPath, "---\ncategory: decision\n---\n\nChose Postgres.\n", "utf8");
    await writeFile(questionPath, "---\nid: q-1\nresolved: false\n---\n\nWhat DB?\n", "utf8");

    const key = deriveKeyScrypt("questions-plaintext", Buffer.alloc(KDF_SALT_LENGTH, 0x5a), FAST_SCRYPT);
    const migrated = await migrateMemoryDirToEncrypted(memoryDir, key);

    assert.equal(migrated.encrypted, 1, "only the decision memory should be encrypted");
    assert.equal(isEncryptedFile(await readFile(decisionPath)), true, "decisions/ is encrypted at rest");
    assert.equal(isEncryptedFile(await readFile(questionPath)), false, "questions/ stays plaintext");
    assert.match(await readFile(questionPath, "utf8"), /What DB\?/, "question body remains readable UTF-8");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("chunked encrypted reads fill the header across positioned short reads", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "remnic-chunked-header-"));
  const filePath = path.join(dir, "encrypted.md");
  const key = Buffer.alloc(32, 9);
  const plaintext = Buffer.from("streamed encrypted content survives short header reads");
  await writeFile(filePath, encryptFileBody(plaintext, key, filePathAad(filePath, dir)));

  const probeHandle = await openFile(filePath, "r");
  type PositionedRead = (
    buffer: Buffer,
    offset: number,
    length: number,
    position: number | null
  ) => Promise<{ bytesRead: number; buffer: Buffer }>;
  const handlePrototype = Object.getPrototypeOf(probeHandle) as { read: PositionedRead };
  const originalRead = handlePrototype.read;
  await probeHandle.close();
  let shortReadsRemaining = 3;
  handlePrototype.read = async function (buffer, offset, length, position) {
    const boundedLength = shortReadsRemaining > 0 ? Math.min(length, 4) : length;
    shortReadsRemaining -= 1;
    return await originalRead.call(this, buffer, offset, boundedLength, position);
  };

  try {
    assert.equal(await probeEncryptedRegularFileHeader(filePath), true);
    shortReadsRemaining = 3;
    const chunks: Buffer[] = [];
    for await (const chunk of readMaybeEncryptedFileFromChunks(filePath, key, dir, 11)) {
      chunks.push(chunk);
    }
    assert.deepEqual(Buffer.concat(chunks), plaintext);
  } finally {
    handlePrototype.read = originalRead;
    await rm(dir, { recursive: true, force: true });
  }
});

test("probeEncryptedRegularFileHeader detects encryption, treats absent as false, and refuses non-regular paths (#2033)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "remnic-probe-header-"));
  try {
    const plainPath = path.join(dir, "plain.jsonl");
    await writeFile(plainPath, "row-1\nrow-2\n", "utf8");
    assert.equal(await probeEncryptedRegularFileHeader(plainPath), false, "plaintext file is not encrypted");

    const encPath = path.join(dir, "enc.jsonl");
    const key = Buffer.alloc(32, 5);
    await writeFile(encPath, encryptFileBody("secret\n", key, filePathAad(encPath, dir)));
    assert.equal(await probeEncryptedRegularFileHeader(encPath), true, "encrypted file detected via magic header");

    assert.equal(await probeEncryptedRegularFileHeader(path.join(dir, "missing.jsonl")), false);

    const linkPath = path.join(dir, "link.jsonl");
    await symlink(plainPath, linkPath);
    await assert.rejects(
      () => probeEncryptedRegularFileHeader(linkPath),
      (err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        assert.match(message, /non-regular state path/);
        assert.match(message, /symlink\/FIFO\/device/);
        assert.ok(message.includes(linkPath));
        return true;
      }
    );

    await assert.rejects(() => probeEncryptedRegularFileHeader(dir), /non-regular state path/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
