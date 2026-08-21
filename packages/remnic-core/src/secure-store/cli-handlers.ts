/**
 * Pure handlers behind the `remnic secure-store {init,unlock,lock,
 * status,migrate,disable}` CLI surface (issue #690 PR 2/4 + #779/#780).
 *
 * Each handler:
 *   - takes an explicit `memoryDir` (already `~`-expanded by the CLI),
 *   - takes an injectable passphrase reader (so tests don't need a
 *     real TTY and never touch real readline state),
 *   - returns a structured report (no `console.log` inside),
 *   - never logs the passphrase or any secret material.
 *
 * The actual `console.log` formatting lives in `cli-renderer.ts` so
 * tests can assert on the report shape without parsing text.
 */

import { generateSalt as generateEnvelopeSalt } from "./cipher.js";
import {
  buildHeaderFromPassphrase,
  deriveKeyFromHeader,
  headerPath,
  readHeader,
  secureStoreDir,
  verifyKey,
  writeHeader,
  type SecureStoreHeader,
} from "./header.js";
import * as keyring from "./keyring.js";
import {
  DEFAULT_ARGON2ID_PARAMS,
  DEFAULT_SCRYPT_PARAMS,
  KDF_SALT_LENGTH,
  type Argon2idParams,
  type KdfAlgorithm,
  type ScryptParams,
} from "./kdf.js";
import {
  decryptMemoryDirToPlaintext,
  migrateMemoryDirToEncrypted,
  type DecryptResult,
  type MigrateResult,
} from "./secure-fs.js";

/** Passphrase source — async so callers can read from a TTY without echo. */
export type PassphraseReader = (
  prompt: string,
  options?: { confirm?: boolean },
) => Promise<string>;

/** Common options accepted by every handler. */
export interface SecureStoreHandlerCommon {
  memoryDir: string;
  /**
   * Stable identifier for the in-memory keyring entry. Defaults to
   * the secure-store directory under `memoryDir`. Tests override
   * this to keep entries from leaking across cases.
   */
  keyringId?: string;
  /** Optional clock injection for deterministic tests. */
  now?: () => Date;
}

// ─── init ─────────────────────────────────────────────────────────────

export interface SecureStoreInitOptions extends SecureStoreHandlerCommon {
  /** Passphrase reader — called twice (entry + confirmation). */
  readPassphrase: PassphraseReader;
  /**
   * KDF algorithm. Defaults to `"argon2id"` for new stores.
   * `"scrypt"` remains supported for explicit compatibility cases.
   */
  algorithm?: KdfAlgorithm;
  /** KDF parameter override; defaults to OWASP-acceptable params for the selected KDF. */
  params?: ScryptParams | Argon2idParams;
  /** Pre-generated salt for tests; production callers should omit. */
  salt?: Buffer;
  /** Optional human-readable note recorded in metadata. Never persist secrets. */
  note?: string;
}

export interface SecureStoreInitReport {
  ok: true;
  /** Absolute path of the header file that was written. */
  headerPath: string;
  /** Algorithm + params used for the master key derivation. */
  kdf: SecureStoreHeader["metadata"]["kdf"];
  /** ISO-8601 timestamp recorded in the header. */
  createdAt: string;
}

/**
 * Initialize a new secure-store header. Refuses to overwrite an
 * existing header (use `header.ts:writeHeader` directly with explicit
 * intent if you need to reinitialize a destroyed store).
 */
export async function runSecureStoreInit(
  options: SecureStoreInitOptions,
): Promise<SecureStoreInitReport> {
  const { memoryDir, readPassphrase } = options;
  if (typeof memoryDir !== "string" || memoryDir.length === 0) {
    throw new Error("secure-store init: memoryDir is required");
  }
  // Fail fast if a header already exists, before we waste KDF time.
  const existing = await readHeader(memoryDir);
  if (existing !== null) {
    throw new Error(
      `secure-store header already exists at ${headerPath(memoryDir)}. Run 'remnic secure-store status' to inspect, or remove the .secure-store directory explicitly to reinitialize.`,
    );
  }
  const passphrase = await readPassphrase("Enter new passphrase: ", { confirm: true });
  validatePassphrase(passphrase);

  const algorithm: KdfAlgorithm = options.algorithm ?? "argon2id";
  const params = resolveParams(algorithm, options.params);
  const salt = options.salt ?? generateEnvelopeSalt();
  if (salt.length !== KDF_SALT_LENGTH) {
    throw new Error(`salt must be ${KDF_SALT_LENGTH} bytes, got ${salt.length}`);
  }

  const built = buildHeaderFromPassphrase({
    passphrase,
    salt,
    algorithm,
    params,
    ...(options.note !== undefined ? { note: options.note } : {}),
    ...(options.now ? { createdAt: options.now().toISOString() } : {}),
  });
  // Zero the derived key — init does NOT auto-unlock; the operator
  // must run `unlock` separately. This mirrors GnuPG-style hygiene
  // and keeps `init` safe to run from automation that should never
  // hold the master key in memory.
  built.derivedKey.fill(0);

  const writtenPath = await writeHeader(memoryDir, built.header);
  return {
    ok: true,
    headerPath: writtenPath,
    kdf: built.header.metadata.kdf,
    createdAt: built.header.createdAt,
  };
}

// ─── unlock ───────────────────────────────────────────────────────────

export interface SecureStoreUnlockOptions extends SecureStoreHandlerCommon {
  readPassphrase: PassphraseReader;
}

export type SecureStoreUnlockReport =
  | { ok: true; unlockedAt: string; algorithm: KdfAlgorithm }
  | { ok: false; reason: "not-initialized" | "wrong-passphrase" };

export async function runSecureStoreUnlock(
  options: SecureStoreUnlockOptions,
): Promise<SecureStoreUnlockReport> {
  const { memoryDir, readPassphrase } = options;
  const header = await readHeader(memoryDir);
  if (!header) {
    return { ok: false, reason: "not-initialized" };
  }
  const passphrase = await readPassphrase("Enter passphrase: ");
  validatePassphrase(passphrase);
  const candidateKey = deriveKeyFromHeader(header, passphrase);
  if (!verifyKey(header, candidateKey)) {
    candidateKey.fill(0);
    return { ok: false, reason: "wrong-passphrase" };
  }
  const id = options.keyringId ?? secureStoreDir(memoryDir);
  const now = options.now ?? (() => new Date());
  keyring.unlock(id, candidateKey, now);
  const status = keyring.status(id);
  return {
    ok: true,
    unlockedAt: status.unlockedAt ?? now().toISOString(),
    algorithm: header.metadata.kdf.algorithm,
  };
}

// ─── lock ─────────────────────────────────────────────────────────────

export interface SecureStoreLockOptions extends SecureStoreHandlerCommon {}

export interface SecureStoreLockReport {
  ok: true;
  /** True if a key was registered and is now cleared; false if it was already locked. */
  cleared: boolean;
}

export function runSecureStoreLock(options: SecureStoreLockOptions): SecureStoreLockReport {
  const id = options.keyringId ?? secureStoreDir(options.memoryDir);
  const cleared = keyring.lock(id);
  return { ok: true, cleared };
}

// ─── migrate ─────────────────────────────────────────────────────────

export interface SecureStoreMigrateOptions extends SecureStoreHandlerCommon {
  /**
   * Optional passphrase reader for standalone CLI migration. A prior
   * `secure-store unlock` command only unlocks that process-local keyring, so
   * standalone migrate can prompt and install the key in this process instead
   * of pretending another process still has it.
   */
  readPassphrase?: PassphraseReader;
}

export type SecureStoreMigrateReport =
  | ({ ok: true } & MigrateResult)
  | ({
      ok: false;
      reason: "not-initialized" | "locked" | "wrong-passphrase" | "file-errors";
    } & MigrateResult);

export async function runSecureStoreMigrate(
  options: SecureStoreMigrateOptions,
): Promise<SecureStoreMigrateReport> {
  const { memoryDir } = options;
  const header = await readHeader(memoryDir);
  if (!header) {
    return {
      ok: false,
      reason: "not-initialized",
      encrypted: 0,
      skipped: 0,
      errors: [],
    };
  }

  const id = options.keyringId ?? secureStoreDir(memoryDir);
  const key = keyring.getKey(id) ?? await unlockForThisProcess({
    memoryDir,
    header,
    keyringId: id,
    readPassphrase: options.readPassphrase,
    now: options.now,
  });
  if (key === null) {
    return {
      ok: false,
      reason: "locked",
      encrypted: 0,
      skipped: 0,
      errors: [],
    };
  }
  if (key === "wrong-passphrase") {
    return {
      ok: false,
      reason: "wrong-passphrase",
      encrypted: 0,
      skipped: 0,
      errors: [],
    };
  }

  const result = await migrateMemoryDirToEncrypted(memoryDir, key);
  if (result.errors.length > 0) {
    return { ok: false, reason: "file-errors", ...result };
  }
  return { ok: true, ...result };
}

// ─── disable/decrypt ─────────────────────────────────────────────────

export interface SecureStoreDisableOptions extends SecureStoreHandlerCommon {
  /**
   * Optional passphrase reader for standalone CLI decrypt/disable. See
   * SecureStoreMigrateOptions.readPassphrase for the process-local keyring
   * contract.
   */
  readPassphrase?: PassphraseReader;
}

export type SecureStoreDisableReport =
  | ({ ok: true } & DecryptResult)
  | ({
      ok: false;
      reason: "not-initialized" | "locked" | "wrong-passphrase" | "file-errors";
    } & DecryptResult);

export async function runSecureStoreDisable(
  options: SecureStoreDisableOptions,
): Promise<SecureStoreDisableReport> {
  const { memoryDir } = options;
  const header = await readHeader(memoryDir);
  if (!header) {
    return {
      ok: false,
      reason: "not-initialized",
      decrypted: 0,
      skipped: 0,
      errors: [],
    };
  }

  const id = options.keyringId ?? secureStoreDir(memoryDir);
  const key = keyring.getKey(id) ?? await unlockForThisProcess({
    memoryDir,
    header,
    keyringId: id,
    readPassphrase: options.readPassphrase,
    now: options.now,
  });
  if (key === null) {
    return {
      ok: false,
      reason: "locked",
      decrypted: 0,
      skipped: 0,
      errors: [],
    };
  }
  if (key === "wrong-passphrase") {
    return {
      ok: false,
      reason: "wrong-passphrase",
      decrypted: 0,
      skipped: 0,
      errors: [],
    };
  }

  const result = await decryptMemoryDirToPlaintext(memoryDir, key);
  if (result.errors.length > 0) {
    return { ok: false, reason: "file-errors", ...result };
  }
  return { ok: true, ...result };
}

// ─── status ───────────────────────────────────────────────────────────

export interface SecureStoreStatusOptions extends SecureStoreHandlerCommon {}

export interface SecureStoreStatusReport {
  /** True iff a header file exists in `<memoryDir>/.secure-store/`. */
  initialized: boolean;
  /** Path the status check probed. Useful for operators. */
  headerPath: string;
  /** Locked/unlocked state of the in-memory keyring entry. */
  locked: boolean;
  /** ISO-8601 timestamp of the most recent unlock, or null when locked. */
  unlockedAt: string | null;
  /** Header metadata (algorithm + params + salt hex), or null when uninitialized. */
  kdf: SecureStoreHeader["metadata"]["kdf"] | null;
  /** Header `createdAt`, or null when uninitialized. */
  createdAt: string | null;
}

export async function runSecureStoreStatus(
  options: SecureStoreStatusOptions,
): Promise<SecureStoreStatusReport> {
  const { memoryDir } = options;
  const id = options.keyringId ?? secureStoreDir(memoryDir);
  const header = await readHeader(memoryDir);
  const ks = keyring.status(id);
  const target = headerPath(memoryDir);
  if (!header) {
    return {
      initialized: false,
      headerPath: target,
      locked: !ks.unlocked,
      unlockedAt: ks.unlockedAt,
      kdf: null,
      createdAt: null,
    };
  }
  return {
    initialized: true,
    headerPath: target,
    locked: !ks.unlocked,
    unlockedAt: ks.unlockedAt,
    kdf: header.metadata.kdf,
    createdAt: header.createdAt,
  };
}

// ─── helpers ──────────────────────────────────────────────────────────

/** Minimum passphrase length. 8 chars is intentionally permissive — operators may use phrase managers. */
export const MIN_PASSPHRASE_LENGTH = 8;

function validatePassphrase(passphrase: string): void {
  if (typeof passphrase !== "string") {
    throw new Error("passphrase must be a string");
  }
  if (passphrase.length === 0) {
    throw new Error("passphrase must not be empty");
  }
  if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
    throw new Error(`passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters`);
  }
}

function resolveParams(
  algorithm: KdfAlgorithm,
  override: ScryptParams | Argon2idParams | undefined,
): ScryptParams | Argon2idParams {
  if (override !== undefined) return override;
  if (algorithm === "scrypt") return { ...DEFAULT_SCRYPT_PARAMS };
  return { ...DEFAULT_ARGON2ID_PARAMS };
}

async function unlockForThisProcess(options: {
  memoryDir: string;
  header: SecureStoreHeader;
  keyringId: string;
  readPassphrase?: PassphraseReader;
  now?: () => Date;
}): Promise<Buffer | null | "wrong-passphrase"> {
  if (!options.readPassphrase) return null;
  const passphrase = await options.readPassphrase("Enter passphrase: ");
  validatePassphrase(passphrase);
  const candidateKey = deriveKeyFromHeader(options.header, passphrase);
  if (!verifyKey(options.header, candidateKey)) {
    candidateKey.fill(0);
    return "wrong-passphrase";
  }
  keyring.unlock(options.keyringId, candidateKey, options.now ?? (() => new Date()));
  return candidateKey;
}
