export function isErrnoCode(error: unknown, code: string): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: unknown }).code === code;
}

/** True iff `error` carries Node's `ENOENT` code (missing file or directory). */
export function isNotFoundError(error: unknown): boolean {
  return isErrnoCode(error, "ENOENT");
}
