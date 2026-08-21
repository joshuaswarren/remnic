/**
 * Secure-store metadata file format.
 *
 * Issue #690 (PR 1/4) — pure data structure + serialize/parse helpers.
 * No I/O. The eventual `secure-store init` CLI (PR 2/4) will be the
 * surface that actually writes a metadata file to disk.
 *
 * Purpose
 * -------
 * When at-rest encryption is enabled, the memory directory needs a
 * stable record of:
 *
 *   - which KDF algorithm was used to derive the master key,
 *   - the algorithm parameters (so changing OWASP defaults later
 *     doesn't break existing stores),
 *   - the canonical salt for the master key,
 *   - the metadata format version (so we can evolve the file).
 *
 * Crucially, the metadata file does **not** contain the master key,
 * the passphrase, or anything that would let an attacker decrypt
 * memories. It contains only the public parameters needed to
 * re-derive the same key from the same passphrase.
 *
 * On-disk shape
 * -------------
 * The file is JSON. All binary fields are encoded as lowercase hex
 * strings (chosen over base64 for readability when the file is
 * `cat`'d during incident response).
 *
 *   {
 *     "format": "remnic.secure-store.metadata",
 *     "formatVersion": 1,
 *     "kdf": {
 *       "algorithm": "argon2id",
 *       "params": { "memoryKiB": 65536, "iterations": 3, "parallelism": 4, "keyLength": 32 },
 *       "salt": "<32-hex-chars-for-16-bytes>"
 *     },
 *     "createdAt": "<ISO-8601 timestamp>",
 *     "note": "<optional human-readable note>"
 *   }
 */

import {
  DEFAULT_ARGON2ID_PARAMS,
  DEFAULT_SCRYPT_PARAMS,
  KDF_SALT_LENGTH,
  type Argon2idParams,
  type KdfAlgorithm,
  type ScryptParams,
} from "./kdf.js";

/** Stable identifier so we can sniff the file shape without parsing JSON. */
export const METADATA_FORMAT = "remnic.secure-store.metadata" as const;

/** Current metadata format version. Bump on breaking schema changes. */
export const METADATA_FORMAT_VERSION = 1 as const;

export interface SecureStoreMetadataKdfScrypt {
  algorithm: "scrypt";
  params: ScryptParams;
  /** Hex-encoded salt. Length must match `KDF_SALT_LENGTH` after decode. */
  salt: string;
}

export interface SecureStoreMetadataKdfArgon2id {
  algorithm: "argon2id";
  params: Argon2idParams;
  salt: string;
}

export type SecureStoreMetadataKdf =
  | SecureStoreMetadataKdfScrypt
  | SecureStoreMetadataKdfArgon2id;

export interface SecureStoreMetadata {
  format: typeof METADATA_FORMAT;
  formatVersion: number;
  kdf: SecureStoreMetadataKdf;
  /** ISO-8601 timestamp recorded at init time. */
  createdAt: string;
  /** Optional human-readable note. Never persist secrets here. */
  note?: string;
}

function bytesToHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

function hexToBytes(hex: string, expectedLength: number): Buffer {
  if (typeof hex !== "string") {
    throw new Error("hex field must be a string");
  }
  if (!/^[0-9a-f]*$/i.test(hex)) {
    throw new Error("hex field must contain only hexadecimal characters");
  }
  if (hex.length % 2 !== 0) {
    throw new Error("hex field must have even length");
  }
  const buf = Buffer.from(hex, "hex");
  if (buf.length !== expectedLength) {
    throw new Error(
      `hex field decoded to ${buf.length} bytes, expected ${expectedLength}`,
    );
  }
  return buf;
}

export interface BuildMetadataOptions {
  algorithm: KdfAlgorithm;
  salt: Uint8Array;
  /** Optional override; defaults to `DEFAULT_SCRYPT_PARAMS` / `DEFAULT_ARGON2ID_PARAMS`. */
  params?: ScryptParams | Argon2idParams;
  /** Optional ISO timestamp. Defaults to `new Date().toISOString()`. */
  createdAt?: string;
  /** Optional human-readable note. */
  note?: string;
}

/**
 * Build an in-memory `SecureStoreMetadata` object from the given
 * algorithm + salt. Pure: does not touch the filesystem or the clock
 * unless `createdAt` is omitted (in which case `new Date()` is read).
 */
export function buildMetadata(options: BuildMetadataOptions): SecureStoreMetadata {
  const { algorithm, salt } = options;
  if (!(salt instanceof Uint8Array) || salt.length !== KDF_SALT_LENGTH) {
    throw new Error(
      `salt must be ${KDF_SALT_LENGTH} bytes, got ${salt?.length ?? "non-buffer"}`,
    );
  }
  const createdAt = options.createdAt ?? new Date().toISOString();

  let kdf: SecureStoreMetadataKdf;
  if (algorithm === "scrypt") {
    const params = (options.params as ScryptParams | undefined) ?? {
      ...DEFAULT_SCRYPT_PARAMS,
    };
    kdf = { algorithm: "scrypt", params, salt: bytesToHex(salt) };
  } else if (algorithm === "argon2id") {
    const params = (options.params as Argon2idParams | undefined) ?? {
      ...DEFAULT_ARGON2ID_PARAMS,
    };
    kdf = { algorithm: "argon2id", params, salt: bytesToHex(salt) };
  } else {
    throw new Error(`unknown KDF algorithm: ${algorithm as string}`);
  }

  const meta: SecureStoreMetadata = {
    format: METADATA_FORMAT,
    formatVersion: METADATA_FORMAT_VERSION,
    kdf,
    createdAt,
  };
  if (options.note !== undefined) {
    meta.note = options.note;
  }
  return meta;
}

/**
 * Serialize metadata to a stable JSON string with sorted top-level
 * keys. Stable ordering matters because hash-based integrity checks
 * may eventually consume the serialized form.
 */
export function serializeMetadata(meta: SecureStoreMetadata): string {
  // Validate before serializing so we never write a malformed file.
  validateMetadata(meta);
  // JSON.stringify preserves insertion order; we construct the object
  // explicitly to lock the field order.
  const ordered: Record<string, unknown> = {
    format: meta.format,
    formatVersion: meta.formatVersion,
    kdf: orderKdf(meta.kdf),
    createdAt: meta.createdAt,
  };
  if (meta.note !== undefined) {
    ordered.note = meta.note;
  }
  return JSON.stringify(ordered, null, 2);
}

function orderKdf(kdf: SecureStoreMetadataKdf): Record<string, unknown> {
  if (kdf.algorithm === "scrypt") {
    return {
      algorithm: kdf.algorithm,
      params: {
        N: kdf.params.N,
        r: kdf.params.r,
        p: kdf.params.p,
        keyLength: kdf.params.keyLength,
        maxmem: kdf.params.maxmem,
      },
      salt: kdf.salt,
    };
  }
  return {
    algorithm: kdf.algorithm,
    params: {
      memoryKiB: kdf.params.memoryKiB,
      iterations: kdf.params.iterations,
      parallelism: kdf.params.parallelism,
      keyLength: kdf.params.keyLength,
    },
    salt: kdf.salt,
  };
}

/**
 * Parse a metadata JSON string. Throws on any structural problem.
 * Callers that need to migrate older formats should branch on
 * `formatVersion` *before* calling this; this function is strict
 * about the current version.
 */
export function parseMetadata(json: string): SecureStoreMetadata {
  if (typeof json !== "string") {
    throw new Error("metadata input must be a string");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`metadata is not valid JSON: ${msg}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("metadata must be a JSON object");
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.format !== METADATA_FORMAT) {
    throw new Error(
      `unexpected metadata format: ${String(obj.format)} (expected ${METADATA_FORMAT})`,
    );
  }
  if (obj.formatVersion !== METADATA_FORMAT_VERSION) {
    throw new Error(
      `unsupported metadata formatVersion: ${String(obj.formatVersion)} ` +
        `(this build supports ${METADATA_FORMAT_VERSION})`,
    );
  }
  if (typeof obj.createdAt !== "string" || obj.createdAt.length === 0) {
    throw new Error("metadata.createdAt must be a non-empty string");
  }
  if (obj.note !== undefined && typeof obj.note !== "string") {
    throw new Error("metadata.note must be a string when present");
  }
  const kdf = parseKdf(obj.kdf);
  const meta: SecureStoreMetadata = {
    format: METADATA_FORMAT,
    formatVersion: METADATA_FORMAT_VERSION,
    kdf,
    createdAt: obj.createdAt,
  };
  if (typeof obj.note === "string") {
    meta.note = obj.note;
  }
  validateMetadata(meta);
  return meta;
}

function parseKdf(value: unknown): SecureStoreMetadataKdf {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("metadata.kdf must be an object");
  }
  const k = value as Record<string, unknown>;
  if (k.algorithm !== "scrypt" && k.algorithm !== "argon2id") {
    throw new Error(`metadata.kdf.algorithm must be 'scrypt' or 'argon2id', got ${String(k.algorithm)}`);
  }
  if (typeof k.salt !== "string") {
    throw new Error("metadata.kdf.salt must be a hex string");
  }
  // Decode to validate length and hex shape; we don't need the bytes here.
  hexToBytes(k.salt, KDF_SALT_LENGTH);
  if (typeof k.params !== "object" || k.params === null || Array.isArray(k.params)) {
    throw new Error("metadata.kdf.params must be an object");
  }
  const params = k.params as Record<string, unknown>;
  if (k.algorithm === "scrypt") {
    const required: (keyof ScryptParams)[] = ["N", "r", "p", "keyLength", "maxmem"];
    for (const key of required) {
      if (typeof params[key] !== "number" || !Number.isFinite(params[key] as number)) {
        throw new Error(`metadata.kdf.params.${key} must be a finite number`);
      }
    }
    return {
      algorithm: "scrypt",
      params: {
        N: params.N as number,
        r: params.r as number,
        p: params.p as number,
        keyLength: params.keyLength as number,
        maxmem: params.maxmem as number,
      },
      salt: k.salt,
    };
  }
  // argon2id
  const required2: (keyof Argon2idParams)[] = [
    "memoryKiB",
    "iterations",
    "parallelism",
    "keyLength",
  ];
  for (const key of required2) {
    if (typeof params[key] !== "number" || !Number.isFinite(params[key] as number)) {
      throw new Error(`metadata.kdf.params.${key} must be a finite number`);
    }
  }
  return {
    algorithm: "argon2id",
    params: {
      memoryKiB: params.memoryKiB as number,
      iterations: params.iterations as number,
      parallelism: params.parallelism as number,
      keyLength: params.keyLength as number,
    },
    salt: k.salt,
  };
}

/** Validate a metadata object's invariants. Throws on the first problem. */
export function validateMetadata(meta: SecureStoreMetadata): void {
  if (meta.format !== METADATA_FORMAT) {
    throw new Error(`metadata.format must be ${METADATA_FORMAT}`);
  }
  if (meta.formatVersion !== METADATA_FORMAT_VERSION) {
    throw new Error(`metadata.formatVersion must be ${METADATA_FORMAT_VERSION}`);
  }
  if (typeof meta.createdAt !== "string" || meta.createdAt.length === 0) {
    throw new Error("metadata.createdAt must be a non-empty ISO-8601 string");
  }
  // Salt round-trip check.
  hexToBytes(meta.kdf.salt, KDF_SALT_LENGTH);
  if (meta.kdf.algorithm === "scrypt") {
    const { N, r, p, keyLength, maxmem } = meta.kdf.params;
    // Cursor Low + codex P2: bitwise `(N & (N - 1))` truncates to
    // 32-bit signed in JS, so for N >= 2**31 the check silently
    // wraps and accepts non-powers-of-two like `5 * 2**30`. Use
    // Math.log2 plus an upper bound at 2**30 so out-of-range
    // values are rejected loudly at metadata-load time rather than
    // locking up the KDF later.
    if (
      !Number.isInteger(N) ||
      N < 2 ||
      N > 2 ** 30 ||
      !Number.isInteger(Math.log2(N))
    ) {
      throw new Error("metadata.kdf.params.N must be a power of 2 in [2, 2^30]");
    }
    if (!Number.isInteger(r) || r < 1) {
      throw new Error("metadata.kdf.params.r must be a positive integer");
    }
    if (!Number.isInteger(p) || p < 1) {
      throw new Error("metadata.kdf.params.p must be a positive integer");
    }
    // Codex P2: cipher.ts hard-requires a 32-byte AES-256 key
    // (`assertAesKey`). Accepting `keyLength: 16` here would parse
    // and validate cleanly but later fail at encrypt/decrypt time
    // — a latent runtime break. Reject anything other than 32 at
    // load time so the metadata file is the authoritative gate.
    if (!Number.isInteger(keyLength) || keyLength !== 32) {
      throw new Error("metadata.kdf.params.keyLength must be 32 (AES-256 requires a 32-byte key)");
    }
    if (!Number.isInteger(maxmem) || maxmem < 1024) {
      throw new Error("metadata.kdf.params.maxmem must be a positive integer");
    }
  } else if (meta.kdf.algorithm === "argon2id") {
    const { memoryKiB, iterations, parallelism, keyLength } = meta.kdf.params;
    if (!Number.isInteger(memoryKiB) || memoryKiB < 8) {
      throw new Error("metadata.kdf.params.memoryKiB must be ≥ 8");
    }
    if (!Number.isInteger(iterations) || iterations < 1) {
      throw new Error("metadata.kdf.params.iterations must be a positive integer");
    }
    if (!Number.isInteger(parallelism) || parallelism < 1 || parallelism > 255) {
      throw new Error("metadata.kdf.params.parallelism must be an integer in [1, 255]");
    }
    // Codex P2: cipher.ts hard-requires a 32-byte AES-256 key
    // (`assertAesKey`). Accepting `keyLength: 16` here would parse
    // and validate cleanly but later fail at encrypt/decrypt time
    // — a latent runtime break. Reject anything other than 32 at
    // load time so the metadata file is the authoritative gate.
    if (!Number.isInteger(keyLength) || keyLength !== 32) {
      throw new Error("metadata.kdf.params.keyLength must be 32 (AES-256 requires a 32-byte key)");
    }
  }
}

/**
 * Decode the salt field of a metadata object back into bytes.
 * Convenience helper so callers don't reach into the hex codec.
 */
export function decodeMetadataSalt(meta: SecureStoreMetadata): Buffer {
  return hexToBytes(meta.kdf.salt, KDF_SALT_LENGTH);
}
