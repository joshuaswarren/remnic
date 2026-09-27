// Streaming offline-sync snapshot builder (PR #3148 round 5). Extracted from
// access-service.ts so the god-file line-count ratchet does not grow: the
// stream carries whole-generation omission metadata alongside the file walk,
// so a filtered embedding generation is announced instead of looking deleted.
import { createHash } from "node:crypto";
import type {
  OfflineSyncDeletionRevision,
  OfflineSyncFileRecord,
  OfflineSyncSnapshot,
} from "./offline-sync.js";
import { OFFLINE_SYNC_SNAPSHOT_FORMAT, iterateOfflineSyncSnapshotFileRecords } from "./offline-sync.js";
import { resolvePushEmbeddingGenerationState } from "./offline-sync-embedding-generation.js";
import type { OfflineSyncExcludeFile, OfflineSyncFileTarget } from "./offline-sync-file-io.js";
import type { OfflineSyncFileDigest } from "./offline-sync.js";

export interface OfflineSyncSnapshotStreamBuildOptions {
  root: string;
  namespace: string;
  includeContent: boolean;
  includeTranscripts: boolean;
  userExcludeRegexps?: readonly RegExp[];
  excludeFile: OfflineSyncExcludeFile;
  readFile: (target: OfflineSyncFileTarget) => Promise<Buffer>;
  readFileDigest: (target: OfflineSyncFileTarget) => Promise<OfflineSyncFileDigest>;
  deletions: readonly OfflineSyncDeletionRevision[];
  signal?: AbortSignal;
}

export type OfflineSyncSnapshotStreamBuild = Omit<OfflineSyncSnapshot, "files"> & {
  namespace: string;
  files: AsyncIterable<OfflineSyncFileRecord>;
};

/**
 * Build the streamed snapshot response: whole-generation omission computed
 * with the SAME filters the walk uses and announced in the header, so the
 * receiver never interprets a filtered generation as deleted.
 */
export async function buildEmbeddingAwareSnapshotStream(
  options: OfflineSyncSnapshotStreamBuildOptions,
): Promise<OfflineSyncSnapshotStreamBuild> {
  const storageHash = createHash("sha256").update(options.root).digest("hex").slice(0, 16);
  const generationState = await resolvePushEmbeddingGenerationState({
    rootAbs: options.root,
    includeTranscripts: options.includeTranscripts,
    userExcludeRegexps: options.userExcludeRegexps,
    excludeFile: options.excludeFile,
    deletions: options.deletions,
  });
  return {
    namespace: options.namespace,
    format: OFFLINE_SYNC_SNAPSHOT_FORMAT,
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    sourceId: `remnic:${options.namespace}:${storageHash}`,
    includeTranscripts: options.includeTranscripts,
    deletions: generationState.deletions,
    ...(generationState.omittedDirs.length > 0
      ? { omittedEmbeddingGenerationDirs: generationState.omittedDirs }
      : {}),
    files: iterateOfflineSyncSnapshotFileRecords({
      root: options.root,
      includeContent: options.includeContent,
      includeTranscripts: options.includeTranscripts,
      readFile: options.readFile,
      readFileDigest: options.readFileDigest,
      signal: options.signal,
      userExcludeRegexps: options.userExcludeRegexps,
      excludeFile: options.excludeFile,
      skipEmbeddingGenerationPaths: generationState.omittedPaths,
    }),
  };
}
