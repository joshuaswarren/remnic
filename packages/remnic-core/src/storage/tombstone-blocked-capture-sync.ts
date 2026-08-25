import { createHash, randomUUID, type Hash } from "node:crypto";
import { unlink } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { log } from "../logger.js";
import type { MemoryFile, MemoryFrontmatter } from "../types.js";
import { markProjectedMemoryPathInvalid } from "../memory-projection-store.js";
import { pathMayCarryEntityRefs, requestEntityCanonicalIdReconcile } from "./entity-canonical-id-references.js";
import { withRawEntityPageMutation } from "./entity-canonical-id-lock.js";
import { readMaybeEncryptedFileFromChunks, writeMaybeEncryptedFileFromChunks } from "../secure-store/secure-fs.js";
import * as archiveMutation from "../archive-mutation-version.js";
import { invalidationCommitFingerprint, isSemanticFrontmatterChange } from "./deletion-revision-store.js";
import type { CasRevisionTransaction } from "./cas-revision-store.js";
import {
  buildExplicitCaptureDedupKey,
  buildCapturePathLockIdentity,
  captureIdentityHash,
  tombstoneBlocked,
  isQueuedReviewMemory,
  runTombstoneBlockedMutation,
  type TombstoneBlockedMutationHost,
} from "./tombstone-blocked-capture-mutation.js";
import { TombstoneBlockedCaptureIndex } from "./tombstone-blocked-capture-index.js";
import type { TombstoneBlockedCaptureIndexOptions } from "./tombstone-blocked-capture-index.js";

const OFFLINE_SYNC_BUFFER_LIMIT_BYTES = 1_048_576;
const OFFLINE_SYNC_STAGE_READ_BYTES = 64 * 1024;
const OFFLINE_SYNC_FRONTMATTER_DELIMITER = Buffer.from("\n---\n", "utf8");

const CASED_CHARACTER = /\p{Cased}/u;
const CASE_IGNORABLE_CHARACTER = /\p{Case_Ignorable}/u;

type StreamedOfflineSyncIdentity = {
  identityHash: string;
};

type PreparedOfflineSyncChunks = {
  after: MemoryFile | null;
  chunks: AsyncIterable<Buffer>;
  stagePath?: string;
  streamedIdentity?: StreamedOfflineSyncIdentity;
};

type ExplicitContentNormalizerSink = {
  write: (chunk: string) => void;
  beginConditionalSigma: () => void;
  resolveConditionalSigma: (useFinalSigma: boolean) => void;
};

function createExplicitContentNormalizer(sink: ExplicitContentNormalizerSink): {
  push: (text: string) => void;
  finish: () => void;
} {
  let started = false;
  let pendingSpace = false;
  let output = "";
  let precededByCased = false;
  let pendingSigma = false;
  const flush = () => {
    if (output.length > 0) {
      sink.write(output);
      output = "";
    }
  };
  const emit = (text: string) => {
    for (const character of text) {
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
  };
  const resolveSigma = (followedByCased: boolean) => {
    flush();
    sink.resolveConditionalSigma(!followedByCased);
    pendingSigma = false;
  };
  const push = (text: string) => {
    for (const character of text) {
      const caseIgnorable = CASE_IGNORABLE_CHARACTER.test(character);
      const cased = CASED_CHARACTER.test(character);
      if (pendingSigma) {
        if (caseIgnorable) {
          emit(character.toLowerCase());
          continue;
        }
        resolveSigma(cased);
      }
      if (character === "Σ" && precededByCased) {
        flush();
        sink.beginConditionalSigma();
        pendingSigma = true;
        precededByCased = true;
        continue;
      }
      emit(character.toLowerCase());
      if (!caseIgnorable) precededByCased = cased;
    }
  };
  return {
    push,
    finish() {
      if (pendingSigma) resolveSigma(false);
      flush();
    },
  };
}

async function forEachStagedTextChunk(
  stagePath: string,
  offset: number,
  onText: (text: string) => void,
  key: Buffer | null,
  memoryDir: string
): Promise<void> {
  const decoder = new TextDecoder("utf-8");
  let remaining = offset;
  for await (const chunk of readMaybeEncryptedFileFromChunks(stagePath, key, memoryDir)) {
    const textChunk = remaining >= chunk.length ? null : chunk.subarray(remaining);
    remaining = Math.max(0, remaining - chunk.length);
    if (textChunk === null || textChunk.length === 0) continue;
    const text = decoder.decode(textChunk, { stream: true });
    if (text.length > 0) onText(text);
  }
  const finalText = decoder.decode();
  if (finalText.length > 0) onText(finalText);
}

async function findStagedBodyOffset(stagePath: string, key: Buffer | null, memoryDir: string): Promise<number | null> {
  let scannedBytes = 0;
  let tail = Buffer.alloc(0);
  for await (const chunk of readMaybeEncryptedFileFromChunks(stagePath, key, memoryDir)) {
    const window = tail.length > 0 ? Buffer.concat([tail, chunk]) : chunk;
    const windowStart = scannedBytes - tail.length;
    for (let searchFrom = 0; ; ) {
      const delimiterStart = window.indexOf(OFFLINE_SYNC_FRONTMATTER_DELIMITER, searchFrom);
      if (delimiterStart < 0) break;
      if (windowStart + delimiterStart >= 4) {
        return windowStart + delimiterStart + OFFLINE_SYNC_FRONTMATTER_DELIMITER.length;
      }
      searchFrom = delimiterStart + 1;
    }
    scannedBytes += chunk.length;
    const tailLength = Math.min(OFFLINE_SYNC_FRONTMATTER_DELIMITER.length - 1, window.length);
    tail = Buffer.from(window.subarray(window.length - tailLength));
  }
  return null;
}

async function readStagedPrefix(
  stagePath: string,
  byteLimit: number,
  key: Buffer | null,
  memoryDir: string
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytesRead = 0;
  for await (const chunk of readMaybeEncryptedFileFromChunks(stagePath, key, memoryDir)) {
    const length = Math.min(chunk.length, byteLimit - bytesRead);
    if (length > 0) chunks.push(chunk.subarray(0, length));
    bytesRead += length;
    if (bytesRead >= byteLimit) break;
  }
  return Buffer.concat(chunks, bytesRead);
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
  protected abstract bumpMemoryCorpusVersion(): void;
  protected abstract markFactHashIndexNotAuthoritative(): void;
  protected abstract deleteManagedStorageFile(filePath: string, deletionMtimeMs?: number | null): Promise<boolean>;
  protected abstract writeManagedStorageFile(filePath: string, write: () => Promise<void>): Promise<void>;

  /** #2813 (P1 C, #2807): reserve the target's next durable CAS revision
   * token as a two-phase receipt transaction — a PENDING write-ahead
   * marker under the mutation's path lock, published COMMITTED only after
   * the durable file write lands. Receipt identity lives in the per-target
   * sidecar, never in public `frontmatter.updated`. The default host keeps
   * no receipt identity; StorageManager records it. */
  protected async beginDurableMemoryRevision(_pathname: string, _expectedContent?: string | Buffer | null): Promise<CasRevisionTransaction | undefined> {
    return undefined;
  }

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

  /** Read selected memories while their mutation locks remain held. */
  async readMemorySnapshotsIfUnchanged(expected: readonly MemoryFile[]): Promise<MemoryFile[] | null> {
    return await this.withMemorySnapshotsIfUnchanged(expected, async (memories) => memories);
  }

  async withMemorySnapshotsIfUnchanged<T>(
    expected: readonly MemoryFile[],
    task: (memories: MemoryFile[]) => Promise<T>
  ): Promise<T | null> {
    if (expected.length === 0) return await task([]);
    const pathnames = [...new Set(expected.map((memory) => memory.path))];
    if (pathnames.length !== expected.length) return null;
    return await this.withTombstoneBlockedCaptureWriteLock(async () => {
      const current = await Promise.all(pathnames.map((pathname) => this.readMemoryByPath(pathname)));
      for (let index = 0; index < expected.length; index += 1) {
        const actual = current[index];
        const snapshot = expected[index];
        if (
          !actual ||
          !snapshot ||
          actual.frontmatter.id !== snapshot.frontmatter.id ||
          invalidationCommitFingerprint(actual) !== invalidationCommitFingerprint(snapshot)
        ) {
          return null;
        }
      }
      return await task(current as MemoryFile[]);
    }, pathnames.map(buildCapturePathLockIdentity));
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
    coordinate = false,
    shouldMintRevision?: (current: MemoryFile | null) => boolean
  ): Promise<string | undefined> {
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
      withCaptureWriteLock: (task, lockIdentity) => this.withTombstoneBlockedCaptureWriteLock(task, lockIdentity),
      logWarning: (message) => log.warn(message),
      beginDurableMemoryRevision: (targetPath, expectedContent) =>
        this.beginDurableMemoryRevision(targetPath, expectedContent),
    };
    return await runTombstoneBlockedMutation(host, {
      blocked,
      pathname,
      fileContent,
      identity,
      updateIndex,
      beforeIndexUpdate,
      coordinate,
      shouldMintRevision,
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
      [
        buildCapturePathLockIdentity(pathname),
        buildExplicitCaptureDedupKey(content, frontmatter.category, frontmatter.sourceConnector),
      ],
      (rebuildMarker) =>
        this.getTombstoneBlockedCaptureIndex().addWrittenMemory(pathname, frontmatter, content, rebuildMarker),
      beforeIndexUpdate
    );
  }

  protected async withTombstoneBlockedMemoryPathLock<T>(
    pathname: string,
    task: (current: MemoryFile | null) => Promise<T>,
    additionalPathnames: readonly string[] = []
  ): Promise<T> {
    let lockIdentities = [pathname, ...additionalPathnames].map(buildCapturePathLockIdentity);
    for (;;) {
      let retryIdentity: string | undefined;
      let result: T | undefined;
      await this.withTombstoneBlockedCaptureWriteLock(async () => {
        const current = await this.readMemoryByPath(pathname);
        if (current !== null) {
          const currentIdentity = this.offlineSyncMemoryIdentity(current);
          if (!lockIdentities.includes(currentIdentity)) {
            retryIdentity = currentIdentity;
            return;
          }
        }
        result = await task(current);
      }, lockIdentities);
      if (retryIdentity !== undefined) {
        lockIdentities = [...new Set([...lockIdentities, retryIdentity])];
        continue;
      }
      return result!;
    }
  }

  protected async writeTombstoneBlockedChunk(
    pathname: string,
    fileContent: string,
    frontmatter: MemoryFrontmatter,
    content: string,
    findDuplicate: () => Promise<MemoryFile | null>,
    afterWrite: (current: MemoryFile | null) => Promise<void>
  ): Promise<string> {
    const incomingIdentity = buildExplicitCaptureDedupKey(content, frontmatter.category, frontmatter.sourceConnector);
    let lockIdentities = [buildCapturePathLockIdentity(pathname), incomingIdentity];
    for (;;) {
      let retryIdentity: string | undefined;
      let result = frontmatter.id;
      await this.withTombstoneBlockedCaptureWriteLock(async () => {
        const current = await this.readMemoryByPath(pathname);
        if (current !== null) {
          const currentIdentity = this.offlineSyncMemoryIdentity(current);
          if (!lockIdentities.includes(currentIdentity)) {
            retryIdentity = currentIdentity;
            return;
          }
        }
        if (tombstoneBlocked(frontmatter)) {
          const duplicate = await findDuplicate();
          if (duplicate) {
            result = duplicate.frontmatter.id;
            return;
          }
        }
        await this.writeTombstoneBlockedMemory(pathname, fileContent, frontmatter, content);
        await afterWrite(current);
      }, lockIdentities);
      if (retryIdentity === undefined) return result;
      lockIdentities = [...new Set([...lockIdentities, retryIdentity])];
    }
  }

  protected async writeTombstoneBlockedUpdate(
    before: MemoryFile,
    fileContent: string,
    frontmatter: MemoryFrontmatter,
    content: string,
    beforeIndexUpdate?: () => Promise<void>
  ): Promise<string | undefined> {
    return await this.writeTombstoneBlockedMutation(
      tombstoneBlocked(before.frontmatter) || tombstoneBlocked(frontmatter),
      before.path,
      fileContent,
      [
        buildCapturePathLockIdentity(before.path),
        this.offlineSyncMemoryIdentity(before),
        buildExplicitCaptureDedupKey(content, frontmatter.category, frontmatter.sourceConnector),
      ],
      (rebuildMarker, current) =>
        this.getTombstoneBlockedCaptureIndex().syncUpdatedMemory(
          current ?? before,
          frontmatter,
          content,
          rebuildMarker
        ),
      beforeIndexUpdate,
      true,
      () => true
    );
  }

  protected async writeTombstoneBlockedFrontmatter(
    before: MemoryFile,
    fileContent: string,
    frontmatter: MemoryFrontmatter,
    beforeIndexUpdate?: () => Promise<void>
  ): Promise<string | undefined> {
    return await this.writeTombstoneBlockedMutation(
      tombstoneBlocked(before.frontmatter) || tombstoneBlocked(frontmatter),
      before.path,
      fileContent,
      [
        buildCapturePathLockIdentity(before.path),
        this.offlineSyncMemoryIdentity(before),
        buildExplicitCaptureDedupKey(before.content, frontmatter.category, frontmatter.sourceConnector),
      ],
      (rebuildMarker, current) =>
        this.getTombstoneBlockedCaptureIndex().syncUpdatedFrontmatter(current ?? before, frontmatter, rebuildMarker),
      beforeIndexUpdate,
      true,
      (current) => isSemanticFrontmatterChange((current ?? before).frontmatter, frontmatter)
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

  private async invalidateAfterOfflineSyncMutation(
    filePath: string,
    ownedMarker?: string,
    archiveChanged = true,
    blockedKeySetMayHaveChanged = true
  ): Promise<void> {
    this.invalidateAllMemoriesCache();
    this.invalidateKnowledgeIndexCache();
    this.markFactHashIndexNotAuthoritative();
    if (filePath.includes(`${path.sep}cold${path.sep}`)) {
      this.invalidateColdMemoriesCache();
    }
    if (blockedKeySetMayHaveChanged) {
      await this.rebuildTombstoneBlockedCaptureAfterInvalidationForPath(filePath, ownedMarker);
    } else if (ownedMarker !== undefined) {
      // The index only holds tombstone-blocked explicit-capture keys, so a
      // write where neither side is blocked cannot have changed it. Rebuilding
      // here re-reads the whole corpus per replicated file — measured 15-31s
      // per write against a ~190k-file corpus, which turns a boot-scale
      // `converge apply` into a multi-week run. Clear the committed marker and
      // keep the index as-is.
      try {
        await this.getTombstoneBlockedCaptureIndex().clearCommittedWriteMarker(ownedMarker);
      } catch (err) {
        this.getTombstoneBlockedCaptureIndex().markUntrusted();
        log.warn(`storage.offlineSyncFile committed write succeeded; marker cleanup failed: ${err}`);
      }
    }
    if (filePath.includes(`${path.sep}artifacts${path.sep}`)) {
      this.bumpArtifactWriteVersion();
    }
    const memoryDir = this.tombstoneBlockedCaptureIndexOptions().memoryDir;
    archiveMutation.bumpArchiveMutationForPath(memoryDir, archiveChanged, filePath);
    this.bumpMemoryStatusVersion();
  }

  protected async runTombstoneBlockedArchive(
    memory: MemoryFile,
    task: (current: MemoryFile, markDurable: () => void) => Promise<string | null>
  ): Promise<string | null> {
    let archivedPath: string | null = null;
    const archived = await this.runTombstoneBlockedInvalidation(memory, async (current, rebuildMarker, markDurable) => {
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
        try {
          await index.discardWrite(rebuildMarker);
        } catch {
          index.markUntrusted();
        }
      }
      return archivedPath !== null;
    });
    return archived ? archivedPath : null;
  }

  protected async runTombstoneBlockedInvalidation(
    memory: MemoryFile,
    task: (current: MemoryFile, rebuildMarker: string | undefined, markDurable: () => void) => Promise<boolean>,
    propagateErrors = false,
    coordinate = false
  ): Promise<boolean> {
    let lockIdentities = [
      buildCapturePathLockIdentity(memory.path),
      ...(coordinate || this.isTombstoneBlockedMemory(memory) || isQueuedReviewMemory(memory)
        ? [this.offlineSyncMemoryIdentity(memory)]
        : []),
    ];
    for (;;) {
      const attempt = async () => {
        const options = this.tombstoneBlockedCaptureIndexOptions();
        const current =
          (await this.readMemoryByPath(memory.path)) ??
          (await options.readAllMemories()).find((candidate) => candidate.frontmatter.id === memory.frontmatter.id) ??
          (await options.readAllColdMemories()).find((candidate) => candidate.frontmatter.id === memory.frontmatter.id);
        if (!current) return { result: false };
        const blocked = this.isTombstoneBlockedMemory(current);
        const queuedReview = isQueuedReviewMemory(current);
        if (blocked || queuedReview) {
          const currentIdentity = this.offlineSyncMemoryIdentity(current);
          if (!lockIdentities.includes(currentIdentity)) return { retryIdentity: currentIdentity };
        }
        const blockedIndex = blocked ? this.getTombstoneBlockedCaptureIndex() : null;
        let rebuildMarker: string | undefined;
        let durable = false;
        try {
          if (blockedIndex) rebuildMarker = await blockedIndex.prepareWrite();
          const result = await task(current, rebuildMarker, () => {
            durable = true;
          });
          if (!result && rebuildMarker && !durable && blockedIndex) {
            try {
              await blockedIndex.discardWrite(rebuildMarker);
            } catch {
              blockedIndex.markUntrusted();
            }
          }
          return { result };
        } catch (error) {
          if (rebuildMarker && !durable && blockedIndex) {
            try {
              await blockedIndex.discardWrite(rebuildMarker);
            } catch {
              blockedIndex.markUntrusted();
            }
          }
          if (propagateErrors) throw error;
          return { result: false };
        }
      };
      const result = await this.withTombstoneBlockedCaptureWriteLock(attempt, lockIdentities);
      if (result.retryIdentity !== undefined) {
        lockIdentities = [...new Set([...lockIdentities, result.retryIdentity])];
        continue;
      }
      return result.result;
    }
  }
  async deleteMemoryForMaintenance(
    memory: MemoryFile,
    shouldDelete: (current: MemoryFile) => boolean = () => true
  ): Promise<MemoryFile | null> {
    let deleted: MemoryFile | null = null;
    const removed = await this.runTombstoneBlockedInvalidation(
      memory,
      async (current, rebuildMarker, markDurable) => {
        if (!shouldDelete(current)) return false;
        if (!(await this.deleteManagedStorageFile(current.path))) return false;
        markDurable();
        deleted = current;
        const memoryDir = this.tombstoneBlockedCaptureIndexOptions().memoryDir;
        archiveMutation.bumpArchiveMutationForPath(memoryDir, true, current.path);
        markProjectedMemoryPathInvalid(memoryDir, current.frontmatter.id);
        this.invalidateAllMemoriesCache();
        if (current.path.includes(`${path.sep}cold${path.sep}`)) {
          this.invalidateColdMemoriesCache();
        }
        await this.rebuildTombstoneBlockedCaptureAfterInvalidation(rebuildMarker);
        this.bumpMemoryCorpusVersion();
        this.bumpMemoryStatusVersion();
        return true;
      },
      true,
      true
    );
    return removed ? deleted : null;
  }

  protected async runTombstoneBlockedOfflineSyncMutation(
    target: string,
    after: MemoryFile | null,
    write: () => Promise<boolean | void>,
    coordinate = false,
    streamedIdentity?: StreamedOfflineSyncIdentity
  ): Promise<void> {
    for (;;) {
      const before = await this.readMemoryByPath(target);
      const targetIdentity = before === null ? undefined : this.offlineSyncMemoryIdentity(before);
      const afterIdentity = after === null || streamedIdentity ? undefined : this.offlineSyncMemoryIdentity(after);
      const mustCoordinate =
        coordinate || targetIdentity !== undefined || afterIdentity !== undefined || streamedIdentity !== undefined;
      const identities = [
        ...(mustCoordinate ? [buildCapturePathLockIdentity(target)] : []),
        ...(targetIdentity === undefined ? [] : [targetIdentity]),
        ...(afterIdentity === undefined ? [] : [afterIdentity]),
      ];
      let retryIdentity: string | undefined;
      const mutate = async (): Promise<void> => {
        const current = await this.readMemoryByPath(target);
        if (current !== null) {
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
        const affectsBlockedIndex =
          coordinate || this.isTombstoneBlockedMemory(current) || this.isTombstoneBlockedMemory(after);
        const marker = affectsBlockedIndex ? await this.getTombstoneBlockedCaptureIndex().prepareWrite() : undefined;
        let durable = false;
        try {
          const changed = await write();
          durable = true;
          if (marker) {
            try {
              await this.getTombstoneBlockedCaptureIndex().commitWrite(marker);
            } catch (err) {
              this.getTombstoneBlockedCaptureIndex().markUntrusted();
              log.warn(`storage.offlineSyncFile committed write marker failed: ${err}`);
            }
          }
          await this.invalidateAfterOfflineSyncMutation(
            target,
            marker,
            changed !== false,
            this.isTombstoneBlockedMemory(current) || this.isTombstoneBlockedMemory(after)
          );
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
      if (!mustCoordinate) {
        await mutate();
      } else if (streamedIdentity) {
        await this.withTombstoneBlockedCaptureWriteLockAndHashes(mutate, identities, [streamedIdentity.identityHash]);
      } else {
        await this.withTombstoneBlockedCaptureWriteLock(mutate, identities);
      }
      if (retryIdentity !== undefined) continue;
      return;
    }
  }

  protected async writeTombstoneBlockedOfflineSyncFile(target: string, content: Buffer): Promise<void> {
    const options = this.tombstoneBlockedCaptureIndexOptions();
    const after = options.parseMemory?.(target, content) ?? null;
    await withRawEntityPageMutation(path.dirname(options.stateDir), target, async () => {
      await this.runTombstoneBlockedOfflineSyncMutation(target, after, () =>
        this.writeManagedStorageFile(target, () => this.writeStorageSecureFile(target, content))
      );
    });
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
    let firstOverflow: Buffer | undefined;
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      if (bufferedBytes + next.value.length > OFFLINE_SYNC_BUFFER_LIMIT_BYTES) {
        firstOverflow = next.value;
        break;
      }
      bufferedBytes += next.value.length;
      buffered.push(next.value);
    }
    const overflow = firstOverflow;
    if (overflow === undefined) {
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

    const options = this.tombstoneBlockedCaptureIndexOptions();
    const stagePath = path.join(
      options.stateDir,
      "tombstone-blocked-capture",
      "offline-sync-staging",
      `${randomUUID()}.stage`
    );
    const stagedChunks = (async function* (): AsyncIterable<Buffer> {
      for (const chunk of buffered) yield chunk;
      yield overflow;
      for (;;) {
        const next = await iterator.next();
        if (next.done) break;
        yield next.value;
      }
    })();
    try {
      await writeMaybeEncryptedFileFromChunks(
        stagePath,
        stagedChunks,
        options.secureStoreWriteKeyProvider(),
        { atomic: false },
        options.memoryDir
      );
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
    const options = this.tombstoneBlockedCaptureIndexOptions();
    const key = options.secureStoreKeyProvider();
    const bodyOffset = await findStagedBodyOffset(stagePath, key, options.memoryDir);
    if (bodyOffset === null) {
      return { after: null, chunks: this.readStagedOfflineSyncChunks(stagePath), stagePath };
    }
    const prefix = await readStagedPrefix(stagePath, bodyOffset, key, options.memoryDir);
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
    const countNormalizer = createExplicitContentNormalizer({
      write: (chunk) => {
        normalizedLength += chunk.length;
      },
      beginConditionalSigma: () => {
        normalizedLength += 1;
      },
      resolveConditionalSigma: () => {},
    });
    const options = this.tombstoneBlockedCaptureIndexOptions();
    const key = options.secureStoreKeyProvider();
    await forEachStagedTextChunk(stagePath, bodyOffset, (text) => countNormalizer.push(text), key, options.memoryDir);
    countNormalizer.finish();

    const category = after.frontmatter.category;
    const connector = after.frontmatter.sourceConnector?.trim() ?? "";
    const encode = (label: string, value: string): string => `${label} ${value.length} ${value}`;
    const identityPrefix = [
      encode("category", category),
      encode("connector", connector),
      `content ${normalizedLength} `,
    ].join(" ");
    let identityHash = createHash("sha256");
    let normalSigmaIdentityHash: Hash | undefined;
    identityHash.update(identityPrefix);
    const identityNormalizer = createExplicitContentNormalizer({
      write: (chunk) => {
        identityHash.update(chunk);
        normalSigmaIdentityHash?.update(chunk);
      },
      beginConditionalSigma: () => {
        normalSigmaIdentityHash = identityHash.copy().update("σ");
        identityHash.update("ς");
      },
      resolveConditionalSigma: (useFinalSigma) => {
        if (!useFinalSigma) {
          if (normalSigmaIdentityHash === undefined) throw new Error("conditional sigma hash state is missing");
          identityHash = normalSigmaIdentityHash;
        }
        normalSigmaIdentityHash = undefined;
      },
    });
    await forEachStagedTextChunk(
      stagePath,
      bodyOffset,
      (text) => identityNormalizer.push(text),
      key,
      options.memoryDir
    );
    identityNormalizer.finish();
    return {
      identityHash: identityHash.digest("hex"),
    };
  }

  private async *readStagedOfflineSyncChunks(stagePath: string): AsyncIterable<Buffer> {
    const options = this.tombstoneBlockedCaptureIndexOptions();
    for await (const chunk of readMaybeEncryptedFileFromChunks(
      stagePath,
      options.secureStoreKeyProvider(),
      options.memoryDir
    )) {
      yield chunk;
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
    const baseDir = path.dirname(this.tombstoneBlockedCaptureIndexOptions().stateDir);
    try {
      await withRawEntityPageMutation(baseDir, target, async () => {
        await this.runTombstoneBlockedOfflineSyncMutation(
          target,
          prepared.after,
          () => this.writeManagedStorageFile(target, () => this.writeStorageSecureFileChunks(target, prepared.chunks)),
          coordinate,
          streamedIdentity
        );
      });
    } finally {
      if (prepared.stagePath !== undefined) await unlink(prepared.stagePath).catch(() => {});
    }
  }

  async writeOfflineSyncFile(filePath: string, content: Buffer): Promise<void> {
    const target = this.assertManagedStoragePath(filePath, "storage.writeOfflineSyncFile");
    await this.writeTombstoneBlockedOfflineSyncFile(target, content);
    await this.requestSyncReconcileIfMigrationPath(target);
  }

  async writeOfflineSyncFileChunks(filePath: string, chunks: AsyncIterable<Buffer>): Promise<void> {
    const target = this.assertManagedStoragePath(filePath, "storage.writeOfflineSyncFileChunks");
    await this.writeTombstoneBlockedOfflineSyncFileChunks(target, chunks);
    await this.requestSyncReconcileIfMigrationPath(target);
  }

  /**
   * Opaque replicated bytes can restore legacy memory references or entity
   * relationship targets. Other sync traffic must not request reconciliation.
   */
  private async requestSyncReconcileIfMigrationPath(target: string): Promise<void> {
    const stateDir = this.tombstoneBlockedCaptureIndexOptions().stateDir;
    if (!pathMayCarryEntityRefs(path.dirname(stateDir), target)) return;
    await requestEntityCanonicalIdReconcile(stateDir);
  }

  async deleteOfflineSyncFile(filePath: string, deletionMtimeMs?: number | null): Promise<void> {
    const target = this.assertManagedStoragePath(filePath, "storage.deleteOfflineSyncFile");
    await this.deleteTombstoneBlockedOfflineSyncFile(target, deletionMtimeMs);
    await this.requestSyncReconcileIfMigrationPath(target);
  }

  protected async deleteTombstoneBlockedOfflineSyncFile(
    target: string,
    deletionMtimeMs?: number | null
  ): Promise<void> {
    const stateDir = this.tombstoneBlockedCaptureIndexOptions().stateDir;
    await withRawEntityPageMutation(path.dirname(stateDir), target, async () => {
      await this.runTombstoneBlockedOfflineSyncMutation(target, null, async () => {
        return await this.deleteManagedStorageFile(target, deletionMtimeMs);
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
