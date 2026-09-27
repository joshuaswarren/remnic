import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import { throwIfAborted } from "./abort-error.js";
import { MAGIC_HEADER_SIZE, isEncryptedFile } from "./secure-store/secure-fs.js";

export interface OfflineSyncFileTarget {
  root: string;
  path: string;
  filePath: string;
}

export type OfflineSyncExcludeFile = (target: OfflineSyncFileTarget) => boolean | Promise<boolean>;
export async function shouldExcludeOfflineSyncFile(
  excludeFile: OfflineSyncExcludeFile | undefined,
  target: OfflineSyncFileTarget
): Promise<boolean> {
  return excludeFile ? await excludeFile(target) : false;
}

export async function sha256OfflineSyncFile(
  filePath: string,
  signal?: AbortSignal
): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(filePath)) {
    throwIfAborted(signal, "offline sync request aborted");
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    hash.update(buffer);
    bytes += buffer.length;
  }
  throwIfAborted(signal, "offline sync request aborted");
  return { sha256: hash.digest("hex"), bytes };
}

export async function isEncryptedOfflineSyncFile(filePath: string): Promise<boolean> {
  const handle = await open(filePath, "r");
  try {
    const header = Buffer.alloc(MAGIC_HEADER_SIZE);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    return bytesRead >= MAGIC_HEADER_SIZE && isEncryptedFile(header);
  } finally {
    await handle.close();
  }
}

export async function readPlainOfflineSyncFileChunk(options: {
  filePath: string;
  offset: number;
  length: number;
  bytes: number;
}): Promise<Buffer> {
  const chunkBytes = Math.min(options.length, options.bytes - options.offset);
  const chunk = Buffer.alloc(chunkBytes);
  if (chunkBytes === 0) return chunk;
  const handle = await open(options.filePath, "r");
  try {
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, options.offset);
    return bytesRead === chunk.length ? chunk : chunk.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** Streamed whole-file sha256 for plain-file chunk reads — the value the
 * file-content response contract exposes as x-remnic-file-sha256. Deliberately
 * UNCACHED: identity keys like (path, size, mtimeMs) are spoofable (a rewrite
 * that preserves size and mtime would serve a stale digest, defeating the
 * uploader's verify-before-idempotent-skip check). One bounded-memory hash
 * pass per chunk request; content reads stay windowed. */
export async function plainFileDigest(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const piece of createReadStream(filePath)) {
    hash.update(piece as Buffer);
  }
  return hash.digest("hex");
}

import { lstat, utimes } from "node:fs/promises";
import { isCensusMtimeMs } from "./census-validation.js";
import { resolveSafeArchiveTarget, type SafeArchiveRoot } from "./transfer/fs-utils.js";

/** Sync-internal directory spooling partial uploads and coordination state. */
export const SYNC_INTERNAL_DIR = ".offline-sync";

export const OFFLINE_SYNC_FAST_BASE_MTIME_TOLERANCE_MS = 1_000;

export function assertNonNegativeFinite(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${field} must be a non-negative finite number`);
  }
  return value;
}

export function assertOfflineSyncMtimeMs(value: unknown, field: string): number {
  const mtimeMs = assertNonNegativeFinite(value, field);
  if (!isCensusMtimeMs(mtimeMs)) {
    throw new Error(`${field} must be within JavaScript Date range`);
  }
  return mtimeMs;
}

export async function setSafeFileMtime(
  root: SafeArchiveRoot,
  relPath: string,
  mtimeMs: number | undefined,
): Promise<boolean> {
  if (mtimeMs === undefined) return true;
  const target = await resolveSafeArchiveTarget(root, relPath);
  const targetStat = await lstat(target).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (!targetStat) return false;
  if (targetStat.isSymbolicLink()) {
    throw new Error(`offline sync target is a symlink: ${relPath}`);
  }
  const targetMtimeMs = assertOfflineSyncMtimeMs(mtimeMs, "mtimeMs");
  if (Math.abs(targetStat.mtimeMs - targetMtimeMs) <= OFFLINE_SYNC_FAST_BASE_MTIME_TOLERANCE_MS) {
    return true;
  }
  const mtime = new Date(targetMtimeMs);
  await utimes(target, mtime, mtime);
  return true;
}
