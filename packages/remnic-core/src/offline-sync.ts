import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  stat,
  unlink,
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

export interface OfflineSyncFileContentChunk extends Omit<OfflineSyncFileState, "sha256"> {
  sha256?: string;
  offset: number;
  chunkBytes: number;
  content: Buffer;
}

interface OfflineSyncFileRecordOptions {
  root: SafeArchiveRoot;
  relPath: string;
  filePath: string;
  includeContent: boolean;
  readFile?: (target: OfflineSyncFileTarget) => Promise<Buffer>;
}

const SYNC_INTERNAL_DIR = ".offline-sync";
const EXCLUDED_FILE_NAMES = new Set([
  ".sync-state.json",
]);

const EXCLUDED_REL_PATHS = new Set([
  "state/fact-hashes.ready",
  "state/fact-hashes.txt",
  "state/lcm.sqlite",
  "state/lcm.sqlite-shm",
  "state/lcm.sqlite-wal",
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
    mtimeMs: assertNonNegativeFinite(obj.mtimeMs, `${fieldPrefix}.mtimeMs`),
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
  });
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
  if (EXCLUDED_REL_PATHS.has(relPosix)) return true;
  if (!includeTranscripts && parts[0] === "transcripts") return true;
  const basename = parts[parts.length - 1] ?? "";
  if (EXCLUDED_FILE_NAMES.has(basename)) return true;
  return EXCLUDED_FILE_PREFIXES.some((prefix) => basename.startsWith(prefix));
}

function filterBaseFilesForMode(
  files: readonly OfflineSyncFileState[],
  includeTranscripts: boolean,
): OfflineSyncFileState[] {
  return files.filter((file) => !shouldExcludeRelPath(file.path, includeTranscripts));
}

async function readOfflineSyncFileRecord(
  options: OfflineSyncFileRecordOptions,
): Promise<OfflineSyncFileRecord> {
  const relPath = validateArchiveRelativePath(options.relPath, "offlineSyncFile.path");
  const bytes = options.readFile
    ? await options.readFile({ root: options.root.abs, path: relPath, filePath: options.filePath })
    : await readFile(options.filePath);
  const digest = sha256Buffer(bytes);
  const st = await stat(options.filePath);
  return {
    path: relPath,
    sha256: digest.sha256,
    bytes: digest.bytes,
    mtimeMs: st.mtimeMs,
    ...(options.includeContent ? { contentBase64: bytes.toString("base64") } : {}),
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

export async function buildOfflineSyncSnapshot(options: {
  root: string;
  sourceId: string;
  includeContent?: boolean;
  includeTranscripts?: boolean;
  now?: Date;
  readFile?: (target: OfflineSyncFileTarget) => Promise<Buffer>;
}): Promise<OfflineSyncSnapshot> {
  const rootAbs = path.resolve(options.root);
  const root = await prepareSafeArchiveRoot(rootAbs, "buildOfflineSyncSnapshot", "root");
  const includeTranscripts = options.includeTranscripts !== false;
  const files: OfflineSyncFileRecord[] = [];

  async function walk(dirAbs: string): Promise<void> {
    let entries = await readdir(dirAbs, { withFileTypes: true });
    entries = entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const abs = path.join(dirAbs, entry.name);
      const relPosix = path.relative(root.abs, abs).split(path.sep).join("/");
      if (shouldExcludeRelPath(relPosix, includeTranscripts)) continue;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await walk(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      files.push(await readOfflineSyncFileRecord({
        root,
        relPath: relPosix,
        filePath: abs,
        includeContent: options.includeContent === true,
        readFile: options.readFile,
      }));
    }
  }

  await walk(root.abs);

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
}): Promise<OfflineSyncSnapshot> {
  const rootAbs = path.resolve(options.root);
  const root = await prepareSafeArchiveRoot(rootAbs, "buildOfflineSyncSnapshotForPaths", "root");
  const includeTranscripts = options.includeTranscripts !== false;
  const files: OfflineSyncFileRecord[] = [];
  const seen = new Set<string>();

  for (const rawPath of options.paths) {
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
    }));
  }

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
  includeTranscripts?: boolean;
  now?: Date;
  readFile?: (target: OfflineSyncFileTarget) => Promise<Buffer>;
}): Promise<OfflineSyncChangeset> {
  const includeTranscripts = options.includeTranscripts !== false;
  const base = byPath(filterBaseFilesForMode(
    normalizeFileStates(options.baseFiles),
    includeTranscripts,
  ));
  const current = await buildOfflineSyncSnapshot({
    root: options.root,
    sourceId: options.sourceId,
    includeContent: false,
    includeTranscripts,
    now: options.now,
    readFile: options.readFile,
  });
  const currentMap = byPath(current.files);
  const changes: OfflineSyncChange[] = [];

  for (const relPath of unionPaths(base, currentMap)) {
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
    includeTranscripts: current.includeTranscripts,
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

export async function applyOfflineSyncSnapshot(options: {
  root: string;
  snapshot: unknown;
  baseFiles?: readonly OfflineSyncFileState[];
  writeConflictCopies?: boolean;
  readFile?: (target: OfflineSyncFileTarget) => Promise<Buffer>;
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
  const current = await buildOfflineSyncSnapshot({
    root: root.abs,
    sourceId: "local",
    includeContent: false,
    includeTranscripts: snapshot.includeTranscripts,
    readFile: options.readFile,
  });
  const currentMap = byPath(current.files);
  const nextBase = new Map(baseMap);
  const conflicts: OfflineSyncConflict[] = [];
  let upserted = 0;
  let deleted = 0;
  let skipped = 0;
  let pendingLocal = 0;

  for (const relPath of unionPaths(baseMap, incomingMap, currentMap)) {
    const base = baseMap.get(relPath);
    const incoming = incomingMap.get(relPath);
    const currentEntry = currentMap.get(relPath);

    if (incoming) {
      if (currentEntry?.sha256 === incoming.sha256) {
        nextBase.set(relPath, toFileState(incoming));
        skipped += 1;
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
          incomingBuffer: options.writeConflictCopies === false
            ? incomingBuffers.get(relPath)
            : requiredBuffer(incomingBuffers, relPath),
          writeConflictCopies: options.writeConflictCopies !== false,
          sourceId: snapshot.sourceId,
          writeFile: options.writeFile,
        }));
        nextBase.set(relPath, base);
        continue;
      }
      if (!currentEntry && !base) {
        await writeSafeFile(root, relPath, requiredBuffer(incomingBuffers, relPath), options.writeFile);
        nextBase.set(relPath, toFileState(incoming));
        upserted += 1;
        continue;
      }
      if (base && currentEntry && currentEntry.sha256 === base.sha256) {
        await writeSafeFile(root, relPath, requiredBuffer(incomingBuffers, relPath), options.writeFile);
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
        incomingBuffer: options.writeConflictCopies === false
          ? incomingBuffers.get(relPath)
          : requiredBuffer(incomingBuffers, relPath),
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
  writeConflictCopies?: boolean;
  readFile?: (target: OfflineSyncFileTarget) => Promise<Buffer>;
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
  const current = await buildOfflineSyncSnapshot({
    root: root.abs,
    sourceId: "local",
    includeContent: false,
    includeTranscripts: changeset.includeTranscripts,
    readFile: options.readFile,
  });
  const currentMap = byPath(current.files);
  const conflicts: OfflineSyncConflict[] = [];
  let appliedUpserts = 0;
  let appliedDeletes = 0;
  let skipped = 0;

  for (const change of changeset.changes) {
    const currentEntry = currentMap.get(change.path);
    if (change.type === "upsert") {
      if (currentEntry?.sha256 === change.file.sha256) {
        skipped += 1;
        continue;
      }
      if (!change.baseSha256) {
        if (!currentEntry) {
          await writeSafeFile(root, change.path, requiredBuffer(incomingBuffers, change.path), options.writeFile);
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
        await writeSafeFile(root, change.path, requiredBuffer(incomingBuffers, change.path), options.writeFile);
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
    currentFiles: [...currentMap.values()].sort(compareByPath),
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
): Promise<void> {
  const target = await resolveSafeArchiveTarget(root, relPath);
  if (writeFileHook) {
    await writeFileHook({ root: root.abs, path: relPath, filePath: target, content });
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
  } catch (error) {
    await unlink(tmp).catch(() => {});
    throw error;
  }
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
