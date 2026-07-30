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
import { resolveCorpusNamespaceRoots } from "@remnic/core/corpus-watermark.js";
import { listNamespaces } from "@remnic/core/namespaces/migrate.js";
import {
  type ConvergeCursorState,
  defaultConvergeCursorPath,
  deriveConvergeCursorBase,
  readConvergeCursor,
  writeConvergeCursor,
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
export interface ConvergePlanOptions {
  config?: PluginConfig;
  peerUrl?: string;
  peerToken?: string;
  cursorDir?: string;
  conflictPolicy?: ConvergeConflictPolicy;
  fetchImpl?: typeof fetch;
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
        !item ||
        typeof item !== "object" ||
        !("path" in item) ||
        typeof item.path !== "string" ||
        !("sha256" in item) ||
        typeof item.sha256 !== "string"
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
  }
  return null;
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
      baseMap.set(ns, files);
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
        try {
          const io = await createOfflineStorageIo(rootInfo.rootDir);
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
          );
        } catch {
          localManifests.delete(ns);
        }
        const tombstones = await readLocalTombstones(rootInfo.rootDir);
        localTombstones.set(ns, tombstones);
      } catch {
        localMap.set(ns, []);
      }
    }
  }

  const peerUrl = options.peerUrl;
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
    for (const ns of namespacesToPlan) {
      const peerData = await fetchPeerSnapshot(peerUrl, ns, resolvedToken, fetchFn);
      peerMap.set(ns, peerData.files);
      peerTombstones.set(ns, peerData.tombstones);
      peerManifests.set(
        ns,
        await buildReconcileManifest({
          files: peerData.files,
          cachedFiles: localManifests.get(ns)?.files,
          readFile: async (file) => {
            const remote = await fetchPeerFileContent(peerUrl, ns, file.path, resolvedToken, fetchFn);
            if (!remote || remote.sha256 !== file.sha256) {
              throw new Error(`failed to read peer reconciliation manifest file: ${file.path}`);
            }
            return remote.content;
          },
        })
      );
    }
  }

  const memoryDir = options.cursorDir ?? config?.memoryDir;
  if (memoryDir && options.peerUrl && (!options.baseFilesByNamespace || !options.semanticAgreementsByNamespace)) {
    for (const ns of namespacesToPlan) {
      const cursorPath = defaultConvergeCursorPath(memoryDir, options.peerUrl, ns);
      const cursor = await readConvergeCursor(cursorPath);
      if (!options.baseFilesByNamespace && cursor?.baseFiles && cursor.baseFiles.length > 0) {
        baseMap.set(ns, cursor.baseFiles);
      }
      if (
        !options.semanticAgreementsByNamespace &&
        cursor?.semanticAgreements &&
        cursor.semanticAgreements.length > 0
      ) {
        semanticAgreementMap.set(ns, cursor.semanticAgreements);
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
      converged: false,
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

    if (transferType === "pull") {
      let remoteFile: PeerFileContent | null = null;
      const buffered = options.peerFileBuffers?.get(entry.namespace)?.get(entry.path);
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
          if (!pendingReceiverNamespaces.has(entry.namespace)) {
            await setRefreshPending(options, entry.namespace, "receiver", true);
            pendingReceiverNamespaces.add(entry.namespace);
            receiverMarkedThisRun.add(entry.namespace);
          }
          const expectedPeerSha256 = entry.action === "conflict" ? entry.peerSha256 : entry.baseSha256;
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
            fetchFn
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
      } else {
        actualTransfers.failed += 1;
      }
    } else if (transferType === "delete-local") {
      let deleted = false;
      let localRefreshTracked = false;
      const bufferedFiles = options.localFileBuffers?.get(entry.namespace);
      if (options.localFileBuffers) {
        const current = bufferedFiles?.get(entry.path);
        if (current && entry.localSha256 && createHash("sha256").update(current).digest("hex") === entry.localSha256) {
          bufferedFiles!.delete(entry.path);
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
          try {
            const io = await createOfflineStorageIo(rootDir);
            const filePath = path.join(rootDir, entry.path);
            const current = await io.readFileDigest({ root: rootDir, path: entry.path, filePath });
            if (current.sha256 === entry.localSha256) {
              await io.deleteFile!({ root: rootDir, path: entry.path, filePath });
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
          deleted = true;
        }
      } else if (options.peerUrl && entry.peerSha256) {
        if (!pendingReceiverNamespaces.has(entry.namespace)) {
          await setRefreshPending(options, entry.namespace, "receiver", true);
          pendingReceiverNamespaces.add(entry.namespace);
          receiverMarkedThisRun.add(entry.namespace);
        }
        const deletionResult = await postPeerFileDeletion(
          options.peerUrl,
          entry.namespace,
          entry.path,
          entry.peerSha256,
          resolvedToken,
          fetchFn
        );
        deleted = deletionResult === "applied" || deletionResult === "skipped";
        if (deletionResult === "applied" || deletionResult === "ambiguous") {
          peerMutatedNamespaces.add(entry.namespace);
        }
      }
      if (deleted) actualTransfers.conflictsResolved += 1;
      else actualTransfers.failed += 1;
    } else if (transferType === "suppress") {
      actualTransfers.suppressed += 1;
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
