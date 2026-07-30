import * as fs from "node:fs";
import { createHash } from "node:crypto";
import * as path from "node:path";
import {
  type PluginConfig,
  CONVERGE_CONFLICT_POLICIES,
  DEFAULT_CONVERGE_CONFLICT_POLICY,
  parseConfig,
  type ResolveSecretRefFn,
  buildOfflineSyncSnapshotFromBase,
  OFFLINE_SYNC_FILE_CONTENT_MAX_CHUNK_BYTES,
  OFFLINE_SYNC_CHANGESET_FORMAT,
  OFFLINE_SYNC_FILE_CONTENT_TRANSFER_CHUNK_BYTES,
  applyOfflineSyncFileContentChunk,
} from "@remnic/core";
import type { ConvergeConflictPolicy } from "@remnic/core/types.js";
import { resolveCorpusNamespaceRoots } from "@remnic/core/corpus-watermark.js";
import { listNamespaces } from "@remnic/core/namespaces/migrate.js";
import {
  planReconciliation,
  type ReconcileFileState,
  type ReconcileNamespaceInput,
  type ReconcilePlan,
} from "@remnic/core/reconcile/plan.js";
import {
  defaultConvergeCursorPath,
  readConvergeCursor,
  writeConvergeCursor,
  type ConvergeCursorState,
} from "@remnic/core/reconcile/cursor.js";
import { createOfflineStorageIo } from "./offline-storage-io.js";
import { resolveAgentAccessAuthToken } from "@remnic/core/resolve-auth-token.js";
export interface ConvergePlanOptions {
  config?: PluginConfig;
  peerUrl?: string;
  peerToken?: string;
  cursorDir?: string;
  conflictPolicy?: ConvergeConflictPolicy;
  fetchImpl?: typeof fetch;
  resolveSecretRef?: ResolveSecretRefFn;
  baseFilesByNamespace?: Map<string, ReconcileFileState[]>;
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
}

export interface ConvergeApplyResult {
  converged: boolean;
  status: "converged" | "applied" | "stopped_unresolved_conflicts" | "dry_run";
  plan: ReconcilePlan;
  transfers: {
    pulled: number;
    pushed: number;
    conflictsResolved: number;
    suppressed: number;
    failed: number;
  };
  cursorUpdated: boolean;
}

async function readLocalTombstones(rootDir: string): Promise<Set<string>> {
  const shaSet = new Set<string>();
  const candidates = [
    path.join(rootDir, "state", "tombstones.jsonl"),
    path.join(rootDir, "tombstones.jsonl"),
  ];
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
  fetchImpl: typeof fetch = globalThis.fetch,
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

  for (const route of routes) {
    let response: Response;
    try {
      response = await fetchImpl(`${base}${route}`, { headers });
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
      continue;
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
  }

  throw new Error(`failed to fetch peer snapshot for namespace ${namespace}: ${lastFailure}`);
}

interface PeerFileContent {
  content: Buffer;
  sha256: string;
  bytes: number;
  mtimeMs: number;
}

function requiredResponseNumber(response: Response, name: string): number {
  const raw = response.headers.get(name);
  const value = raw === null ? Number.NaN : Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`offline file content response had invalid ${name}`);
  }
  return value;
}

async function fetchPeerFileContent(
  peerUrl: string,
  namespace: string,
  filePath: string,
  token?: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<PeerFileContent | null> {
  const base = peerUrl.replace(/\/+$/, "");
  const routes = [
    "/remnic/v1/offline-sync/file-content",
    "/engram/v1/offline-sync/file-content",
  ];
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
          !sha256
          || chunkOffset !== offset
          || chunkBytes !== content.length
          || (encodedPath !== null && decodeURIComponent(encodedPath) !== filePath)
          || (expectedBytes !== undefined && expectedBytes !== totalBytes)
          || (expectedSha256 !== undefined && expectedSha256 !== sha256)
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
        expectedBytes === undefined
        || expectedSha256 === undefined
        || mtimeMs === undefined
        || offset !== expectedBytes
        || hash.digest("hex") !== expectedSha256
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
  }
  return null;
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
            changes: [{ type: "delete", path: filePath, baseSha256 }],
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
  const namespacesToPlan = new Set<string>();
  const localMap = new Map<string, ReconcileFileState[]>();
  const localTombstones = new Map<string, Set<string>>();
  const peerMap = new Map<string, ReconcileFileState[]>();
  const peerTombstones = new Map<string, Set<string>>();
  const localDeletionMtimeMs = new Map<string, ReadonlyMap<string, number>>();
  const peerDeletionMtimeMs = new Map<string, ReadonlyMap<string, number>>();

  if (options.baseFilesByNamespace) {
    for (const [ns, files] of options.baseFilesByNamespace) {
      namespacesToPlan.add(ns);
      baseMap.set(ns, files);
    }
  }
  if (options.localFilesByNamespace) {
    for (const [ns, files] of options.localFilesByNamespace) {
      namespacesToPlan.add(ns);
      localMap.set(ns, files);
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
      peerMap.set(ns, files);
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

  if (!options.localFilesByNamespace && config) {
    const roots = await resolveCorpusNamespaceRoots({ config });
    const discovered = await listNamespaces({ config });
    for (const entry of discovered) {
      namespacesToPlan.add(entry.namespace);
    }
    for (const rootInfo of roots) {
      const ns = rootInfo.namespace;
      namespacesToPlan.add(ns);
      try {
        const snapshot = await buildOfflineSyncSnapshotFromBase({
          root: rootInfo.rootDir,
          sourceId: "local",
          includeContent: false,
        });
        const files: ReconcileFileState[] = snapshot.files.map((record) => ({
          path: record.path,
          sha256: record.sha256,
          mtimeMs: record.mtimeMs,
          bytes: record.bytes,
        }));
        localMap.set(ns, files);
        const tombstones = await readLocalTombstones(rootInfo.rootDir);
        localTombstones.set(ns, tombstones);
      } catch {
        localMap.set(ns, []);
      }
    }
  }

  if (!options.peerFilesByNamespace && options.peerUrl) {
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
    for (const ns of namespacesToPlan) {
      const peerData = await fetchPeerSnapshot(options.peerUrl, ns, resolvedToken, fetchFn);
      peerMap.set(ns, peerData.files);
      peerTombstones.set(ns, peerData.tombstones);
    }
  }

  const memoryDir = options.cursorDir ?? config?.memoryDir;
  if (!options.baseFilesByNamespace && memoryDir && options.peerUrl) {
    for (const ns of namespacesToPlan) {
      const cursorPath = defaultConvergeCursorPath(memoryDir, options.peerUrl, ns);
      const cursor = await readConvergeCursor(cursorPath);
      if (cursor?.baseFiles && cursor.baseFiles.length > 0) {
        baseMap.set(ns, cursor.baseFiles);
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

  const conflictPolicy = options.conflictPolicy
    ?? config?.converge.conflictPolicy
    ?? DEFAULT_CONVERGE_CONFLICT_POLICY;
  return planReconciliation(inputs, { conflictPolicy });
}

export async function executeConvergeApply(
  options: ConvergeApplyOptions = {},
): Promise<ConvergeApplyResult> {
  const conflictPolicy = options.conflictPolicy
    ?? options.config?.converge.conflictPolicy
    ?? DEFAULT_CONVERGE_CONFLICT_POLICY;
  const plan = await computeConvergePlan({ ...options, conflictPolicy });

  if (plan.converged && !options.dryRun) {
    await updateCursorsForPlan(plan, options);
    return {
      converged: true,
      status: "converged",
      plan,
      transfers: { pulled: 0, pushed: 0, conflictsResolved: 0, suppressed: 0, failed: 0 },
      cursorUpdated: true,
    };
  }

  const unresolvedCount = plan.byNamespace.reduce((acc, report) => acc + report.unresolved, 0);
  if (unresolvedCount > 0) {
    // Every policy stops when its conflict rule cannot choose a safe resolution.
    return {
      converged: false,
      status: "stopped_unresolved_conflicts",
      plan,
      transfers: { pulled: 0, pushed: 0, conflictsResolved: 0, suppressed: 0, failed: 0 },
      cursorUpdated: false,
    };
  }

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
      converged: false,
      status: "dry_run",
      plan,
      transfers: plannedTransfers,
      cursorUpdated: false,
    };
  }

  const actualTransfers = {
    pulled: 0,
    pushed: 0,
    conflictsResolved: 0,
    suppressed: 0,
    failed: 0,
  };
  const peerMutatedNamespaces = new Set<string>();

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

  let config = options.config;
  if (!config) {
    try {
      config = parseConfig({});
    } catch {
      // ignore
    }
  }

  const rootMap = new Map<string, string>();
  if (config) {
    try {
      const roots = await resolveCorpusNamespaceRoots({ config });
      for (const r of roots) {
        rootMap.set(r.namespace, r.rootDir);
      }
    } catch {
      // ignore
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

    if (transferType === "pull") {
      let remoteFile: PeerFileContent | null = null;
      const buffered = options.peerFileBuffers?.get(entry.namespace)?.get(entry.path);
      if (buffered) {
        const state = options.peerFilesByNamespace
          ?.get(entry.namespace)
          ?.find((file) => file.path === entry.path);
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
          entry.path,
          resolvedToken,
          fetchFn,
        );
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
            const io = await createOfflineStorageIo(rootDir);
            const expectedLocalSha256 = entry.action === "conflict"
              ? entry.localSha256
              : entry.baseSha256;
            let offset = 0;
            let transferComplete = false;
            do {
              const chunk = remoteFile.content.subarray(
                offset,
                Math.min(
                  remoteFile.content.length,
                  offset + OFFLINE_SYNC_FILE_CONTENT_TRANSFER_CHUNK_BYTES,
                ),
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
            } else {
              actualTransfers.failed += 1;
            }
          } else {
            actualTransfers.failed += 1;
          }
        }
      } else {
        actualTransfers.failed += 1;
      }
    } else if (transferType === "push") {
      let content: Buffer | null = null;
      let mtimeMs = options.localFilesByNamespace
        ?.get(entry.namespace)
        ?.find((file) => file.path === entry.path)
        ?.mtimeMs;
      if (options.localFileBuffers?.get(entry.namespace)?.has(entry.path)) {
        content = options.localFileBuffers.get(entry.namespace)!.get(entry.path)!;
      } else {
        const rootDir = rootMap.get(entry.namespace);
        if (rootDir) {
          const filePath = path.join(rootDir, entry.path);
          try {
            const io = await createOfflineStorageIo(rootDir);
            content = await io.readFile!({ root: rootDir, path: entry.path, filePath });
            mtimeMs ??= (await fs.promises.stat(filePath)).mtimeMs;
          } catch {
            content = null;
          }
        }
      }

      if (content !== null) {
        if (options.peerFileBuffers) {
          let nsMap = options.peerFileBuffers.get(entry.namespace);
          if (!nsMap) {
            nsMap = new Map();
            options.peerFileBuffers.set(entry.namespace, nsMap);
          }
          nsMap.set(entry.path, content);
          if (entry.action === "conflict") actualTransfers.conflictsResolved += 1;
          else actualTransfers.pushed += 1;
        } else if (options.peerUrl && entry.localSha256) {
          const expectedPeerSha256 = entry.action === "conflict"
            ? entry.peerSha256
            : entry.baseSha256;
          const applied = await postPeerFileContent(
            options.peerUrl,
            entry.namespace,
            entry.path,
            content,
            {
              sha256: entry.localSha256,
              mtimeMs: mtimeMs ?? 0,
              ...(expectedPeerSha256 ? { baseSha256: expectedPeerSha256 } : {}),
            },
            resolvedToken,
            fetchFn,
          );
          if (applied) {
            if (applied === "applied") peerMutatedNamespaces.add(entry.namespace);
            if (entry.action === "conflict") actualTransfers.conflictsResolved += 1;
            else actualTransfers.pushed += 1;
          } else {
            actualTransfers.failed += 1;
          }
        } else {
          actualTransfers.failed += 1;
        }
      } else {
        actualTransfers.failed += 1;
      }
    } else if (transferType === "delete-local") {
      let deleted = false;
      const bufferedFiles = options.localFileBuffers?.get(entry.namespace);
      if (options.localFileBuffers) {
        const current = bufferedFiles?.get(entry.path);
        if (
          current
          && entry.localSha256
          && createHash("sha256").update(current).digest("hex") === entry.localSha256
        ) {
          bufferedFiles!.delete(entry.path);
          deleted = true;
        }
      } else {
        const rootDir = rootMap.get(entry.namespace);
        if (rootDir && entry.localSha256) {
          try {
            const io = await createOfflineStorageIo(rootDir);
            const filePath = path.join(rootDir, entry.path);
            const current = await io.readFileDigest({ root: rootDir, path: entry.path, filePath });
            if (current.sha256 === entry.localSha256) {
              await io.deleteFile({ root: rootDir, path: entry.path, filePath });
              deleted = true;
            }
          } catch {
            deleted = false;
          }
        }
      }
      if (deleted) actualTransfers.conflictsResolved += 1;
      else actualTransfers.failed += 1;
    } else if (transferType === "delete-peer") {
      let deleted = false;
      const bufferedFiles = options.peerFileBuffers?.get(entry.namespace);
      if (options.peerFileBuffers) {
        const current = bufferedFiles?.get(entry.path);
        if (
          current
          && entry.peerSha256
          && createHash("sha256").update(current).digest("hex") === entry.peerSha256
        ) {
          bufferedFiles!.delete(entry.path);
          deleted = true;
        }
      } else if (options.peerUrl && entry.peerSha256) {
        const deletionResult = await postPeerFileDeletion(
          options.peerUrl,
          entry.namespace,
          entry.path,
          entry.peerSha256,
          resolvedToken,
          fetchFn,
        );
        deleted = Boolean(deletionResult);
        if (deletionResult === "applied") peerMutatedNamespaces.add(entry.namespace);
      }
      if (deleted) actualTransfers.conflictsResolved += 1;
      else actualTransfers.failed += 1;
    } else if (transferType === "suppress") {
      actualTransfers.suppressed += 1;
    }
  }

  if (options.peerUrl && peerMutatedNamespaces.size > 0) {
    const namespaces = [...peerMutatedNamespaces].sort();
    if (!await postPeerConvergenceComplete(
      options.peerUrl,
      namespaces,
      resolvedToken,
      fetchFn,
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
  };
}

async function updateCursorsForPlan(
  plan: ReconcilePlan,
  options: ConvergeApplyOptions,
): Promise<void> {
  const peerUrl = options.peerUrl ?? "local";
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
    const nsEntries = plan.entries.filter((e) => e.namespace === ns);
    const baseFiles = nsEntries
      .filter((entry) => !(
        (entry.reason === "local_modified_peer_deleted" && entry.resolution === "peer-wins")
        || (entry.reason === "local_deleted_peer_modified" && entry.resolution === "local-wins")
      ))
      .map((entry) => ({
        path: entry.path,
        sha256: entry.localSha256 ?? entry.peerSha256 ?? "unknown",
      }));

    const cursorState: ConvergeCursorState = {
      version: 1,
      peerUrl,
      namespace: ns,
      lastConvergedAt: new Date().toISOString(),
      baseFiles,
    };
    try {
      await writeConvergeCursor(cursorPath, cursorState);
    } catch {
      // ignore write errors in fallback environments
    }
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
  config: PluginConfig = parseConfig({}),
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
      if (
        typeof policy !== "string"
        || !CONVERGE_CONFLICT_POLICIES.includes(policy as ConvergeConflictPolicy)
      ) {
        throw new Error(
          `converge: --conflict-policy must be one of ${CONVERGE_CONFLICT_POLICIES.join(", ")}`,
        );
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
