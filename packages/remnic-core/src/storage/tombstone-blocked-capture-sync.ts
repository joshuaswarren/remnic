import { createHash, randomUUID } from "node:crypto";
import { mkdir, open as openFile, unlink } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { log } from "../logger.js";
import type { MemoryFile, MemoryFrontmatter } from "../types.js";
import { RECALL_FALLBACK_DIRS } from "../utils/category-dir.js";
import { isErrnoCode } from "../utils/errno.js";
import { writeMaybeEncryptedFileFromChunks } from "../secure-store/secure-fs.js";
import {
  buildExplicitCaptureDedupKey,
  captureIdentityHash,
  tombstoneBlocked,
  isQueuedReviewFrontmatter,
  isQueuedReviewMemory,
  runTombstoneBlockedChunkMutation,
  runTombstoneBlockedMutation,
  type TombstoneBlockedMutationHost,
} from "./tombstone-blocked-capture-mutation.js";
import { TombstoneBlockedCaptureIndex } from "./tombstone-blocked-capture-index.js";
import type { TombstoneBlockedCaptureIndexOptions } from "./tombstone-blocked-capture-index.js";

const OFFLINE_SYNC_BUFFER_LIMIT_BYTES = 1_048_576;
const OFFLINE_SYNC_STAGE_READ_BYTES = 64 * 1024;
const OFFLINE_SYNC_FRONTMATTER_LIMIT_BYTES = 128 * 1024;

type StreamedOfflineSyncIdentity = {
  identityHash: string;
};

type PreparedOfflineSyncChunks = {
  after: MemoryFile | null;
  chunks: AsyncIterable<Buffer>;
  stagePath?: string;
  streamedIdentity?: StreamedOfflineSyncIdentity;
};

function createExplicitContentNormalizer(onChunk: (chunk: string) => void): {
  push: (text: string) => void;
  finish: () => void;
} {
  let started = false;
  let pendingSpace = false;
  let output = "";
  const flush = () => {
    if (output.length > 0) {
      onChunk(output);
      output = "";
    }
  };
  return {
    push(text) {
      for (const character of text.toLowerCase()) {
        if (/\s/u.test(character)) {
          if (started) pendingSpace = true;
          continue;
        }
        if (pendingSpace) {
          output += " ";
          pendingSpace = false;
        }
        output += character;
        started = true;
        if (output.length >= OFFLINE_SYNC_STAGE_READ_BYTES) flush();
      }
    },
    finish: flush,
  };
}

async function forEachStagedTextChunk(
  stagePath: string,
  offset: number,
  onText: (text: string) => void
): Promise<void> {
  const handle = await openFile(stagePath, "r");
  const buffer = Buffer.alloc(OFFLINE_SYNC_STAGE_READ_BYTES);
  const decoder = new TextDecoder("utf-8");
  let position = offset;
  try {
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      const text = decoder.decode(buffer.subarray(0, bytesRead), { stream: true });
      if (text.length > 0) onText(text);
    }
    const finalText = decoder.decode();
    if (finalText.length > 0) onText(finalText);
  } finally {
    await handle.close();
  }
}

export type OfflineSyncMemoryParser = (filePath: string, content: Buffer) => MemoryFile | null;

export function parseTombstoneBlockedOfflineSyncMemory(
  filePath: string,
  content: Buffer,
  memoryDir: string,
  parseFrontmatter: (raw: string) => { frontmatter: MemoryFrontmatter; content: string } | null,
  normalizeFrontmatterForPath: (frontmatter: MemoryFrontmatter, pathRel: string, content?: string) => MemoryFrontmatter,
  toMemoryPathRel: (baseDir: string, filePath: string) => string
): MemoryFile | null {
  const parsed = parseFrontmatter(content.toString("utf8"));
  if (!parsed) return null;
  return {
    path: filePath,
    frontmatter: normalizeFrontmatterForPath(parsed.frontmatter, toMemoryPathRel(memoryDir, filePath), parsed.content),
    content: parsed.content,
  };
}

export abstract class TombstoneBlockedCaptureIndexHost {
  private tombstoneBlockedCaptureIndex: TombstoneBlockedCaptureIndex | null = null;
  protected abstract tombstoneBlockedCaptureIndexOptions(): TombstoneBlockedCaptureIndexOptions;
  protected abstract writeStorageSecureFile(
    filePath: string,
    content: string | Buffer,
    forceEncrypt?: boolean
  ): Promise<void>;
  protected abstract assertManagedStoragePath(filePath: string, method: string): string;
  protected abstract notifyCatalogWriteForPath(filePath: string): void;
  protected abstract readMemoryByPath(filePath: string): Promise<MemoryFile | null>;
  protected abstract invalidateAllMemoriesCache(): void;
  protected abstract invalidateKnowledgeIndexCache(): void;
  protected abstract invalidateColdMemoriesCache(): void;
  protected abstract bumpArtifactWriteVersion(): number;
  protected abstract bumpMemoryStatusVersion(): void;
  protected abstract markFactHashIndexNotAuthoritative(): void;

  private async writeStorageSecureFileChunks(filePath: string, chunks: AsyncIterable<Buffer>): Promise<void> {
    const options = this.tombstoneBlockedCaptureIndexOptions();
    await writeMaybeEncryptedFileFromChunks(
      filePath,
      chunks,
      options.secureStoreWriteKeyProvider(),
      {},
      options.memoryDir
    );
    this.notifyCatalogWriteForPath(filePath);
  }

  protected getTombstoneBlockedCaptureIndex(): TombstoneBlockedCaptureIndex {
    if (this.tombstoneBlockedCaptureIndex === null) {
      this.tombstoneBlockedCaptureIndex = new TombstoneBlockedCaptureIndex(this.tombstoneBlockedCaptureIndexOptions());
    }
    return this.tombstoneBlockedCaptureIndex;
  }
  async withTombstoneBlockedCaptureWriteLock<T>(
    task: () => Promise<T>,
    identity?: string | readonly string[]
  ): Promise<T> {
    return await this.getTombstoneBlockedCaptureIndex().withCaptureWriteLock(task, identity);
  }

  protected async withTombstoneBlockedCaptureWriteLockAndHashes<T>(
    task: () => Promise<T>,
    identity: string | readonly string[] | undefined,
    identityHashes: readonly string[]
  ): Promise<T> {
    return await this.getTombstoneBlockedCaptureIndex().withCaptureWriteLockAndHashes(task, identity, identityHashes);
  }

  private async writeTombstoneBlockedMutation(
    blocked: boolean,
    pathname: string,
    fileContent: string,
    identity: string | readonly string[],
    updateIndex: (rebuildMarker?: string, current?: MemoryFile | null) => Promise<void>,
    beforeIndexUpdate?: () => Promise<void>,
    coordinate = false
  ): Promise<void> {
    const host: TombstoneBlockedMutationHost = {
      readCurrent: () => this.readMemoryByPath(pathname),
      isBlocked: (memory) => this.isTombstoneBlockedMemory(memory),
      isQueuedReview: (memory) => isQueuedReviewMemory(memory),
      memoryIdentity: (memory) => this.offlineSyncMemoryIdentity(memory),
      prepareWrite: () => this.getTombstoneBlockedCaptureIndex().prepareWrite(),
      commitWrite: (marker) => this.getTombstoneBlockedCaptureIndex().commitWrite(marker),
      discardWrite: (marker) => this.getTombstoneBlockedCaptureIndex().discardWrite(marker),
      markUntrusted: () => this.getTombstoneBlockedCaptureIndex().markUntrusted(),
      writeStorageSecureFile: (target, content) => this.writeStorageSecureFile(target, content),
      withCaptureWriteLock: (task, lockIdentity) =>
        this.withTombstoneBlockedCaptureWriteLock(task, lockIdentity),
      logWarning: (message) => log.warn(message),
    };
    await runTombstoneBlockedMutation(host, {
      blocked,
      pathname,
      fileContent,
      identity,
      updateIndex,
      beforeIndexUpdate,
      coordinate,
    });
  }

  protected async writeTombstoneBlockedMemory(
    pathname: string,
    fileContent: string,
    frontmatter: MemoryFrontmatter,
    content: string,
    beforeIndexUpdate?: () => Promise<void>
  ): Promise<void> {
    await this.writeTombstoneBlockedMutation(
      tombstoneBlocked(frontmatter),
      pathname,
      fileContent,
      buildExplicitCaptureDedupKey(content, frontmatter.category, frontmatter.sourceConnector),
      (rebuildMarker) =>
        this.getTombstoneBlockedCaptureIndex().addWrittenMemory(pathname, frontmatter, content, rebuildMarker),
      beforeIndexUpdate
    );
  }

  protected async writeTombstoneBlockedChunk(
    pathname: string,
    fileContent: string,
    frontmatter: MemoryFrontmatter,
    content: string,
    findDuplicate: () => Promise<MemoryFile | null>,
    afterWrite: () => Promise<void>
  ): Promise<string> {
    return await runTombstoneBlockedChunkMutation({
      blocked: tombstoneBlocked(frontmatter),
      id: frontmatter.id,
      identity: buildExplicitCaptureDedupKey(content, frontmatter.category, frontmatter.sourceConnector),
      findDuplicate,
      persistMemory: () => this.writeTombstoneBlockedMemory(pathname, fileContent, frontmatter, content),
      afterWrite,
      withCaptureWriteLock: (task, identity) => this.withTombstoneBlockedCaptureWriteLock(task, identity),
    });
  }

  protected async writeTombstoneBlockedUpdate(
    before: MemoryFile,
    fileContent: string,
    frontmatter: MemoryFrontmatter,
    content: string,
    beforeIndexUpdate?: () => Promise<void>
  ): Promise<void> {
    await this.writeTombstoneBlockedMutation(
      tombstoneBlocked(before.frontmatter) || tombstoneBlocked(frontmatter),
      before.path,
      fileContent,
      [
        ...(tombstoneBlocked(before.frontmatter)
          ? [
              buildExplicitCaptureDedupKey(
                before.content,
                before.frontmatter.category,
                before.frontmatter.sourceConnector
              ),
            ]
          : []),
        ...(tombstoneBlocked(frontmatter)
          ? [buildExplicitCaptureDedupKey(content, frontmatter.category, frontmatter.sourceConnector)]
          : []),
        ...(isQueuedReviewMemory(before)
          ? [
              buildExplicitCaptureDedupKey(
                before.content,
                before.frontmatter.category,
                before.frontmatter.sourceConnector
              ),
            ]
          : []),
        ...(isQueuedReviewFrontmatter(frontmatter)
          ? [buildExplicitCaptureDedupKey(content, frontmatter.category, frontmatter.sourceConnector)]
          : []),
      ],
      (rebuildMarker, current) =>
        this.getTombstoneBlockedCaptureIndex().syncUpdatedMemory(
          current ?? before,
          frontmatter,
          content,
          rebuildMarker
        ),
      beforeIndexUpdate,
      isQueuedReviewMemory(before) || isQueuedReviewFrontmatter(frontmatter)
    );
  }

  protected async writeTombstoneBlockedFrontmatter(
    before: MemoryFile,
    fileContent: string,
    frontmatter: MemoryFrontmatter,
    beforeIndexUpdate?: () => Promise<void>
  ): Promise<void> {
    await this.writeTombstoneBlockedMutation(
      tombstoneBlocked(before.frontmatter) || tombstoneBlocked(frontmatter),
      before.path,
      fileContent,
      [
        ...(tombstoneBlocked(before.frontmatter)
          ? [
              buildExplicitCaptureDedupKey(
                before.content,
                before.frontmatter.category,
                before.frontmatter.sourceConnector
              ),
            ]
          : []),
        ...(tombstoneBlocked(frontmatter)
          ? [buildExplicitCaptureDedupKey(before.content, frontmatter.category, frontmatter.sourceConnector)]
          : []),
        ...(isQueuedReviewMemory(before)
          ? [
              buildExplicitCaptureDedupKey(
                before.content,
                before.frontmatter.category,
                before.frontmatter.sourceConnector
              ),
            ]
          : []),
        ...(isQueuedReviewFrontmatter(frontmatter)
          ? [buildExplicitCaptureDedupKey(before.content, frontmatter.category, frontmatter.sourceConnector)]
          : []),
      ],
      (rebuildMarker, current) =>
        this.getTombstoneBlockedCaptureIndex().syncUpdatedFrontmatter(
          current ?? before,
          frontmatter,
          rebuildMarker
        ),
      beforeIndexUpdate,
      isQueuedReviewMemory(before) || isQueuedReviewFrontmatter(frontmatter)
    );
  }

  private isTombstoneBlockedMemory(memory: MemoryFile | null): memory is MemoryFile {
    return memory !== null && memory.frontmatter.status === "pending_review" && Boolean(memory.frontmatter.blockedBy);
  }

  private offlineSyncMemoryIdentity(memory: MemoryFile): string {
    return buildExplicitCaptureDedupKey(
      memory.content,
      memory.frontmatter.category,
      memory.frontmatter.sourceConnector
    );
  }
  private async isDuplicateTombstoneBlockedOfflineSync(
    target: string,
    incoming: MemoryFile,
    streamedIdentity?: StreamedOfflineSyncIdentity
  ): Promise<boolean> {
    const before = await this.readMemoryByPath(target);
    const duplicate = streamedIdentity
      ? true
      : await this.getTombstoneBlockedCaptureIndex().has(
          incoming.content,
          incoming.frontmatter.category,
          incoming.frontmatter.sourceConnector
        );
    if (!duplicate) return false;
    const incomingIdentity = streamedIdentity?.identityHash ?? this.offlineSyncMemoryIdentity(incoming);
    const options = this.tombstoneBlockedCaptureIndexOptions();
    const existing = [...(await options.readAllMemories()), ...(await options.readAllColdMemories())];
    const exactMatch = existing.some(
      (memory) =>
        this.isTombstoneBlockedMemory(memory) &&
        (streamedIdentity ? captureIdentityHash(memory) : this.offlineSyncMemoryIdentity(memory)) === incomingIdentity
    );
    if (!exactMatch) return false;
    if (before === null) return true;
    if (!this.isTombstoneBlockedMemory(before)) return false;
    const beforeIdentity = streamedIdentity ? captureIdentityHash(before) : this.offlineSyncMemoryIdentity(before);
    if (beforeIdentity !== incomingIdentity) return false;
    return streamedIdentity
      ? isDeepStrictEqual(before.frontmatter, incoming.frontmatter)
      : before.content === incoming.content && isDeepStrictEqual(before.frontmatter, incoming.frontmatter);
  }

  private async invalidateAfterOfflineSyncMutation(filePath: string, ownedMarker?: string): Promise<void> {
    this.invalidateAllMemoriesCache();
    this.invalidateKnowledgeIndexCache();
    this.markFactHashIndexNotAuthoritative();
    if (filePath.includes(`${path.sep}cold${path.sep}`)) {
      this.invalidateColdMemoriesCache();
    }
    await this.rebuildTombstoneBlockedCaptureAfterInvalidationForPath(filePath, ownedMarker);
    if (filePath.includes(`${path.sep}artifacts${path.sep}`)) {
      this.bumpArtifactWriteVersion();
    }
    this.bumpMemoryStatusVersion();
  }

  protected async runTombstoneBlockedArchive(
    memory: MemoryFile,
    task: (current: MemoryFile, markDurable: () => void) => Promise<string | null>
  ): Promise<string | null> {
    if (!this.isTombstoneBlockedMemory(memory) && !isQueuedReviewMemory(memory)) {
      return await task(memory, () => {});
    }
    let archivedPath: string | null = null;
    const archived = await this.runTombstoneBlockedInvalidation(
      memory,
      async (current, rebuildMarker, markDurable) => {
        let archiveDurable = false;
        const markArchiveDurable = () => {
          archiveDurable = true;
          markDurable();
        };
        archivedPath = await task(current, markArchiveDurable);
        if (rebuildMarker !== undefined && (archivedPath !== null || archiveDurable)) {
          await this.rebuildTombstoneBlockedCaptureAfterInvalidation(rebuildMarker);
        } else if (rebuildMarker !== undefined) {
          const index = this.getTombstoneBlockedCaptureIndex();
          try { await index.discardWrite(rebuildMarker); } catch { index.markUntrusted(); }
        }
        return archivedPath !== null;
      }
    );
    return archived ? archivedPath : null;
  }

  protected async runTombstoneBlockedInvalidation(
    memory: MemoryFile,
    task: (
      current: MemoryFile,
      rebuildMarker: string | undefined,
      markDurable: () => void
    ) => Promise<boolean>
  ): Promise<boolean> {
    let lockIdentity =
      this.isTombstoneBlockedMemory(memory) || isQueuedReviewMemory(memory)
        ? this.offlineSyncMemoryIdentity(memory)
        : undefined;
    for (;;) {
      const attempt = async () => {
        const options = this.tombstoneBlockedCaptureIndexOptions();
        const current =
          (await options.readAllMemories()).find((candidate) => candidate.frontmatter.id === memory.frontmatter.id) ??
          (await this.readMemoryByPath(memory.path)) ??
          (await options.readAllColdMemories()).find((candidate) => candidate.frontmatter.id === memory.frontmatter.id);
        if (!current) return { result: false };
        const blocked = this.isTombstoneBlockedMemory(current);
        const queuedReview = isQueuedReviewMemory(current);
        if (blocked || queuedReview) {
          const currentIdentity = this.offlineSyncMemoryIdentity(current);
          if (lockIdentity !== currentIdentity) return { retryIdentity: currentIdentity };
        }
        const blockedIndex = blocked ? this.getTombstoneBlockedCaptureIndex() : null;
        let rebuildMarker: string | undefined;
        let durable = false;
        try {
          if (blockedIndex) rebuildMarker = await blockedIndex.prepareWrite();
          const result = await task(current, rebuildMarker, () => {
            durable = true;
          });
          return { result };
        } catch {
          if (rebuildMarker && !durable && blockedIndex) {
            try {
              await blockedIndex.discardWrite(rebuildMarker);
            } catch {
              blockedIndex.markUntrusted();
            }
          }
          return { result: false };
        }
      };
      const result =
        lockIdentity === undefined
          ? await attempt()
          : await this.withTombstoneBlockedCaptureWriteLock(attempt, lockIdentity);
      if (result.retryIdentity !== undefined) {
        lockIdentity = result.retryIdentity;
        continue;
      }
      return result.result;
    }
  }
  protected async runTombstoneBlockedExpiredTTL(
    memory: MemoryFile,
    now: number,
    deleteMemory: (current: MemoryFile, markDurable: () => void) => Promise<void>
  ): Promise<void> {
    await this.runTombstoneBlockedInvalidation(
      memory,
      async (current, rebuildMarker, markDurable) => {
        const expiresAt = current.frontmatter.expiresAt
          ? new Date(current.frontmatter.expiresAt).getTime()
          : Number.NaN;
        if (!Number.isFinite(expiresAt) || expiresAt >= now) return false;
        try {
          await deleteMemory(current, markDurable);
          if (rebuildMarker !== undefined) {
            await this.rebuildTombstoneBlockedCaptureAfterInvalidation(rebuildMarker);
          }
          return true;
        } catch {
          return false;
        }
      }
    );
  }

  protected async runTombstoneBlockedOfflineSyncMutation(
    target: string,
    after: MemoryFile | null,
    write: () => Promise<void>,
    coordinate = false,
    streamedIdentity?: StreamedOfflineSyncIdentity
  ): Promise<void> {
    for (;;) {
      const before = await this.readMemoryByPath(target);
      const targetIdentity = this.isTombstoneBlockedMemory(before)
        ? this.offlineSyncMemoryIdentity(before)
        : undefined;
      const blocked = coordinate || targetIdentity !== undefined || this.isTombstoneBlockedMemory(after);
      const identities = [
        ...(targetIdentity === undefined ? [] : [targetIdentity]),
        ...(!streamedIdentity && this.isTombstoneBlockedMemory(after)
          ? [this.offlineSyncMemoryIdentity(after)]
          : []),
        ...(coordinate ? [target] : []),
        ...(coordinate && after === null && streamedIdentity === undefined ? [""] : []),
      ];
      let retryIdentity: string | undefined;
      const mutate = async (): Promise<void> => {
        const current = await this.readMemoryByPath(target);
        if (this.isTombstoneBlockedMemory(current)) {
          const currentIdentity = this.offlineSyncMemoryIdentity(current);
          if (currentIdentity !== targetIdentity) {
            retryIdentity = currentIdentity;
            return;
          }
        }
        if (
          this.isTombstoneBlockedMemory(after) &&
          (await this.isDuplicateTombstoneBlockedOfflineSync(target, after, streamedIdentity))
        ) {
          return;
        }
        const marker = blocked ? await this.getTombstoneBlockedCaptureIndex().prepareWrite() : undefined;
        let durable = false;
        try {
          await write();
          durable = true;
          if (marker) {
            try {
              await this.getTombstoneBlockedCaptureIndex().commitWrite(marker);
            } catch (err) {
              this.getTombstoneBlockedCaptureIndex().markUntrusted();
              log.warn(`storage.offlineSyncFile committed write marker failed: ${err}`);
            }
          }
          await this.invalidateAfterOfflineSyncMutation(target, marker);
        } catch (err) {
          if (marker && !durable) {
            try {
              await this.getTombstoneBlockedCaptureIndex().discardWrite(marker);
            } catch (cleanupError) {
              this.getTombstoneBlockedCaptureIndex().markUntrusted();
              log.warn(`storage.offlineSyncFile failed to clear write marker: ${cleanupError}`);
            }
          }
          throw err;
        }
      };
      if (!blocked) {
        await mutate();
      } else {
        if (streamedIdentity) {
          await this.withTombstoneBlockedCaptureWriteLockAndHashes(
            mutate,
            identities,
            [streamedIdentity.identityHash]
          );
        } else {
          await this.withTombstoneBlockedCaptureWriteLock(mutate, identities);
        }
      }
      if (retryIdentity !== undefined) continue;
      return;
    }
  }

  protected async writeTombstoneBlockedOfflineSyncFile(target: string, content: Buffer): Promise<void> {
    await this.runTombstoneBlockedOfflineSyncMutation(
      target,
      this.tombstoneBlockedCaptureIndexOptions().parseMemory?.(target, content) ?? null,
      () => this.writeStorageSecureFile(target, content)
    );
  }

  private async prepareTombstoneBlockedOfflineSyncChunks(
    target: string,
    chunks: AsyncIterable<Buffer>
  ): Promise<PreparedOfflineSyncChunks> {
    const parseMemory = this.tombstoneBlockedCaptureIndexOptions().parseMemory;
    if (!parseMemory) return { after: null, chunks };

    const iterator = chunks[Symbol.asyncIterator]();
    const buffered: Buffer[] = [];
    let bufferedBytes = 0;
    let stagePath: string | undefined;
    let stageHandle: Awaited<ReturnType<typeof openFile>> | null = null;
    const writeStageChunk = async (chunk: Buffer): Promise<void> => {
      if (stageHandle === null) {
        const stageDir = path.join(
          this.tombstoneBlockedCaptureIndexOptions().stateDir,
          "tombstone-blocked-capture",
          "offline-sync-staging"
        );
        await mkdir(stageDir, { recursive: true });
        stagePath = path.join(stageDir, `${randomUUID()}.stage`);
        stageHandle = await openFile(stagePath, "w", 0o600);
        for (const prior of buffered) await stageHandle.write(prior);
        buffered.length = 0;
      }
      await stageHandle.write(chunk);
    };

    try {
      for (;;) {
        const next = await iterator.next();
        if (next.done) break;
        bufferedBytes += next.value.length;
        if (stageHandle !== null || bufferedBytes > OFFLINE_SYNC_BUFFER_LIMIT_BYTES) {
          await writeStageChunk(next.value);
        } else {
          buffered.push(next.value);
        }
      }
    } catch (err) {
      const failedStageHandle = stageHandle as Awaited<ReturnType<typeof openFile>> | null;
      if (failedStageHandle !== null) await failedStageHandle.close().catch(() => {});
      if (stagePath !== undefined) await unlink(stagePath).catch(() => {});
      throw err;
    }
    const completedStageHandle = stageHandle as Awaited<ReturnType<typeof openFile>> | null;
    if (completedStageHandle !== null) await completedStageHandle.close();
    if (stagePath === undefined) {
      let after: MemoryFile | null = null;
      try {
        after = parseMemory(target, Buffer.concat(buffered));
      } catch {
        after = null;
      }
      const replay = (async function* (): AsyncIterable<Buffer> {
        for (const chunk of buffered) yield chunk;
      })();
      return { after, chunks: replay };
    }
    try {
      return await this.describeStagedOfflineSyncChunks(target, stagePath, parseMemory);
    } catch (err) {
      await unlink(stagePath).catch(() => {});
      throw err;
    }
  }

  private async describeStagedOfflineSyncChunks(
    target: string,
    stagePath: string,
    parseMemory: OfflineSyncMemoryParser
  ): Promise<PreparedOfflineSyncChunks> {
    const handle = await openFile(stagePath, "r");
    const prefix = Buffer.alloc(OFFLINE_SYNC_FRONTMATTER_LIMIT_BYTES);
    let bytesRead = 0;
    try {
      ({ bytesRead } = await handle.read(prefix, 0, prefix.length, 0));
    } finally {
      await handle.close();
    }
    const delimiter = Buffer.from("\n---\n", "utf8");
    const delimiterStart = prefix.subarray(0, bytesRead).indexOf(delimiter, 4);
    if (delimiterStart < 0) {
      return { after: null, chunks: this.readStagedOfflineSyncChunks(stagePath), stagePath };
    }
    const bodyOffset = delimiterStart + delimiter.length;
    let after: MemoryFile | null = null;
    try {
      after = parseMemory(target, prefix.subarray(0, bodyOffset));
    } catch {
      after = null;
    }
    if (after === null) {
      return { after: null, chunks: this.readStagedOfflineSyncChunks(stagePath), stagePath };
    }
    const streamedIdentity = await this.computeStagedOfflineSyncIdentity(stagePath, bodyOffset, after);
    return {
      after,
      chunks: this.readStagedOfflineSyncChunks(stagePath),
      stagePath,
      streamedIdentity,
    };
  }

  private async computeStagedOfflineSyncIdentity(
    stagePath: string,
    bodyOffset: number,
    after: MemoryFile
  ): Promise<StreamedOfflineSyncIdentity> {
    let normalizedLength = 0;
    const countNormalizer = createExplicitContentNormalizer((chunk) => {
      normalizedLength += chunk.length;
    });
    await forEachStagedTextChunk(stagePath, bodyOffset, (text) => countNormalizer.push(text));
    countNormalizer.finish();

    const category = after.frontmatter.category;
    const connector = after.frontmatter.sourceConnector?.trim() ?? "";
    const encode = (label: string, value: string): string => `${label} ${value.length} ${value}`;
    const identityPrefix =
      [encode("category", category), encode("connector", connector), `content ${normalizedLength} `].join(" ");
    const identityHash = createHash("sha256");
    identityHash.update(identityPrefix);
    const identityNormalizer = createExplicitContentNormalizer((chunk) => identityHash.update(chunk));
    await forEachStagedTextChunk(stagePath, bodyOffset, (text) => identityNormalizer.push(text));
    identityNormalizer.finish();
    return {
      identityHash: identityHash.digest("hex"),
    };
  }

  private async *readStagedOfflineSyncChunks(stagePath: string): AsyncIterable<Buffer> {
    const handle = await openFile(stagePath, "r");
    const buffer = Buffer.alloc(OFFLINE_SYNC_STAGE_READ_BYTES);
    try {
      for (;;) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
        if (bytesRead === 0) break;
        yield Buffer.from(buffer.subarray(0, bytesRead));
      }
    } finally {
      await handle.close();
    }
  }

  protected async writeTombstoneBlockedOfflineSyncFileChunks(
    target: string,
    chunks: AsyncIterable<Buffer>
  ): Promise<void> {
    const coordinate = this.getTombstoneBlockedCaptureIndex().shouldRebuildAfterInvalidationForPath(target);
    const prepared: PreparedOfflineSyncChunks = coordinate
      ? await this.prepareTombstoneBlockedOfflineSyncChunks(target, chunks)
      : { after: null, chunks };
    const streamedIdentity = prepared.streamedIdentity;
    const mutate = async (): Promise<void> => {
      try {
        await this.runTombstoneBlockedOfflineSyncMutation(
          target,
          prepared.after,
          () => this.writeStorageSecureFileChunks(target, prepared.chunks),
          coordinate,
          streamedIdentity
        );
      } finally {
        if (prepared.stagePath !== undefined) await unlink(prepared.stagePath).catch(() => {});
      }
    };
    await mutate();
  }

  async writeOfflineSyncFile(filePath: string, content: Buffer): Promise<void> {
    const target = this.assertManagedStoragePath(filePath, "storage.writeOfflineSyncFile");
    await this.writeTombstoneBlockedOfflineSyncFile(target, content);
  }

  async writeOfflineSyncFileChunks(filePath: string, chunks: AsyncIterable<Buffer>): Promise<void> {
    const target = this.assertManagedStoragePath(filePath, "storage.writeOfflineSyncFileChunks");
    await this.writeTombstoneBlockedOfflineSyncFileChunks(target, chunks);
  }

  async deleteOfflineSyncFile(filePath: string): Promise<void> {
    const target = this.assertManagedStoragePath(filePath, "storage.deleteOfflineSyncFile");
    await this.deleteTombstoneBlockedOfflineSyncFile(target);
  }

  protected async deleteTombstoneBlockedOfflineSyncFile(target: string): Promise<void> {
    await this.runTombstoneBlockedOfflineSyncMutation(target, null, async () => {
      await unlink(target).catch((error: unknown) => {
        if (isErrnoCode(error, "ENOENT")) return;
        throw error;
      });
    });
  }

  async checkTombstoneBlockedExplicitCapture(
    ...args: [string, string, string?]
  ): Promise<{ has: boolean; authoritative: boolean }> {
    return this.getTombstoneBlockedCaptureIndex().check(...args);
  }

  async hasTombstoneBlockedExplicitCapture(...args: [string, string, string?]): Promise<boolean> {
    return this.getTombstoneBlockedCaptureIndex().has(...args);
  }

  async isTombstoneBlockedExplicitCaptureIndexAuthoritative(): Promise<boolean> {
    return this.getTombstoneBlockedCaptureIndex().isAuthoritative();
  }

  protected async rebuildTombstoneBlockedCaptureAfterInvalidationForPath(
    filePath: string,
    ownedMarker?: string
  ): Promise<void> {
    const index = this.getTombstoneBlockedCaptureIndex();
    if (index.shouldRebuildAfterInvalidationForPath(filePath)) {
      await this.rebuildTombstoneBlockedCaptureAfterInvalidation(ownedMarker);
    }
  }
  protected async rebuildTombstoneBlockedCaptureAfterInvalidation(ownedMarker?: string): Promise<void> {
    await this.getTombstoneBlockedCaptureIndex().rebuildAfterInvalidation(ownedMarker);
  }
}
