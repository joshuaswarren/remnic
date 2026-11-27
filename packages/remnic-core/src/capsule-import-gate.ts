import { constants as fsConstants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { ZodError } from "zod";
import { EngramAccessInputError } from "./access-errors.js";
import { defaultCapsulesDir } from "./capsule-cli.js";


function hasFsErrorCode(cause: unknown, code: string): boolean {
  return cause instanceof Object && "code" in cause && cause.code === code;
}

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

const ZOD_STYLE_CODE = /^Z_/;

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

const IMPORT_SOURCE_REFUSED =
  "capsule import failed: archivePath must be an existing file inside the namespace capsule store";

async function realpathOrNull(target: string): Promise<string | null> {
  try {
    return await realpath(target);
  } catch (cause) {
    if (!isInputFsError(cause)) throw cause;
    return null;
  }
}

function isInsideDirectory(directory: string, target: string): boolean {
  const rel = path.relative(directory, target);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

export async function validateCapsuleImportArchive(archivePath: string, storageDir: string): Promise<void> {
  const storeReal = await realpathOrNull(defaultCapsulesDir(storageDir));
  const archiveReal = await realpathOrNull(archivePath);
  if (storeReal === null || archiveReal === null || !isInsideDirectory(storeReal, archiveReal)) {
    throw new EngramAccessInputError(IMPORT_SOURCE_REFUSED);
  }
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
