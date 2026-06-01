import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
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
import { isEncryptedFile, MAGIC_HEADER_SIZE } from "./secure-store/secure-fs.js";
import {
  prepareSafeArchiveRoot,
  resolveSafeArchiveTarget,
  sha256Bytes,
  validateArchiveRelativePath,
  type SafeArchiveRoot,
} from "./transfer/fs-utils.js";
import { parseFlexibleIsoTimestamp } from "./utils/iso-timestamp.js";

export const OFFLINE_SYNC_SNAPSHOT_FORMAT = "remnic.offline-sync.snapshot.v1";
export const OFFLINE_SYNC_CHANGESET_FORMAT = "remnic.offline-sync.changeset.v1";
export const OFFLINE_SYNC_STATE_VERSION = 1;
export const OFFLINE_SYNC_FILE_CONTENT_MAX_CHUNK_BYTES = 64 * 1024 * 1024;
export const OFFLINE_SYNC_FILE_CONTENT_TRANSFER_CHUNK_BYTES = 8 * 1024 * 1024;
export const OFFLINE_SYNC_APPLY_MAX_BODY_BYTES = 16 * 1024 * 1024;
export const OFFLINE_SYNC_SNAPSHOT_BASE_MAX_BODY_BYTES = 64 * 1024 * 1024;
export const OFFLINE_SYNC_MAX_MTIME_MS = 8_640_000_000_000_000;

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

export interface OfflineSyncSnapshot {
  format: typeof OFFLINE_SYNC_SNAPSHOT_FORMAT;
  schemaVersion: 1;
  createdAt: string;
  sourceId: string;
  includeTranscripts: boolean;
  files: OfflineSyncFileRecord[];
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
    };

export interface OfflineSyncChangeset {
  format: typeof OFFLINE_SYNC_CHANGESET_FORMAT;
  schemaVersion: 1;
  createdAt: string;
  sourceId: string;
  includeTranscripts: boolean;
  changes: OfflineSyncChange[];
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
    | "remote_changed_for_local_delete";
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

export interface OfflineSyncFileTarget {
  root: string;
  path: string;
  filePath: string;
}

export interface OfflineSyncFileWriteTarget extends OfflineSyncFileTarget {
  content: Buffer;
}

export interface OfflineSyncFileWriteChunksTarget extends OfflineSyncFileTarget {
  chunks: AsyncIterable<Buffer>;
}

export interface OfflineSyncFileStagingWriteTarget extends OfflineSyncFileWriteTarget {}

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

const SYNC_INTERNAL_DIR = ".offline-sync";
const OFFLINE_SYNC_UPLOAD_STAGING_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const OFFLINE_SYNC_FAST_BASE_MTIME_TOLERANCE_MS = 1_000;
const OFFLINE_SYNC_FAST_BASE_CTIME_TOLERANCE_MS = 1;
const EXCLUDED_FILE_NAMES = new Set([
  ".sync-state.json",
]);

const EXCLUDED_FILE_PREFIXES = [
  ".remnic-sync.",
  ".remnic-sync-state.",
];

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

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
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/i.test(value)) {
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

function assertNonNegativeFinite(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${field} must be a non-negative finite number`);
  }
  return value;
}

function assertOfflineSyncMtimeMs(value: unknown, field: string): number {
  const mtimeMs = assertNonNegativeFinite(value, field);
  if (mtimeMs > OFFLINE_SYNC_MAX_MTIME_MS) {
    throw new Error(`${field} must be within JavaScript Date range`);
  }
  return mtimeMs;
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
  assertUniquePaths(files, "offline sync snapshot");
  if (!includeTranscripts) {
    const transcriptPath = files.find((file) => file.path.split("/")[0] === "transcripts")?.path;
    if (transcriptPath) {
      throw new Error(
        `offline sync snapshot includeTranscripts is false but contains transcript path: ${transcriptPath}`,
      );
    }
  }
  const excludedPath = files.find((file) => shouldExcludeRelPath(file.path, true))?.path;
  if (excludedPath) {
    throw new Error(`offline sync snapshot contains excluded path: ${excludedPath}`);
  }
  return {
    format: OFFLINE_SYNC_SNAPSHOT_FORMAT,
    schemaVersion: 1,
    createdAt,
    sourceId,
    includeTranscripts,
    files,
  };
}

export function normalizeOfflineSyncChangeset(input: unknown): OfflineSyncChangeset {
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
      return {
        type: "delete",
        path: relPath,
        baseSha256: assertSha256(change.baseSha256, `changes[${index}].baseSha256`),
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
  return {
    format: OFFLINE_SYNC_CHANGESET_FORMAT,
    schemaVersion: 1,
    createdAt,
    sourceId,
    includeTranscripts,
    changes: changes.sort(compareByPath),
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

function shouldExcludeRelPath(relPosix: string, includeTranscripts: boolean): boolean {
  const parts = relPosix.split("/");
  if (parts.some((part) => DEFAULT_TRANSFER_EXCLUDE_DIRS.has(part))) return true;
  if (parts.some((part) => part === SYNC_INTERNAL_DIR)) return true;
  if (!includeTranscripts && parts[0] === "transcripts") return true;
  const basename = parts[parts.length - 1] ?? "";
  if (isCanonicalRuntimeStatePath(parts) && basename.includes(".tmp-")) return true;
  if (EXCLUDED_FILE_NAMES.has(basename)) return true;
  return EXCLUDED_FILE_PREFIXES.some((prefix) => basename.startsWith(prefix));
}

function shouldIgnoreIncomingRuntimePath(relPosix: string): boolean {
  const parts = relPosix.split("/");
  const basename = parts[parts.length - 1] ?? "";
  return isCanonicalRuntimeStatePath(parts) && basename.includes(".tmp-");
}

function isCanonicalRuntimeStatePath(parts: string[]): boolean {
  if (parts[0] === "state") return true;
  return parts[0] === "namespaces" && parts.length >= 4 && parts[2] === "state";
}

const REMOTE_AUTHORITATIVE_RUNTIME_STATE_FILES = new Set([
  ".artifact-write-version.log",
  ".memory-status-version.log",
  "buffer.json",
  "embeddings.json",
  "index_time.json",
  "last_intent.json",
  "last_recall.json",
  "memory-lifecycle-ledger.jsonl",
  "recall_impressions.jsonl",
]);

export function shouldPreferIncomingOfflineRuntimeFile(relPosix: string): boolean {
  const parts = relPosix.split("/");
  const basename = parts[parts.length - 1] ?? "";
  return isCanonicalRuntimeStatePath(parts) && REMOTE_AUTHORITATIVE_RUNTIME_STATE_FILES.has(basename);
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
    digest = await sha256File(options.filePath, options.signal);
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

async function sha256File(filePath: string, signal?: AbortSignal): Promise<OfflineSyncFileDigest> {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(filePath)) {
    throwIfOfflineSyncAborted(signal);
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    hash.update(buffer);
    bytes += buffer.length;
  }
  throwIfOfflineSyncAborted(signal);
  return {
    sha256: hash.digest("hex"),
    bytes,
  };
}

async function fileIsSecureStoreEncrypted(filePath: string): Promise<boolean> {
  const handle = await open(filePath, "r");
  try {
    const header = Buffer.alloc(MAGIC_HEADER_SIZE);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    return bytesRead >= MAGIC_HEADER_SIZE && isEncryptedFile(header);
  } finally {
    await handle.close();
  }
}

async function readPlainFileContentChunk(options: {
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

export async function* iterateOfflineSyncSnapshotFileRecords(options: {
  root: string;
  includeContent?: boolean;
  includeTranscripts?: boolean;
  readFile?: (target: OfflineSyncFileTarget) => Promise<Buffer>;
  readFileDigest?: (target: OfflineSyncFileTarget) => Promise<OfflineSyncFileDigest>;
  signal?: AbortSignal;
}): AsyncIterable<OfflineSyncFileRecord> {
  throwIfOfflineSyncAborted(options.signal);
  const rootAbs = path.resolve(options.root);
  const root = await prepareSafeArchiveRoot(rootAbs, "iterateOfflineSyncSnapshotFileRecords", "root");
  const includeTranscripts = options.includeTranscripts !== false;

  async function* walk(dirAbs: string): AsyncIterable<OfflineSyncFileRecord> {
    throwIfOfflineSyncAborted(options.signal);
    let entries = await readdir(dirAbs, { withFileTypes: true });
    entries = entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      throwIfOfflineSyncAborted(options.signal);
      const abs = path.join(dirAbs, entry.name);
      const relPosix = path.relative(root.abs, abs).split(path.sep).join("/");
      if (shouldExcludeRelPath(relPosix, includeTranscripts)) continue;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        yield* walk(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      yield await readOfflineSyncFileRecord({
        root,
        relPath: relPosix,
        filePath: abs,
        includeContent: options.includeContent === true,
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
  includeTranscripts?: boolean;
  now?: Date;
  readFile?: (target: OfflineSyncFileTarget) => Promise<Buffer>;
  readFileDigest?: (target: OfflineSyncFileTarget) => Promise<OfflineSyncFileDigest>;
  signal?: AbortSignal;
}): Promise<OfflineSyncSnapshot> {
  throwIfOfflineSyncAborted(options.signal);
  const includeTranscripts = options.includeTranscripts !== false;
  const files: OfflineSyncFileRecord[] = [];
  for await (const file of iterateOfflineSyncSnapshotFileRecords(options)) files.push(file);
  throwIfOfflineSyncAborted(options.signal);

  return {
    format: OFFLINE_SYNC_SNAPSHOT_FORMAT,
    schemaVersion: 1,
    createdAt: (options.now ?? new Date()).toISOString(),
    sourceId: normalizeSourceId(options.sourceId, "sourceId"),
    includeTranscripts,
    files: files.sort(compareByPath),
  };
}

export async function buildOfflineSyncSnapshotFromBase(options: {
  root: string;
  sourceId: string;
  baseFiles?: readonly OfflineSyncFileState[];
  baseCapturedAt?: Date;
  includeContent?: boolean;
  includeTranscripts?: boolean;
  now?: Date;
  readFile?: (target: OfflineSyncFileTarget) => Promise<Buffer>;
  readFileDigest?: (target: OfflineSyncFileTarget) => Promise<OfflineSyncFileDigest>;
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
  const files: OfflineSyncFileRecord[] = [];

  async function walk(dirAbs: string): Promise<void> {
    throwIfOfflineSyncAborted(options.signal);
    let entries = await readdir(dirAbs, { withFileTypes: true });
    entries = entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      throwIfOfflineSyncAborted(options.signal);
      const abs = path.join(dirAbs, entry.name);
      const relPosix = path.relative(root.abs, abs).split(path.sep).join("/");
      if (shouldExcludeRelPath(relPosix, includeTranscripts)) continue;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await walk(abs);
        continue;
      }
      if (!entry.isFile()) continue;
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

  return {
    format: OFFLINE_SYNC_SNAPSHOT_FORMAT,
    schemaVersion: 1,
    createdAt: (options.now ?? new Date()).toISOString(),
    sourceId: normalizeSourceId(options.sourceId, "sourceId"),
    includeTranscripts,
    files: files.sort(compareByPath),
  };
}

export async function buildOfflineSyncSnapshotForPaths(options: {
  root: string;
  sourceId: string;
  paths: readonly string[];
  includeContent?: boolean;
  includeTranscripts?: boolean;
  now?: Date;
  readFile?: (target: OfflineSyncFileTarget) => Promise<Buffer>;
  readFileDigest?: (target: OfflineSyncFileTarget) => Promise<OfflineSyncFileDigest>;
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
    if (shouldExcludeRelPath(relPath, includeTranscripts)) {
      throw new Error(`offline sync snapshot path is excluded: ${relPath}`);
    }
    const filePath = await resolveSafeArchiveTarget(root, relPath);
    const st = await lstat(filePath).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    if (!st || st.isSymbolicLink() || !st.isFile()) continue;
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

  return {
    format: OFFLINE_SYNC_SNAPSHOT_FORMAT,
    schemaVersion: 1,
    createdAt: (options.now ?? new Date()).toISOString(),
    sourceId: normalizeSourceId(options.sourceId, "sourceId"),
    includeTranscripts,
    files: files.sort(compareByPath),
  };
}

export async function readOfflineSyncFileContentChunk(options: {
  root: string;
  path: string;
  offset?: number;
  length?: number;
  includeTranscripts?: boolean;
  readFile?: (target: OfflineSyncFileTarget) => Promise<Buffer>;
}): Promise<OfflineSyncFileContentChunk> {
  const rootAbs = path.resolve(options.root);
  const root = await prepareSafeArchiveRoot(rootAbs, "readOfflineSyncFileContentChunk", "root");
  const includeTranscripts = options.includeTranscripts !== false;
  const relPath = normalizeRelativePath(options.path, "path");
  if (shouldExcludeRelPath(relPath, includeTranscripts)) {
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
  const encrypted = await fileIsSecureStoreEncrypted(filePath);
  if (!encrypted) {
    if (offset > st.size) {
      throw new Error(`offset must be <= file size for ${relPath}`);
    }
    const chunk = await readPlainFileContentChunk({
      filePath,
      offset,
      length: requestedLength,
      bytes: st.size,
    });
    return {
      path: relPath,
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
  baseCapturedAt?: Date;
  excludePaths?: readonly string[];
  includeTranscripts?: boolean;
  now?: Date;
  readFile?: (target: OfflineSyncFileTarget) => Promise<Buffer>;
  readFileDigest?: (target: OfflineSyncFileTarget) => Promise<OfflineSyncFileDigest>;
}): Promise<OfflineSyncChangeset> {
  const includeTranscripts = options.includeTranscripts !== false;
  const current = await buildOfflineSyncSnapshotFromBase({
    root: options.root,
    sourceId: options.sourceId,
    baseFiles: options.baseFiles,
    baseCapturedAt: options.baseCapturedAt,
    includeContent: false,
    includeTranscripts,
    now: options.now,
    readFile: options.readFile,
    readFileDigest: options.readFileDigest,
  });
  return buildOfflineSyncChangesetFromSnapshot({
    root: options.root,
    sourceId: options.sourceId,
    baseFiles: options.baseFiles,
    currentFiles: current.files,
    excludePaths: options.excludePaths,
    includeTranscripts,
    now: options.now,
    readFile: options.readFile,
  });
}

export async function buildOfflineSyncChangesetFromSnapshot(options: {
  root: string;
  sourceId: string;
  currentFiles: readonly OfflineSyncFileState[];
  baseFiles?: readonly OfflineSyncFileState[];
  excludePaths?: readonly string[];
  includeTranscripts?: boolean;
  now?: Date;
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
  const changes: OfflineSyncChange[] = [];

  for (const relPath of unionPaths(base, currentMap)) {
    if (excludedPaths.has(relPath)) continue;
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
      changes.push({
        type: "delete",
        path: relPath,
        baseSha256: baseEntry.sha256,
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
    readFile: options.readFile,
    readFileDigest: options.readFileDigest,
  });
  return summarizeOfflineSyncPendingFiles({
    baseFiles: options.baseFiles,
    currentFiles: current.files,
    includeTranscripts,
  });
}

export function summarizeOfflineSyncPendingFiles(options: {
  baseFiles?: readonly OfflineSyncFileState[];
  currentFiles: readonly OfflineSyncFileState[];
  includeTranscripts?: boolean;
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
  writeConflictCopies?: boolean;
  readFile?: (target: OfflineSyncFileTarget) => Promise<Buffer>;
  readFileDigest?: (target: OfflineSyncFileTarget) => Promise<OfflineSyncFileDigest>;
  writeFile?: (target: OfflineSyncFileWriteTarget) => Promise<void>;
  deleteFile?: (target: OfflineSyncFileTarget) => Promise<void>;
}): Promise<OfflineSyncApplySnapshotResult> {
  const snapshot = normalizeOfflineSyncSnapshot(options.snapshot);
  const baseMap = byPath(filterBaseFilesForMode(
    normalizeFileStates(options.baseFiles),
    snapshot.includeTranscripts,
  ));
  const incomingMap = byPath(snapshot.files);
  const incomingBuffers = verifyRecordContents(snapshot.files, "offline sync snapshot", {
    requireContent: false,
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
      })).files;
  const currentMap = byPath(currentFiles);
  const deferredPaths = new Set(options.deferredPaths ?? []);
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

    if (incoming) {
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
      if (shouldPreferIncomingOfflineRuntimeFile(relPath) && currentEntry && base && incoming.sha256 === base.sha256) {
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

    if (!currentEntry) {
      nextBase.delete(relPath);
      skipped += 1;
      continue;
    }
    if (shouldPreferIncomingOfflineRuntimeFile(relPath) && base) {
      await deleteSafeFile(root, relPath, options.deleteFile);
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
      await deleteSafeFile(root, relPath, options.deleteFile);
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
    upserted,
    deleted,
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
  deleteFile?: (target: OfflineSyncFileTarget) => Promise<void>;
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
  const incomingBuffers = verifyRecordContents(records, "offline sync changeset");
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
      })).files;
  const currentMap = byPath(currentFiles);
  const conflicts: OfflineSyncConflict[] = [];
  let appliedUpserts = 0;
  let appliedDeletes = 0;
  let skipped = 0;

  for (const change of changeset.changes) {
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
      skipped += 1;
      continue;
    }
    if (currentEntry.sha256 === change.baseSha256) {
      await deleteSafeFile(root, change.path, options.deleteFile);
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
        })).files,
    ...(options.returnCurrentFiles === false ? { currentFilesComplete: false } : {}),
  };
}

function verifyRecordContents(
  records: readonly OfflineSyncFileRecord[],
  context: string,
  options: { requireContent?: boolean } = {},
): Map<string, Buffer> {
  const buffers = new Map<string, Buffer>();
  for (const record of records) {
    if (typeof record.contentBase64 !== "string") {
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

async function setSafeFileMtime(
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
  const mtime = new Date(assertOfflineSyncMtimeMs(mtimeMs, "mtimeMs"));
  await utimes(target, mtime, mtime);
  return true;
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
    const currentSnapshot = await buildOfflineSyncSnapshotForPaths({
      root: root.abs,
      sourceId: "local",
      paths: [relPath],
      includeContent: false,
      includeTranscripts,
      readFile: options.readFile,
      readFileDigest: options.readFileDigest,
    });
    const currentFile = currentSnapshot.files[0];
    if (currentFile?.sha256 === sha256) {
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

  const currentSnapshot = await buildOfflineSyncSnapshotForPaths({
    root: root.abs,
    sourceId: "local",
    paths: [relPath],
    includeContent: false,
    includeTranscripts,
    readFile: options.readFile,
    readFileDigest: options.readFileDigest,
  });
  const currentFile = currentSnapshot.files[0];
  const uploadedState: OfflineSyncFileState = {
    path: relPath,
    sha256,
    bytes,
    mtimeMs,
  };

  try {
    if (currentFile?.sha256 === sha256) {
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

function offlineUploadRelPath(options: {
  sourceId: string;
  relPath: string;
  sha256: string;
  bytes: number;
}): string {
  const key = hashText([
    options.sourceId,
    options.relPath,
    options.sha256,
    String(options.bytes),
  ].join("\0"));
  return `${SYNC_INTERNAL_DIR}/uploads/${key}.part`;
}

async function offlineUploadPath(root: SafeArchiveRoot, options: {
  sourceId: string;
  relPath: string;
  sha256: string;
  bytes: number;
}): Promise<OfflineUploadStaging> {
  const relPath = offlineUploadRelPath(options);
  return {
    kind: "single",
    relPath,
    filePath: await resolveSafeArchiveTarget(root, relPath),
  };
}

async function offlineUploadChunkPath(root: SafeArchiveRoot, options: {
  sourceId: string;
  relPath: string;
  sha256: string;
  bytes: number;
  offset: number;
}): Promise<OfflineUploadStaging> {
  const uploadRelPath = offlineUploadRelPath(options);
  const relPath = `${uploadRelPath}/${String(options.offset).padStart(20, "0")}.part`;
  return {
    kind: "chunks",
    relPath,
    filePath: await resolveSafeArchiveTarget(root, relPath),
  };
}

async function writeOfflineUploadChunk(options: {
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

async function pruneOfflineUploadStaging(root: SafeArchiveRoot): Promise<void> {
  const uploadsRelPath = `${SYNC_INTERNAL_DIR}/uploads`;
  const uploadsPath = await resolveSafeArchiveTarget(root, uploadsRelPath);
  const entries = await readdir(uploadsPath, { withFileTypes: true }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  });
  const now = Date.now();
  await Promise.all(entries.map(async (entry) => {
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
  }));
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
  const chunkNames = entries
    .filter((entry) => /^\d{20}\.part$/.test(entry))
    .sort();
  if (chunkNames.length === 0) {
    throw new Error(`offline sync upload is missing chunks for ${options.upload.relPath}`);
  }
  let expectedOffset = 0;
  for (const chunkName of chunkNames) {
    const offset = Number(chunkName.slice(0, 20));
    if (!Number.isSafeInteger(offset) || offset !== expectedOffset) {
      throw new Error(
        `offline sync upload offset mismatch for ${options.upload.relPath}: expected ${expectedOffset}, got ${offset}`,
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

async function digestOfflineUploadStagingContent(options: {
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

async function writeSafeFileFromUpload(
  root: SafeArchiveRoot,
  relPath: string,
  upload: OfflineUploadStaging,
  readFile?: (target: OfflineSyncFileTarget) => Promise<Buffer>,
  writeFileChunks?: (target: OfflineSyncFileWriteChunksTarget) => Promise<void>,
  mtimeMs?: number,
): Promise<void> {
  const target = await resolveSafeArchiveTarget(root, relPath);
  const chunks = readOfflineUploadStagingChunks({ root, upload, readFile });
  if (writeFileChunks) {
    await writeFileChunks({ root: root.abs, path: relPath, filePath: target, chunks });
    await setSafeFileMtime(root, relPath, mtimeMs);
    return;
  }

  await mkdir(path.dirname(target), { recursive: true });
  const tmp = path.join(
    path.dirname(target),
    `.remnic-sync.${process.pid}.${randomUUID()}.tmp`,
  );
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

async function cleanupOfflineUpload(upload: OfflineUploadStaging): Promise<void> {
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

async function deleteSafeFile(
  root: SafeArchiveRoot,
  relPath: string,
  deleteFile?: (target: OfflineSyncFileTarget) => Promise<void>,
): Promise<void> {
  const target = await resolveSafeArchiveTarget(root, relPath);
  if (deleteFile) {
    await deleteFile({ root: root.abs, path: relPath, filePath: target });
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
