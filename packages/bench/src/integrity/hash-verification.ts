/**
 * Hash verification utilities used by the benchmark integrity pipeline.
 *
 * These helpers produce deterministic SHA-256 digests for sealed artifacts:
 * qrels payloads, judge prompts, dataset files, and encrypted seals. They are
 * intentionally simple and rely only on Node's built-in crypto module so the
 * bench package can verify seals without additional dependencies.
 *
 * Rules of the road:
 * - Hashes are lowercase hex strings. Always compare with `timingSafeEqual`.
 * - Structured inputs are serialized with sorted keys so equivalent objects
 *   produce identical digests. This aligns with CLAUDE.md gotcha #38.
 * - The AES-GCM seal helpers use 256-bit keys and 96-bit IVs; they are a
 *   thin interface so CI + tests can exercise the flow without reaching for
 *   a KMS. Production deployments should wire a real key-management backend.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const SHA256_HEX_LENGTH = 64;
const AES_KEY_LENGTH = 32; // 256 bits
const AES_IV_LENGTH = 12; // 96-bit IV recommended for GCM
const AES_TAG_LENGTH = 16;

export const INTEGRITY_HASH_ALGORITHM = "sha256" as const;
export const INTEGRITY_CIPHER_ALGORITHM = "aes-256-gcm" as const;

export interface SealedArtifact {
  /** Version marker for the seal envelope. */
  version: 1;
  /** Symmetric cipher identifier. */
  algorithm: typeof INTEGRITY_CIPHER_ALGORITHM;
  /** Base64-encoded 96-bit IV. */
  iv: string;
  /** Base64-encoded 128-bit auth tag. */
  tag: string;
  /** Base64-encoded ciphertext. */
  ciphertext: string;
  /**
   * SHA-256 of the plaintext payload. Verified after decryption as a
   * defence-in-depth check against silent key rotation or ciphertext drift.
   */
  plaintextHash: string;
}

export function hashString(value: string): string {
  return createHash(INTEGRITY_HASH_ALGORITHM).update(value, "utf8").digest("hex");
}

export function hashBytes(value: Uint8Array): string {
  return createHash(INTEGRITY_HASH_ALGORITHM).update(value).digest("hex");
}

/**
 * Canonicalize a JSON-serializable value so equivalent payloads produce the
 * same digest regardless of key insertion order.
 *
 * `space` matches the third argument of `JSON.stringify` — pass `2` (or any
 * positive integer / indent string) when you want a pretty-printed output
 * that is still byte-stable across runs. Default is compact output.
 */
export function canonicalJsonStringify(
  value: unknown,
  space?: string | number,
): string {
  return JSON.stringify(value, canonicalReplacer, space);
}

/**
 * Exported so downstream callers can compose the canonical key-sort
 * contract into their own stringification (e.g. with a custom indent).
 */
export function canonicalReplacer(
  this: unknown,
  _key: string,
  value: unknown,
): unknown {
  if (Array.isArray(value)) {
    return value;
  }
  if (value && typeof value === "object") {
    return sortObjectKeys(value as Record<string, unknown>);
  }
  return value;
}

function sortObjectKeys(input: Record<string, unknown>): Record<string, unknown> {
  const keys = Object.keys(input).sort();
  const sorted: Record<string, unknown> = {};
  for (const key of keys) {
    sorted[key] = input[key];
  }
  return sorted;
}

export function hashCanonicalJson(value: unknown): string {
  return hashString(canonicalJsonStringify(value));
}

export function isSha256Hex(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

export function assertSha256Hex(value: unknown, label: string): string {
  if (!isSha256Hex(value)) {
    throw new Error(
      `Expected ${label} to be a lowercase SHA-256 hex digest (${SHA256_HEX_LENGTH} chars)`,
    );
  }
  return value;
}

/**
 * Constant-time equality check for hex digests. Returns `false` when inputs
 * differ in length — `timingSafeEqual` would otherwise throw.
 */
export function safeHexEqual(expected: string, actual: string): boolean {
  if (typeof expected !== "string" || typeof actual !== "string") {
    return false;
  }
  if (expected.length !== actual.length) {
    return false;
  }
  const expectedBuf = Buffer.from(expected, "hex");
  const actualBuf = Buffer.from(actual, "hex");
  if (expectedBuf.length !== actualBuf.length || expectedBuf.length === 0) {
    return false;
  }
  return timingSafeEqual(expectedBuf, actualBuf);
}

/**
 * Encrypt a plaintext payload with AES-256-GCM, returning a seal envelope.
 * The caller owns the key. A 96-bit IV is drawn from `crypto.randomBytes`
 * for each call — never reuse keys across predictable IVs.
 */
export function sealPayload(plaintext: string, key: Buffer): SealedArtifact {
  if (!(key instanceof Buffer) || key.length !== AES_KEY_LENGTH) {
    throw new Error(
      `Seal key must be a ${AES_KEY_LENGTH}-byte Buffer (AES-256 expects 256 bits)`,
    );
  }
  const iv = randomBytes(AES_IV_LENGTH);
  const cipher = createCipheriv(INTEGRITY_CIPHER_ALGORITHM, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  if (tag.length !== AES_TAG_LENGTH) {
    throw new Error("AES-GCM auth tag was not 128 bits; aborting seal.");
  }

  return {
    version: 1,
    algorithm: INTEGRITY_CIPHER_ALGORITHM,
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext: encrypted.toString("base64"),
    plaintextHash: hashString(plaintext),
  };
}

export function openSeal(seal: SealedArtifact, key: Buffer): string {
  if (seal.version !== 1) {
    throw new Error(`Unsupported seal version: ${String(seal.version)}`);
  }
  if (seal.algorithm !== INTEGRITY_CIPHER_ALGORITHM) {
    throw new Error(`Unsupported seal algorithm: ${String(seal.algorithm)}`);
  }
  if (!(key instanceof Buffer) || key.length !== AES_KEY_LENGTH) {
    throw new Error(`Seal key must be a ${AES_KEY_LENGTH}-byte Buffer`);
  }

  const iv = Buffer.from(seal.iv, "base64");
  const tag = Buffer.from(seal.tag, "base64");
  const ciphertext = Buffer.from(seal.ciphertext, "base64");
  if (iv.length !== AES_IV_LENGTH || tag.length !== AES_TAG_LENGTH) {
    throw new Error("Seal IV or tag has an unexpected length.");
  }

  const decipher = createDecipheriv(INTEGRITY_CIPHER_ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString("utf8");

  const observed = hashString(plaintext);
  if (!safeHexEqual(seal.plaintextHash, observed)) {
    throw new Error(
      "Decrypted plaintext hash does not match seal.plaintextHash (possible tampering).",
    );
  }

  return plaintext;
}

// Strict base64 / base64url validator for a 32-byte key. `Buffer.from(x,
// "base64")` is permissive in Node — it silently drops non-base64 characters
// rather than throwing — so we must validate the input format ourselves
// before decoding. 32 bytes of base64 is 44 characters including padding
// (or 43 without padding for base64url-style encoding).
const BASE64_32BYTE_PATTERN = /^(?:[A-Za-z0-9+/]{43}=|[A-Za-z0-9+/]{44}|[A-Za-z0-9_-]{43}=?|[A-Za-z0-9_-]{44})$/u;

/**
 * Load a 32-byte AES key from an environment variable. The variable must
 * contain a base64-encoded 256-bit key. Returns `null` when unset so callers
 * can degrade gracefully in environments without a key-management backend.
 *
 * The input is validated against a strict base64 pattern before decoding
 * because Node's `Buffer.from(x, "base64")` silently ignores non-base64
 * characters and never throws — accepting a malformed key would surface
 * only later as an opaque decryption or hash mismatch error.
 */
export function loadSealKeyFromEnv(envName: string): Buffer | null {
  const raw = process.env[envName];
  if (typeof raw !== "string" || raw.length === 0) {
    return null;
  }
  if (!BASE64_32BYTE_PATTERN.test(raw)) {
    throw new Error(
      `${envName} must be a base64 (or base64url) encoding of exactly 32 bytes.`,
    );
  }
  // Normalize base64url to standard base64 so Buffer.from decodes cleanly.
  const normalized = raw.replace(/-/g, "+").replace(/_/g, "/");
  const decoded = Buffer.from(normalized, "base64");
  if (decoded.length !== AES_KEY_LENGTH) {
    throw new Error(
      `${envName} decoded to ${decoded.length} bytes; expected ${AES_KEY_LENGTH}.`,
    );
  }
  return decoded;
}
