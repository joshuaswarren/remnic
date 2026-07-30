import * as nodePath from "node:path";
import type { Orchestrator } from "./orchestrator.js";
import { iterateOfflineSyncSnapshotFileRecords } from "./offline-sync.js";
import { offlineSyncStorageForSnapshot } from "./offline-sync-impression-drain.js";
import {
  buildReconcileManifestFile,
  RECONCILE_MANIFEST_FORMAT,
  RECONCILE_MANIFEST_SCHEMA_VERSION,
  type ReconcileManifest,
  type ReconcileManifestFile,
  type ReconcileMemoryParser,
} from "./reconcile/manifest.js";

export interface OfflineSyncManifestRequest {
  includeTranscripts?: boolean;
  signal?: AbortSignal;
}

export interface OfflineSyncManifestStreamResponse extends Omit<ReconcileManifest, "files"> {
  namespace: string;
  files: AsyncIterable<ReconcileManifestFile>;
}

export async function createOfflineSyncManifestStream(
  orchestrator: Orchestrator,
  namespace: string,
  userExcludeRegexps: RegExp[],
  options: OfflineSyncManifestRequest,
  parseMemory: ReconcileMemoryParser,
): Promise<OfflineSyncManifestStreamResponse> {
  const storage = await offlineSyncStorageForSnapshot(orchestrator, namespace);
  const snapshotFiles = iterateOfflineSyncSnapshotFileRecords({
    root: storage.dir,
    includeContent: false,
    includeTranscripts: options.includeTranscripts !== false,
    readFileDigest: async ({ filePath }) => storage.digestOfflineSyncFile(filePath),
    signal: options.signal,
    userExcludeRegexps,
  });
  return {
    namespace,
    format: RECONCILE_MANIFEST_FORMAT,
    schemaVersion: RECONCILE_MANIFEST_SCHEMA_VERSION,
    files: (async function* () {
      for await (const file of snapshotFiles) {
        yield await buildReconcileManifestFile(
          file,
          async ({ path }) => storage.readOfflineSyncFile(nodePath.join(storage.dir, path)),
          parseMemory,
        );
      }
    })(),
  };
}
