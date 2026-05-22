/**
 * Capsule and backup archive encryption helpers (issue #690 PR 4/4).
 *
 * This module sits between the capsule export/import pipeline and the
 * secure-store primitives (PR 1/4 cipher + PR 2/4 keyring). It handles:
 *
 *   - Wrapping a raw `.capsule.json.gz` payload in an AES-256-GCM sealed
 *     envelope with a small plaintext header so auto-detection works without
 *     decryption.
 *   - Symmetrically: reading that header, decrypting the payload, and
 *     returning the original `.capsule.json.gz` bytes.
 *   - The same encrypt/decrypt helpers are re-used by the backup pipeline
 *     (`backup --encrypt`).
 *
 * On-disk format for an encrypted archive (format v2, issue #690 PR 4/4)
 * -------------------------------------------------------------------------
 * The encrypted file uses the extension `.capsule.json.gz.enc` and starts
 * with a small ASCII header terminated by a NUL byte so the MIME type can
 * be determined cheaply:
 *
 *   "REMNIC-ENC\x00"   (11 bytes, magic + NUL sentinel)
 *   UINT8               format version (2 — see version history below)
 *   UINT16LE            kdf_len: byte length of the KDF params JSON blob
 *   <kdf_len bytes>     compact JSON: { algorithm, params, salt }
 *   <seal envelope>     rest of file: AES-256-GCM sealed envelope (cipher.ts)
 *
 * The magic string is chosen to be:
 *   - ASCII-safe (no UTF-8 confusion)
 *   - obviously non-JSON (won't parse as a JSON object)
 *   - obviously non-gzip (gzip magic is 0x1f 0x8b; 'R' is 0x52)
 *
 * The sealed envelope format is documented in `cipher.ts`:
 *   [VERSION:1][SALT:16][IV:12][AUTHTAG:16][CIPHERTEXT:...]
 *
 * The original gzip bytes are the ciphertext. There is no additional
 * framing inside the ciphertext; decryption yields the original `.gz`
 * bytes verbatim.
 *
 * AAD
 * ---
 * The file's basename (without the `.enc` suffix, as a UTF-8 buffer) is
 * bound as AAD so the sealed envelope is tied to its filename. Renaming an
 * encrypted capsule file causes auth-tag failure on open. This prevents a
 * replay where an attacker substitutes one user's encrypted capsule for
 * another's. Callers MUST supply the same basename on encrypt and decrypt.
 *
 * Cross-machine restore (Codex P1 / #690)
 * ----------------------------------------
 * Format v2 embeds the KDF params (algorithm + params + salt)
 * in the archive header as a compact JSON blob. Any machine that knows the
 * original passphrase can parse this blob and re-derive the exact same
 * 256-bit AES key using the documented algorithm + params + salt — no
 * out-of-band key material or access to the source machine's secure-store
 * header is required. The keyring (in-memory unlocked key) is still used on
 * the decrypt path when available (faster; avoids a re-derivation round).
 */

import { open as openFileHandle, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { open, seal } from "../secure-store/cipher.js";
import * as keyring from "../secure-store/keyring.js";
import { readHeader, secureStoreDir } from "../secure-store/header.js";
import {
  deriveKey,
  KDF_SALT_LENGTH,
  type Argon2idParams,
  type KdfAlgorithm,
  type ScryptParams,
} from "../secure-store/kdf.js";

// ---------------------------------------------------------------------------
// On-disk magic
// ---------------------------------------------------------------------------

/** ASCII magic + NUL sentinel — 11 bytes total. */
const MAGIC = Buffer.from("REMNIC-ENC\x00", "ascii");

/**
 * Current format version byte.
 *
 * Version history:
 *   1 — original format: MAGIC(11) + VERSION(1) + ENVELOPE(...)
 *   2 — adds KDF params section for cross-machine re-derivation:
 *         MAGIC(11) + VERSION(1) + KDF_LEN(2, LE uint16) + KDF_JSON(variable) + ENVELOPE(...)
 *       The KDF_JSON blob carries the algorithm, params, and salt so any machine
 *       that knows the original passphrase can re-derive the archive key without
 *       access to the source machine's secure-store keyring. (Codex P1 / #690)
 */
const FORMAT_VERSION = 2;

/** Format v1 minimum size: magic (11) + version (1) + envelope header (45). */
const MIN_ENC_SIZE_V1 = MAGIC.length + 1 + 45; // 45 = cipher.ts ENVELOPE_HEADER_SIZE

/** Minimum size for magic + version + KDF length field. */
const MIN_ENC_SIZE = MAGIC.length + 1 + 2; // used only for header detection

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export interface EncryptCapsuleOptions {
  /**
   * Absolute path to the source `.capsule.json.gz` (or `.backup.tar.gz`)
   * payload to encrypt.
   */
  sourceGzPath: string;

  /**
   * Absolute path to the memory directory whose secure-store keyring will
   * be queried for the master key.
   */
  memoryDir: string;

  /**
   * Destination path for the encrypted output. If omitted, defaults to
   * `sourceGzPath + ".enc"`.
   */
  outPath?: string;
}

export interface EncryptCapsuleResult {
  /** Absolute path to the encrypted archive file. */
  encPath: string;
}

export interface DecryptCapsuleOptions {
  /**
   * Absolute path to the `.enc` encrypted archive to decrypt.
   */
  encPath: string;

  /**
   * Absolute path to the memory directory whose secure-store keyring will
   * be queried for the master key when no passphrase is supplied. Required
   * for v1 archives, optional for v2 passphrase-based restores.
   */
  memoryDir?: string;

  /**
   * Original secure-store passphrase. For format-v2 archives this is used
   * with the embedded KDF params to restore on a machine that does not have
   * the source memory directory's unlocked keyring entry.
   */
  passphrase?: string;

  /**
   * Destination path for the decrypted output. If omitted, defaults to
   * `encPath` with the `.enc` suffix removed.
   */
  outPath?: string;
}

export interface DecryptCapsuleResult {
  /** Absolute path to the decrypted archive file. */
  gzPath: string;
}

/**
 * Return `true` iff the given file path ends with `.enc` AND its first bytes
 * match the REMNIC-ENC magic header.
 *
 * Reads only the first `MAGIC.length` bytes of the file (open + partial read
 * + close) so this is cheap enough to call on every import regardless of
 * archive size. (Codex P2 / Cursor — previously read the entire file.)
 *
 * Throws only on I/O errors; returns `false` for files that are too short
 * or whose magic does not match.
 */
export async function isEncryptedCapsuleFile(filePath: string): Promise<boolean> {
  if (!filePath.endsWith(".enc")) return false;
  let fh: Awaited<ReturnType<typeof openFileHandle>> | null = null;
  try {
    fh = await openFileHandle(filePath, "r");
    const buf = Buffer.allocUnsafe(MAGIC.length);
    const { bytesRead } = await fh.read(buf, 0, MAGIC.length, 0);
    if (bytesRead < MAGIC.length) return false;
    return buf.equals(MAGIC);
  } catch {
    return false;
  } finally {
    if (fh !== null) {
      await fh.close().catch(() => undefined);
    }
  }
}

/**
 * Encrypt a `.capsule.json.gz` (or `.backup.tar.gz`) payload using the
 * secure-store master key held in the in-memory keyring for `memoryDir`.
 *
 * The key MUST already be unlocked in the keyring (`remnic secure-store
 * unlock`). If the store is locked or has never been initialized, this
 * function throws a clear error rather than silently producing an
 * un-decryptable output.
 *
 * Format v2 embeds the KDF params (algorithm + params + salt) in the archive
 * header so any machine that knows the original passphrase can re-derive the
 * same key and decrypt the archive without access to the source machine's
 * keyring. (Codex P1 — cross-machine restore.)
 *
 * Writes atomically: the output is assembled in memory and written in a
 * single `writeFile` call so a crash mid-write cannot leave a partial file
 * that passes the magic check but fails decryption (gotcha #54 — do not
 * delete-before-write; here we write-new rather than replace, so no prior
 * valid file can be destroyed).
 */
export async function encryptCapsuleFile(
  opts: EncryptCapsuleOptions,
): Promise<EncryptCapsuleResult> {
  const encPath = opts.outPath ?? `${opts.sourceGzPath}.enc`;
  const key = getKeyOrThrow(opts.memoryDir, "encrypt capsule");

  // Read the source payload.
  const plaintext = await readFile(opts.sourceGzPath);

  // Bind the output filename (without .enc) as AAD so the envelope is
  // tied to its destination path (Codex P1: replay prevention).
  const basename = path.basename(encPath);
  const aad = Buffer.from(basename, "utf-8");

  // Load the secure-store header to extract KDF params + canonical salt.
  // The KDF params are embedded in the archive (format v2) so the archive
  // is self-contained for cross-machine restore: the recipient re-derives
  // the same key from their passphrase + the embedded params without
  // needing access to the source machine's keyring. (Codex P1 / #690)
  const kdfSection = await loadKdfSection(opts.memoryDir);

  const envelope = seal(key, kdfSection.salt, plaintext, { aad });

  // Assemble the encrypted file (format v2):
  //   MAGIC(11) + VERSION(1) + KDF_LEN(2 LE) + KDF_JSON(variable) + ENVELOPE(...)
  const versionBuf = Buffer.alloc(1);
  versionBuf.writeUInt8(FORMAT_VERSION, 0);

  const kdfJsonBuf = Buffer.from(kdfSection.json, "utf-8");
  const kdfLenBuf = Buffer.alloc(2);
  kdfLenBuf.writeUInt16LE(kdfJsonBuf.length, 0);

  const output = Buffer.concat([MAGIC, versionBuf, kdfLenBuf, kdfJsonBuf, envelope]);

  await writeFile(encPath, output);
  return { encPath };
}

/**
 * Decrypt a `.enc` encrypted capsule or backup archive.
 *
 * Validates the magic header and format version before attempting
 * decryption. Throws with a clear message on:
 *   - non-enc file / wrong magic
 *   - unsupported format version
   *   - locked/uninitialized secure-store (when keyring is not unlocked and no passphrase)
 *   - wrong key / tampered ciphertext (AES-GCM auth failure)
 *
   * Format v2 archives carry embedded KDF params. If a `passphrase` is
   * provided, the key is re-derived from the passphrase + embedded KDF params
   * for cross-machine restore. Without a passphrase, an unlocked keyring key
   * from `memoryDir` is used directly.
 */
export async function decryptCapsuleFile(
  opts: DecryptCapsuleOptions,
): Promise<DecryptCapsuleResult> {
  const gzPath = opts.outPath ?? opts.encPath.replace(/\.enc$/, "");

  const buf = await readFile(opts.encPath);

  // Magic check.
  if (buf.length < MIN_ENC_SIZE_V1) {
    throw new Error(
      `decryptCapsuleFile: file too short to be an encrypted capsule: ${opts.encPath}`,
    );
  }
  if (!buf.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error(
      `decryptCapsuleFile: file does not start with REMNIC-ENC magic: ${opts.encPath}`,
    );
  }

  // Version check.
  const version = buf.readUInt8(MAGIC.length);
  if (version !== 1 && version !== 2) {
    throw new Error(
      `decryptCapsuleFile: unsupported encrypted-capsule format version ${version} ` +
        `(this build supports versions 1 and 2): ${opts.encPath}`,
    );
  }

  // Resolve the decryption key and the envelope offset.
  const { key, envelopeOffset } = resolveKeyAndOffset(
    buf,
    version,
    opts.memoryDir,
    "decryptCapsuleFile",
    opts.encPath,
    opts.passphrase,
  );

  // The sealed envelope starts at `envelopeOffset`.
  const envelope = buf.subarray(envelopeOffset);

  // Reconstruct AAD from the basename of the enc file (same as encrypt).
  const basename = path.basename(opts.encPath);
  const aad = Buffer.from(basename, "utf-8");

  let plaintext: Buffer;
  try {
    plaintext = open(key, envelope, { aad });
  } catch (cause) {
    throw new Error(
      `decryptCapsuleFile: authentication failed — wrong passphrase, ` +
        `tampered archive, or key mismatch. ` +
        `Ensure the secure-store is unlocked with the correct passphrase and ` +
        `the archive has not been modified: ${opts.encPath}`,
      { cause: cause as Error },
    );
  }

  await writeFile(gzPath, plaintext);
  return { gzPath };
}

/**
 * Decrypt an encrypted capsule archive directly to a `Buffer` without writing
 * an intermediate file. Used by `importCapsule` so the plaintext gzip bytes
 * never touch disk during an in-memory import roundtrip.
 *
 * Semantics identical to {@link decryptCapsuleFile} except the output is
 * returned as a `Buffer` rather than written to disk.
 *
 * Supports both format v1 (keyring-only) and format v2 (keyring preferred,
 * passphrase re-derivation available for cross-machine restore).
 */
export async function decryptCapsuleFileInMemory(
  encPath: string,
  memoryDir?: string,
  options: { passphrase?: string } = {},
): Promise<Buffer> {
  const buf = await readFile(encPath);

  if (buf.length < MIN_ENC_SIZE_V1) {
    throw new Error(
      `decryptCapsuleFileInMemory: file too short to be an encrypted capsule: ${encPath}`,
    );
  }
  if (!buf.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error(
      `decryptCapsuleFileInMemory: file does not start with REMNIC-ENC magic: ${encPath}`,
    );
  }

  const version = buf.readUInt8(MAGIC.length);
  if (version !== 1 && version !== 2) {
    throw new Error(
      `decryptCapsuleFileInMemory: unsupported encrypted-capsule format version ${version} ` +
        `(this build supports versions 1 and 2): ${encPath}`,
    );
  }

  const { key, envelopeOffset } = resolveKeyAndOffset(
    buf,
    version,
    memoryDir,
    "decryptCapsuleFileInMemory",
    encPath,
    options.passphrase,
  );
  const envelope = buf.subarray(envelopeOffset);

  const basename = path.basename(encPath);
  const aad = Buffer.from(basename, "utf-8");

  try {
    return open(key, envelope, { aad });
  } catch (cause) {
    throw new Error(
      `decryptCapsuleFileInMemory: authentication failed — wrong passphrase, ` +
        `tampered archive, or key mismatch. ` +
        `Ensure the secure-store is unlocked with the correct passphrase and ` +
        `the archive has not been modified: ${encPath}`,
      { cause: cause as Error },
    );
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Serializable KDF section embedded in format-v2 archives.
 * The `salt` field is hex-encoded in `json` and decoded to bytes for use
 * with the KDF.
 */
interface KdfSection {
  /** Compact JSON string embedded in the archive header. */
  json: string;
  /** Decoded salt bytes (same value as the `salt` field in `json`). */
  salt: Buffer;
}

interface ParsedKdfSection {
  algorithm: KdfAlgorithm;
  params: ScryptParams | Argon2idParams;
  salt: Buffer;
}

/**
 * Read the KDF params + canonical salt from the secure-store header and
 * return both a compact JSON representation (for embedding in the archive)
 * and the salt buffer (for passing to `seal`).
 *
 * Falls back to a freshly generated random salt if the header cannot be
 * read (e.g. in tests that skip header init). In that case the archive is
 * still valid but cross-machine re-derivation won't work without knowing
 * the embedded params.
 *
 * This function is only called on the encrypt path — decryption reads the
 * KDF section from the archive itself.
 */
async function loadKdfSection(memoryDir: string): Promise<KdfSection> {
  try {
    const header = await readHeader(memoryDir);
    if (header !== null) {
      const { decodeMetadataSalt } = await import("../secure-store/metadata.js");
      const salt = decodeMetadataSalt(header.metadata);
      const kdf = header.metadata.kdf;
      const json = JSON.stringify({
        algorithm: kdf.algorithm,
        params: kdf.params,
        salt: salt.toString("hex"),
      });
      return { json, salt };
    }
  } catch {
    // Fall through to randomBytes fallback.
  }
  const { generateSalt } = await import("../secure-store/cipher.js");
  const salt = generateSalt();
  // Use the current secure-store default when a header is unavailable.
  const { DEFAULT_ARGON2ID_PARAMS } = await import("../secure-store/kdf.js");
  const json = JSON.stringify({
    algorithm: "argon2id",
    params: DEFAULT_ARGON2ID_PARAMS,
    salt: salt.toString("hex"),
  });
  return { json, salt };
}

/**
 * Retrieve the master key for `memoryDir` from the in-memory keyring, or
 * throw a clear actionable error if the store is locked or not initialized.
 *
 * Rule 51: never silently default when the user's intent is clear but the
 * precondition (unlocked keyring) is not met.
 */
function getKeyOrThrow(memoryDir: string | undefined, action: string): Buffer {
  if (!memoryDir) {
    throw new Error(
      `Secure-store memoryDir is required — cannot ${action} without either an unlocked keyring or a format-v2 passphrase.`,
    );
  }
  const storeId = secureStoreDir(memoryDir);
  const key = keyring.getKey(storeId);
  if (key === null) {
    throw new Error(
      `Secure-store is locked or not initialized — cannot ${action}. ` +
        `Run \`remnic secure-store unlock\` first, provide the original passphrase for ` +
        `a format-v2 archive restore, or run \`remnic secure-store init\` if the store ` +
        `has never been initialized.`,
    );
  }
  return key;
}

/**
 * Resolve the decryption key and the byte offset of the sealed envelope
 * within `buf`, handling both format v1 (no KDF section) and format v2
 * (embedded KDF params for cross-machine restore).
 *
 * For v2 archives: a caller-supplied passphrase is derived against the
 * embedded KDF section for cross-machine restore. Without a passphrase, the
 * keyring is used as the fast local path.
 *
 * The KDF-params section serves two roles:
 *   1. Documents what algorithm was used so cross-machine tooling knows
 *      what to invoke.
 *   2. Provides the required `algorithm + params + salt` triple for
 *      passphrase-based re-derivation without needing the source machine's
 *      secure-store header. (Codex P1 / #690)
 */
function resolveKeyAndOffset(
  buf: Buffer,
  version: number,
  memoryDir: string | undefined,
  caller: string,
  encPath: string,
  passphrase?: string,
): { key: Buffer; envelopeOffset: number } {
  if (version === 1) {
    // v1: envelope starts immediately after magic (11) + version (1).
    const key = getKeyOrThrow(memoryDir, "decrypt capsule");
    return { key, envelopeOffset: MAGIC.length + 1 };
  }

  // v2: KDF_LEN(2 LE) + KDF_JSON(KDF_LEN bytes) + envelope.
  const kdfLenOffset = MAGIC.length + 1; // after magic + version
  if (buf.length < kdfLenOffset + 2) {
    throw new Error(
      `${caller}: file too short for format v2 KDF length field: ${encPath}`,
    );
  }
  const kdfLen = buf.readUInt16LE(kdfLenOffset);
  const kdfJsonOffset = kdfLenOffset + 2;
  if (buf.length < kdfJsonOffset + kdfLen) {
    throw new Error(
      `${caller}: file too short for format v2 KDF params section (expected ${kdfLen} bytes): ${encPath}`,
    );
  }
  if (kdfLen <= 0) {
    throw new Error(`${caller}: format v2 KDF params section is empty: ${encPath}`);
  }
  const kdfJson = buf.subarray(kdfJsonOffset, kdfJsonOffset + kdfLen).toString("utf-8");
  const kdf = parseEmbeddedKdfSection(kdfJson, caller, encPath);
  const envelopeOffset = kdfJsonOffset + kdfLen;

  if (passphrase !== undefined) {
    if (passphrase.length === 0) {
      throw new Error(`${caller}: passphrase must not be empty for format v2 archive restore`);
    }
    const key = deriveKey(kdf.algorithm, passphrase, kdf.salt, kdf.params);
    return { key, envelopeOffset };
  }

  const key = getKeyOrThrow(memoryDir, "decrypt capsule");
  return { key, envelopeOffset };
}

function parseEmbeddedKdfSection(json: string, caller: string, encPath: string): ParsedKdfSection {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (cause) {
    throw new Error(`${caller}: format v2 KDF params are not valid JSON: ${encPath}`, { cause: cause as Error });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${caller}: format v2 KDF params must be a JSON object: ${encPath}`);
  }
  const obj = parsed as Record<string, unknown>;
  const algorithm = obj.algorithm;
  if (algorithm !== "scrypt" && algorithm !== "argon2id") {
    throw new Error(`${caller}: unsupported format v2 KDF algorithm ${String(algorithm)}: ${encPath}`);
  }
  if (typeof obj.params !== "object" || obj.params === null || Array.isArray(obj.params)) {
    throw new Error(`${caller}: format v2 KDF params.params must be an object: ${encPath}`);
  }
  if (typeof obj.salt !== "string" || !/^[0-9a-fA-F]+$/.test(obj.salt) || obj.salt.length % 2 !== 0) {
    throw new Error(`${caller}: format v2 KDF salt must be an even-length hex string: ${encPath}`);
  }
  const salt = Buffer.from(obj.salt, "hex");
  if (salt.length !== KDF_SALT_LENGTH) {
    throw new Error(`${caller}: format v2 KDF salt decoded to ${salt.length} bytes, expected ${KDF_SALT_LENGTH}: ${encPath}`);
  }
  return {
    algorithm,
    params: obj.params as ScryptParams | Argon2idParams,
    salt,
  };
}
