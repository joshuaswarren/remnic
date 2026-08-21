import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  canonicalJsonStringify,
  hashBytes,
  hashCanonicalJson,
  hashString,
  isSha256Hex,
  loadSealKeyFromEnv,
  openSeal,
  safeHexEqual,
  sealPayload,
} from "./hash-verification.ts";

test("hashString produces a stable lowercase SHA-256 hex digest", () => {
  const digest = hashString("remnic-integrity");
  assert.equal(digest.length, 64);
  assert.match(digest, /^[0-9a-f]{64}$/u);
  // Stable across calls.
  assert.equal(hashString("remnic-integrity"), digest);
});

test("hashBytes matches hashString for identical content", () => {
  const text = "bench-integrity-canary";
  assert.equal(hashBytes(Buffer.from(text, "utf8")), hashString(text));
});

test("canonicalJsonStringify sorts nested object keys", () => {
  const left = { b: 1, a: { y: 2, x: 1 } };
  const right = { a: { x: 1, y: 2 }, b: 1 };
  assert.equal(canonicalJsonStringify(left), canonicalJsonStringify(right));
  assert.equal(
    hashCanonicalJson(left),
    hashCanonicalJson(right),
    "canonical hash must ignore insertion order",
  );
});

test("isSha256Hex validates lowercase 64-char hex strings", () => {
  assert.ok(isSha256Hex("0".repeat(64)));
  assert.ok(!isSha256Hex("0".repeat(63)));
  assert.ok(!isSha256Hex("A".repeat(64)));
  assert.ok(!isSha256Hex(12 as unknown as string));
});

test("safeHexEqual short-circuits on length mismatch and matches equal hashes", () => {
  const a = hashString("one");
  const b = hashString("one");
  assert.ok(safeHexEqual(a, b));
  assert.ok(!safeHexEqual(a, hashString("two")));
  assert.ok(!safeHexEqual(a, a.slice(0, -1)));
});

test("sealPayload/openSeal round-trips plaintext under the same key", () => {
  const key = randomBytes(32);
  const plaintext = JSON.stringify({ ground: "truth", nested: { a: 1 } });
  const seal = sealPayload(plaintext, key);
  assert.equal(seal.version, 1);
  assert.equal(seal.algorithm, "aes-256-gcm");
  assert.equal(seal.plaintextHash, hashString(plaintext));

  const recovered = openSeal(seal, key);
  assert.equal(recovered, plaintext);
});

test("openSeal fails when the plaintext hash is tampered with", () => {
  const key = randomBytes(32);
  const seal = sealPayload("qrels-v1", key);
  const tampered = { ...seal, plaintextHash: hashString("different") };
  assert.throws(() => openSeal(tampered, key), /plaintext hash does not match/);
});

test("openSeal rejects wrong keys", () => {
  const key = randomBytes(32);
  const wrongKey = randomBytes(32);
  const seal = sealPayload("qrels-v1", key);
  assert.throws(() => openSeal(seal, wrongKey));
});

test("sealPayload rejects malformed keys", () => {
  assert.throws(() => sealPayload("x", Buffer.alloc(16)), /32-byte Buffer/);
});

test("loadSealKeyFromEnv decodes a base64 32-byte key", () => {
  const key = randomBytes(32);
  process.env.REMNIC_TEST_SEAL_KEY = key.toString("base64");
  try {
    const loaded = loadSealKeyFromEnv("REMNIC_TEST_SEAL_KEY");
    assert.ok(loaded);
    assert.ok(loaded.equals(key));
  } finally {
    delete process.env.REMNIC_TEST_SEAL_KEY;
  }
});

test("loadSealKeyFromEnv returns null when the variable is unset", () => {
  delete process.env.REMNIC_UNSET_SEAL_KEY;
  assert.equal(loadSealKeyFromEnv("REMNIC_UNSET_SEAL_KEY"), null);
});

test("loadSealKeyFromEnv rejects wrong-length base64 inputs", () => {
  // 16 bytes of base64 is 24 chars — outside the strict 43/44-char pattern.
  process.env.REMNIC_TEST_BAD_SEAL_KEY = Buffer.alloc(16).toString("base64");
  try {
    assert.throws(
      () => loadSealKeyFromEnv("REMNIC_TEST_BAD_SEAL_KEY"),
      /32 bytes/,
    );
  } finally {
    delete process.env.REMNIC_TEST_BAD_SEAL_KEY;
  }
});

test("loadSealKeyFromEnv rejects non-base64 strings", () => {
  process.env.REMNIC_TEST_BAD_CHARS_SEAL_KEY = "not-a-valid-base64-string!!!!!";
  try {
    assert.throws(
      () => loadSealKeyFromEnv("REMNIC_TEST_BAD_CHARS_SEAL_KEY"),
      /base64/,
    );
  } finally {
    delete process.env.REMNIC_TEST_BAD_CHARS_SEAL_KEY;
  }
});

test("loadSealKeyFromEnv accepts base64url-encoded keys", () => {
  const key = Buffer.from("a".repeat(32));
  const base64url = key.toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
  process.env.REMNIC_TEST_BASE64URL_SEAL_KEY = base64url;
  try {
    const loaded = loadSealKeyFromEnv("REMNIC_TEST_BASE64URL_SEAL_KEY");
    assert.ok(loaded);
    assert.ok(loaded.equals(key));
  } finally {
    delete process.env.REMNIC_TEST_BASE64URL_SEAL_KEY;
  }
});
