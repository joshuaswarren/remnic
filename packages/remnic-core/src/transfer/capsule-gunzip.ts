import { gunzipSync } from "node:zlib";

import { isErrnoCode } from "../utils/errno.js";

/**
 * Hard cap on decompressed capsule JSON for import, merge and inspect. `gunzipSync` without
 * `maxOutputLength` allocates whatever the stream claims, so a small
 * highly-compressible gzip can OOM the process. 64 MiB is enough for ordinary
 * capsules and stops classic bomb shapes at the zlib edge.
 */
export const CAPSULE_IMPORT_MAX_GUNZIP_BYTES = 64 * 1024 * 1024;

/**
 * Gunzip a capsule archive buffer with a hard decompressed-size cap.
 * `caller` is the public API name used in error messages (`importCapsule`,
 * `mergeCapsule`, `capsule inspect`).
 */
export function gunzipCapsuleArchive(
  raw: Buffer,
  caller: string,
  archiveAbs: string,
): string {
  try {
    return gunzipSync(raw, {
      maxOutputLength: CAPSULE_IMPORT_MAX_GUNZIP_BYTES,
    }).toString("utf-8");
  } catch (cause) {
    if (isErrnoCode(cause, "ERR_BUFFER_TOO_LARGE")) {
      throw new Error(
        `${caller}: archive decompressed size exceeds limit of ${CAPSULE_IMPORT_MAX_GUNZIP_BYTES} bytes`,
        cause instanceof Error ? { cause } : undefined,
      );
    }
    throw new Error(
      `${caller}: archive is not a valid gzip file: ${archiveAbs}`,
      cause instanceof Error ? { cause } : undefined,
    );
  }
}
