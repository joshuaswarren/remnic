import * as path from "node:path";
import { buildOfflineSyncSnapshotFromBase, isInternalRemnicStatePath } from "@remnic/core";
import { parseFrontmatter } from "@remnic/core/storage.js";
import type { ReconcileFileState } from "@remnic/core/reconcile/plan.js";
import { buildReconcileManifest, type ReconcileManifest } from "@remnic/core/reconcile/manifest.js";
import { convergeIdentityCachePath } from "@remnic/core/reconcile/cursor.js";
import type { ConvergePlanCache } from "./converge-plan-cache.js";
import type { ConvergePlanProgressEvent } from "./converge-plan-cache.js";
import { censusWatermark } from "./converge-plan-cache.js";
import { readLocalTombstoneEvidence, tombstonedFileDigests } from "./converge-tombstones.js";
import { createOfflineStorageIo } from "./offline-storage-io.js";
import { loadConvergeIdentityCache, saveConvergeIdentityCache } from "./converge-identity-cache.js";

/**
 * Local-side census phase for one namespace root (issue #2803, extracted
 * from converge.ts): streamed corpus walk + manifest build, resumed from
 * the per-namespace plan-cache checkpoint when one exists.
 */

export interface LocalCensusArgs {
  rootDir: string;
  namespace: string;
  index: number;
  total: number;
  citationTemplate: string;
  cache: ConvergePlanCache | null;
  signal?: AbortSignal;
  onProgress?: (event: ConvergePlanProgressEvent) => void;
  memoryDir?: string;
  peerUrl?: string;
  userExcludeRegexps?: readonly RegExp[];
}

export interface LocalCensusResult {
  files: ReconcileFileState[];
  manifest: ReconcileManifest;
  tombstones: Set<string>;
}

export async function planLocalNamespaceCensus(args: LocalCensusArgs): Promise<LocalCensusResult> {
  const { rootDir, ns } = { rootDir: args.rootDir, ns: args.namespace };
  args.signal?.throwIfAborted();
  const identityCachePath = args.memoryDir
    ? convergeIdentityCachePath(args.memoryDir, args.peerUrl ?? "local", ns)
    : undefined;
  const identityCache = await loadConvergeIdentityCache(identityCachePath, args.citationTemplate);
  const classificationUpdates = new Map<string, { statIdentity: string; excluded: boolean }>();
  const io = await createOfflineStorageIo(
    rootDir,
    undefined,
    identityCachePath === undefined
      ? undefined
      : { persisted: identityCache, updates: classificationUpdates }
  );
  const priorEntry = args.cache ? await args.cache.readEntry("local", ns) : null;
  const priorFiles = priorEntry?.files;
  const capturedAtMs = Date.now();
  // Streamed census with fast-base resume: unchanged files (mtime+bytes
  // within the offline-sync tolerance, ctime not newer than the cached
  // capture) reuse their cached sha256 instead of rehashing.
  const snapshot = await buildOfflineSyncSnapshotFromBase({
    root: rootDir,
    sourceId: "local",
    includeContent: false,
    // Peer snapshot, manifest-stream, and apply all pin
    // includeTranscripts=false. Including transcripts here would mark
    // identical transcripts as local-only, then apply would reject them.
    includeTranscripts: false,
    // Rows missing stat metadata cannot ride the fast-base path
    // (normalizeFileState requires them); they simply re-hash.
    baseFiles: priorFiles?.filter(
      (file): file is typeof file & { mtimeMs: number; bytes: number } =>
        typeof file.mtimeMs === "number" && typeof file.bytes === "number"
    ),
    baseCapturedAt: priorEntry ? new Date(priorEntry.capturedAtMs) : undefined,
    readFile: io.readFile,
    readFileDigest: io.readFileDigest,
    excludeFile: io.excludeFile,
    userExcludeRegexps: args.userExcludeRegexps,
    signal: args.signal,
  });
  const files: ReconcileFileState[] = snapshot.files
    .filter((record) => !isInternalRemnicStatePath(record.path))
    .map((record) => ({
      path: record.path,
      sha256: record.sha256,
      mtimeMs: record.mtimeMs,
      bytes: record.bytes,
    }));
  const evidence = await readLocalTombstoneEvidence(rootDir);
  let manifestReadFailed = false;
  const manifest = await buildReconcileManifest({
    files,
    parseMemory: parseFrontmatter,
    citationTemplate: args.citationTemplate,
    cachedFiles: identityCache.size > 0 ? [...identityCache.values()] : priorFiles,
    readFile: async (file) => {
      const readFile = io.readFile;
      if (!readFile) {
        manifestReadFailed = true;
        throw new Error("offline storage cannot read reconciliation manifest files");
      }
      try {
        return await readFile({
          root: rootDir,
          path: file.path,
          filePath: path.join(rootDir, file.path),
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
  await saveConvergeIdentityCache(
    identityCachePath,
    manifest,
    args.citationTemplate,
    identityCache,
    classificationUpdates
  );
  if (args.cache) {
    const priorByPath = new Map((priorFiles ?? []).map((file) => [file.path, file.sha256.toLowerCase()]));
    let reused = 0;
    for (const file of files) {
      if (priorByPath.get(file.path) === file.sha256.toLowerCase()) reused += 1;
    }
    args.onProgress?.({
      side: "local",
      namespace: ns,
      index: args.index,
      total: args.total,
      reused,
      computed: files.length - reused,
    });
    // Checkpoint the namespace only after it fully completed, so an
    // aborted or crashed run leaves a valid (if partial) plan cache.
    await args.cache.writeEntry({
      version: 1,
      scope: args.cache.scope,
      side: "local",
      namespace: ns,
      watermark: censusWatermark(files),
      fileCount: files.length,
      capturedAtMs,
      savedAt: new Date().toISOString(),
      files: manifest.files,
    });
  }
  return { files, manifest, tombstones: tombstonedFileDigests(evidence, manifest) };
}
