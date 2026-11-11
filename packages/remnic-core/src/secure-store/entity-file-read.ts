import { constants } from "node:fs";
import { lstat, open, readFile } from "node:fs/promises";
import path from "node:path";
import { isPathInsideStorageRoot, resolveSafeStoragePath } from "../storage-paths.js";

/** Symlink refusal with ELOOP so entity readers treat it like a kernel nofollow miss. */
function refuseSymlink(message: string): never {
  const err = new Error(message) as NodeJS.ErrnoException;
  err.code = "ELOOP";
  throw err;
}

/**
 * Read a store file under `memoryDir` without following symlinks.
 *
 * COS-388c Finding C2: entity reads (and every other secure-store read that
 * passes `memoryDir`) used to reach plain `readFile`, which follows a
 * post-init `entities/<id>.md` symlink out of the memory root. Refuse the
 * leaf and every ancestor via {@link resolveSafeStoragePath}, then open with
 * O_NOFOLLOW and re-check identity so a swap between the path walk and the
 * open cannot redirect the bytes.
 *
 * Paths outside `memoryDir` keep a plain read (callers that only pass
 * `memoryDir` for AAD binding).
 */
export async function readStoreFileBuffer(filePath: string, memoryDir: string): Promise<Buffer> {
  const root = path.resolve(memoryDir);
  const target = path.resolve(filePath);
  if (!isPathInsideStorageRoot(root, target) || target === root) {
    return readFile(filePath);
  }

  const relative = path.relative(root, target);
  const parts = relative.split(path.sep).filter((part) => part.length > 0);
  // Shared storage-path helper: lexical containment + no symlink on any
  // existing ancestor or the leaf (profile, entities, facts, …).
  try {
    await resolveSafeStoragePath(root, ...parts);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/symlink|escapes root/i.test(message)) {
      refuseSymlink(message);
    }
    throw err;
  }

  let handle;
  try {
    handle = await open(
      target,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ELOOP") {
      refuseSymlink(`Refusing unsafe store file: ${filePath}.`);
    }
    throw err;
  }
  try {
    const [opened, entry] = await Promise.all([handle.stat(), lstat(target)]);
    if (entry.isSymbolicLink()) {
      refuseSymlink(`Refusing unsafe store file: ${filePath}.`);
    }
    // Identity mismatch is a concurrent atomic-replace race, not a symlink —
    // throw without ELOOP so readStoreFileBufferTolerant can retry.
    if (
      !opened.isFile() ||
      !entry.isFile() ||
      opened.dev !== entry.dev ||
      opened.ino !== entry.ino
    ) {
      throw new Error(`Refusing unsafe store file: ${filePath}.`);
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

/**
 * Atomic-replacement-tolerant variant: store writes ship as temp-file +
 * rename, so an open/lstat identity mismatch during a concurrent write is an
 * ordinary race, not tampering. Retry a bounded number of times with fresh
 * containment checks before surfacing the mismatch as unsafe.
 */
export async function readStoreFileBufferTolerant(
  filePath: string,
  memoryDir: string,
  attempts = 3,
): Promise<Buffer> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await readStoreFileBuffer(filePath, memoryDir);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // ELOOP is a hard refusal (planted symlink), not a rename race.
      if ((err as NodeJS.ErrnoException)?.code === "ELOOP") throw err;
      // Match both the pre-C2 "unsafe entity …" wording and the shared
      // "unsafe store file" / resolveSafeStoragePath symlink refusal so a
      // rename race during any secure-store write still retries.
      const identityRace =
        /unsafe (?:store|entity) (?:file|directory)/.test(message) ||
        /storage path must not pass through a symlink/.test(message);
      if (!identityRace || attempt >= attempts - 1) throw err;
    }
  }
}
