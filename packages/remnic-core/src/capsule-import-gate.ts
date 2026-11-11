import { constants as fsConstants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { ZodError } from "zod";
import { EngramAccessInputError } from "./access-errors.js";
import { defaultCapsulesDir } from "./capsule-cli.js";

/**
 * Import-path gate for remote capsule imports (issue #3225 C1).
 *
 * `EngramAccessService.capsuleImport` serves the HTTP route and the
 * `capsule_import` MCP operation, where the caller supplies `archivePath`.
 * The destination namespace is authorized, but the source archive previously
 * was not: any path the server process could read was accepted. This module
 * confines the source to the namespace capsule store, `defaultCapsulesDir`
 * of the destination storage dir, which is the same store `capsule export`
 * writes and `capsule_list` lists.
 *
 * The CLI import path does not go through this gate; it is the explicit
 * operator authority and keeps unrestricted local-path imports.
 */

/** True when the caught error carries the given errno-style code. */
function hasFsErrorCode(cause: unknown, code: string): boolean {
  return cause instanceof Object && "code" in cause && cause.code === code;
}

/** True when `cause` is a filesystem error the gate reports as "not readable". */
function isInputFsError(cause: unknown): boolean {
  return (
    hasFsErrorCode(cause, "ENOENT") ||
    hasFsErrorCode(cause, "ENOTDIR") ||
    hasFsErrorCode(cause, "EACCES") ||
    hasFsErrorCode(cause, "EPERM") ||
    hasFsErrorCode(cause, "ELOOP")
  );
}

/** Matches zod-style `Z_` error codes carried on error objects. */
const ZOD_STYLE_CODE = /^Z_/;

/** True when the caught error carries a zod-style `Z_` code. */
function hasZodStyleErrorCode(cause: unknown): boolean {
  return cause instanceof Object && "code" in cause && ZOD_STYLE_CODE.test(String(cause.code));
}

/** True when the importer failed on archive input (shape, gzip, checksum) rather than backend errors. */
export function isCapsuleImportArchiveInputError(cause: unknown, message: string): boolean {
  if (cause instanceof ZodError) return true;
  if (hasZodStyleErrorCode(cause)) return true;
  return (
    message.startsWith("importCapsule: archive") ||
    message.startsWith("importCapsule: bundle") ||
    message.startsWith("importCapsule: manifest") ||
    message.startsWith("importCapsule: record") ||
    /incorrect header check|invalid stored block lengths|not in gzip format|unexpected end of file/i.test(message)
  );
}

/**
 * Validate a remote import source and confine it to the namespace capsule
 * store. The archive must be a readable regular file whose real path lies
 * inside the store's real path, so `..` segments and store symlinks that
 * point outside are refused with the archive.
 */
export async function validateCapsuleImportArchive(archivePath: string, storageDir: string): Promise<void> {
  let archiveStat;
  try {
    archiveStat = await stat(archivePath);
  } catch (cause) {
    if (!isInputFsError(cause)) throw cause;
    throw new EngramAccessInputError(
      `capsule import failed: archive is not readable: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  if (!archiveStat.isFile()) {
    throw new EngramAccessInputError("capsule import failed: archivePath must point to a file");
  }
  try {
    await access(archivePath, fsConstants.R_OK);
  } catch (cause) {
    if (!isInputFsError(cause)) throw cause;
    throw new EngramAccessInputError(
      `capsule import failed: archive is not readable: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }

  const storeDir = defaultCapsulesDir(storageDir);
  const storeReal = await realpath(storeDir).catch(() => null);
  if (storeReal === null) {
    throw new EngramAccessInputError(`capsule import failed: namespace capsule store is not readable: ${storeDir}`);
  }
  const archiveReal = await realpath(archivePath).catch(() => null);
  if (archiveReal === null) {
    throw new EngramAccessInputError(`capsule import failed: archive is not readable: ${archivePath}`);
  }
  const rel = path.relative(storeReal, archiveReal);
  const inside = rel !== "" && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
  if (!inside) {
    throw new EngramAccessInputError("capsule import failed: archivePath must be inside the namespace capsule store");
  }
}
