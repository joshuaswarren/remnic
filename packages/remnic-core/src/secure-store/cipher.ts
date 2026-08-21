/**
 * AES-256-GCM encrypt / decrypt primitives for the secure-store
 * module.
 *
 * Issue #690 (PR 1/4) — pure primitives, no I/O.
 *
 * Sealed envelope format
 * ----------------------
 * A "sealed" buffer is the canonical on-disk shape for a single
 * encrypted blob. It contains the salt used to derive the key from
 * the user's passphrase, so a caller who has the passphrase + the
 * sealed buffer can decrypt without any external metadata.
 *
 *   [VERSION:1][SALT:16][IV:12][AUTHTAG:16][CIPHERTEXT:...]
 *
 *   - VERSION (1 byte): envelope format version. Currently 1. Future
 *     versions can change the layout (e.g. variable salt length, an
 *     algorithm identifier byte) by bumping this byte.
 *   - SALT (16 bytes): KDF salt. Persisted with the ciphertext so the
 *     same passphrase can re-derive the key on read.
 *   - IV (12 bytes): GCM nonce. Must be unique per (key, ciphertext)
 *     pair. We generate it fresh from `randomBytes` on every encrypt
 *     call. Reusing an IV with the same key destroys GCM's
 *     confidentiality and authenticity guarantees.
 *   - AUTHTAG (16 bytes): GCM authentication tag. Tampering with any
 *     byte of (salt | iv | tag | ciphertext) causes decryption to
 *     fail with an auth-tag mismatch.
 *   - CIPHERTEXT (variable): the encrypted payload.
 *
 * The salt is stored alongside the ciphertext (rather than only in a
 * separate metadata file) so an individual encrypted blob is
 * self-contained for diagnostics and recovery. The metadata file
 * (see `metadata.ts`) records the *canonical* salt + KDF params for a
 * store; the per-blob salt is expected to match the metadata salt in
 * normal operation, but the format does not require it — a future PR
 * could rotate per-blob salts if desired.
 *
 * AAD support
 * -----------
 * Callers can pass associated authenticated data (AAD) — typically a
 * file path or namespace tag — that is authenticated but not
 * encrypted. AAD must be supplied identically on encrypt and decrypt;
 * a mismatch causes auth-tag failure. AAD is NOT serialized into the
 * envelope; the caller is responsible for re-supplying it on decrypt.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/** Current envelope format version. */
export const ENVELOPE_VERSION = 1 as const;

/** GCM nonce length. 96 bits is the NIST-recommended size for AES-GCM. */
export const IV_LENGTH = 12;

/** GCM authentication tag length. 16 bytes (128 bits) — the maximum. */
export const AUTH_TAG_LENGTH = 16;

/** Salt length carried in the envelope. Must match KDF_SALT_LENGTH. */
export const ENVELOPE_SALT_LENGTH = 16;

/** Required key length for AES-256. */
export const AES_KEY_LENGTH = 32;

/** Byte offsets of each envelope field (for clarity at call sites). */
export const ENVELOPE_LAYOUT = Object.freeze({
  version: 0,
  salt: 1,
  iv: 1 + ENVELOPE_SALT_LENGTH,
  authTag: 1 + ENVELOPE_SALT_LENGTH + IV_LENGTH,
  ciphertext: 1 + ENVELOPE_SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH,
});

/** Minimum envelope size: header + zero-length ciphertext. */
export const ENVELOPE_HEADER_SIZE = ENVELOPE_LAYOUT.ciphertext;

export interface EncryptOptions {
  /**
   * Optional associated data — authenticated but not encrypted.
   * Caller must supply the same value on decrypt.
   */
  aad?: Uint8Array;
  /**
   * Override the per-call IV. Strongly discouraged outside of tests:
   * GCM is catastrophically broken if an IV is reused under the same
   * key. Production callers should always let the cipher generate a
   * fresh random IV.
   */
  iv?: Uint8Array;
}

export interface DecryptOptions {
  /** Same AAD that was supplied to `encrypt`. */
  aad?: Uint8Array;
}

/**
 * Validate that a key is a 32-byte buffer suitable for AES-256.
 */
function assertAesKey(key: Uint8Array): void {
  if (!(key instanceof Uint8Array)) {
    throw new Error("key must be a Uint8Array");
  }
  if (key.length !== AES_KEY_LENGTH) {
    throw new Error(
      `AES-256-GCM requires a ${AES_KEY_LENGTH}-byte key, got ${key.length}`,
    );
  }
}

/**
 * Encrypt `plaintext` under `key` and return a sealed envelope buffer.
 *
 * @param key 32-byte AES-256 key (from `deriveKey`).
 * @param salt 16-byte KDF salt to embed in the envelope. The caller is
 *   responsible for using the same salt that was passed to the KDF.
 * @param plaintext the bytes to encrypt.
 * @param options optional `aad` / `iv` overrides.
 */
export function seal(
  key: Uint8Array,
  salt: Uint8Array,
  plaintext: Uint8Array,
  options: EncryptOptions = {},
): Buffer {
  assertAesKey(key);
  if (!(salt instanceof Uint8Array) || salt.length !== ENVELOPE_SALT_LENGTH) {
    throw new Error(
      `salt must be ${ENVELOPE_SALT_LENGTH} bytes, got ${salt?.length ?? "non-buffer"}`,
    );
  }
  if (!(plaintext instanceof Uint8Array)) {
    throw new Error("plaintext must be a Uint8Array");
  }
  let iv: Uint8Array;
  if (options.iv) {
    if (options.iv.length !== IV_LENGTH) {
      throw new Error(`iv must be ${IV_LENGTH} bytes, got ${options.iv.length}`);
    }
    iv = options.iv;
  } else {
    iv = randomBytes(IV_LENGTH);
  }

  const cipher = createCipheriv("aes-256-gcm", Buffer.from(key), Buffer.from(iv), {
    authTagLength: AUTH_TAG_LENGTH,
  });
  // Codex P1: bind the envelope header (version + salt) into AAD so
  // flipping the salt or version on a sealed envelope triggers an
  // auth failure on open. Without this, callers using a metadata-
  // derived store key would still decrypt successfully even after
  // the per-blob salt was tampered with — silently desynchronizing
  // per-blob salt from metadata/recovery logic. Caller-supplied AAD
  // is appended after the header so existing AAD usage stays intact.
  const headerAad = buildHeaderAad(salt);
  const finalAad = options.aad
    ? Buffer.concat([headerAad, Buffer.from(options.aad)])
    : headerAad;
  cipher.setAAD(finalAad);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(plaintext)), cipher.final()]);
  const authTag = cipher.getAuthTag();
  if (authTag.length !== AUTH_TAG_LENGTH) {
    // Defensive: Node always produces 16 bytes when authTagLength is 16.
    throw new Error(`unexpected auth tag length: ${authTag.length}`);
  }

  const envelope = Buffer.alloc(ENVELOPE_HEADER_SIZE + ciphertext.length);
  envelope.writeUInt8(ENVELOPE_VERSION, ENVELOPE_LAYOUT.version);
  Buffer.from(salt).copy(envelope, ENVELOPE_LAYOUT.salt);
  Buffer.from(iv).copy(envelope, ENVELOPE_LAYOUT.iv);
  authTag.copy(envelope, ENVELOPE_LAYOUT.authTag);
  ciphertext.copy(envelope, ENVELOPE_LAYOUT.ciphertext);
  return envelope;
}

/** Parsed view of a sealed envelope. Useful for inspection in tests. */
export interface ParsedEnvelope {
  version: number;
  salt: Buffer;
  iv: Buffer;
  authTag: Buffer;
  ciphertext: Buffer;
}

/**
 * Parse a sealed envelope into its component fields without
 * decrypting. Throws on malformed input. The returned buffers are
 * sub-views (not copies) — do not mutate.
 */
export function parseEnvelope(envelope: Uint8Array): ParsedEnvelope {
  if (!(envelope instanceof Uint8Array)) {
    throw new Error("envelope must be a Uint8Array");
  }
  if (envelope.length < ENVELOPE_HEADER_SIZE) {
    throw new Error(
      `envelope too short: need ≥ ${ENVELOPE_HEADER_SIZE} bytes, got ${envelope.length}`,
    );
  }
  const buf = Buffer.from(envelope.buffer, envelope.byteOffset, envelope.byteLength);
  const version = buf.readUInt8(ENVELOPE_LAYOUT.version);
  if (version !== ENVELOPE_VERSION) {
    throw new Error(
      `unsupported envelope version: ${version} (this build supports ${ENVELOPE_VERSION})`,
    );
  }
  return {
    version,
    salt: buf.subarray(ENVELOPE_LAYOUT.salt, ENVELOPE_LAYOUT.salt + ENVELOPE_SALT_LENGTH),
    iv: buf.subarray(ENVELOPE_LAYOUT.iv, ENVELOPE_LAYOUT.iv + IV_LENGTH),
    authTag: buf.subarray(
      ENVELOPE_LAYOUT.authTag,
      ENVELOPE_LAYOUT.authTag + AUTH_TAG_LENGTH,
    ),
    ciphertext: buf.subarray(ENVELOPE_LAYOUT.ciphertext),
  };
}

/**
 * Decrypt a sealed envelope and return the plaintext.
 *
 * Throws on:
 *   - malformed envelope (wrong length, wrong version);
 *   - wrong key (auth-tag mismatch);
 *   - tampered ciphertext / iv / auth tag (auth-tag mismatch);
 *   - mismatched AAD (auth-tag mismatch).
 *
 * The same error class is intentional: from the caller's standpoint
 * "wrong passphrase" and "tampered ciphertext" should both be
 * non-recoverable failures.
 */
export function open(
  key: Uint8Array,
  envelope: Uint8Array,
  options: DecryptOptions = {},
): Buffer {
  assertAesKey(key);
  const parsed = parseEnvelope(envelope);
  const decipher = createDecipheriv("aes-256-gcm", Buffer.from(key), parsed.iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  decipher.setAuthTag(parsed.authTag);
  // Codex P1: header (version + salt) is bound at seal time.
  // Reconstruct it identically so a tampered salt fails auth.
  const headerAad = buildHeaderAad(parsed.salt);
  const finalAad = options.aad
    ? Buffer.concat([headerAad, Buffer.from(options.aad)])
    : headerAad;
  decipher.setAAD(finalAad);
  // `final()` throws if the auth tag doesn't validate.
  return Buffer.concat([decipher.update(parsed.ciphertext), decipher.final()]);
}

/**
 * Build the canonical header AAD: a single byte version followed by
 * the per-blob salt. Binds the immutable envelope header into AES-GCM
 * authentication so tampering with either value triggers auth failure
 * on open (codex P1 on PR #718).
 */
function buildHeaderAad(salt: Uint8Array): Buffer {
  const out = Buffer.alloc(1 + ENVELOPE_SALT_LENGTH);
  out.writeUInt8(ENVELOPE_VERSION, 0);
  Buffer.from(salt).copy(out, 1);
  return out;
}

/**
 * Generate a fresh random salt of the canonical envelope length.
 * Convenience wrapper so callers don't reach into `node:crypto`.
 */
export function generateSalt(): Buffer {
  return randomBytes(ENVELOPE_SALT_LENGTH);
}
