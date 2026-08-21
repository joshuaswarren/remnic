import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import { MAGIC_HEADER_SIZE, isEncryptedFile } from "./secure-store/secure-fs.js";

export interface OfflineSyncFileTarget {
  root: string;
  path: string;
  filePath: string;
}

export type OfflineSyncExcludeFile = (target: OfflineSyncFileTarget) => boolean | Promise<boolean>;

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error("offline sync request aborted");
}

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
    throwIfAborted(signal);
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    hash.update(buffer);
    bytes += buffer.length;
  }
  throwIfAborted(signal);
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
