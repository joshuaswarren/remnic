// Chunked transport for oversized embedding-generation members (codex P1 on
// issue #3148). Generation members never direct-hydrate at their live
// marker/shard paths, and the inline base64 content path cannot carry them
// once large: the base64 string of a near-512MiB legacy marker exceeds the
// V8 string ceiling. Members at or above the direct-hydration threshold are
// instead fetched chunk-wise (binary /offline-sync/file-content) into a
// PRIVATE staging root under `<memoryDir>/.offline-sync/`, encrypted with
// the vault's secure-store key and AAD-bound to the staging paths. The
// atomic generation transaction then consumes the staged bytes via core's
// `readIncomingFile` apply callback — live paths are only ever touched by
// the transaction's atomic backup-swap.
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { hostname } from "node:os";

import { StorageManager, embeddingGenerationMembership } from "@remnic/core";
import type { OfflineSyncFileState } from "@remnic/core";
import type { hydrateOfflineFileContent } from "./index.js";
import {
  createConfiguredOfflineStorage,
  createOfflineStorageIo,
  resolveOfflineDirectHydrationPath,
} from "./offline-storage-io.js";

type HydrateOfflineFileContentFn = typeof hydrateOfflineFileContent;

/** Sync-internal staging prefix under `<memoryDir>/.offline-sync/`. */
const GENERATION_STAGING_PREFIX = "generation-incoming-";

export interface GenerationStagedTransport {
  /** Generation member paths routed through the staged transport. */
  readonly stagedPaths: ReadonlySet<string>;
  /**
   * Core `applyOfflineSyncSnapshot` callback: verified staged bytes for
   * staged paths, null for everything else (metadata-only behavior).
   */
  readIncomingFile: (target: { path: string; sha256: string; bytes: number }) => Promise<Buffer | null>;
  /** Removes the private staging root. Idempotent; best-effort. */
  cleanup: () => Promise<void>;
}

/**
 * Pure selection of generation members that must ride the staged chunk
 * transport: members of an embedding generation at or above `minBytes`,
 * not already deferred, and not byte-identical to the local current file.
 */
export function generationMembersForStagedTransport(options: {
  incomingFiles: readonly OfflineSyncFileState[];
  currentFiles?: readonly OfflineSyncFileState[];
  deferredPaths?: readonly string[];
  minBytes: number;
}): OfflineSyncFileState[] {
  const currentByPath = new Map((options.currentFiles ?? []).map((file) => [file.path, file]));
  const deferred = new Set(options.deferredPaths ?? []);
  return options.incomingFiles
    .filter(
      (file) =>
        file.bytes >= options.minBytes &&
        !deferred.has(file.path) &&
        currentByPath.get(file.path)?.sha256 !== file.sha256 &&
        embeddingGenerationMembership(file.path) !== null
    )
    .sort((left, right) => right.bytes - left.bytes || left.path.localeCompare(right.path));
}

/** Reject redirected staging roots before enumeration or mutation. */
async function assertPrivateOfflineDir(offlineDir: string): Promise<void> {
  const info = await lstat(offlineDir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (info && (info.isSymbolicLink() || !info.isDirectory())) {
    throw new Error("offline-sync staging directory must be a real directory, not a symlink");
  }
}

async function removeStage(offlineDir: string, stage: string): Promise<void> {
  await assertPrivateOfflineDir(offlineDir);
  const info = await lstat(stage).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (info?.isDirectory() && !info.isSymbolicLink()) {
    await rm(stage, { recursive: true, force: true });
  }
}

/** Reclaim only same-host stages whose recorded process no longer exists. */
async function reclaimAbandonedGenerationStages(offlineDir: string): Promise<void> {
  await assertPrivateOfflineDir(offlineDir);
  const names = await readdir(offlineDir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [] as string[];
    throw error;
  });
  for (const name of names) {
    if (!name.startsWith(GENERATION_STAGING_PREFIX)) continue;
    const dir = path.join(offlineDir, name);
    try {
      const info = await lstat(dir);
      if (!info.isDirectory() || info.isSymbolicLink()) continue;
      const owner = JSON.parse(await readFile(path.join(dir, "owner.json"), "utf-8"));
      if (owner?.hostname !== hostname() || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) continue;
      try {
        process.kill(owner.pid, 0);
      } catch (error) {
        // EPERM/unknown ownership and reused PIDs are conservative keeps.
        // Age alone never proves that an oversized transfer is abandoned.
        if ((error as NodeJS.ErrnoException).code === "ESRCH") {
          await removeStage(offlineDir, dir);
        }
      }
    } catch {
      // Missing/malformed ownership or concurrent cleanup: preserve unknown stages.
    }
  }
}

/**
 * Chunk-fetch the oversized generation members of an incoming snapshot into
 * a private, secure-store-bound staging root and expose them to the apply
 * transaction. Fetch failures throw AFTER cleaning the staging root; the
 * published generation is never touched — apply either runs entirely inside
 * the atomic transaction or not at all.
 */
export async function stageGenerationMembersForApply(options: {
  memoryDir: string;
  remoteUrl: string;
  token: string;
  namespace?: string;
  includeTranscripts: boolean;
  incomingFiles: readonly OfflineSyncFileState[];
  currentFiles?: readonly OfflineSyncFileState[];
  deferredPaths?: readonly string[];
  /** Minimum member size routed through staging (CLI direct-hydrate threshold in production). */
  minBytes: number;
  /** Preserve the configured secure-store write policy when loading the key. */
  secureStoreEncryptOnWrite?: boolean;
  hydrateFileContent: HydrateOfflineFileContentFn;
}): Promise<GenerationStagedTransport> {
  const noop = {
    stagedPaths: new Set<string>() as ReadonlySet<string>,
    readIncomingFile: async () => null,
    cleanup: async () => {},
  };
  const candidates = generationMembersForStagedTransport({
    incomingFiles: options.incomingFiles,
    currentFiles: options.currentFiles,
    deferredPaths: options.deferredPaths,
    minBytes: options.minBytes,
  });
  const offlineDir = path.join(options.memoryDir, ".offline-sync");
  await reclaimAbandonedGenerationStages(offlineDir);
  if (candidates.length === 0) return noop;

  await mkdir(offlineDir, { recursive: true });
  await assertPrivateOfflineDir(offlineDir);
  const stagingRoot = await mkdtemp(path.join(offlineDir, GENERATION_STAGING_PREFIX));
  try {
    await writeFile(path.join(stagingRoot, "owner.json"), JSON.stringify({
      pid: process.pid, hostname: hostname(),
    }), { mode: 0o600, flag: "wx" });
    // The fresh staging root has no keyring header of its own; inherit the
    // parent vault's secure-store policy so staged bytes are encrypted at
    // rest with the same key instead of plaintext-downgrading the vault.
    const configured = await createConfiguredOfflineStorage(options.memoryDir, options.secureStoreEncryptOnWrite);
    const stagingStorage = new StorageManager(stagingRoot);
    if (configured.secureStoreRequired) stagingStorage.setSecureStoreRequired(true);
    if (configured.secureStoreKey) {
      await stagingStorage.setSecureStoreKeyAndWait(
        configured.secureStoreKey,
        options.secureStoreEncryptOnWrite ?? true
      );
    }
    const stagingIo = await createOfflineStorageIo(stagingRoot, {
      storage: stagingStorage,
      secureStoreKey: configured.secureStoreKey,
      secureStoreRequired: configured.secureStoreRequired,
    });
    const stagingReadFile = stagingIo.readFile;
    const {
      readFileDigest: stagingReadFileDigest,
      writeFile: stagingWriteFile,
      writeStagingFile: stagingWriteStagingFile,
      writeFileChunks: stagingWriteFileChunks,
    } = stagingIo;
    if (
      !stagingReadFile ||
      !stagingReadFileDigest ||
      !stagingWriteFile ||
      !stagingWriteStagingFile ||
      !stagingWriteFileChunks
    ) {
      throw new Error("offline generation staging requires full storage IO hooks");
    }

    const stagedPaths = new Set<string>();
    for (const member of candidates) {
      const result = await options.hydrateFileContent({
        remoteUrl: options.remoteUrl,
        token: options.token,
        namespace: options.namespace,
        includeTranscripts: options.includeTranscripts,
        memoryDir: stagingRoot,
        sourceId: "remote",
        expected: member,
        readFile: stagingReadFile,
        readFileDigest: stagingReadFileDigest,
        writeFile: stagingWriteFile,
        writeStagingFile: stagingWriteStagingFile,
        writeFileChunks: stagingWriteFileChunks,
      });
      if (result.conflict) {
        throw new Error(`offline generation staging conflict for ${member.path}`);
      }
      if (!result.done || !(result.applied || result.skipped)) {
        throw new Error(`offline generation staging did not finish for ${member.path}`);
      }
      stagedPaths.add(member.path);
    }

    return {
      stagedPaths,
      readIncomingFile: async (target) => {
        if (!stagedPaths.has(target.path)) return null;
        return await stagingReadFile({
          root: stagingRoot,
          path: target.path,
          filePath: resolveOfflineDirectHydrationPath(stagingRoot, target.path),
        });
      },
      cleanup: async () => {
        await removeStage(offlineDir, stagingRoot).catch(() => {});
      },
    };
  } catch (error) {
    await removeStage(offlineDir, stagingRoot).catch(() => {});
    throw error;
  }
}
