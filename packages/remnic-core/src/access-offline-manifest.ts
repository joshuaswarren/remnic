import * as nodePath from "node:path";
import type { Orchestrator } from "./orchestrator.js";
import { iterateOfflineSyncSnapshotFileRecords } from "./offline-sync.js";
import { offlineSyncStorageForSnapshot } from "./offline-sync-impression-drain.js";
import {
  buildReconcileManifestFile,
  CONTENT_HASH_NORMALIZER_VERSION,
  IDENTITY_RESOLUTION_VERSION,
  RECONCILE_MANIFEST_FORMAT,
  type ReconcileMemoryIdentity,
  RECONCILE_MANIFEST_SCHEMA_VERSION,
  type ReconcileManifest,
  type ReconcileManifestFile,
  type ReconcileMemoryParser,
} from "./reconcile/manifest.js";
import { isSupportPassportPrivateMemory } from "./support-passport/card-projection.js";

export interface OfflineSyncManifestRequest {
  includeTranscripts?: boolean;
  signal?: AbortSignal;
}

export interface OfflineSyncManifestStreamResponse extends Omit<ReconcileManifest, "files"> {
  namespace: string;
  files: AsyncIterable<ReconcileManifestFile>;
}

interface ServerIdentityCacheEntry {
  path: string;
  sha256: string;
  memory?: ReconcileMemoryIdentity;
}

function serverIdentityCachePath(storageDir: string): string {
  return nodePath.join(storageDir, "state", "converge-identity-cache.json");
}

async function loadServerIdentityCache(storageDir: string): Promise<Map<string, ServerIdentityCacheEntry>> {
  const cache = new Map<string, ServerIdentityCacheEntry>();
  try {
    const raw = JSON.parse(
      await import("node:fs/promises").then((fs) => fs.readFile(serverIdentityCachePath(storageDir), "utf8"))
    ) as {
      files?: ServerIdentityCacheEntry[];
    };
    for (const entry of raw.files ?? []) {
      if (typeof entry?.path === "string" && typeof entry.sha256 === "string") cache.set(entry.path, entry);
    }
  } catch {
    // missing or corrupt cache: cold build
  }
  return cache;
}

export async function createOfflineSyncManifestStream(
  orchestrator: Orchestrator,
  namespace: string,
  userExcludeRegexps: RegExp[],
  options: OfflineSyncManifestRequest,
  parseMemory: ReconcileMemoryParser
): Promise<OfflineSyncManifestStreamResponse> {
  const storage = await offlineSyncStorageForSnapshot(orchestrator, namespace);
  const identityCache = await loadServerIdentityCache(storage.dir);
  const snapshotFiles = iterateOfflineSyncSnapshotFileRecords({
    root: storage.dir,
    includeContent: false,
    includeTranscripts: options.includeTranscripts !== false,
    readFileDigest: async ({ filePath }) => storage.digestOfflineSyncFile(filePath),
    signal: options.signal,
    userExcludeRegexps,
    excludeFile: async ({ filePath }) => {
      const memory = await storage.readMemoryByPath(filePath);
      return memory ? isSupportPassportPrivateMemory(memory) : false;
    },
  });
  return {
    namespace,
    format: RECONCILE_MANIFEST_FORMAT,
    schemaVersion: RECONCILE_MANIFEST_SCHEMA_VERSION,
    files: (async function* () {
      let updated = 0;
      const updatedEntries: ServerIdentityCacheEntry[] = [];
      const flush = async (): Promise<void> => {
        if (updated === 0) return;
        try {
          const fs = await import("node:fs/promises");
          const cachePath = serverIdentityCachePath(storage.dir);
          await fs.mkdir(nodePath.dirname(cachePath), { recursive: true });
          const tmp = `${cachePath}.tmp`;
          await fs.writeFile(tmp, JSON.stringify({ files: updatedEntries }));
          await fs.rename(tmp, cachePath);
        } catch {
          // cache persistence is best-effort
        }
      };
      try {
        for await (const file of snapshotFiles) {
          const cached = identityCache.get(file.path);
          if (
            cached?.memory !== undefined &&
            cached.sha256.toLowerCase() === file.sha256.toLowerCase() &&
            cached.memory.normalizerVersion === CONTENT_HASH_NORMALIZER_VERSION &&
            cached.memory.identityResolutionVersion === IDENTITY_RESOLUTION_VERSION
          ) {
            yield { ...file, memory: cached.memory };
            continue;
          }
          const built = await buildReconcileManifestFile(
            file,
            async ({ path }) => storage.readOfflineSyncFile(nodePath.join(storage.dir, path)),
            parseMemory,
            orchestrator.config.inlineSourceAttributionFormat
          );
          if (built.memory !== undefined) {
            updatedEntries.push({ path: built.path, sha256: built.sha256, memory: built.memory });
            updated += 1;
          }
          yield built;
        }
      } finally {
        await flush();
      }
    })(),
  };
}
