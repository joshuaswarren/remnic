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

/** True when `cause` is a path error the gate reports as an input error instead of a server fault. */
function isInputFsError(cause: unknown): boolean {
  return (
    hasFsErrorCode(cause, "ENOENT") ||
    hasFsErrorCode(cause, "ENOTDIR") ||
    hasFsErrorCode(cause, "EACCES") ||
    hasFsErrorCode(cause, "EPERM") ||
    hasFsErrorCode(cause, "ELOOP") ||
    hasFsErrorCode(cause, "ENAMETOOLONG") ||
    hasFsErrorCode(cause, "ERR_INVALID_ARG_VALUE")
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
 * One message for every refusal before confinement is proven. A caller that
 * can name any server path must not learn from the error whether that path
 * exists, is a directory, or is unreadable.
 */
const IMPORT_SOURCE_REFUSED =
  "capsule import failed: archivePath must be an existing file inside the namespace capsule store";

/** Resolve a path to its real path; a missing, looping, or unreadable path resolves to null. */
async function realpathOrNull(target: string): Promise<string | null> {
  try {
    return await realpath(target);
  } catch (cause) {
    if (!isInputFsError(cause)) throw cause;
    return null;
  }
}

/** True when `target` is a strict descendant of `directory` (both already resolved). */
function isInsideDirectory(directory: string, target: string): boolean {
  const rel = path.relative(directory, target);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/**
 * Validate a remote import source and confine it to the namespace capsule
 * store. Both real paths are resolved first, so `..` segments and store
 * symlinks that point outside are refused. Confinement is checked before the
 * file is inspected in any other way, and every failure before it proves
 * confinement raises the same message.
 */
export async function validateCapsuleImportArchive(archivePath: string, storageDir: string): Promise<void> {
  const storeReal = await realpathOrNull(defaultCapsulesDir(storageDir));
  const archiveReal = await realpathOrNull(archivePath);
  if (storeReal === null || archiveReal === null || !isInsideDirectory(storeReal, archiveReal)) {
    throw new EngramAccessInputError(IMPORT_SOURCE_REFUSED);
  }
  // The path now names a store entry, so the checks below only describe the store.
  if (!(await stat(archiveReal)).isFile()) {
    throw new EngramAccessInputError("capsule import failed: archivePath must point to a file");
  }
  try {
    await access(archiveReal, fsConstants.R_OK);
  } catch (cause) {
    if (!isInputFsError(cause)) throw cause;
    throw new EngramAccessInputError("capsule import failed: archive is not readable");
  }
}
