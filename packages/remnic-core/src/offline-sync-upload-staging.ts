// Offline-sync upload staging: chunked upload spool under
// `.offline-sync/uploads/` (issue #2033). Extracted from offline-sync.ts so
// the god-file line-count ratchet does not grow; behavior is unchanged.
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { SYNC_INTERNAL_DIR, setSafeFileMtime } from "./offline-sync-file-io.js";
import type { OfflineSyncFileTarget } from "./offline-sync-file-io.js";
import type {
  OfflineSyncFileStagingWriteTarget,
  OfflineSyncFileWriteChunksTarget,
  OfflineSyncFileWriteTarget,
} from "./offline-sync.js";
import { type SafeArchiveRoot, resolveSafeArchiveTarget } from "./transfer/fs-utils.js";

const OFFLINE_SYNC_UPLOAD_STAGING_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** A staged upload spool returned by writeOfflineUploadChunk; consumed by digest/cleanup/finalize. */
export interface OfflineUploadStaging {
  kind: "single" | "chunks";
  relPath: string;
  filePath: string;
}

function offlineUploadRelPath(options: {
  sourceId: string;
  relPath: string;
  sha256: string;
  bytes: number;
}): string {
  const key = hashText([options.sourceId, options.relPath, options.sha256, String(options.bytes)].join("\0"));
  return `${SYNC_INTERNAL_DIR}/uploads/${key}.part`;
}

async function offlineUploadPath(
  root: SafeArchiveRoot,
  options: {
    sourceId: string;
    relPath: string;
    sha256: string;
    bytes: number;
  }
): Promise<OfflineUploadStaging> {
  const relPath = offlineUploadRelPath(options);
  return {
    kind: "single",
    relPath,
    filePath: await resolveSafeArchiveTarget(root, relPath),
  };
}

async function offlineUploadChunkPath(
  root: SafeArchiveRoot,
  options: {
    sourceId: string;
    relPath: string;
    sha256: string;
    bytes: number;
    offset: number;
  }
): Promise<OfflineUploadStaging> {
  const uploadRelPath = offlineUploadRelPath(options);
  const relPath = `${uploadRelPath}/${String(options.offset).padStart(20, "0")}.part`;
  return {
    kind: "chunks",
    relPath,
    filePath: await resolveSafeArchiveTarget(root, relPath),
  };
}

export async function writeOfflineUploadChunk(options: {
  root: SafeArchiveRoot;
  sourceId: string;
  relPath: string;
  sha256: string;
  bytes: number;
  offset: number;
  content: Buffer;
  readFile?: (target: OfflineSyncFileTarget) => Promise<Buffer>;
  writeFile?: (target: OfflineSyncFileWriteTarget) => Promise<void>;
  writeStagingFile?: (target: OfflineSyncFileStagingWriteTarget) => Promise<void>;
}): Promise<OfflineUploadStaging> {
  if ((options.writeFile || options.writeStagingFile) && !options.readFile) {
    throw new Error("offline sync upload chunk storage hooks require readFile");
  }
  const uploadRoot = {
    ...(await offlineUploadPath(options.root, options)),
    kind: "chunks" as const,
  };
  if (options.offset === 0) {
    await rm(uploadRoot.filePath, { recursive: true, force: true }).catch(() => {});
  } else {
    const existing = await stat(uploadRoot.filePath).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    if (!existing || !existing.isDirectory()) {
      throw new Error(`offline sync upload is missing initial chunk for ${options.relPath}`);
    }
  }
  const chunk = await offlineUploadChunkPath(options.root, { ...options, offset: options.offset });

  const writeStagingFile = options.writeStagingFile ?? options.writeFile;
  if (writeStagingFile) {
    // Storage-backed services provide these hooks so secure-store deployments
    // keep staged partial uploads encrypted at rest without mutating indexes.
    await writeOfflineUploadContent({
      root: options.root,
      relPath: chunk.relPath,
      filePath: chunk.filePath,
      content: options.content,
      writeFile: writeStagingFile,
    });
    return uploadRoot;
  }

  await mkdir(path.dirname(chunk.filePath), { recursive: true });
  const existingChunk = await lstat(chunk.filePath).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (existingChunk?.isSymbolicLink()) {
    throw new Error(`offline sync upload chunk is a symlink: ${chunk.relPath}`);
  }
  await writeFile(chunk.filePath, options.content, { mode: 0o600 });
  return uploadRoot;
}

export async function pruneOfflineUploadStaging(root: SafeArchiveRoot): Promise<void> {
  const uploadsRelPath = `${SYNC_INTERNAL_DIR}/uploads`;
  const uploadsPath = await resolveSafeArchiveTarget(root, uploadsRelPath);
  const entries = await readdir(uploadsPath, { withFileTypes: true }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  });
  const now = Date.now();
  await Promise.all(
    entries.map(async (entry) => {
      if (!/^[a-f0-9]{64}\.part$/i.test(entry.name)) return;
      const relPath = `${uploadsRelPath}/${entry.name}`;
      const filePath = await resolveSafeArchiveTarget(root, relPath);
      const info = await lstat(filePath).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      });
      if (!info) return;
      if (now - info.mtimeMs <= OFFLINE_SYNC_UPLOAD_STAGING_MAX_AGE_MS) return;
      await rm(filePath, { recursive: true, force: true });
    })
  );
}

async function* readOfflineUploadStagingChunks(options: {
  root: SafeArchiveRoot;
  upload: OfflineUploadStaging;
  readFile?: (target: OfflineSyncFileTarget) => Promise<Buffer>;
}): AsyncGenerator<Buffer> {
  if (options.upload.kind === "single") {
    yield await readOfflineUploadContent({
      root: options.root,
      relPath: options.upload.relPath,
      filePath: options.upload.filePath,
      readFile: options.readFile,
    });
    return;
  }

  const entries = await readdir(options.upload.filePath);
  const chunkNames = entries.filter((entry) => /^\d{20}\.part$/.test(entry)).sort();
  if (chunkNames.length === 0) {
    throw new Error(`offline sync upload is missing chunks for ${options.upload.relPath}`);
  }
  let expectedOffset = 0;
  for (const chunkName of chunkNames) {
    const offset = Number(chunkName.slice(0, 20));
    if (!Number.isSafeInteger(offset) || offset !== expectedOffset) {
      throw new Error(
        `offline sync upload offset mismatch for ${options.upload.relPath}: expected ${expectedOffset}, got ${offset}`
      );
    }
    const relPath = `${options.upload.relPath}/${chunkName}`;
    const filePath = await resolveSafeArchiveTarget(options.root, relPath);
    const content = await readOfflineUploadContent({
      root: options.root,
      relPath,
      filePath,
      readFile: options.readFile,
    });
    expectedOffset += content.length;
    yield content;
  }
}

export async function digestOfflineUploadStagingContent(options: {
  root: SafeArchiveRoot;
  upload: OfflineUploadStaging;
  readFile?: (target: OfflineSyncFileTarget) => Promise<Buffer>;
}): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of readOfflineUploadStagingChunks(options)) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  return { sha256: hash.digest("hex"), bytes };
}

export async function writeSafeFileFromUpload(
  root: SafeArchiveRoot,
  relPath: string,
  upload: OfflineUploadStaging,
  readFile?: (target: OfflineSyncFileTarget) => Promise<Buffer>,
  writeFileChunks?: (target: OfflineSyncFileWriteChunksTarget) => Promise<void>,
  mtimeMs?: number
): Promise<void> {
  const target = await resolveSafeArchiveTarget(root, relPath);
  const chunks = readOfflineUploadStagingChunks({ root, upload, readFile });
  if (writeFileChunks) {
    await writeFileChunks({ root: root.abs, path: relPath, filePath: target, chunks });
    await setSafeFileMtime(root, relPath, mtimeMs);
    return;
  }

  await mkdir(path.dirname(target), { recursive: true });
  const tmp = path.join(path.dirname(target), `.remnic-sync.${process.pid}.${randomUUID()}.tmp`);
  const handle = await open(tmp, "w", 0o600);
  try {
    for await (const chunk of chunks) {
      if (chunk.length > 0) await handle.write(chunk);
    }
    await handle.close();
    const targetStat = await lstat(target).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    if (targetStat?.isSymbolicLink()) {
      throw new Error(`offline sync target is a symlink: ${relPath}`);
    }
    await rename(tmp, target);
    await setSafeFileMtime(root, relPath, mtimeMs);
  } catch (error) {
    await handle.close().catch(() => {});
    await unlink(tmp).catch(() => {});
    throw error;
  }
}

export async function cleanupOfflineUpload(upload: OfflineUploadStaging): Promise<void> {
  if (upload.kind === "chunks") {
    await rm(upload.filePath, { recursive: true, force: true });
    return;
  }
  await unlink(upload.filePath).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  });
}

async function readOfflineUploadContent(options: {
  root: SafeArchiveRoot;
  relPath: string;
  filePath: string;
  readFile?: (target: OfflineSyncFileTarget) => Promise<Buffer>;
}): Promise<Buffer> {
  if (options.readFile) {
    return options.readFile({
      root: options.root.abs,
      path: options.relPath,
      filePath: options.filePath,
    });
  }
  return readFile(options.filePath);
}

async function writeOfflineUploadContent(options: {
  root: SafeArchiveRoot;
  relPath: string;
  filePath: string;
  content: Buffer;
  writeFile: (target: OfflineSyncFileWriteTarget) => Promise<void>;
}): Promise<void> {
  await options.writeFile({
    root: options.root.abs,
    path: options.relPath,
    filePath: options.filePath,
    content: options.content,
  });
}
