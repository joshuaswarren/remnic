import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_TRANSFER_EXCLUDE_DIRS,
} from "./transfer/exclusions.js";
import {
  prepareSafeArchiveRoot,
  resolveSafeArchiveTarget,
  sha256Bytes,
  validateArchiveRelativePath,
  type SafeArchiveRoot,
} from "./transfer/fs-utils.js";
import { parseFlexibleIsoTimestamp } from "./utils/iso-timestamp.js";
import { EmbeddingIndexStorageError } from "./embedding-index-storage.js";
import { isEmbeddingGenerationMarkerPath, matchesOfflineSyncDefaultExclude } from "./offline-sync-exclude-globs.js";
import {
  applyIncomingEmbeddingGenerations,
  assertEmbeddingGenerationStillIncluded,
  computeOmittedEmbeddingGenerationPaths,
  divergedEmbeddingGenerationDeferrals,
  embeddingGenerationMembership,
  isEmbeddingGenerationDirPath,
  isPathInOmittedEmbeddingGeneration,
} from "./offline-sync-embedding-generation.js";
import {
  applyChangesetEmbeddingGenerations,
  normalizeChangesetGenerations,
  type OfflineSyncChangesetGeneration,
} from "./offline-sync-changeset-generations.js";
import { withEmbeddingGenerationLock, withEmbeddingGenerationLockIter } from "./embedding-generation-lock.js";
import {
  isCanonicalRuntimeStatePath,
  shouldDeleteAbsentIncomingOfflineRuntimeFile,
  shouldPreferIncomingOfflineRuntimeFile,
} from "./offline-sync-runtime-state.js";
export { shouldPreferIncomingOfflineRuntimeFile } from "./offline-sync-runtime-state.js";
export { computeOmittedEmbeddingGenerationPaths } from "./offline-sync-embedding-generation.js";
export type { OfflineSyncChangesetGeneration } from "./offline-sync-changeset-generations.js";
export {
  compileOfflineSyncExcludeGlobs,
  globToRegExp,
  parseOfflineSyncExcludes,
} from "./offline-sync-exclude-globs.js";
import {
  isEncryptedOfflineSyncFile,
  readPlainOfflineSyncFileChunk,
  sha256OfflineSyncFile,
  shouldExcludeOfflineSyncFile,
  type OfflineSyncExcludeFile,
  type OfflineSyncFileTarget,
  plainFileDigest,
  SYNC_INTERNAL_DIR,
  setSafeFileMtime,
  assertNonNegativeFinite,
  assertOfflineSyncMtimeMs,
  OFFLINE_SYNC_FAST_BASE_MTIME_TOLERANCE_MS,
} from "./offline-sync-file-io.js";
import { CENSUS_MAX_MTIME_MS, isSha256Hex } from "./census-validation.js";
import {
  cleanupOfflineUpload,
  digestOfflineUploadStagingContent,
  pruneOfflineUploadStaging,
  writeOfflineUploadChunk,
  writeSafeFileFromUpload,
  hashText,
} from "./offline-sync-upload-staging.js";
export type { OfflineSyncExcludeFile, OfflineSyncFileTarget } from "./offline-sync-file-io.js";

export const OFFLINE_SYNC_SNAPSHOT_FORMAT = "remnic.offline-sync.snapshot.v1";
export const OFFLINE_SYNC_CHANGESET_FORMAT = "remnic.offline-sync.changeset.v1";
export const OFFLINE_SYNC_STATE_VERSION = 1;
export const OFFLINE_SYNC_FILE_CONTENT_MAX_CHUNK_BYTES = 64 * 1024 * 1024;
export const OFFLINE_SYNC_FILE_CONTENT_TRANSFER_CHUNK_BYTES = 8 * 1024 * 1024;
export const OFFLINE_SYNC_APPLY_MAX_BODY_BYTES = 16 * 1024 * 1024;
export const OFFLINE_SYNC_SNAPSHOT_BASE_MAX_BODY_BYTES = 64 * 1024 * 1024;
export const OFFLINE_SYNC_MAX_MTIME_MS = CENSUS_MAX_MTIME_MS;

export interface OfflineSyncFileState {
  path: string;
  sha256: string;
  /** Byte length of the transferable content, after any readFile hook such as secure-store decryption. */
  bytes: number;
  mtimeMs: number;
}

export interface OfflineSyncFileRecord extends OfflineSyncFileState {
  contentBase64?: string;
}

export interface OfflineSyncFileDigest {
  sha256: string;
  bytes: number;
}

export interface OfflineSyncDeletionRevision {
  path: string;
  mtimeMs: number;
}

export interface OfflineSyncSnapshot {
  format: typeof OFFLINE_SYNC_SNAPSHOT_FORMAT;
  schemaVersion: 1;
  createdAt: string;
  sourceId: string;
  includeTranscripts: boolean;
  files: OfflineSyncFileRecord[];
  deletions?: OfflineSyncDeletionRevision[];
  /**
   * Embedding generation dirs whose on-disk members were ALL omitted from
   * `files` because a push filter excluded at least one member (PR #3148
   * round 4). Their absence here is NOT a delete instruction: a receiver
   * keeps its local copy and its base entries until the generation is
   * pushed unfiltered or genuinely deleted with deletion metadata.
   */
  omittedEmbeddingGenerationDirs?: string[];
}

export type OfflineSyncChange =
  | {
      type: "upsert";
      path: string;
      baseSha256?: string;
      file: OfflineSyncFileRecord & { contentBase64: string };
    }
  | {
      type: "delete";
      path: string;
      baseSha256: string;
      mtimeMs?: number;
    };

export interface OfflineSyncChangeset {
  format: typeof OFFLINE_SYNC_CHANGESET_FORMAT;
  schemaVersion: 1;
  createdAt: string;
  sourceId: string;
  includeTranscripts: boolean;
  changes: OfflineSyncChange[];
  /**
   * Complete post-change membership of every embedding generation the
   * changeset touches (issue #3150). Absent on legacy senders: receivers
   * defer manifest-less shard upserts as conflicts instead of publishing a
   * mixed generation.
   */
  embeddingGenerations?: OfflineSyncChangesetGeneration[];
}

export interface OfflineSyncState {
  version: typeof OFFLINE_SYNC_STATE_VERSION;
  remoteId: string;
  namespace?: string;
  includeTranscripts: boolean;
  lastSyncedAt: string;
  baseFiles: OfflineSyncFileState[];
}

export interface OfflineSyncConflict {
  path: string;
  reason:
    | "both_modified"
    | "local_deleted_remote_modified"
    | "local_modified_remote_deleted"
    | "remote_exists_for_local_create"
    | "remote_changed_for_local_update"
    | "remote_deleted_for_local_update"
    | "remote_changed_for_local_delete"
    // Changeset generation deferrals (#3150): the receiver refused a whole
    // embedding generation; surfaced as conflicts so the push side never
    // checkpoints it as applied.
    | "embedding_generation_diverged"
    | "embedding_generation_manifest_required";
  baseSha256?: string;
  localSha256?: string;
  incomingSha256?: string;
  conflictPath?: string;
}

export interface OfflineSyncApplySnapshotResult {
  upserted: number;
  deleted: number;
  skipped: number;
  pendingLocal: number;
  conflicts: OfflineSyncConflict[];
  nextBaseFiles: OfflineSyncFileState[];
}

export interface OfflineSyncApplyChangesetResult {
  appliedUpserts: number;
  appliedDeletes: number;
  skipped: number;
  conflicts: OfflineSyncConflict[];
  currentFiles: OfflineSyncFileState[];
  currentFilesComplete?: boolean;
}

export interface OfflineSyncChangesetSummary {
  upserts: number;
  deletes: number;
  total: number;
}

export interface OfflineSyncFileDeleteTarget extends OfflineSyncFileTarget {
  mtimeMs?: number;
}

export type OfflineSyncRecordDeletionRevision = (
  target: OfflineSyncFileDeleteTarget & { mtimeMs: number },
) => Promise<void>;

export interface OfflineSyncFileWriteTarget extends OfflineSyncFileTarget {
  content: Buffer;
}

export interface OfflineSyncFileWriteChunksTarget extends OfflineSyncFileTarget {
  chunks: AsyncIterable<Buffer>;
}

export interface OfflineSyncFileStagingWriteTarget extends OfflineSyncFileWriteTarget {
  /**
   * ABSOLUTE final path whose canonical AAD the staged ciphertext binds
   * (secure-store deployments): the offline-sync embedding generation
   * transaction stages under a staging dir and publishes by rename, so the
   * ciphertext must decrypt at the FINAL path. The AAD derives through the
   * same filePathAad logic as ordinary reads (platform-consistent).
   */
  finalAadFilePath?: string;
}

export interface OfflineSyncFileStagingReadTarget extends OfflineSyncFileTarget {
  /** See {@link OfflineSyncFileStagingWriteTarget.finalAadFilePath}. */
  finalAadFilePath?: string;
}

export interface OfflineSyncFileContentChunk extends Omit<OfflineSyncFileState, "sha256"> {
  sha256?: string;
  offset: number;
  chunkBytes: number;
  content: Buffer;
}

export interface OfflineSyncApplyFileContentChunkResult {
  path: string;
  sha256: string;
  bytes: number;
  mtimeMs: number;
  offset: number;
  chunkBytes: number;
  done: boolean;
  applied: boolean;
  skipped: boolean;
  conflict?: OfflineSyncConflict;
  currentFile?: OfflineSyncFileState;
}

interface OfflineUploadStaging {
  kind: "single" | "chunks";
  relPath: string;
  filePath: string;
}

interface OfflineSyncFileRecordOptions {
  root: SafeArchiveRoot;
  relPath: string;
  filePath: string;
  includeContent: boolean;
  readFile?: (target: OfflineSyncFileTarget) => Promise<Buffer>;
  readFileDigest?: (target: OfflineSyncFileTarget) => Promise<OfflineSyncFileDigest>;
  signal?: AbortSignal;
}

const OFFLINE_SYNC_FAST_BASE_CTIME_TOLERANCE_MS = 1;
const EXCLUDED_FILE_NAMES = new Set([
  ".sync-state.json",
]);

const EXCLUDED_FILE_PREFIXES = [
  ".remnic-sync.",
  ".remnic-sync-state.",
];

/**
 * Convert a tiny subset of glob syntax (`*`, `**`, `?`, literal text) into a
 * regular expression anchored at the start and end of the input. The matcher
 * is intentionally narrow — it is only used for operator-supplied
 * `offlineSyncExcludes` entries, not for full shell-style globbing.
 * `*` and `?` match within a single path segment. `**` is cross-segment
 * wherever it appears: a `star-star-slash` prefix (leading or embedded)
 * matches zero or more whole segments, and a trailing `dir/star-star`
 * matches everything under `dir/` at any depth.
 */


function sha256Buffer(buffer: Buffer): { sha256: string; bytes: number } {
  return sha256Bytes(buffer);
}

function throwIfOfflineSyncAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw new Error("offline sync request aborted");
}

function compareByPath<T extends { path: string }>(left: T, right: T): number {
  return left.path.localeCompare(right.path);
}

function assertSha256(value: unknown, field: string): string {
  if (!isSha256Hex(value)) {
    throw new Error(`${field} must be a 64-character sha256 hex string`);
  }
  return value.toLowerCase();
}

function assertNonNegativeInteger(value: unknown, field: string): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value < 0
  ) {
    throw new Error(`${field} must be a non-negative integer`);
  }
  return value;
}



function assertBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${field} must be a boolean`);
  }
  return value;
}

function normalizeSourceId(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 512) {
    throw new Error(`${field} must be a non-empty string no longer than 512 characters`);
  }
  return value.trim();
}

function normalizeFileState(input: unknown, fieldPrefix: string): OfflineSyncFileState {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(`${fieldPrefix} must be an object`);
  }
  const obj = input as Record<string, unknown>;
  const relPath = normalizeRelativePath(obj.path, `${fieldPrefix}.path`);
  return {
    path: relPath,
    sha256: assertSha256(obj.sha256, `${fieldPrefix}.sha256`),
    bytes: assertNonNegativeInteger(obj.bytes, `${fieldPrefix}.bytes`),
    mtimeMs: assertOfflineSyncMtimeMs(obj.mtimeMs, `${fieldPrefix}.mtimeMs`),
  };
}

function normalizeFileRecord(
  input: unknown,
  fieldPrefix: string,
  requireContent: boolean,
): OfflineSyncFileRecord {
  const state = normalizeFileState(input, fieldPrefix);
  const obj = input as Record<string, unknown>;
  const contentBase64 = obj.contentBase64;
  if (requireContent && typeof contentBase64 !== "string") {
    throw new Error(`${fieldPrefix}.contentBase64 is required`);
  }
  if (contentBase64 !== undefined && typeof contentBase64 !== "string") {
    throw new Error(`${fieldPrefix}.contentBase64 must be a base64 string`);
  }
  return {
    ...state,
    ...(contentBase64 !== undefined ? { contentBase64 } : {}),
  };
}

function normalizeFileStates(input: readonly unknown[] | undefined): OfflineSyncFileState[] {
  if (!input) return [];
  if (!Array.isArray(input)) {
    throw new Error("baseFiles must be an array");
  }
  return input.map((entry, index) => normalizeFileState(entry, `baseFiles[${index}]`));
}

function normalizeDeletionRevisions(
  input: unknown,
  fieldPrefix: string,
): OfflineSyncDeletionRevision[] | undefined {
  if (input === undefined) return undefined;
  if (!Array.isArray(input)) {
    throw new Error(`${fieldPrefix} must be an array`);
  }
  const deletions = input.map((entry, index): OfflineSyncDeletionRevision => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`${fieldPrefix}[${index}] must be an object`);
    }
    const obj = entry as Record<string, unknown>;
    return {
      path: normalizeRelativePath(obj.path, `${fieldPrefix}[${index}].path`),
      mtimeMs: assertOfflineSyncMtimeMs(obj.mtimeMs, `${fieldPrefix}[${index}].mtimeMs`),
    };
  });
  assertUniquePaths(deletions, fieldPrefix);
  return deletions.sort(compareByPath);
}

function snapshotBuilderDeletions(options: {
  deletions?: readonly OfflineSyncDeletionRevision[];
  files: readonly OfflineSyncFileState[];
  paths?: readonly string[];
  includeTranscripts: boolean;
  excludeNodeLocalState?: boolean;
  userExcludeRegexps?: readonly RegExp[];
  /** Generation dirs omitted by the push enumeration (PR #3148): revisions
   * for ANY member — including already-absent ones — are suppressed, so a
   * filtered generation can never be announced as deleted. */
  omittedGenerationDirs?: ReadonlySet<string>;
}): OfflineSyncDeletionRevision[] | undefined {
  const deletions = normalizeDeletionRevisions(options.deletions, "deletions");
  if (deletions === undefined) return undefined;
  if (deletions.length === 0) return deletions;
  const presentPaths = new Set(options.files.map((file) => file.path.toLowerCase()));
  const scopedPaths = options.paths
    ? new Set(options.paths.map((relPath) => relPath.toLowerCase()))
    : undefined;
  return deletions.filter((deletion) =>
    (scopedPaths === undefined || scopedPaths.has(deletion.path.toLowerCase())) &&
    !presentPaths.has(deletion.path.toLowerCase()) &&
    !isDeletionInOmittedGeneration(deletion.path, options.omittedGenerationDirs) &&
    !(options.excludeNodeLocalState === false
      ? shouldExcludeRelPath(deletion.path, options.includeTranscripts)
      : shouldExcludePushRelPath(
          deletion.path,
          options.includeTranscripts,
          options.userExcludeRegexps,
        )));
}

function isDeletionInOmittedGeneration(
  relPath: string,
  omittedGenerationDirs: ReadonlySet<string> | undefined,
): boolean {
  if (!omittedGenerationDirs || omittedGenerationDirs.size === 0) return false;
  const membership = embeddingGenerationMembership(relPath);
  return membership !== null && omittedGenerationDirs.has(membership.shardDir);
}

export async function filterOfflineSyncDeletionRevisions(options: {
  root: string;
  deletions: readonly OfflineSyncDeletionRevision[];
  includeTranscripts?: boolean;
  userExcludeRegexps?: readonly RegExp[];
  excludeFile?: OfflineSyncExcludeFile;
}): Promise<OfflineSyncDeletionRevision[]> {
  const deletions = normalizeDeletionRevisions(options.deletions, "deletions");
  if (deletions === undefined) throw new Error("deletions must be an array");
  if (deletions.length === 0) return deletions;
  const root = await prepareSafeArchiveRoot(
    path.resolve(options.root),
    "filterOfflineSyncDeletionRevisions",
    "root",
  );
  const includeTranscripts = options.includeTranscripts !== false;
  const omission = await computeOmittedEmbeddingGenerationPaths({
    rootAbs: root.abs,
    userExcludeRegexps: options.userExcludeRegexps,
    excludeFile: options.excludeFile,
    isExcludedRelPath: (relPath) =>
      shouldExcludePushRelPath(relPath, includeTranscripts, options.userExcludeRegexps),
  });
  const omittedDirs = new Set(omission.omittedDirs);
  const filtered: OfflineSyncDeletionRevision[] = [];
  for (const deletion of deletions) {
    if (
      shouldExcludePushRelPath(deletion.path, includeTranscripts, options.userExcludeRegexps) ||
      isDeletionInOmittedGeneration(deletion.path, omittedDirs)
    ) {
      continue;
    }
    const filePath = path.join(root.abs, ...deletion.path.split("/"));
    const present = await lstat(filePath).then(
      () => true,
      (error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      },
    );
    if (!present) filtered.push(deletion);
  }
  return filtered;
}

export function normalizeOfflineSyncSnapshot(
  input: unknown,
  options: { requireContent?: boolean } = {},
): OfflineSyncSnapshot {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("offline sync snapshot must be an object");
  }
  const obj = input as Record<string, unknown>;
  if (obj.format !== OFFLINE_SYNC_SNAPSHOT_FORMAT) {
    throw new Error(`offline sync snapshot format must be ${OFFLINE_SYNC_SNAPSHOT_FORMAT}`);
  }
  if (obj.schemaVersion !== 1) {
    throw new Error("offline sync snapshot schemaVersion must be 1");
  }
  const createdAt = normalizeIsoString(obj.createdAt, "createdAt");
  const sourceId = normalizeSourceId(obj.sourceId, "sourceId");
  const includeTranscripts = assertBoolean(obj.includeTranscripts, "includeTranscripts");
  if (!Array.isArray(obj.files)) {
    throw new Error("offline sync snapshot files must be an array");
  }
  const files = obj.files
    .map((entry, index) =>
      normalizeFileRecord(entry, `files[${index}]`, options.requireContent === true))
    .filter((file) => !shouldIgnoreIncomingRuntimePath(file.path))
    .sort(compareByPath);
  const deletions = normalizeDeletionRevisions(obj.deletions, "deletions")
    ?.filter((deletion) => !shouldIgnoreIncomingRuntimePath(deletion.path));
  const entries = deletions && deletions.length > 0 ? [...files, ...deletions] : files;
  assertUniquePaths(entries, "offline sync snapshot");
  if (!includeTranscripts) {
    const transcriptPath = entries
      .find((entry) => entry.path.split("/")[0] === "transcripts")?.path;
    if (transcriptPath) {
      throw new Error(
        `offline sync snapshot includeTranscripts is false but contains transcript path: ${transcriptPath}`,
      );
    }
  }
  const excludedPath = entries
    .find((entry) => shouldExcludeRelPath(entry.path, true))?.path;
  if (excludedPath) {
    throw new Error(`offline sync snapshot contains excluded path: ${excludedPath}`);
  }
  let omittedEmbeddingGenerationDirs: string[] | undefined;
  if (obj.omittedEmbeddingGenerationDirs !== undefined) {
    if (!Array.isArray(obj.omittedEmbeddingGenerationDirs)) {
      throw new Error("offline sync snapshot omittedEmbeddingGenerationDirs must be an array");
    }
    const seenDirs = new Set<string>();
    for (const [index, entry] of obj.omittedEmbeddingGenerationDirs.entries()) {
      if (
        typeof entry !== "string" ||
        !isEmbeddingGenerationDirPath(entry) ||
        seenDirs.has(entry)
      ) {
        throw new Error(
          `omittedEmbeddingGenerationDirs[${index}] must be a unique canonical embeddings generation dir`,
        );
      }
      seenDirs.add(entry);
    }
    omittedEmbeddingGenerationDirs = [...seenDirs].sort((left, right) => left.localeCompare(right));
  }
  return {
    format: OFFLINE_SYNC_SNAPSHOT_FORMAT,
    schemaVersion: 1,
    createdAt,
    sourceId,
    includeTranscripts,
    files,
    ...(deletions === undefined ? {} : { deletions }),
    ...(omittedEmbeddingGenerationDirs === undefined ? {} : { omittedEmbeddingGenerationDirs }),
  };
}

export function normalizeOfflineSyncChangeset(
  input: unknown,
): OfflineSyncChangeset {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("offline sync changeset must be an object");
  }
  const obj = input as Record<string, unknown>;
  if (obj.format !== OFFLINE_SYNC_CHANGESET_FORMAT) {
    throw new Error(`offline sync changeset format must be ${OFFLINE_SYNC_CHANGESET_FORMAT}`);
  }
  if (obj.schemaVersion !== 1) {
    throw new Error("offline sync changeset schemaVersion must be 1");
  }
  const createdAt = normalizeIsoString(obj.createdAt, "createdAt");
  const sourceId = normalizeSourceId(obj.sourceId, "sourceId");
  const includeTranscripts = assertBoolean(obj.includeTranscripts, "includeTranscripts");
  if (!Array.isArray(obj.changes)) {
    throw new Error("offline sync changeset changes must be an array");
  }
  const changes = obj.changes.map((entry, index): OfflineSyncChange => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`changes[${index}] must be an object`);
    }
    const change = entry as Record<string, unknown>;
    const type = change.type;
    const relPath = normalizeRelativePath(change.path, `changes[${index}].path`);
    if (type === "upsert") {
      const file = normalizeFileRecord(
        change.file,
        `changes[${index}].file`,
        true,
      ) as OfflineSyncFileRecord & { contentBase64: string };
      if (file.path !== relPath) {
        throw new Error(`changes[${index}].file.path must match changes[${index}].path`);
      }
      const baseSha256 =
        change.baseSha256 === undefined
          ? undefined
          : assertSha256(change.baseSha256, `changes[${index}].baseSha256`);
      return {
        type: "upsert",
        path: relPath,
        ...(baseSha256 ? { baseSha256 } : {}),
        file,
      };
    }
    if (type === "delete") {
      const mtimeMs = change.mtimeMs === undefined
        ? undefined
        : assertOfflineSyncMtimeMs(change.mtimeMs, `changes[${index}].mtimeMs`);
      return {
        type: "delete",
        path: relPath,
        baseSha256: assertSha256(change.baseSha256, `changes[${index}].baseSha256`),
        ...(mtimeMs === undefined ? {} : { mtimeMs }),
      };
    }
    throw new Error(`changes[${index}].type must be "upsert" or "delete"`);
  }).filter((change) => !shouldIgnoreIncomingRuntimePath(change.path));
  assertUniquePaths(changes, "offline sync changeset");
  if (!includeTranscripts) {
    const transcriptPath = changes.find((change) => change.path.split("/")[0] === "transcripts")?.path;
    if (transcriptPath) {
      throw new Error(
        `offline sync changeset includeTranscripts is false but contains transcript path: ${transcriptPath}`,
      );
    }
  }
  const excludedPath = changes.find((change) => shouldExcludeRelPath(change.path, true))?.path;
  if (excludedPath) {
    throw new Error(`offline sync changeset contains excluded path: ${excludedPath}`);
  }
  const embeddingGenerations = normalizeChangesetGenerations(obj.embeddingGenerations, changes);
  return {
    format: OFFLINE_SYNC_CHANGESET_FORMAT,
    schemaVersion: 1,
    createdAt,
    sourceId,
    includeTranscripts,
    changes: changes.sort(compareByPath),
    ...(embeddingGenerations === undefined ? {} : { embeddingGenerations }),
  };
}

function normalizeIsoString(input: unknown, field: string): string {
  if (typeof input !== "string" || input.trim().length === 0) {
    throw new Error(`${field} must be an ISO timestamp string`);
  }
  const parsed = parseFlexibleIsoTimestamp(input.trim());
  if (parsed === null) {
    throw new Error(`${field} must be a parseable ISO timestamp`);
  }
  return new Date(parsed).toISOString();
}

function normalizeRelativePath(input: unknown, field: string): string {
  if (typeof input !== "string") {
    throw new Error(`${field} must be a POSIX relative path string`);
  }
  return validateArchiveRelativePath(input, field);
}

function assertUniquePaths(entries: readonly { path: string }[], context: string): void {
  const seen = new Set<string>();
  for (const entry of entries) {
    const key = entry.path.toLowerCase();
    if (seen.has(key)) {
      throw new Error(`${context} contains duplicate path: ${entry.path}`);
    }
    seen.add(key);
  }
}

export function isInternalRemnicStatePath(relPosix: string): boolean {
  const normalized = relPosix.includes("\\") ? relPosix.replaceAll("\\", "/") : relPosix;
  return normalized === ".remnic"
    || normalized.startsWith(".remnic/")
    || normalized.endsWith("/.remnic")
    || normalized.includes("/.remnic/");
}

function shouldExcludeRelPath(relPosix: string, includeTranscripts: boolean): boolean {
  if (isInternalRemnicStatePath(relPosix)) return true;
  const parts = relPosix.split("/");
  if (parts.some((part) => DEFAULT_TRANSFER_EXCLUDE_DIRS.has(part))) return true;
  if (parts.some((part) => part === SYNC_INTERNAL_DIR)) return true;
  if (!includeTranscripts && parts[0] === "transcripts") return true;
  const basename = parts[parts.length - 1] ?? "";
  if (isCanonicalRuntimeStatePath(parts) && basename.includes(".tmp-")) return true;
  if (EXCLUDED_FILE_NAMES.has(basename)) return true;
  if (EXCLUDED_FILE_PREFIXES.some((prefix) => basename.startsWith(prefix))) return true;
  return false;
}

/**
 * Push-side variant of `shouldExcludeRelPath` for issue #1786. Combines the
 * legacy structural exclude (private dirs, sync internal, tmp runtime state,
 * excluded file names/prefixes) with the new push-only exclusion layers:
 *   - the `state/*.sqlite`, `state/index_tags.json`, etc. defaults that
 *     describe node-local runtime state each node rebuilds from synced
 *     records, and
 *   - operator-supplied `offlineSyncExcludes` regexps.
 *
 * Used ONLY by push-side enumeration/validation paths. Apply-side callers
 * must use the legacy `shouldExcludeRelPath` so a remote snapshot containing
 * `state/lcm.sqlite` can still be accepted on first sync -- the remote's
 * view is authoritative for that file until the local LCM is bootstrapped.
 */
function shouldExcludePushRelPath(
  relPosix: string,
  includeTranscripts: boolean,
  userExcludeRegexps?: readonly RegExp[],
): boolean {
  if (shouldExcludeRelPath(relPosix, includeTranscripts)) return true;
  // Issue #1786: node-local runtime state (live sqlite, derived indexes,
  // per-node governance run logs) is rebuilt by each node, never synced.
  if (matchesOfflineSyncDefaultExclude(relPosix)) return true;
  if (userExcludeRegexps && userExcludeRegexps.some((re) => re.test(relPosix))) return true;
  return false;
}

// Precompiled once at module load — this check sits on the hot
// enumeration path for every walked file (Kilo review, PR #1793).


/**
 * Compile operator-supplied `offlineSyncExcludes` glob strings into a
 * pre-validated array of regular expressions. Empty input is allowed and
 * returns an empty list. Throws on any invalid entry — callers should treat
 * a thrown error as a fatal configuration mistake and refuse to start the
 * sync run rather than silently dropping the bad entry.
 */

function shouldIgnoreIncomingRuntimePath(relPosix: string): boolean {
  if (isInternalRemnicStatePath(relPosix)) return true;
  const parts = relPosix.split("/");
  const basename = parts[parts.length - 1] ?? "";
  return isCanonicalRuntimeStatePath(parts) && basename.includes(".tmp-");
}

function filterBaseFilesForMode(
  files: readonly OfflineSyncFileState[],
  includeTranscripts: boolean,
): OfflineSyncFileState[] {
  return files.filter((file) => !shouldExcludeRelPath(file.path, includeTranscripts));
}

function canReuseFastBaseFileState(
  baseEntry: OfflineSyncFileState,
  st: { size: number; mtimeMs: number; ctimeMs: number },
  baseCapturedAtMs: number | null,
): boolean {
  if (baseEntry.bytes !== st.size) return false;
  if (Math.abs(baseEntry.mtimeMs - st.mtimeMs) > OFFLINE_SYNC_FAST_BASE_MTIME_TOLERANCE_MS) {
    return false;
  }
  if (baseCapturedAtMs === null) return false;
  // Node reports stat times as fractional milliseconds while Date snapshots are
  // whole milliseconds, so allow only a tiny precision window around capture.
  return st.ctimeMs - baseCapturedAtMs <= OFFLINE_SYNC_FAST_BASE_CTIME_TOLERANCE_MS;
}

async function canReuseFastBaseFileStateFromDisk(
  baseEntry: OfflineSyncFileState,
  st: { size: number; mtimeMs: number; ctimeMs: number },
  baseCapturedAtMs: number | null,
): Promise<boolean> {
  return canReuseFastBaseFileState(baseEntry, st, baseCapturedAtMs);
}

async function readOfflineSyncFileRecord(
  options: OfflineSyncFileRecordOptions,
): Promise<OfflineSyncFileRecord> {
  throwIfOfflineSyncAborted(options.signal);
  const relPath = validateArchiveRelativePath(options.relPath, "offlineSyncFile.path");
  let content: Buffer | null = null;
  let digest: OfflineSyncFileDigest;
  if (options.includeContent) {
    content = options.readFile
      ? await options.readFile({ root: options.root.abs, path: relPath, filePath: options.filePath })
      : await readFile(options.filePath);
    throwIfOfflineSyncAborted(options.signal);
    digest = sha256Buffer(content);
  } else if (options.readFileDigest) {
    digest = await options.readFileDigest({ root: options.root.abs, path: relPath, filePath: options.filePath });
    throwIfOfflineSyncAborted(options.signal);
  } else if (options.readFile) {
    content = await options.readFile({ root: options.root.abs, path: relPath, filePath: options.filePath });
    throwIfOfflineSyncAborted(options.signal);
    digest = sha256Buffer(content);
    content = null;
  } else {
    digest = await sha256OfflineSyncFile(options.filePath, options.signal);
  }
  throwIfOfflineSyncAborted(options.signal);
  const st = await stat(options.filePath);
  return {
    path: relPath,
    sha256: digest.sha256,
    bytes: digest.bytes,
    mtimeMs: st.mtimeMs,
    ...(content ? { contentBase64: content.toString("base64") } : {}),
  };
}

export async function* iterateOfflineSyncSnapshotFileRecords(options: {
  root: string;
  includeContent?: boolean;
  includeTranscripts?: boolean;
  readFile?: (target: OfflineSyncFileTarget) => Promise<Buffer>;
  readFileDigest?: (target: OfflineSyncFileTarget) => Promise<OfflineSyncFileDigest>;
  excludeFile?: OfflineSyncExcludeFile;
  userExcludeRegexps?: readonly RegExp[];
  /**
   * Precomputed whole-generation omission set (PR #3148 round 4): paths the
   * walk must skip because their embedding generation lost ANY member to a
   * push filter. When omitted and push excludes are active, the set is
   * computed here so streaming census consumers get the same semantics.
   */
  skipEmbeddingGenerationPaths?: ReadonlySet<string>;
  /**
   * When false, enumeration uses only the legacy structural excludes —
   * the apply/pull-side view of local files. Push-side callers keep the
   * default (true): built-in node-local state excludes + user excludes.
   * (Cursor review on PR #1793: apply-side local enumeration must see
   * files like state/lcm.sqlite or merges misclassify them.)
   */
  excludeNodeLocalState?: boolean;
  signal?: AbortSignal;
}): AsyncIterable<OfflineSyncFileRecord> {
  throwIfOfflineSyncAborted(options.signal);
  const rootAbs = path.resolve(options.root);
  const root = await prepareSafeArchiveRoot(rootAbs, "iterateOfflineSyncSnapshotFileRecords", "root");
  const includeTranscripts = options.includeTranscripts !== false;
  const pushExcludes = options.excludeNodeLocalState !== false;
  const skipGenerationPaths = options.skipEmbeddingGenerationPaths ??
    (pushExcludes
      ? (await computeOmittedEmbeddingGenerationPaths({
          rootAbs: root.abs,
          userExcludeRegexps: options.userExcludeRegexps,
          excludeFile: options.excludeFile,
          isExcludedRelPath: (relPath) =>
            shouldExcludePushRelPath(relPath, includeTranscripts, options.userExcludeRegexps),
        })).omittedPaths
      : undefined);

  async function* walk(dirAbs: string, includeContent = options.includeContent === true): AsyncIterable<OfflineSyncFileRecord> {
    throwIfOfflineSyncAborted(options.signal);
    let entries = await readdir(dirAbs, { withFileTypes: true });
    entries = entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const abs = path.join(dirAbs, entry.name);
      const relPosix = path.relative(root.abs, abs).split(path.sep).join("/");
      if (
        options.excludeNodeLocalState === false
          ? shouldExcludeRelPath(relPosix, includeTranscripts)
          : shouldExcludePushRelPath(relPosix, includeTranscripts, options.userExcludeRegexps)
      ) continue;
      if (skipGenerationPaths?.has(relPosix)) continue;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (isEmbeddingGenerationDirPath(relPosix)) {
          yield* withEmbeddingGenerationLockIter(path.dirname(abs), (content) => walk(abs, content), includeContent,
            () => assertEmbeddingGenerationStillIncluded(root.abs, relPosix, options.excludeFile,
              (rel) => shouldExcludePushRelPath(rel, includeTranscripts, options.userExcludeRegexps),
              []));
          continue;
        }
        yield* walk(abs, includeContent);
        continue;
      }
      if (!entry.isFile()) continue;
      if (await shouldExcludeOfflineSyncFile(options.excludeFile, {
        root: root.abs,
        path: relPosix,
        filePath: abs,
      })) continue;
      yield await readOfflineSyncFileRecord({
        root,
        relPath: relPosix,
        filePath: abs,
        includeContent,
        readFile: options.readFile,
        readFileDigest: options.readFileDigest,
        signal: options.signal,
      });
    }
  }

  yield* walk(root.abs);
}

export async function buildOfflineSyncSnapshot(options: {
  root: string;
  sourceId: string;
  includeContent?: boolean;
  deletions?: readonly OfflineSyncDeletionRevision[];
  includeTranscripts?: boolean;
  now?: Date;
  readFile?: (target: OfflineSyncFileTarget) => Promise<Buffer>;
  readFileDigest?: (target: OfflineSyncFileTarget) => Promise<OfflineSyncFileDigest>;
  excludeFile?: OfflineSyncExcludeFile;
  userExcludeRegexps?: readonly RegExp[];
  /**
   * When false, enumeration uses only the legacy structural excludes —
   * the apply/pull-side view of local files. Push-side callers keep the
   * default (true): built-in node-local state excludes + user excludes.
   * (Cursor review on PR #1793: apply-side local enumeration must see
   * files like state/lcm.sqlite or merges misclassify them.)
   */
  excludeNodeLocalState?: boolean;
  signal?: AbortSignal;
}): Promise<OfflineSyncSnapshot> {
  throwIfOfflineSyncAborted(options.signal);
  const includeTranscripts = options.includeTranscripts !== false;
  const pushExcludes = options.excludeNodeLocalState !== false;
  const normalizedDeletions = normalizeDeletionRevisions(options.deletions, "deletions");
  const omission = pushExcludes
    ? await computeOmittedEmbeddingGenerationPaths({
        rootAbs: path.resolve(options.root),
        userExcludeRegexps: options.userExcludeRegexps,
        excludeFile: options.excludeFile,
        tombstonedPaths: (normalizedDeletions ?? []).map((deletion) => deletion.path),
        isExcludedRelPath: (relPath) =>
          shouldExcludePushRelPath(relPath, includeTranscripts, options.userExcludeRegexps),
      })
    : undefined;
  const files: OfflineSyncFileRecord[] = [];
  for await (const file of iterateOfflineSyncSnapshotFileRecords({
    ...options,
    skipEmbeddingGenerationPaths: omission?.omittedPaths,
  })) files.push(file);
  throwIfOfflineSyncAborted(options.signal);

  const sortedFiles = files.sort(compareByPath);
  const deletions = snapshotBuilderDeletions({
    deletions: options.deletions,
    files: sortedFiles,
    includeTranscripts,
    excludeNodeLocalState: options.excludeNodeLocalState,
    userExcludeRegexps: options.userExcludeRegexps,
    omittedGenerationDirs: omission && omission.omittedDirs.length > 0
      ? new Set(omission.omittedDirs)
      : undefined,
  });
  return {
    format: OFFLINE_SYNC_SNAPSHOT_FORMAT,
    schemaVersion: 1,
    createdAt: (options.now ?? new Date()).toISOString(),
    sourceId: normalizeSourceId(options.sourceId, "sourceId"),
    includeTranscripts,
    files: sortedFiles,
    ...(deletions === undefined ? {} : { deletions }),
    ...(omission && omission.omittedDirs.length > 0
      ? { omittedEmbeddingGenerationDirs: omission.omittedDirs }
      : {}),
  };
}

export async function buildOfflineSyncSnapshotFromBase(options: {
  root: string;
  sourceId: string;
  baseFiles?: readonly OfflineSyncFileState[];
  deletions?: readonly OfflineSyncDeletionRevision[];
  baseCapturedAt?: Date;
  includeContent?: boolean;
  includeTranscripts?: boolean;
  now?: Date;
  readFile?: (target: OfflineSyncFileTarget) => Promise<Buffer>;
  readFileDigest?: (target: OfflineSyncFileTarget) => Promise<OfflineSyncFileDigest>;
  excludeFile?: OfflineSyncExcludeFile;
  userExcludeRegexps?: readonly RegExp[];
  /**
   * When false, enumeration uses only the legacy structural excludes —
   * the apply/pull-side view of local files. Push-side callers keep the
   * default (true): built-in node-local state excludes + user excludes.
   * (Cursor review on PR #1793: apply-side local enumeration must see
   * files like state/lcm.sqlite or merges misclassify them.)
   */
  excludeNodeLocalState?: boolean;
  signal?: AbortSignal;
}): Promise<OfflineSyncSnapshot> {
  throwIfOfflineSyncAborted(options.signal);
  const rootAbs = path.resolve(options.root);
  const root = await prepareSafeArchiveRoot(rootAbs, "buildOfflineSyncSnapshotFromBase", "root");
  const includeTranscripts = options.includeTranscripts !== false;
  const base = byPath(filterBaseFilesForMode(
    normalizeFileStates(options.baseFiles),
    includeTranscripts,
  ));
  const rawBaseCapturedAtMs = options.baseCapturedAt?.getTime();
  const baseCapturedAtMs = rawBaseCapturedAtMs !== undefined && Number.isFinite(rawBaseCapturedAtMs)
    ? rawBaseCapturedAtMs
    : null;
  const pushExcludes = options.excludeNodeLocalState !== false;
  const normalizedDeletions = normalizeDeletionRevisions(options.deletions, "deletions");
  const omission = pushExcludes
    ? await computeOmittedEmbeddingGenerationPaths({
        rootAbs: root.abs,
        userExcludeRegexps: options.userExcludeRegexps,
        excludeFile: options.excludeFile,
        tombstonedPaths: (normalizedDeletions ?? []).map((deletion) => deletion.path),
        isExcludedRelPath: (relPath) =>
          shouldExcludePushRelPath(relPath, includeTranscripts, options.userExcludeRegexps),
      })
    : undefined;
  const files: OfflineSyncFileRecord[] = [];

  async function walk(dirAbs: string): Promise<void> {
    throwIfOfflineSyncAborted(options.signal);
    let entries = await readdir(dirAbs, { withFileTypes: true });
    entries = entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      throwIfOfflineSyncAborted(options.signal);
      const abs = path.join(dirAbs, entry.name);
      const relPosix = path.relative(root.abs, abs).split(path.sep).join("/");
      if (
        options.excludeNodeLocalState === false
          ? shouldExcludeRelPath(relPosix, includeTranscripts)
          : shouldExcludePushRelPath(relPosix, includeTranscripts, options.userExcludeRegexps)
      ) continue;
      if (omission?.omittedPaths.has(relPosix)) continue;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (isEmbeddingGenerationDirPath(relPosix)) {
          await withEmbeddingGenerationLock(path.dirname(abs), async () => {
            await assertEmbeddingGenerationStillIncluded(root.abs, relPosix, options.excludeFile,
              (rel) => shouldExcludePushRelPath(rel, includeTranscripts, options.userExcludeRegexps),
              (normalizedDeletions ?? []).map((deletion) => deletion.path));
            await walk(abs);
          });
          continue;
        }
        await walk(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      if (await shouldExcludeOfflineSyncFile(options.excludeFile, {
        root: root.abs,
        path: relPosix,
        filePath: abs,
      })) continue;
      const st = await stat(abs);
      const baseEntry = base.get(relPosix);
      if (
        options.includeContent !== true &&
        baseEntry &&
        baseCapturedAtMs !== null &&
        await canReuseFastBaseFileStateFromDisk(baseEntry, st, baseCapturedAtMs)
      ) {
        files.push(baseEntry);
        continue;
      }
      files.push(await readOfflineSyncFileRecord({
        root,
        relPath: relPosix,
        filePath: abs,
        includeContent: options.includeContent === true,
        readFile: options.readFile,
        readFileDigest: options.readFileDigest,
        signal: options.signal,
      }));
    }
  }

  await walk(root.abs);
  throwIfOfflineSyncAborted(options.signal);

  const sortedFiles = files.sort(compareByPath);
  const deletions = snapshotBuilderDeletions({
    deletions: options.deletions,
    files: sortedFiles,
    includeTranscripts,
    excludeNodeLocalState: options.excludeNodeLocalState,
    userExcludeRegexps: options.userExcludeRegexps,
    omittedGenerationDirs: omission && omission.omittedDirs.length > 0
      ? new Set(omission.omittedDirs)
      : undefined,
  });
  return {
    format: OFFLINE_SYNC_SNAPSHOT_FORMAT,
    schemaVersion: 1,
    createdAt: (options.now ?? new Date()).toISOString(),
    sourceId: normalizeSourceId(options.sourceId, "sourceId"),
    includeTranscripts,
    files: sortedFiles,
    ...(deletions === undefined ? {} : { deletions }),
    ...(omission && omission.omittedDirs.length > 0
      ? { omittedEmbeddingGenerationDirs: omission.omittedDirs }
      : {}),
  };
}

export async function buildOfflineSyncSnapshotForPaths(options: {
  root: string;
  sourceId: string;
  paths: readonly string[];
  deletions?: readonly OfflineSyncDeletionRevision[];
  includeContent?: boolean;
  includeTranscripts?: boolean;
  now?: Date;
  readFile?: (target: OfflineSyncFileTarget) => Promise<Buffer>;
  readFileDigest?: (target: OfflineSyncFileTarget) => Promise<OfflineSyncFileDigest>;
  excludeFile?: OfflineSyncExcludeFile;
  userExcludeRegexps?: readonly RegExp[];
  /**
   * When false, enumeration uses only the legacy structural excludes —
   * the apply/pull-side view of local files. Push-side callers keep the
   * default (true): built-in node-local state excludes + user excludes.
   * (Cursor review on PR #1793: apply-side local enumeration must see
   * files like state/lcm.sqlite or merges misclassify them.)
   */
  excludeNodeLocalState?: boolean;
  signal?: AbortSignal;
}): Promise<OfflineSyncSnapshot> {
  throwIfOfflineSyncAborted(options.signal);
  const rootAbs = path.resolve(options.root);
  const root = await prepareSafeArchiveRoot(rootAbs, "buildOfflineSyncSnapshotForPaths", "root");
  const includeTranscripts = options.includeTranscripts !== false;
  const files: OfflineSyncFileRecord[] = [];
  const seen = new Set<string>();

  for (const rawPath of options.paths) {
    throwIfOfflineSyncAborted(options.signal);
    const relPath = normalizeRelativePath(rawPath, "paths[]");
    if (seen.has(relPath)) continue;
    seen.add(relPath);
    if (
      options.excludeNodeLocalState === false
        ? shouldExcludeRelPath(relPath, includeTranscripts)
        : shouldExcludePushRelPath(relPath, includeTranscripts, options.userExcludeRegexps)
    ) {
      throw new Error(`offline sync snapshot path is excluded: ${relPath}`);
    }
    const filePath = await resolveSafeArchiveTarget(root, relPath);
    const st = await lstat(filePath).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    if (!st || st.isSymbolicLink() || !st.isFile()) continue;
    if (await shouldExcludeOfflineSyncFile(options.excludeFile, {
      root: root.abs,
      path: relPath,
      filePath,
    })) {
      throw new Error(`offline sync snapshot path is excluded: ${relPath}`);
    }
    files.push(await readOfflineSyncFileRecord({
      root,
      relPath,
      filePath,
      includeContent: options.includeContent === true,
      readFile: options.readFile,
      readFileDigest: options.readFileDigest,
      signal: options.signal,
    }));
  }
  throwIfOfflineSyncAborted(options.signal);

  const sortedFiles = files.sort(compareByPath);
  const deletions = snapshotBuilderDeletions({
    deletions: options.deletions,
    files: sortedFiles,
    paths: [...seen],
    includeTranscripts,
    excludeNodeLocalState: options.excludeNodeLocalState,
    userExcludeRegexps: options.userExcludeRegexps,
  });
  return {
    format: OFFLINE_SYNC_SNAPSHOT_FORMAT,
    schemaVersion: 1,
    createdAt: (options.now ?? new Date()).toISOString(),
    sourceId: normalizeSourceId(options.sourceId, "sourceId"),
    includeTranscripts,
    files: sortedFiles,
    ...(deletions === undefined ? {} : { deletions }),
  };
}

export async function readOfflineSyncFileContentChunk(options: {
  root: string;
  path: string;
  offset?: number;
  length?: number;
  includeTranscripts?: boolean;
  readFile?: (target: OfflineSyncFileTarget) => Promise<Buffer>;
  excludeFile?: OfflineSyncExcludeFile;
  userExcludeRegexps?: readonly RegExp[];
  /**
   * When false, enumeration uses only the legacy structural excludes —
   * the apply/pull-side view of local files. Push-side callers keep the
   * default (true): built-in node-local state excludes + user excludes.
   * (Cursor review on PR #1793: apply-side local enumeration must see
   * files like state/lcm.sqlite or merges misclassify them.)
   */
  excludeNodeLocalState?: boolean;
}): Promise<OfflineSyncFileContentChunk> {
  const rootAbs = path.resolve(options.root);
  const root = await prepareSafeArchiveRoot(rootAbs, "readOfflineSyncFileContentChunk", "root");
  const includeTranscripts = options.includeTranscripts !== false;
  const relPath = normalizeRelativePath(options.path, "path");
  if (
    options.excludeNodeLocalState === false
      ? shouldExcludeRelPath(relPath, includeTranscripts)
      : shouldExcludePushRelPath(relPath, includeTranscripts, options.userExcludeRegexps)
  ) {
    throw new Error(`offline sync file content path is excluded: ${relPath}`);
  }
  const offset = options.offset === undefined
    ? 0
    : assertNonNegativeInteger(options.offset, "offset");
  const requestedLength = options.length === undefined
    ? OFFLINE_SYNC_FILE_CONTENT_MAX_CHUNK_BYTES
    : assertNonNegativeInteger(options.length, "length");
  if (requestedLength < 1 || requestedLength > OFFLINE_SYNC_FILE_CONTENT_MAX_CHUNK_BYTES) {
    throw new Error(
      `length must be an integer from 1 to ${OFFLINE_SYNC_FILE_CONTENT_MAX_CHUNK_BYTES}`,
    );
  }
  const filePath = await resolveSafeArchiveTarget(root, relPath);
  const st = await lstat(filePath).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (!st || st.isSymbolicLink() || !st.isFile()) {
    throw new Error(`offline sync file content path not found: ${relPath}`);
  }
  if (await shouldExcludeOfflineSyncFile(options.excludeFile, {
    root: root.abs,
    path: relPath,
    filePath,
  })) {
    throw new Error(`offline sync file content path is excluded: ${relPath}`);
  }
  const encrypted = await isEncryptedOfflineSyncFile(filePath);
  if (!encrypted) {
    if (offset > st.size) {
      throw new Error(`offset must be <= file size for ${relPath}`);
    }
    // Plain files need the whole-file sha256 for the response contract
    // (x-remnic-file-sha256; peer transports reject chunks without it), but
    // must stay memory-bounded for large files: the digest is computed by a
    // streamed hash pass (never buffering the file) and cached by
    // (path, bytes, mtimeMs) so per-chunk requests after the first are O(1).
    const chunk = await readPlainOfflineSyncFileChunk({
      filePath,
      offset,
      length: requestedLength,
      bytes: st.size,
    });
    const digest = await plainFileDigest(filePath);
    return {
      path: relPath,
      sha256: digest,
      bytes: st.size,
      mtimeMs: st.mtimeMs,
      offset,
      chunkBytes: chunk.length,
      content: chunk,
    };
  }
  if (!options.readFile) {
    throw new Error(`offline sync file content requires a secure-store read hook: ${relPath}`);
  }
  const content = await options.readFile({ root: root.abs, path: relPath, filePath });
  if (offset > content.length) {
    throw new Error(`offset must be <= file size for ${relPath}`);
  }
  const digest = sha256Buffer(content);
  const end = Math.min(content.length, offset + requestedLength);
  const chunk = content.subarray(offset, end);
  return {
    path: relPath,
    sha256: digest.sha256,
    bytes: digest.bytes,
    mtimeMs: st.mtimeMs,
    offset,
    chunkBytes: chunk.length,
    content: Buffer.from(chunk),
  };
}

export async function buildOfflineSyncChangeset(options: {
  root: string;
  sourceId: string;
  baseFiles?: readonly OfflineSyncFileState[];
  deletions?: readonly OfflineSyncDeletionRevision[];
  baseCapturedAt?: Date;
  excludePaths?: readonly string[];
  includeTranscripts?: boolean;
  now?: Date;
  userExcludeRegexps?: readonly RegExp[];
  /**
   * When false, enumeration uses only the legacy structural excludes —
   * the apply/pull-side view of local files. Push-side callers keep the
   * default (true): built-in node-local state excludes + user excludes.
   * (Cursor review on PR #1793: apply-side local enumeration must see
   * files like state/lcm.sqlite or merges misclassify them.)
   */
  excludeNodeLocalState?: boolean;
  readFile?: (target: OfflineSyncFileTarget) => Promise<Buffer>;
  readFileDigest?: (target: OfflineSyncFileTarget) => Promise<OfflineSyncFileDigest>;
}): Promise<OfflineSyncChangeset> {
  const includeTranscripts = options.includeTranscripts !== false;
  const current = await buildOfflineSyncSnapshotFromBase({
    root: options.root,
    sourceId: options.sourceId,
    baseFiles: options.baseFiles,
    deletions: options.deletions,
    baseCapturedAt: options.baseCapturedAt,
    includeContent: false,
    includeTranscripts,
    now: options.now,
    userExcludeRegexps: options.userExcludeRegexps,
    readFile: options.readFile,
    readFileDigest: options.readFileDigest,
  });
  return buildOfflineSyncChangesetFromSnapshot({
    root: options.root,
    sourceId: options.sourceId,
    baseFiles: options.baseFiles,
    currentFiles: current.files,
    deletions: current.deletions,
    excludePaths: options.excludePaths,
    includeTranscripts,
    now: options.now,
    userExcludeRegexps: options.userExcludeRegexps,
    readFile: options.readFile,
  });
}

export async function buildOfflineSyncChangesetFromSnapshot(options: {
  root: string;
  sourceId: string;
  currentFiles: readonly OfflineSyncFileState[];
  baseFiles?: readonly OfflineSyncFileState[];
  deletions?: readonly OfflineSyncDeletionRevision[];
  excludePaths?: readonly string[];
  includeTranscripts?: boolean;
  now?: Date;
  userExcludeRegexps?: readonly RegExp[];
  /**
   * When false, enumeration uses only the legacy structural excludes —
   * the apply/pull-side view of local files. Push-side callers keep the
   * default (true): built-in node-local state excludes + user excludes.
   * (Cursor review on PR #1793: apply-side local enumeration must see
   * files like state/lcm.sqlite or merges misclassify them.)
   */
  excludeNodeLocalState?: boolean;
  readFile?: (target: OfflineSyncFileTarget) => Promise<Buffer>;
}): Promise<OfflineSyncChangeset> {
  const includeTranscripts = options.includeTranscripts !== false;
  const excludedPaths = new Set(
    (options.excludePaths ?? []).map((relPath) => normalizeRelativePath(relPath, "excludePaths[]")),
  );
  const base = byPath(filterBaseFilesForMode(
    normalizeFileStates(options.baseFiles),
    includeTranscripts,
  ));
  const currentMap = byPath(filterBaseFilesForMode(
    normalizeFileStates(options.currentFiles),
    includeTranscripts,
  ));
  const deletions = normalizeDeletionRevisions(options.deletions, "deletions");
  const deletionMtimeByPath = deletions === undefined
    ? undefined
    : new Map(deletions.map((deletion) => [deletion.path, deletion.mtimeMs] as const));
  const changes: OfflineSyncChange[] = [];

  for (const relPath of unionPaths(base, currentMap)) {
    if (excludedPaths.has(relPath)) continue;
    // Issue #1786: node-local runtime state must never appear in a push-side
    // changeset — each node rebuilds it from synced records.
    if (shouldExcludePushRelPath(relPath, includeTranscripts, options.userExcludeRegexps)) continue;
    // Runtime state is remote-authoritative in offline sync: local edits and
    // deletes are not pushed; the pull phase restores or removes these files
    // from the remote snapshot.
    if (shouldPreferIncomingOfflineRuntimeFile(relPath)) continue;
    const baseEntry = base.get(relPath);
    const currentEntry = currentMap.get(relPath);
    if (currentEntry && currentEntry.sha256 !== baseEntry?.sha256) {
      const file = await buildOfflineSyncSnapshotForPaths({
        root: options.root,
        sourceId: options.sourceId,
        paths: [relPath],
        includeContent: true,
        includeTranscripts,
        now: options.now,
        userExcludeRegexps: options.userExcludeRegexps,
        readFile: options.readFile,
      });
      const record = file.files[0];
      if (!record || typeof record.contentBase64 !== "string" || record.sha256 !== currentEntry.sha256) {
        throw new Error(`offline sync file changed while building changeset: ${relPath}`);
      }
      changes.push({
        type: "upsert",
        path: relPath,
        ...(baseEntry ? { baseSha256: baseEntry.sha256 } : {}),
        file: record as OfflineSyncFileRecord & { contentBase64: string },
      });
      continue;
    }
    if (!currentEntry && baseEntry) {
      const mtimeMs = deletionMtimeByPath?.get(relPath);
      changes.push({
        type: "delete",
        path: relPath,
        baseSha256: baseEntry.sha256,
        ...(mtimeMs === undefined ? {} : { mtimeMs }),
      });
    }
  }

  return {
    format: OFFLINE_SYNC_CHANGESET_FORMAT,
    schemaVersion: 1,
    createdAt: (options.now ?? new Date()).toISOString(),
    sourceId: normalizeSourceId(options.sourceId, "sourceId"),
    includeTranscripts,
    changes: changes.sort(compareByPath),
  };
}

export function summarizeOfflineSyncChangeset(
  changeset: OfflineSyncChangeset,
): OfflineSyncChangesetSummary {
  const upserts = changeset.changes.filter((change) => change.type === "upsert").length;
  const deletes = changeset.changes.filter((change) => change.type === "delete").length;
  return {
    upserts,
    deletes,
    total: changeset.changes.length,
  };
}

export async function summarizeOfflineSyncPendingChanges(options: {
  root: string;
  sourceId: string;
  baseFiles?: readonly OfflineSyncFileState[];
  baseCapturedAt?: Date;
  includeTranscripts?: boolean;
  now?: Date;
  userExcludeRegexps?: readonly RegExp[];
  /**
   * When false, enumeration uses only the legacy structural excludes —
   * the apply/pull-side view of local files. Push-side callers keep the
   * default (true): built-in node-local state excludes + user excludes.
   * (Cursor review on PR #1793: apply-side local enumeration must see
   * files like state/lcm.sqlite or merges misclassify them.)
   */
  excludeNodeLocalState?: boolean;
  readFile?: (target: OfflineSyncFileTarget) => Promise<Buffer>;
  readFileDigest?: (target: OfflineSyncFileTarget) => Promise<OfflineSyncFileDigest>;
}): Promise<OfflineSyncChangesetSummary> {
  const includeTranscripts = options.includeTranscripts !== false;
  const current = await buildOfflineSyncSnapshotFromBase({
    root: options.root,
    sourceId: options.sourceId,
    baseFiles: options.baseFiles,
    baseCapturedAt: options.baseCapturedAt,
    includeContent: false,
    includeTranscripts,
    now: options.now,
    userExcludeRegexps: options.userExcludeRegexps,
    readFile: options.readFile,
    readFileDigest: options.readFileDigest,
  });
  return summarizeOfflineSyncPendingFiles({
    baseFiles: options.baseFiles,
    currentFiles: current.files,
    includeTranscripts,
    userExcludeRegexps: options.userExcludeRegexps,
  });
}

export function summarizeOfflineSyncPendingFiles(options: {
  baseFiles?: readonly OfflineSyncFileState[];
  currentFiles: readonly OfflineSyncFileState[];
  includeTranscripts?: boolean;
  userExcludeRegexps?: readonly RegExp[];
  /**
   * When false, enumeration uses only the legacy structural excludes —
   * the apply/pull-side view of local files. Push-side callers keep the
   * default (true): built-in node-local state excludes + user excludes.
   * (Cursor review on PR #1793: apply-side local enumeration must see
   * files like state/lcm.sqlite or merges misclassify them.)
   */
  excludeNodeLocalState?: boolean;
}): OfflineSyncChangesetSummary {
  const includeTranscripts = options.includeTranscripts !== false;
  const base = byPath(filterBaseFilesForMode(
    normalizeFileStates(options.baseFiles),
    includeTranscripts,
  ));
  const currentMap = byPath(filterBaseFilesForMode(
    normalizeFileStates(options.currentFiles),
    includeTranscripts,
  ));
  let upserts = 0;
  let deletes = 0;
  for (const relPath of unionPaths(base, currentMap)) {
    if (shouldPreferIncomingOfflineRuntimeFile(relPath)) continue;
    if (shouldExcludePushRelPath(relPath, includeTranscripts, options.userExcludeRegexps)) continue;
    const baseEntry = base.get(relPath);
    const currentEntry = currentMap.get(relPath);
    if (currentEntry && currentEntry.sha256 !== baseEntry?.sha256) {
      upserts += 1;
      continue;
    }
    if (!currentEntry && baseEntry) {
      deletes += 1;
    }
  }

  return {
    upserts,
    deletes,
    total: upserts + deletes,
  };
}

export async function applyOfflineSyncSnapshot(options: {
  root: string;
  snapshot: unknown;
  baseFiles?: readonly OfflineSyncFileState[];
  currentFiles?: readonly OfflineSyncFileState[];
  deferredPaths?: readonly string[];
  allowMissingConflictContent?: boolean;
  /**
   * Explicit INCOMING content source for snapshot records without inline
   * `contentBase64` (oversized generation members the client fetched
   * chunk-wise into a private staging root). Consulted only for such
   * records; return null to keep the metadata-only behavior (the local
   * file must hash-match the record). Returned buffers are digest-verified
   * against the incoming record before anything is published.
   */
  readIncomingFile?: (target: { path: string; sha256: string; bytes: number }) => Promise<Buffer | null>;
  writeConflictCopies?: boolean;
  readFile?: (target: OfflineSyncFileTarget) => Promise<Buffer>;
  readFileDigest?: (target: OfflineSyncFileTarget) => Promise<OfflineSyncFileDigest>;
  writeFile?: (target: OfflineSyncFileWriteTarget) => Promise<void>;
  writeStagingFile?: (target: OfflineSyncFileStagingWriteTarget) => Promise<void>;
  readStagingFile?: (target: OfflineSyncFileStagingReadTarget) => Promise<Buffer>;
  deleteFile?: (target: OfflineSyncFileDeleteTarget) => Promise<void>;
  recordDeletionRevision?: OfflineSyncRecordDeletionRevision;
}): Promise<OfflineSyncApplySnapshotResult> {
  const snapshot = normalizeOfflineSyncSnapshot(options.snapshot);
  const baseMap = byPath(filterBaseFilesForMode(
    normalizeFileStates(options.baseFiles),
    snapshot.includeTranscripts,
  ));
  const incomingMap = byPath(snapshot.files);
  const deletionMtimeByPath = snapshot.deletions === undefined
    ? undefined
    : new Map(snapshot.deletions.map((deletion) => [deletion.path, deletion.mtimeMs] as const));
  const incomingBuffers = await verifyRecordContents(snapshot.files, "offline sync snapshot", {
    requireContent: false,
    readIncomingFile: options.readIncomingFile,
  });
  const root = await ensureSyncRoot(options.root, "applyOfflineSyncSnapshot");
  const currentFiles = options.currentFiles
    ? filterBaseFilesForMode(normalizeFileStates(options.currentFiles), snapshot.includeTranscripts).sort(compareByPath)
    : (await buildOfflineSyncSnapshot({
        root: root.abs,
        sourceId: "local",
        includeContent: false,
        includeTranscripts: snapshot.includeTranscripts,
        readFile: options.readFile,
        readFileDigest: options.readFileDigest,
        excludeNodeLocalState: false,
      })).files;
  const currentMap = byPath(currentFiles);
  const deferredPaths = new Set([...(options.deferredPaths ?? []),
    ...divergedEmbeddingGenerationDeferrals({
      incomingFiles: snapshot.files, baseFiles: [...baseMap.values()], currentFiles,
    }),
  ]);
  const omittedGenerationDirs = new Set(snapshot.omittedEmbeddingGenerationDirs ?? []);
  if (deletionMtimeByPath && options.recordDeletionRevision) {
    for (const [relPath, mtimeMs] of deletionMtimeByPath) {
      if (
        currentMap.has(relPath) ||
        deferredPaths.has(relPath) ||
        (omittedGenerationDirs.size > 0 &&
          isPathInOmittedEmbeddingGeneration(relPath, omittedGenerationDirs)) ||
        matchesOfflineSyncDefaultExclude(relPath)
      ) {
        continue;
      }
      await options.recordDeletionRevision({
        root: root.abs,
        path: relPath,
        filePath: await resolveSafeArchiveTarget(root, relPath),
        mtimeMs,
      });
    }
  }
  const nextBase = new Map(baseMap);
  const conflicts: OfflineSyncConflict[] = [];
  let upserted = 0;
  let deleted = 0;
  let skipped = 0;
  let pendingLocal = 0;
  const conflictIncomingBuffer = (relPath: string): Buffer | undefined => {
    if (options.writeConflictCopies === false) return undefined;
    const buffer = incomingBuffers.get(relPath);
    if (buffer || options.allowMissingConflictContent === true) return buffer;
    return requiredBuffer(incomingBuffers, relPath);
  };

  // Embedding generations travel and replace as ONE unit (issue #3148):
  // atomic replacement, cross-layout marker conversion, whole-generation
  // removal on tombstones — all extracted to the generation module (issue
  // #3150) so the changeset path can share it without growing this file.
  const { transactionResults, deferredGenerationDirs } = await applyIncomingEmbeddingGenerations({
    root,
    incomingMap,
    incomingBuffers,
    baseMap,
    currentMap,
    deferredPaths,
    omittedGenerationDirs,
    deletionMtimeByPath,
    io: {
      readFile: options.readFile,
      writeStagingFile: options.writeStagingFile,
      readStagingFile: options.readStagingFile,
      deleteFile: options.deleteFile,
    },
    customIoPresent: Boolean(options.writeFile || options.readFile || options.readFileDigest || options.deleteFile),
    now: Date.now(),
  });

  const transactionHandled = new Set<string>();
  let generationUpserted = 0;
  let generationDeleted = 0;
  for (const result of transactionResults) {
    if (result.deferredLocalDivergence) {
      for (const relPath of result.handledPaths) deferredPaths.add(relPath);
      deferredGenerationDirs.add(result.shardDirRel);
      continue;
    }
    generationUpserted += result.upserted;
    generationDeleted += result.deleted;
    for (const relPath of result.handledPaths) transactionHandled.add(relPath);
    // Record converted shard paths directly; they may not be in any input map.
    for (const [relPath, state] of result.writtenStates) {
      nextBase.set(relPath, state);
      transactionHandled.add(relPath);
    }
    for (const relPath of result.removedPaths) {
      nextBase.delete(relPath);
      transactionHandled.add(relPath);
    }
  }

  for (const relPath of unionPaths(baseMap, incomingMap, currentMap)) {
    const base = baseMap.get(relPath);
    const incoming = incomingMap.get(relPath);
    const currentEntry = currentMap.get(relPath);

    if (deferredPaths.has(relPath)) {
      if (base) nextBase.set(relPath, base);
      else nextBase.delete(relPath);
      skipped += 1;
      continue;
    }

    // The generation transaction already published or removed this path and
    // applied its nextBase bookkeeping above; nothing left to do.
    if (transactionHandled.has(relPath)) continue;

    // A deferral anywhere in a generation defers the WHOLE generation: no
    // partial replacement in either direction, local files and base entries
    // stay exactly as they are.
    const membership = embeddingGenerationMembership(relPath);
    if (membership && deferredGenerationDirs.has(membership.shardDir)) {
      if (base) nextBase.set(relPath, base);
      else nextBase.delete(relPath);
      skipped += 1;
      continue;
    }

    if (incoming) {
      // The generation marker (PR #3176) is node-local on BOTH sides: an
      // incoming copy — old or hostile — never overwrites the local file
      // and never enters the base set. Other default excludes stay
      // apply-accepted (#1786: first-sync LCM sqlite bootstrapping).
      if (isEmbeddingGenerationMarkerPath(relPath)) {
        nextBase.delete(relPath);
        skipped += 1;
        continue;
      }
      if (currentEntry?.sha256 === incoming.sha256) {
        if (await setSafeFileMtime(root, relPath, incoming.mtimeMs)) {
          nextBase.set(relPath, toFileState(incoming));
        } else {
          if (base) nextBase.set(relPath, base);
          else nextBase.delete(relPath);
          pendingLocal += 1;
        }
        skipped += 1;
        continue;
      }
      // Remote unchanged from the shared base while the local file drifted:
      // keep the local copy (no content is needed to make that decision).
      // Members of a replaced generation never reach this branch — the
      // generation transaction or the deferral guard handled them above.
      if (
        shouldPreferIncomingOfflineRuntimeFile(relPath) &&
        currentEntry && base && incoming.sha256 === base.sha256
      ) {
        nextBase.set(relPath, base);
        skipped += 1;
        continue;
      }
      if (shouldPreferIncomingOfflineRuntimeFile(relPath)) {
        await writeSafeFile(root, relPath, requiredBuffer(incomingBuffers, relPath), options.writeFile, incoming.mtimeMs);
        nextBase.set(relPath, toFileState(incoming));
        upserted += 1;
        continue;
      }
      if (!currentEntry && base && incoming.sha256 === base.sha256) {
        nextBase.set(relPath, base);
        pendingLocal += 1;
        skipped += 1;
        continue;
      }
      if (!currentEntry && base && incoming.sha256 !== base.sha256) {
        conflicts.push(await recordConflict({
          root,
          relPath,
          reason: "local_deleted_remote_modified",
          baseSha256: base.sha256,
          incomingSha256: incoming.sha256,
          incomingBuffer: conflictIncomingBuffer(relPath),
          writeConflictCopies: options.writeConflictCopies !== false,
          sourceId: snapshot.sourceId,
          writeFile: options.writeFile,
        }));
        nextBase.set(relPath, base);
        continue;
      }
      if (!currentEntry && !base) {
        await writeSafeFile(root, relPath, requiredBuffer(incomingBuffers, relPath), options.writeFile, incoming.mtimeMs);
        nextBase.set(relPath, toFileState(incoming));
        upserted += 1;
        continue;
      }
      if (base && currentEntry && currentEntry.sha256 === base.sha256) {
        await writeSafeFile(root, relPath, requiredBuffer(incomingBuffers, relPath), options.writeFile, incoming.mtimeMs);
        nextBase.set(relPath, toFileState(incoming));
        upserted += 1;
        continue;
      }
      if (base && incoming.sha256 === base.sha256) {
        nextBase.set(relPath, base);
        pendingLocal += 1;
        skipped += 1;
        continue;
      }
      conflicts.push(await recordConflict({
        root,
        relPath,
        reason: base ? "both_modified" : "remote_exists_for_local_create",
        baseSha256: base?.sha256,
        localSha256: currentEntry?.sha256,
        incomingSha256: incoming.sha256,
        incomingBuffer: conflictIncomingBuffer(relPath),
        writeConflictCopies: options.writeConflictCopies !== false,
        sourceId: snapshot.sourceId,
        writeFile: options.writeFile,
      }));
      if (base) nextBase.set(relPath, base);
      continue;
    }

    // Node-local runtime state (#1786): a push-filtered remote snapshot
    // never carries these paths, so their absence is NOT a delete
    // instruction. Drop any stale base entry (pre-#1786 state files still
    // carry them) and leave the local file untouched — deleting a live
    // sqlite WAL/SHM here would corrupt the local LCM store.
    if (matchesOfflineSyncDefaultExclude(relPath)) {
      nextBase.delete(relPath);
      skipped += 1;
      continue;
    }
    if (!currentEntry) {
      nextBase.delete(relPath);
      skipped += 1;
      continue;
    }
    if (
      shouldPreferIncomingOfflineRuntimeFile(relPath) &&
      membership !== null && omittedGenerationDirs.has(membership.shardDir)
    ) {
      // The push omitted this whole generation because a filter excluded at
      // least one member (snapshot.omittedEmbeddingGenerationDirs): absence
      // is NOT a deletion — keep the local generation and its base entries
      // until it is pushed unfiltered or deleted with deletion metadata.
      pendingLocal += 1;
      skipped += 1;
      continue;
    }
    if (
      shouldPreferIncomingOfflineRuntimeFile(relPath) &&
      (base || shouldDeleteAbsentIncomingOfflineRuntimeFile(relPath))
    ) {
      await deleteSafeFile(
        root,
        relPath,
        options.deleteFile,
        deletionMtimeByPath?.get(relPath),
      );
      nextBase.delete(relPath);
      deleted += 1;
      continue;
    }
    if (shouldPreferIncomingOfflineRuntimeFile(relPath)) {
      pendingLocal += 1;
      skipped += 1;
      continue;
    }
    if (base && currentEntry.sha256 === base.sha256) {
      await deleteSafeFile(
        root,
        relPath,
        options.deleteFile,
        deletionMtimeByPath?.get(relPath),
      );
      nextBase.delete(relPath);
      deleted += 1;
      continue;
    }
    if (base) {
      conflicts.push({
        path: relPath,
        reason: "local_modified_remote_deleted",
        baseSha256: base.sha256,
        localSha256: currentEntry.sha256,
      });
      nextBase.set(relPath, base);
      continue;
    }
    pendingLocal += 1;
    skipped += 1;
  }

  return {
    upserted: upserted + generationUpserted,
    deleted: deleted + generationDeleted,
    skipped,
    pendingLocal,
    conflicts,
    nextBaseFiles: [...nextBase.values()].sort(compareByPath),
  };
}

export async function applyOfflineSyncChangeset(options: {
  root: string;
  changeset: unknown;
  currentFiles?: readonly OfflineSyncFileState[];
  returnCurrentFiles?: boolean;
  writeConflictCopies?: boolean;
  readFile?: (target: OfflineSyncFileTarget) => Promise<Buffer>;
  readFileDigest?: (target: OfflineSyncFileTarget) => Promise<OfflineSyncFileDigest>;
  writeFile?: (target: OfflineSyncFileWriteTarget) => Promise<void>;
  writeStagingFile?: (target: OfflineSyncFileStagingWriteTarget) => Promise<void>;
  readStagingFile?: (target: OfflineSyncFileStagingReadTarget) => Promise<Buffer>;
  deleteFile?: (target: OfflineSyncFileDeleteTarget) => Promise<void>;
  recordDeletionRevision?: OfflineSyncRecordDeletionRevision;
}): Promise<OfflineSyncApplyChangesetResult> {
  let changeset: OfflineSyncChangeset;
  try {
    changeset = normalizeOfflineSyncChangeset(options.changeset);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      message.startsWith("offline sync")
        ? message
        : `offline sync changeset invalid: ${message}`,
    );
  }
  const root = await ensureSyncRoot(options.root, "applyOfflineSyncChangeset");
  const records = changeset.changes
    .filter((change): change is Extract<OfflineSyncChange, { type: "upsert" }> => change.type === "upsert")
    .map((change) => change.file);
  const incomingBuffers = await verifyRecordContents(records, "offline sync changeset");
  const currentFiles = options.currentFiles
    ? filterBaseFilesForMode(normalizeFileStates(options.currentFiles), changeset.includeTranscripts).sort(compareByPath)
    : (await buildOfflineSyncSnapshotForPaths({
        root: root.abs,
        sourceId: "local",
        paths: changeset.changes.map((change) => change.path),
        includeContent: false,
        includeTranscripts: changeset.includeTranscripts,
        readFile: options.readFile,
        readFileDigest: options.readFileDigest,
        excludeNodeLocalState: false,
      })).files;
  const currentMap = byPath(currentFiles);
  const conflicts: OfflineSyncConflict[] = [];
  let appliedUpserts = 0;
  let appliedDeletes = 0;
  let skipped = 0;

  // Embedding generations apply as ONE unit through the shared locked
  // transaction (issue #3150). Deferred generations surface as conflicts so
  // the push side never checkpoints them as applied.
  const generationRouting = await applyChangesetEmbeddingGenerations({
    root,
    changeset,
    incomingBuffers,
    currentMap,
    io: {
      readFile: options.readFile,
      writeStagingFile: options.writeStagingFile,
      readStagingFile: options.readStagingFile,
      deleteFile: options.deleteFile,
    },
    customIoPresent: Boolean(options.writeFile || options.readFile || options.readFileDigest || options.deleteFile),
    now: Date.now(),
  });
  appliedUpserts += generationRouting.appliedUpserts;
  appliedDeletes += generationRouting.appliedDeletes;
  conflicts.push(...generationRouting.conflicts);

  for (const change of changeset.changes) {
    if (generationRouting.conflictedPaths.has(change.path)) continue;
    if (generationRouting.transactionHandled.has(change.path)) continue;
    const currentEntry = currentMap.get(change.path);
    if (change.type === "upsert") {
      if (currentEntry?.sha256 === change.file.sha256) {
        if (await setSafeFileMtime(root, change.path, change.file.mtimeMs)) {
          skipped += 1;
        } else {
          await writeSafeFile(root, change.path, requiredBuffer(incomingBuffers, change.path), options.writeFile, change.file.mtimeMs);
          currentMap.set(change.path, toFileState(change.file));
          appliedUpserts += 1;
        }
        continue;
      }
      if (!change.baseSha256) {
        if (!currentEntry) {
          await writeSafeFile(root, change.path, requiredBuffer(incomingBuffers, change.path), options.writeFile, change.file.mtimeMs);
          currentMap.set(change.path, toFileState(change.file));
          appliedUpserts += 1;
          continue;
        }
        conflicts.push(await recordConflict({
          root,
          relPath: change.path,
          reason: "remote_exists_for_local_create",
          localSha256: currentEntry.sha256,
          incomingSha256: change.file.sha256,
          incomingBuffer: incomingBuffers.get(change.path),
          writeConflictCopies: options.writeConflictCopies !== false,
          sourceId: changeset.sourceId,
          writeFile: options.writeFile,
        }));
        continue;
      }
      if (currentEntry?.sha256 === change.baseSha256) {
        await writeSafeFile(root, change.path, requiredBuffer(incomingBuffers, change.path), options.writeFile, change.file.mtimeMs);
        currentMap.set(change.path, toFileState(change.file));
        appliedUpserts += 1;
        continue;
      }
      conflicts.push(await recordConflict({
        root,
        relPath: change.path,
        reason: currentEntry ? "remote_changed_for_local_update" : "remote_deleted_for_local_update",
        baseSha256: change.baseSha256,
        localSha256: currentEntry?.sha256,
        incomingSha256: change.file.sha256,
        incomingBuffer: incomingBuffers.get(change.path),
        writeConflictCopies: options.writeConflictCopies !== false,
        sourceId: changeset.sourceId,
        writeFile: options.writeFile,
      }));
      continue;
    }

    if (!currentEntry) {
      if (change.mtimeMs !== undefined && options.recordDeletionRevision) {
        await options.recordDeletionRevision({
          root: root.abs,
          path: change.path,
          filePath: await resolveSafeArchiveTarget(root, change.path),
          mtimeMs: change.mtimeMs,
        });
      }
      skipped += 1;
      continue;
    }
    if (currentEntry.sha256 === change.baseSha256) {
      await deleteSafeFile(root, change.path, options.deleteFile, change.mtimeMs);
      currentMap.delete(change.path);
      appliedDeletes += 1;
      continue;
    }
    conflicts.push({
      path: change.path,
      reason: "remote_changed_for_local_delete",
      baseSha256: change.baseSha256,
      localSha256: currentEntry.sha256,
    });
  }

  // Generation transactions bypassed the per-file loop; fold their published
  // and removed members into the partial result map (returnCurrentFiles ===
  // false consumers) so it reflects the post-apply generation exactly.
  for (const [relPath, state] of generationRouting.writtenStates) currentMap.set(relPath, state);
  for (const relPath of generationRouting.removedPaths) currentMap.delete(relPath);

  return {
    appliedUpserts,
    appliedDeletes,
    skipped,
    conflicts,
    currentFiles: options.returnCurrentFiles === false
      ? [...currentMap.values()].sort(compareByPath)
      : (await buildOfflineSyncSnapshot({
          root: root.abs,
          sourceId: "local",
          includeContent: false,
          includeTranscripts: changeset.includeTranscripts,
          readFile: options.readFile,
          readFileDigest: options.readFileDigest,
          excludeNodeLocalState: false,
        })).files,
    ...(options.returnCurrentFiles === false ? { currentFilesComplete: false } : {}),
  };
}

async function verifyRecordContents(
  records: readonly OfflineSyncFileRecord[],
  context: string,
  options: {
    requireContent?: boolean;
    readIncomingFile?: (target: { path: string; sha256: string; bytes: number }) => Promise<Buffer | null>;
  } = {},
): Promise<Map<string, Buffer>> {
  const buffers = new Map<string, Buffer>();
  for (const record of records) {
    if (typeof record.contentBase64 !== "string") {
      if (options.readIncomingFile) {
        // Explicit INCOMING content source for records whose bytes travel
        // out-of-band (chunked fetch into the client's private staging
        // root). Never the local current-state file: the buffer is
        // digest-verified against the incoming record before anything is
        // published. null keeps the metadata-only behavior below.
        const incoming = await options.readIncomingFile({
          path: record.path,
          sha256: record.sha256,
          bytes: record.bytes,
        });
        if (incoming) {
          const digest = sha256Buffer(incoming);
          if (digest.sha256 !== record.sha256 || digest.bytes !== record.bytes) {
            throw new Error(`${context}: incoming content checksum mismatch for ${record.path}`);
          }
          buffers.set(record.path, incoming);
          continue;
        }
      }
      if (options.requireContent === false) continue;
      throw new Error(`${context}: contentBase64 is required for ${record.path}`);
    }
    const buffer = Buffer.from(record.contentBase64, "base64");
    const digest = sha256Buffer(buffer);
    if (digest.sha256 !== record.sha256 || digest.bytes !== record.bytes) {
      throw new Error(
        `${context}: content checksum mismatch for ${record.path}`,
      );
    }
    buffers.set(record.path, buffer);
  }
  return buffers;
}

function requiredBuffer(buffers: Map<string, Buffer>, relPath: string): Buffer {
  const buffer = buffers.get(relPath);
  if (!buffer) {
    throw new Error(`missing decoded content for ${relPath}`);
  }
  return buffer;
}

async function ensureSyncRoot(rootPath: string, errorPrefix: string): Promise<SafeArchiveRoot> {
  const rootAbs = path.resolve(rootPath);
  await mkdir(rootAbs, { recursive: true });
  return prepareSafeArchiveRoot(rootAbs, errorPrefix, "root");
}

function byPath<T extends OfflineSyncFileState>(files: readonly T[]): Map<string, T> {
  const out = new Map<string, T>();
  for (const file of files) {
    out.set(validateArchiveRelativePath(file.path, "offlineSync"), file);
  }
  return out;
}

function unionPaths(...maps: Array<Map<string, unknown>>): string[] {
  const paths = new Set<string>();
  for (const map of maps) {
    for (const key of map.keys()) paths.add(key);
  }
  return [...paths].sort();
}

function toFileState(file: OfflineSyncFileState): OfflineSyncFileState {
  return {
    path: file.path,
    sha256: file.sha256,
    bytes: file.bytes,
    mtimeMs: file.mtimeMs,
  };
}

async function writeSafeFile(
  root: SafeArchiveRoot,
  relPath: string,
  content: Buffer,
  writeFileHook?: (target: OfflineSyncFileWriteTarget) => Promise<void>,
  mtimeMs?: number,
): Promise<void> {
  const target = await resolveSafeArchiveTarget(root, relPath);
  if (writeFileHook) {
    await writeFileHook({ root: root.abs, path: relPath, filePath: target, content });
    await setSafeFileMtime(root, relPath, mtimeMs);
    return;
  }
  await mkdir(path.dirname(target), { recursive: true });
  const tmp = path.join(
    path.dirname(target),
    `.remnic-sync.${process.pid}.${randomUUID()}.tmp`,
  );
  await writeFile(tmp, content);
  try {
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
    await unlink(tmp).catch(() => {});
    throw error;
  }
}


/**
 * Read the local file digest for a single relative path without applying
 * push-side exclude rules. Used by apply-side helpers that need to check
 * the current local state of a path that the push-side exclude would
 * reject (e.g. `state/lcm.sqlite`). Returns `null` if the file does not
 * exist, is not a regular file, or is a symlink.
 */
async function readLocalFileState(options: {
  rootAbs: string;
  relPath: string;
  readFile?: (target: OfflineSyncFileTarget) => Promise<Buffer>;
  readFileDigest?: (target: OfflineSyncFileTarget) => Promise<OfflineSyncFileDigest>;
  signal?: AbortSignal;
}): Promise<OfflineSyncFileState | null> {
  const filePath = await resolveSafeArchiveTarget(
    await prepareSafeArchiveRoot(options.rootAbs, "readLocalFileState", "rootAbs"),
    options.relPath,
  );
  const st = await lstat(filePath).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (!st || st.isSymbolicLink() || !st.isFile()) return null;
  throwIfOfflineSyncAborted(options.signal);
  let digest: OfflineSyncFileDigest;
  if (options.readFileDigest) {
    digest = await options.readFileDigest({ root: options.rootAbs, path: options.relPath, filePath });
  } else if (options.readFile) {
    const content = await options.readFile({ root: options.rootAbs, path: options.relPath, filePath });
    digest = sha256Buffer(content);
  } else {
    digest = await sha256OfflineSyncFile(filePath, options.signal);
  }
  throwIfOfflineSyncAborted(options.signal);
  return {
    path: options.relPath,
    sha256: digest.sha256,
    bytes: digest.bytes,
    mtimeMs: st.mtimeMs,
  };
}

export async function applyOfflineSyncFileContentChunk(options: {
  root: string;
  sourceId: string;
  path: string;
  sha256: string;
  bytes: number;
  mtimeMs: number;
  offset?: number;
  content: Buffer;
  baseSha256?: string;
  includeTranscripts?: boolean;
  readFile?: (target: OfflineSyncFileTarget) => Promise<Buffer>;
  readFileDigest?: (target: OfflineSyncFileTarget) => Promise<OfflineSyncFileDigest>;
  writeFile?: (target: OfflineSyncFileWriteTarget) => Promise<void>;
  writeStagingFile?: (target: OfflineSyncFileStagingWriteTarget) => Promise<void>;
  writeFileChunks?: (target: OfflineSyncFileWriteChunksTarget) => Promise<void>;
}): Promise<OfflineSyncApplyFileContentChunkResult> {
  const root = await ensureSyncRoot(options.root, "applyOfflineSyncFileContentChunk");
  const sourceId = normalizeSourceId(options.sourceId, "sourceId");
  const relPath = normalizeRelativePath(options.path, "path");
  const includeTranscripts = options.includeTranscripts !== false;
  if (shouldExcludeRelPath(relPath, includeTranscripts)) {
    throw new Error(`offline sync file content path is excluded: ${relPath}`);
  }
  const sha256 = assertSha256(options.sha256, "sha256");
  const bytes = assertNonNegativeInteger(options.bytes, "bytes");
  const mtimeMs = assertOfflineSyncMtimeMs(options.mtimeMs, "mtimeMs");
  const offset = options.offset === undefined
    ? 0
    : assertNonNegativeInteger(options.offset, "offset");
  const baseSha256 = options.baseSha256 === undefined
    ? undefined
    : assertSha256(options.baseSha256, "baseSha256");
  const preferIncomingRuntimeFile = shouldPreferIncomingOfflineRuntimeFile(relPath);
  if (!Buffer.isBuffer(options.content)) {
    throw new Error("content must be a Buffer");
  }
  if (options.content.length > OFFLINE_SYNC_FILE_CONTENT_MAX_CHUNK_BYTES) {
    throw new Error(
      `content chunk must be ${OFFLINE_SYNC_FILE_CONTENT_MAX_CHUNK_BYTES} bytes or fewer`,
    );
  }
  if (bytes > 0 && options.content.length === 0) {
    throw new Error("content chunk must be non-empty before EOF");
  }
  if (offset > bytes || offset + options.content.length > bytes) {
    throw new Error(`content chunk range exceeds declared file size for ${relPath}`);
  }
  if (options.writeFile && !options.writeFileChunks) {
    throw new Error("offline sync upload storage hooks require writeFileChunks");
  }
  if (options.writeFile && !options.writeStagingFile) {
    throw new Error("offline sync upload storage hooks require writeStagingFile");
  }
  const baseResult = {
    path: relPath,
    sha256,
    bytes,
    mtimeMs,
    offset,
    chunkBytes: options.content.length,
    done: offset + options.content.length === bytes,
  };
  const currentFileConflict = async (
    currentFile: OfflineSyncFileState | undefined,
  ): Promise<{ conflict: OfflineSyncConflict; currentFile?: OfflineSyncFileState } | null> => {
    if (!baseSha256 && currentFile && !preferIncomingRuntimeFile) {
      const conflict = await recordConflict({
        root,
        relPath,
        reason: "remote_exists_for_local_create",
        localSha256: currentFile.sha256,
        incomingSha256: sha256,
        writeConflictCopies: false,
        sourceId,
        writeFile: options.writeFile,
      });
      return {
        conflict,
        currentFile,
      };
    }
    if (baseSha256 && currentFile?.sha256 !== baseSha256 && !preferIncomingRuntimeFile) {
      const conflict = await recordConflict({
        root,
        relPath,
        reason: currentFile ? "remote_changed_for_local_update" : "remote_deleted_for_local_update",
        baseSha256,
        localSha256: currentFile?.sha256,
        incomingSha256: sha256,
        writeConflictCopies: false,
        sourceId,
        writeFile: options.writeFile,
      });
      return {
        conflict,
        ...(currentFile ? { currentFile } : {}),
      };
    }
    return null;
  };
  if (offset === 0) {
    await pruneOfflineUploadStaging(root);
    const currentFile = await readLocalFileState({
      rootAbs: root.abs,
      relPath,
      readFile: options.readFile,
      readFileDigest: options.readFileDigest,
    });
    if (currentFile && currentFile.sha256 === sha256) {
      await setSafeFileMtime(root, relPath, mtimeMs);
      return {
        ...baseResult,
        done: true,
        chunkBytes: 0,
        applied: false,
        skipped: true,
        currentFile: toFileState(currentFile),
      };
    }
    const conflictResult = await currentFileConflict(currentFile ? toFileState(currentFile) : undefined);
    if (conflictResult) {
      return {
        ...baseResult,
        done: true,
        chunkBytes: 0,
        applied: false,
        skipped: false,
        ...conflictResult,
      };
    }
  }

  const upload = await writeOfflineUploadChunk({
    root,
    sourceId,
    relPath,
    sha256,
    bytes,
    offset,
    content: options.content,
    readFile: options.readFile,
    writeFile: options.writeFile,
    writeStagingFile: options.writeStagingFile,
  });
  const done = baseResult.done;
  if (!done) {
    return {
      ...baseResult,
      applied: false,
      skipped: false,
    };
  }

  const digest = await digestOfflineUploadStagingContent({
    root,
    upload,
    readFile: options.readFile,
  });
  if (digest.sha256 !== sha256 || digest.bytes !== bytes) {
    await cleanupOfflineUpload(upload).catch(() => {});
    throw new Error(`offline sync upload checksum mismatch for ${relPath}`);
  }

  const currentFile = await readLocalFileState({
    rootAbs: root.abs,
    relPath,
    readFile: options.readFile,
    readFileDigest: options.readFileDigest,
  });
  const uploadedState: OfflineSyncFileState = {
    path: relPath,
    sha256,
    bytes,
    mtimeMs,
  };

  try {
    if (currentFile && currentFile.sha256 === sha256) {
      await setSafeFileMtime(root, relPath, mtimeMs);
      return {
        ...baseResult,
        applied: false,
        skipped: true,
        currentFile: uploadedState,
      };
    }

    const conflictResult = await currentFileConflict(currentFile ? toFileState(currentFile) : undefined);
    if (conflictResult) {
      return {
        ...baseResult,
        applied: false,
        skipped: false,
        ...conflictResult,
      };
    }

    await writeSafeFileFromUpload(root, relPath, upload, options.readFile, options.writeFileChunks, mtimeMs);
    return {
      ...baseResult,
      applied: true,
      skipped: false,
      currentFile: uploadedState,
    };
  } finally {
    await cleanupOfflineUpload(upload).catch(() => {});
  }
}


async function deleteSafeFile(
  root: SafeArchiveRoot,
  relPath: string,
  deleteFile?: (target: OfflineSyncFileDeleteTarget) => Promise<void>,
  mtimeMs?: number,
): Promise<void> {
  const target = await resolveSafeArchiveTarget(root, relPath);
  if (deleteFile) {
    await deleteFile({
      root: root.abs,
      path: relPath,
      filePath: target,
      ...(mtimeMs === undefined ? {} : { mtimeMs }),
    });
    return;
  }
  await unlink(target).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  });
}

async function recordConflict(options: {
  root: SafeArchiveRoot;
  relPath: string;
  reason: OfflineSyncConflict["reason"];
  baseSha256?: string;
  localSha256?: string;
  incomingSha256?: string;
  incomingBuffer?: Buffer;
  writeConflictCopies: boolean;
  sourceId: string;
  writeFile?: (target: OfflineSyncFileWriteTarget) => Promise<void>;
}): Promise<OfflineSyncConflict> {
  let conflictPath: string | undefined;
  if (options.writeConflictCopies && options.incomingBuffer) {
    const sourceHash = hashText(options.sourceId).slice(0, 12);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    conflictPath = `${SYNC_INTERNAL_DIR}/conflicts/${stamp}-${sourceHash}/${options.relPath}`;
    await writeSafeFile(options.root, conflictPath, options.incomingBuffer, options.writeFile);
  }
  return {
    path: options.relPath,
    reason: options.reason,
    baseSha256: options.baseSha256,
    localSha256: options.localSha256,
    incomingSha256: options.incomingSha256,
    ...(conflictPath ? { conflictPath } : {}),
  };
}

export function defaultOfflineSyncStatePath(
  memoryDir: string,
  remoteId: string,
  namespace?: string,
): string {
  const key = hashText(`${remoteId}\0${namespace ?? ""}`).slice(0, 16);
  return path.join(path.resolve(memoryDir), SYNC_INTERNAL_DIR, "state", `${key}.json`);
}

export async function readOfflineSyncState(
  statePath: string,
): Promise<OfflineSyncState | null> {
  let raw: string;
  try {
    raw = await readFile(path.resolve(statePath), "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const parsed = JSON.parse(raw) as unknown;
  return normalizeOfflineSyncState(parsed);
}

export async function writeOfflineSyncState(
  statePath: string,
  state: OfflineSyncState,
): Promise<void> {
  const normalized = normalizeOfflineSyncState(state);
  const target = path.resolve(statePath);
  await mkdir(path.dirname(target), { recursive: true });
  const tmp = path.join(
    path.dirname(target),
    `.remnic-sync-state.${process.pid}.${randomUUID()}.tmp`,
  );
  await writeFile(tmp, JSON.stringify(normalized, null, 2) + "\n", "utf-8");
  try {
    await rename(tmp, target);
  } catch (error) {
    await unlink(tmp).catch(() => {});
    throw error;
  }
}

export function offlineSyncStateFromSnapshot(options: {
  remoteId: string;
  namespace?: string;
  snapshot: OfflineSyncSnapshot;
  baseFiles?: readonly OfflineSyncFileState[];
}): OfflineSyncState {
  const snapshot = normalizeOfflineSyncSnapshot(options.snapshot);
  return normalizeOfflineSyncState({
    version: OFFLINE_SYNC_STATE_VERSION,
    remoteId: options.remoteId,
    namespace: options.namespace,
    includeTranscripts: snapshot.includeTranscripts,
    lastSyncedAt: new Date().toISOString(),
    baseFiles: options.baseFiles ?? snapshot.files.map(toFileState),
  });
}

export function normalizeOfflineSyncState(input: unknown): OfflineSyncState {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("offline sync state must be an object");
  }
  const obj = input as Record<string, unknown>;
  if (obj.version !== OFFLINE_SYNC_STATE_VERSION) {
    throw new Error(`offline sync state version must be ${OFFLINE_SYNC_STATE_VERSION}`);
  }
  const namespace =
    typeof obj.namespace === "string" && obj.namespace.trim().length > 0
      ? obj.namespace.trim()
      : undefined;
  const baseFiles = normalizeFileStates(obj.baseFiles as readonly unknown[] | undefined)
    .sort(compareByPath);
  assertUniquePaths(baseFiles, "offline sync state");
  return {
    version: OFFLINE_SYNC_STATE_VERSION,
    remoteId: normalizeSourceId(obj.remoteId, "remoteId"),
    ...(namespace ? { namespace } : {}),
    includeTranscripts: assertBoolean(obj.includeTranscripts, "includeTranscripts"),
    lastSyncedAt: normalizeIsoString(obj.lastSyncedAt, "lastSyncedAt"),
    baseFiles,
  };
}

export function fileStatesFromSnapshot(snapshot: OfflineSyncSnapshot): OfflineSyncFileState[] {
  return normalizeOfflineSyncSnapshot(snapshot).files.map(toFileState).sort(compareByPath);
}
