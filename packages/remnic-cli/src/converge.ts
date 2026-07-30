import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  CONVERGE_CONFLICT_POLICIES,
  DEFAULT_CONVERGE_CONFLICT_POLICY,
  OFFLINE_SYNC_FILE_CONTENT_MAX_CHUNK_BYTES,
  OFFLINE_SYNC_FILE_CONTENT_TRANSFER_CHUNK_BYTES,
  type PluginConfig,
  type ResolveSecretRefFn,
  applyOfflineSyncFileContentChunk,
  buildOfflineSyncSnapshotFromBase,
  parseConfig,
} from "@remnic/core";
  parseConfig,
  type ResolveSecretRefFn,
  buildOfflineSyncSnapshotFromBase,
  OFFLINE_SYNC_FILE_CONTENT_MAX_CHUNK_BYTES,
  OFFLINE_SYNC_CHANGESET_FORMAT,
  OFFLINE_SYNC_FILE_CONTENT_TRANSFER_CHUNK_BYTES,
  OFFLINE_SYNC_MAX_MTIME_MS,
  applyOfflineSyncFileContentChunk,
  isInternalRemnicStatePath,
  OFFLINE_SYNC_FILE_CONTENT_TRANSFER_CHUNK_BYTES,
} from "@remnic/core";
import { parseFrontmatter } from "@remnic/core/storage.js";
import type { ConvergeConflictPolicy } from "@remnic/core/types.js";
import { resolveCorpusNamespaceRoots } from "@remnic/core/corpus-watermark.js";
import { listNamespaces } from "@remnic/core/namespaces/migrate.js";
import {
  type ConvergeCursorState,
  defaultConvergeCursorPath,
  deriveConvergeCursorBase,
  readConvergeCursor,
  writeConvergeCursor,
  type ConvergeCursorState,
  normalizeConvergePeerUrl,
} from "@remnic/core/reconcile/cursor.js";
import {
  type ReconcileManifest,
  buildReconcileManifest,
  collapseActiveFactDuplicates,
} from "@remnic/core/reconcile/manifest.js";
import {
  type ReconcileFileState,
  type ReconcileNamespaceInput,
  type ReconcilePlan,
  type ReconcileSemanticAgreement,
  planReconciliation,
} from "@remnic/core/reconcile/plan.js";
import { createOfflineStorageIo } from "./offline-storage-io.js";
import { validateArchiveRelativePath } from "@remnic/core/transfer/fs-utils.js";
import { resolveAgentAccessAuthToken } from "@remnic/core/resolve-auth-token.js";
import type { ConvergeConflictPolicy } from "@remnic/core/types.js";
import {
  type ReceiverFinalizationNegotiation,
  type ReceiverFinalizationResult,
  negotiateReceiverFinalization,
  postPeerConvergenceComplete,
  postPeerFileContent,
  postPeerFileDeletion,
  receiverFinalizationResult,
} from "./converge-peer.js";
import {
  plansReceiverMutation,
  readPendingRefreshNamespaces,
  refreshLocalProjections,
  setRefreshPending,
} from "./converge-refresh-state.js";
import { createOfflineStorageIo } from "./offline-storage-io.js";
import {
  DEFAULT_PEER_REQUEST_TIMEOUT_MS,
  fetchPeerFileContent,
  fetchPeerManifestStream,
  fetchPeerSyncCapabilities,
  fetchPeerSnapshot,
  postPeerConvergenceComplete,
  postPeerFileContent,
  postPeerFileDeletion,
  streamPeerFileContent,
  type PeerFileContent,
  type PeerFileChunk,
  type PeerFileSource,
} from "./converge-peer-transport.js";
export interface ConvergePlanOptions {
  config?: PluginConfig;
  peerUrl?: string;
  peerToken?: string;
  cursorDir?: string;
  conflictPolicy?: ConvergeConflictPolicy;
  fetchImpl?: typeof fetch;
  peerRequestTimeoutMs?: number;
  resolveSecretRef?: ResolveSecretRefFn;
  baseFilesByNamespace?: Map<string, ReconcileFileState[]>;
  semanticAgreementsByNamespace?: Map<string, ReconcileSemanticAgreement[]>;
  localFilesByNamespace?: Map<string, ReconcileFileState[]>;
  localTombstonesByNamespace?: Map<string, Iterable<string>>;
  localDeletionMtimeMsByNamespace?: Map<string, ReadonlyMap<string, number>>;
  peerFilesByNamespace?: Map<string, ReconcileFileState[]>;
  peerTombstonesByNamespace?: Map<string, Iterable<string>>;
  peerDeletionMtimeMsByNamespace?: Map<string, ReadonlyMap<string, number>>;
}

export interface ConvergeApplyOptions extends ConvergePlanOptions {
  dryRun?: boolean;
  cursorDir?: string;
  localFileBuffers?: Map<string, Map<string, Buffer>>;
  peerFileBuffers?: Map<string, Map<string, Buffer>>;
  refreshLocalNamespaces?: (namespaces: readonly string[]) => Promise<void>;
}

export interface ConvergeApplyResult {
  converged: boolean;
  status: "converged" | "applied" | "stopped_unresolved_conflicts" | "receiver_finalization_unsupported" | "dry_run";
  plan: ReconcilePlan;
  transfers: {
    pulled: number;
    pushed: number;
    conflictsResolved: number;
    suppressed: number;
    failed: number;
  };
  cursorUpdated: boolean;
  receiverFinalization: ReceiverFinalizationResult;
}

async function readLocalTombstones(rootDir: string): Promise<Set<string>> {
  const shaSet = new Set<string>();
  const candidates = [path.join(rootDir, "state", "tombstones.jsonl"), path.join(rootDir, "tombstones.jsonl")];
  for (const tombPath of candidates) {
    try {
      const content = await fs.promises.readFile(tombPath, "utf-8");
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const record = JSON.parse(trimmed) as { contentHash?: unknown; fileSha256?: unknown };
          if (typeof record.contentHash === "string" && /^[0-9a-f]{64}$/i.test(record.contentHash)) {
            shaSet.add(record.contentHash.toLowerCase());
          }
          if (typeof record.fileSha256 === "string" && /^[0-9a-f]{64}$/i.test(record.fileSha256)) {
            shaSet.add(record.fileSha256.toLowerCase());
          }
        } catch {
          // ignore unparseable line
        }
      }
    } catch {
      // file does not exist
    }
  }
  return shaSet;
}

async function fetchPeerSnapshot(
  peerUrl: string,
  namespace: string,
  token?: string,
  fetchImpl: typeof fetch = globalThis.fetch
): Promise<{ files: ReconcileFileState[]; tombstones: Set<string> }> {
  let base = peerUrl;
  while (base.endsWith("/")) {
    base = base.slice(0, -1);
  }
  const routes = [
    `/remnic/v1/offline-sync/snapshot?namespace=${encodeURIComponent(namespace)}&content=false`,
    `/engram/v1/offline-sync/snapshot?namespace=${encodeURIComponent(namespace)}&content=false`,
  ];
  const headers: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};
  let lastFailure = "no snapshot route responded";
interface TombstoneEvidence {
  contentHashes: Set<string>;
  fileSha256: Set<string>;
}

async function fetchPeerSnapshot(
  peerUrl: string,
  namespace: string,
  token?: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<{
  files: ReconcileFileState[];
  tombstones: Set<string>;
  deletions: ReadonlyMap<string, number>;
}> {
  let base = peerUrl;
  while (base.endsWith("/")) {
    base = base.slice(0, -1);
  }
  const routes = [
    `/remnic/v1/offline-sync/snapshot?namespace=${encodeURIComponent(namespace)}&content=false`,
    `/engram/v1/offline-sync/snapshot?namespace=${encodeURIComponent(namespace)}&content=false`,
  ];
  const headers: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};
  let lastFailure = "no snapshot route responded";
const TOMBSTONE_PATHS = ["state/tombstones.jsonl", "tombstones.jsonl"] as const;

function parseTombstoneEvidence(content: string): TombstoneEvidence {
  const contentHashes = new Set<string>();
  const fileSha256 = new Set<string>();
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const record = JSON.parse(trimmed) as { contentHash?: unknown; fileSha256?: unknown };
      if (typeof record.contentHash === "string" && /^[0-9a-f]{64}$/i.test(record.contentHash)) {
        contentHashes.add(record.contentHash.toLowerCase());
      }
      if (typeof record.fileSha256 === "string" && /^[0-9a-f]{64}$/i.test(record.fileSha256)) {
        fileSha256.add(record.fileSha256.toLowerCase());
      }
    } catch {
      continue;
    }
  }
  return { contentHashes, fileSha256 };
}

function tombstonedFileDigests(
  evidence: TombstoneEvidence,
  manifest: ReconcileManifest | undefined,
): Set<string> {
  const result = new Set(evidence.fileSha256);
  for (const file of manifest?.files ?? []) {
    if (file.memory && evidence.contentHashes.has(file.memory.contentHash.toLowerCase())) {
      result.add(file.sha256.toLowerCase());
    }
  }
  return result;
}

async function readLocalTombstoneEvidence(rootDir: string): Promise<TombstoneEvidence> {
  const merged: TombstoneEvidence = { contentHashes: new Set(), fileSha256: new Set() };
  for (const relativePath of TOMBSTONE_PATHS) {
    let content: string;
    try {
      content = await fs.promises.readFile(path.join(rootDir, relativePath), "utf-8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (!response.ok) {
      lastFailure = `HTTP ${response.status}`;
      continue;
    }

    let data: unknown;
    try {
      data = await response.json();
    } catch {
      throw new Error(`invalid peer snapshot for namespace ${namespace}: response was not JSON`);
    }
    if (!data || typeof data !== "object" || !("files" in data) || !Array.isArray(data.files)) {
      throw new Error(`invalid peer snapshot for namespace ${namespace}: files must be an array`);
    }

    const files: ReconcileFileState[] = data.files.map((item, index) => {
      if (
        !item ||
        typeof item !== "object" ||
        !("path" in item) ||
        typeof item.path !== "string" ||
        !("sha256" in item) ||
        typeof item.sha256 !== "string"
        !item
        || typeof item !== "object"
        || !("path" in item)
        || typeof item.path !== "string"
        || !("sha256" in item)
        || typeof item.sha256 !== "string"
      ) {
        throw new Error(`invalid peer snapshot for namespace ${namespace}: malformed file at index ${index}`);
      }
      return {
        path: item.path,
        sha256: item.sha256,
        mtimeMs: "mtimeMs" in item && typeof item.mtimeMs === "number" ? item.mtimeMs : undefined,
        bytes: "bytes" in item && typeof item.bytes === "number" ? item.bytes : undefined,
      };
    });

    const rawTombstones = "tombstones" in data ? data.tombstones : undefined;
    if (rawTombstones !== undefined && !Array.isArray(rawTombstones)) {
      throw new Error(`invalid peer snapshot for namespace ${namespace}: tombstones must be an array`);
    }
    const tombstones = new Set<string>();
    for (const tombstone of rawTombstones ?? []) {
      if (typeof tombstone !== "string" || !/^[0-9a-f]{64}$/i.test(tombstone)) {
        throw new Error(`invalid peer snapshot for namespace ${namespace}: malformed tombstone`);
      }
      tombstones.add(tombstone.toLowerCase());
    }
    return { files, tombstones };

    const rawDeletions = "deletions" in data ? data.deletions : undefined;
    if (rawDeletions !== undefined && !Array.isArray(rawDeletions)) {
      throw new Error(`invalid peer snapshot for namespace ${namespace}: deletions must be an array`);
    }
    const deletions = new Map<string, number>();
    const deletionPathKeys = new Set<string>();
    for (const deletion of rawDeletions ?? []) {
      if (!deletion || typeof deletion !== "object" || Array.isArray(deletion)) {
        throw new Error(`invalid peer snapshot for namespace ${namespace}: malformed deletion revision`);
      }
      const record = deletion as Record<string, unknown>;
      if (
        typeof record.path !== "string"
        || typeof record.mtimeMs !== "number"
        || !Number.isFinite(record.mtimeMs)
        || record.mtimeMs < 0
        || record.mtimeMs > OFFLINE_SYNC_MAX_MTIME_MS
      ) {
        throw new Error(`invalid peer snapshot for namespace ${namespace}: malformed deletion revision`);
      }
      let deletionPath: string;
      try {
        deletionPath = validateArchiveRelativePath(record.path, "deletions[].path");
      } catch {
        throw new Error(`invalid peer snapshot for namespace ${namespace}: malformed deletion revision path`);
      }
      const pathKey = deletionPath.toLowerCase();
      if (deletionPathKeys.has(pathKey)) {
        throw new Error(`invalid peer snapshot for namespace ${namespace}: duplicate deletion revision path`);
      }
      deletionPathKeys.add(pathKey);
      deletions.set(deletionPath, record.mtimeMs);
    }
    return { files, tombstones, deletions };
    const parsed = parseTombstoneEvidence(content);
    for (const value of parsed.contentHashes) merged.contentHashes.add(value);
    for (const value of parsed.fileSha256) merged.fileSha256.add(value);
  }
  return merged;
}

async function discoverCursorNamespaces(memoryDir: string, peerUrl: string): Promise<string[]> {
  const cursorDir = path.join(path.resolve(memoryDir), ".remnic", "state", "converge-cursors");
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(cursorDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return value;
}

async function fetchPeerFileContent(
  peerUrl: string,
  namespace: string,
  filePath: string,
  token?: string,
  fetchImpl: typeof fetch = globalThis.fetch
): Promise<PeerFileContent | null> {
  const base = peerUrl.replace(/\/+$/, "");
  const routes = ["/remnic/v1/offline-sync/file-content", "/engram/v1/offline-sync/file-content"];
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
  for (const route of routes) {
    try {
      const chunks: Buffer[] = [];
      const hash = createHash("sha256");
      let offset = 0;
      let expectedBytes: number | undefined;
      let expectedSha256: string | undefined;
      let mtimeMs: number | undefined;
      do {
        const response = await fetchImpl(`${base}${route}`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            namespace,
            includeTranscripts: false,
            path: filePath,
            offset,
            length: OFFLINE_SYNC_FILE_CONTENT_MAX_CHUNK_BYTES,
          }),
        });
        if (!response.ok) throw new Error(`offline file content request failed: ${response.status}`);
        const content = Buffer.from(await response.arrayBuffer());
        const chunkOffset = requiredResponseNumber(response, "x-remnic-chunk-offset");
        const chunkBytes = requiredResponseNumber(response, "x-remnic-chunk-bytes");
        const totalBytes = requiredResponseNumber(response, "x-remnic-file-bytes");
        const responseMtimeMs = requiredResponseNumber(response, "x-remnic-file-mtime-ms");
        const sha256 = response.headers.get("x-remnic-file-sha256");
        const encodedPath = response.headers.get("x-remnic-file-path");
        if (
          !sha256 ||
          chunkOffset !== offset ||
          chunkBytes !== content.length ||
          (encodedPath !== null && decodeURIComponent(encodedPath) !== filePath) ||
          (expectedBytes !== undefined && expectedBytes !== totalBytes) ||
          (expectedSha256 !== undefined && expectedSha256 !== sha256)
        ) {
          throw new Error(`offline file content response changed during transfer: ${filePath}`);
        }
        if (content.length === 0 && offset < totalBytes) {
          throw new Error(`offline file content chunk was empty before EOF: ${filePath}`);
        }
        expectedBytes = totalBytes;
        expectedSha256 = sha256;
        mtimeMs = responseMtimeMs;
        chunks.push(content);
        hash.update(content);
        offset += content.length;
      } while (expectedBytes === undefined || offset < expectedBytes);
      if (
        expectedBytes === undefined ||
        expectedSha256 === undefined ||
        mtimeMs === undefined ||
        offset !== expectedBytes ||
        hash.digest("hex") !== expectedSha256
      ) {
        throw new Error(`offline file content checksum mismatch: ${filePath}`);
      }
      return {
        content: Buffer.concat(chunks, expectedBytes),
        sha256: expectedSha256,
        bytes: expectedBytes,
        mtimeMs,
      };
    } catch {
      // try next route
    }
  const namespaces = new Set<string>();
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const cursor = await readConvergeCursor(path.join(cursorDir, entry.name));
    if (!cursor) throw new Error(`invalid converge cursor: ${entry.name}`);
    if (path.basename(defaultConvergeCursorPath(memoryDir, peerUrl, cursor.namespace)) !== entry.name) continue;
    namespaces.add(cursor.namespace);
  }
  return [...namespaces].sort();
}

function withoutTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end -= 1;
  return value.slice(0, end);
}

async function postPeerFileContent(
  peerUrl: string,
  namespace: string,
  filePath: string,
  content: Buffer,
  metadata: { sha256: string; mtimeMs: number; baseSha256?: string },
  token?: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<"applied" | "skipped" | false> {
  const base = withoutTrailingSlashes(peerUrl);
  const routes = [
    `/remnic/v1/offline-sync/apply-file-content?namespace=${encodeURIComponent(namespace)}`,
    `/engram/v1/offline-sync/apply-file-content?namespace=${encodeURIComponent(namespace)}`,
  ];
  let previousAttemptFailed = false;
  for (const route of routes) {
    try {
      let offset = 0;
      do {
        const chunk = content.subarray(
          offset,
          Math.min(content.length, offset + OFFLINE_SYNC_FILE_CONTENT_TRANSFER_CHUNK_BYTES),
        );
        const headers: Record<string, string> = {
          "content-type": "application/octet-stream",
          "x-remnic-include-transcripts": "false",
          "x-remnic-source-id": encodeURIComponent("remnic-converge"),
          "x-remnic-file-path": encodeURIComponent(filePath),
          "x-remnic-file-sha256": metadata.sha256,
          "x-remnic-file-bytes": String(content.length),
          "x-remnic-file-mtime-ms": String(metadata.mtimeMs),
          "x-remnic-chunk-offset": String(offset),
          ...(metadata.baseSha256 ? { "x-remnic-base-sha256": metadata.baseSha256 } : {}),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        };
        const response = await fetchImpl(`${base}${route}`, {
          method: "POST",
          headers,
          body: new Uint8Array(chunk),
        });
        if (!response.ok) throw new Error(`offline apply-file-content request failed: ${response.status}`);
        const result: unknown = await response.json().catch(() => null);
        if (
          !result
          || typeof result !== "object"
          || !("done" in result)
          || typeof result.done !== "boolean"
          || !("applied" in result)
          || typeof result.applied !== "boolean"
          || !("skipped" in result)
          || typeof result.skipped !== "boolean"
          || ("conflict" in result && result.conflict)
        ) {
          return false;
        }
        if (result.done) {
          if (result.skipped) return previousAttemptFailed ? "applied" : "skipped";
          if (result.applied && offset + chunk.length === content.length) return "applied";
          return false;
        }
        if (result.applied || result.skipped || chunk.length === 0) {
          return false;
        }
        offset += chunk.length;
      } while (offset < content.length);
      return false;
    } catch {
      previousAttemptFailed = true;
    }
  }
  return false;
}

async function postPeerConvergenceComplete(
  peerUrl: string,
  namespaces: readonly string[],
  token?: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<boolean> {
  const base = withoutTrailingSlashes(peerUrl);
  const query = namespaces
    .map((namespace) => `namespace=${encodeURIComponent(namespace)}`)
    .join("&");
  const routes = [
    "/remnic/v1/offline-sync/convergence-complete",
    "/engram/v1/offline-sync/convergence-complete",
  ];
  for (const route of routes) {
    const response = await fetchImpl(`${base}${route}?${query}`, {
      method: "POST",
      headers: {
        "x-remnic-source-id": encodeURIComponent("remnic-converge"),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    }).catch(() => null);
    if (!response?.ok) continue;
    const result: unknown = await response.json().catch(() => null);
    if (
      result
      && typeof result === "object"
      && "namespaces" in result
      && Array.isArray(result.namespaces)
      && result.namespaces.length === namespaces.length
      && result.namespaces.every((namespace, index) => namespace === namespaces[index])
      && "refreshed" in result
      && result.refreshed === true
    ) {
      return true;
    }
  }
  return false;
}

async function postPeerFileDeletion(
  peerUrl: string,
  namespace: string,
  filePath: string,
  baseSha256: string,
  deletionMtimeMs: number,
  token?: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<"applied" | "skipped" | false> {
  const base = withoutTrailingSlashes(peerUrl);
  const routes = ["/remnic/v1/offline-sync/apply", "/engram/v1/offline-sync/apply"];
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
  let previousAttemptFailed = false;
  for (const route of routes) {
    try {
      const response = await fetchImpl(`${base}${route}`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          namespace,
          changeset: {
            format: OFFLINE_SYNC_CHANGESET_FORMAT,
            schemaVersion: 1,
            createdAt: new Date().toISOString(),
            sourceId: "remnic-converge",
            includeTranscripts: false,
            changes: [{ type: "delete", path: filePath, baseSha256, mtimeMs: deletionMtimeMs }],
          },
        }),
      });
      if (!response.ok) throw new Error(`offline apply request failed: ${response.status}`);
      const result: unknown = await response.json().catch(() => null);
      if (
        !result
        || typeof result !== "object"
        || !("appliedDeletes" in result)
        || typeof result.appliedDeletes !== "number"
        || !("skipped" in result)
        || typeof result.skipped !== "number"
        || !("conflicts" in result)
        || !Array.isArray(result.conflicts)
        || result.conflicts.length > 0
      ) {
        return false;
      }
      if (result.appliedDeletes === 1) return "applied";
      if (result.skipped === 1) return previousAttemptFailed ? "applied" : "skipped";
      return false;
    } catch {
      previousAttemptFailed = true;
    }
  }
  return false;
}

export async function computeConvergePlan(options: ConvergePlanOptions = {}): Promise<ReconcilePlan> {
  const baseMap = new Map<string, ReconcileFileState[]>();
  const semanticAgreementMap = new Map<string, ReconcileSemanticAgreement[]>();
  const namespacesToPlan = new Set<string>();
  const localMap = new Map<string, ReconcileFileState[]>();
  const localTombstones = new Map<string, Set<string>>();
  const peerMap = new Map<string, ReconcileFileState[]>();
  const peerTombstones = new Map<string, Set<string>>();
  const localDeletionMtimeMs = new Map<string, ReadonlyMap<string, number>>();
  const peerDeletionMtimeMs = new Map<string, ReadonlyMap<string, number>>();
  const localManifests = new Map<string, ReconcileManifest>();
  const peerManifests = new Map<string, ReconcileManifest>();

  if (options.baseFilesByNamespace) {
    for (const [ns, files] of options.baseFilesByNamespace) {
      namespacesToPlan.add(ns);
      baseMap.set(ns, files.filter((file) => !isInternalRemnicStatePath(file.path)));
    }
  }
  if (options.semanticAgreementsByNamespace) {
    for (const [ns, agreements] of options.semanticAgreementsByNamespace) {
      namespacesToPlan.add(ns);
      semanticAgreementMap.set(ns, agreements);
    }
  }
  if (options.localFilesByNamespace) {
    for (const [ns, files] of options.localFilesByNamespace) {
      namespacesToPlan.add(ns);
      localMap.set(ns, files.filter((file) => !isInternalRemnicStatePath(file.path)));
    }
  }
  if (options.localTombstonesByNamespace) {
    for (const [ns, tombstones] of options.localTombstonesByNamespace) {
      localTombstones.set(ns, new Set(tombstones));
    }
  }
  if (options.localDeletionMtimeMsByNamespace) {
    for (const [ns, mtimes] of options.localDeletionMtimeMsByNamespace) {
      namespacesToPlan.add(ns);
      localDeletionMtimeMs.set(ns, mtimes);
    }
  }
  if (options.peerFilesByNamespace) {
    for (const [ns, files] of options.peerFilesByNamespace) {
      namespacesToPlan.add(ns);
      peerMap.set(ns, files.filter((file) => !isInternalRemnicStatePath(file.path)));
    }
  }
  if (options.peerTombstonesByNamespace) {
    for (const [ns, tombstones] of options.peerTombstonesByNamespace) {
      peerTombstones.set(ns, new Set(tombstones));
    }
  }
  if (options.peerDeletionMtimeMsByNamespace) {
    for (const [ns, mtimes] of options.peerDeletionMtimeMsByNamespace) {
      namespacesToPlan.add(ns);
      peerDeletionMtimeMs.set(ns, mtimes);
    }
  }
  let config = options.config;
  if (!config) {
    try {
      config = parseConfig({});
    } catch {
      // ignore missing/invalid config in fallback mode
    }
  }
  const memoryDir = options.cursorDir ?? config?.memoryDir;

  if (!options.localFilesByNamespace && config) {
    const roots = await resolveCorpusNamespaceRoots({ config });
    const discovered = await listNamespaces({ config });
    for (const entry of discovered) {
      namespacesToPlan.add(entry.namespace);
    }
    for (const rootInfo of roots) {
      const ns = rootInfo.namespace;
      namespacesToPlan.add(ns);
      const io = await createOfflineStorageIo(rootInfo.rootDir);
      const storedDeletions = await io.readDeletionRevisions();
      try {
        const snapshot = await buildOfflineSyncSnapshotFromBase({
          root: rootInfo.rootDir,
          sourceId: "local",
          includeContent: false,
          deletions: [...storedDeletions].map(([path, mtimeMs]) => ({ path, mtimeMs })),
        });
        const files: ReconcileFileState[] = snapshot.files
          .filter((record) => !isInternalRemnicStatePath(record.path))
          .map((record) => ({
            path: record.path,
            sha256: record.sha256,
            mtimeMs: record.mtimeMs,
            bytes: record.bytes,
          }));
        localMap.set(ns, files);
        try {
          const io = await createOfflineStorageIo(rootInfo.rootDir);
        if (!localDeletionMtimeMs.has(ns)) {
          localDeletionMtimeMs.set(
            ns,
            new Map((snapshot.deletions ?? []).map((revision) => [revision.path, revision.mtimeMs])),
          );
        }
        try {
          localManifests.set(
            ns,
            await buildReconcileManifest({
              files,
              readFile: async (file) => {
                const readFile = io.readFile;
                if (!readFile) throw new Error("offline storage cannot read reconciliation manifest files");
                return await readFile({
                  root: rootInfo.rootDir,
                  path: file.path,
                  filePath: path.join(rootInfo.rootDir, file.path),
                });
              },
            })
            }),
          );
        } catch {
          localManifests.delete(ns);
        const evidence = await readLocalTombstoneEvidence(rootInfo.rootDir);
        const io = await createOfflineStorageIo(rootInfo.rootDir);
        let manifestReadFailed = false;
        const manifest = await buildReconcileManifest({
          files,
          parseMemory: parseFrontmatter,
          readFile: async (file) => {
            const readFile = io.readFile;
            if (!readFile) {
              manifestReadFailed = true;
              throw new Error("offline storage cannot read reconciliation manifest files");
            }
            try {
              return await readFile({
                root: rootInfo.rootDir,
                path: file.path,
                filePath: path.join(rootInfo.rootDir, file.path),
              });
            } catch (error) {
              manifestReadFailed = true;
              throw error;
            }
          },
        });
        if (manifestReadFailed) {
          throw new Error(`failed to build local reconciliation manifest for namespace ${ns}`);
        }
        localManifests.set(ns, manifest);
        localTombstones.set(ns, tombstonedFileDigests(evidence, manifest));
    }
  }

  const peerUrl = options.peerUrl;
  if (memoryDir && peerUrl) {
    for (const namespace of await discoverCursorNamespaces(memoryDir, peerUrl)) {
      namespacesToPlan.add(namespace);
    }
  }
  if (!options.peerFilesByNamespace && peerUrl) {
    let resolvedToken: string | undefined;
    if (options.peerToken) {
      try {
        resolvedToken = await resolveAgentAccessAuthToken(options.peerToken, {
          resolveSecretRef: options.resolveSecretRef,
        });
      } catch {
        resolvedToken = options.peerToken;
      }
    }
    const fetchFn = options.fetchImpl ?? globalThis.fetch;
    const timeoutMs = options.peerRequestTimeoutMs ?? DEFAULT_PEER_REQUEST_TIMEOUT_MS;
    const capabilities = await fetchPeerSyncCapabilities(
      peerUrl,
      resolvedToken,
      fetchFn,
      timeoutMs,
    );
    for (const ns of namespacesToPlan) {
      const peerData = await fetchPeerSnapshot(peerUrl, ns, resolvedToken, fetchFn);
      peerMap.set(ns, peerData.files);
      peerTombstones.set(ns, peerData.tombstones);
      if (!peerDeletionMtimeMs.has(ns)) {
        peerDeletionMtimeMs.set(ns, peerData.deletions);
      }
      peerManifests.set(
        ns,
        await buildReconcileManifest({
          files: peerData.files,
      const peerData = await fetchPeerSnapshot(peerUrl, ns, resolvedToken, fetchFn, timeoutMs);
      const streamedManifest = capabilities?.manifestStream
        ? await fetchPeerManifestStream(peerUrl, ns, resolvedToken, fetchFn, timeoutMs)
        : null;
      const peerFiles = streamedManifest?.files ?? peerData.files;
      peerMap.set(ns, peerFiles);
      let peerManifest = streamedManifest;
      if (!peerManifest) {
        let readFailure: Error | undefined;
        peerManifest = await buildReconcileManifest({
          files: peerFiles,
          parseMemory: parseFrontmatter,
          cachedFiles: localManifests.get(ns)?.files,
          readFile: async (file) => {
            let remote: PeerFileContent | null;
            try {
              remote = await fetchPeerFileContent(peerUrl, ns, file.path, resolvedToken, fetchFn, timeoutMs);
            } catch (error) {
              readFailure = error instanceof Error ? error : new Error(String(error));
              throw readFailure;
            }
            if (!remote || remote.sha256 !== file.sha256) {
              readFailure = new Error(`failed to read peer reconciliation manifest file: ${file.path}`);
              throw readFailure;
            }
            return remote.content;
          },
        })
      );
    }
  }

  const memoryDir = options.cursorDir ?? config?.memoryDir;
  if (memoryDir && options.peerUrl && (!options.baseFilesByNamespace || !options.semanticAgreementsByNamespace)) {
        });
        if (readFailure) throw readFailure;
      }
      peerManifests.set(ns, peerManifest);
      const evidence: TombstoneEvidence = { contentHashes: new Set(), fileSha256: new Set() };
      for (const tombstonePath of TOMBSTONE_PATHS) {
        const state = peerFiles.find((file) => file.path === tombstonePath);
        if (!state) continue;
        const remote = await fetchPeerFileContent(
          peerUrl,
          ns,
          tombstonePath,
          resolvedToken,
          fetchFn,
          timeoutMs,
        );
        if (!remote || remote.sha256.toLowerCase() !== state.sha256.toLowerCase()) {
          throw new Error(`failed to read peer tombstone evidence: ${tombstonePath}`);
        }
        const parsed = parseTombstoneEvidence(remote.content.toString("utf8"));
        for (const value of parsed.contentHashes) evidence.contentHashes.add(value);
        for (const value of parsed.fileSha256) evidence.fileSha256.add(value);
      }
      const mapped = tombstonedFileDigests(evidence, peerManifests.get(ns));
      for (const digest of peerData.tombstones) mapped.add(digest);
      peerTombstones.set(ns, mapped);
    }
  }

  if (
    memoryDir
    && options.peerUrl
    && (!options.baseFilesByNamespace || !options.semanticAgreementsByNamespace)
  ) {
    for (const ns of namespacesToPlan) {
      const cursorPath = defaultConvergeCursorPath(memoryDir, options.peerUrl, ns);
      const cursor = await readConvergeCursor(cursorPath);
      if (!options.baseFilesByNamespace && cursor?.baseFiles && cursor.baseFiles.length > 0) {
        baseMap.set(
          ns,
          cursor.baseFiles.filter((file) => !isInternalRemnicStatePath(file.path)),
        );
      }
      if (
        !options.semanticAgreementsByNamespace &&
        cursor?.semanticAgreements &&
        cursor.semanticAgreements.length > 0
      ) {
        semanticAgreementMap.set(
          ns,
          cursor.semanticAgreements.filter(
            (agreement) =>
              !isInternalRemnicStatePath(agreement.local.path)
              && !isInternalRemnicStatePath(agreement.peer.path),
          ),
        );
      }
    }
  }

  const inputs: ReconcileNamespaceInput[] = [];
  for (const ns of [...namespacesToPlan].sort()) {
    const baseFiles = baseMap.get(ns);
    const localFiles = localMap.get(ns) ?? [];
    const peerFiles = peerMap.get(ns) ?? [];
    const localDeletions = new Map(localDeletionMtimeMs.get(ns) ?? []);
    const peerDeletions = new Map(peerDeletionMtimeMs.get(ns) ?? []);
    inputs.push({
      namespace: ns,
      local: localFiles,
      peer: peerFiles,
      base: baseFiles,
      localDeletionMtimeMs: localDeletions,
      peerDeletionMtimeMs: peerDeletions,
      tombstonedFileSha256: localTombstones.get(ns) ?? [],
      peerTombstonedFileSha256: peerTombstones.get(ns) ?? [],
    });
  }

  const conflictPolicy = options.conflictPolicy ?? config?.converge.conflictPolicy ?? DEFAULT_CONVERGE_CONFLICT_POLICY;
  const plan = planReconciliation(inputs, { conflictPolicy });
  return collapseActiveFactDuplicates(plan, localManifests, peerManifests, semanticAgreementMap);
}

export async function executeConvergeApply(options: ConvergeApplyOptions = {}): Promise<ConvergeApplyResult> {
  const conflictPolicy =
    options.conflictPolicy ?? options.config?.converge.conflictPolicy ?? DEFAULT_CONVERGE_CONFLICT_POLICY;
  const plan = await computeConvergePlan({ ...options, conflictPolicy });

  const plannedTransfers = {
    pulled: 0,
    pushed: 0,
    conflictsResolved: 0,
    suppressed: 0,
    failed: 0,
  };
  for (const entry of plan.entries) {
    if (entry.action === "pull") plannedTransfers.pulled += 1;
    else if (entry.action === "push") plannedTransfers.pushed += 1;
    else if (entry.action === "conflict") plannedTransfers.conflictsResolved += 1;
    else if (entry.action === "suppress") plannedTransfers.suppressed += 1;
  }

  if (options.dryRun) {
    return {
      converged: plan.converged,
      status: "dry_run",
      plan,
      transfers: plannedTransfers,
      cursorUpdated: false,
      receiverFinalization: receiverFinalizationResult("not_required"),
    };
  }

  let resolvedToken: string | undefined;
  if (options.peerToken) {
    try {
      resolvedToken = await resolveAgentAccessAuthToken(options.peerToken, {
        resolveSecretRef: options.resolveSecretRef,
      });
    } catch {
      resolvedToken = options.peerToken;
    }
  }
  const fetchFn = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.peerRequestTimeoutMs ?? DEFAULT_PEER_REQUEST_TIMEOUT_MS;

  let config = options.config;
  if (!config) {
    try {
      config = parseConfig({});
    } catch {
      config = undefined;
    }
  }

  const pendingLocalNamespaces = await readPendingRefreshNamespaces(plan, options, "local");
  const pendingReceiverNamespaces = await readPendingRefreshNamespaces(plan, options, "receiver");
  const plannedReceiverNamespaces = new Set(
    plan.entries.filter((entry) => plansReceiverMutation(entry, options)).map((entry) => entry.namespace)
  );
  let receiverNegotiation: ReceiverFinalizationNegotiation | undefined;
  if (options.peerUrl && (pendingReceiverNamespaces.size > 0 || plannedReceiverNamespaces.size > 0)) {
    receiverNegotiation = await negotiateReceiverFinalization(options.peerUrl, resolvedToken, fetchFn);
    if (receiverNegotiation.capability === "unsupported") {
      return {
        converged: false,
        status: "receiver_finalization_unsupported",
        plan,
        transfers: { pulled: 0, pushed: 0, conflictsResolved: 0, suppressed: 0, failed: 0 },
        cursorUpdated: false,
        receiverFinalization: receiverFinalizationResult("unsupported", [], pendingReceiverNamespaces),
      };
    }
  }

  if (pendingLocalNamespaces.size > 0) {
    const namespaces = [...pendingLocalNamespaces].sort();
    await refreshLocalProjections(options, config, namespaces);
    for (const namespace of namespaces) {
      await setRefreshPending(options, namespace, "local", false);
    }
    pendingLocalNamespaces.clear();
  }

  const refreshedReceiverNamespaces = new Set<string>();
  if (options.peerUrl && receiverNegotiation?.capability === "supported" && pendingReceiverNamespaces.size > 0) {
    const namespaces = [...pendingReceiverNamespaces].sort();
    await postPeerConvergenceComplete(options.peerUrl, receiverNegotiation.route, namespaces, resolvedToken, fetchFn);
    for (const namespace of namespaces) {
      await setRefreshPending(options, namespace, "receiver", false);
      refreshedReceiverNamespaces.add(namespace);
    }
    pendingReceiverNamespaces.clear();
  }

  const unresolvedCount = plan.byNamespace.reduce((acc, report) => acc + report.unresolved, 0);
  if (unresolvedCount > 0) {
    return {
      converged: false,
      status: "stopped_unresolved_conflicts",
      plan,
      transfers: { pulled: 0, pushed: 0, conflictsResolved: 0, suppressed: 0, failed: 0 },
      cursorUpdated: false,
      receiverFinalization: receiverFinalizationResult(
        receiverNegotiation?.capability ?? "not_required",
        refreshedReceiverNamespaces
      ),
    };
  }

  if (plan.converged) {
    await updateCursorsForPlan(plan, options);
    return {
      converged: true,
      status: "converged",
      plan,
      transfers: { pulled: 0, pushed: 0, conflictsResolved: 0, suppressed: 0, failed: 0 },
      cursorUpdated: true,
      receiverFinalization: receiverFinalizationResult(
        receiverNegotiation?.capability ?? "not_required",
        refreshedReceiverNamespaces
      ),
    };
  }

  const actualTransfers = {
    pulled: 0,
    pushed: 0,
    conflictsResolved: 0,
    suppressed: 0,
    failed: 0,
  };
  const localMutatedNamespaces = new Set<string>();
  const localMarkedThisRun = new Set<string>();
  const peerMutatedNamespaces = new Set<string>();
  const receiverMarkedThisRun = new Set<string>();

  const rootMap = new Map<string, string>();
  if (config) {
    try {
      const roots = await resolveCorpusNamespaceRoots({ config });
      for (const r of roots) {
        rootMap.set(r.namespace, r.rootDir);
      }
    } catch {
      rootMap.clear();
    }
  }

  for (const entry of plan.entries) {
    if (entry.action === "identical") continue;

    let transferType: "pull" | "push" | "delete-local" | "delete-peer" | "suppress" | "none" = "none";
    if (entry.action === "pull") {
      transferType = "pull";
    } else if (entry.action === "push") {
      transferType = "push";
    } else if (entry.action === "suppress") {
      transferType = "suppress";
    } else if (entry.action === "conflict") {
      if (entry.resolution === "peer-wins") {
        transferType = entry.peerSha256 ? "pull" : "delete-local";
      } else if (entry.resolution === "local-wins") {
        transferType = entry.localSha256 ? "push" : "delete-peer";
      }
    }
    const localPath = entry.semanticAgreement?.local.path ?? entry.path;
    const peerPath = entry.semanticAgreement?.peer.path ?? entry.path;

    if (transferType === "pull") {
      const buffered = options.peerFileBuffers?.get(entry.namespace)?.get(peerPath);
      if (options.localFileBuffers) {
        let remoteFile: PeerFileContent | null = null;
        if (buffered) {
          const state = options.peerFilesByNamespace
            ?.get(entry.namespace)
            ?.find((file) => file.path === peerPath);
          remoteFile = {
            content: buffered,
            sha256: state?.sha256 ?? entry.peerSha256 ?? createHash("sha256").update(buffered).digest("hex"),
            bytes: buffered.length,
            mtimeMs: state?.mtimeMs ?? 0,
          };
        } else if (options.peerUrl) {
          remoteFile = await fetchPeerFileContent(
            options.peerUrl,
            entry.namespace,
            peerPath,
            resolvedToken,
            fetchFn,
            timeoutMs,
          );
        }
        if (!remoteFile || (entry.peerSha256 && remoteFile.sha256 !== entry.peerSha256)) {
          actualTransfers.failed += 1;
          continue;
        }
        let namespaceFiles = options.localFileBuffers.get(entry.namespace);
        if (!namespaceFiles) {
          namespaceFiles = new Map();
          options.localFileBuffers.set(entry.namespace, namespaceFiles);
        }
        namespaceFiles.set(localPath, remoteFile.content);
        if (entry.action === "conflict") actualTransfers.conflictsResolved += 1;
        else actualTransfers.pulled += 1;
        continue;
      }

      const rootDir = rootMap.get(entry.namespace);
      if (!rootDir) {
        actualTransfers.failed += 1;
        continue;
      }
      const io = await createOfflineStorageIo(rootDir);
      const expectedLocalSha256 = entry.action === "conflict" ? entry.localSha256 : entry.baseSha256;
      let transferComplete = false;
      let transferRejected = false;
      const applyChunk = async (chunk: PeerFileChunk): Promise<void> => {
        if (transferRejected) return;
        if (entry.peerSha256 && chunk.sha256 !== entry.peerSha256) {
          transferRejected = true;
          return;
        }
        const chunkResult = await applyOfflineSyncFileContentChunk({
          root: rootDir,
          sourceId: "remnic-converge",
          path: localPath,
          sha256: chunk.sha256,
          bytes: chunk.bytes,
          mtimeMs: chunk.mtimeMs,
          offset: chunk.offset,
          content: chunk.content,
          ...(expectedLocalSha256 ? { baseSha256: expectedLocalSha256 } : {}),
          readFile: io.readFile,
          readFileDigest: io.readFileDigest,
          writeFile: io.writeFile,
          writeStagingFile: io.writeStagingFile,
          writeFileChunks: io.writeFileChunks,
        });
        if (chunkResult.conflict) {
          transferRejected = true;
        } else if (chunkResult.done) {
          transferComplete = chunkResult.applied || chunkResult.skipped;
        } else if (chunkResult.applied || chunkResult.skipped || chunk.content.length === 0) {
          transferRejected = true;
        }
      };

      let metadata: Omit<PeerFileContent, "content"> | null = null;
      if (buffered) {
        const state = options.peerFilesByNamespace?.get(entry.namespace)?.find((file) => file.path === entry.path);
        remoteFile = {
          content: buffered,
          sha256: state?.sha256 ?? entry.peerSha256 ?? createHash("sha256").update(buffered).digest("hex"),
          bytes: buffered.length,
          mtimeMs: state?.mtimeMs ?? 0,
        };
      } else if (options.peerUrl) {
        remoteFile = await fetchPeerFileContent(options.peerUrl, entry.namespace, entry.path, resolvedToken, fetchFn);
      }

      if (remoteFile !== null && (!entry.peerSha256 || remoteFile.sha256 === entry.peerSha256)) {
        if (options.localFileBuffers) {
          let nsMap = options.localFileBuffers.get(entry.namespace);
          if (!nsMap) {
            nsMap = new Map();
            options.localFileBuffers.set(entry.namespace, nsMap);
          }
          nsMap.set(entry.path, remoteFile.content);
          if (entry.action === "conflict") actualTransfers.conflictsResolved += 1;
          else actualTransfers.pulled += 1;
        } else {
          const rootDir = rootMap.get(entry.namespace);
          if (rootDir) {
            if (!pendingLocalNamespaces.has(entry.namespace)) {
              await setRefreshPending(options, entry.namespace, "local", true);
              pendingLocalNamespaces.add(entry.namespace);
              localMarkedThisRun.add(entry.namespace);
            }
            const io = await createOfflineStorageIo(rootDir);
            const expectedLocalSha256 = entry.action === "conflict" ? entry.localSha256 : entry.baseSha256;
            let offset = 0;
            let transferComplete = false;
            let fileApplied = false;
            do {
              const chunk = remoteFile.content.subarray(
                offset,
                Math.min(remoteFile.content.length, offset + OFFLINE_SYNC_FILE_CONTENT_TRANSFER_CHUNK_BYTES)
              );
              const chunkResult = await applyOfflineSyncFileContentChunk({
                root: rootDir,
                sourceId: "remnic-converge",
                path: entry.path,
                sha256: remoteFile.sha256,
                bytes: remoteFile.bytes,
                mtimeMs: remoteFile.mtimeMs,
                offset,
                content: chunk,
                ...(expectedLocalSha256 ? { baseSha256: expectedLocalSha256 } : {}),
                readFile: io.readFile,
                readFileDigest: io.readFileDigest,
                writeFile: io.writeFile,
                writeStagingFile: io.writeStagingFile,
                writeFileChunks: io.writeFileChunks,
              });
              if (chunkResult.conflict) {
                break;
              }
              if (chunkResult.done) {
                transferComplete = chunkResult.applied || chunkResult.skipped;
                fileApplied = chunkResult.applied;
                break;
              }
              if (chunkResult.applied || chunkResult.skipped || chunk.length === 0) {
                break;
              }
              offset += chunk.length;
            } while (offset < remoteFile.content.length);
            if (transferComplete) {
              if (entry.action === "conflict") actualTransfers.conflictsResolved += 1;
              else actualTransfers.pulled += 1;
              if (fileApplied) localMutatedNamespaces.add(entry.namespace);
            } else {
              actualTransfers.failed += 1;
            }
          } else {
            actualTransfers.failed += 1;
          }
        }
        const state = options.peerFilesByNamespace
          ?.get(entry.namespace)
          ?.find((file) => file.path === peerPath);
        const sha256 = state?.sha256 ?? entry.peerSha256 ?? createHash("sha256").update(buffered).digest("hex");
        const bytes = buffered.length;
        const mtimeMs = state?.mtimeMs ?? 0;
        let offset = 0;
        do {
          const content = buffered.subarray(
            offset,
            Math.min(bytes, offset + OFFLINE_SYNC_FILE_CONTENT_TRANSFER_CHUNK_BYTES),
          );
          await applyChunk({ content, offset, sha256, bytes, mtimeMs });
          offset += content.length;
        } while (!transferRejected && !transferComplete && offset < bytes);
        metadata = { sha256, bytes, mtimeMs };
      } else if (options.peerUrl) {
        metadata = await streamPeerFileContent(
          options.peerUrl,
          entry.namespace,
          peerPath,
          applyChunk,
          resolvedToken,
          fetchFn,
          timeoutMs,
        );
      }
      if (
        metadata
        && transferComplete
        && !transferRejected
        && (!entry.peerSha256 || metadata.sha256 === entry.peerSha256)
      ) {
        if (entry.action === "conflict") actualTransfers.conflictsResolved += 1;
        else actualTransfers.pulled += 1;
      } else {
        actualTransfers.failed += 1;
      }
    } else if (transferType === "push") {
      let content: Buffer | null = null;
      let mtimeMs = options.localFilesByNamespace
        ?.get(entry.namespace)
        ?.find((file) => file.path === entry.path)?.mtimeMs;
      if (options.localFileBuffers?.get(entry.namespace)?.has(entry.path)) {
        content = options.localFileBuffers.get(entry.namespace)!.get(entry.path)!;
      } else {
      const localBuffer = options.localFileBuffers?.get(entry.namespace)?.get(localPath);
      let source: PeerFileSource | null = null;
      let closeSource: (() => Promise<void>) | undefined;
      const expectedPeerSha256 = entry.action === "conflict" ? entry.peerSha256 : entry.baseSha256;
      if (localBuffer && entry.localSha256) {
        source = {
          sha256: entry.localSha256,
          bytes: localBuffer.length,
          mtimeMs: options.localFilesByNamespace
            ?.get(entry.namespace)
            ?.find((file) => file.path === localPath)
            ?.mtimeMs ?? 0,
          ...(expectedPeerSha256 ? { baseSha256: expectedPeerSha256 } : {}),
          readChunk: async (offset, length) => localBuffer.subarray(offset, offset + length),
        };
      } else if (entry.localSha256) {
        const rootDir = rootMap.get(entry.namespace);
        if (rootDir) {
          try {
            const filePath = path.join(rootDir, localPath);
            const io = await createOfflineStorageIo(rootDir);
            const current = await io.readFileDigest({ root: rootDir, path: localPath, filePath });
            if (current.sha256 !== entry.localSha256) {
              throw new Error(`local file changed during push: ${localPath}`);
            }
            const stat = await fs.promises.stat(filePath);
            let chunks: AsyncIterator<Buffer> | undefined;
            let chunkOffset = 0;
            const resetChunks = async (): Promise<void> => {
              await chunks?.return?.();
              chunks = io.readFileChunks({
                root: rootDir,
                path: localPath,
                filePath,
                chunkSize: OFFLINE_SYNC_FILE_CONTENT_TRANSFER_CHUNK_BYTES,
              })[Symbol.asyncIterator]();
              chunkOffset = 0;
            };
            closeSource = async () => {
              await chunks?.return?.();
            };
            source = {
              sha256: entry.localSha256,
              bytes: current.bytes,
              mtimeMs: stat.mtimeMs,
              ...(expectedPeerSha256 ? { baseSha256: expectedPeerSha256 } : {}),
              readChunk: async (offset, length) => {
                if (!chunks || offset < chunkOffset) await resetChunks();
                while (chunkOffset < offset) {
                  const skipped = await chunks!.next();
                  if (skipped.done || chunkOffset + skipped.value.length > offset) {
                    throw new Error(`cannot resume local file upload at offset ${offset}: ${localPath}`);
                  }
                  chunkOffset += skipped.value.length;
                }
                const next = await chunks!.next();
                if (next.done) return Buffer.alloc(0);
                if (next.value.length > length) {
                  throw new Error(`local file chunk exceeds requested length: ${localPath}`);
                }
                chunkOffset += next.value.length;
                return next.value;
              },
            };
          } catch {
            source = null;
          }
        }
      }

      try {
        if (options.peerFileBuffers && localBuffer) {
          let namespaceFiles = options.peerFileBuffers.get(entry.namespace);
          if (!namespaceFiles) {
            namespaceFiles = new Map();
            options.peerFileBuffers.set(entry.namespace, namespaceFiles);
          }
          namespaceFiles.set(peerPath, localBuffer);
          if (entry.action === "conflict") actualTransfers.conflictsResolved += 1;
          else actualTransfers.pushed += 1;
        } else if (options.peerUrl && entry.localSha256) {
          if (!pendingReceiverNamespaces.has(entry.namespace)) {
            await setRefreshPending(options, entry.namespace, "receiver", true);
            pendingReceiverNamespaces.add(entry.namespace);
            receiverMarkedThisRun.add(entry.namespace);
          }
          const expectedPeerSha256 = entry.action === "conflict" ? entry.peerSha256 : entry.baseSha256;
        } else if (options.peerUrl && source) {
          const applied = await postPeerFileContent(
            options.peerUrl,
            entry.namespace,
            peerPath,
            source,
            resolvedToken,
            fetchFn
            fetchFn,
            timeoutMs,
          );
          if (applied === "applied") {
            peerMutatedNamespaces.add(entry.namespace);
            if (entry.action === "conflict") actualTransfers.conflictsResolved += 1;
            else actualTransfers.pushed += 1;
          } else if (applied === "skipped") {
            if (entry.action === "conflict") actualTransfers.conflictsResolved += 1;
            else actualTransfers.pushed += 1;
          } else {
            if (applied === "ambiguous") peerMutatedNamespaces.add(entry.namespace);
            actualTransfers.failed += 1;
          }
        } else {
          actualTransfers.failed += 1;
        }
      } finally {
        await closeSource?.();
      }
    } else if (transferType === "delete-local") {
      let deleted = false;
      let localRefreshTracked = false;
      const bufferedFiles = options.localFileBuffers?.get(entry.namespace);
      if (options.localFileBuffers) {
        const current = bufferedFiles?.get(entry.path);
        if (current && entry.localSha256 && createHash("sha256").update(current).digest("hex") === entry.localSha256) {
          bufferedFiles!.delete(entry.path);
        const current = bufferedFiles?.get(localPath);
        if (
          current
          && entry.localSha256
          && createHash("sha256").update(current).digest("hex") === entry.localSha256
        ) {
          bufferedFiles!.delete(localPath);
          deleted = true;
        }
      } else {
        const rootDir = rootMap.get(entry.namespace);
        if (rootDir && entry.localSha256) {
          if (!pendingLocalNamespaces.has(entry.namespace)) {
            await setRefreshPending(options, entry.namespace, "local", true);
            pendingLocalNamespaces.add(entry.namespace);
            localMarkedThisRun.add(entry.namespace);
          }
          localRefreshTracked = true;
        if (rootDir && entry.localSha256 && entry.deletionMtimeMs !== undefined) {
          try {
            const io = await createOfflineStorageIo(rootDir);
            const filePath = path.join(rootDir, localPath);
            const current = await io.readFileDigest({ root: rootDir, path: localPath, filePath });
            if (current.sha256 === entry.localSha256) {
              await io.deleteFile!({
                root: rootDir,
                path: entry.path,
                filePath,
                mtimeMs: entry.deletionMtimeMs,
              });
              await io.deleteFile!({ root: rootDir, path: localPath, filePath });
              deleted = true;
            }
          } catch {
            deleted = false;
          }
        }
      }
      if (deleted) {
        actualTransfers.conflictsResolved += 1;
        if (localRefreshTracked) localMutatedNamespaces.add(entry.namespace);
      } else {
        actualTransfers.failed += 1;
      }
    } else if (transferType === "delete-peer") {
      let deleted = false;
      const bufferedFiles = options.peerFileBuffers?.get(entry.namespace);
      if (options.peerFileBuffers) {
        const current = bufferedFiles?.get(entry.path);
        if (current && entry.peerSha256 && createHash("sha256").update(current).digest("hex") === entry.peerSha256) {
          bufferedFiles!.delete(entry.path);
        const current = bufferedFiles?.get(peerPath);
        if (
          current
          && entry.peerSha256
          && createHash("sha256").update(current).digest("hex") === entry.peerSha256
        ) {
          bufferedFiles!.delete(peerPath);
          deleted = true;
        }
      } else if (options.peerUrl && entry.peerSha256) {
        if (!pendingReceiverNamespaces.has(entry.namespace)) {
          await setRefreshPending(options, entry.namespace, "receiver", true);
          pendingReceiverNamespaces.add(entry.namespace);
          receiverMarkedThisRun.add(entry.namespace);
        }
      } else if (options.peerUrl && entry.peerSha256 && entry.deletionMtimeMs !== undefined) {
        const deletionResult = await postPeerFileDeletion(
          options.peerUrl,
          entry.namespace,
          peerPath,
          entry.peerSha256,
          entry.deletionMtimeMs,
          resolvedToken,
          fetchFn
          fetchFn,
          timeoutMs,
        );
        deleted = deletionResult === "applied" || deletionResult === "skipped";
        if (deletionResult === "applied" || deletionResult === "ambiguous") {
          peerMutatedNamespaces.add(entry.namespace);
        }
      }
      if (deleted) actualTransfers.conflictsResolved += 1;
      else actualTransfers.failed += 1;
    } else if (transferType === "suppress") {
      let suppressed = entry.suppressSide !== undefined;
      if (entry.suppressSide === "local" || entry.suppressSide === "both") {
        let deletedLocal = false;
        if (entry.localSha256 && options.localFileBuffers) {
          const files = options.localFileBuffers.get(entry.namespace);
          const current = files?.get(localPath);
          if (current && createHash("sha256").update(current).digest("hex") === entry.localSha256) {
            files!.delete(localPath);
            deletedLocal = true;
          }
        } else if (entry.localSha256) {
          const rootDir = rootMap.get(entry.namespace);
          if (rootDir) {
            try {
              const io = await createOfflineStorageIo(rootDir);
              const filePath = path.join(rootDir, localPath);
              const current = await io.readFileDigest({ root: rootDir, path: localPath, filePath });
              if (current.sha256 === entry.localSha256) {
                await io.deleteFile!({ root: rootDir, path: localPath, filePath });
                deletedLocal = true;
              }
            } catch {
              deletedLocal = false;
            }
          }
        }
        suppressed &&= deletedLocal;
      }
      if (entry.suppressSide === "peer" || entry.suppressSide === "both") {
        let deletedPeer = false;
        if (entry.peerSha256 && options.peerFileBuffers) {
          const files = options.peerFileBuffers.get(entry.namespace);
          const current = files?.get(peerPath);
          if (current && createHash("sha256").update(current).digest("hex") === entry.peerSha256) {
            files!.delete(peerPath);
            deletedPeer = true;
          }
        } else if (entry.peerSha256 && options.peerUrl) {
          const result = await postPeerFileDeletion(
            options.peerUrl,
            entry.namespace,
            peerPath,
            entry.peerSha256,
            resolvedToken,
            fetchFn,
            timeoutMs,
          );
          deletedPeer = Boolean(result);
          if (result === "applied") peerMutatedNamespaces.add(entry.namespace);
        }
        suppressed &&= deletedPeer;
      }
      if (suppressed) actualTransfers.suppressed += 1;
      else actualTransfers.failed += 1;
    }
  }

  for (const namespace of localMarkedThisRun) {
    if (localMutatedNamespaces.has(namespace)) continue;
    await setRefreshPending(options, namespace, "local", false);
    pendingLocalNamespaces.delete(namespace);
  }
  if (localMutatedNamespaces.size > 0) {
    const namespaces = [...localMutatedNamespaces].sort();
    await refreshLocalProjections(options, config, namespaces);
    for (const namespace of namespaces) {
      await setRefreshPending(options, namespace, "local", false);
      pendingLocalNamespaces.delete(namespace);
    }
  }

  for (const namespace of receiverMarkedThisRun) {
    if (peerMutatedNamespaces.has(namespace)) continue;
    await setRefreshPending(options, namespace, "receiver", false);
    pendingReceiverNamespaces.delete(namespace);
  }
  if (options.peerUrl && peerMutatedNamespaces.size > 0) {
    if (receiverNegotiation?.capability !== "supported") {
      throw new Error("receiver finalization was not negotiated before mutation");
    }
    const namespaces = [...peerMutatedNamespaces].sort();
    await postPeerConvergenceComplete(options.peerUrl, receiverNegotiation.route, namespaces, resolvedToken, fetchFn);
    for (const namespace of namespaces) {
      await setRefreshPending(options, namespace, "receiver", false);
      pendingReceiverNamespaces.delete(namespace);
      refreshedReceiverNamespaces.add(namespace);
    if (!await postPeerConvergenceComplete(
      options.peerUrl,
      namespaces,
      resolvedToken,
      fetchFn,
      timeoutMs,
    )) {
      actualTransfers.failed += 1;
    }
  }

  let cursorUpdated = false;
  if (actualTransfers.failed === 0) {
    await updateCursorsForPlan(plan, options);
    cursorUpdated = true;
  }

  return {
    converged: actualTransfers.failed === 0,
    status: "applied",
    plan,
    transfers: actualTransfers,
    cursorUpdated,
    receiverFinalization: receiverFinalizationResult(
      receiverNegotiation?.capability ?? "not_required",
      refreshedReceiverNamespaces,
      pendingReceiverNamespaces
    ),
  };
}

async function updateCursorsForPlan(plan: ReconcilePlan, options: ConvergeApplyOptions): Promise<void> {
  const peerUrl = options.peerUrl ?? "local";
async function updateCursorsForPlan(
  plan: ReconcilePlan,
  options: ConvergeApplyOptions,
): Promise<void> {
  const peerUrl = normalizeConvergePeerUrl(options.peerUrl ?? "local");
  let memoryDir: string | undefined;
  if (options.cursorDir) {
    memoryDir = options.cursorDir;
  } else if (options.config) {
    memoryDir = options.config.memoryDir;
  }
  if (!memoryDir) return;

  const namespaces = new Set(plan.byNamespace.map((n) => n.namespace));
  for (const ns of namespaces) {
    const cursorPath = defaultConvergeCursorPath(memoryDir, peerUrl, ns);
    const priorSemanticAgreements =
      options.semanticAgreementsByNamespace?.get(ns) ??
      (await readConvergeCursor(cursorPath))?.semanticAgreements ??
      [];
    const { baseFiles, semanticAgreements } = deriveConvergeCursorBase(plan.entries, ns, priorSemanticAgreements);

    const cursorState: ConvergeCursorState = {
      version: 1,
      peerUrl,
      namespace: ns,
      lastConvergedAt: new Date().toISOString(),
      baseFiles,
      semanticAgreements,
    };
    await writeConvergeCursor(cursorPath, cursorState);
  }
}

export function formatConvergeReport(plan: ReconcilePlan): string {
  const lines: string[] = [];
  lines.push(`Convergence Status: ${plan.converged ? "CONVERGED" : "DIVERGED"}`);
  lines.push("");
  lines.push("Per-Namespace Summary:");
  if (plan.byNamespace.length === 0) {
    lines.push("  (no namespaces evaluated)");
  } else {
    for (const report of plan.byNamespace) {
      lines.push(`  [${report.namespace}]`);
      lines.push(`    identical:  ${report.identical}`);
      lines.push(`    pull:       ${report.pull}`);
      lines.push(`    push:       ${report.push}`);
      lines.push(`    conflict:   ${report.conflict}`);
      lines.push(`    suppress:   ${report.suppress}`);
      lines.push(`    unresolved: ${report.unresolved}`);
    }
  }
  return lines.join("\n");
}

export function formatConvergeApplyReport(result: ConvergeApplyResult): string {
  const lines: string[] = [];
  lines.push(`Convergence Execution Status: ${result.status.toUpperCase()}`);
  lines.push(`Converged: ${result.converged ? "YES" : "NO"}`);
  lines.push(`Receiver finalization: ${result.receiverFinalization.capability}`);
  if (result.receiverFinalization.refreshedNamespaces.length > 0) {
    lines.push(`Receiver namespaces refreshed: ${result.receiverFinalization.refreshedNamespaces.join(", ")}`);
  }
  if (result.receiverFinalization.pendingNamespaces.length > 0) {
    lines.push(`Receiver namespaces pending: ${result.receiverFinalization.pendingNamespaces.join(", ")}`);
  }
  lines.push("");
  lines.push("Transfers Executed:");
  lines.push(`  pulled:             ${result.transfers.pulled}`);
  lines.push(`  pushed:             ${result.transfers.pushed}`);
  lines.push(`  conflictsResolved:  ${result.transfers.conflictsResolved}`);
  lines.push(`  suppressed:         ${result.transfers.suppressed}`);
  lines.push(`  failed:             ${result.transfers.failed}`);
  lines.push("");
  lines.push(formatConvergeReport(result.plan));
  return lines.join("\n");
}

export async function cmdConverge(
  action: string,
  rest: string[],
  json: boolean,
  config: PluginConfig = parseConfig({})
): Promise<void> {
  if (action === "help" || action === "--help" || action === "-h" || rest.includes("--help") || rest.includes("-h")) {
    console.log(`Usage: remnic converge <plan|apply> [options]

Subcommands:
  plan              Compute and display reconciliation plan
  apply             Execute bidirectional converge transport (alias: transport, sync)

Options:
  --peer <url>      Peer server URL (or --remote-url / --remote)
  --token <token>   Bearer token or SecretRef for peer authentication
  --conflict-policy <policy>
                    Policy override (newest-wins|manual)
                    Default: converge.conflictPolicy (newest-wins)
  --dry-run         Simulate transfers without mutating disk or remote peer
  --json            Output detailed JSON plan report
`);
    return;
  }

  if (action !== "plan" && action !== "apply" && action !== "transport" && action !== "sync") {
    process.stderr.write(`converge: unknown action "${action}". Use: plan or apply [options].\n`);
    process.exitCode = 2;
    return;
  }

  let peerUrl: string | undefined;
  let peerToken: string | undefined;
  let dryRun = false;
  let conflictPolicy: ConvergeConflictPolicy | undefined;

  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if ((arg === "--peer" || arg === "--remote-url" || arg === "--remote") && rest[i + 1]) {
      peerUrl = rest[i + 1];
      i += 1;
    } else if (arg === "--token" && rest[i + 1]) {
      peerToken = rest[i + 1];
      i += 1;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--conflict-policy") {
      const policy = rest[i + 1];
      if (typeof policy !== "string" || !CONVERGE_CONFLICT_POLICIES.includes(policy as ConvergeConflictPolicy)) {
        throw new Error(`converge: --conflict-policy must be one of ${CONVERGE_CONFLICT_POLICIES.join(", ")}`);
      }
      conflictPolicy = policy as ConvergeConflictPolicy;
      i += 1;
    }
  }

  if (action === "plan") {
    const plan = await computeConvergePlan({ config, peerUrl, peerToken, conflictPolicy });
    if (json) {
      console.log(JSON.stringify(plan, null, 2));
    } else {
      console.log(formatConvergeReport(plan));
    }
    return;
  }

  const result = await executeConvergeApply({
    peerUrl,
    peerToken,
    dryRun,
    conflictPolicy,
    config,
  });

  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatConvergeApplyReport(result));
  }
}
