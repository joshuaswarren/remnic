import * as fs from "node:fs";
import { createHash } from "node:crypto";
import * as path from "node:path";
import {
  type PluginConfig,
  CONVERGE_CONFLICT_POLICIES,
  DEFAULT_CONVERGE_CONFLICT_POLICY,
  parseConfig,
  envConvergePeerRequestTimeoutMs,
  normalizeConvergePeerRequestTimeoutMs,
  type ResolveSecretRefFn,
  buildOfflineSyncSnapshotFromBase,
  applyOfflineSyncFileContentChunk,
  isInternalRemnicStatePath,
  OFFLINE_SYNC_FILE_CONTENT_TRANSFER_CHUNK_BYTES,
} from "@remnic/core";
import { parseFrontmatter } from "@remnic/core/storage.js";
import type { ConvergeConflictPolicy } from "@remnic/core/types.js";
import { resolveCorpusNamespaceRoots } from "@remnic/core/corpus-watermark.js";
import { listNamespaces } from "@remnic/core/namespaces/migrate.js";
import {
  planReconciliation,
  type ReconcileFileState,
  type ReconcileNamespaceInput,
  type ReconcilePlan,
  type ReconcileSemanticAgreement,
} from "@remnic/core/reconcile/plan.js";
import {
  defaultConvergeCursorPath,
  deriveConvergeCursorBase,
  readConvergeCursor,
  writeConvergeCursor,
  type ConvergeCursorState,
  normalizeConvergePeerUrl,
} from "@remnic/core/reconcile/cursor.js";
import {
  buildReconcileManifest,
  collapseActiveFactDuplicates,
  type ReconcileManifest,
} from "@remnic/core/reconcile/manifest.js";
import { createOfflineStorageIo } from "./offline-storage-io.js";
import { convergeWatch, type ConvergeWatchOutcome } from "./converge-watch.js";
import { resolveAgentAccessAuthToken } from "@remnic/core/resolve-auth-token.js";
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

interface TombstoneEvidence {
  contentHashes: Set<string>;
  fileSha256: Set<string>;
}

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

function tombstonedFileDigests(evidence: TombstoneEvidence, manifest: ReconcileManifest | undefined): Set<string> {
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
  let peerPlatform: string | undefined;

  if (options.baseFilesByNamespace) {
    for (const [ns, files] of options.baseFilesByNamespace) {
      namespacesToPlan.add(ns);
      baseMap.set(
        ns,
        files.filter((file) => !isInternalRemnicStatePath(file.path))
      );
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
      localMap.set(
        ns,
        files.filter((file) => !isInternalRemnicStatePath(file.path))
      );
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
      peerMap.set(
        ns,
        files.filter((file) => !isInternalRemnicStatePath(file.path))
      );
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
      const snapshot = await buildOfflineSyncSnapshotFromBase({
        root: rootInfo.rootDir,
        sourceId: "local",
        includeContent: false,
        readFile: io.readFile,
        readFileDigest: io.readFileDigest,
        excludeFile: io.excludeFile,
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
      const evidence = await readLocalTombstoneEvidence(rootInfo.rootDir);
      let manifestReadFailed = false;
      const manifest = await buildReconcileManifest({
        files,
        parseMemory: parseFrontmatter,
        citationTemplate: config.inlineSourceAttributionFormat,
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
    const timeoutMs =
      options.peerRequestTimeoutMs ??
      config?.converge.peerRequestTimeoutMs ??
      envConvergePeerRequestTimeoutMs() ??
      DEFAULT_PEER_REQUEST_TIMEOUT_MS;
    const capabilities = await fetchPeerSyncCapabilities(peerUrl, resolvedToken, fetchFn, timeoutMs);
    peerPlatform = capabilities?.platform;
    for (const ns of namespacesToPlan) {
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
          citationTemplate: config?.inlineSourceAttributionFormat,
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
        });
        if (readFailure) throw readFailure;
      }
      peerManifests.set(ns, peerManifest);
      const evidence: TombstoneEvidence = { contentHashes: new Set(), fileSha256: new Set() };
      for (const tombstonePath of TOMBSTONE_PATHS) {
        const state = peerFiles.find((file) => file.path === tombstonePath);
        if (!state) continue;
        const remote = await fetchPeerFileContent(peerUrl, ns, tombstonePath, resolvedToken, fetchFn, timeoutMs);
        // A transport-level failure here is FATAL on purpose: tombstone
        // evidence is what stops a plan from pushing a peer-retracted memory
        // back (resurrection). There is no safe "empty evidence" fallback —
        // the snapshot response carries no tombstone digest array today.
        if (!remote) {
          throw new Error(`failed to read peer tombstone evidence: ${tombstonePath}`);
        }
        if (remote.sha256.toLowerCase() !== state.sha256.toLowerCase()) {
          // A LIVE peer appends tombstones while the plan runs, so the file
          // can legitimately differ from the snapshot listing that scheduled
          // this fetch. Tombstone stores are append-only by design, so the
          // fetch is consistent with the listing exactly when the listed
          // revision is a byte-prefix of the fetched content. The comparison
          // is BYTES throughout: state.bytes is a byte count and hashing the
          // buffer directly avoids UTF-16 code-unit slicing on non-ASCII
          // logs (review round 1).
          const listedBytes = typeof state.bytes === "number" ? state.bytes : -1;
          const prefixMatches =
            listedBytes >= 0 &&
            remote.content.length >= listedBytes &&
            createHash("sha256").update(remote.content.subarray(0, listedBytes)).digest("hex") ===
              state.sha256.toLowerCase();
          if (!prefixMatches) {
            throw new Error(`failed to read peer tombstone evidence: ${tombstonePath}`);
          }
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

  if (memoryDir && options.peerUrl && (!options.baseFilesByNamespace || !options.semanticAgreementsByNamespace)) {
    for (const ns of namespacesToPlan) {
      const cursorPath = defaultConvergeCursorPath(memoryDir, options.peerUrl, ns);
      const cursor = await readConvergeCursor(cursorPath);
      if (!options.baseFilesByNamespace && cursor?.baseFiles && cursor.baseFiles.length > 0) {
        baseMap.set(
          ns,
          cursor.baseFiles.filter((file) => !isInternalRemnicStatePath(file.path))
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
              !isInternalRemnicStatePath(agreement.local.path) && !isInternalRemnicStatePath(agreement.peer.path)
          )
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
  const plan = planReconciliation(inputs, { conflictPolicy, peerPlatform });
  return collapseActiveFactDuplicates(plan, localManifests, peerManifests, semanticAgreementMap);
}

export async function executeConvergeApply(options: ConvergeApplyOptions = {}): Promise<ConvergeApplyResult> {
  const conflictPolicy =
    options.conflictPolicy ?? options.config?.converge.conflictPolicy ?? DEFAULT_CONVERGE_CONFLICT_POLICY;
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
      converged: plan.converged,
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
  let config = options.config;
  if (!config) {
    try {
      config = parseConfig({});
    } catch {
      // ignore
    }
  }
  const fetchFn = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs =
    options.peerRequestTimeoutMs ??
    config?.converge.peerRequestTimeoutMs ??
    envConvergePeerRequestTimeoutMs() ??
    DEFAULT_PEER_REQUEST_TIMEOUT_MS;

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
    const localPath = entry.semanticAgreement?.local.path ?? entry.path;
    const peerPath = entry.semanticAgreement?.peer.path ?? entry.path;

    if (transferType === "pull") {
      const buffered = options.peerFileBuffers?.get(entry.namespace)?.get(peerPath);
      if (options.localFileBuffers) {
        let remoteFile: PeerFileContent | null = null;
        if (buffered) {
          const state = options.peerFilesByNamespace?.get(entry.namespace)?.find((file) => file.path === peerPath);
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
            timeoutMs
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
        const state = options.peerFilesByNamespace?.get(entry.namespace)?.find((file) => file.path === peerPath);
        const sha256 = state?.sha256 ?? entry.peerSha256 ?? createHash("sha256").update(buffered).digest("hex");
        const bytes = buffered.length;
        const mtimeMs = state?.mtimeMs ?? 0;
        let offset = 0;
        do {
          const content = buffered.subarray(
            offset,
            Math.min(bytes, offset + OFFLINE_SYNC_FILE_CONTENT_TRANSFER_CHUNK_BYTES)
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
          timeoutMs
        );
      }
      if (
        metadata &&
        transferComplete &&
        !transferRejected &&
        (!entry.peerSha256 || metadata.sha256 === entry.peerSha256)
      ) {
        if (entry.action === "conflict") actualTransfers.conflictsResolved += 1;
        else actualTransfers.pulled += 1;
      } else {
        actualTransfers.failed += 1;
      }
    } else if (transferType === "push") {
      const localBuffer = options.localFileBuffers?.get(entry.namespace)?.get(localPath);
      let source: PeerFileSource | null = null;
      let closeSource: (() => Promise<void>) | undefined;
      const expectedPeerSha256 = entry.action === "conflict" ? entry.peerSha256 : entry.baseSha256;
      if (localBuffer && entry.localSha256) {
        source = {
          sha256: entry.localSha256,
          bytes: localBuffer.length,
          mtimeMs:
            options.localFilesByNamespace?.get(entry.namespace)?.find((file) => file.path === localPath)?.mtimeMs ?? 0,
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
              chunks = io
                .readFileChunks({
                  root: rootDir,
                  path: localPath,
                  filePath,
                  chunkSize: OFFLINE_SYNC_FILE_CONTENT_TRANSFER_CHUNK_BYTES,
                })
                [Symbol.asyncIterator]();
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
        } else if (options.peerUrl && source) {
          const applied = await postPeerFileContent(
            options.peerUrl,
            entry.namespace,
            peerPath,
            source,
            resolvedToken,
            fetchFn,
            timeoutMs
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
      } finally {
        await closeSource?.();
      }
    } else if (transferType === "delete-local") {
      let deleted = false;
      const bufferedFiles = options.localFileBuffers?.get(entry.namespace);
      if (options.localFileBuffers) {
        const current = bufferedFiles?.get(localPath);
        if (current && entry.localSha256 && createHash("sha256").update(current).digest("hex") === entry.localSha256) {
          bufferedFiles!.delete(localPath);
          deleted = true;
        }
      } else {
        const rootDir = rootMap.get(entry.namespace);
        if (rootDir && entry.localSha256) {
          try {
            const io = await createOfflineStorageIo(rootDir);
            const filePath = path.join(rootDir, localPath);
            const current = await io.readFileDigest({ root: rootDir, path: localPath, filePath });
            if (current.sha256 === entry.localSha256) {
              await io.deleteFile!({ root: rootDir, path: localPath, filePath });
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
        const current = bufferedFiles?.get(peerPath);
        if (current && entry.peerSha256 && createHash("sha256").update(current).digest("hex") === entry.peerSha256) {
          bufferedFiles!.delete(peerPath);
          deleted = true;
        }
      } else if (options.peerUrl && entry.peerSha256) {
        const deletionResult = await postPeerFileDeletion(
          options.peerUrl,
          entry.namespace,
          peerPath,
          entry.peerSha256,
          resolvedToken,
          fetchFn,
          timeoutMs
        );
        deleted = Boolean(deletionResult);
        if (deletionResult === "applied") peerMutatedNamespaces.add(entry.namespace);
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
            timeoutMs
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

  if (options.peerUrl && peerMutatedNamespaces.size > 0) {
    const namespaces = [...peerMutatedNamespaces].sort();
    if (!(await postPeerConvergenceComplete(options.peerUrl, namespaces, resolvedToken, fetchFn, timeoutMs))) {
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

async function updateCursorsForPlan(plan: ReconcilePlan, options: ConvergeApplyOptions): Promise<void> {
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

/**
 * Convert the `--timeout <seconds>` flag to normalized milliseconds. The
 * flag is SECONDS and normalization validates/clamps MILLISECONDS — the
 * conversion must happen BETWEEN them. Normalizing the raw seconds and
 * dividing by 1000 (the #2802 round-1 form) turned `--timeout 3600` into a
 * 3.6-second timeout.
 */
export function convergeTimeoutFlagToMs(seconds: number): number {
  // Round before normalization: IEEE-754 can turn 1.001 into
  // 1000.9999999999999, which the integer-only normalizer would reject.
  return normalizeConvergePeerRequestTimeoutMs(Math.round(seconds * 1000), "--timeout");
}

export async function cmdConverge(
  action: string,
  rest: string[],
  json: boolean,
  config: PluginConfig = parseConfig({})
): Promise<void> {
  if (action === "help" || action === "--help" || action === "-h" || rest.includes("--help") || rest.includes("-h")) {
    console.log(`Usage: remnic converge <plan|apply|watch> [options]

Subcommands:
  plan              Compute and display reconciliation plan
  apply             Execute bidirectional converge transport (alias: transport, sync)
  watch             Run apply on a cadence until stopped (scheduled replication)

Options:
  --peer <url>      Peer server URL (or --remote-url / --remote)
  --token <token>   Bearer token or SecretRef for peer authentication
  --conflict-policy <policy>
                    Policy override (newest-wins|manual)
                    Default: converge.conflictPolicy (newest-wins)
  --interval <seconds>
                    Watch cadence in seconds (watch only; default 300, min 1)
  --timeout <seconds>
                    Per-request peer HTTP timeout (default 30; use 300+ for
                    boot-scale namespaces of ~100k files)
  --dry-run         Simulate transfers without mutating disk or remote peer
  --json            Output detailed JSON plan report
`);
    return;
  }

  if (action !== "plan" && action !== "apply" && action !== "transport" && action !== "sync" && action !== "watch") {
    process.stderr.write(`converge: unknown action "${action}". Use: plan, apply, or watch [options].\n`);
    process.exitCode = 2;
    return;
  }

  let peerUrl: string | undefined;
  let peerToken: string | undefined;
  let dryRun = false;
  let conflictPolicy: ConvergeConflictPolicy | undefined;
  let intervalSeconds: number | undefined;
  let timeoutMsFlag: number | undefined;

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
    } else if (arg === "--interval") {
      // Flag-present-but-value-absent is malformed, not "use the default":
      // an operator who typed `--interval` alone must hear about it, not
      // silently get a 300s watch (codex P1 / coderabbit round 2).
      const raw = rest[i + 1];
      const parsed = raw === undefined ? Number.NaN : Number(raw);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        process.stderr.write("converge: --interval must be a positive number of seconds.\n");
        process.exitCode = 2;
        return;
      }
      intervalSeconds = parsed;
      i += 1;
    } else if (arg === "--timeout") {
      // Flag-present-but-value-absent is malformed, not "use the default".
      const raw = rest[i + 1];
      const parsed = raw === undefined ? Number.NaN : Number(raw);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        process.stderr.write("converge: --timeout must be a positive number of seconds.\n");
        process.exitCode = 2;
        return;
      }
      timeoutMsFlag = convergeTimeoutFlagToMs(parsed);
      i += 1;
    } else if (arg === "--conflict-policy") {
      const policy = rest[i + 1];
      if (typeof policy !== "string" || !CONVERGE_CONFLICT_POLICIES.includes(policy as ConvergeConflictPolicy)) {
        throw new Error(`converge: --conflict-policy must be one of ${CONVERGE_CONFLICT_POLICIES.join(", ")}`);
      }
      conflictPolicy = policy as ConvergeConflictPolicy;
      i += 1;
    }
  }

  if (action === "watch") {
    const controller = new AbortController();
    const onSignal = () => controller.abort();
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    let outcome: ConvergeWatchOutcome | undefined;
    try {
      outcome = await convergeWatch({
        apply: (applyOptions) => executeConvergeApply(applyOptions),
        config,
        peerUrl,
        dryRun,
        peerToken,
        conflictPolicy,
        intervalMs: intervalSeconds !== undefined ? intervalSeconds * 1000 : undefined,
        ...(timeoutMsFlag !== undefined ? { peerRequestTimeoutMs: timeoutMsFlag } : {}),
        signal: controller.signal,
        onCycle: json
          ? undefined
          : (cycle, event) => {
              if (event.error !== undefined) {
                console.error(`converge watch: cycle ${cycle} failed: ${String(event.error)}`);
                return;
              }
              const result = event.result;
              if (!result) return;
              const transfers = result.transfers;
              console.log(
                `converge watch: cycle ${cycle} status=${result.status} pulled=${transfers.pulled} pushed=${transfers.pushed} conflicts=${transfers.conflictsResolved} failed=${transfers.failed}`
              );
            },
      });
      if (json) {
        console.log(JSON.stringify(outcome, null, 2));
      } else {
        console.log(
          `converge watch stopped after ${outcome.cycles} cycle(s): ${outcome.convergedCycles} converged, ${outcome.appliedCycles} applied, ${outcome.failedCycles} failed (last: ${outcome.lastStatus}).`
        );
      }
    } finally {
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
      // A supervisor needs a nonzero exit when the watch never made progress
      // (peer unreachable, bad token) — exit 1 only when EVERY cycle failed.
      if (outcome && outcome.cycles > 0 && outcome.failedCycles === outcome.cycles) {
        process.exitCode = 1;
      }
    }
    return;
  }

  if (action === "plan") {
    const plan = await computeConvergePlan({
      config,
      peerUrl,
      peerToken,
      conflictPolicy,
      ...(timeoutMsFlag !== undefined ? { peerRequestTimeoutMs: timeoutMsFlag } : {}),
    });
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
    ...(timeoutMsFlag !== undefined ? { peerRequestTimeoutMs: timeoutMsFlag } : {}),
  });

  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatConvergeApplyReport(result));
  }
}
