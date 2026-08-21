/**
 * Key-derivation functions for the secure-store module.
 *
 * Issue #690 (PR 1/4) — pure primitives, no I/O.
 *
 * Naming note
 * -----------
 * The directory is named `secure-store/` — NOT `vault/` — because
 * `vault` is already a content-source concept in `native-knowledge.ts`
 * (Obsidian vaults: `ObsidianVaultState`, `vaultId`, `obsidianVaults`
 * config, etc.). Reusing the `vault` namespace for at-rest encryption
 * would cause symbol collisions and reader confusion.
 *
 * KDF choice — Argon2id primary, scrypt compatibility
 * ---------------------------------------------------
 * Issue #690 specifies Argon2id (OWASP m=64 MiB, t=3, p=4) as the
 * preferred KDF. We use `@node-rs/argon2` for the Argon2id runtime
 * and keep scrypt as the compatibility path for stores initialized
 * before Argon2id support landed.
 *
 * The algorithm name + params are persisted in the metadata file, so
 * stores keep deriving with the same KDF they were initialized with.
 *
 * Trade-off summary:
 *   - scrypt N=2^17, r=8, p=1 → ~128 MiB memory, ~150 ms on a modern
 *     laptop. Memory-hard. Resists GPU/ASIC attacks meaningfully.
 *   - Argon2id m=64 MiB, t=3, p=4 → ~64 MiB memory, similar wall
 *     time. Considered the modern best-in-class but requires native
 *     bindings.
 *
 * Both produce a 32-byte key suitable for AES-256-GCM.
 */

import { scryptSync, timingSafeEqual } from "node:crypto";
import { createRequire } from "node:module";

type Argon2Runtime = typeof import("@node-rs/argon2");

const requireArgon2 = createRequire(import.meta.url);
let argon2Runtime: Argon2Runtime | undefined;

function loadArgon2Runtime(): Argon2Runtime {
  try {
    argon2Runtime ??= requireArgon2("@node-rs/argon2") as Argon2Runtime;
    return argon2Runtime;
  } catch (cause) {
    throw new Error(
      "Argon2id KDF requires @node-rs/argon2 to be installed and loadable on this platform. " +
        "Use scrypt compatibility mode for stores that must run without the Argon2 native binding.",
      { cause },
    );
  }
}

/** KDF algorithms supported by the secure-store metadata format. */
export type KdfAlgorithm = "scrypt" | "argon2id";

/** Parameters for the scrypt KDF (RFC 7914). */
export interface ScryptParams {
  /** CPU/memory cost. Must be a power of 2. Default 2^17 = 131072. */
  N: number;
  /** Block size. Default 8. */
  r: number;
  /** Parallelization. Default 1. */
  p: number;
  /** Output key length in bytes. Default 32 (AES-256). */
  keyLength: number;
  /** maxmem ceiling for scrypt; defaults to 256 MiB. */
  maxmem: number;
}

/** Parameters for the Argon2id KDF. */
export interface Argon2idParams {
  /** Memory cost in KiB. OWASP default 65536 (64 MiB). */
  memoryKiB: number;
  /** Time cost (iterations). OWASP default 3. */
  iterations: number;
  /** Parallelism. OWASP default 4. */
  parallelism: number;
  /** Output key length in bytes. Default 32 (AES-256). */
  keyLength: number;
}

/** Strong scrypt defaults (OWASP-acceptable for 2024+). */
export const DEFAULT_SCRYPT_PARAMS: Readonly<ScryptParams> = Object.freeze({
  // 2^17. Hex-coding the literal would obscure the doubling chain.
  N: 1 << 17,
  r: 8,
  p: 1,
  keyLength: 32,
  // 256 MiB ceiling — comfortably above the 128 MiB scrypt needs at N=2^17.
  maxmem: 256 * 1024 * 1024,
});

/** OWASP Argon2id defaults. */
export const DEFAULT_ARGON2ID_PARAMS: Readonly<Argon2idParams> = Object.freeze({
  memoryKiB: 64 * 1024,
  iterations: 3,
  parallelism: 4,
  keyLength: 32,
});

/** Salt length in bytes. 128 bits is the modern minimum. */
export const KDF_SALT_LENGTH = 16;

/** Required derived-key length for AES-256 (32 bytes). */
export const KDF_KEY_LENGTH = 32;

/**
 * Validate that scrypt parameters are within sane bounds and that
 * `N` is a power of 2 (required by RFC 7914).
 */
export function validateScryptParams(params: ScryptParams): void {
  const { N, r, p, keyLength, maxmem } = params;
  if (!Number.isInteger(N) || N < 2) {
    throw new Error(`scrypt N must be an integer ≥ 2, got ${N}`);
  }
  // Cursor Low + codex P2: a `(N & (N - 1)) !== 0` check truncates
  // to 32-bit semantics for `N >= 2**31`, so values like `5 * 2**30`
  // would pass even though they are not powers of two, and absurdly
  // large values like `2**33` would silently lock up the KDF. Use
  // Math.log2-based detection plus an explicit upper bound at 2**30
  // (already orders of magnitude past any practical memory budget)
  // so out-of-range or non-power-of-two values are rejected loudly.
  if (N > 2 ** 30) {
    throw new Error(`scrypt N is unreasonably large (max 2^30), got ${N}`);
  }
  if (!Number.isInteger(Math.log2(N))) {
    throw new Error(`scrypt N must be a power of 2, got ${N}`);
  }
  if (!Number.isInteger(r) || r < 1) {
    throw new Error(`scrypt r must be a positive integer, got ${r}`);
  }
  if (!Number.isInteger(p) || p < 1) {
    throw new Error(`scrypt p must be a positive integer, got ${p}`);
  }
  if (!Number.isInteger(keyLength) || keyLength < 16) {
    throw new Error(
      `scrypt keyLength must be ≥ 16 (need 32 for AES-256), got ${keyLength}`,
    );
  }
  if (!Number.isInteger(maxmem) || maxmem < 1024) {
    throw new Error(`scrypt maxmem must be a sane positive integer, got ${maxmem}`);
  }
}

/** Validate Argon2id parameters before invoking the native KDF binding. */
export function validateArgon2idParams(params: Argon2idParams): void {
  const { memoryKiB, iterations, parallelism, keyLength } = params;
  if (!Number.isInteger(memoryKiB) || memoryKiB < 8) {
    throw new Error(`argon2id memoryKiB must be an integer ≥ 8, got ${memoryKiB}`);
  }
  if (!Number.isInteger(iterations) || iterations < 1) {
    throw new Error(`argon2id iterations must be a positive integer, got ${iterations}`);
  }
  if (!Number.isInteger(parallelism) || parallelism < 1 || parallelism > 255) {
    throw new Error(`argon2id parallelism must be an integer in [1, 255], got ${parallelism}`);
  }
  if (!Number.isInteger(keyLength) || keyLength !== KDF_KEY_LENGTH) {
    throw new Error(
      `argon2id keyLength must be ${KDF_KEY_LENGTH} (AES-256 requires a 32-byte key), got ${keyLength}`,
    );
  }
}

/**
 * Derive a key from a passphrase + salt using scrypt.
 *
 * Pure: no I/O, no global state, deterministic for a given
 * (passphrase, salt, params) tuple.
 *
 * @throws if params are invalid.
 */
export function deriveKeyScrypt(
  passphrase: string,
  salt: Uint8Array,
  params: ScryptParams = DEFAULT_SCRYPT_PARAMS,
): Buffer {
  if (typeof passphrase !== "string") {
    throw new Error("passphrase must be a string");
  }
  if (passphrase.length === 0) {
    throw new Error("passphrase must not be empty");
  }
  if (!(salt instanceof Uint8Array) || salt.length < 8) {
    throw new Error(
      `salt must be a Uint8Array of at least 8 bytes, got ${salt?.length ?? "non-buffer"}`,
    );
  }
  validateScryptParams(params);
  return scryptSync(passphrase, Buffer.from(salt), params.keyLength, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: params.maxmem,
  });
}

/**
 * Derive a key from a passphrase + salt using Argon2id.
 *
 * The returned raw hash is used directly as the AES-256-GCM master key.
 * The same public KDF params are persisted in secure-store metadata so
 * unlock can reproduce the exact key later.
 */
export function deriveKeyArgon2id(
  passphrase: string,
  salt: Uint8Array,
  params: Argon2idParams = DEFAULT_ARGON2ID_PARAMS,
): Buffer {
  if (typeof passphrase !== "string") {
    throw new Error("passphrase must be a string");
  }
  if (passphrase.length === 0) {
    throw new Error("passphrase must not be empty");
  }
  if (!(salt instanceof Uint8Array) || salt.length < 8) {
    throw new Error(
      `salt must be a Uint8Array of at least 8 bytes, got ${salt?.length ?? "non-buffer"}`,
    );
  }
  validateArgon2idParams(params);
  const { Algorithm, Version, hashRawSync } = loadArgon2Runtime();
  return hashRawSync(passphrase, {
    algorithm: Algorithm.Argon2id,
    version: Version.V0x13,
    memoryCost: params.memoryKiB,
    timeCost: params.iterations,
    parallelism: params.parallelism,
    outputLen: params.keyLength,
    salt,
  });
}

/**
 * Algorithm-dispatching KDF. The algorithm name is recorded in the
 * metadata file so existing stores continue using their original KDF.
 */
export function deriveKey(
  algorithm: KdfAlgorithm,
  passphrase: string,
  salt: Uint8Array,
  params: ScryptParams | Argon2idParams,
): Buffer {
  if (algorithm === "scrypt") {
    return deriveKeyScrypt(passphrase, salt, params as ScryptParams);
  }
  if (algorithm === "argon2id") {
    return deriveKeyArgon2id(passphrase, salt, params as Argon2idParams);
  }
  throw new Error(`unknown KDF algorithm: ${algorithm as string}`);
}

/**
 * Constant-time equality for two derived keys / MACs. Re-exported so
 * callers don't reach into `node:crypto` directly for this primitive.
 */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
