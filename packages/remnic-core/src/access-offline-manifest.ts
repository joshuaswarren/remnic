import * as nodePath from "node:path";
import { offlineSyncStorageForSnapshot } from "./offline-sync-impression-drain.js";
import { iterateOfflineSyncSnapshotFileRecords } from "./offline-sync.js";
import type { Orchestrator } from "./orchestrator.js";
import {
  CONTENT_HASH_NORMALIZER_VERSION,
  IDENTITY_RESOLUTION_VERSION,
  RECONCILE_MANIFEST_FORMAT,
  RECONCILE_MANIFEST_SCHEMA_VERSION,
  type ReconcileManifest,
  type ReconcileManifestFile,
  type ReconcileMemoryIdentity,
  type ReconcileMemoryParser,
  buildReconcileManifestFile,
  citationTemplateFingerprint,
  isReconcileMemoryIdentity,
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

export interface ServerIdentityCacheEntry {
  path: string;
  sha256: string;
  memory?: ReconcileMemoryIdentity;
}

/**
 * Decide what the manifest stream should persist, and whether a write is
 * needed at all.
 *
 * A write is required whenever the persisted set changed — an identity was
 * rebuilt, or an entry was dropped because its file lost its identity — and
 * also when a completed walk leaves entries for paths it never saw, which are
 * files that have since been deleted. Skipping the write in that last case
 * would strand those entries on disk forever.
 *
 * Pruning is gated on the walk completing: an aborted or partially consumed
 * stream has simply not observed the remaining paths, so it may only add.
 */
export function planServerIdentityCacheWrite(input: {
  persisted: ReadonlyMap<string, ServerIdentityCacheEntry>;
  yieldedPaths: ReadonlySet<string>;
  streamCompleted: boolean;
  cacheDirty: boolean;
}): { shouldWrite: boolean; entries: ServerIdentityCacheEntry[] } {
  const entries = input.streamCompleted
    ? [...input.persisted.values()].filter((entry) => input.yieldedPaths.has(entry.path))
    : [...input.persisted.values()];
  return { shouldWrite: input.cacheDirty || entries.length !== input.persisted.size, entries };
}

/**
 * The cache lives under `.remnic/` rather than `state/`: snapshot enumeration
 * excludes internal `.remnic/` paths structurally (`isInternalRemnicStatePath`),
 * whereas `state/` is only filtered by an allowlist of known node-local
 * artifacts. Under `state/` this node-local cache would be advertised as a peer
 * file, so convergence would transfer the cache itself — and the stream rewrites
 * it during finalization, so the advertised digest could go stale mid-transfer.
 */
function serverIdentityCachePath(storageDir: string): string {
  return nodePath.join(storageDir, ".remnic", "state", "converge-identity-cache.json");
}

async function loadServerIdentityCache(
  storageDir: string,
  citationTemplate?: string
): Promise<Map<string, ServerIdentityCacheEntry>> {
  const cache = new Map<string, ServerIdentityCacheEntry>();
  try {
    const raw = JSON.parse(
      await import("node:fs/promises").then((fs) => fs.readFile(serverIdentityCachePath(storageDir), "utf8"))
    ) as {
      citationTemplate?: string;
      files?: unknown[];
    };
    // Identities are derived after stripping inline attribution for a specific
    // citation template; entries written under a different one would produce
    // wrong contentHash values for unchanged files.
    if (raw.citationTemplate !== citationTemplateFingerprint(citationTemplate)) return cache;
    for (const candidate of raw.files ?? []) {
      const entry = candidate as Partial<ServerIdentityCacheEntry> | null;
      if (typeof entry?.path !== "string" || typeof entry.sha256 !== "string") continue;
      if (entry.memory !== undefined && !isReconcileMemoryIdentity(entry.memory)) continue;
      cache.set(entry.path, {
        path: entry.path,
        sha256: entry.sha256,
        ...(entry.memory ? { memory: entry.memory } : {}),
      });
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
  const citationTemplate = orchestrator.config.inlineSourceAttributionFormat;
  const identityCache = await loadServerIdentityCache(storage.dir, citationTemplate);
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
      // Any change to the persisted set, not just a rebuilt identity: a file
      // that lost its identity, or a completed walk that must prune vanished
      // paths, also has to reach disk or the removal is lost forever.
      let cacheDirty = false;
      let streamCompleted = false;
      // Seeded with every previously cached entry so a partially consumed
      // stream (client disconnect, abort) can only add to the cache. Writing
      // just this run's rebuilds would drop every cache hit, so one edit to a
      // large corpus would shrink the cache to that single entry and force a
      // near-cold rebuild on the next request.
      const persistedEntries = new Map(identityCache);
      const yieldedPaths = new Set<string>();
      const flush = async (): Promise<void> => {
        const { shouldWrite, entries } = planServerIdentityCacheWrite({
          persisted: persistedEntries,
          yieldedPaths,
          streamCompleted,
          cacheDirty,
        });
        if (!shouldWrite) return;
        try {
          const fs = await import("node:fs/promises");
          const cachePath = serverIdentityCachePath(storage.dir);
          await fs.mkdir(nodePath.dirname(cachePath), { recursive: true });
          const tmp = `${cachePath}.tmp`;
          await fs.writeFile(
            tmp,
            JSON.stringify({ citationTemplate: citationTemplateFingerprint(citationTemplate), files: entries })
          );
          await fs.rename(tmp, cachePath);
        } catch {
          // cache persistence is best-effort
        }
      };
      try {
        for await (const file of snapshotFiles) {
          yieldedPaths.add(file.path);
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
            citationTemplate
          );
          if (built.memory !== undefined) {
            persistedEntries.set(built.path, { path: built.path, sha256: built.sha256, memory: built.memory });
            cacheDirty = true;
          } else if (persistedEntries.delete(built.path)) {
            cacheDirty = true;
          }
          yield built;
        }
        streamCompleted = true;
      } finally {
        await flush();
      }
    })(),
  };
}
