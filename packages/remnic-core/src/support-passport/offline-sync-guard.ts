import path from "node:path";

import type { OfflineSyncFileTarget } from "../offline-sync-file-io.js";
import {
  applyOfflineSyncChangeset,
  applyOfflineSyncFileContentChunk,
  buildOfflineSyncSnapshot,
  normalizeOfflineSyncChangeset,
  type OfflineSyncApplyChangesetResult,
  type OfflineSyncApplyFileContentChunkResult,
} from "../offline-sync.js";
import { validateArchiveRelativePath } from "../transfer/fs-utils.js";
import type { MemoryFile } from "../types.js";
import { createSupportPassportPrivateFileExclusion } from "./card-projection.js";

const MAX_SUPPORT_PASSPORT_FRONTMATTER_BYTES = 1_048_576;
const SUPPORT_PASSPORT_MARKER = "support-passport-";
const FRONTMATTER_PREFIXES = ["---\n", "---\r\n"] as const;

type FrontmatterDecision = "allow" | "wait";

interface SupportPassportOfflineSyncStorage {
  dir: string;
  readMemoryByPath(filePath: string): Promise<MemoryFile | null>;
  readOfflineSyncFile(filePath: string): Promise<Buffer>;
  digestOfflineSyncFile(filePath: string): Promise<{ sha256: string; bytes: number }>;
  writeOfflineSyncFile(filePath: string, content: Buffer): Promise<void>;
  writeOfflineSyncStagingFile(filePath: string, content: Buffer): Promise<void>;
  writeOfflineSyncFileChunks(filePath: string, chunks: AsyncIterable<Buffer>): Promise<void>;
  deleteOfflineSyncFile(filePath: string, deletionMtimeMs?: number | null): Promise<void>;
  recordReplicatedDeletionRevision(filePath: string, mtimeMs: number): Promise<void>;
}

interface SupportPassportOfflineSyncFileContentInput {
  includeTranscripts?: boolean;
  sourceId: string;
  path: string;
  sha256: string;
  bytes: number;
  mtimeMs: number;
  offset?: number;
  baseSha256?: string;
  content: Buffer;
}

interface SupportPassportOfflineSyncApplyInput {
  changeset: unknown;
  returnCurrentFiles?: boolean;
}

function frontmatterPrefixState(raw: Buffer): "absent" | "present" | "pending" {
  const prefix = raw.subarray(0, Math.min(raw.length, 5)).toString("utf8");
  if (FRONTMATTER_PREFIXES.some((candidate) => prefix.startsWith(candidate))) return "present";
  if (FRONTMATTER_PREFIXES.some((candidate) => candidate.startsWith(prefix))) return "pending";
  return "absent";
}

function completeFrontmatter(raw: Buffer): string | null {
  const text = raw.toString("utf8");
  return /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(text)?.[0] ?? null;
}

function assertFrontmatterAllowed(frontmatter: string, relativePath: string): void {
  if (frontmatter.includes(SUPPORT_PASSPORT_MARKER)) {
    throw new Error(`offline sync cannot modify private support-passport record: ${relativePath}`);
  }
}

function inspectBufferedFrontmatter(
  raw: Buffer,
  relativePath: string,
  endOfFile: boolean,
): FrontmatterDecision {
  const prefixState = frontmatterPrefixState(raw);
  if (prefixState === "absent") return "allow";
  if (prefixState === "pending" && !endOfFile) return "wait";

  const frontmatter = completeFrontmatter(raw);
  if (frontmatter !== null) {
    assertFrontmatterAllowed(frontmatter, relativePath);
    return "allow";
  }
  if (raw.length > MAX_SUPPORT_PASSPORT_FRONTMATTER_BYTES) {
    throw new Error(`offline sync frontmatter is too large: ${relativePath}`);
  }
  if (endOfFile) {
    assertFrontmatterAllowed(raw.toString("utf8"), relativePath);
    return "allow";
  }
  return "wait";
}

async function* guardSupportPassportChunks(
  chunks: AsyncIterable<Buffer>,
  relativePath: string,
): AsyncIterable<Buffer> {
  const buffered: Buffer[] = [];
  let bufferedBytes = 0;
  let passThrough = false;
  for await (const chunk of chunks) {
    if (passThrough) {
      yield chunk;
      continue;
    }
    buffered.push(chunk);
    bufferedBytes += chunk.length;
    const raw = Buffer.concat(buffered, bufferedBytes);
    if (inspectBufferedFrontmatter(raw, relativePath, false) === "wait") continue;
    for (const bufferedChunk of buffered) yield bufferedChunk;
    passThrough = true;
  }
  if (!passThrough && bufferedBytes > 0) {
    const raw = Buffer.concat(buffered, bufferedBytes);
    inspectBufferedFrontmatter(raw, relativePath, true);
    for (const bufferedChunk of buffered) yield bufferedChunk;
  }
}

export function createSupportPassportOfflineSyncGuard(storage: {
  dir: string;
  readMemoryByPath(filePath: string): Promise<MemoryFile | null>;
}) {
  const excludePrivateFile = createSupportPassportPrivateFileExclusion(storage);

  const targetForPath = (relativePath: string): OfflineSyncFileTarget => {
    const normalizedPath = validateArchiveRelativePath(relativePath, "path");
    return {
      root: storage.dir,
      path: normalizedPath,
      filePath: path.resolve(storage.dir, ...normalizedPath.split("/")),
    };
  };

  const assertTargetAllowed = async (target: OfflineSyncFileTarget): Promise<void> => {
    if (await excludePrivateFile(target)) {
      throw new Error(`offline sync cannot modify private support-passport record: ${target.path}`);
    }
  };

  return {
    async assertPathAllowed(relativePath: string): Promise<void> {
      await assertTargetAllowed(targetForPath(relativePath));
    },
    assertContentAllowed(relativePath: string, content: Buffer): void {
      inspectBufferedFrontmatter(content, relativePath, true);
    },
    assertTargetAllowed,
    guardChunks(relativePath: string, chunks: AsyncIterable<Buffer>): AsyncIterable<Buffer> {
      return guardSupportPassportChunks(chunks, relativePath);
    },
    excludePrivateFile,
  };
}

export async function applySupportPassportOfflineSyncFileContent(
  storage: SupportPassportOfflineSyncStorage,
  options: SupportPassportOfflineSyncFileContentInput,
): Promise<OfflineSyncApplyFileContentChunkResult> {
  const guard = createSupportPassportOfflineSyncGuard(storage);
  await guard.assertPathAllowed(options.path);
  return applyOfflineSyncFileContentChunk({
    root: storage.dir,
    sourceId: options.sourceId,
    path: options.path,
    sha256: options.sha256,
    bytes: options.bytes,
    mtimeMs: options.mtimeMs,
    offset: options.offset,
    baseSha256: options.baseSha256,
    content: options.content,
    includeTranscripts: options.includeTranscripts !== false,
    readFile: async ({ filePath }) => storage.readOfflineSyncFile(filePath),
    readFileDigest: async ({ filePath }) => storage.digestOfflineSyncFile(filePath),
    writeFile: async ({ filePath, content }) => storage.writeOfflineSyncFile(filePath, content),
    writeStagingFile: async ({ filePath, content }) => storage.writeOfflineSyncStagingFile(filePath, content),
    writeFileChunks: async (target) => {
      await guard.assertTargetAllowed(target);
      await storage.writeOfflineSyncFileChunks(
        target.filePath,
        guard.guardChunks(target.path, target.chunks),
      );
    },
  });
}

export async function applySupportPassportOfflineSyncChangeset(
  storage: SupportPassportOfflineSyncStorage,
  options: SupportPassportOfflineSyncApplyInput,
): Promise<OfflineSyncApplyChangesetResult> {
  const guard = createSupportPassportOfflineSyncGuard(storage);
  const changeset = normalizeOfflineSyncChangeset(options.changeset);
  for (const change of changeset.changes) {
    await guard.assertPathAllowed(change.path);
    if (change.type === "upsert") {
      guard.assertContentAllowed(change.path, Buffer.from(change.file.contentBase64, "base64"));
    }
  }
  const result = await applyOfflineSyncChangeset({
    root: storage.dir,
    changeset,
    returnCurrentFiles: false,
    readFile: async ({ filePath }) => storage.readOfflineSyncFile(filePath),
    readFileDigest: async ({ filePath }) => storage.digestOfflineSyncFile(filePath),
    writeFile: async (target) => {
      await guard.assertTargetAllowed(target);
      guard.assertContentAllowed(target.path, target.content);
      await storage.writeOfflineSyncFile(target.filePath, target.content);
    },
    deleteFile: async (target) => {
      await guard.assertTargetAllowed(target);
      await storage.deleteOfflineSyncFile(target.filePath, target.mtimeMs ?? null);
    },
    recordDeletionRevision: async ({ filePath, mtimeMs }) =>
      storage.recordReplicatedDeletionRevision(filePath, mtimeMs),
  });
  if (options.returnCurrentFiles === false) return result;

  const current = await buildOfflineSyncSnapshot({
    root: storage.dir,
    sourceId: "local",
    includeContent: false,
    includeTranscripts: changeset.includeTranscripts,
    readFile: async ({ filePath }) => storage.readOfflineSyncFile(filePath),
    readFileDigest: async ({ filePath }) => storage.digestOfflineSyncFile(filePath),
    excludeFile: guard.excludePrivateFile,
  });
  const { currentFiles: _partialFiles, currentFilesComplete: _incomplete, ...counts } = result;
  return { ...counts, currentFiles: current.files };
}
